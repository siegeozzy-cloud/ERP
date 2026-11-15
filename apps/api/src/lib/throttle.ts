// Password guessing, slowed down until it isn't worth it. Ported from Memoir.
//
// The per-IP limit in app.ts caps how fast one machine can ask, but an attacker with a pool of
// addresses walks past it, while a shared office address can be spent by people who mistyped. So
// wrong answers are also counted against the *account* being tried, and each failure past a small
// allowance locks that account's sign-in for longer than the last.
//
// Counted whether or not anyone has registered the address: an address with no account must behave
// exactly like one that's taken, or the lockout would reveal who has an account.
//
// Held in memory, not the database: a failed sign-in is something an attacker can ask for as fast as
// they like, and making each one a write would run up a database metered by the second. A restart
// forgets the counts, which is a fair trade.

type Attempts = { fails: number; until: number; touched: number }

/** Wrong answers allowed before the first lockout. */
const FREE = 5
/** What each failure past the allowance costs. The last value applies from then on. */
const LOCKOUTS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]
/** A key that has been quiet this long starts again from nothing. */
const FORGET_AFTER = 2 * 60 * 60_000
/** A ceiling, so someone cycling addresses can't grow this without limit. */
const MAX_KEYS = 20_000

const seen = new Map<string, Attempts>()

function current(key: string, now: number) {
  const a = seen.get(key)
  if (!a) return undefined
  if (a.until <= now && now - a.touched > FORGET_AFTER) {
    seen.delete(key)
    return undefined
  }
  return a
}

/** How much longer this key is locked out for, in ms. 0 means it may try now. */
export function lockedFor(key: string, now = Date.now()) {
  const a = current(key, now)
  return a && a.until > now ? a.until - now : 0
}

/** Counts one wrong answer. Returns how long the key is now locked out for, or 0. */
export function recordFailure(key: string, now = Date.now()) {
  const a = current(key, now) ?? { fails: 0, until: 0, touched: now }
  a.fails += 1
  a.touched = now
  const over = a.fails - FREE
  if (over > 0) a.until = now + LOCKOUTS[Math.min(over, LOCKOUTS.length) - 1]!
  seen.set(key, a)
  prune(now)
  return a.until > now ? a.until - now : 0
}

/** Forgets this key: the password was right, so nobody is guessing it. */
export const clearFailures = (key: string) => void seen.delete(key)

/** "45 seconds", "5 minutes", for the sentence the person reads. */
export function describeWait(ms: number) {
  const seconds = Math.ceil(ms / 1000)
  if (seconds <= 90) return `${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.ceil(seconds / 60)
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

/** Keeps the map bounded. Only runs when it's full, so an attacker can't make every failure expensive. */
function prune(now: number) {
  if (seen.size <= MAX_KEYS) return
  for (const [key, a] of seen) if (a.until <= now && now - a.touched > FORGET_AFTER) seen.delete(key)
  if (seen.size <= MAX_KEYS) return
  const oldestFirst = [...seen.entries()].sort((a, b) => a[1].touched - b[1].touched)
  for (const [key] of oldestFirst.slice(0, Math.ceil(MAX_KEYS / 4))) seen.delete(key)
}
