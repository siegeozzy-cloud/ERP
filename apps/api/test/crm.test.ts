import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Account, CustomerDetail, Delivery, Invoice, LeadDetail, Quote, Role, SalesOrder, Unit, Warehouse } from '@erp/shared'
import { buildApp } from '../src/app.ts'
import { db, pool, runMigrations } from '../src/db/client.ts'
import { sessions, users } from '../src/db/schema.ts'
import { hashToken, newToken } from '../src/lib/crypto.ts'
import { todayInManila } from '../src/features/finance/ledger.ts'

// Phase 4: lead → customer → quote → sales order → deliveries → invoices.
// What matters most: stock leaves once (on the delivery), an order can't be invoiced for more than
// went out, and the stock valuation still equals the Inventory account at the end.

const app = await buildApp()
const run = Date.now()

async function makeUser(name: string) {
  const [user] = await db
    .insert(users)
    .values({ email: `crm+${name.toLowerCase()}+${run}@example.com`, name, passwordHash: 'x', emailVerifiedAt: new Date(), termsAcceptedAt: new Date() })
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
let main = ''
let rice = ''
let fee = ''

const asOf = '2030-12-31'
async function balanceOf(key: string) {
  const tb = (await call('GET', w(`/reports/trial-balance?asOf=${asOf}`))).body.report
  return tb.rows.find((r: { id: string }) => r.id === acct[key])?.balance ?? 0
}
const valuation = async () => (await call('GET', w(`/inventory/valuation?asOf=${asOf}`))).body.total as number
const onHand = async () => (await call('GET', w(`/items/${rice}`))).body.item.onHand as number
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

before(async () => {
  await runMigrations()
  owner = await makeUser('Lorna')
  const r = await call('POST', '/api/workspaces', { template: 'wholesale', name: 'Lorna Trading', tin: '444-555-666-00000', vatStatus: 'vat', street: 'Divisoria, Manila' })
  ws = r.body.workspace.id
  for (const a of (await call('GET', w('/accounts'))).body.accounts as Account[]) if (a.systemKey) acct[a.systemKey] = a.id
  const units = (await call('GET', w('/units'))).body.units as Unit[]
  main = ((await call('GET', w('/warehouses'))).body.warehouses as Warehouse[])[0]!.id
  rice = (
    await call('POST', w('/items'), { sku: 'RICE-50', name: 'Sinandomeng rice, 50 kg', unitId: units.find((u) => u.code === 'sack')!.id, salesPrice: 1_500_00, trackLots: true, trackExpiry: true })
  ).body.item.id
  fee = (await call('POST', w('/items'), { sku: 'DELIVERY', name: 'Delivery fee', kind: 'service', unitId: units.find((u) => u.code === 'pc')!.id, salesPrice: 500_00 })).body.item.id
  // 20 sacks expiring in January at ₱1,000, 30 expiring in June at ₱1,200
  const opening = await call('POST', w('/stock/adjustments'), {
    date: '2026-10-01',
    warehouseId: main,
    reason: 'opening',
    lines: [
      { itemId: rice, change: 20, unitCost: 1_000_00, lotNo: 'A', expiryDate: '2027-01-31' },
      { itemId: rice, change: 30, unitCost: 1_200_00, lotNo: 'B', expiryDate: '2027-06-30' },
    ],
  })
  assert.equal(opening.status, 201, JSON.stringify(opening.body))
})
after(async () => {
  await app.close()
  await pool.end()
})

let lead: LeadDetail
let customer = ''

test('a lead is added, worked and turned into a customer', async () => {
  const noName = await call('POST', w('/leads'), { title: 'Rice supply' })
  assert.equal(noName.body.error.field, 'companyName')
  const r = await call('POST', w('/leads'), { title: 'Weekly rice for 3 branches', companyName: 'Café Uno Inc.', personName: 'Mia Santos', phone: '0917 555 1234', source: 'referral', value: 90_000_00 })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  lead = r.body.lead
  assert.equal(lead.stage, 'new')
  assert.equal(lead.owner?.id, owner.id) // whoever adds it works it, unless they say otherwise

  const logged = await call('POST', w(`/leads/${lead.id}/activities`), { kind: 'call', body: 'Wants 40 sacks to start, delivered.', date: '2026-11-01' })
  assert.equal(logged.status, 201)
  assert.equal(logged.body.lead.activities[0].kind, 'call')

  const converted = await call('POST', w(`/leads/${lead.id}/convert`))
  lead = converted.body.lead
  assert.equal(lead.customer?.name, 'Café Uno Inc.')
  assert.equal(lead.stage, 'qualified')
  customer = lead.customer!.id
  assert.equal((await call('POST', w(`/leads/${lead.id}/convert`))).body.error.code, 'already-customer')

  const lost = await call('PATCH', w(`/leads/${lead.id}/stage`), { stage: 'lost' })
  assert.equal(lost.body.error.field, 'lostReason')

  const overview = (await call('GET', w('/crm/overview'))).body.overview
  assert.equal(overview.pipeline.find((p: { stage: string }) => p.stage === 'qualified').value, 90_000_00)
  assert.equal(overview.weighted, 90_000_00 * 0.25)
})

let quote: Quote

test('a quote is sent and accepted, which wins the lead; an expired one has to be copied', async () => {
  const lines = [
    { itemId: rice, quantity: 40, unitPrice: 1_500_00, vat: 'vatable' },
    { itemId: fee, quantity: 1, unitPrice: 500_00, vat: 'vatable' },
  ]
  const noVat = await call('POST', w('/quotes'), { customerId: customer, date: '2026-11-02', lines: [{ ...lines[0], vat: 'none' }] })
  assert.match(noVat.body.error.message, /VAT-registered/)

  const draft = await call('POST', w('/quotes'), { customerId: customer, leadId: lead.id, date: '2026-11-02', validUntil: '2030-12-31', lines })
  assert.equal(draft.status, 201, JSON.stringify(draft.body))
  assert.equal(draft.body.quote.total, 67_760_00) // (40 × 1,500 + 500) + 12% VAT
  assert.equal(draft.body.quote.lines[0].description, 'Sinandomeng rice, 50 kg')
  assert.equal((await call('POST', w(`/quotes/${draft.body.quote.id}/accept`))).body.error.message, 'Send the quote first.')

  quote = (await call('POST', w(`/quotes/${draft.body.quote.id}/send`))).body.quote
  assert.equal(quote.number, 'QT-000001')
  assert.equal((await call('GET', w(`/leads/${lead.id}`))).body.lead.stage, 'proposal')
  assert.equal((await call('PUT', w(`/quotes/${quote.id}`), { customerId: customer, date: '2026-11-02', lines })).status, 409)

  quote = (await call('POST', w(`/quotes/${quote.id}/accept`))).body.quote
  assert.equal(quote.status, 'accepted')
  const won = (await call('GET', w(`/leads/${lead.id}`))).body.lead as LeadDetail
  assert.equal(won.stage, 'won')
  assert.ok(won.closedAt)
  assert.equal(won.quotes[0]!.number, 'QT-000001')

  // an old quote can't be accepted at its old prices: copy it, and the copy is valid as long again
  const old = (await call('POST', w('/quotes'), { customerId: customer, date: '2026-01-05', validUntil: '2026-01-20', lines })).body.quote
  const sentOld = (await call('POST', w(`/quotes/${old.id}/send`))).body.quote as Quote
  assert.equal(sentOld.expired, true)
  assert.equal((await call('POST', w(`/quotes/${old.id}/accept`))).body.error.code, 'expired')
  const copy = (await call('POST', w(`/quotes/${old.id}/copy`))).body.quote as Quote
  assert.equal(copy.status, 'draft')
  assert.equal(copy.date, todayInManila())
  assert.equal(copy.validUntil, addDays(todayInManila(), 15))
  assert.equal(copy.total, 67_760_00)
  assert.equal((await call('DELETE', w(`/quotes/${copy.id}`))).status, 204)
})

let order: SalesOrder

test('the accepted quote becomes an order; confirming it respects the credit limit', async () => {
  const made = await call('POST', w(`/quotes/${quote.id}/order`))
  assert.equal(made.status, 201, JSON.stringify(made.body))
  order = made.body.salesOrder
  assert.equal(order.status, 'draft')
  assert.equal(order.total, 67_760_00)
  assert.equal(order.warehouse?.id, main)
  assert.equal(order.quote?.number, 'QT-000001')
  assert.equal((await call('POST', w(`/quotes/${quote.id}/order`))).body.error.code, 'already-ordered')

  const base = { name: 'Café Uno Inc.', tin: '111-222-333-00000', address: 'Legazpi Village, Makati', phone: '0917 555 1234' }
  await call('PUT', w(`/crm/customers/${customer}`), { ...base, creditLimit: 50_000_00, paymentTermsDays: 30 })
  const refused = await call('POST', w(`/sales-orders/${order.id}/confirm`))
  assert.equal(refused.body.error.code, 'over-credit-limit')
  assert.match(refused.body.error.message, /₱67,760\.00 .* over their ₱50,000\.00 credit limit/)

  await call('PUT', w(`/crm/customers/${customer}`), { ...base, creditLimit: 100_000_00, paymentTermsDays: 30 })
  order = (await call('POST', w(`/sales-orders/${order.id}/confirm`))).body.salesOrder
  assert.equal(order.number, 'SO-000001')
  assert.equal(order.status, 'confirmed')

  // the finance contact form doesn't send terms: editing there leaves them alone
  await call('PUT', w(`/contacts/${customer}`), { ...base, isCustomer: true })
  const c = (await call('GET', w(`/contacts/${customer}`))).body.contact
  assert.equal(c.creditLimit, 100_000_00)
  assert.equal(c.paymentTermsDays, 30)
})

test('before anything is delivered, only the service can be invoiced', async () => {
  const r = await call('POST', w(`/sales-orders/${order.id}/invoice`))
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const inv = (await call('GET', w(`/invoices/${r.body.invoiceId}`))).body.invoice as Invoice
  assert.deepEqual(
    inv.lines.map((l) => [l.description, l.quantity]),
    [['Delivery fee', 1]],
  )
  assert.equal((await call('DELETE', w(`/invoices/${inv.id}`))).status, 204)
})

let delivery: Delivery

test('a delivery takes the stock out, earliest expiry first, and books the cost', async () => {
  const valueBefore = await valuation()
  const over = await call('POST', w(`/sales-orders/${order.id}/deliver`), { date: '2026-11-05', warehouseId: main, lines: [{ soLineId: order.lines[0]!.id, quantity: 41 }] })
  assert.match(over.body.error.message, /only 40/)
  const service = await call('POST', w(`/sales-orders/${order.id}/deliver`), { date: '2026-11-05', warehouseId: main, lines: [{ soLineId: order.lines[1]!.id, quantity: 1 }] })
  assert.match(service.body.error.message, /non-stock/)

  const r = await call('POST', w(`/sales-orders/${order.id}/deliver`), { date: '2026-11-05', warehouseId: main, lines: [{ soLineId: order.lines[0]!.id, quantity: 25 }] })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  delivery = r.body.delivery
  order = r.body.salesOrder
  assert.equal(delivery.number, 'DR-000001')
  assert.equal(delivery.customer.name, 'Café Uno Inc.')
  assert.equal(delivery.salesOrder.number, 'SO-000001')
  // all 20 of lot A (expiring first), then 5 of lot B
  assert.deepEqual(delivery.lines.map((l) => `${l.lotNo}:${l.quantity}`), ['A:20', 'B:5'])
  assert.equal(order.status, 'partly_delivered')
  assert.equal(order.lines[0]!.deliveredQty, 25)
  assert.equal(await onHand(), 25)

  const cost = valueBefore - (await valuation())
  assert.equal(cost, Math.round(25 * (56_000_00 / 50))) // average cost ₱1,120
  assert.equal(delivery.value, cost)
  assert.equal(await balanceOf('cogs'), cost)
  assert.equal(await valuation(), await balanceOf('inventory'))
  assert.equal((await call('GET', w(`/deliveries/${delivery.id}`))).body.delivery.number, 'DR-000001')
})

let firstInvoice: Invoice

test('the invoice made from the order bills what was delivered, and doesn’t take the stock again', async () => {
  const valueBefore = await valuation()
  const r = await call('POST', w(`/sales-orders/${order.id}/invoice`))
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal((await call('POST', w(`/sales-orders/${order.id}/invoice`))).body.error.code, 'nothing-to-invoice') // it's all on the draft
  const draft = (await call('GET', w(`/invoices/${r.body.invoiceId}`))).body.invoice as Invoice
  assert.deepEqual(
    draft.lines.map((l) => [l.description, l.quantity]),
    [
      ['Sinandomeng rice, 50 kg', 25],
      ['Delivery fee', 1],
    ],
  )
  assert.equal(draft.dueDate, addDays(todayInManila(), 30)) // the customer's terms
  assert.match(draft.notes ?? '', /For SO-000001/)

  // invoicing more than went out is refused at posting
  const body = (qty: number) => ({
    customerId: customer,
    date: draft.date,
    dueDate: draft.dueDate,
    notes: draft.notes,
    lines: draft.lines.map((l, i) => ({ description: l.description, quantity: i === 0 ? qty : l.quantity, unitPrice: l.unitPrice, vat: l.vat, accountId: l.accountId, itemId: l.itemId, soLineId: l.soLineId })),
  })
  await call('PUT', w(`/invoices/${draft.id}`), body(26))
  const over = await call('POST', w(`/invoices/${draft.id}/post`))
  assert.equal(over.body.error.code, 'over-invoiced')
  assert.match(over.body.error.message, /only 25/)
  await call('PUT', w(`/invoices/${draft.id}`), body(25))

  const posted = await call('POST', w(`/invoices/${draft.id}/post`))
  assert.equal(posted.status, 200, JSON.stringify(posted.body))
  firstInvoice = posted.body.invoice
  assert.equal(firstInvoice.total, (25 * 1_500_00 + 500_00) * 1.12)
  assert.equal(await valuation(), valueBefore) // no second trip out of the warehouse
  assert.equal(await onHand(), 25)
  assert.equal(await balanceOf('ar'), firstInvoice.total)

  order = (await call('GET', w(`/sales-orders/${order.id}`))).body.salesOrder
  assert.deepEqual(order.lines.map((l) => l.invoicedQty), [25, 1])
  assert.equal(order.invoices[0]!.number, firstInvoice.number)
  assert.equal((await call('POST', w(`/sales-orders/${order.id}/invoice`))).body.error.message, 'Nothing delivered is waiting to be invoiced. Deliver the goods first.')

  // the customer owes the invoice and has the rest on order
  const c = (await call('GET', w(`/crm/customers/${customer}`))).body.customer as CustomerDetail
  assert.equal(c.owed, firstInvoice.total)
  assert.equal(c.onOrder, 25_200_00) // 15 × ₱1,500 + 12% VAT
  assert.equal(c.invoices.length, 1)
  assert.equal(c.leads[0]!.stage, 'won')
})

test('the rest goes out and is invoiced, which closes the order; voiding an invoice reopens it', async () => {
  const r = await call('POST', w(`/sales-orders/${order.id}/deliver`), { date: '2026-11-08', warehouseId: main, lines: [{ soLineId: order.lines[0]!.id, quantity: 15 }] })
  assert.equal(r.body.salesOrder.status, 'delivered')
  const made = await call('POST', w(`/sales-orders/${order.id}/invoice`))
  const posted = await call('POST', w(`/invoices/${made.body.invoiceId}/post`))
  assert.equal(posted.status, 200, JSON.stringify(posted.body))
  order = (await call('GET', w(`/sales-orders/${order.id}`))).body.salesOrder
  assert.equal(order.status, 'closed')
  assert.equal(order.deliveries.length, 2)
  assert.equal((await call('POST', w(`/sales-orders/${order.id}/cancel`))).body.error.code, 'in-progress')

  const stockBefore = await onHand()
  await call('POST', w(`/invoices/${firstInvoice.id}/void`), { date: todayInManila() })
  order = (await call('GET', w(`/sales-orders/${order.id}`))).body.salesOrder
  assert.equal(order.status, 'delivered')
  assert.deepEqual(order.lines.map((l) => l.invoicedQty), [15, 0])
  assert.equal(await onHand(), stockBefore) // the goods are still with the customer
  assert.equal(await valuation(), await balanceOf('inventory'))
  const tb = (await call('GET', w(`/reports/trial-balance?asOf=${asOf}`))).body.report
  assert.equal(tb.totalDebit, tb.totalCredit)
})

test('activities on the lead and the customer both show on the customer', async () => {
  await call('POST', w(`/crm/customers/${customer}/activities`), { kind: 'meeting', body: 'Agreed on Tuesday deliveries.', date: '2026-11-09' })
  const c = (await call('GET', w(`/crm/customers/${customer}`))).body.customer as CustomerDetail
  assert.deepEqual(c.activities.map((a) => a.kind).sort(), ['call', 'meeting'])
  const list = (await call('GET', w('/crm/customers?q=uno'))).body.customers
  assert.equal(list.length, 1)
})

test('sales staff sell, warehouse staff deliver, and neither posts to the books', async () => {
  const roles = (await call('GET', w('/roles'))).body.roles as Role[]
  const join = async (roleName: string, person: string) => {
    const code = (await call('POST', w('/join-codes'), { roleId: roles.find((r) => r.name === roleName)!.id })).body.code.code
    const u = await makeUser(person)
    assert.equal((await u.call('POST', '/api/workspaces/join', { code })).status, 200)
    return u
  }
  const sales = await join('Sales', 'Jun')
  const staff = await join('Warehouse staff', 'Bong')

  const so = await sales.call('POST', w('/sales-orders'), { customerId: customer, date: '2026-11-10', warehouseId: main, lines: [{ itemId: rice, quantity: 2, unitPrice: 1_500_00, vat: 'vatable' }] })
  assert.equal(so.status, 201, JSON.stringify(so.body))
  const confirmed = (await sales.call('POST', w(`/sales-orders/${so.body.salesOrder.id}/confirm`))).body.salesOrder as SalesOrder
  assert.equal(confirmed.number, 'SO-000002')
  assert.equal((await sales.call('GET', w('/sales/items'))).status, 200)
  assert.equal((await sales.call('POST', w(`/sales-orders/${confirmed.id}/deliver`), { date: '2026-11-11', warehouseId: main, lines: [{ soLineId: confirmed.lines[0]!.id, quantity: 2 }] })).status, 403)
  assert.equal((await sales.call('POST', w(`/sales-orders/${confirmed.id}/invoice`))).status, 403)
  assert.equal((await sales.call('GET', w('/invoices'))).status, 403)

  assert.equal((await staff.call('POST', w('/sales-orders'), { customerId: customer, date: '2026-11-10', lines: [{ itemId: fee, quantity: 1, unitPrice: 1, vat: 'vatable' }] })).status, 403)
  const delivered = await staff.call('POST', w(`/sales-orders/${confirmed.id}/deliver`), { date: '2026-11-11', warehouseId: main, lines: [{ soLineId: confirmed.lines[0]!.id, quantity: 2 }] })
  assert.equal(delivered.status, 201, JSON.stringify(delivered.body))
  assert.equal(delivered.body.salesOrder.status, 'delivered')

  const current = (await call('GET', w(''))).body.workspace
  await call('PATCH', w(''), { ...current, modules: ['finance', 'inventory'] })
  const off = await call('GET', w('/leads'))
  assert.equal(off.body.error.code, 'module-off')
  await call('PATCH', w(''), { ...current, modules: current.modules })
  assert.equal((await call('GET', w('/leads'))).status, 200)
})
