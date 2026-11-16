import {
  InvoiceFromOrderInput,
  computeLine,
  computeTotals,
  DeliveryInput,
  formatPeso,
  q4,
  QUOTE_STATUSES,
  QuoteInput,
  SalesOrderInput,
  SO_STATUSES,
  VAT_TREATMENT_LABELS,
  type Delivery,
  type Quote,
  type QuoteSummary,
  type SalesLine,
  type SalesOrder,
  type SalesOrderSummary,
} from '@erp/shared'
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client.ts'
import { contacts, documentLines, items, leads, quotes, salesInvoices, salesLines, salesOrders, stockDocuments, stockLots, stockMoves, units, warehouses, workOrders, type WorkspaceRow } from '../../db/schema.ts'
import type { Executor, Tx } from '../../db/types.ts'
import { audit } from '../../lib/audit.ts'
import { HttpError, parse } from '../../lib/errors.ts'
import { userOf } from '../../lib/session.ts'
import { needs, workspaceOf } from '../../lib/workspace.ts'
import { totalsOf } from '../finance/documents.ts'
import { nextNumber, postEntry, systemAccount, taxRateOn, todayInManila, VAT_CODE } from '../finance/ledger.ts'
import { warnLow } from '../inventory/routes.ts'
import { activeWarehouse, itemTotals, lockStockItem, stockOut } from '../inventory/stock.ts'
import { exposureOf } from './exposure.ts'
import { refreshSoStatus } from './order-lines.ts'

/**
 * Quotes (QT-), sales orders (SO-) and deliveries (DR-).
 *
 * A delivery takes the goods out of the warehouse at moving average cost and books that cost:
 * Dr Cost of Sales / Cr Inventory. The invoice made from the order then books only the sale
 * (Dr Accounts Receivable / Cr Sales / Cr Output VAT), and can't bill more than was delivered.
 * So stock leaves once, on the day it leaves, and the customer owes from the day they're invoiced.
 */

const view = needs('crm.view', 'crm')
const quoting = needs('crm.manage', 'crm')
const ordering = needs('sales.manage', 'crm')
const delivering = needs('inventory.manage', 'crm')

const IdParam = z.object({ id: z.uuid() })
const idOf = (params: unknown, what: string) => {
  const r = IdParam.safeParse(params)
  if (!r.success) throw new HttpError(404, 'not-found', `That ${what} doesn’t exist.`)
  return r.data.id
}

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

type QuoteRow = typeof quotes.$inferSelect
type OrderRow = typeof salesOrders.$inferSelect
type ItemRow = typeof items.$inferSelect

/* ---------------------------------------------------------------------------------------------
 * Lines: checked against the workspace and priced with the rates in force on the document's date
 * ------------------------------------------------------------------------------------------- */

async function prepareSales(db: Executor, ws: WorkspaceRow, input: { customerId: string; date: string; pricesIncludeVat: boolean; lines: z.output<typeof QuoteInput>['lines'] }) {
  const [customer] = await db.select().from(contacts).where(and(eq(contacts.id, input.customerId), eq(contacts.workspaceId, ws.id)))
  if (!customer?.isCustomer) throw new HttpError(400, 'invalid', 'Choose a customer.', 'customerId')
  const itemRows = await db.select().from(items).where(and(eq(items.workspaceId, ws.id), inArray(items.id, [...new Set(input.lines.map((l) => l.itemId))])))
  const byId = new Map(itemRows.map((i) => [i.id, i]))
  const vatRateBp = input.lines.some((l) => l.vat === 'vatable') ? (await taxRateOn(db, ws.id, VAT_CODE, input.date)).rateBp : 0
  const lines = input.lines.map((l, i) => {
    const item = byId.get(l.itemId)
    if (!item) throw new HttpError(400, 'invalid', `Line ${i + 1}: choose an item.`, 'lines')
    if (!item.active) throw new HttpError(400, 'invalid', `Line ${i + 1}: ${item.name} is turned off.`, 'lines')
    // the same rules as the invoice these become
    if (ws.vatStatus === 'vat' && l.vat === 'none') throw new HttpError(400, 'invalid', `Line ${i + 1}: a VAT-registered business charges VAT. Choose VATable, zero-rated or VAT-exempt.`, 'lines')
    if (ws.vatStatus === 'non_vat' && l.vat !== 'none') throw new HttpError(400, 'invalid', `Line ${i + 1}: a non-VAT business doesn’t make ${VAT_TREATMENT_LABELS[l.vat]} sales. Choose Non-VAT.`, 'lines')
    const { gross, net, vatAmount } = computeLine({ quantity: l.quantity, unitPrice: l.unitPrice, vat: l.vat, vatRateBp }, input.pricesIncludeVat)
    return { position: i, itemId: item.id, description: l.description ?? item.name, quantity: l.quantity, unitPrice: l.unitPrice, vat: l.vat, vatRateBp: l.vat === 'vatable' ? vatRateBp : 0, gross, net, vatAmount }
  })
  return { customer, lines, items: byId, totals: computeTotals(lines.map((l) => ({ ...l, ewtAmount: 0 }))) }
}

type Prepared = Awaited<ReturnType<typeof prepareSales>>

