import {
  computeLine,
  computeTotals,
  formatPeso,
  PO_STATUSES,
  PurchaseOrderInput,
  q4,
  ReceiptInput,
  type PoStatus,
  type PurchaseOrder,
  type PurchaseOrderSummary,
} from '@erp/shared'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client.ts'
import { bills, contacts, documentLines, items, purchaseOrderLines, purchaseOrders, stockDocuments, taxCodes, units, warehouses, type WorkspaceRow } from '../../db/schema.ts'
import type { Executor, Tx } from '../../db/types.ts'
import { audit } from '../../lib/audit.ts'
import { HttpError, parse } from '../../lib/errors.ts'
import { userOf } from '../../lib/session.ts'
import { needs, workspaceOf } from '../../lib/workspace.ts'
import { totalsOf } from '../finance/documents.ts'
import { nextNumber, postEntry, systemAccount, taxRateOn, todayInManila, VAT_CODE } from '../finance/ledger.ts'
import { stockDocumentDetail } from './routes.ts'
import { activeWarehouse, lockStockItem, lotForReceipt, stockIn } from './stock.ts'

/**
 * Purchase orders (PO-), receiving them (GR-), and billing them.
 *
 * Receiving puts stock in at the PO's cost: Dr Inventory / Cr Goods Received Not Invoiced. The
 * supplier's bill then clears GRNI (finance/document-routes.ts); a price different from the PO's
 * goes to Purchase Price Variance. So the stock is on the books from the day it arrives, and the
 * debt from the day the bill does.
 */

const view = needs('inventory.view', 'inventory')
const purchasing = needs('purchasing.manage', 'inventory')
const receiving = needs('inventory.manage', 'inventory')

const IdParam = z.object({ id: z.uuid() })
const notFound = () => new HttpError(404, 'not-found', 'That purchase order doesn’t exist.')
const idOf = (params: unknown) => {
  const r = IdParam.safeParse(params)
  if (!r.success) throw notFound()
  return r.data.id
}

type PoRow = typeof purchaseOrders.$inferSelect
type PoLineRow = typeof purchaseOrderLines.$inferSelect

/**
 * The cost per unit stock is carried at: before VAT for a VAT-registered business (it claims the
 * VAT back), including VAT for a non-VAT one (for whom it's part of the cost).
 */
export const unitBasis = (ws: WorkspaceRow, line: Pick<PoLineRow, 'net' | 'gross' | 'quantity'>) => (ws.vatStatus === 'vat' ? line.net : line.gross) / line.quantity

/** Draft lines checked against the workspace and priced with the rates in force on the PO's date. */
export async function preparePo(db: Executor, ws: WorkspaceRow, input: z.output<typeof PurchaseOrderInput>) {
  const [supplier] = await db.select().from(contacts).where(and(eq(contacts.id, input.supplierId), eq(contacts.workspaceId, ws.id)))
  if (!supplier?.isSupplier) throw new HttpError(400, 'invalid', 'Choose a supplier.', 'supplierId')
  await activeWarehouse(db, ws.id, input.warehouseId)
  const itemRows = await db.select().from(items).where(and(eq(items.workspaceId, ws.id), inArray(items.id, [...new Set(input.lines.map((l) => l.itemId))])))
  const byId = new Map(itemRows.map((i) => [i.id, i]))
  const vatRateBp = input.lines.some((l) => l.vat === 'vatable') ? (await taxRateOn(db, ws.id, VAT_CODE, input.date)).rateBp : 0
  const lines = []
  for (const [i, l] of input.lines.entries()) {
    const item = byId.get(l.itemId)
    if (!item) throw new HttpError(400, 'invalid', `Line ${i + 1}: choose an item.`, 'lines')
    if (!item.active) throw new HttpError(400, 'invalid', `Line ${i + 1}: ${item.name} is turned off.`, 'lines')
    let ewtRateBp: number | null = null
    if (l.ewtCodeId) {
      const [code] = await db.select().from(taxCodes).where(and(eq(taxCodes.id, l.ewtCodeId), eq(taxCodes.workspaceId, ws.id)))
      if (code?.kind !== 'ewt') throw new HttpError(400, 'invalid', `Line ${i + 1}: choose a withholding tax code.`, 'lines')
      ewtRateBp = (await taxRateOn(db, ws.id, code.code, input.date)).rateBp
    }
    const amounts = computeLine({ quantity: l.quantity, unitPrice: l.unitCost, vat: l.vat, vatRateBp, ewtRateBp }, input.pricesIncludeVat)
    lines.push({
      position: i,
      itemId: item.id,
      description: l.description ?? item.name,
      quantity: l.quantity,
      unitCost: l.unitCost,
      vat: l.vat,
      vatRateBp: l.vat === 'vatable' ? vatRateBp : 0,
      ewtCodeId: l.ewtCodeId ?? null,
      ewtRateBp,
      ...amounts,
    })
  }
  return { supplier, lines, totals: computeTotals(lines) }
}

