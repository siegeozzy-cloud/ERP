import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Account, DemoStartResponse, InventoryOverview, Lead, LeaveRequest, PayrollRunSummary, SalesOrderSummary, Session, TrialBalance, Unit } from '@erp/shared'
import { count, eq, sql } from 'drizzle-orm'
import { buildApp } from '../src/app.ts'
import { db, pool, runMigrations } from '../src/db/client.ts'
import { demoAccounts, journalEntries, sessions, users, workspaces } from '../src/db/schema.ts'
import { claimDemo, demoExpiry, tendDemos } from '../src/features/demo/routes.ts'
import { buildDemo, purgeDemos } from '../src/features/demo/seed.ts'
import { hashToken, newToken } from '../src/lib/crypto.ts'

// The investor demo: "Try the demo" hands each visitor their own copy of Sariwa Food Supply Co., a
// food distributor with three months of history built through the API. Food is the finished
// niche: its write-offs go to Spoilage, and expired lots are never sold.

const app = await buildApp()
let built: { userId: string; workspaceId: string }
let token = ''
const w = (p: string) => `/api/w/${built.workspaceId}${p}`
const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object, bearer = token) => {
  const r = await app.inject({ method, url, payload, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} })
  return { status: r.statusCode, body: r.body ? r.json() : undefined }
}
const acct: Record<string, string> = {}
const balanceOf = async (key: string) => {
  const tb = (await call('GET', w('/reports/trial-balance?asOf=2099-12-31'))).body.report as TrialBalance
  return tb.rows.find((r) => r.id === acct[key])?.balance ?? 0
}

before(async () => {
  await runMigrations()
})
after(async () => {
  await app.close()
  await pool.end()
})