async function linesOf(db: Executor, where: { quoteId?: string; orderId?: string }): Promise<SalesLine[]> {
  const rows = await db
    .select({ l: salesLines, item: items, unit: units.code })
    .from(salesLines)
    .innerJoin(items, eq(items.id, salesLines.itemId))
    .innerJoin(units, eq(units.id, items.unitId))
    .where(where.quoteId ? eq(salesLines.quoteId, where.quoteId) : eq(salesLines.orderId, where.orderId!))
    .orderBy(asc(salesLines.position))
  return rows.map(({ l, item, unit }) => ({
    id: l.id,
    item: { id: item.id, sku: item.sku, name: item.name, kind: item.kind, trackLots: item.trackLots, unit },
    description: l.description,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    vat: l.vat,
    gross: l.gross,
    net: l.net,
    vatAmount: l.vatAmount,
    ewtAmount: 0,
    deliveredQty: l.deliveredQty,
    invoicedQty: l.invoicedQty,
  }))
}

const lineValues = (workspaceId: string, parent: { quoteId?: string; orderId?: string }, prepared: Prepared) =>
  prepared.lines.map((l) => ({ ...l, workspaceId, quoteId: parent.quoteId ?? null, orderId: parent.orderId ?? null }))

/* ---------------------------------------------------------------------------------------------
 * Quotes
 * ------------------------------------------------------------------------------------------- */

const isExpired = (q: Pick<QuoteRow, 'status' | 'validUntil'>) => q.status === 'sent' && !!q.validUntil && q.validUntil < todayInManila()

/** The order a quote became (not counting cancelled ones). */
const orderOfQuote = sql<string | null>`(select so.id from sales_orders so where so.quote_id = ${quotes.id} and so.status <> 'cancelled' order by so.created_at desc limit 1)`
const orderNumberOfQuote = sql<string | null>`(select so.number from sales_orders so where so.quote_id = ${quotes.id} and so.status <> 'cancelled' order by so.created_at desc limit 1)`

const quoteSelect = {
  q: quotes,
  customer: { id: contacts.id, name: contacts.name },
  leadId: leads.id,
  leadTitle: leads.title,
  orderId: orderOfQuote,
  orderNumber: orderNumberOfQuote,
}

type QuoteSelected = { q: QuoteRow; customer: { id: string; name: string }; leadId: string | null; leadTitle: string | null; orderId: string | null; orderNumber: string | null }

const quoteSummaryOut = (r: QuoteSelected): QuoteSummary => ({
  id: r.q.id,
  number: r.q.number,
  status: r.q.status,
  date: r.q.date,
  validUntil: r.q.validUntil,
  expired: isExpired(r.q),
  customer: r.customer,
  lead: r.leadId ? { id: r.leadId, title: r.leadTitle! } : null,
  salesOrder: r.orderId ? { id: r.orderId, number: r.orderNumber } : null,
  ...totalsOf(r.q),
})

/** Quotes, newest first. Used by the lists, and by the customer and lead pages. */
export async function quoteSummaries(db: Executor, workspaceId: string, filter: { status?: QuoteRow['status']; customerId?: string; leadId?: string } = {}) {
  const rows = await db
    .select(quoteSelect)
    .from(quotes)
    .innerJoin(contacts, eq(contacts.id, quotes.customerId))
    .leftJoin(leads, eq(leads.id, quotes.leadId))
    .where(
      and(
        eq(quotes.workspaceId, workspaceId),
        filter.status ? eq(quotes.status, filter.status) : undefined,
        filter.customerId ? eq(quotes.customerId, filter.customerId) : undefined,
        filter.leadId ? eq(quotes.leadId, filter.leadId) : undefined,
      ),
    )
    .orderBy(desc(quotes.date), desc(quotes.createdAt))
    .limit(500)
  return rows.map(quoteSummaryOut)
}

async function quoteDetail(db: Executor, workspaceId: string, id: string): Promise<Quote> {
  const [row] = await db
    .select(quoteSelect)
    .from(quotes)
    .innerJoin(contacts, eq(contacts.id, quotes.customerId))
    .leftJoin(leads, eq(leads.id, quotes.leadId))
    .where(and(eq(quotes.id, id), eq(quotes.workspaceId, workspaceId)))
  if (!row) throw new HttpError(404, 'not-found', 'That quote doesn’t exist.')
  return { ...quoteSummaryOut(row), pricesIncludeVat: row.q.pricesIncludeVat, notes: row.q.notes, lines: await linesOf(db, { quoteId: id }) }
}

async function lockQuote(tx: Tx, workspaceId: string, id: string) {
  const [q] = await tx.select().from(quotes).where(and(eq(quotes.id, id), eq(quotes.workspaceId, workspaceId))).for('update')
  if (!q) throw new HttpError(404, 'not-found', 'That quote doesn’t exist.')
  return q
}

async function checkLead(db: Executor, workspaceId: string, leadId: string | null | undefined) {
  if (!leadId) return null
  const [lead] = await db.select().from(leads).where(and(eq(leads.id, leadId), eq(leads.workspaceId, workspaceId)))
  if (!lead) throw new HttpError(400, 'invalid', 'That lead isn’t in this workspace.', 'leadId')
  return lead
}

/* ---------------------------------------------------------------------------------------------
 * Sales orders
 * ------------------------------------------------------------------------------------------- */

const orderSelect = {
  o: salesOrders,
  customer: { id: contacts.id, name: contacts.name },
  warehouseId: warehouses.id,
  warehouseName: warehouses.name,
  quoteNumber: quotes.number,
}

type OrderSelected = { o: OrderRow; customer: { id: string; name: string }; warehouseId: string | null; warehouseName: string | null; quoteNumber: string | null }

