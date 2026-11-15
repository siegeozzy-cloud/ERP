import { EmailInput, ResetPasswordInput, SignInInput, SignUpInput, linkTokenSchema, type CheckInboxResponse, type SignInResponse } from '@erp/shared'
import { hash, verify } from '@node-rs/argon2'
import { and, eq, gt } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../../config.ts'
import { db, isUniqueViolation } from '../../db/client.ts'
import { emailTokens, users, type UserRow } from '../../db/schema.ts'
import { hashToken, newToken } from '../../lib/crypto.ts'
import { HttpError, parse } from '../../lib/errors.ts'
import { sendMail } from '../../lib/mailer.ts'
import { endAllSessions, endSession, startSession } from '../../lib/session.ts'
import { clearFailures, describeWait, lockedFor, recordFailure } from '../../lib/throttle.ts'
import { alreadyRegistered, resetEmail, verifyEmail } from './emails.ts'
import { sessionOf } from './users.ts'

/** The token on a /verify or /reset link, checked before it's looked up. */
const LinkQuery = z.object({ token: linkTokenSchema })

/** Without Brevo or a mail server the link is printed in the API's terminal, so say so. */
const delivery = () => (config.mailConfigured ? ('email' as const) : ('console' as const))

const VERIFY_TTL = 24 * 60 * 60 * 1000
/** A reset link is a way into the account, so it's good for an hour rather than a day. */
const RESET_TTL = 60 * 60 * 1000
/** Don't email a new link more often than this. */
const RESEND_AFTER = 2 * 60 * 1000
const strict = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } })

// Checked against when the email isn't registered, so a wrong email takes as long as a wrong password
// (otherwise response times would reveal which emails have accounts).
const dummyHash = hash('erp-not-a-real-password')

type Purpose = 'verify' | 'reset'

/**
 * Emails a fresh link (replacing older ones of the same kind), unless one went out in the last two
 * minutes. If the mail server is down the account is unaffected and asking again later works.
 */
async function sendLink(user: UserRow, purpose: Purpose, force = false) {
  if (!force) {
    const recent = await db.query.emailTokens.findFirst({
      where: and(eq(emailTokens.userId, user.id), eq(emailTokens.purpose, purpose), gt(emailTokens.createdAt, new Date(Date.now() - RESEND_AFTER))),
    })
    if (recent) return
  }
  const token = newToken()
  const ttl = purpose === 'verify' ? VERIFY_TTL : RESET_TTL
  await db.transaction(async (tx) => {
    await tx.delete(emailTokens).where(and(eq(emailTokens.userId, user.id), eq(emailTokens.purpose, purpose)))
    await tx.insert(emailTokens).values({ id: hashToken(token), userId: user.id, purpose, expiresAt: new Date(Date.now() + ttl) })
  })
  const url = `${config.apiOrigin}/api/auth/${purpose}?token=${token}`
  try {
    await sendMail(purpose === 'verify' ? verifyEmail(user.email, user.name, url) : resetEmail(user.email, user.name, url))
  } catch (e) {
    console.error(`Couldn’t send the ${purpose} email to ${user.email}:`, (e as Error).message)
  }
}

/** Finds a link's token row, deleting it if it has expired. */
async function linkRow(token: string, purpose: Purpose) {
  const row = await db.query.emailTokens.findFirst({ where: and(eq(emailTokens.id, hashToken(token)), eq(emailTokens.purpose, purpose)) })
  if (!row) return 'invalid' as const
  if (row.expiresAt < new Date()) {
    await db.delete(emailTokens).where(eq(emailTokens.id, row.id))
    return 'expired' as const
  }
  return row
}

