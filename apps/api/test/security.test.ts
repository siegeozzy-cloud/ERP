import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Unit, Warehouse } from '@erp/shared'
import { buildApp } from '../src/app.ts'
import { db, pool, runMigrations } from '../src/db/client.ts'
import { sessions, users } from '../src/db/schema.ts'
import { hashToken, newToken } from '../src/lib/crypto.ts'

// Phase 9 security review: no route reaches another workspace's records, whether the id is in the
// address or in the body. Workspace B holds the records; Alice, owner of workspace A, tries to use
// them through A. Every attempt must fail, and B must be unchanged.

const app = await buildApp()
const run = Date.now()

async function person(name: string) {
  const [u] = await db.insert(users).values({ email: `sec+${name}+${run}@example.com`, name, passwordHash: 'x', emailVerifiedAt: new Date(), termsAcceptedAt: new Date() }).returning()
  const token = newToken()
  await db.insert(sessions).values({ id: hashToken(token), userId: u!.id, remember: false, expiresAt: new Date(Date.now() + 3_600_000) })
  return async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = {}) => {
    const r = await app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}`, ...headers } })
    return { status: r.statusCode, body: r.body ? r.json() : undefined, headers: r.headers }
  }
}

let alice: Awaited<ReturnType<typeof person>>
let bob: Awaited<ReturnType<typeof person>>
let A = ''
const B: Record<string, string> = {}
const a = (p: string) => `/api/w/${A}${p}`
const b = (p: string) => `/api/w/${B.ws}${p}`

before(async () => {
  await runMigrations()
  alice = await person('alice')
  bob = await person('bob')
  A = (await alice('POST', '/api/workspaces', { template: 'construction', name: 'A Corp', tin: '111-111-111-00000', vatStatus: 'vat', street: 'A' })).body.workspace.id
  B.ws = (await bob('POST', '/api/workspaces', { template: 'pharma', name: 'B Corp', tin: '222-222-222-00000', vatStatus: 'vat', street: 'B' })).body.workspace.id
  // the same records Alice will try to use: an item with a lot in quarantine, a customer and supplier,
  // a warehouse, a BOM, a work order, a price list, a project with a task and a milestone
  const units = (await bob('GET', b('/units'))).body.units as Unit[]
  B.warehouse = ((await bob('GET', b('/warehouses'))).body.warehouses as Warehouse[])[0]!.id
  B.customer = (await bob('POST', b('/contacts'), { name: 'B customer', isCustomer: true })).body.contact.id
  B.supplier = (await bob('POST', b('/contacts'), { name: 'B supplier', isSupplier: true })).body.contact.id
  B.item = (await bob('POST', b('/items'), { sku: 'B-ITEM', name: 'B item', unitId: units.find((u) => u.code === 'box')!.id, trackLots: true, trackExpiry: true, attributes: { fda_cpr: 'DR-1' } })).body.item.id
  B.made = (await bob('POST', b('/items'), { sku: 'B-MADE', name: 'B product', unitId: units.find((u) => u.code === 'box')!.id })).body.item.id
  const po = (await bob('POST', b('/purchase-orders'), { supplierId: B.supplier, date: '2026-11-01', warehouseId: B.warehouse, lines: [{ itemId: B.item, quantity: 5, unitCost: 100_00, vat: 'vatable' }] })).body.purchaseOrder
  const issued = (await bob('POST', b(`/purchase-orders/${po.id}/issue`))).body.purchaseOrder
  await bob('POST', b(`/purchase-orders/${po.id}/receive`), { date: '2026-11-02', warehouseId: B.warehouse, lines: [{ poLineId: issued.lines[0].id, quantity: 5, lotNo: 'B-LOT', expiryDate: '2028-01-31' }] })
  B.lot = (await bob('GET', b('/lots/quarantine'))).body.lots[0].lotId
  B.workCenter = (await bob('POST', b('/work-centers'), { code: 'BWC', name: 'B centre', costPerHour: 100_00 })).body.workCenter.id
  B.bom = (await bob('POST', b('/boms'), { itemId: B.made, outputQty: 1, lines: [{ itemId: B.item, quantity: 1 }] })).body.bom.id
  B.wo = (await bob('POST', b('/work-orders'), { itemId: B.made, quantity: 1, warehouseId: B.warehouse, startDate: '2026-11-03', dueDate: '2026-11-03' })).body.workOrder.id
  B.priceList = (await bob('POST', b('/price-lists'), { name: 'B prices', lines: [{ itemId: B.item, minQty: 0, price: 1 }] })).body.priceList.id
  const current = (await bob('GET', b(''))).body.workspace
  await bob('PATCH', b(''), { ...current, modules: [...current.modules, 'projects'] })
  const p = (await bob('POST', b('/projects'), { name: 'B project', customerId: B.customer, startDate: '2026-11-01', endDate: '2026-12-31', billing: 'fixed', contractValue: 1_000_00 })).body.project
  B.project = p.id
  B.task = (await bob('POST', b(`/projects/${p.id}/tasks`), { name: 'B task', startDate: '2026-11-01', endDate: '2026-11-02' })).body.project.tasks[0].id
  B.milestone = (await bob('POST', b(`/projects/${p.id}/milestones`), { name: 'B milestone', dueDate: '2026-12-31', amount: 1_000_00 })).body.project.milestones[0].id
})
after(async () => {
  await app.close()
  await pool.end()
})

test('B’s workspace answers Alice as if it didn’t exist', async () => {
  for (const path of ['', '/items', `/items/${B.item}`, '/boms', `/work-orders/${B.wo}`, `/projects/${B.project}`, '/price-lists', '/lots/quarantine', '/dashboard', '/mrp']) {
    const r = await alice('GET', b(path))
    assert.equal(r.status, 404, `GET ${path}: ${r.status}`)
  }
  assert.equal((await alice('POST', b(`/lots/${B.lot}/release`))).status, 404)
  assert.equal((await alice('POST', b('/import/items'), { rows: [{ sku: 'X', name: 'X', unit: 'pc' }] })).status, 404)
})

test('B’s ids used through A’s own workspace are refused', async () => {
  const units = (await alice('GET', a('/units'))).body.units as Unit[]
  const pc = units.find((u) => u.code === 'pc')!.id
  const aWarehouse = ((await alice('GET', a('/warehouses'))).body.warehouses as Warehouse[])[0]!.id
  const aItem = (await alice('POST', a('/items'), { sku: 'A-ITEM', name: 'A item', unitId: pc })).body.item.id
  const aCustomer = (await alice('POST', a('/contacts'), { name: 'A customer', isCustomer: true })).body.contact.id
  const aProject = (await alice('POST', a('/projects'), { name: 'A project', customerId: aCustomer, startDate: '2026-11-01', endDate: '2026-12-31', billing: 'hourly', hourlyRate: 1_000_00 })).body.project.id
  await alice('POST', a('/employees'), { firstName: 'Alice', lastName: 'A', position: 'Owner', hireDate: '2025-01-01', rate: 50_000_00, tracksAttendance: false })

  const attempts: [string, Promise<{ status: number }>][] = [
    // in the address, under A
    ['lot release', alice('POST', a(`/lots/${B.lot}/release`))],
    ['variants', alice('POST', a(`/items/${B.item}/variants`), { colours: ['x'], sizes: ['y'] })],
    ['work order', alice('GET', a(`/work-orders/${B.wo}`))],
    ['bom', alice('GET', a(`/boms/${B.bom}`))],
    ['project', alice('GET', a(`/projects/${B.project}`))],
    ['milestone invoice', alice('POST', a(`/projects/${aProject}/milestones/${B.milestone}/invoice`))],
    ['task progress', alice('POST', a(`/me/tasks/${B.task}/progress`), { status: 'done' })],
    ['price list', alice('GET', a(`/price-lists/${B.priceList}`))],
    // in the body
    ['bom with B component', alice('POST', a('/boms'), { itemId: aItem, outputQty: 1, lines: [{ itemId: B.item, quantity: 1 }] })],
    ['bom with B work centre', alice('POST', a('/boms'), { itemId: aItem, outputQty: 1, lines: [{ itemId: aItem, quantity: 1 }], operations: [{ workCenterId: B.workCenter, description: 'x', minutes: 1 }] })],
    ['work order for B product', alice('POST', a('/work-orders'), { itemId: B.made, quantity: 1, warehouseId: aWarehouse, startDate: '2026-11-03', dueDate: '2026-11-03' })],
    ['project for B customer', alice('POST', a('/projects'), { name: 'x', customerId: B.customer, startDate: '2026-11-01', endDate: '2026-11-02', billing: 'fixed' })],
    ['task on B milestone', alice('POST', a(`/projects/${aProject}/tasks`), { name: 'x', startDate: '2026-11-01', endDate: '2026-11-02', milestoneId: B.milestone })],
    ['task after B task', alice('POST', a(`/projects/${aProject}/tasks`), { name: 'x', startDate: '2026-11-01', endDate: '2026-11-02', dependsOnId: B.task })],
    ['time on B project', alice('POST', a('/timesheets'), { projectId: B.project, date: '2026-11-03', hours: 1 })],
    ['time on B task', alice('POST', a('/timesheets'), { projectId: aProject, taskId: B.task, date: '2026-11-03', hours: 1 })],
    ['materials of B item', alice('POST', a(`/projects/${aProject}/materials`), { date: '2026-11-03', warehouseId: aWarehouse, lines: [{ itemId: B.item, quantity: 1 }] })],
    ['materials from B warehouse', alice('POST', a(`/projects/${aProject}/materials`), { date: '2026-11-03', warehouseId: B.warehouse, lines: [{ itemId: aItem, quantity: 1 }] })],
    ['invoice tagged to B project', alice('POST', a('/invoices'), { customerId: aCustomer, projectId: B.project, date: '2026-11-03', lines: [{ description: 'x', quantity: 1, unitPrice: 1, vat: 'vatable', accountId: (await alice('GET', a('/accounts'))).body.accounts.find((x: { systemKey: string }) => x.systemKey === 'sales').id }] })],
    ['customer on B price list', alice('POST', a('/crm/customers'), { name: 'x', priceListId: B.priceList })],
    ['price list of B item', alice('POST', a('/price-lists'), { name: 'x', lines: [{ itemId: B.item, minQty: 0, price: 1 }] })],
    ['price of B item', alice('GET', a(`/sales/price?itemId=${B.item}`))],
    ['MRP buy from B supplier', alice('POST', a('/mrp/purchase-orders'), { warehouseId: aWarehouse, lines: [{ itemId: aItem, supplierId: B.supplier, quantity: 1, unitCost: 1 }] })],
  ]
  for (const [what, p] of attempts) {
    const r = await p
    assert.ok(r.status >= 400 && r.status < 500, `${what}: answered ${r.status}`)
  }
  // an import naming B's item is a row error, and nothing is saved
  const imp = await alice('POST', a('/import/opening-stock'), { rows: [{ sku: 'B-ITEM', quantity: '1', unitCost: '1' }] })
  assert.equal(imp.body.result.saved, false)
  assert.match(imp.body.result.errors[0].message, /No item with SKU B-ITEM/)

  // and B is as it was
  assert.equal((await bob('GET', b('/lots/quarantine'))).body.lots.length, 1)
  assert.equal((await bob('GET', b(`/projects/${B.project}`))).body.project.tasks[0].status, 'todo')
  assert.equal((await bob('GET', b(`/projects/${B.project}`))).body.project.milestones[0].status, 'open')
})

test('the API refuses changes from other sites, and sends its security headers', async () => {
  const r = await alice('POST', a('/import/items'), { rows: [{ sku: 'X', name: 'X', unit: 'pc' }] }, { origin: 'https://evil.example' })
  assert.equal(r.status, 403)
  assert.equal(r.body.error.code, 'bad-origin')
  assert.equal((await app.inject({ method: 'POST', url: '/api/demo', headers: { origin: 'https://evil.example' } })).statusCode, 403)
  const ping = await app.inject({ url: '/api/ping' })
  assert.match(String(ping.headers['content-security-policy']), /default-src 'none'/)
  assert.equal(ping.headers['x-frame-options'], 'DENY')
  // a spreadsheet can be big, but not unbounded
  const huge = await alice('POST', a('/import/items'), { rows: Array.from({ length: 5001 }, () => ({ sku: 'X' })) })
  assert.equal(huge.status, 400)
})

test('Excel import: checked first, then all rows or none', async () => {
  const rows = [
    { sku: 'IMP-1', name: 'Cement, 40 kg', unit: 'bag', salesPrice: '265.00', purchaseCost: '230', reorderPoint: '50' },
    { sku: 'IMP-2', name: 'Rebar 10 mm', unit: 'length', salesPrice: '180' },
  ]
  const bad = await alice('POST', a('/import/items'), { rows })
  assert.equal(bad.body.result.saved, false)
  assert.deepEqual(bad.body.result.errors.map((e: { row: number }) => e.row), [3]) // "length" isn't a Construction unit
  assert.equal((await alice('GET', a('/items'))).body.items.some((i: { sku: string }) => i.sku === 'IMP-1'), false)

  rows[1]!.unit = 'pc'
  const dry = await alice('POST', a('/import/items'), { rows, dryRun: true })
  assert.deepEqual([dry.body.result.created, dry.body.result.saved, dry.body.result.errors.length], [2, false, 0])
  assert.equal((await alice('GET', a('/items'))).body.items.some((i: { sku: string }) => i.sku === 'IMP-1'), false)

  const done = await alice('POST', a('/import/items'), { rows })
  assert.deepEqual([done.body.result.created, done.body.result.saved], [2, true])
  // the same SKUs again update rather than duplicate
  rows[0]!.salesPrice = '270.00'
  assert.equal((await alice('POST', a('/import/items'), { rows })).body.result.updated, 2)
  const cement = ((await alice('GET', a('/items'))).body.items as { sku: string; salesPrice: number }[]).find((i) => i.sku === 'IMP-1')!
  assert.equal(cement.salesPrice, 270_00)

  const stock = await alice('POST', a('/import/opening-stock'), { rows: [{ sku: 'IMP-1', quantity: '200', unitCost: '230' }], date: '2026-11-01' })
  assert.equal(stock.body.result.saved, true, JSON.stringify(stock.body))
  const tb = (await alice('GET', a('/reports/trial-balance?asOf=2030-12-31'))).body.report
  assert.equal(tb.totalDebit, tb.totalCredit)

  const contacts = await alice('POST', a('/import/contacts'), { rows: [{ name: 'Hardware Depot', type: 'supplier', tin: '123-456-789-00000' }, { name: 'Santos Family', type: 'customer', paymentTermsDays: '15' }] })
  assert.deepEqual([contacts.body.result.created, contacts.body.result.saved], [2, true])

  // the dashboard counts what's waiting and draws the money
  const dash = (await alice('GET', a('/dashboard'))).body.dashboard
  assert.ok(dash.money.months.length >= 2 && dash.money.months.length <= 6) // from the first month with activity
  assert.equal(dash.money.aging.length, 5)
})