test('the demo business is built through the API, and its books add up', async () => {
  const started = Date.now()
  built = await buildDemo(app)
  console.log(`  demo built in ${((Date.now() - started) / 1000).toFixed(1)} s`)
  token = newToken()
  await db.insert(sessions).values({ id: hashToken(token), userId: built.userId, remember: false, expiresAt: new Date(Date.now() + 3_600_000) })
  for (const a of (await call('GET', w('/accounts'))).body.accounts as Account[]) if (a.systemKey) acct[a.systemKey] = a.id

  const tb = (await call('GET', w('/reports/trial-balance?asOf=2099-12-31'))).body.report as TrialBalance
  assert.equal(tb.totalDebit, tb.totalCredit)
  const valuation = (await call('GET', w('/inventory/valuation?asOf=2099-12-31'))).body.total as number
  assert.equal(valuation, await balanceOf('inventory'))
  assert.ok(valuation > 500_000_00, `stock worth ${valuation}`)

  // the Food template: its units, and spoilage on its own account
  const units = (await call('GET', w('/units'))).body.units as Unit[]
  assert.ok(['tray', 'crate', 'case', 'pail'].every((c) => units.some((u) => u.code === c)))
  assert.ok((await balanceOf('spoilage')) > 0)
  // the only count difference is the expired trays found yesterday, left for the visitor to write off
  assert.equal(await balanceOf('inventory_adjustments'), -6 * 215_00)
  const expired = ((await call('GET', w('/inventory/overview'))).body.overview as InventoryOverview).expiring.filter((e) => e.expiryDate < new Date().toISOString().slice(0, 10))
  assert.deepEqual(expired.map((e) => [e.sku, e.quantity]), [['EGGS-30', 6]])

  // a business mid-stream: unpaid and overdue invoices, open orders, a pipeline
  const overview = (await call('GET', w('/reports/overview'))).body.overview
  assert.ok(overview.receivables > 0 && overview.payables > 0 && overview.overdueInvoices > 0, JSON.stringify(overview))
  const orders = (await call('GET', w('/sales-orders'))).body.salesOrders as SalesOrderSummary[]
  for (const s of ['draft', 'confirmed', 'partly_delivered', 'closed']) assert.ok(orders.some((o) => o.status === s), `an order that is ${s}`)
  const leads = (await call('GET', w('/leads'))).body.leads as Lead[]
  for (const s of ['new', 'qualified', 'negotiation', 'won', 'lost']) assert.ok(leads.some((l) => l.stage === s), `a lead that is ${s}`)
  const stock = (await call('GET', w('/inventory/overview'))).body.overview as InventoryOverview
  assert.ok(stock.low.some((i) => i.sku === 'YEAST-500'), 'yeast is running low')
  assert.ok(stock.openPurchaseOrders >= 1)

  // people: six members, nine employees, payroll posted (the latest not yet paid), leave waiting
  assert.equal((await call('GET', w('/members'))).body.members.length, 6)
  assert.equal((await call('GET', w('/employees'))).body.employees.length, 9)
  const runs = (await call('GET', w('/payroll/runs'))).body.runs as PayrollRunSummary[]
  assert.ok(runs.length >= 4)
  assert.ok(runs.every((r) => r.status !== 'draft'))
  assert.equal(runs.filter((r) => r.status === 'posted').length, 1)
  const pending = (await call('GET', w('/leave/requests?status=pending'))).body.requests as LeaveRequest[]
  assert.equal(pending.length, 2)
  const me = (await call('GET', w('/me/hr'))).body.me
  assert.equal(me.employee.name, 'Carmela Santos')
  assert.ok(me.payslips.length >= 4)
  // the premix room: two BOMs, weekly work orders completed with QC, one started and one released for the visitor
  assert.equal((await call('GET', w('/boms'))).body.boms.length, 2)
  const wos = (await call('GET', w('/work-orders'))).body.workOrders as { status: string; rejectedQty: number }[]
  assert.ok(wos.filter((x) => x.status === 'completed').length >= 6, `${wos.length} work orders`)
  assert.ok(wos.some((x) => x.rejectedQty > 0), 'some bags rejected in QC')
  assert.equal(wos.filter((x) => x.status === 'in_progress').length, 1)
  assert.equal(wos.filter((x) => x.status === 'released').length, 1)
  // what's in work in process is the started work order's materials
  assert.ok((await balanceOf('wip')) > 0)
  assert.ok((await balanceOf('applied_overhead')) < 0)
  // projects: the cold room expansion (internal, with contractors' bills) and an hourly service to the hotel
  const prjs = (await call('GET', w('/projects'))).body.projects as { id: string; billing: string; costToDate: number; percentComplete: number }[]
  assert.equal(prjs.length, 2)
  const expansion = prjs.find((x) => x.billing === 'none')!
  assert.ok(expansion.costToDate > 380_000_00 && expansion.percentComplete > 0 && expansion.percentComplete < 100)
  const service = (await call('GET', w(`/projects/${prjs.find((x) => x.billing === 'hourly')!.id}`))).body.project
  assert.ok(service.costing.revenue > 0 && service.costing.unbilledHours > 0)
  // the visitor has tasks of their own, on the web and the phone
  const myTasks = (await call('GET', w('/me/tasks'))).body.tasks as { fieldWork: boolean }[]
  assert.ok(myTasks.length >= 3 && myTasks.some((t) => t.fieldWork))
    // government contributions were remitted: what's left is the latest month's at most
  assert.ok((await balanceOf('sss_payable')) <= 0)
})

test('Food: an expired lot is never sold, and writing it off goes to Spoilage', async () => {
  const pc = ((await call('GET', w('/units'))).body.units as Unit[]).find((u) => u.code === 'tray')!.id
  const main = (await call('GET', w('/warehouses'))).body.warehouses[0].id
  const customer = (await call('POST', w('/contacts'), { name: 'Test buyer', isCustomer: true })).body.contact.id
  const item = (await call('POST', w('/items'), { sku: 'TEST-QUAIL', name: 'Quail eggs, tray', unitId: pc, salesPrice: 150_00, trackLots: true, trackExpiry: true })).body.item.id
  await call('POST', w('/stock/adjustments'), {
    date: '2026-01-01',
    warehouseId: main,
    reason: 'opening',
    lines: [
      { itemId: item, change: 5, unitCost: 100_00, lotNo: 'OLD', expiryDate: '2026-01-10' },
      { itemId: item, change: 3, unitCost: 100_00, lotNo: 'NEW', expiryDate: '2026-02-28' },
    ],
  })
  const sale = (qty: number, extra = {}) =>
    call('POST', w('/invoices'), { customerId: customer, warehouseId: main, date: '2026-01-20', lines: [{ description: 'Quail eggs', quantity: qty, unitPrice: 150_00, vat: 'vatable', accountId: acct.sales, itemId: item, ...extra }] })
  const tooMany = (await sale(4)).body.invoice.id
  const refused = await call('POST', w(`/invoices/${tooMany}/post`))
  assert.equal(refused.body.error.code, 'not-enough-stock')
  assert.match(refused.body.error.message, /only 3 tray .*\(5 more tray there have expired\)/)
  await call('DELETE', w(`/invoices/${tooMany}`))

  // three can go, all from the lot still good
  const ok = (await sale(3)).body.invoice.id
  assert.equal((await call('POST', w(`/invoices/${ok}/post`))).status, 200)
  const levels = (await call('GET', w(`/items/${item}`))).body.item.levels as { lot: { lotNo: string }; quantity: number }[]
  assert.deepEqual(levels.map((l) => `${l.lot.lotNo}:${l.quantity}`), ['OLD:5'])

  const spoilageBefore = await balanceOf('spoilage')
  const off = await call('POST', w('/stock/adjustments'), { date: '2026-01-20', warehouseId: main, reason: 'expired', lines: [{ itemId: item, change: -5, lotNo: 'OLD' }] })
  assert.equal(off.status, 201, JSON.stringify(off.body))
  assert.equal((await balanceOf('spoilage')) - spoilageBefore, 500_00)
})

