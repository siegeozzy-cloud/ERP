import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Account, ItemDetail, Project, QuarantineLot, SalesOrder, Unit, Warehouse } from '@erp/shared'
import { buildApp } from '../src/app.ts'
import { db, pool, runMigrations } from '../src/db/client.ts'
import { sessions, users } from '../src/db/schema.ts'
import { hashToken, newToken } from '../src/lib/crypto.ts'

// Phase 8: the niche packs. Each test makes a workspace from its template and checks the rules
// the template switches on: Pharma's quarantine and FDA registration, licences on the business,
// Apparel's variants, Wholesale's price lists, Construction's retention, and make-to-order.

const app = await buildApp()
const run = Date.now()

const [user] = await db.insert(users).values({ email: `niche+${run}@example.com`, name: 'Niche Owner', passwordHash: 'x', emailVerifiedAt: new Date(), termsAcceptedAt: new Date() }).returning()
const token = newToken()
await db.insert(sessions).values({ id: hashToken(token), userId: user!.id, remember: false, expiresAt: new Date(Date.now() + 3_600_000) })

const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) => {
  const r = await app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } })
  return { status: r.statusCode, body: r.body ? r.json() : undefined }
}

/** A workspace from a template, with what tests need: accounts, units, the main warehouse, a customer and a supplier. */
async function workspaceFor(template: string) {
  const r = await call('POST', '/api/workspaces', { template, name: `${template} test ${run}`, tin: '246-135-790-00000', vatStatus: 'vat', street: 'Makati' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const ws = r.body.workspace.id as string
  const w = (p: string) => `/api/w/${ws}${p}`
  const acct: Record<string, string> = {}
  for (const a of (await call('GET', w('/accounts'))).body.accounts as Account[]) if (a.systemKey) acct[a.systemKey] = a.id
  const units = (await call('GET', w('/units'))).body.units as Unit[]
  const unit = (code: string) => units.find((u) => u.code === code)!.id
  const main = ((await call('GET', w('/warehouses'))).body.warehouses as Warehouse[])[0]!.id
  const customer = (await call('POST', w('/contacts'), { name: 'A customer', isCustomer: true, paymentTermsDays: 30 })).body.contact.id as string
  const supplier = (await call('POST', w('/contacts'), { name: 'A supplier', isSupplier: true })).body.contact.id as string
  return { ws, w, acct, unit, main, customer, supplier }
}

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())

before(async () => {
  await runMigrations()
})
after(async () => {
  await app.close()
  await pool.end()
})

test('Pharma: no sale without the FDA registration; lots wait in quarantine until QC releases (or rejects) them', async () => {
  const t = await workspaceFor('pharma')
  const { w } = t
  // the item form's fields are checked against the template's
  const badOption = await call('POST', w('/items'), { sku: 'X', name: 'X', unitId: t.unit('box'), attributes: { dosage_form: 'Lozenge' } })
  assert.equal(badOption.body.error.field, 'attributes.dosage_form')
  const unknown = await call('POST', w('/items'), { sku: 'X', name: 'X', unitId: t.unit('box'), attributes: { hazard_class: 'Class 3: Flammable liquid' } })
  assert.equal(unknown.status, 400)

  const amox = (await call('POST', w('/items'), { sku: 'AMOX-500', name: 'Amoxicillin 500 mg, box of 100', unitId: t.unit('box'), salesPrice: 950_00, trackLots: true, trackExpiry: true, attributes: { generic_name: 'Amoxicillin', dosage_form: 'Capsule', strength: '500 mg', classification: 'Prescription (Rx)' } })).body.item as ItemDetail
  assert.equal(amox.attributes.generic_name, 'Amoxicillin')

  // a purchase order received: the lot is held
  const po = (await call('POST', w('/purchase-orders'), { supplierId: t.supplier, date: '2026-11-02', warehouseId: t.main, lines: [{ itemId: amox.id, quantity: 20, unitCost: 600_00, vat: 'vatable' }] })).body.purchaseOrder
  const issued = (await call('POST', w(`/purchase-orders/${po.id}/issue`))).body.purchaseOrder
  const got = await call('POST', w(`/purchase-orders/${po.id}/receive`), { date: '2026-11-03', warehouseId: t.main, lines: [{ poLineId: issued.lines[0].id, quantity: 20, lotNo: 'AX-2611', expiryDate: '2028-10-31' }] })
  assert.equal(got.status, 201, JSON.stringify(got.body))
  const held = (await call('GET', w('/lots/quarantine'))).body.lots as QuarantineLot[]
  assert.deepEqual(held.map((l) => [l.lotNo, l.quantity]), [['AX-2611', 20]])

  const sell = async (extra = {}) => {
    const inv = (await call('POST', w('/invoices'), { customerId: t.customer, warehouseId: t.main, date: '2026-11-05', lines: [{ description: 'Amoxicillin', quantity: 2, unitPrice: 950_00, vat: 'vatable', accountId: t.acct.sales, itemId: amox.id, ...extra }] })).body.invoice
    return call('POST', w(`/invoices/${inv.id}/post`))
  }
  // first: it has no FDA registration number
  const noCpr = await sell()
  assert.equal(noCpr.body.error.code, 'missing-for-sale')
  assert.match(noCpr.body.error.message, /FDA product registration \(CPR\) number/)
  await call('PUT', w(`/items/${amox.id}`), { sku: amox.sku, name: amox.name, unitId: t.unit('box'), salesPrice: 950_00, trackLots: true, trackExpiry: true, attributes: { ...amox.attributes, fda_cpr: 'DR-XY12345' } })
  // then: everything on hand is still in quarantine
  const quarantined = await sell()
  assert.equal(quarantined.body.error.code, 'not-enough-stock')
  assert.match(quarantined.body.error.message, /waiting for quality control/)

  assert.equal((await call('POST', w(`/lots/${held[0]!.lotId}/release`), { note: 'COA checked, assay 99.2%' })).status, 200)
  const sold = await sell()
  assert.equal(sold.status, 200, JSON.stringify(sold.body))
  assert.equal((await call('POST', w(`/lots/${held[0]!.lotId}/release`))).body.error.code, 'decided')

  // a second lot fails QC: written off to Rejected and Expired Stock
  const po2 = (await call('POST', w('/purchase-orders'), { supplierId: t.supplier, date: '2026-11-06', warehouseId: t.main, lines: [{ itemId: amox.id, quantity: 10, unitCost: 600_00, vat: 'vatable' }] })).body.purchaseOrder
  const issued2 = (await call('POST', w(`/purchase-orders/${po2.id}/issue`))).body.purchaseOrder
  await call('POST', w(`/purchase-orders/${po2.id}/receive`), { date: '2026-11-07', warehouseId: t.main, lines: [{ poLineId: issued2.lines[0].id, quantity: 10, lotNo: 'AX-2612', expiryDate: '2028-11-30' }] })
  const lot2 = ((await call('GET', w('/lots/quarantine'))).body.lots as QuarantineLot[])[0]!
  assert.equal((await call('POST', w(`/lots/${lot2.lotId}/reject`), { date: '2026-11-08' })).body.error.field, 'note')
  assert.equal((await call('POST', w(`/lots/${lot2.lotId}/reject`), { date: '2026-11-08', note: 'Dissolution test failed' })).status, 200)
  const tb = (await call('GET', w('/reports/trial-balance?asOf=2030-12-31'))).body.report
  assert.equal(tb.rows.find((r: { id: string }) => r.id === t.acct.spoilage).balance, 10 * 600_00)
  assert.equal(((await call('GET', w(`/items/${amox.id}`))).body.item as ItemDetail).onHand, 18)
})

test('licences on the business: FDA LTO with its expiry; only the template’s, and dates checked', async () => {
  const t = await workspaceFor('pharma')
  const current = (await call('GET', t.w(''))).body.workspace
  const bad = await call('PATCH', t.w(''), { ...current, licences: { fda_lto: 'LTO-3000001234567', fda_lto_expires: 'next year' } })
  assert.equal(bad.body.error.field, 'licences')
  assert.equal((await call('PATCH', t.w(''), { ...current, licences: { pcab_licence: '12345' } })).status, 400)
  const ok = await call('PATCH', t.w(''), { ...current, licences: { fda_lto: 'LTO-3000001234567', fda_lto_expires: '2027-03-31' } })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(ok.body.workspace.licences.fda_lto_expires, '2027-03-31')
  // saving the workspace without licences leaves them as they were
  const { licences: _ignored, ...withoutLicences } = current
  assert.equal((await call('PATCH', t.w(''), withoutLicences)).body.workspace.licences.fda_lto, 'LTO-3000001234567')
})

test('Apparel: a style’s size × colour variants, made once each', async () => {
  const t = await workspaceFor('apparel')
  const style = (await call('POST', t.w('/items'), { sku: 'POLO-01', name: 'Piqué polo', unitId: t.unit('pc'), salesPrice: 799_00, purchaseCost: 320_00, attributes: { season: 'Holiday 2026' } })).body.item as ItemDetail
  const r = await call('POST', t.w(`/items/${style.id}/variants`), { colours: ['Navy', 'White'], sizes: ['S', 'M', 'L'] })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(r.body.made, 6)
  const detail = r.body.item as ItemDetail
  assert.deepEqual(detail.variants.map((v) => v.sku).sort(), ['POLO-01-NAVY-L', 'POLO-01-NAVY-M', 'POLO-01-NAVY-S', 'POLO-01-WHITE-L', 'POLO-01-WHITE-M', 'POLO-01-WHITE-S'])
  const navyM = (await call('GET', t.w(`/items/${detail.variants.find((v) => v.sku === 'POLO-01-NAVY-M')!.id}`))).body.item as ItemDetail
  assert.deepEqual([navyM.attributes.colour, navyM.attributes.size, navyM.attributes.season, navyM.salesPrice, navyM.parent?.id], ['Navy', 'M', 'Holiday 2026', 799_00, style.id])
  // adding a size makes only what's missing
  assert.equal((await call('POST', t.w(`/items/${style.id}/variants`), { colours: ['Navy', 'White'], sizes: ['M', 'XL'] })).body.made, 2)
  assert.equal((await call('POST', t.w(`/items/${navyM.id}/variants`), { colours: ['Red'], sizes: ['S'] })).body.error.code, 'is-variant')
  // other templates don't have variants
  const food = await workspaceFor('food')
  const rice = (await call('POST', food.w('/items'), { sku: 'R', name: 'Rice', unitId: food.unit('sack') })).body.item
  assert.equal((await call('POST', food.w(`/items/${rice.id}/variants`), { colours: ['a'], sizes: ['b'] })).body.error.code, 'no-variants')
})

test('Wholesale: a price list with quantity breaks fills in the customer’s price', async () => {
  const t = await workspaceFor('wholesale')
  const soap = (await call('POST', t.w('/items'), { sku: 'SOAP-135', name: 'Bath soap 135 g', unitId: t.unit('pc'), salesPrice: 45_00, attributes: { brand: 'Linis', case_pack: '72' } })).body.item
  const list = await call('POST', t.w('/price-lists'), {
    name: 'Sari-sari dealers',
    lines: [
      { itemId: soap.id, minQty: 0, price: 40_00 },
      { itemId: soap.id, minQty: 72, price: 37_50 },
      { itemId: soap.id, minQty: 720, price: 35_00 },
    ],
  })
  assert.equal(list.status, 201, JSON.stringify(list.body))
  const dealer = (await call('POST', t.w('/crm/customers'), { name: 'Tindahan ni Aling Nena', priceListId: list.body.priceList.id })).body.customer.id
  const price = async (customerId: string | null, quantity: number) => (await call('GET', t.w(`/sales/price?itemId=${soap.id}&quantity=${quantity}${customerId ? `&customerId=${customerId}` : ''}`))).body.price
  assert.deepEqual(await price(dealer, 10), { price: 40_00, source: 'list', priceList: 'Sari-sari dealers' })
  assert.equal((await price(dealer, 72)).price, 37_50)
  assert.equal((await price(dealer, 1000)).price, 35_00)
  assert.deepEqual(await price(t.customer, 1000), { price: 45_00, source: 'item', priceList: null })
  assert.equal((await call('GET', t.w('/price-lists'))).body.priceLists[0].customerCount, 1)
  // a list from another workspace can't be given to a customer here
  const other = await workspaceFor('general')
  assert.equal((await call('POST', other.w('/crm/customers'), { name: 'X', priceListId: list.body.priceList.id })).body.error.field, 'priceListId')
})

test('Construction: milestones billed less 10% retention, released on one invoice at turnover', async () => {
  const t = await workspaceFor('construction')
  const p = (await call('POST', t.w('/projects'), { name: 'Two-storey residence, Antipolo', customerId: t.customer, status: 'active', startDate: '2026-11-02', endDate: '2027-05-31', billing: 'fixed', contractValue: 3_000_000_00 })).body.project as Project
  assert.equal(p.retentionBp, 1000) // the template's
  let project = p
  for (const [name, amount] of [['Foundation and columns', 1_200_000_00], ['Roofing and turnover', 1_800_000_00]] as const) {
    project = (await call('POST', t.w(`/projects/${p.id}/milestones`), { name, dueDate: '2027-01-31', amount })).body.project
  }
  const first = await call('POST', t.w(`/projects/${p.id}/milestones/${project.milestones[0]!.id}/invoice`))
  const inv = (await call('GET', t.w(`/invoices/${first.body.invoiceId}`))).body.invoice
  assert.equal(inv.lines[0].unitPrice, 1_080_000_00)
  assert.match(inv.lines[0].description, /less 10% retention of ₱120,000\.00/)
  assert.equal((await call('POST', t.w(`/projects/${p.id}/invoice-retention`))).body.error.code, 'not-yet')

  await call('POST', t.w(`/projects/${p.id}/milestones/${project.milestones[1]!.id}/invoice`))
  project = (await call('GET', t.w(`/projects/${p.id}`))).body.project
  assert.equal(project.retention.held, 300_000_00)
  const released = await call('POST', t.w(`/projects/${p.id}/invoice-retention`))
  assert.equal(released.status, 201, JSON.stringify(released.body))
  const rinv = (await call('GET', t.w(`/invoices/${released.body.invoiceId}`))).body.invoice
  assert.equal(rinv.lines[0].unitPrice, 300_000_00)
  assert.equal(rinv.lines[0].accountId, t.acct.contract_revenue)
  assert.equal((await call('POST', t.w(`/projects/${p.id}/invoice-retention`))).body.error.code, 'billed')
  // deleting the draft frees it to bill again
  await call('DELETE', t.w(`/invoices/${rinv.id}`))
  assert.equal(((await call('GET', t.w(`/projects/${p.id}`))).body.project as Project).retention.invoice, null)

  // the PCAB licence and category are the business's
  const current = (await call('GET', t.w(''))).body.workspace
  assert.equal((await call('PATCH', t.w(''), { ...current, licences: { pcab_licence: '41234', pcab_category: 'AAA', pcab_licence_expires: '2027-06-30' } })).status, 200)
  assert.equal((await call('PATCH', t.w(''), { ...current, licences: { pcab_category: 'Z' } })).status, 400)
})

test('Make to order: a work order for a sales order shows on it, with its cost against the order', async () => {
  const t = await workspaceFor('discrete')
  const steel = (await call('POST', t.w('/items'), { sku: 'SS-SHEET', name: 'SS304 sheet, 4×8, 2 mm', unitId: t.unit('sheet'), attributes: { material: 'SS304, 2 mm' } })).body.item
  const table = (await call('POST', t.w('/items'), { sku: 'TBL-PREP', name: 'Stainless prep table, 6 ft', unitId: t.unit('pc'), salesPrice: 28_000_00, attributes: { drawing_no: 'D-1042 rev B' } })).body.item
  await call('POST', t.w('/stock/adjustments'), { date: '2026-11-01', warehouseId: t.main, reason: 'opening', lines: [{ itemId: steel.id, change: 10, unitCost: 6_500_00 }] })
  await call('POST', t.w('/boms'), { itemId: table.id, outputQty: 1, lines: [{ itemId: steel.id, quantity: 2 }] })
  const so = (await call('POST', t.w('/sales-orders'), { customerId: t.customer, date: today, warehouseId: t.main, lines: [{ itemId: table.id, quantity: 3, unitPrice: 28_000_00, vat: 'vatable' }] })).body.salesOrder as SalesOrder
  await call('POST', t.w(`/sales-orders/${so.id}/confirm`))
  const wo = (await call('POST', t.w('/work-orders'), { itemId: table.id, quantity: 3, warehouseId: t.main, startDate: today, dueDate: today, salesOrderId: so.id })).body.workOrder
  assert.equal(wo.salesOrder.id, so.id)
  await call('POST', t.w(`/work-orders/${wo.id}/start`), { date: today, materials: [] })
  const order = (await call('GET', t.w(`/sales-orders/${so.id}`))).body.salesOrder as SalesOrder
  assert.equal(order.workOrders.length, 1)
  assert.equal(order.productionCost, 6 * 6_500_00)
})
