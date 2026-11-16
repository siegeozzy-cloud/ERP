import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Account, Bill, Invoice, ItemDetail, PurchaseOrder, Role, Unit, Warehouse } from '@erp/shared'
import { sql } from 'drizzle-orm'
import { buildApp } from '../src/app.ts'
import { db, pool, runMigrations } from '../src/db/client.ts'
import { sessions, users } from '../src/db/schema.ts'
import { hashToken, newToken } from '../src/lib/crypto.ts'
import { testPushOutbox } from '../src/lib/push.ts'

// Phase 3: items, stock, purchase orders → receipts → bills, and invoices taking stock out.
// The test that matters most: the stock valuation always equals the Inventory account.

const app = await buildApp()
const run = Date.now()

async function makeUser(name: string) {
  const [user] = await db
    .insert(users)
    .values({ email: `inv+${name.toLowerCase()}+${run}@example.com`, name, passwordHash: 'x', emailVerifiedAt: new Date(), termsAcceptedAt: new Date() })
    .returning()
  const token = newToken()
  await db.insert(sessions).values({ id: hashToken(token), userId: user!.id, remember: false, expiresAt: new Date(Date.now() + 3_600_000) })
  return {
    id: user!.id,
    call: async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) => {
      const r = await app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } })
      return { status: r.statusCode, body: r.body ? r.json() : undefined }
    },
  }
}

let owner: Awaited<ReturnType<typeof makeUser>>
let ws = ''
const w = (p: string) => `/api/w/${ws}${p}`
const call = (...a: Parameters<typeof owner.call>) => owner.call(...a)
const acct: Record<string, string> = {}
let sack = ''
let main = ''
let annex = ''
let rice = ''
let supplier = ''
let customer = ''

/** Debit-positive balance of a system account, from the trial balance. */
async function balanceOf(key: string) {
  const tb = (await call('GET', w('/reports/trial-balance?asOf=2026-12-31'))).body.report
  return tb.rows.find((r: { id: string }) => r.id === acct[key])?.balance ?? 0
}
const valuation = async () => (await call('GET', w('/inventory/valuation?asOf=2026-12-31'))).body.total as number
const item = async () => (await call('GET', w(`/items/${rice}`))).body.item as ItemDetail

before(async () => {
  await runMigrations()
  owner = await makeUser('Rosa')
  const r = await call('POST', '/api/workspaces', { template: 'food', name: 'Bigasan ni Rosa', tin: '777-888-999-00000', vatStatus: 'vat', street: 'Nueva Ecija' })
  ws = r.body.workspace.id
  for (const a of (await call('GET', w('/accounts'))).body.accounts as Account[]) if (a.systemKey) acct[a.systemKey] = a.id
  sack = ((await call('GET', w('/units'))).body.units as Unit[]).find((u) => u.code === 'sack')!.id
  main = ((await call('GET', w('/warehouses'))).body.warehouses as Warehouse[])[0]!.id
  annex = (await call('POST', w('/warehouses'), { code: 'annex', name: 'Annex' })).body.warehouse.id
  supplier = (await call('POST', w('/contacts'), { name: 'Palay Farmers Coop', isSupplier: true })).body.contact.id
  customer = (await call('POST', w('/contacts'), { name: 'Karinderya ni Aling Bebang', isCustomer: true })).body.contact.id
})
after(async () => {
  await app.close()
  await pool.end()
})

test('items: lot and expiry tracking, unique SKUs and barcodes, found by barcode', async () => {
  const bad = await call('POST', w('/items'), { sku: 'X', name: 'X', unitId: sack, trackExpiry: true })
  assert.equal(bad.body.error.field, 'trackExpiry')
  const r = await call('POST', w('/items'), {
    sku: 'rice-25kg',
    name: 'Dinorado rice, 25 kg',
    barcode: '4800000000017',
    unitId: sack,
    salesPrice: 1_500_00,
    purchaseCost: 1_100_00,
    trackLots: true,
    trackExpiry: true,
    reorderPoint: 20,
    reorderQty: 100,
  })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  rice = r.body.item.id
  assert.equal(r.body.item.sku, 'RICE-25KG')
  assert.equal((await call('POST', w('/items'), { sku: 'RICE-25KG', name: 'Copy', unitId: sack })).body.error.field, 'sku')
  assert.equal((await call('POST', w('/items'), { sku: 'OTHER', name: 'Other', unitId: sack, barcode: '4800000000017' })).body.error.field, 'barcode')
  const scanned = await call('GET', w('/items/barcode/4800000000017'))
  assert.equal(scanned.body.item.id, rice)
  assert.equal((await call('GET', w('/items/barcode/0000'))).status, 404)
})

