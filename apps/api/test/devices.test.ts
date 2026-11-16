import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Role } from '@erp/shared'
import { eq } from 'drizzle-orm'
import { buildApp } from '../src/app.ts'
import { db, pool, runMigrations } from '../src/db/client.ts'
import { pushTokens, sessions, users } from '../src/db/schema.ts'
import { hashToken, newToken } from '../src/lib/crypto.ts'
import { testPushOutbox } from '../src/lib/push.ts'

// Phase 1M: the phone app's side of the API. Phones send no Origin header and use the bearer token.

const app = await buildApp()
const run = Date.now()

async function makeUser(name: string) {
  const [user] = await db
    .insert(users)
    .values({ email: `dev+${name.toLowerCase()}+${run}@example.com`, name, passwordHash: 'x', emailVerifiedAt: new Date(), termsAcceptedAt: new Date() })
    .returning()
  const token = newToken()
  await db.insert(sessions).values({ id: hashToken(token), userId: user!.id, remember: true, expiresAt: new Date(Date.now() + 3_600_000) })
  // like the phone app: a bearer token and no Origin header
  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => {
    const r = await app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } })
    return { status: r.statusCode, body: r.body ? r.json() : undefined }
  }
  return { id: user!.id, name, call }
}

let owner: Awaited<ReturnType<typeof makeUser>>
let member: Awaited<ReturnType<typeof makeUser>>
const phone = `ExponentPushToken[test${run}abcdefgh]`

before(async () => {
  await runMigrations()
  owner = await makeUser('Olivia')
  member = await makeUser('Mateo')
})
after(async () => {
  await app.close()
  await pool.end()
})

test('a phone registers for notifications, and a shared phone belongs to whoever signed in last', async () => {
  assert.equal((await owner.call('POST', '/api/devices', { token: 'not-a-token', platform: 'ios' })).status, 400)
  assert.equal((await owner.call('POST', '/api/devices', { token: phone, platform: 'android' })).status, 204)
  assert.equal((await owner.call('POST', '/api/devices', { token: phone, platform: 'android' })).status, 204)
  let [row] = await db.select().from(pushTokens).where(eq(pushTokens.token, phone))
  assert.equal(row!.userId, owner.id)

  await member.call('POST', '/api/devices', { token: phone, platform: 'android' })
  ;[row] = await db.select().from(pushTokens).where(eq(pushTokens.token, phone))
  assert.equal(row!.userId, member.id)

  // signing out removes only your own registration
  await owner.call('DELETE', '/api/devices', { token: phone })
  assert.equal((await db.select().from(pushTokens).where(eq(pushTokens.token, phone))).length, 1)
  await member.call('DELETE', '/api/devices', { token: phone })
  assert.equal((await db.select().from(pushTokens).where(eq(pushTokens.token, phone))).length, 0)

  assert.equal((await app.inject({ method: 'POST', url: '/api/devices', payload: { token: phone, platform: 'ios' } })).statusCode, 401)
})

test('joining tells the people who manage members, and a role change tells the member', async () => {
  const ws = (await owner.call('POST', '/api/workspaces', { template: 'food', name: 'Panaderia Olivia', tin: '555-666-777-00000', vatStatus: 'non_vat', street: 'Cebu City' })).body.workspace
  const roles = (await owner.call('GET', `/api/w/${ws.id}/roles`)).body.roles as Role[]
  const viewer = roles.find((r) => r.name === 'Viewer')!
  const code = (await owner.call('POST', `/api/w/${ws.id}/join-codes`, { roleId: viewer.id })).body.code.code

  const before = testPushOutbox.length
  const joined = await member.call('POST', '/api/workspaces/join', { code })
  assert.equal(joined.status, 200)
  const joinPush = testPushOutbox.at(-1)!
  assert.equal(testPushOutbox.length, before + 1)
  assert.deepEqual(joinPush.userIds, [owner.id])
  assert.equal(joinPush.body, 'Mateo joined as Viewer.')
  assert.deepEqual(joinPush.data, { workspaceId: ws.id, screen: 'members' })

  const accountant = roles.find((r) => r.name === 'Accountant')!
  await owner.call('PATCH', `/api/w/${ws.id}/members/${member.id}`, { roleId: accountant.id })
  const rolePush = testPushOutbox.at(-1)!
  assert.deepEqual(rolePush.userIds, [member.id])
  assert.equal(rolePush.body, 'Your role is now Accountant.')
})

test('the phone app can do what the web app does, without an Origin header', async () => {
  const mine = (await member.call('GET', '/api/workspaces')).body.workspaces
  assert.equal(mine.length, 1)
  const overview = await member.call('GET', `/api/w/${mine[0].id}/reports/overview`)
  assert.equal(overview.status, 200)
  assert.equal(typeof overview.body.overview.cash, 'number')
})