/** Where a PO stands, from what has arrived and been billed. Services count as arrived. */
export async function refreshPoStatus(tx: Tx, poId: string) {
  const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).for('update')
  if (!po || po.status === 'draft' || po.status === 'cancelled') return
  const lines = await tx.select({ l: purchaseOrderLines, kind: items.kind }).from(purchaseOrderLines).innerJoin(items, eq(items.id, purchaseOrderLines.itemId)).where(eq(purchaseOrderLines.poId, poId))
  const received = (r: (typeof lines)[number]) => (r.kind === 'service' ? r.l.quantity : r.l.receivedQty)
  const allReceived = lines.every((r) => received(r) >= r.l.quantity)
  const anyReceived = lines.some((r) => r.kind === 'stock' && r.l.receivedQty > 0)
  const allBilled = lines.every((r) => r.l.billedQty >= r.l.quantity)
  const status: PoStatus = allReceived && allBilled ? 'closed' : allReceived ? 'received' : anyReceived ? 'partly_received' : 'issued'
  // closed by hand stays closed; closed because it was all done reopens if a bill is voided
  if (!po.closedByHand && status !== po.status) await tx.update(purchaseOrders).set({ status, updatedAt: new Date() }).where(eq(purchaseOrders.id, poId))
}

async function poDetail(db: Executor, workspaceId: string, id: string): Promise<PurchaseOrder> {
  const [row] = await db
    .select({ po: purchaseOrders, supplier: { id: contacts.id, name: contacts.name }, warehouse: { id: warehouses.id, name: warehouses.name } })
    .from(purchaseOrders)
    .innerJoin(contacts, eq(contacts.id, purchaseOrders.supplierId))
    .innerJoin(warehouses, eq(warehouses.id, purchaseOrders.warehouseId))
    .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.workspaceId, workspaceId)))
  if (!row) throw notFound()
  const lines = await db
    .select({ l: purchaseOrderLines, item: items, unit: units.code })
    .from(purchaseOrderLines)
    .innerJoin(items, eq(items.id, purchaseOrderLines.itemId))
    .innerJoin(units, eq(units.id, items.unitId))
    .where(eq(purchaseOrderLines.poId, id))
    .orderBy(asc(purchaseOrderLines.position))
  const receipts = await db
    .select({ d: stockDocuments, value: sql<number>`(select coalesce(sum(value), 0)::bigint from stock_moves where document_id = ${stockDocuments.id})`.mapWith(Number) })
    .from(stockDocuments)
    .where(eq(stockDocuments.poId, id))
    .orderBy(asc(stockDocuments.createdAt))
  const lineIds = lines.map((l) => l.l.id)
  const billRows = lineIds.length
    ? await db
        .selectDistinct({ id: bills.id, number: bills.number, status: bills.status, total: bills.total })
        .from(bills)
        .innerJoin(documentLines, eq(documentLines.billId, bills.id))
        .where(inArray(documentLines.poLineId, lineIds))
    : []
  return {
    ...summaryOut(row.po, row.supplier, row.warehouse),
    pricesIncludeVat: row.po.pricesIncludeVat,
    notes: row.po.notes,
    lines: lines.map(({ l, item, unit }) => ({
      id: l.id,
      item: { id: item.id, sku: item.sku, name: item.name, kind: item.kind, trackLots: item.trackLots, trackExpiry: item.trackExpiry, unit },
      description: l.description,
      quantity: l.quantity,
      unitCost: l.unitCost,
      vat: l.vat,
      ewtCodeId: l.ewtCodeId,
      receivedQty: l.receivedQty,
      billedQty: l.billedQty,
      gross: l.gross,
      net: l.net,
      vatAmount: l.vatAmount,
      ewtAmount: l.ewtAmount,
    })),
    receipts: receipts.map((r) => ({ id: r.d.id, number: r.d.number, date: r.d.date, status: r.d.status, value: r.value })),
    bills: billRows,
  }
}