test('opening stock: on the shelf and on the books, against opening balance equity', async () => {
  const noLot = await call('POST', w('/stock/adjustments'), { date: '2026-10-01', warehouseId: main, reason: 'opening', lines: [{ itemId: rice, change: 10, unitCost: 1_000_00 }] })
  assert.match(noLot.body.error.message, /lot number/)
  const r = await call('POST', w('/stock/adjustments'), {
    date: '2026-10-01',
    warehouseId: main,
    reason: 'opening',
    lines: [{ itemId: rice, change: 10, unitCost: 1_000_00, lotNo: 'OLD-01', expiryDate: '2027-01-31' }],
  })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(r.body.document.number, 'ADJ-000001')
  assert.equal(r.body.document.value, 10_000_00)
  assert.equal(await balanceOf('inventory'), 10_000_00)
  assert.equal(await balanceOf('opening_equity'), -10_000_00)
  assert.equal(await valuation(), 10_000_00)
})

let po: PurchaseOrder

test('a purchase order is issued, received in two lots, and can’t be over-received', async () => {
  const draft = await call('POST', w('/purchase-orders'), {
    supplierId: supplier,
    date: '2026-10-05',
    warehouseId: main,
    lines: [{ itemId: rice, quantity: 50, unitCost: 1_200_00, vat: 'vatable' }],
  })
  assert.equal(draft.status, 201, JSON.stringify(draft.body))
  assert.equal(draft.body.purchaseOrder.total, 67_200_00) // 50 × 1,200 + 12% VAT
  const early = await call('POST', w(`/purchase-orders/${draft.body.purchaseOrder.id}/receive`), { date: '2026-10-06', warehouseId: main, lines: [] })
  assert.equal(early.status, 400)

  po = (await call('POST', w(`/purchase-orders/${draft.body.purchaseOrder.id}/issue`))).body.purchaseOrder
  assert.equal(po.number, 'PO-000001')
  const line = po.lines[0]!.id

  const r1 = await call('POST', w(`/purchase-orders/${po.id}/receive`), { date: '2026-10-08', warehouseId: main, lines: [{ poLineId: line, quantity: 30, lotNo: 'NEW-A', expiryDate: '2027-06-30' }] })
  assert.equal(r1.status, 201, JSON.stringify(r1.body))
  assert.equal(r1.body.receipt.number, 'GR-000001')
  assert.equal(r1.body.purchaseOrder.status, 'partly_received')
  const over = await call('POST', w(`/purchase-orders/${po.id}/receive`), { date: '2026-10-09', warehouseId: main, lines: [{ poLineId: line, quantity: 21, lotNo: 'NEW-B', expiryDate: '2027-07-31' }] })
  assert.match(over.body.error.message, /only 20/)
  const r2 = await call('POST', w(`/purchase-orders/${po.id}/receive`), { date: '2026-10-09', warehouseId: annex, lines: [{ poLineId: line, quantity: 20, lotNo: 'NEW-B', expiryDate: '2027-07-31' }] })
  po = r2.body.purchaseOrder
  assert.equal(po.status, 'received')

  // stock at cost before VAT; the debt isn't on the books yet, it's waiting in GRNI
  assert.equal(await balanceOf('inventory'), 10_000_00 + 50 * 1_200_00)
  assert.equal(await balanceOf('grni'), -60_000_00)
  const it = await item()
  assert.equal(it.onHand, 60)
  assert.equal(it.averageCost, 70_000_00 / 60)
  assert.deepEqual(it.levels.map((l) => `${l.lot?.lotNo}:${l.quantity}`).sort(), ['NEW-A:30', 'NEW-B:20', 'OLD-01:10'])
})

let bill: Bill

