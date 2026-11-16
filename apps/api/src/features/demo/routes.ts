import { randomInt } from 'node:crypto'
import type { DemoStartResponse } from '@erp/shared'
import { hash } from '@node-rs/argon2'
import { and, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { config } from '../../config.ts'
import { db } from '../../db/client.ts'
import { demoAccounts, employees, timeEntries, users } from '../../db/schema.ts'
import { encrypt } from '../../lib/crypto.ts'
import { HttpError } from '../../lib/errors.ts'
import { startSession } from '../../lib/session.ts'
import { sessionOf } from '../auth/users.ts'
import { todayInManila } from '../finance/ledger.ts'
import { fromManila, manilaMinutes } from '../hr/time.ts'
import { buildDemo, purgeDemos } from './seed.ts'

/**
 * "Try the demo" (docs/roadmap.md, the investor demo). Each visitor gets their own copy of the demo
 * business, signed in as its owner: what one person does can't spoil it for the next. A copy is kept
 * built and waiting, so the button answers at once; when none is ready, one is built while the
 * visitor waits (a few seconds).
 *
 * Demos are wiped at 3 a.m. Manila time, and always last at least 12 hours. The job below does it,
 * whenever the server is awake (a free host sleeps when idle, so it also runs on waking).
 */

const HOUR = 3_600_000

/** The next 3 a.m. in Manila that's at least 12 hours away. */
export function demoExpiry(now = new Date()) {
  const manila = new Date(now.getTime() + 8 * HOUR)
  let at = Date.UTC(manila.getUTCFullYear(), manila.getUTCMonth(), manila.getUTCDate(), 3) - 8 * HOUR
  while (at < now.getTime() + 12 * HOUR) at += 24 * HOUR
  return new Date(at)
}

/** Easy to type on a phone: no 0/O or 1/l. */
function demoPassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyz23456789'
  const part = () => Array.from({ length: 4 }, () => letters[randomInt(letters.length)]).join('')
  return `${part()}-${part()}-${part()}`
}

/**
 * A spare tells a story ending the day before it was built. One from today is best; when there's
 * none (the free server slept through the night), one up to a week old is handed out rather than
 * keep the visitor waiting, and a fresh one is built behind it.
 */
const startOfManilaDay = () => fromManila(`${todayInManila()}T00:00`)
const SPARE_DAYS = 7

let running: Promise<void> | null = null

/** Deletes expired and stale demos, then builds spares up to DEMO_SPARES. One run at a time. */
export function tendDemos(app: FastifyInstance) {
  running ??= (async () => {
    try {
      const old = await db
        .select({ userId: demoAccounts.userId })
        .from(demoAccounts)
        .where(
          sql`(${demoAccounts.expiresAt} < now())
            OR (${demoAccounts.claimedAt} IS NULL AND ${demoAccounts.createdAt} < now() - make_interval(days => ${SPARE_DAYS}))
            OR (NOT ${demoAccounts.ready} AND ${demoAccounts.createdAt} < now() - interval '1 hour')`,
        )
      if (old.length) app.log.info(`Demo: deleting ${old.length} old demo(s).`)
      await purgeDemos(old.map((r) => r.userId))
      if (config.DEMO === 'off') return
      const today = startOfManilaDay()
      const [fresh] = await db.select({ n: count() }).from(demoAccounts).where(and(isNull(demoAccounts.claimedAt), eq(demoAccounts.ready, true), sql`${demoAccounts.createdAt} >= ${today}`))
      for (let n = fresh?.n ?? 0; n < config.DEMO_SPARES; n++) {
        const started = Date.now()
        await buildDemo(app)
        app.log.info(`Demo: a spare is ready (built in ${((Date.now() - started) / 1000).toFixed(1)} s).`)
      }
      // today's spares are ready, so older ones go
      if (config.DEMO_SPARES > 0) {
        const stale = await db.select({ userId: demoAccounts.userId }).from(demoAccounts).where(and(isNull(demoAccounts.claimedAt), eq(demoAccounts.ready, true), sql`${demoAccounts.createdAt} < ${today}`))
        await purgeDemos(stale.map((r) => r.userId))
      }
    } catch (e) {
      app.log.error(e, 'Demo: couldn’t tend the demos')
    } finally {
      running = null
    }
  })()
  return running
}

