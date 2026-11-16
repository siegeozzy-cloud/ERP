import { hasFeature, q4, templateByKey, type MoveKind } from '@erp/shared'
import { and, asc, eq, sql } from 'drizzle-orm'
import { items, stockLots, stockMoves, units, warehouses, type WorkspaceRow } from '../../db/schema.ts'
import type { Executor, Tx } from '../../db/types.ts'
import { HttpError } from '../../lib/errors.ts'

/**
 * The stock engine. Everything that changes stock goes through `stockIn` and `stockOut`, inside
 * the transaction of the document that causes it, with the item locked first: two people selling
 * the last sack at once can't both succeed.
 *
 * Costing is moving average across all warehouses: value on hand ÷ quantity on hand. Stock going
 * out is valued at that average, so the inventory account always equals the stock valuation.
 */

export type ItemRow = typeof items.$inferSelect

const sumQty = sql<number>`coalesce(sum(${stockMoves.quantity}), 0)`.mapWith(Number)
const sumValue = sql<number>`coalesce(sum(${stockMoves.value}), 0)::bigint`.mapWith(Number)

/** The item, locked for the rest of the transaction. Must be a stock item of this workspace. */
export async function lockStockItem(tx: Tx, workspaceId: string, itemId: string) {
  const [item] = await tx.select().from(items).where(and(eq(items.id, itemId), eq(items.workspaceId, workspaceId))).for('update')
  if (!item) throw new HttpError(400, 'invalid', 'That item isn’t in this workspace.', 'itemId')
  if (item.kind !== 'stock') throw new HttpError(400, 'invalid', `${item.name} is a non-stock item, so it has no stock to move.`, 'itemId')
  return item
}

export async function activeWarehouse(db: Executor, workspaceId: string, id: string, field = 'warehouseId') {
  const [w] = await db.select().from(warehouses).where(and(eq(warehouses.id, id), eq(warehouses.workspaceId, workspaceId)))
  if (!w) throw new HttpError(400, 'invalid', 'Choose a warehouse in this workspace.', field)
  if (!w.active) throw new HttpError(400, 'invalid', `${w.name} is closed. Choose another warehouse.`, field)
  return w
}

/** Quantity and value on hand for an item, everywhere. */
export async function itemTotals(db: Executor, itemId: string) {
  const [row] = await db.select({ qty: sumQty, value: sumValue }).from(stockMoves).where(eq(stockMoves.itemId, itemId))
  return { qty: q4(row?.qty ?? 0), value: row?.value ?? 0 }
}

export const averageCost = (t: { qty: number; value: number }) => (t.qty > 0 ? t.value / t.qty : 0)

/** The unit name for messages: "8 sack". */
async function unitOf(db: Executor, item: ItemRow) {
  const [u] = await db.select({ code: units.code }).from(units).where(eq(units.id, item.unitId))
  return u?.code ?? ''
}

/**
 * The lot for stock coming in: found by number, or made. Expiry is required when the item tracks
 * it, and must match what's already recorded for that lot.
 */
export async function lotForReceipt(tx: Tx, ws: WorkspaceRow, item: ItemRow, lotNo: string | undefined, expiryDate: string | null | undefined, line: string, o: { hold?: boolean } = {}) {
  if (!item.trackLots) return null
  if (!lotNo) throw new HttpError(400, 'invalid', `${line}: ${item.name} is tracked by lot. Enter the lot number.`, 'lines')
  if (item.trackExpiry && !expiryDate) throw new HttpError(400, 'invalid', `${line}: enter the expiry date of lot ${lotNo}.`, 'lines')
  const [existing] = await tx.select().from(stockLots).where(and(eq(stockLots.itemId, item.id), eq(stockLots.lotNo, lotNo)))
  if (existing) {
    if (item.trackExpiry && existing.expiryDate !== expiryDate) {
      throw new HttpError(400, 'invalid', `${line}: lot ${lotNo} is already recorded as expiring ${existing.expiryDate}.`, 'lines')
    }
    return existing
  }
  // received or made in a template with quality release (Pharma): held until QC releases it
  const status = o.hold && hasFeature(ws.template, 'qcRelease') ? 'quarantine' : 'released'
  const [lot] = await tx.insert(stockLots).values({ workspaceId: ws.id, itemId: item.id, lotNo, expiryDate: item.trackExpiry ? (expiryDate ?? null) : null, status }).returning()
  return lot!
}

type Source = { documentId?: string | null; invoiceId?: string | null; poLineId?: string | null; soLineId?: string | null; workOrderId?: string | null; projectId?: string | null }

/** Stock coming in, at a value (centavos) the caller has worked out. */
export async function stockIn(
  tx: Tx,
  ws: WorkspaceRow,
  move: { item: ItemRow; warehouseId: string; lotId: string | null; quantity: number; value: number; kind: MoveKind; date: string } & Source,
) {
  await tx.insert(stockMoves).values({
    workspaceId: ws.id,
    itemId: move.item.id,
    warehouseId: move.warehouseId,
    lotId: move.lotId,
    date: move.date,
    kind: move.kind,
    quantity: q4(move.quantity),
    value: move.value,
    documentId: move.documentId ?? null,
    invoiceId: move.invoiceId ?? null,
    poLineId: move.poLineId ?? null,
    soLineId: move.soLineId ?? null,
    workOrderId: move.workOrderId ?? null,
    projectId: move.projectId ?? null,
  })
}

/**
 * Stock going out of a warehouse, valued at moving average cost. For a lot-tracked item without a
 * lot named, it takes the lots that expire first (FEFO), across as many as it needs. A sale or
 * delivery (`issue`) skips lots already past their expiry on the document's date, and refuses one
 * named. Refuses to take more than is there. Returns the value taken out (centavos, positive).
 */