test('billing the order clears GRNI; a different price on the bill is purchase price variance', async () => {
  const noPo = await call('POST', w('/bills'), { supplierId: supplier, date: '2026-10-10', lines: [{ description: 'Rice', quantity: 1, unitPrice: 100, vat: 'vatable', accountId: acct.purchases, itemId: rice }] })
  assert.match(noPo.body.error.message, /purchase order/)

  const made = await call('POST', w(`/purchase-orders/${po.id}/bill`))
  assert.equal(made.status, 201, JSON.stringify(made.body))
  assert.equal((await call('POST', w(`/purchase-orders/${po.id}/bill`))).body.error.code, 'nothing-to-bill')
  bill = (await call('GET', w(`/bills/${made.body.billId}`))).body.bill
  assert.equal(bill.lines[0]!.quantity, 50)

  // the supplier charged ₱1,210 a sack, not ₱1,200
  const edited = await call('PUT', w(`/bills/${bill.id}`), {
    supplierId: supplier,
    supplierInvoiceNo: 'COOP-5521',
    date: '2026-10-12',
    lines: bill.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: 1_210_00, vat: l.vat, accountId: l.accountId, itemId: l.itemId, poLineId: l.poLineId })),
  })
  assert.equal(edited.status, 200, JSON.stringify(edited.body))
  const posted = await call('POST', w(`/bills/${bill.id}/post`))
  assert.equal(posted.status, 200, JSON.stringify(posted.body))
  bill = posted.body.bill

  assert.equal(await balanceOf('grni'), 0)
  assert.equal(await balanceOf('price_variance'), 50 * 10_00)
  assert.equal(await balanceOf('ap'), -(60_500_00 + 7_260_00)) // 50 × ₱1,210 plus 12% VAT
  const after = (await call('GET', w(`/purchase-orders/${po.id}`))).body.purchaseOrder as PurchaseOrder
  assert.equal(after.status, 'closed')
  assert.equal(after.lines[0]!.billedQty, 50)
})

let invoice: Invoice

test('a sale takes stock out, earliest expiry first, at average cost', async () => {
  const noWarehouse = await call('POST', w('/invoices'), { customerId: customer, date: '2026-10-15', lines: [{ description: 'Rice', quantity: 1, unitPrice: 1_500_00, vat: 'vatable', accountId: acct.sales, itemId: rice }] })
  assert.equal(noWarehouse.body.error.field, 'warehouseId')

  const tooMuch = await call('POST', w('/invoices'), { customerId: customer, warehouseId: main, date: '2026-10-15', lines: [{ description: 'Rice', quantity: 41, unitPrice: 1_500_00, vat: 'vatable', accountId: acct.sales, itemId: rice }] })
  const refused = await call('POST', w(`/invoices/${tooMuch.body.invoice.id}/post`))
  assert.equal(refused.body.error.code, 'not-enough-stock')
  assert.match(refused.body.error.message, /only 40 sack/)
  await call('DELETE', w(`/invoices/${tooMuch.body.invoice.id}`))

  const before = await valuation()
  const draft = await call('POST', w('/invoices'), { customerId: customer, warehouseId: main, date: '2026-10-15', lines: [{ description: 'Dinorado rice, 25 kg', quantity: 15, unitPrice: 1_500_00, vat: 'vatable', accountId: acct.sales, itemId: rice }] })
  invoice = (await call('POST', w(`/invoices/${draft.body.invoice.id}/post`))).body.invoice
  assert.equal(invoice.status, 'posted')

  const it = await item()
  // the 10 old sacks (expiring January) went first, then 5 of NEW-A
  assert.deepEqual(it.levels.map((l) => `${l.lot?.lotNo}:${l.quantity}`).sort(), ['NEW-A:25', 'NEW-B:20'])
  const cost = before - (await valuation())
  assert.equal(cost, Math.round(15 * (70_000_00 / 60)))
  assert.equal(await balanceOf('cogs'), cost)
  assert.equal(await valuation(), await balanceOf('inventory'))
})

test('voiding the sale puts the stock back, lot by lot', async () => {
  await call('POST', w(`/invoices/${invoice.id}/void`), { date: '2026-10-16' })
  const it = await item()
  assert.deepEqual(it.levels.map((l) => `${l.lot?.lotNo}:${l.quantity}`).sort(), ['NEW-A:30', 'NEW-B:20', 'OLD-01:10'])
  assert.equal(await balanceOf('cogs'), 0)
  assert.equal(await valuation(), await balanceOf('inventory'))
})

test('a transfer moves stock between warehouses without changing its value', async () => {
  const value = await valuation()
  const r = await call('POST', w('/stock/transfers'), { date: '2026-10-20', fromWarehouseId: main, toWarehouseId: annex, lines: [{ itemId: rice, quantity: 12, lotNo: 'NEW-A' }] })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(r.body.document.number, 'TR-000001')
  const it = await item()
  const at = (code: string, lot: string) => it.levels.find((l) => l.warehouse.code === code && l.lot?.lotNo === lot)?.quantity
  assert.equal(at('MAIN', 'NEW-A'), 18)
  assert.equal(at('ANNEX', 'NEW-A'), 12)
  assert.equal(await valuation(), value)
  assert.equal((await call('POST', w('/stock/transfers'), { date: '2026-10-20', fromWarehouseId: main, toWarehouseId: main, lines: [{ itemId: rice, quantity: 1 }] })).body.error.field, 'toWarehouseId')
})