const orderSummaryOut = (r: OrderSelected): SalesOrderSummary => ({
  id: r.o.id,
  number: r.o.number,
  status: r.o.status,
  date: r.o.date,
  deliveryDate: r.o.deliveryDate,
  customerPoNo: r.o.customerPoNo,
  customer: r.customer,
  warehouse: r.warehouseId ? { id: r.warehouseId, name: r.warehouseName! } : null,
  quote: r.o.quoteId ? { id: r.o.quoteId, number: r.quoteNumber } : null,
  ...totalsOf(r.o),
})

export async function orderSummaries(db: Executor, workspaceId: string, filter: { status?: OrderRow['status']; customerId?: string } = {}) {
  const rows = await db
    .select(orderSelect)
    .from(salesOrders)
    .innerJoin(contacts, eq(contacts.id, salesOrders.customerId))
    .leftJoin(warehouses, eq(warehouses.id, salesOrders.warehouseId))
    .leftJoin(quotes, eq(quotes.id, salesOrders.quoteId))
    .where(and(eq(salesOrders.workspaceId, workspaceId), filter.status ? eq(salesOrders.status, filter.status) : undefined, filter.customerId ? eq(salesOrders.customerId, filter.customerId) : undefined))
    .orderBy(desc(salesOrders.date), desc(salesOrders.createdAt))
    .limit(500)
  return rows.map(orderSummaryOut)
}

async function orderDetail(db: Executor, workspaceId: string, id: string): Promise<SalesOrder> {
  const [row] = await db
    .select(orderSelect)
    .from(salesOrders)
    .innerJoin(contacts, eq(contacts.id, salesOrders.customerId))
    .leftJoin(warehouses, eq(warehouses.id, salesOrders.warehouseId))
    .leftJoin(quotes, eq(quotes.id, salesOrders.quoteId))
    .where(and(eq(salesOrders.id, id), eq(salesOrders.workspaceId, workspaceId)))
  if (!row) throw new HttpError(404, 'not-found', 'That sales order doesn’t exist.')
  const lines = await linesOf(db, { orderId: id })
  const deliveries = await db
    .select({ d: stockDocuments, value: sql<number>`(select coalesce(-sum(value), 0)::bigint from stock_moves where document_id = ${stockDocuments.id})`.mapWith(Number) })
    .from(stockDocuments)
    .where(eq(stockDocuments.soId, id))
    .orderBy(asc(stockDocuments.createdAt))
  const invoices = lines.length
    ? await db
        .selectDistinct({ id: salesInvoices.id, number: salesInvoices.number, status: salesInvoices.status, total: salesInvoices.total })
        .from(salesInvoices)
        .innerJoin(documentLines, eq(documentLines.invoiceId, salesInvoices.id))
        .where(inArray(documentLines.soLineId, lines.map((l) => l.id)))
    : []
  // make to order: what was made for it, at what it cost (materials, plus labour and overhead once done)
  const made = await db
    .select({ id: workOrders.id, number: workOrders.number, status: workOrders.status, item: items.name, quantity: workOrders.quantity, cost: sql<number>`${workOrders.materialCost} + ${workOrders.conversionCost}`.mapWith(Number) })
    .from(workOrders)
    .innerJoin(items, eq(items.id, workOrders.itemId))
    .where(and(eq(workOrders.salesOrderId, id), ne(workOrders.status, 'cancelled')))
    .orderBy(asc(workOrders.createdAt))
  return {
    ...orderSummaryOut(row),
    workOrders: made,
    productionCost: made.reduce((s, w) => s + w.cost, 0),
    pricesIncludeVat: row.o.pricesIncludeVat,
    notes: row.o.notes,
    lines,
    deliveries: deliveries.map((r) => ({ id: r.d.id, number: r.d.number, date: r.d.date, value: r.value })),
    invoices,
  }
}

async function lockOrder(tx: Tx, workspaceId: string, id: string) {
  const [o] = await tx.select().from(salesOrders).where(and(eq(salesOrders.id, id), eq(salesOrders.workspaceId, workspaceId))).for('update')
  if (!o) throw new HttpError(404, 'not-found', 'That sales order doesn’t exist.')
  return o
}

const OPEN: OrderRow['status'][] = ['confirmed', 'partly_delivered', 'delivered']

/** A warehouse is needed when anything on the order has to be shipped. */
async function orderWarehouse(db: Executor, ws: WorkspaceRow, warehouseId: string | null | undefined, prepared: Prepared) {
  const ships = prepared.lines.some((l) => prepared.items.get(l.itemId)?.kind === 'stock')
  if (!warehouseId) {
    if (ships) throw new HttpError(400, 'invalid', 'Choose the warehouse the goods ship from.', 'warehouseId')
    return null
  }
  return (await activeWarehouse(db, ws.id, warehouseId)).id
}

/* ---------------------------------------------------------------------------------------------
 * Deliveries
 * ------------------------------------------------------------------------------------------- */

