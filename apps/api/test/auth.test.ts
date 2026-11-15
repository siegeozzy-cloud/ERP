import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { buildApp } from '../src/app.ts'
import { pool, runMigrations } from '../src/db/client.ts'
import { decrypt, encrypt } from '../src/lib/crypto.ts'
import { testOutbox } from '../src/lib/mailer.ts'
import { clearFailures, describeWait, lockedFor, recordFailure } from '../src/lib/throttle.ts'

// Runs against the development database (npm run db:up), with a fresh email each run.
// The whole account life: sign up → confirm email → sign in → session → reset password → sign out.

const app = await buildApp()
const ORIGIN = 'http://127.0.0.1:5180'
const email = `test+${Date.now()}@example.com`
let password = 'correct horse battery staple'

type Method = 'POST' | 'GET'
/** Each test picks its own address, so the per-IP rate limits of one test don't spill into the next. */
const call = (method: Method, url: string, opts: { payload?: object; ip?: string; headers?: Record<string, string> } = {}) =>
  app.inject({ method, url, payload: opts.payload, remoteAddress: opts.ip ?? '127.0.0.1', headers: { origin: ORIGIN, ...opts.headers } })
const lastLink = () => /https?:\/\/\S+/.exec(testOutbox.at(-1)!.text)![0]
const pathOf = (url: string) => {
  const u = new URL(url)
  return u.pathname + u.search
}

before(async () => {
  await runMigrations()
})
after(async () => {
  await app.close()
  await pool.end()
})

test('ping and health answer', async () => {
  assert.deepEqual((await call('GET', '/api/ping')).json(), { ok: true })
  assert.deepEqual((await call('GET', '/api/health')).json(), { ok: true, db: true })
})

test('sign-up checks every field, with messages for people', async () => {
  const cases: [object, string][] = [
    [{ name: 'Maria', email: 'not-an-email', password, acceptedTerms: true }, 'email'],
    [{ name: 'Maria', email, password: 'short', acceptedTerms: true }, 'password'],
    [{ name: 'M4ria <script>', email, password, acceptedTerms: true }, 'name'],
    [{ name: 'Maria', email, password, acceptedTerms: false }, 'acceptedTerms'],
  ]
  for (const [payload, field] of cases) {
    const r = await call('POST', '/api/auth/signup', { payload, ip: '10.0.1.1' })
    assert.equal(r.statusCode, 400, field)
    assert.equal(r.json().error.field, field)
    assert.ok(r.json().error.message.length > 5)
  }
  // names from any language, with apostrophes and hyphens, are fine
  const ok = await call('POST', '/api/auth/signup', { payload: { name: "  María   Dela Cruz-Santos ", email, password, acceptedTerms: true }, ip: '10.0.1.1' })
  assert.equal(ok.statusCode, 202)
  // no mail server in tests, so the link would be printed in the terminal
  assert.deepEqual(ok.json(), { status: 'verify-email', email, delivery: 'console' })
  assert.match(testOutbox.at(-1)!.subject, /Confirm your email/)
})

test('sign-up is limited to 5 tries a minute per address', async () => {
  const r = await call('POST', '/api/auth/signup', { payload: { name: 'Someone', email, password, acceptedTerms: true }, ip: '10.0.1.1' })
  assert.equal(r.statusCode, 429)
  assert.equal(r.json().error.code, 'rate-limited')
})

test('sign-in waits for the email to be confirmed', async () => {
  const r = await call('POST', '/api/auth/signin', { payload: { email, password }, ip: '10.0.2.1' })
  assert.equal(r.statusCode, 403)
  assert.equal(r.json().error.code, 'email-unverified')
})

test('the emailed link confirms the address once', async () => {
  const link = pathOf(lastLink())
  const r = await call('GET', link)
  assert.equal(r.statusCode, 302)
  assert.equal(r.headers.location, `${ORIGIN}/sign-in?verified=1`)
  const again = await call('GET', link)
  assert.equal(again.headers.location, `${ORIGIN}/sign-in?verified=invalid`)
})

test('signing up again with a registered email reveals nothing', async () => {
  const r = await call('POST', '/api/auth/signup', { payload: { name: 'Someone', email, password: 'another password', acceptedTerms: true }, ip: '10.0.3.1' })
  assert.equal(r.statusCode, 202)
  assert.deepEqual(r.json(), { status: 'verify-email', email, delivery: 'console' })
  // the owner is told by email instead
  assert.match(testOutbox.at(-1)!.subject, /already have/)
})

test('a wrong password and an unknown email get the same answer', async () => {
  const wrong = await call('POST', '/api/auth/signin', { payload: { email, password: 'not it at all' }, ip: '10.0.4.1' })
  const unknown = await call('POST', '/api/auth/signin', { payload: { email: `nobody+${Date.now()}@example.com`, password }, ip: '10.0.4.1' })
  assert.equal(wrong.statusCode, 401)
  assert.deepEqual(wrong.json(), unknown.json())
  clearFailures(`signin:${email}`)
})

