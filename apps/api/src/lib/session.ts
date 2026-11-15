import { and, eq, gt } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.ts'
import { db } from '../db/client.ts'
import { sessions, users, type UserRow } from '../db/schema.ts'
import { hashToken, newToken } from './crypto.ts'
import { HttpError } from './errors.ts'

/**
 * A session is a random token the server keeps only as a SHA-256, so a database leak hands out
 * nothing. It reaches the server two ways:
 *
 * - as an httpOnly cookie, when the web app and the API share an address (development, through the
 *   Vite proxy). Scripts can't read it, which is the safest arrangement;
 * - as `Authorization: Bearer …`, for clients that can't use that cookie: the phone app, and the web
 *   app when it's deployed on a different site from the API.
 *
 * "Keep me signed in" makes it last 30 days; otherwise it ends with the browser, and within a day.
 */

export const SESSION_COOKIE = 'erp_session'
const DAY = 24 * 60 * 60 * 1000
const LONG = 30 * DAY

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in user, when the request has a valid session. */
    auth: { sessionId: string; user: UserRow } | null
  }
}

const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: !config.dev, path: '/' } as const

/** Starts a session: sets the cookie, and returns the token for clients that send it themselves. */
export async function startSession(reply: FastifyReply, userId: string, remember: boolean) {
  const token = newToken()
  await db.insert(sessions).values({ id: hashToken(token), userId, remember, expiresAt: new Date(Date.now() + (remember ? LONG : DAY)) })
  reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions, ...(remember ? { maxAge: LONG / 1000 } : {}) })
  return token
}

export async function endSession(req: FastifyRequest, reply: FastifyReply) {
  if (req.auth) await db.delete(sessions).where(eq(sessions.id, req.auth.sessionId))
  reply.clearCookie(SESSION_COOKIE, cookieOptions)
}

/** Signs a user out everywhere (after a password reset). */
export async function endAllSessions(userId: string, reply: FastifyReply) {
  await db.delete(sessions).where(eq(sessions.userId, userId))
  reply.clearCookie(SESSION_COOKIE, cookieOptions)
}

function tokenOf(req: FastifyRequest) {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7).trim()
  return req.cookies[SESSION_COOKIE]
}

export function registerSessions(app: FastifyInstance) {
  app.decorateRequest('auth', null)
  app.addHook('onRequest', async (req) => {
    const token = tokenOf(req)
    if (!token) return
    const id = hashToken(token)
    const [row] = await db
      .select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
    if (row) req.auth = { sessionId: id, user: row.user }
  })
}

/** preHandler for routes that need a signed-in user. */
export async function requireAuth(req: FastifyRequest) {
  if (!req.auth) throw new HttpError(401, 'signed-out', 'Sign in to continue.')
}

/** The signed-in user (call after requireAuth). */
export const userOf = (req: FastifyRequest) => req.auth!.user
