import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Account, AuditEntry, JoinCode, Member, Role } from '@erp/shared'
import { eq, sql } from 'drizzle-orm'
import Fastify from 'fastify'
import { buildApp } from '../src/app.ts'
import { db, pool, runMigrations } from '../src/db/client.ts'
import { joinCodes, psgcBarangays, psgcCities, psgcRegions, sessions, users } from '../src/db/schema.ts'
import { hashToken, newToken } from '../src/lib/crypto.ts'
import { workspaceScope } from '../src/lib/workspace.ts'

// Phase 1: workspaces from templates, join codes, roles and permissions, the audit log.
// Against the development database (npm run db:up), with fresh users each run.

const app = await buildApp()
const ORIGIN = 'http://127.0.0.1:5180'
const run = Date.now()

async function makeUser(name: string) {
  const [user] = await db
    .insert(users)
    .values({ email: `ws+${name.toLowerCase()}+${run}@example.com`, name, passwordHash: 'x', emailVerifiedAt: new Date(), termsAcceptedAt: new Date() })
    .returning()
  const token = newToken()
  await db.insert(sessions).values({ id: hashToken(token), userId: user!.id, remember: false, expiresAt: new Date(Date.now() + 3_600_000) })
  return { id: user!.id, token }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
let ipCounter = 0
const as = (token: string) => async (method: Method, url: string, payload?: object) => {
  // a different address per request, so the per-address limits don't get in the way of the per-person ones
  const r = await app.inject({ method, url, payload, headers: { origin: ORIGIN, authorization: `Bearer ${token}` }, remoteAddress: `10.20.${(ipCounter = (ipCounter + 1) % 250)}.${run % 250}` })
  return { status: r.statusCode, body: r.body ? r.json() : undefined }
}

const people: Record<string, { id: string; call: ReturnType<typeof as> }> = {}
let ws = ''
const w = (path: string) => `/api/w/${ws}${path}`
const roleId: Record<string, string> = {}

before(async () => {
  await runMigrations()
  for (const name of ['Alice', 'Bob', 'Carol', 'Dan', 'Eve']) {
    const u = await makeUser(name)
    people[name] = { id: u.id, call: as(u.token) }
  }
})
after(async () => {
  await app.close()
  await pool.end()
})

const alice = (...a: Parameters<ReturnType<typeof as>>) => people.Alice!.call(...a)
const bob = (...a: Parameters<ReturnType<typeof as>>) => people.Bob!.call(...a)
const carol = (...a: Parameters<ReturnType<typeof as>>) => people.Carol!.call(...a)

/** A code for a role, made by `who`. */
async function codeFor(who: typeof alice, role: string, expiresIn = '24h') {
  const r = await who('POST', w('/join-codes'), { roleId: roleId[role], expiresIn })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body.code.code as string
}

test('a route that names no permission stops the server from starting', async () => {
  const bare = Fastify()
  await assert.rejects(
    workspaceScope(bare, async (scoped) => {
      scoped.get('/oops', async () => ({}))
    }),
    /must say which permission it needs/,
  )
})

test('a workspace made from a template gets its modules, accounts and roles', async () => {
  const r = await alice('POST', '/api/workspaces', { template: 'wholesale', name: 'Bodega Distributors Inc.', tin: '333-444-555-00000', vatStatus: 'vat', street: '12 Rizal Ave.' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  ws = r.body.workspace.id
  assert.deepEqual(r.body.workspace.modules, ['finance', 'inventory', 'crm', 'hr'])
  assert.equal(r.body.workspace.role.name, 'Owner')
  assert.ok(r.body.workspace.permissions.includes('roles.manage'))

  const accounts = (await alice('GET', w('/accounts'))).body.accounts as Account[]
  assert.ok(accounts.some((a) => a.code === '1205' && a.name === 'Merchandise Inventory'))

  const roles = (await alice('GET', w('/roles'))).body.roles as Role[]
  assert.deepEqual(roles.map((x) => x.name), ['Owner', 'Admin', 'Accountant', 'Bookkeeper', 'HR & payroll', 'Production staff', 'Project manager', 'Sales', 'Viewer', 'Warehouse staff'])
  for (const x of roles) roleId[x.name] = x.id
  assert.equal(roles[0]!.memberCount, 1)

  const bad = await alice('POST', '/api/workspaces', { template: 'spaceships', name: 'X', tin: '333-444-555-00000', vatStatus: 'vat', street: 'x' })
  assert.equal(bad.body.error.field, 'template')
})

test('a join code works once, typed any way, and gives its role', async () => {
  const code = await codeFor(alice, 'Bookkeeper')
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  assert.doesNotMatch(code, /[01ILO]/)

  // stored only as a hash
  const [stored] = await db.select().from(joinCodes).where(eq(joinCodes.codeHash, hashToken(code.replace('-', ''))))
  assert.ok(stored)

  const joined = await bob('POST', '/api/workspaces/join', { code: code.toLowerCase().replace('-', ' ') })
  assert.equal(joined.status, 200, JSON.stringify(joined.body))
  assert.equal(joined.body.workspace.id, ws)
  assert.equal(joined.body.workspace.role.name, 'Bookkeeper')

  const again = await carol('POST', '/api/workspaces/join', { code })
  assert.equal(again.body.error.code, 'bad-code')

  const list = (await alice('GET', w('/join-codes'))).body.codes as JoinCode[]
  assert.equal(list[0]!.status, 'used')
  assert.equal(list[0]!.usedBy, 'Bob')
})

test('what a role allows is what the API allows', async () => {
  const customer = (await alice('POST', w('/contacts'), { name: 'Tindahan ni Aling Nena', isCustomer: true })).body.contact
  const sales = ((await alice('GET', w('/accounts'))).body.accounts as Account[]).find((a) => a.systemKey === 'sales')!

  // a bookkeeper prepares drafts…
  assert.equal((await bob('GET', w('/invoices'))).status, 200)
  const draft = await bob('POST', w('/invoices'), { customerId: customer.id, date: '2026-10-01', lines: [{ description: 'Rice, 50 kg', quantity: 3, unitPrice: 2_500_00, vat: 'vatable', accountId: sales.id }] })
  assert.equal(draft.status, 201)
  // …but can't post them, see the audit log, or invite people
  const post = await bob('POST', w(`/invoices/${draft.body.invoice.id}/post`))
  assert.equal(post.status, 403)
  assert.match(post.body.error.message, /Bookkeeper/)
  assert.equal((await bob('GET', w('/audit'))).status, 403)
  assert.equal((await bob('POST', w('/join-codes'), { roleId: roleId.Viewer })).status, 403)

  // as an accountant, posting works
  assert.equal((await alice('PATCH', w(`/members/${people.Bob!.id}`), { roleId: roleId.Accountant })).status, 200)
  assert.equal((await bob('POST', w(`/invoices/${draft.body.invoice.id}/post`))).status, 200)
})

test('admins can’t make owners or touch the owner', async () => {
  await carol('POST', '/api/workspaces/join', { code: await codeFor(alice, 'Admin') })
  const ownerCode = await carol('POST', w('/join-codes'), { roleId: roleId.Owner })
  assert.equal(ownerCode.status, 403)
  const demote = await carol('PATCH', w(`/members/${people.Alice!.id}`), { roleId: roleId.Viewer })
  assert.equal(demote.status, 403)
  const remove = await carol('DELETE', w(`/members/${people.Alice!.id}`))
  assert.equal(remove.status, 403)
  // but can manage everyone else
  assert.equal((await carol('PATCH', w(`/members/${people.Bob!.id}`), { roleId: roleId.Bookkeeper })).status, 200)
})

test('there is always an owner', async () => {
  const demote = await alice('PATCH', w(`/members/${people.Alice!.id}`), { roleId: roleId.Admin })
  assert.equal(demote.body.error.code, 'last-owner')
  const leave = await alice('DELETE', w(`/members/${people.Alice!.id}`))
  assert.equal(leave.body.error.code, 'last-owner')

  // with a second owner, the first may step down
  await alice('PATCH', w(`/members/${people.Carol!.id}`), { roleId: roleId.Owner })
  assert.equal((await alice('PATCH', w(`/members/${people.Alice!.id}`), { roleId: roleId.Admin })).status, 200)
  // and back, by the new owner
  assert.equal((await carol('PATCH', w(`/members/${people.Alice!.id}`), { roleId: roleId.Owner })).status, 200)

  const members = (await alice('GET', w('/members'))).body.members as Member[]
  assert.deepEqual(members.map((m) => `${m.name}:${m.role.name}`), ['Alice:Owner', 'Bob:Bookkeeper', 'Carol:Owner'])
})

test('roles: custom ones, fixed ones, and no granting what you don’t have', async () => {
  const created = await alice('POST', w('/roles'), { name: 'Cashier', description: 'Records payments', permissions: ['finance.view', 'finance.post'] })
  assert.equal(created.status, 201)
  const dup = await alice('POST', w('/roles'), { name: 'Cashier', permissions: [] })
  assert.equal(dup.body.error.field, 'name')
  assert.equal((await alice('PUT', w(`/roles/${roleId.Owner}`), { name: 'Boss', permissions: [] })).body.error.code, 'fixed-role')
  assert.equal((await alice('DELETE', w(`/roles/${roleId.Bookkeeper}`))).body.error.code, 'in-use')
  assert.equal((await alice('DELETE', w(`/roles/${created.body.role.id}`))).status, 204)

  // a custom role that may manage roles, but has no finance permissions, can't hand finance out
  await alice('POST', w('/roles'), { name: 'Role manager', permissions: ['roles.manage', 'members.view'] })
  const rm = ((await alice('GET', w('/roles'))).body.roles as Role[]).find((r) => r.name === 'Role manager')!
  roleId['Role manager'] = rm.id
  await people.Dan!.call('POST', '/api/workspaces/join', { code: await codeFor(alice, 'Role manager') })
  const escalate = await people.Dan!.call('POST', w('/roles'), { name: 'Sneaky', permissions: ['finance.post'] })
  assert.equal(escalate.status, 403)
  // nor take role management away from their own role
  const lockout = await people.Dan!.call('PUT', w(`/roles/${rm.id}`), { name: 'Role manager', permissions: ['members.view'] })
  assert.equal(lockout.body.error.code, 'own-role')
})

test('wrong codes are limited per person, and expired or revoked codes don’t work', async () => {
  const eve = people.Eve!.call
  for (let i = 0; i < 5; i++) assert.equal((await eve('POST', '/api/workspaces/join', { code: 'AAAA-AAAA' })).body.error.code, 'bad-code')
  const locked = await eve('POST', '/api/workspaces/join', { code: 'AAAA-AAAA' })
  assert.equal(locked.status, 429)
  // even a good code waits until the lockout ends
  const good = await codeFor(alice, 'Viewer')
  assert.equal((await eve('POST', '/api/workspaces/join', { code: good })).status, 429)

  const revoked = await alice('POST', w('/join-codes'), { roleId: roleId.Viewer })
  assert.equal((await alice('POST', w(`/join-codes/${revoked.body.code.id}/revoke`))).status, 200)
  assert.equal((await alice('POST', w(`/join-codes/${revoked.body.code.id}/revoke`))).body.error.code, 'not-active')
  const someoneElse = await makeUser(`Frank${run}`)
  assert.equal((await as(someoneElse.token)('POST', '/api/workspaces/join', { code: revoked.body.code.code })).body.error.code, 'bad-code')

  const expiring = await alice('POST', w('/join-codes'), { roleId: roleId.Viewer, expiresIn: '1h' })
  await db.execute(sql`update join_codes set expires_at = now() - interval '1 minute' where id = ${expiring.body.code.id}`)
  assert.equal((await as(someoneElse.token)('POST', '/api/workspaces/join', { code: expiring.body.code.code })).body.error.code, 'bad-code')
})

test('the address can be picked from the PSGC and is written out in full', async () => {
  // the real codes for one Manila barangay, in case the list hasn't been loaded on this machine
  await db.insert(psgcRegions).values({ code: '130000000', name: 'National Capital Region', shortName: 'Metro Manila' }).onConflictDoNothing()
  await db.insert(psgcCities).values({ code: '133900000', name: 'City of Manila', regionCode: '130000000', provinceCode: null, isCity: true }).onConflictDoNothing()
  await db.insert(psgcBarangays).values({ code: '133901001', name: 'Barangay 1', cityCode: '133900000' }).onConflictDoNothing()

  const regions = await alice('GET', '/api/psgc/regions')
  assert.ok(regions.body.places.some((p: { code: string }) => p.code === '130000000'))
  const ncr = await alice('GET', '/api/psgc/provinces?region=130000000')
  assert.equal(ncr.body.independentCities, true)
  const cities = await alice('GET', '/api/psgc/cities?region=130000000&province=none')
  assert.ok(cities.body.places.some((p: { name: string }) => p.name === 'City of Manila'))

  const current = (await alice('GET', w(''))).body.workspace
  const update = { ...current, street: '88 Mabini St.', barangayCode: '133901001', dpoName: 'Alice Reyes', dpoEmail: 'dpo@example.com' }
  const r = await alice('PATCH', w(''), update)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.workspace.registeredAddress, '88 Mabini St., Barangay 1, City of Manila, Metro Manila')
  assert.equal((await alice('PATCH', w(''), { ...update, barangayCode: '999999999' })).body.error.field, 'barangayCode')

  // a posted invoice exists, so the tax type is fixed now
  const vat = await alice('PATCH', w(''), { ...update, vatStatus: 'non_vat' })
  assert.equal(vat.body.error.code, 'has-documents')
  // and only those who may manage the workspace can change it
  assert.equal((await bob('PATCH', w(''), update)).status, 403)
})

test('every change is in the audit log, and the log can’t be altered', async () => {
  const entries = (await alice('GET', w('/audit'))).body.entries as AuditEntry[]
  const actions = new Set(entries.map((e) => e.action))
  for (const a of ['workspace.created', 'join_code.created', 'member.joined', 'member.role_changed', 'invoice.drafted', 'invoice.posted', 'role.created', 'role.deleted', 'workspace.updated', 'contact.created']) {
    assert.ok(actions.has(a), `missing ${a}`)
  }
  const roleChange = entries.find((e) => e.action === 'member.role_changed' && e.summary.includes('Bob'))!
  assert.match(roleChange.summary, /Changed Bob’s role from/)
  assert.ok(roleChange.actor)
  const posted = entries.find((e) => e.action === 'invoice.posted')!
  assert.equal(posted.actor!.name, 'Bob')

  const refused = (e: unknown) => /audit log can.t be changed/.test(String((e as { cause?: Error }).cause?.message))
  await assert.rejects(db.execute(sql`update audit_log set summary = 'nothing happened' where id = ${roleChange.id}`), refused)
  await assert.rejects(db.execute(sql`delete from audit_log where id = ${roleChange.id}`), refused)
})

test('leaving a workspace', async () => {
  assert.equal((await bob('DELETE', w(`/members/${people.Bob!.id}`))).status, 204)
  assert.equal((await bob('GET', w('/invoices'))).status, 404)
  const mine = (await bob('GET', '/api/workspaces')).body.workspaces as { id: string }[]
  assert.ok(!mine.some((x) => x.id === ws))
})

test('every template makes a workspace (its accounts don’t clash with the standard chart)', async () => {
  const { TEMPLATES } = await import('@erp/shared')
  const u = as((await makeUser('Tess')).token)
  for (const t of TEMPLATES) {
    const r = await u('POST', '/api/workspaces', { template: t.key, name: `Template ${t.key}`, tin: '123-456-789-00000', vatStatus: 'vat', street: 'Manila' })
    assert.equal(r.status, 201, `${t.key}: ${JSON.stringify(r.body)}`)
  }
})