export async function deliveryDetail(db: Executor, workspaceId: string, id: string): Promise<Delivery> {
  const [row] = await db
    .select({ d: stockDocuments, so: salesOrders, customer: contacts, warehouse: warehouses })
    .from(stockDocuments)
    .innerJoin(salesOrders, eq(salesOrders.id, stockDocuments.soId))
    .innerJoin(contacts, eq(contacts.id, salesOrders.customerId))
    .innerJoin(warehouses, eq(warehouses.id, stockDocuments.warehouseId))
    .where(and(eq(stockDocuments.id, id), eq(stockDocuments.workspaceId, workspaceId), eq(stockDocuments.kind, 'delivery')))
  if (!row) throw new HttpError(404, 'not-found', 'That delivery doesn’t exist.')
  const moves = await db
    .select({ m: stockMoves, item: { id: items.id, sku: items.sku, name: items.name }, unit: units.code, lotNo: stockLots.lotNo, expiryDate: stockLots.expiryDate })
    .from(stockMoves)
    .innerJoin(items, eq(items.id, stockMoves.itemId))
    .innerJoin(units, eq(units.id, items.unitId))
    .leftJoin(stockLots, eq(stockLots.id, stockMoves.lotId))
    .leftJoin(salesLines, eq(salesLines.id, stockMoves.soLineId))
    .where(eq(stockMoves.documentId, id))
    // moves made together share a timestamp: show them in order-line order, lots as FEFO took them
    .orderBy(asc(salesLines.position), sql`${stockLots.expiryDate} asc nulls last`, asc(stockLots.lotNo))
  return {
    id: row.d.id,
    number: row.d.number,
    date: row.d.date,
    warehouse: { id: row.warehouse.id, name: row.warehouse.name, address: row.warehouse.address },
    notes: row.d.notes,
    customer: { id: row.customer.id, name: row.customer.name, tin: row.customer.tin, address: row.customer.address },
    salesOrder: { id: row.so.id, number: row.so.number, customerPoNo: row.so.customerPoNo },
    value: -moves.reduce((s, r) => s + r.m.value, 0),
    lines: moves.map((r) => ({ item: { ...r.item, unit: r.unit }, quantity: -r.m.quantity, lotNo: r.lotNo, expiryDate: r.expiryDate })),
  }
}

/* ---------------------------------------------------------------------------------------------
 * Routes
 * ------------------------------------------------------------------------------------------- */