export default async function authRoutes(app: FastifyInstance) {
  /**
   * Always answers "check your inbox", whether or not the email is registered, so the form can't be
   * used to find out who has an account. The email itself tells the owner what happened.
   */
  app.post('/signup', strict(5), async (req, reply) => {
    const input = parse(SignUpInput, req.body)
    const passwordHash = await hash(input.password)
    const existing = await db.query.users.findFirst({ where: eq(users.email, input.email) })
    if (existing?.emailVerifiedAt) {
      await sendMail(alreadyRegistered(existing.email, existing.name)).catch((e: Error) => console.error('Couldn’t send the "already registered" email:', e.message))
    } else if (existing) {
      // never confirmed: the newest sign-up's details win and older links stop working, so only
      // whoever can read the inbox decides which password the account ends up with
      const [updated] = await db
        .update(users)
        .set({ name: input.name, passwordHash, termsAcceptedAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, existing.id))
        .returning()
      await sendLink(updated!, 'verify', true)
    } else {
      try {
        const [user] = await db.insert(users).values({ email: input.email, name: input.name, passwordHash, termsAcceptedAt: new Date() }).returning()
        await sendLink(user!, 'verify', true)
      } catch (e) {
        if (!isUniqueViolation(e, 'users_email_key')) throw e // signed up twice at once: the first one stands
      }
    }
    return reply.code(202).send({ status: 'verify-email', email: input.email, delivery: delivery() } satisfies CheckInboxResponse)
  })

  /** The link in the confirmation email. Lands on the web app's sign-in page with the result. */
  app.get('/verify', async (req, reply) => {
    const back = (result: string) => reply.redirect(`${config.appOrigin}/sign-in?verified=${result}`)
    const link = LinkQuery.safeParse(req.query)
    if (!link.success) return back('invalid')
    const row = await linkRow(link.data.token, 'verify')
    if (typeof row === 'string') return back(row)
    await db.transaction(async (tx) => {
      await tx.update(users).set({ emailVerifiedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, row.userId))
      await tx.delete(emailTokens).where(and(eq(emailTokens.userId, row.userId), eq(emailTokens.purpose, 'verify')))
    })
    return back('1')
  })

  app.post('/resend-verification', strict(3), async (req, reply) => {
    const { email } = parse(EmailInput, req.body)
    const user = await db.query.users.findFirst({ where: eq(users.email, email) })
    if (user && !user.emailVerifiedAt) await sendLink(user, 'verify')
    return reply.code(202).send({ status: 'verify-email', email, delivery: delivery() } satisfies CheckInboxResponse)
  })

  /**
   * Answers "check your inbox" whether or not the address has an account. An account that never
   * confirmed its email has no password worth resetting: signing up again claims it.
   */
  app.post('/forgot-password', strict(3), async (req, reply) => {
    const { email } = parse(EmailInput, req.body)
    const user = await db.query.users.findFirst({ where: eq(users.email, email) })
    if (user?.emailVerifiedAt) await sendLink(user, 'reset')
    return reply.code(202).send({ status: 'reset-sent', email, delivery: delivery() } satisfies CheckInboxResponse)
  })

  /**
   * The emailed reset link. It doesn't spend the token: it hands it to the web app, which asks for the
   * new password and sends both to /reset-password.
   */
  app.get('/reset', async (req, reply) => {
    const back = (query: string) => reply.redirect(`${config.appOrigin}/reset-password?${query}`)
    const link = LinkQuery.safeParse(req.query)
    if (!link.success) return back('error=invalid')
    const row = await linkRow(link.data.token, 'reset')
    if (typeof row === 'string') return back(`error=${row}`)
    return back(`token=${encodeURIComponent(link.data.token)}`)
  })

  /** Finishes the reset. The link works once, and everyone signed in with the old password is signed out. */
  app.post('/reset-password', strict(5), async (req, reply) => {
    const input = parse(ResetPasswordInput, req.body)
    const expired = new HttpError(400, 'bad-token', 'That link has expired or has already been used. Ask for a new one.', 'password')
    const row = await linkRow(input.token, 'reset')
    if (typeof row === 'string') throw expired
    const user = await db.query.users.findFirst({ where: eq(users.id, row.userId) })
    if (!user) throw expired
    const passwordHash = await hash(input.password)
    await db.transaction(async (tx) => {
      // opening the link proves the address is theirs, so an unconfirmed account is confirmed by it too
      await tx.update(users).set({ passwordHash, emailVerifiedAt: user.emailVerifiedAt ?? new Date(), updatedAt: new Date() }).where(eq(users.id, user.id))
      await tx.delete(emailTokens).where(eq(emailTokens.userId, user.id))
    })
    await endAllSessions(user.id, reply)
    return reply.code(204).send()
  })

  app.post('/signin', strict(10), async (req, reply) => {
    const input = parse(SignInInput, req.body)
    // Counted against the address, not the machine asking. See lib/throttle.ts.
    const key = `signin:${input.email}`
    const tooSoon = lockedFor(key)
    if (tooSoon) throw new HttpError(429, 'too-many-attempts', `Too many sign-in attempts. Try again in ${describeWait(tooSoon)}.`)

    const user = await db.query.users.findFirst({ where: eq(users.email, input.email) })
    const ok = user ? await verify(user.passwordHash, input.password) : (await verify(await dummyHash, input.password), false)
    if (!user || !ok) {
      const locked = recordFailure(key)
      if (locked) throw new HttpError(429, 'too-many-attempts', `Too many sign-in attempts. Try again in ${describeWait(locked)}.`)
      throw new HttpError(401, 'wrong-credentials', 'Wrong email or password.')
    }
    clearFailures(key)

    if (!user.emailVerifiedAt) {
      await sendLink(user, 'verify')
      const where = delivery() === 'console' ? 'The link is printed in the API’s terminal (no mail server is set up).' : `We sent a link to ${user.email}.`
      throw new HttpError(403, 'email-unverified', `Confirm your email first. ${where}`, 'email')
    }
    const token = await startSession(reply, user.id, input.remember)
    return { ...sessionOf(user), token } satisfies SignInResponse
  })

  app.post('/signout', async (req, reply) => {
    await endSession(req, reply)
    return reply.code(204).send()
  })

  /** The current session, or null. Not a 401, so a signed-out page load doesn't log an error. */
  app.get('/session', async (req) => ({ session: req.auth ? sessionOf(req.auth.user) : null }))
}
