import { constants as zlibConstants } from 'node:zlib'
import compress from '@fastify/compress'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import Fastify from 'fastify'
import { config } from './config.ts'
import { pool } from './db/client.ts'
import authRoutes from './features/auth/routes.ts'
import crmRoutes from './features/crm/routes.ts'
import priceRoutes from './features/crm/prices.ts'
import salesRoutes from './features/crm/sales.ts'
import payrollRoutes from './features/hr/payroll.ts'
import peopleRoutes from './features/hr/people.ts'
import { billRoutes, invoiceRoutes, paymentRoutes } from './features/finance/document-routes.ts'
import journalRoutes from './features/finance/journal-routes.ts'
import reportRoutes from './features/finance/report-routes.ts'
import purchasingRoutes from './features/inventory/purchasing.ts'
import inventoryRoutes from './features/inventory/routes.ts'
import manufacturingRoutes from './features/manufacturing/routes.ts'
import memberRoutes from './features/members/routes.ts'
import projectRoutes from './features/projects/routes.ts'
import psgcRoutes from './features/psgc/psgc.ts'
import demoRoutes from './features/demo/routes.ts'
import { isSeedRequest } from './features/demo/seed.ts'
import dashboardRoutes from './features/dashboard/routes.ts'
import importRoutes from './features/import/routes.ts'
import deviceRoutes from './features/devices/routes.ts'
import setupRoutes from './features/finance/setup-routes.ts'
import workspaceRoutes, { workspaceDetailRoutes } from './features/workspaces/routes.ts'
import { errorHandler, HttpError } from './lib/errors.ts'
import { registerSecurityHeaders } from './lib/security.ts'
import { registerSessions } from './lib/session.ts'
import { workspaceScope } from './lib/workspace.ts'

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
  // the demo builder makes hundreds of requests in-process (features/demo), and carries a secret to say so
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute', allowList: (req) => isSeedRequest(req.headers) })

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
  await app.register(workspaceRoutes, { prefix: '/api/workspaces' })
  await app.register(psgcRoutes, { prefix: '/api/psgc' })
  await app.register(deviceRoutes, { prefix: '/api/devices' })
  await app.register(demoRoutes, { prefix: '/api/demo', root: app })

  // everything below lives inside one workspace: /api/w/:workspaceId/…
  await workspaceScope(app, async (scoped) => {
    await workspaceDetailRoutes(scoped)
    await dashboardRoutes(scoped)
    await importRoutes(scoped)
    await memberRoutes(scoped)
    await setupRoutes(scoped)
    await invoiceRoutes(scoped)
    await billRoutes(scoped)
    await paymentRoutes(scoped)
    await journalRoutes(scoped)
    await reportRoutes(scoped)
    await inventoryRoutes(scoped)
    await purchasingRoutes(scoped)
    await crmRoutes(scoped)
    await salesRoutes(scoped)
    await priceRoutes(scoped)
    await peopleRoutes(scoped)
    await payrollRoutes(scoped)
    await manufacturingRoutes(scoped)
    await projectRoutes(scoped)
  })

  return app
}