test('“Try the demo” hands out a demo, signs the visitor in, and gives them a password for the phone', async () => {
  const r = await call('POST', '/api/demo', undefined, '')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const started = r.body as DemoStartResponse
  assert.ok(started.token)
  assert.equal(started.user.name, 'Carmela Santos')
  assert.ok(started.demo && started.demo.email.endsWith('@demo.example.com'))
  assert.match(started.demo.password, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/)
  assert.ok(new Date(started.demo.expiresAt).getTime() - Date.now() >= 12 * 3_600_000)

  // the phone signs in with what the banner shows
  const phone = await call('POST', '/api/auth/signin', { email: started.demo.email, password: started.demo.password, remember: true }, '')
  assert.equal(phone.status, 200, JSON.stringify(phone.body))
  assert.equal((phone.body as Session).demo?.workspaceId, started.demo.workspaceId)

  // pressing it again in the same browser goes back to the same demo
  const again = await call('POST', '/api/demo', undefined, started.token!)
  assert.equal(again.body.token, null)
  assert.equal(again.body.demo.workspaceId, started.demo.workspaceId)

  // someone else's account has no demo
  const real = (await db.insert(users).values({ email: `real+${Date.now()}@example.com`, name: 'Real', passwordHash: 'x', emailVerifiedAt: new Date(), termsAcceptedAt: new Date() }).returning())[0]!
  const t = newToken()
  await db.insert(sessions).values({ id: hashToken(t), userId: real.id, remember: false, expiresAt: new Date(Date.now() + 60_000) })
  assert.equal((await call('GET', '/api/auth/session', undefined, t)).body.session.demo, null)
})

test('demos last until 3 a.m. Manila time, at least 12 hours', () => {
  // 2 p.m. Manila → 3 a.m. the next day (13 hours)
  assert.equal(demoExpiry(new Date('2026-11-16T06:00:00Z')).toISOString(), '2026-11-16T19:00:00.000Z')
  // 9 p.m. Manila → 3 a.m. the day after next (30 hours), not 6 hours later
  assert.equal(demoExpiry(new Date('2026-11-16T13:00:00Z')).toISOString(), '2026-11-17T19:00:00.000Z')
})

test('the nightly job wipes expired demos, posted records and all', async () => {
  // claim one more (built on the spot: there are no spares in tests), then let both expire
  const second = await claimDemo(app)
  await db.update(demoAccounts).set({ claimedAt: new Date(), expiresAt: new Date(Date.now() - 1000) }).where(eq(demoAccounts.workspaceId, built.workspaceId))
  await db.update(demoAccounts).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(demoAccounts.workspaceId, second.workspaceId))
  await tendDemos(app)
  for (const id of [built.workspaceId, second.workspaceId]) {
    assert.equal((await db.select({ n: count() }).from(workspaces).where(eq(workspaces.id, id)))[0]!.n, 0)
    assert.equal((await db.select({ n: count() }).from(journalEntries).where(eq(journalEntries.workspaceId, id)))[0]!.n, 0)
  }
  assert.equal((await db.select({ n: count() }).from(users).where(eq(users.id, built.userId)))[0]!.n, 0)
  // staff accounts went with their demos
  const left = await db.execute<{ n: number }>(sql`select count(*)::int as n from users u where u.email like '%@demo.example.com' and not exists (select 1 from memberships m where m.user_id = u.id)`)
  assert.equal(left.rows[0]!.n, 0)
  // purging nothing is fine
  assert.equal(await purgeDemos([]), 0)
})
