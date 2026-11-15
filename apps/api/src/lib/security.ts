import type { FastifyInstance } from 'fastify'
import { config } from '../config.ts'

/**
 * Headers on every answer this server gives. An API answer is never a page, so its policy can be the
 * strictest one there is: load nothing, frame nothing, be framed by nobody.
 */
const API_CSP = ["default-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ')

const API_PERMISSIONS = ['accelerometer=()', 'camera=()', 'display-capture=()', 'geolocation=()', 'microphone=()', 'payment=()', 'usb=()'].join(', ')

export function registerSecurityHeaders(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Content-Security-Policy', API_CSP)
    reply.header('X-Frame-Options', 'DENY')
    reply.header('X-Content-Type-Options', 'nosniff')
    // don't pass on the page someone came from: a reset link is in an address
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('Permissions-Policy', API_PERMISSIONS)
    reply.header('Cross-Origin-Opener-Policy', 'same-origin')
    reply.header('X-Permitted-Cross-Domain-Policies', 'none')
    if (!config.dev && req.protocol === 'https') reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  })
}
