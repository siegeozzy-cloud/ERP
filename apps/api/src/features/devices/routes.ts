import { DeviceInput } from '@erp/shared'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client.ts'
import { pushTokens } from '../../db/schema.ts'
import { parse } from '../../lib/errors.ts'
import { requireAuth, userOf } from '../../lib/session.ts'

/** /api/devices: the phone app registers for push notifications, and unregisters on sign-out. */
export default async function deviceRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  /** The token now belongs to whoever is signed in: a shared phone notifies its current user only. */
  app.post('/', async (req, reply) => {
    const input = parse(DeviceInput, req.body)
    const userId = userOf(req).id
    await db
      .insert(pushTokens)
      .values({ token: input.token, userId, platform: input.platform })
      .onConflictDoUpdate({ target: pushTokens.token, set: { userId, platform: input.platform, lastSeenAt: new Date() } })
    return reply.code(204).send()
  })

  app.delete('/', async (req, reply) => {
    const { token } = parse(z.object({ token: z.string().max(300) }), req.body)
    await db.delete(pushTokens).where(and(eq(pushTokens.token, token), eq(pushTokens.userId, userOf(req).id)))
    return reply.code(204).send()
  })
}