let token = ''

test('sign-in sets the cookie and returns a token for the phone app', async () => {
  const r = await call('POST', '/api/auth/signin', { payload: { email: email.toUpperCase(), password, remember: true }, ip: '10.0.5.1' })
  assert.equal(r.statusCode, 200)
  const body = r.json()
  assert.equal(body.user.email, email)
  assert.equal(body.user.name, 'María Dela Cruz-Santos')
  assert.equal(body.token.length, 43)
  assert.equal(body.passwordHash, undefined)
  token = body.token
  const setCookie = String(r.headers['set-cookie'])
  assert.match(setCookie, /erp_session=/)
  assert.match(setCookie, /HttpOnly/)

  // the cookie works (web app)…
  const viaCookie = await call('GET', '/api/auth/session', { headers: { cookie: `erp_session=${token}` } })
  assert.equal(viaCookie.json().session.user.email, email)
  // …and so does the bearer token (phone app, cross-site web app)
  const viaBearer = await call('GET', '/api/auth/session', { headers: { authorization: `Bearer ${token}` } })
  assert.equal(viaBearer.json().session.user.email, email)
  // no credentials: null, not an error
  const none = await call('GET', '/api/auth/session')
  assert.equal(none.statusCode, 200)
  assert.equal(none.json().session, null)
})

test('changes from another website are refused', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/auth/signout', headers: { origin: 'https://evil.example', authorization: `Bearer ${token}` } })
  assert.equal(r.statusCode, 403)
  assert.equal(r.json().error.code, 'bad-origin')
  // and the phone app, which sends no Origin, is let through
  const phone = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { authorization: `Bearer ${token}` } })
  assert.equal(phone.json().session.user.email, email)
})

test('a password reset works once and signs everyone out', async () => {
  const forgot = await call('POST', '/api/auth/forgot-password', { payload: { email }, ip: '10.0.6.1' })
  assert.equal(forgot.statusCode, 202)
  assert.equal(forgot.json().status, 'reset-sent')
  assert.match(testOutbox.at(-1)!.subject, /new .* password/)

  // the emailed link hands the token to the web app's reset page
  const landing = await call('GET', pathOf(lastLink()))
  assert.equal(landing.statusCode, 302)
  const location = new URL(landing.headers.location as string)
  assert.equal(location.pathname, '/reset-password')
  const resetToken = location.searchParams.get('token')!
  assert.ok(resetToken)

  password = 'a brand new passphrase'
  const done = await call('POST', '/api/auth/reset-password', { payload: { token: resetToken, password }, ip: '10.0.6.1' })
  assert.equal(done.statusCode, 204)
  const reused = await call('POST', '/api/auth/reset-password', { payload: { token: resetToken, password }, ip: '10.0.6.1' })
  assert.equal(reused.json().error.code, 'bad-token')

  // the old session is gone
  const old = await call('GET', '/api/auth/session', { headers: { authorization: `Bearer ${token}` } })
  assert.equal(old.json().session, null)
  const fresh = await call('POST', '/api/auth/signin', { payload: { email, password }, ip: '10.0.6.2' })
  assert.equal(fresh.statusCode, 200)
  token = fresh.json().token
})

test('a reset link that was never issued lands on an error', async () => {
  const r = await call('GET', '/api/auth/reset?token=nope')
  assert.equal(r.headers.location, `${ORIGIN}/reset-password?error=invalid`)
})

test('sign-out ends the session', async () => {
  const r = await call('POST', '/api/auth/signout', { headers: { authorization: `Bearer ${token}` } })
  assert.equal(r.statusCode, 204)
  const after = await call('GET', '/api/auth/session', { headers: { authorization: `Bearer ${token}` } })
  assert.equal(after.json().session, null)
})

test('repeated wrong passwords lock the account for longer each time', () => {
  const key = `signin:locktest+${Date.now()}@example.com`
  const now = 1_000_000
  for (let i = 0; i < 5; i++) assert.equal(recordFailure(key, now), 0)
  assert.equal(recordFailure(key, now), 60_000)
  assert.equal(lockedFor(key, now + 30_000), 30_000)
  assert.equal(recordFailure(key, now), 5 * 60_000)
  assert.equal(describeWait(45_000), '45 seconds')
  assert.equal(describeWait(5 * 60_000), '5 minutes')
  clearFailures(key)
  assert.equal(lockedFor(key, now), 0)
})

test('sensitive values are encrypted and come back intact', () => {
  const tin = '123-456-789-00000'
  const sealed = encrypt(tin)
  assert.ok(!sealed.includes(tin))
  assert.notEqual(encrypt(tin), sealed, 'a fresh IV each time')
  assert.equal(decrypt(sealed), tin)
  const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA')
  assert.throws(() => decrypt(tampered))
})