export default async function salesRoutes(app: FastifyInstance) {
  /* ---------- quotes ---------- */

  app.get('/quotes', view, async (req) => {
    const q = parse(z.object({ status: z.enum(QUOTE_STATUSES).optional(), customerId: z.uuid().optional(), leadId: z.uuid().optional() }), req.query)
    return { quotes: await quoteSummaries(db, workspaceOf(req).id, q) }
  })

  app.get('/quotes/:id', view, async (req) => ({ quote: await quoteDetail(db, workspaceOf(req).id, idOf(req.params, 'quote')) }))

  app.post('/quotes', quoting, async (req, reply) => {
    const input = parse(QuoteInput, req.body)
    const ws = workspaceOf(req)
    const lead = await checkLead(db, ws.id, input.leadId)
    const prepared = await prepareSales(db, ws, input)
    const id = await db.transaction(async (tx) => {
      const [q] = await tx
        .insert(quotes)
        .values({ workspaceId: ws.id, customerId: input.customerId, leadId: lead?.id ?? null, date: input.date, validUntil: input.validUntil ?? null, pricesIncludeVat: input.pricesIncludeVat, notes: input.notes ?? null, ...prepared.totals, createdBy: userOf(req).id })
        .returning()
      await tx.insert(salesLines).values(lineValues(ws.id, { quoteId: q!.id }, prepared))
      await audit(tx, req, { action: 'quote.drafted', entity: 'quote', entityId: q!.id, summary: `Drafted a quote for ${prepared.customer.name} (${formatPeso(prepared.totals.total)})` })
      return q!.id
    })
    return reply.code(201).send({ quote: await quoteDetail(db, ws.id, id) })
  })

  app.put('/quotes/:id', quoting, async (req) => {
    const id = idOf(req.params, 'quote')
    const input = parse(QuoteInput, req.body)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const current = await lockQuote(tx, ws.id, id)
      if (current.status !== 'draft') throw new HttpError(409, 'locked', 'A sent quote can’t be edited. Make a revised copy instead.')
      const lead = await checkLead(tx, ws.id, input.leadId)
      const prepared = await prepareSales(tx, ws, input)
      await tx.delete(salesLines).where(eq(salesLines.quoteId, id))
      await tx.insert(salesLines).values(lineValues(ws.id, { quoteId: id }, prepared))
      await tx
        .update(quotes)
        .set({ customerId: input.customerId, leadId: lead?.id ?? null, date: input.date, validUntil: input.validUntil ?? null, pricesIncludeVat: input.pricesIncludeVat, notes: input.notes ?? null, ...prepared.totals, updatedAt: new Date() })
        .where(eq(quotes.id, id))
      await audit(tx, req, { action: 'quote.edited', entity: 'quote', entityId: id, summary: `Edited a draft quote for ${prepared.customer.name} (${formatPeso(prepared.totals.total)})` })
    })
    return { quote: await quoteDetail(db, ws.id, id) }
  })

  app.delete('/quotes/:id', quoting, async (req, reply) => {
    const id = idOf(req.params, 'quote')
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const current = await lockQuote(tx, ws.id, id)
      if (current.status !== 'draft') throw new HttpError(409, 'locked', 'Only drafts can be deleted. A sent quote stays on record.')
      await tx.delete(quotes).where(eq(quotes.id, id))
      await audit(tx, req, { action: 'quote.deleted', entity: 'quote', entityId: id, summary: `Deleted a draft quote (${formatPeso(current.total)})` })
    })
    return reply.code(204).send()
  })

  /** Sending gives it its number. Its lead moves on to "Quote sent". */
  app.post('/quotes/:id/send', quoting, async (req) => {
    const id = idOf(req.params, 'quote')
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const q = await lockQuote(tx, ws.id, id)
      if (q.status !== 'draft') throw new HttpError(409, 'locked', 'That quote has already been sent.')
      const number = await nextNumber(tx, ws.id, 'quote')
      await tx.update(quotes).set({ status: 'sent', number, sentAt: new Date(), updatedAt: new Date() }).where(eq(quotes.id, id))
      if (q.leadId) await tx.update(leads).set({ stage: 'proposal', updatedAt: new Date() }).where(and(eq(leads.id, q.leadId), inArray(leads.stage, ['new', 'qualified'])))
      await audit(tx, req, { action: 'quote.sent', entity: 'quote', entityId: id, summary: `Sent quote ${number} (${formatPeso(q.total)})` })
    })
    return { quote: await quoteDetail(db, ws.id, id) }
  })

  /** The customer said yes. Its lead is won. */
  app.post('/quotes/:id/accept', quoting, async (req) => {
    const id = idOf(req.params, 'quote')
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const q = await lockQuote(tx, ws.id, id)
      if (q.status !== 'sent') throw new HttpError(409, 'locked', q.status === 'draft' ? 'Send the quote first.' : 'That quote has already been answered.')
      if (isExpired(q)) throw new HttpError(409, 'expired', `This quote expired on ${q.validUntil}. Make a revised copy with today’s prices.`)
      await tx.update(quotes).set({ status: 'accepted', respondedAt: new Date(), updatedAt: new Date() }).where(eq(quotes.id, id))
      if (q.leadId) {
        await tx
          .update(leads)
          .set({ stage: 'won', closedAt: new Date(), lostReason: null, customerId: sql`coalesce(${leads.customerId}, ${q.customerId})`, updatedAt: new Date() })
          .where(and(eq(leads.id, q.leadId), ne(leads.stage, 'won')))
      }
      await audit(tx, req, { action: 'quote.accepted', entity: 'quote', entityId: id, summary: `Quote ${q.number} was accepted (${formatPeso(q.total)})` })
    })
    return { quote: await quoteDetail(db, ws.id, id) }
  })

  app.post('/quotes/:id/decline', quoting, async (req) => {
    const id = idOf(req.params, 'quote')
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const q = await lockQuote(tx, ws.id, id)
      if (q.status !== 'sent') throw new HttpError(409, 'locked', q.status === 'draft' ? 'A draft can be deleted instead.' : 'That quote has already been answered.')
      await tx.update(quotes).set({ status: 'declined', respondedAt: new Date(), updatedAt: new Date() }).where(eq(quotes.id, id))
      await audit(tx, req, { action: 'quote.declined', entity: 'quote', entityId: id, summary: `Quote ${q.number} was declined` })
    })
    return { quote: await quoteDetail(db, ws.id, id) }
  })

  /** A new draft with the same lines, dated today and valid for as long as the original was. */
  app.post('/quotes/:id/copy', quoting, async (req, reply) => {
    const id = idOf(req.params, 'quote')
    const ws = workspaceOf(req)
    const original = await quoteDetail(db, ws.id, id)
    const date = todayInManila()
    const input = parse(QuoteInput, {
      customerId: original.customer.id,
      leadId: original.lead?.id ?? null,
      date,
      validUntil: original.validUntil ? addDays(date, Math.max(0, daysBetween(original.date, original.validUntil))) : null,
      pricesIncludeVat: original.pricesIncludeVat,
      notes: original.notes ?? '',
      lines: original.lines.map((l) => ({ itemId: l.item.id, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, vat: l.vat })),
    })
    const prepared = await prepareSales(db, ws, input)
    const newId = await db.transaction(async (tx) => {
      const [q] = await tx
        .insert(quotes)
        .values({ workspaceId: ws.id, customerId: input.customerId, leadId: input.leadId ?? null, date, validUntil: input.validUntil ?? null, pricesIncludeVat: input.pricesIncludeVat, notes: input.notes ?? null, ...prepared.totals, createdBy: userOf(req).id })
        .returning()
      await tx.insert(salesLines).values(lineValues(ws.id, { quoteId: q!.id }, prepared))
      await audit(tx, req, { action: 'quote.drafted', entity: 'quote', entityId: q!.id, summary: `Drafted a copy of quote ${original.number ?? '(draft)'} for ${prepared.customer.name}` })
      return q!.id
    })
    return reply.code(201).send({ quote: await quoteDetail(db, ws.id, newId) })
  })

  /** An accepted quote becomes a draft sales order, at the quoted prices. */
  app.post('/quotes/:id/order', ordering, async (req, reply) => {
    const id = idOf(req.params, 'quote')
    const ws = workspaceOf(req)
    const quote = await quoteDetail(db, ws.id, id)
    if (quote.status !== 'accepted') throw new HttpError(409, 'not-accepted', 'Only an accepted quote becomes a sales order.')
    if (quote.salesOrder) throw new HttpError(409, 'already-ordered', `This quote is already on sales order ${quote.salesOrder.number ?? '(draft)'}.`)
    const date = todayInManila()
    const prepared = await prepareSales(db, ws, {
      customerId: quote.customer.id,
      date,
      pricesIncludeVat: quote.pricesIncludeVat,
      lines: quote.lines.map((l) => ({ itemId: l.item.id, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, vat: l.vat })),
    })
    const ships = prepared.lines.some((l) => prepared.items.get(l.itemId)?.kind === 'stock')
    const [firstWarehouse] = ships ? await db.select().from(warehouses).where(and(eq(warehouses.workspaceId, ws.id), eq(warehouses.active, true))).orderBy(asc(warehouses.createdAt)).limit(1) : []
    const orderId = await db.transaction(async (tx) => {
      const [o] = await tx
        .insert(salesOrders)
        .values({
          workspaceId: ws.id,
          customerId: quote.customer.id,
          quoteId: quote.id,
          date,
          warehouseId: firstWarehouse?.id ?? null,
          pricesIncludeVat: quote.pricesIncludeVat,
          notes: quote.notes,
          ...prepared.totals,
          createdBy: userOf(req).id,
        })
        .returning()
      await tx.insert(salesLines).values(lineValues(ws.id, { orderId: o!.id }, prepared))
      await audit(tx, req, { action: 'so.drafted', entity: 'sales_order', entityId: o!.id, summary: `Drafted a sales order from quote ${quote.number} (${formatPeso(prepared.totals.total)})` })
      return o!.id
    })
    return reply.code(201).send({ salesOrder: await orderDetail(db, ws.id, orderId) })
  })

  /* ---------- sales orders ---------- */

  app.get('/sales-orders', view, async (req) => {
    const q = parse(z.object({ status: z.enum(SO_STATUSES).optional(), customerId: z.uuid().optional() }), req.query)
    return { salesOrders: await orderSummaries(db, workspaceOf(req).id, q) }
  })

  app.get('/sales-orders/:id', view, async (req) => ({ salesOrder: await orderDetail(db, workspaceOf(req).id, idOf(req.params, 'sales order')) }))

  app.post('/sales-orders', ordering, async (req, reply) => {
    const input = parse(SalesOrderInput, req.body)
    const ws = workspaceOf(req)
    const prepared = await prepareSales(db, ws, input)
    const warehouseId = await orderWarehouse(db, ws, input.warehouseId, prepared)
    const id = await db.transaction(async (tx) => {
      const [o] = await tx
        .insert(salesOrders)
        .values({
          workspaceId: ws.id,
          customerId: input.customerId,
          date: input.date,
          deliveryDate: input.deliveryDate ?? null,
          warehouseId,
          customerPoNo: input.customerPoNo ?? null,
          pricesIncludeVat: input.pricesIncludeVat,
          notes: input.notes ?? null,
          ...prepared.totals,
          createdBy: userOf(req).id,
        })
        .returning()
      await tx.insert(salesLines).values(lineValues(ws.id, { orderId: o!.id }, prepared))
      await audit(tx, req, { action: 'so.drafted', entity: 'sales_order', entityId: o!.id, summary: `Drafted a sales order for ${prepared.customer.name} (${formatPeso(prepared.totals.total)})` })
      return o!.id
    })
    return reply.code(201).send({ salesOrder: await orderDetail(db, ws.id, id) })
  })

  app.put('/sales-orders/:id', ordering, async (req) => {
    const id = idOf(req.params, 'sales order')
    const input = parse(SalesOrderInput, req.body)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const current = await lockOrder(tx, ws.id, id)
      if (current.status !== 'draft') throw new HttpError(409, 'locked', 'A confirmed sales order can’t be edited. Cancel it and make a new one.')
      const prepared = await prepareSales(tx, ws, input)
      const warehouseId = await orderWarehouse(tx, ws, input.warehouseId, prepared)
      await tx.delete(salesLines).where(eq(salesLines.orderId, id))
      await tx.insert(salesLines).values(lineValues(ws.id, { orderId: id }, prepared))
      await tx
        .update(salesOrders)
        .set({
          customerId: input.customerId,
          date: input.date,
          deliveryDate: input.deliveryDate ?? null,
          warehouseId,
          customerPoNo: input.customerPoNo ?? null,
          pricesIncludeVat: input.pricesIncludeVat,
          notes: input.notes ?? null,
          ...prepared.totals,
          updatedAt: new Date(),
        })
        .where(eq(salesOrders.id, id))
      await audit(tx, req, { action: 'so.edited', entity: 'sales_order', entityId: id, summary: `Edited a draft sales order for ${prepared.customer.name} (${formatPeso(prepared.totals.total)})` })
    })
    return { salesOrder: await orderDetail(db, ws.id, id) }
  })

  app.delete('/sales-orders/:id', ordering, async (req, reply) => {
    const id = idOf(req.params, 'sales order')
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const current = await lockOrder(tx, ws.id, id)
      if (current.status !== 'draft') throw new HttpError(409, 'locked', 'Only drafts can be deleted. Cancel a confirmed order instead.')
      await tx.delete(salesOrders).where(eq(salesOrders.id, id))
      await audit(tx, req, { action: 'so.deleted', entity: 'sales_order', entityId: id, summary: `Deleted a draft sales order (${formatPeso(current.total)})` })
    })
    return reply.code(204).send()
  })

  /**
   * Confirming gives it its number and commits to it. Refused when it would take the customer past
   * their credit limit, counting what they owe and what's on order but not invoiced yet.
   */
  app.post('/sales-orders/:id/confirm', ordering, async (req) => {
    const id = idOf(req.params, 'sales order')
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, ws.id, id)
      if (o.status !== 'draft') throw new HttpError(409, 'locked', 'That sales order has already been confirmed.')
      // lock the customer too, so two orders confirmed at once can't both squeeze under the limit
      const [customer] = await tx.select().from(contacts).where(eq(contacts.id, o.customerId)).for('update')
      if (o.warehouseId) await activeWarehouse(tx, ws.id, o.warehouseId)
      if (customer!.creditLimit !== null) {
        const exposure = (await exposureOf(tx, ws.id, customer!.id)).get(customer!.id) ?? { owed: 0, onOrder: 0 }
        const after = exposure.owed + exposure.onOrder + o.total
        if (after > customer!.creditLimit) {
          throw new HttpError(
            409,
            'over-credit-limit',
            `${customer!.name} would owe ${formatPeso(after)} with this order (${formatPeso(exposure.owed)} unpaid, ${formatPeso(exposure.onOrder)} on order), over their ${formatPeso(customer!.creditLimit)} credit limit. Collect first, or raise the limit.`,
          )
        }
      }
      const number = await nextNumber(tx, ws.id, 'sales_order')
      await tx.update(salesOrders).set({ status: 'confirmed', number, confirmedAt: new Date(), updatedAt: new Date() }).where(eq(salesOrders.id, id))
      await refreshSoStatus(tx, id)
      await audit(tx, req, { action: 'so.confirmed', entity: 'sales_order', entityId: id, summary: `Confirmed sales order ${number} for ${customer!.name} (${formatPeso(o.total)})` })
    })
    return { salesOrder: await orderDetail(db, ws.id, id) }
  })

  app.post('/sales-orders/:id/cancel', ordering, async (req) => {
    const id = idOf(req.params, 'sales order')
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, ws.id, id)
      if (o.status === 'draft') throw new HttpError(409, 'not-confirmed', 'A draft can be deleted instead.')
      if (o.status === 'cancelled') throw new HttpError(409, 'already', 'That sales order is already cancelled.')
      const [touched] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(salesLines)
        .where(and(eq(salesLines.orderId, id), sql`(${salesLines.deliveredQty} > 0 or ${salesLines.invoicedQty} > 0)`))
      if ((touched?.n ?? 0) > 0) throw new HttpError(409, 'in-progress', 'Goods have been delivered or invoiced on this order. Close it instead, to stop the rest.')
      await tx.update(salesOrders).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(salesOrders.id, id))
      await audit(tx, req, { action: 'so.cancelled', entity: 'sales_order', entityId: id, summary: `Cancelled sales order ${o.number}` })
    })
    return { salesOrder: await orderDetail(db, ws.id, id) }
  })

  /** Nothing more will go out: the rest of the order won't be delivered. */
  app.post('/sales-orders/:id/close', ordering, async (req) => {
    const id = idOf(req.params, 'sales order')
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, ws.id, id)
      if (!OPEN.includes(o.status)) throw new HttpError(409, 'locked', 'Only an open sales order can be closed.')
      await tx.update(salesOrders).set({ status: 'closed', closedByHand: true, updatedAt: new Date() }).where(eq(salesOrders.id, id))
      await audit(tx, req, { action: 'so.closed', entity: 'sales_order', entityId: id, summary: `Closed sales order ${o.number}` })
    })
    return { salesOrder: await orderDetail(db, ws.id, id) }
  })

  /** Goods went out: stock leaves at average cost (earliest expiry first), and the cost is booked. */
  app.post('/sales-orders/:id/deliver', delivering, async (req, reply) => {
    const id = idOf(req.params, 'sales order')
    const input = parse(DeliveryInput, req.body)
    const ws = workspaceOf(req)
    const stockBefore = new Map<string, number>()
    const docId = await db.transaction(async (tx) => {
      const o = await lockOrder(tx, ws.id, id)
      if (!['confirmed', 'partly_delivered'].includes(o.status)) {
        throw new HttpError(409, 'locked', o.status === 'draft' ? 'Confirm the sales order before delivering it.' : 'This sales order isn’t waiting for any more deliveries.')
      }
      const warehouse = await activeWarehouse(tx, ws.id, input.warehouseId)
      const [customer] = await tx.select({ name: contacts.name }).from(contacts).where(eq(contacts.id, o.customerId))
      const number = await nextNumber(tx, ws.id, 'delivery')
      const [doc] = await tx
        .insert(stockDocuments)
        .values({ workspaceId: ws.id, kind: 'delivery', number, date: input.date, warehouseId: warehouse.id, soId: o.id, notes: input.notes ?? null, createdBy: userOf(req).id })
        .returning()
      let cost = 0
      for (const [i, line] of input.lines.entries()) {
        const label = `Line ${i + 1}`
        const [sl] = await tx.select().from(salesLines).where(and(eq(salesLines.id, line.soLineId), eq(salesLines.orderId, o.id))).for('update')
        if (!sl) throw new HttpError(400, 'invalid', `${label} isn’t on this sales order.`, 'lines')
        const item: ItemRow = await lockStockItem(tx, ws.id, sl.itemId)
        const open = q4(sl.quantity - sl.deliveredQty)
        if (line.quantity > open) throw new HttpError(400, 'invalid', `${label}: only ${open} of ${item.name} is left to deliver.`, 'lines')
        stockBefore.set(item.id, stockBefore.get(item.id) ?? (await itemTotals(tx, item.id)).qty)
        cost += await stockOut(tx, ws, { item, warehouseId: warehouse.id, quantity: line.quantity, lotNo: line.lotNo, kind: 'issue', date: input.date, documentId: doc!.id, soLineId: sl.id, line: label })
        await tx.update(salesLines).set({ deliveredQty: q4(sl.deliveredQty + line.quantity) }).where(eq(salesLines.id, sl.id))
      }
      if (cost > 0) {
        const entry = await postEntry(
          tx,
          { workspaceId: ws.id, date: input.date, memo: `Delivery ${number} on ${o.number} — ${customer!.name}`, source: 'delivery', sourceId: doc!.id, createdBy: userOf(req).id },
          [
            { accountId: await systemAccount(tx, ws.id, 'cogs'), debit: cost, contactId: o.customerId },
            { accountId: await systemAccount(tx, ws.id, 'inventory'), credit: cost },
          ],
        )
        await tx.update(stockDocuments).set({ journalEntryId: entry.id }).where(eq(stockDocuments.id, doc!.id))
      }
      await refreshSoStatus(tx, o.id)
      await audit(tx, req, { action: 'so.delivered', entity: 'stock_document', entityId: doc!.id, summary: `Delivered ${number} on ${o.number} to ${customer!.name} from ${warehouse.name}` })
      return doc!.id
    })
    await warnLow(ws, stockBefore)
    return reply.code(201).send({ delivery: await deliveryDetail(db, ws.id, docId), salesOrder: await orderDetail(db, ws.id, id) })
  })

  /**
   * A draft invoice for what's been delivered but not invoiced yet (and any services ordered). Its
   * lines point back at the order lines, so posting it doesn't take the stock out a second time.
   */
  app.post('/sales-orders/:id/invoice', needs('finance.edit', 'crm'), async (req, reply) => {
    const id = idOf(req.params, 'sales order')
    const input = parse(InvoiceFromOrderInput, req.body ?? {})
    const ws = workspaceOf(req)
    const invoiceId = await db.transaction(async (tx) => {
      const o = await lockOrder(tx, ws.id, id)
      if (!OPEN.includes(o.status) && o.status !== 'closed') throw new HttpError(409, 'locked', 'Only a confirmed sales order can be invoiced.')
      const lines = await tx.select({ l: salesLines, item: items }).from(salesLines).innerJoin(items, eq(items.id, salesLines.itemId)).where(eq(salesLines.orderId, id)).orderBy(asc(salesLines.position))
      // what's already on a draft invoice counts as invoiced, so two drafts can't bill the same goods
      const drafted = await tx
        .select({ soLineId: documentLines.soLineId, qty: sql<number>`sum(${documentLines.quantity})`.mapWith(Number) })
        .from(documentLines)
        .innerJoin(salesInvoices, eq(salesInvoices.id, documentLines.invoiceId))
        .where(and(eq(salesInvoices.status, 'draft'), inArray(documentLines.soLineId, lines.map((r) => r.l.id))))
        .groupBy(documentLines.soLineId)
      const onDrafts = new Map(drafted.map((d) => [d.soLineId, d.qty]))
      const billable = lines
        .map((r) => ({ ...r, qty: q4((r.item.kind === 'stock' ? r.l.deliveredQty : r.l.quantity) - r.l.invoicedQty - (onDrafts.get(r.l.id) ?? 0)) }))
        .filter((r) => r.qty > 0)
      if (!billable.length) {
        const undelivered = lines.some((r) => r.item.kind === 'stock' && r.l.deliveredQty < r.l.quantity)
        throw new HttpError(409, 'nothing-to-invoice', undelivered ? 'Nothing delivered is waiting to be invoiced. Deliver the goods first.' : 'Everything on this order has been invoiced (or is on a draft invoice already).')
      }
      const sales = await systemAccount(tx, ws.id, 'sales')
      const [customer] = await tx.select().from(contacts).where(eq(contacts.id, o.customerId))
      const date = input.date ?? todayInManila()
      const ref = [`For ${o.number}`, o.customerPoNo ? `your PO ${o.customerPoNo}` : null].filter(Boolean).join(', ')
      const [inv] = await tx
        .insert(salesInvoices)
        .values({
          workspaceId: ws.id,
          customerId: o.customerId,
          warehouseId: o.warehouseId,
          date,
          dueDate: customer!.paymentTermsDays !== null ? addDays(date, customer!.paymentTermsDays) : null,
          pricesIncludeVat: o.pricesIncludeVat,
          notes: ref,
          createdBy: userOf(req).id,
        })
        .returning()
      const values = billable.map((r, position) => {
        const amounts = computeLine({ quantity: r.qty, unitPrice: r.l.unitPrice, vat: r.l.vat, vatRateBp: r.l.vatRateBp }, o.pricesIncludeVat)
        return {
          workspaceId: ws.id,
          invoiceId: inv!.id,
          position,
          description: r.l.description,
          quantity: r.qty,
          unitPrice: r.l.unitPrice,
          vat: r.l.vat,
          vatRateBp: r.l.vatRateBp,
          accountId: r.item.salesAccountId ?? sales,
          itemId: r.item.id,
          soLineId: r.l.id,
          ...amounts,
        }
      })
      await tx.insert(documentLines).values(values)
      await tx.update(salesInvoices).set(computeTotals(values)).where(eq(salesInvoices.id, inv!.id))
      await audit(tx, req, { action: 'invoice.drafted', entity: 'invoice', entityId: inv!.id, summary: `Drafted an invoice from sales order ${o.number}` })
      return inv!.id
    })
    return reply.code(201).send({ invoiceId })
  })

  /* ---------- deliveries ---------- */

  app.get('/deliveries', view, async (req) => {
    const ws = workspaceOf(req)
    const rows = await db
      .select({ id: stockDocuments.id })
      .from(stockDocuments)
      .where(and(eq(stockDocuments.workspaceId, ws.id), eq(stockDocuments.kind, 'delivery')))
      .orderBy(desc(stockDocuments.date), desc(stockDocuments.number))
      .limit(200)
    const out: Delivery[] = []
    for (const r of rows) out.push(await deliveryDetail(db, ws.id, r.id))
    return { deliveries: out }
  })

  app.get('/deliveries/:id', view, async (req) => ({ delivery: await deliveryDetail(db, workspaceOf(req).id, idOf(req.params, 'delivery')) }))
}