export async function stockOut(
  tx: Tx,
  ws: WorkspaceRow,
  move: { item: ItemRow; warehouseId: string; quantity: number; lotNo?: string | null; kind: MoveKind; date: string; line: string } & Source,
) {
  const { item } = move
  let remaining = q4(move.quantity)

  // what can be taken, lot by lot (or as one pile when the item has no lots)
  const piles = await tx
    .select({ lotId: stockMoves.lotId, lotNo: stockLots.lotNo, expiry: stockLots.expiryDate, status: stockLots.status, qty: sumQty })
    .from(stockMoves)
    .leftJoin(stockLots, eq(stockLots.id, stockMoves.lotId))
    .where(and(eq(stockMoves.itemId, item.id), eq(stockMoves.warehouseId, move.warehouseId)))
    .groupBy(stockMoves.lotId, stockLots.lotNo, stockLots.expiryDate, stockLots.status)
    .having(sql`sum(${stockMoves.quantity}) > 0`)
    .orderBy(sql`${stockLots.expiryDate} asc nulls last`, asc(stockLots.lotNo))
  // goods going to a customer, or into a product, never come from a lot past its expiry date (it's written off instead)
  const selling = move.kind === 'issue' || move.kind === 'consume'
  if (move.kind === 'issue') checkSellable(ws, item, move.line)
  // a lot past its date, or still waiting for (or failed) quality control, isn't sold or used
  const expired = (p: (typeof piles)[number]) => (!!p.expiry && p.expiry < move.date) || (!!p.status && p.status !== 'released')
  const named = move.lotNo ? piles.filter((p) => p.lotNo === move.lotNo) : piles
  if (selling && move.lotNo && named.some(expired)) {
    const p = named[0]!
    if (p.status && p.status !== 'released') throw new HttpError(409, 'held-lot', `${move.line}: lot ${move.lotNo} of ${item.name} is ${p.status === 'quarantine' ? 'waiting for quality control' : 'rejected'}. It can’t be ${move.kind === 'consume' ? 'used' : 'sold'}.`, 'lines')
    throw new HttpError(409, 'expired-lot', `${move.line}: lot ${move.lotNo} of ${item.name} expired on ${p.expiry}. It can’t be ${move.kind === 'consume' ? 'used' : 'sold'}; write it off instead.`, 'lines')
  }
  const usable = selling ? named.filter((p) => !expired(p)) : named
  const available = q4(usable.reduce((s, p) => s + p.qty, 0))
  if (available < remaining) {
    const unit = await unitOf(tx, item)
    const where = move.lotNo ? `lot ${move.lotNo}` : 'that warehouse'
    const held = q4(named.filter((p) => p.status && p.status !== 'released').reduce((s, p) => s + p.qty, 0))
    const old = q4(named.filter((p) => expired(p) && !(p.status && p.status !== 'released')).reduce((s, p) => s + p.qty, 0))
    const notes = [old > 0 ? `${old} more ${unit} there ${old === 1 ? 'has' : 'have'} expired` : null, held > 0 ? `${held} ${unit} ${held === 1 ? 'is' : 'are'} waiting for quality control` : null].filter(Boolean)
    const note = selling && notes.length ? ` (${notes.join('; ')})` : ''
    throw new HttpError(409, 'not-enough-stock', `${move.line}: only ${available} ${unit} of ${item.name} in ${where}${note}, not ${remaining}.`, 'lines')
  }

  let taken = 0
  for (const pile of usable) {
    if (remaining <= 0) break
    const qty = q4(Math.min(pile.qty, remaining))
    const totals = await itemTotals(tx, item.id)
    // the last of the item takes all its remaining value, so no centavos are ever left behind
    const value = qty >= totals.qty ? totals.value : Math.round(qty * averageCost(totals))
    await tx.insert(stockMoves).values({
      workspaceId: ws.id,
      itemId: item.id,
      warehouseId: move.warehouseId,
      lotId: pile.lotId,
      date: move.date,
      kind: move.kind,
      quantity: -qty,
      value: -value,
      documentId: move.documentId ?? null,
      invoiceId: move.invoiceId ?? null,
      poLineId: move.poLineId ?? null,
      soLineId: move.soLineId ?? null,
      workOrderId: move.workOrderId ?? null,
      projectId: move.projectId ?? null,
    })
    taken += value
    remaining = q4(remaining - qty)
  }
  return taken
}

/**
 * Fields the template needs before an item can go to a customer (Pharma: its FDA registration
 * number). Checked when goods leave on a sale or delivery.
 */
export function checkSellable(ws: WorkspaceRow, item: ItemRow, line: string) {
  const missing = (templateByKey(ws.template)?.itemFields ?? []).filter((f) => f.requiredForSale && !item.attributes?.[f.key])
  if (missing.length) {
    throw new HttpError(409, 'missing-for-sale', `${line}: ${item.name} can’t be sold without its ${missing.map((f) => f.label.replace(/ no\.$/, ' number')).join(' and ')}. Add it to the item first.`, 'lines')
  }
}

/** Items now at or below their reorder point that weren't before: for the "running low" notice. */
export async function newlyLow(db: Executor, before: Map<string, number>) {
  const low: { item: ItemRow; onHand: number; unit: string }[] = []
  for (const [itemId, was] of before) {
    const [item] = await db.select().from(items).where(eq(items.id, itemId))
    if (!item || item.reorderPoint <= 0) continue
    const now = (await itemTotals(db, itemId)).qty
    if (was > item.reorderPoint && now <= item.reorderPoint) low.push({ item, onHand: now, unit: await unitOf(db, item) })
  }
  return low
}
