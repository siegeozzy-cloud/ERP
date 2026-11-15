import { constants as zlibConstants } from 'node:zlib'
import compress from '@fastify/compress'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import Fastify from 'fastify'
import { config } from './config.ts'
import { pool } from './db/client.ts'
import authRoutes from './features/auth/routes.ts'
import { errorHandler, HttpError } from './lib/errors.ts'
import { registerSecurityHeaders } from './lib/security.ts'
import { registerSessions } from './lib/session.ts'

export async function buildApp() {
  const app = Fastify({
    logger:
      config.NODE_ENV === 'test'
        ? false
        : config.dev
          ? { transport: { target: 'pino-pretty', options: { ignore: 'pid,hostname,reqId', translateTime: 'HH:MM:ss' } } }
          : true,
    /**
     * Whose address a request is counted against for rate limiting. In development requests come
     * through the web app's Vite proxy on this machine. In production the host's load balancer is one
     * hop in front: trusting exactly one hop takes the address it saw, which a client can't forge by
     * sending its own X-Forwarded-For.
     */
    trustProxy: config.dev ? '127.0.0.1' : (_address: string, hop: number) => hop === 0,
    bodyLimit: 64 * 1024,
  })

  app.setErrorHandler(errorHandler)
  // first, so every answer below (routes and errors) carries them
  registerSecurityHeaders(app)
  // JSON compresses well and saves bandwidth on metered free plans. gzip first: brotli costs far more CPU.
  await app.register(compress, {
    global: true,
    threshold: 1024,
    encodings: ['gzip', 'deflate', 'br'],
    brotliOptions: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } },
  })
  await app.register(cookie)
  // The web app and the API are on different addresses in production, so the browser asks permission first.
  await app.register(cors, {
    origin: (origin, done) => done(null, !origin || config.allowedOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  })
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' })

  // Changes may only come from the web app itself (or from the phone app, which sends no Origin).
  // With SameSite cookies and JSON bodies this is belt and braces against cross-site request forgery.
  app.addHook('onRequest', async (req) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return
    const origin = req.headers.origin
    if (origin && !config.allowedOrigins.includes(origin)) throw new HttpError(403, 'bad-origin', 'Requests must come from the app.')
  })
  registerSessions(app)

  /**
   * "Is the server up?" and nothing else. The host's health check calls this every few minutes, so it
   * deliberately touches no database: a query would keep a serverless Postgres awake around the clock.
   */
  app.get('/api/ping', async () => ({ ok: true }))

  /** The same, plus "is the database reachable?". */
  app.get('/api/health', async () => {
    await pool.query('select 1')
    return { ok: true, db: true }
  })

  await app.register(authRoutes, { prefix: '/api/auth' })

  return app
}