test('a count finds 2 sacks missing, and dropping below the reorder point tells the stock people', async () => {
  // 60 on hand, reorder at 20: write off down to 21 first, quietly
  await call('POST', w('/stock/adjustments'), { date: '2026-10-25', warehouseId: annex, reason: 'damage', lines: [{ itemId: rice, change: -32 }] })
  assert.equal((await item()).onHand, 28)
  const pushes = testPushOutbox.length
  const count = await call('POST', w('/stock/adjustments'), { date: '2026-10-26', warehouseId: main, reason: 'count', lines: [{ itemId: rice, counted: 8, lotNo: 'NEW-A' }] })
  assert.equal(count.status, 201, JSON.stringify(count.body))
  assert.equal(count.body.document.lines[0].quantity, -10)
  assert.equal((await item()).onHand, 18)
  assert.equal(testPushOutbox.length, pushes + 1)
  assert.match(testPushOutbox.at(-1)!.body, /Dinorado rice, 25 kg is down to 18 sack \(reorder at 20\)/)
  assert.deepEqual(testPushOutbox.at(-1)!.userIds, [owner.id])

  const overview = (await call('GET', w('/inventory/overview'))).body.overview
  assert.equal(overview.low[0].sku, 'RICE-25KG')
  assert.ok(overview.expiring.length === 0 || overview.expiring.every((e: { expiryDate: string }) => e.expiryDate >= '2026'))
})

test('the stock valuation equals the Inventory account, and stock moves can’t be altered', async () => {
  assert.equal(await valuation(), await balanceOf('inventory'))
  const tb = (await call('GET', w('/reports/trial-balance?asOf=2026-12-31'))).body.report
  assert.equal(tb.totalDebit, tb.totalCredit)
  const refused = (e: unknown) => /Stock movements can.t be changed/.test(String((e as { cause?: Error }).cause?.message))
  await assert.rejects(db.execute(sql`update stock_moves set quantity = 1000 where item_id = ${rice}`), refused)
  await assert.rejects(db.execute(sql`delete from stock_moves where item_id = ${rice}`), refused)
})

test('warehouse staff can count and receive, not sell; and a workspace without Inventory has none', async () => {
  const staffRole = ((await call('GET', w('/roles'))).body.roles as Role[]).find((r) => r.name === 'Warehouse staff')!
  const code = (await call('POST', w('/join-codes'), { roleId: staffRole.id })).body.code.code
  const staff = await makeUser('Tonyo')
  assert.equal((await staff.call('POST', '/api/workspaces/join', { code })).status, 200)
  assert.equal((await staff.call('POST', w('/stock/adjustments'), { date: '2026-10-27', warehouseId: main, reason: 'count', lines: [{ itemId: rice, counted: 8, lotNo: 'NEW-A' }] })).status, 201)
  assert.equal((await staff.call('GET', w('/invoices'))).status, 403)
  assert.equal((await staff.call('POST', w('/purchase-orders'), { supplierId: supplier, date: '2026-10-27', warehouseId: main, lines: [{ itemId: rice, quantity: 1, unitCost: 1, vat: 'vatable' }] })).status, 403)

  const current = (await call('GET', w(''))).body.workspace
  await call('PATCH', w(''), { ...current, modules: ['finance'] })
  const off = await call('GET', w('/items'))
  assert.equal(off.status, 403)
  assert.equal(off.body.error.code, 'module-off')
  await call('PATCH', w(''), { ...current, modules: current.modules })
  assert.equal((await call('GET', w('/items'))).status, 200)
})

test('voiding the bill reopens a purchase order that closed by itself, so it can be billed again', async () => {
  assert.equal((await call('GET', w(`/purchase-orders/${po.id}`))).body.purchaseOrder.status, 'closed')
  const voided = await call('POST', w(`/bills/${bill.id}/void`), { date: '2026-10-28' })
  assert.equal(voided.status, 200, JSON.stringify(voided.body))
  assert.equal((await call('GET', w(`/purchase-orders/${po.id}`))).body.purchaseOrder.status, 'received')
  assert.equal((await call('POST', w(`/purchase-orders/${po.id}/bill`))).status, 201)
})