/** Runs tendDemos now and every 10 minutes, until the server closes. */
export function startDemoJobs(app: FastifyInstance) {
  const timer = setInterval(() => void tendDemos(app), 10 * 60_000)
  timer.unref()
  setTimeout(() => void tendDemos(app), 2_000).unref()
  app.addHook('onClose', async () => {
    clearInterval(timer)
    await running
  })
}

/** Hands a demo to a visitor: a spare if there is one, else one built now. */
export async function claimDemo(app: FastifyInstance) {
  const [active] = await db.select({ n: count() }).from(demoAccounts).where(isNotNull(demoAccounts.claimedAt))
  if ((active?.n ?? 0) >= config.DEMO_MAX_ACTIVE) {
    throw new HttpError(503, 'demo-full', 'A lot of people are trying the demo right now. Please try again in a few minutes.')
  }
  const password = demoPassword()
  const passwordHash = await hash(password)
  const claim = () =>
    db.transaction(async (tx) => {
      const [spare] = await tx
        .select()
        .from(demoAccounts)
        .where(and(isNull(demoAccounts.claimedAt), eq(demoAccounts.ready, true), sql`${demoAccounts.createdAt} >= now() - make_interval(days => ${SPARE_DAYS})`))
        .orderBy(desc(demoAccounts.createdAt))
        .limit(1)
        .for('update', { skipLocked: true })
      if (!spare) return null
      await tx.update(demoAccounts).set({ claimedAt: new Date(), expiresAt: demoExpiry(), passwordEnc: encrypt(password) }).where(eq(demoAccounts.userId, spare.userId))
      await tx.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, spare.userId))
      return spare
    })

  let demo = await claim()
  if (!demo) {
    await buildDemo(app)
    demo = await claim()
    if (!demo) throw new HttpError(503, 'demo-busy', 'The demo couldn’t be set up just now. Please try again.')
  }
  await clockInToday(demo.workspaceId)
  void tendDemos(app) // make the next spare
  return demo
}

/**
 * During working hours, the warehouse crew have clocked in this morning, so "who's in" isn't empty.
 * (A spare is built ahead of time, so this happens when it's claimed.)
 */
async function clockInToday(workspaceId: string) {
  const now = new Date()
  const minutes = manilaMinutes(now)
  if (minutes < 8 * 60 + 15 || minutes > 16 * 60) return
  const crew = await db
    .select({ id: employees.id })
    .from(employees)
    .where(and(eq(employees.workspaceId, workspaceId), eq(employees.tracksAttendance, true), inArray(employees.lastName, ['Bautista', 'Castro', 'Pascual'])))
  const today = todayInManila()
  await db
    .insert(timeEntries)
    .values(
      crew.map((e, i) => ({
        workspaceId,
        employeeId: e.id,
        clockIn: fromManila(`${today}T07:${String(48 + i * 4).padStart(2, '0')}`),
        inLatitude: 14.6587,
        inLongitude: 121.0306,
        inAccuracy: 9 + i * 3,
        source: 'phone',
      })),
    )
    .onConflictDoNothing()
}

export default async function demoRoutes(app: FastifyInstance, opts: { root: FastifyInstance }) {
  /** Whether the button should show. */
  app.get('/', async () => ({ enabled: config.DEMO === 'on' }))

  /** Starts a demo and signs the visitor in as its owner. Works from the web app and the phone. */
  app.post('/', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    if (config.DEMO === 'off') throw new HttpError(404, 'not-found', 'The demo is turned off on this server.')
    if (req.auth) {
      // already in a demo: go back to it rather than starting another
      const [mine] = await db.select().from(demoAccounts).where(and(eq(demoAccounts.userId, req.auth.user.id), isNotNull(demoAccounts.claimedAt), sql`${demoAccounts.expiresAt} > now()`))
      if (mine) return { ...(await sessionOf(req.auth.user)), token: null } satisfies DemoStartResponse
    }
    const demo = await claimDemo(opts.root)
    const [user] = await db.select().from(users).where(eq(users.id, demo.userId))
    const token = await startSession(reply, user!.id, true)
    return { ...(await sessionOf(user!)), token } satisfies DemoStartResponse
  })
}

/** How many demos there are, for tests and the log. */
export async function demoCounts() {
  const [row] = await db
    .select({ spares: sql<number>`count(*) filter (where ${demoAccounts.claimedAt} is null)`.mapWith(Number), claimed: sql<number>`count(*) filter (where ${demoAccounts.claimedAt} is not null)`.mapWith(Number) })
    .from(demoAccounts)
  return row ?? { spares: 0, claimed: 0 }
}

