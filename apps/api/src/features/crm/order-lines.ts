import { q4, type SoStatus } from '@erp/shared'
import { and, eq, isNotNull } from 'drizzle-orm'
import { documentLines, items, salesLines, salesOrders } from '../../db/schema.ts'
import type { Tx } from '../../db/types.ts'
import { HttpError } from '../../lib/errors.ts'
import type { PreparedLine } from '../finance/documents.ts'

/**
 * Where sales order lines stand, kept up to date by deliveries and by the invoices made from the
 * order. Invoice posting and voiding (finance/document-routes.ts) call these, inside their own
 * transaction, the way bills call back into purchase orders.
 */

/** Where an order stands, from what has gone out and been invoiced. Services count as delivered. */
export async function refreshSoStatus(tx: Tx, orderId: string) {
  const [so] = await tx.select().from(salesOrders).where(eq(salesOrders.id, orderId)).for('update')
  if (!so || so.status === 'draft' || so.status === 'cancelled') return
  const lines = await tx.select({ l: salesLines, kind: items.kind }).from(salesLines).innerJoin(items, eq(items.id, salesLines.itemId)).where(eq(salesLines.orderId, orderId))
  const delivered = (r: (typeof lines)[number]) => (r.kind === 'service' ? r.l.quantity : r.l.deliveredQty)
  const allDelivered = lines.every((r) => delivered(r) >= r.l.quantity)
  const anyDelivered = lines.some((r) => r.kind === 'stock' && r.l.deliveredQty > 0)
  const allInvoiced = lines.every((r) => r.l.invoicedQty >= r.l.quantity)
  const status: SoStatus = allDelivered && allInvoiced ? 'closed' : allDelivered ? 'delivered' : anyDelivered ? 'partly_delivered' : 'confirmed'
  // closed by hand stays closed; closed because it was all done reopens if an invoice is voided
  if (!so.closedByHand && status !== so.status) await tx.update(salesOrders).set({ status, updatedAt: new Date() }).where(eq(salesOrders.id, orderId))
}

/**
 * Invoice lines billing sales order lines: no more than has been delivered (or ordered, for
 * services) and not invoiced yet. Records them as invoiced. Lines without an order pass through.
 */
export async function invoiceSoLines(tx: Tx, lines: PreparedLine[], itemsById: Map<string, typeof items.$inferSelect>) {
  const orders = new Set<string>()
  for (const [i, line] of lines.entries()) {
    if (!line.soLineId) continue
    const [sl] = await tx.select().from(salesLines).where(eq(salesLines.id, line.soLineId)).for('update')
    const [so] = await tx.select({ status: salesOrders.status, number: salesOrders.number }).from(salesOrders).where(eq(salesOrders.id, sl!.orderId!))
    if (so?.status === 'draft' || so?.status === 'cancelled') throw new HttpError(409, 'order-not-open', `Line ${i + 1}: ${so.number ? `sales order ${so.number}` : 'that sales order'} isn’t open.`, 'lines')
    const item = itemsById.get(line.itemId!)!
    const ceiling = item.kind === 'stock' ? sl!.deliveredQty : sl!.quantity
    const left = q4(ceiling - sl!.invoicedQty)
    if (line.quantity > left) {
      throw new HttpError(409, 'over-invoiced', `Line ${i + 1}: only ${left} of ${item.name} ${item.kind === 'stock' ? 'has been delivered and not invoiced' : 'is left to invoice'} on ${so?.number ?? 'that sales order'}.`, 'lines')
    }
    await tx.update(salesLines).set({ invoicedQty: q4(sl!.invoicedQty + line.quantity) }).where(eq(salesLines.id, sl!.id))
    orders.add(sl!.orderId!)
  }
  for (const o of orders) await refreshSoStatus(tx, o)
}

/** A voided invoice's order lines can be invoiced again. */
export async function uninvoiceSoLines(tx: Tx, invoiceId: string) {
  const lines = await tx.select().from(documentLines).where(and(eq(documentLines.invoiceId, invoiceId), isNotNull(documentLines.soLineId)))
  const orders = new Set<string>()
  for (const l of lines) {
    const [sl] = await tx.select().from(salesLines).where(eq(salesLines.id, l.soLineId!)).for('update')
    await tx.update(salesLines).set({ invoicedQty: q4(Math.max(0, sl!.invoicedQty - l.quantity)) }).where(eq(salesLines.id, sl!.id))
    orders.add(sl!.orderId!)
  }
  for (const o of orders) await refreshSoStatus(tx, o)
}