const summaryOut = (po: PoRow, supplier: { id: string; name: string }, warehouse: { id: string; name: string }): PurchaseOrderSummary => ({
  id: po.id,
  number: po.number,
  status: po.status,
  date: po.date,
  expectedDate: po.expectedDate,
  supplier,
  warehouse,
  ...totalsOf(po),
})

async function lockPo(tx: Tx, workspaceId: string, id: string) {
  const [po] = await tx.select().from(purchaseOrders).where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.workspaceId, workspaceId))).for('update')
  if (!po) throw notFound()
  return po
}

export default async function purchasingRoutes(app: FastifyInstance) {
  app.get('/purchase-orders', view, async (req) => {
    const q = parse(z.object({ status: z.enum(PO_STATUSES).optional() }), req.query)
    const ws = workspaceOf(req)
    const rows = await db
      .select({ po: purchaseOrders, supplier: { id: contacts.id, name: contacts.name }, warehouse: { id: warehouses.id, name: warehouses.name } })
      .from(purchaseOrders)
      .innerJoin(contacts, eq(contacts.id, purchaseOrders.supplierId))
      .innerJoin(warehouses, eq(warehouses.id, purchaseOrders.warehouseId))
      .where(and(eq(purchaseOrders.workspaceId, ws.id), q.status ? eq(purchaseOrders.status, q.status) : undefined))
      .orderBy(desc(purchaseOrders.date), desc(purchaseOrders.createdAt))
      .limit(500)
    return { purchaseOrders: rows.map((r) => summaryOut(r.po, r.supplier, r.warehouse)) }
  })

  app.get('/purchase-orders/:id', view, async (req) => ({ purchaseOrder: await poDetail(db, workspaceOf(req).id, idOf(req.params)) }))

  app.post('/purchase-orders', purchasing, async (req, reply) => {
    const input = parse(PurchaseOrderInput, req.body)
    const ws = workspaceOf(req)
    const prepared = await preparePo(db, ws, input)
    const id = await db.transaction(async (tx) => {
      const [po] = await tx
        .insert(purchaseOrders)
        .values({
          workspaceId: ws.id,
          supplierId: input.supplierId,
          date: input.date,
          expectedDate: input.expectedDate ?? null,
          warehouseId: input.warehouseId,
          pricesIncludeVat: input.pricesIncludeVat,
          notes: input.notes ?? null,
          ...prepared.totals,
          createdBy: userOf(req).id,
        })
        .returning()
      await tx.insert(purchaseOrderLines).values(prepared.lines.map((l) => ({ ...l, workspaceId: ws.id, poId: po!.id })))
      await audit(tx, req, { action: 'po.drafted', entity: 'purchase_order', entityId: po!.id, summary: `Drafted a purchase order to ${prepared.supplier.name} (${formatPeso(prepared.totals.total)})` })
      return po!.id
    })
    return reply.code(201).send({ purchaseOrder: await poDetail(db, ws.id, id) })
  })

  app.put('/purchase-orders/:id', purchasing, async (req) => {
    const id = idOf(req.params)
    const input = parse(PurchaseOrderInput, req.body)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const po = await lockPo(tx, ws.id, id)
      if (po.status !== 'draft') throw new HttpError(409, 'locked', 'An issued purchase order can’t be edited. Cancel it and make a new one.')
      const prepared = await preparePo(tx, ws, input)
      await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.poId, id))
      await tx.insert(purchaseOrderLines).values(prepared.lines.map((l) => ({ ...l, workspaceId: ws.id, poId: id })))
      await tx
        .update(purchaseOrders)
        .set({ supplierId: input.supplierId, date: input.date, expectedDate: input.expectedDate ?? null, warehouseId: input.warehouseId, pricesIncludeVat: input.pricesIncludeVat, notes: input.notes ?? null, ...prepared.totals, updatedAt: new Date() })
        .where(eq(purchaseOrders.id, id))
      await audit(tx, req, { action: 'po.edited', entity: 'purchase_order', entityId: id, summary: `Edited a draft purchase order to ${prepared.supplier.name} (${formatPeso(prepared.totals.total)})` })
    })
    return { purchaseOrder: await poDetail(db, ws.id, id) }
  })

  app.delete('/purchase-orders/:id', purchasing, async (req, reply) => {
    const id = idOf(req.params)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const po = await lockPo(tx, ws.id, id)
      if (po.status !== 'draft') throw new HttpError(409, 'locked', 'Only drafts can be deleted. Cancel an issued purchase order instead.')
      await tx.delete(purchaseOrders).where(eq(purchaseOrders.id, id))
      await audit(tx, req, { action: 'po.deleted', entity: 'purchase_order', entityId: id, summary: `Deleted a draft purchase order (${formatPeso(po.total)})` })
    })
    return reply.code(204).send()
  })

  /** Issuing gives it its number; from then on it can be received and billed, not edited. */
  app.post('/purchase-orders/:id/issue', purchasing, async (req) => {
    const id = idOf(req.params)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const po = await lockPo(tx, ws.id, id)
      if (po.status !== 'draft') throw new HttpError(409, 'locked', 'That purchase order has already been issued.')
      const number = await nextNumber(tx, ws.id, 'purchase_order')
      await tx.update(purchaseOrders).set({ status: 'issued', number, issuedAt: new Date(), updatedAt: new Date() }).where(eq(purchaseOrders.id, id))
      await audit(tx, req, { action: 'po.issued', entity: 'purchase_order', entityId: id, summary: `Issued purchase order ${number} (${formatPeso(po.total)})` })
    })
    return { purchaseOrder: await poDetail(db, ws.id, id) }
  })

  app.post('/purchase-orders/:id/cancel', purchasing, async (req) => {
    const id = idOf(req.params)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const po = await lockPo(tx, ws.id, id)
      if (po.status === 'draft') throw new HttpError(409, 'not-issued', 'A draft can be deleted instead.')
      if (po.status === 'cancelled') throw new HttpError(409, 'already', 'That purchase order is already cancelled.')
      const [touched] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(purchaseOrderLines)
        .where(and(eq(purchaseOrderLines.poId, id), sql`(${purchaseOrderLines.receivedQty} > 0 or ${purchaseOrderLines.billedQty} > 0)`))
      if ((touched?.n ?? 0) > 0) throw new HttpError(409, 'in-progress', 'Goods have been received or billed on this order. Close it instead, to stop the rest.')
      await tx.update(purchaseOrders).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(purchaseOrders.id, id))
      await audit(tx, req, { action: 'po.cancelled', entity: 'purchase_order', entityId: id, summary: `Cancelled purchase order ${po.number}` })
    })
    return { purchaseOrder: await poDetail(db, ws.id, id) }
  })

  /** Nothing more is expected: the rest of the order won't come. */
  app.post('/purchase-orders/:id/close', purchasing, async (req) => {
    const id = idOf(req.params)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const po = await lockPo(tx, ws.id, id)
      if (!['issued', 'partly_received', 'received'].includes(po.status)) throw new HttpError(409, 'locked', 'Only an open purchase order can be closed.')
      await tx.update(purchaseOrders).set({ status: 'closed', closedByHand: true, updatedAt: new Date() }).where(eq(purchaseOrders.id, id))
      await audit(tx, req, { action: 'po.closed', entity: 'purchase_order', entityId: id, summary: `Closed purchase order ${po.number}` })
    })
    return { purchaseOrder: await poDetail(db, ws.id, id) }
  })

  /** Goods arrived: stock in at the PO's cost, and the GRNI entry. */
  app.post('/purchase-orders/:id/receive', receiving, async (req, reply) => {
    const id = idOf(req.params)
    const input = parse(ReceiptInput, req.body)
    const ws = workspaceOf(req)
    const docId = await db.transaction(async (tx) => {
      const po = await lockPo(tx, ws.id, id)
      if (!['issued', 'partly_received'].includes(po.status)) throw new HttpError(409, 'locked', po.status === 'draft' ? 'Issue the purchase order before receiving against it.' : 'This purchase order isn’t expecting any more goods.')
      const warehouse = await activeWarehouse(tx, ws.id, input.warehouseId)
      const number = await nextNumber(tx, ws.id, 'goods_receipt')
      const [doc] = await tx
        .insert(stockDocuments)
        .values({ workspaceId: ws.id, kind: 'receipt', number, date: input.date, warehouseId: warehouse.id, poId: po.id, notes: input.notes ?? null, createdBy: userOf(req).id })
        .returning()
      let total = 0
      for (const [i, line] of input.lines.entries()) {
        const label = `Line ${i + 1}`
        const [pl] = await tx.select().from(purchaseOrderLines).where(and(eq(purchaseOrderLines.id, line.poLineId), eq(purchaseOrderLines.poId, po.id))).for('update')
        if (!pl) throw new HttpError(400, 'invalid', `${label} isn’t on this purchase order.`, 'lines')
        const item = await lockStockItem(tx, ws.id, pl.itemId)
        const open = q4(pl.quantity - pl.receivedQty)
        if (line.quantity > open) throw new HttpError(400, 'invalid', `${label}: only ${open} of ${item.name} is still expected.`, 'lines')
        const lot = await lotForReceipt(tx, ws, item, line.lotNo, line.expiryDate, label, { hold: true })
        const value = Math.round(line.quantity * unitBasis(ws, pl))
        await stockIn(tx, ws, { item, warehouseId: warehouse.id, lotId: lot?.id ?? null, quantity: line.quantity, value, kind: 'receipt', date: input.date, documentId: doc!.id, poLineId: pl.id })
        await tx.update(purchaseOrderLines).set({ receivedQty: q4(pl.receivedQty + line.quantity) }).where(eq(purchaseOrderLines.id, pl.id))
        total += value
      }
      if (total > 0) {
        const entry = await postEntry(
          tx,
          { workspaceId: ws.id, date: input.date, memo: `Goods received ${number} on ${po.number}`, source: 'goods_receipt', sourceId: doc!.id, createdBy: userOf(req).id },
          [
            { accountId: await systemAccount(tx, ws.id, 'inventory'), debit: total },
            { accountId: await systemAccount(tx, ws.id, 'grni'), credit: total, contactId: po.supplierId },
          ],
        )
        await tx.update(stockDocuments).set({ journalEntryId: entry.id }).where(eq(stockDocuments.id, doc!.id))
      }
      await refreshPoStatus(tx, po.id)
      await audit(tx, req, { action: 'po.received', entity: 'stock_document', entityId: doc!.id, summary: `Received ${number} on ${po.number} into ${warehouse.name} (${formatPeso(total)})` })
      return doc!.id
    })
    return reply.code(201).send({ receipt: await stockDocumentDetail(db, ws.id, docId), purchaseOrder: await poDetail(db, ws.id, id) })
  })

  /**
   * A draft bill for what's been received but not billed yet (and any services ordered). Its
   * lines point back at the PO lines, so posting it clears GRNI (finance/document-routes.ts).
   */
  app.post('/purchase-orders/:id/bill', needs('finance.edit', 'inventory'), async (req, reply) => {
    const id = idOf(req.params)
    const ws = workspaceOf(req)
    const billId = await db.transaction(async (tx) => {
      const po = await lockPo(tx, ws.id, id)
      if (!['issued', 'partly_received', 'received'].includes(po.status)) throw new HttpError(409, 'locked', 'Only an open purchase order can be billed.')
      const lines = await tx.select({ l: purchaseOrderLines, item: items }).from(purchaseOrderLines).innerJoin(items, eq(items.id, purchaseOrderLines.itemId)).where(eq(purchaseOrderLines.poId, id)).orderBy(asc(purchaseOrderLines.position))
      // what's already on a draft bill counts as being billed, so two drafts can't bill the same goods
      const drafted = await tx
        .select({ poLineId: documentLines.poLineId, qty: sql<number>`sum(${documentLines.quantity})`.mapWith(Number) })
        .from(documentLines)
        .innerJoin(bills, eq(bills.id, documentLines.billId))
        .where(and(eq(bills.status, 'draft'), inArray(documentLines.poLineId, lines.map((r) => r.l.id))))
        .groupBy(documentLines.poLineId)
      const onDrafts = new Map(drafted.map((d) => [d.poLineId, d.qty]))
      const billable = lines
        .map((r) => ({ ...r, qty: q4((r.item.kind === 'stock' ? r.l.receivedQty : r.l.quantity) - r.l.billedQty - (onDrafts.get(r.l.id) ?? 0)) }))
        .filter((r) => r.qty > 0)
      if (!billable.length) throw new HttpError(409, 'nothing-to-bill', 'Everything received on this order has been billed (or is on a draft bill already).')
      const grni = await systemAccount(tx, ws.id, 'grni')
      const [bill] = await tx
        .insert(bills)
        .values({ workspaceId: ws.id, supplierId: po.supplierId, date: todayInManila(), pricesIncludeVat: po.pricesIncludeVat, notes: `For ${po.number}`, createdBy: userOf(req).id })
        .returning()
      await tx.insert(documentLines).values(
        billable.map((r, position) => {
          const amounts = computeLine({ quantity: r.qty, unitPrice: r.l.unitCost, vat: r.l.vat, vatRateBp: r.l.vatRateBp, ewtRateBp: r.l.ewtRateBp }, po.pricesIncludeVat)
          return {
            workspaceId: ws.id,
            billId: bill!.id,
            position,
            description: r.l.description,
            quantity: r.qty,
            unitPrice: r.l.unitCost,
            vat: r.l.vat,
            vatRateBp: r.l.vatRateBp,
            accountId: r.item.kind === 'stock' ? grni : (r.item.expenseAccountId ?? grni),
            ewtCodeId: r.l.ewtCodeId,
            ewtRateBp: r.l.ewtRateBp,
            itemId: r.item.id,
            poLineId: r.l.id,
            ...amounts,
          }
        }),
      )
      const stored = await tx.select().from(documentLines).where(eq(documentLines.billId, bill!.id))
      await tx.update(bills).set(computeTotals(stored)).where(eq(bills.id, bill!.id))
      await audit(tx, req, { action: 'bill.drafted', entity: 'bill', entityId: bill!.id, summary: `Drafted a bill from purchase order ${po.number}` })
      return bill!.id
    })
    return reply.code(201).send({ billId })
  })

  /** Receipts: what came in, from which PO. */
  app.get('/receipts', view, async (req) => {
    const ws = workspaceOf(req)
    const rows = await db.select({ id: stockDocuments.id }).from(stockDocuments).where(and(eq(stockDocuments.workspaceId, ws.id), eq(stockDocuments.kind, 'receipt'))).orderBy(desc(stockDocuments.date)).limit(200)
    return { receipts: await Promise.all(rows.map((r) => stockDocumentDetail(db, ws.id, r.id))) }
  })
}

