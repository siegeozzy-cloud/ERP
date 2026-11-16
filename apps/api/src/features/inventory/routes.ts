import {
  checkAttributes,
  hasFeature,
  templateByKey,
  VariantsInput,
  type LotStatus,
  type QuarantineLot,
  ADJUSTMENT_REASON_LABELS,
  AdjustmentInput,
  formatPeso,
  ItemInput,
  q4,
  TransferInput,
  UnitInput,
  WarehouseInput,
  type InventoryOverview,
  type Item,
  type ItemDetail,
  type StockDocument,
  type StockLevel,
  type StockMove,
  type Unit,
  type ValuationRow,
  type Warehouse,
} from '@erp/shared'
import { and, asc, desc, eq, ilike, inArray, isNotNull, lte, ne, or, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db, isUniqueViolation } from '../../db/client.ts'
import { accounts, items, purchaseOrders, stockDocuments, stockLots, stockMoves, units, warehouses, workOrders, type WorkspaceRow } from '../../db/schema.ts'
import type { Executor, Tx } from '../../db/types.ts'
import { audit } from '../../lib/audit.ts'
import { HttpError, parse } from '../../lib/errors.ts'
import { membersWith, notifyLater, sendPush } from '../../lib/push.ts'
import { userOf } from '../../lib/session.ts'
import { needs, workspaceOf } from '../../lib/workspace.ts'
import { nextNumber, postEntry, systemAccount, systemAccountIfAny, todayInManila } from '../finance/ledger.ts'
import { activeWarehouse, averageCost, itemTotals, lockStockItem, lotForReceipt, newlyLow, stockIn, stockOut, type ItemRow } from './stock.ts'

const view = needs('inventory.view', 'inventory')
const manage = needs('inventory.manage', 'inventory')

const IdParam = z.object({ id: z.uuid() })
const idOf = (params: unknown, what: string) => {
  const r = IdParam.safeParse(params)
  if (!r.success) throw new HttpError(404, 'not-found', `That ${what} doesn’t exist.`)
  return r.data.id
}

const like = (q: string) => `%${q.replace(/[%_\\]/g, '\\$&')}%`

/* ---------------------------------------------------------------------------------------------
 * Shapes
 * ------------------------------------------------------------------------------------------- */

const warehouseOut = (w: typeof warehouses.$inferSelect): Warehouse => ({ id: w.id, code: w.code, name: w.name, address: w.address, active: w.active })

/** Quantity and value on hand per item, for many items at once. */
async function totalsFor(db: Executor, workspaceId: string, itemIds?: string[]) {
  const rows = await db
    .select({ itemId: stockMoves.itemId, qty: sql<number>`coalesce(sum(${stockMoves.quantity}), 0)`.mapWith(Number), value: sql<number>`coalesce(sum(${stockMoves.value}), 0)::bigint`.mapWith(Number) })
    .from(stockMoves)
    .where(and(eq(stockMoves.workspaceId, workspaceId), itemIds ? inArray(stockMoves.itemId, itemIds) : undefined))
    .groupBy(stockMoves.itemId)
  return new Map(rows.map((r) => [r.itemId, { qty: q4(r.qty), value: r.value }]))
}

function itemOut(row: ItemRow, unit: typeof units.$inferSelect, totals?: { qty: number; value: number }): Item {
  const t = totals ?? { qty: 0, value: 0 }
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    kind: row.kind,
    barcode: row.barcode,
    unit: { id: unit.id, code: unit.code, name: unit.name },
    salesPrice: row.salesPrice,
    purchaseCost: row.purchaseCost,
    salesVat: row.salesVat,
    trackLots: row.trackLots,
    trackExpiry: row.trackExpiry,
    reorderPoint: row.reorderPoint,
    reorderQty: row.reorderQty,
    salesAccountId: row.salesAccountId,
    expenseAccountId: row.expenseAccountId,
    active: row.active,
    onHand: t.qty,
    value: t.value,
    averageCost: averageCost(t),
    low: row.kind === 'stock' && row.reorderPoint > 0 && t.qty <= row.reorderPoint,
    attributes: row.attributes ?? {},
    parentId: row.parentId,
  }
}

async function itemDetail(db: Executor, workspaceId: string, id: string): Promise<ItemDetail> {
  const [row] = await db.select({ item: items, unit: units }).from(items).innerJoin(units, eq(units.id, items.unitId)).where(and(eq(items.id, id), eq(items.workspaceId, workspaceId)))
  if (!row) throw new HttpError(404, 'not-found', 'That item doesn’t exist.')
  const totals = await itemTotals(db, id)
  const levels = await db
    .select({
      warehouse: { id: warehouses.id, code: warehouses.code, name: warehouses.name },
      lotId: stockMoves.lotId,
      lotNo: stockLots.lotNo,
      expiryDate: stockLots.expiryDate,
      lotStatus: stockLots.status,
      quantity: sql<number>`sum(${stockMoves.quantity})`.mapWith(Number),
    })
    .from(stockMoves)
    .innerJoin(warehouses, eq(warehouses.id, stockMoves.warehouseId))
    .leftJoin(stockLots, eq(stockLots.id, stockMoves.lotId))
    .where(eq(stockMoves.itemId, id))
    .groupBy(warehouses.id, stockMoves.lotId, stockLots.lotNo, stockLots.expiryDate, stockLots.status)
    .having(sql`sum(${stockMoves.quantity}) <> 0`)
    .orderBy(asc(warehouses.code), sql`${stockLots.expiryDate} asc nulls last`)
  const moves = await db
    .select({ m: stockMoves, warehouse: { id: warehouses.id, code: warehouses.code, name: warehouses.name }, lotNo: stockLots.lotNo, expiryDate: stockLots.expiryDate, docNumber: stockDocuments.number, docKind: stockDocuments.kind, woNumber: workOrders.number })
    .from(stockMoves)
    .innerJoin(warehouses, eq(warehouses.id, stockMoves.warehouseId))
    .leftJoin(stockLots, eq(stockLots.id, stockMoves.lotId))
    .leftJoin(stockDocuments, eq(stockDocuments.id, stockMoves.documentId))
    .leftJoin(workOrders, eq(workOrders.id, stockMoves.workOrderId))
    .where(eq(stockMoves.itemId, id))
    .orderBy(desc(stockMoves.date), desc(stockMoves.createdAt))
    .limit(100)
  const invoiceNumbers = new Map(
    (
      await db.execute<{ id: string; number: string | null }>(
        sql`select id, number from sales_invoices where id in (select invoice_id from stock_moves where item_id = ${id} and invoice_id is not null)`,
      )
    ).rows.map((r) => [r.id, r.number]),
  )
  // apparel: the style's variants, or the style a variant belongs to
  const variantRows = await db.select({ item: items }).from(items).where(eq(items.parentId, id)).orderBy(asc(items.sku))
  const variantTotals = variantRows.length ? await totalsFor(db, workspaceId, variantRows.map((v) => v.item.id)) : new Map()
  const [parent] = row.item.parentId ? await db.select({ id: items.id, sku: items.sku, name: items.name }).from(items).where(eq(items.id, row.item.parentId)) : []
  return {
    ...itemOut(row.item, row.unit, totals),
    variants: variantRows.map((v) => ({ id: v.item.id, sku: v.item.sku, name: v.item.name, colour: v.item.attributes?.colour ?? '', size: v.item.attributes?.size ?? '', onHand: variantTotals.get(v.item.id)?.qty ?? 0 })),
    parent: parent ?? null,
    levels: levels.map(
      (l): StockLevel => ({ warehouse: l.warehouse, lot: l.lotId ? { id: l.lotId, lotNo: l.lotNo!, expiryDate: l.expiryDate, status: (l.lotStatus ?? 'released') as LotStatus } : null, quantity: q4(l.quantity) }),
    ),
    moves: moves.map(
      (r): StockMove => ({
        id: r.m.id,
        date: r.m.date,
        kind: r.m.kind,
        warehouse: r.warehouse,
        lot: r.lotNo ? { lotNo: r.lotNo, expiryDate: r.expiryDate } : null,
        quantity: r.m.quantity,
        value: r.m.value,
        reference: r.docNumber ?? r.woNumber ?? (r.m.invoiceId ? (invoiceNumbers.get(r.m.invoiceId) ?? null) : null),
        sourceType: r.m.invoiceId ? 'invoice' : r.m.workOrderId ? 'work_order' : r.docKind,
        sourceId: r.m.invoiceId ?? r.m.workOrderId ?? r.m.documentId,
      }),
    ),
  }
}

/** Checks the item's account overrides belong here and are the right kind. */
async function checkItemAccounts(db: Executor, workspaceId: string, input: z.output<typeof ItemInput>) {
  for (const [field, id, types] of [
    ['salesAccountId', input.salesAccountId, ['income']],
    ['expenseAccountId', input.expenseAccountId, ['expense', 'asset']],
  ] as const) {
    if (!id) continue
    const [a] = await db.select({ type: accounts.type }).from(accounts).where(and(eq(accounts.id, id), eq(accounts.workspaceId, workspaceId)))
    if (!a || !(types as readonly string[]).includes(a.type)) throw new HttpError(400, 'invalid', field === 'salesAccountId' ? 'Choose an income account.' : 'Choose an expense or asset account.', field)
  }
  const [u] = await db.select({ id: units.id }).from(units).where(and(eq(units.id, input.unitId), eq(units.workspaceId, workspaceId)))
  if (!u) throw new HttpError(400, 'invalid', 'Choose a unit.', 'unitId')
}

/* ---------------------------------------------------------------------------------------------
 * Stock documents: adjustments, transfers (receipts live with purchase orders)
 * ------------------------------------------------------------------------------------------- */

export async function stockDocumentDetail(db: Executor, workspaceId: string, id: string): Promise<StockDocument> {
  const [doc] = await stockDocumentsOf(db, workspaceId, eq(stockDocuments.id, id))
  if (!doc) throw new HttpError(404, 'not-found', 'That stock document doesn’t exist.')
  return doc
}

/**
 * Stock documents with their lines, in three queries however many there are (the documents, all
 * their moves, the warehouses), newest first.
 */
async function stockDocumentsOf(db: Executor, workspaceId: string, where?: ReturnType<typeof eq>, limit = 200): Promise<StockDocument[]> {
  const docs = await db
    .select()
    .from(stockDocuments)
    .where(and(eq(stockDocuments.workspaceId, workspaceId), where))
    .orderBy(desc(stockDocuments.date), desc(stockDocuments.number))
    .limit(limit)
  if (!docs.length) return []
  const whs = new Map((await db.select().from(warehouses).where(eq(warehouses.workspaceId, workspaceId))).map((w) => [w.id, w]))
  const moves = await db
    .select({ m: stockMoves, item: { id: items.id, sku: items.sku, name: items.name }, lotNo: stockLots.lotNo })
    .from(stockMoves)
    .innerJoin(items, eq(items.id, stockMoves.itemId))
    .leftJoin(stockLots, eq(stockLots.id, stockMoves.lotId))
    .where(inArray(stockMoves.documentId, docs.map((d) => d.id)))
    .orderBy(asc(stockMoves.createdAt))
  const byDoc = new Map<string, typeof moves>()
  for (const r of moves) byDoc.set(r.m.documentId!, [...(byDoc.get(r.m.documentId!) ?? []), r])
  return docs.map((doc) => {
    const all = byDoc.get(doc.id) ?? []
    // a transfer is two moves per line; show the line once, as it left
    const shown = doc.kind === 'transfer' ? all.filter((r) => r.m.warehouseId === doc.warehouseId) : all
    const w = whs.get(doc.warehouseId)!
    const to = doc.toWarehouseId ? whs.get(doc.toWarehouseId) : null
    return {
      id: doc.id,
      number: doc.number,
      kind: doc.kind,
      date: doc.date,
      reason: (doc.reason as StockDocument['reason']) ?? null,
      warehouse: { id: w.id, name: w.name },
      toWarehouse: to ? { id: to.id, name: to.name } : null,
      notes: doc.notes,
      value: shown.reduce((s, r) => s + r.m.value, 0),
      journalEntryId: doc.journalEntryId,
      lines: shown.map((r) => ({ item: r.item, quantity: doc.kind === 'transfer' ? -r.m.quantity : r.m.quantity, lotNo: r.lotNo, value: r.m.value })),
    }
  })
}

/** An item's extra fields, checked against the workspace template's (shared/templates.ts). */
function itemAttributes(ws: WorkspaceRow, values: Record<string, string>) {
  const checked = checkAttributes(templateByKey(ws.template)?.itemFields ?? [], values)
  if ('key' in checked) throw new HttpError(400, 'invalid', checked.message, `attributes.${checked.key}`)
  return checked.ok
}

/** Tells the people who manage stock about items that just dropped to their reorder point. */
export async function warnLow(ws: WorkspaceRow, before: Map<string, number>) {
  await notifyLater(async () => {
    const low = await newlyLow(db, before)
    if (!low.length) return
    const people = await membersWith(ws.id, 'inventory.manage')
    for (const l of low) {
      await sendPush(people, {
        title: `${ws.name}: running low`,
        body: `${l.item.name} is down to ${l.onHand} ${l.unit} (reorder at ${l.item.reorderPoint}).`,
        data: { workspaceId: ws.id, screen: 'home' },
      })
    }
  })
}

async function onHandNow(db: Executor, itemIds: string[]) {
  const map = new Map<string, number>()
  for (const id of new Set(itemIds)) map.set(id, (await itemTotals(db, id)).qty)
  return map
}

export async function postAdjustment(tx: Tx, req: FastifyRequest, ws: WorkspaceRow, input: z.output<typeof AdjustmentInput>) {
  const warehouse = await activeWarehouse(tx, ws.id, input.warehouseId)
  const number = await nextNumber(tx, ws.id, 'stock_adjustment')
  const [doc] = await tx
    .insert(stockDocuments)
    .values({ workspaceId: ws.id, kind: 'adjustment', number, date: input.date, warehouseId: warehouse.id, reason: input.reason, notes: input.notes ?? null, createdBy: userOf(req).id })
    .returning()

  let net = 0
  for (const [i, line] of input.lines.entries()) {
    const label = `Line ${i + 1}`
    const item = await lockStockItem(tx, ws.id, line.itemId)
    let change = line.change ?? 0
    if (line.counted !== undefined) {
      // a count: the difference between the shelf and the books, in this warehouse (and lot)
      const lot = line.lotNo ? (await tx.select().from(stockLots).where(and(eq(stockLots.itemId, item.id), eq(stockLots.lotNo, line.lotNo))))[0] : undefined
      const [here] = await tx
        .select({ qty: sql<number>`coalesce(sum(${stockMoves.quantity}), 0)`.mapWith(Number) })
        .from(stockMoves)
        .where(and(eq(stockMoves.itemId, item.id), eq(stockMoves.warehouseId, warehouse.id), line.lotNo ? eq(stockMoves.lotId, lot?.id ?? '00000000-0000-0000-0000-000000000000') : undefined))
      change = q4(line.counted - (here?.qty ?? 0))
    }
    if (change === 0) continue
    if (change > 0) {
      const lot = await lotForReceipt(tx, ws, item, line.lotNo, line.expiryDate, label)
      const totals = await itemTotals(tx, item.id)
      const unitCost = line.unitCost ?? (totals.qty > 0 ? averageCost(totals) : item.purchaseCost)
      const value = Math.round(change * unitCost)
      await stockIn(tx, ws, { item, warehouseId: warehouse.id, lotId: lot?.id ?? null, quantity: change, value, kind: 'adjustment', date: input.date, documentId: doc!.id })
      net += value
    } else {
      net -= await stockOut(tx, ws, { item, warehouseId: warehouse.id, quantity: -change, lotNo: line.lotNo, kind: 'adjustment', date: input.date, documentId: doc!.id, line: label })
    }
  }

  // the books follow: inventory up or down, against gains and losses (or opening equity)
  if (net !== 0) {
    const inventory = await systemAccount(tx, ws.id, 'inventory')
    // a template with a spoilage account (Food) keeps damaged and expired goods apart from count differences
    const spoiled = net < 0 && (input.reason === 'damage' || input.reason === 'expired' || input.reason === 'rejected') ? await systemAccountIfAny(tx, ws.id, 'spoilage') : null
    const other = spoiled ?? (await systemAccount(tx, ws.id, input.reason === 'opening' ? 'opening_equity' : 'inventory_adjustments'))
    const entry = await postEntry(
      tx,
      { workspaceId: ws.id, date: input.date, memo: `Stock adjustment ${number} — ${ADJUSTMENT_REASON_LABELS[input.reason]}`, source: 'stock_adjustment', sourceId: doc!.id, createdBy: userOf(req).id },
      net > 0 ? [{ accountId: inventory, debit: net }, { accountId: other, credit: net }] : [{ accountId: other, debit: -net }, { accountId: inventory, credit: -net }],
    )
    await tx.update(stockDocuments).set({ journalEntryId: entry.id }).where(eq(stockDocuments.id, doc!.id))
  }
  await audit(tx, req, {
    action: 'stock.adjusted',
    entity: 'stock_document',
    entityId: doc!.id,
    summary: `Stock adjustment ${number} in ${warehouse.name} (${ADJUSTMENT_REASON_LABELS[input.reason]}): ${net >= 0 ? '+' : '−'}${formatPeso(Math.abs(net))}`,
  })
  return doc!.id
}

/* ---------------------------------------------------------------------------------------------
 * Routes
 * ------------------------------------------------------------------------------------------- */

export default async function inventoryRoutes(app: FastifyInstance) {
  /* ---------- units ---------- */

  app.get('/units', view, async (req) => {
    const rows = await db.select().from(units).where(eq(units.workspaceId, workspaceOf(req).id)).orderBy(asc(units.name))
    return { units: rows.map((u): Unit => ({ id: u.id, code: u.code, name: u.name })) }
  })

  app.post('/units', manage, async (req, reply) => {
    const input = parse(UnitInput, req.body)
    try {
      const [u] = await db.insert(units).values({ ...input, workspaceId: workspaceOf(req).id }).returning()
      return reply.code(201).send({ unit: { id: u!.id, code: u!.code, name: u!.name } satisfies Unit })
    } catch (e) {
      if (isUniqueViolation(e, 'units_code_key')) throw new HttpError(409, 'taken', `There’s already a unit called ${input.code}.`, 'code')
      throw e
    }
  })

  /* ---------- warehouses ---------- */

  app.get('/warehouses', view, async (req) => {
    const rows = await db.select().from(warehouses).where(eq(warehouses.workspaceId, workspaceOf(req).id)).orderBy(asc(warehouses.code))
    return { warehouses: rows.map(warehouseOut) }
  })

  app.post('/warehouses', manage, async (req, reply) => {
    const input = parse(WarehouseInput, req.body)
    try {
      const row = await db.transaction(async (tx) => {
        const [w] = await tx.insert(warehouses).values({ ...input, address: input.address ?? null, workspaceId: workspaceOf(req).id }).returning()
        await audit(tx, req, { action: 'warehouse.created', entity: 'warehouse', entityId: w!.id, summary: `Added warehouse ${w!.code} ${w!.name}` })
        return w!
      })
      return reply.code(201).send({ warehouse: warehouseOut(row) })
    } catch (e) {
      if (isUniqueViolation(e, 'warehouses_code_key')) throw new HttpError(409, 'taken', `Warehouse code ${input.code} is already used.`, 'code')
      throw e
    }
  })

  app.put('/warehouses/:id', manage, async (req) => {
    const id = idOf(req.params, 'warehouse')
    const input = parse(WarehouseInput, req.body)
    const ws = workspaceOf(req)
    try {
      const row = await db.transaction(async (tx) => {
        const [before] = await tx.select().from(warehouses).where(and(eq(warehouses.id, id), eq(warehouses.workspaceId, ws.id)))
        if (!before) throw new HttpError(404, 'not-found', 'That warehouse doesn’t exist.')
        if (before.active && !input.active) {
          const [stock] = await tx
            .select({ qty: sql<number>`coalesce(sum(${stockMoves.quantity}), 0)`.mapWith(Number) })
            .from(stockMoves)
            .where(eq(stockMoves.warehouseId, id))
          if ((stock?.qty ?? 0) > 0) throw new HttpError(409, 'has-stock', `${before.name} still has stock. Move it out before closing the warehouse.`, 'active')
        }
        const [w] = await tx.update(warehouses).set({ ...input, address: input.address ?? null }).where(eq(warehouses.id, id)).returning()
        await audit(tx, req, { action: 'warehouse.updated', entity: 'warehouse', entityId: id, summary: `Edited warehouse ${w!.code} ${w!.name}`, before: warehouseOut(before), after: warehouseOut(w!) })
        return w!
      })
      return { warehouse: warehouseOut(row) }
    } catch (e) {
      if (isUniqueViolation(e, 'warehouses_code_key')) throw new HttpError(409, 'taken', `Warehouse code ${input.code} is already used.`, 'code')
      throw e
    }
  })

  /* ---------- items ---------- */

  app.get('/items', view, async (req) => {
    const q = parse(z.object({ q: z.string().trim().max(100).optional(), low: z.enum(['1']).optional(), kind: z.enum(['stock', 'service']).optional() }), req.query)
    const ws = workspaceOf(req)
    const rows = await db
      .select({ item: items, unit: units })
      .from(items)
      .innerJoin(units, eq(units.id, items.unitId))
      .where(
        and(
          eq(items.workspaceId, ws.id),
          q.kind ? eq(items.kind, q.kind) : undefined,
          q.q ? or(ilike(items.name, like(q.q)), ilike(items.sku, like(q.q)), eq(items.barcode, q.q)) : undefined,
        ),
      )
      .orderBy(asc(items.name))
      .limit(1000)
    const totals = await totalsFor(db, ws.id)
    const out = rows.map((r) => itemOut(r.item, r.unit, totals.get(r.item.id)))
    return { items: q.low ? out.filter((i) => i.low) : out }
  })

  app.get('/items/:id', view, async (req) => ({ item: await itemDetail(db, workspaceOf(req).id, idOf(req.params, 'item')) }))

  /** For the phone's scanner. */
  app.get('/items/barcode/:code', view, async (req) => {
    const { code } = parse(z.object({ code: z.string().min(1).max(48) }), req.params)
    const ws = workspaceOf(req)
    const [row] = await db.select({ id: items.id }).from(items).where(and(eq(items.workspaceId, ws.id), or(eq(items.barcode, code), eq(items.sku, code.toUpperCase()))))
    if (!row) throw new HttpError(404, 'not-found', `No item has the barcode ${code}.`)
    return { item: await itemDetail(db, ws.id, row.id) }
  })

  app.post('/items', manage, async (req, reply) => {
    const input = parse(ItemInput, req.body)
    const ws = workspaceOf(req)
    await checkItemAccounts(db, ws.id, input)
    input.attributes = itemAttributes(ws, input.attributes)
    try {
      const id = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(items)
          .values({ ...input, workspaceId: ws.id, description: input.description ?? null, barcode: input.barcode ?? null, salesAccountId: input.salesAccountId ?? null, expenseAccountId: input.expenseAccountId ?? null })
          .returning()
        await audit(tx, req, { action: 'item.created', entity: 'item', entityId: row!.id, summary: `Added item ${row!.sku} ${row!.name}` })
        return row!.id
      })
      return reply.code(201).send({ item: await itemDetail(db, ws.id, id) })
    } catch (e) {
      if (isUniqueViolation(e, 'items_sku_key')) throw new HttpError(409, 'taken', `SKU ${input.sku} is already used.`, 'sku')
      if (isUniqueViolation(e, 'items_barcode_key')) throw new HttpError(409, 'taken', `Another item already has barcode ${input.barcode}.`, 'barcode')
      throw e
    }
  })

  app.put('/items/:id', manage, async (req) => {
    const id = idOf(req.params, 'item')
    const input = parse(ItemInput, req.body)
    const ws = workspaceOf(req)
    await checkItemAccounts(db, ws.id, input)
    input.attributes = itemAttributes(ws, input.attributes)
    try {
      await db.transaction(async (tx) => {
        const [before] = await tx.select().from(items).where(and(eq(items.id, id), eq(items.workspaceId, ws.id))).for('update')
        if (!before) throw new HttpError(404, 'not-found', 'That item doesn’t exist.')
        const [moved] = await tx.select({ id: stockMoves.id }).from(stockMoves).where(eq(stockMoves.itemId, id)).limit(1)
        // once stock has moved, what it is and how it's counted are history
        if (moved && (before.kind !== input.kind || before.unitId !== input.unitId || before.trackLots !== input.trackLots)) {
          throw new HttpError(409, 'has-moves', 'This item has stock movements, so its type, unit and lot tracking can’t change. Make a new item instead.', 'kind')
        }
        await tx
          .update(items)
          .set({ ...input, description: input.description ?? null, barcode: input.barcode ?? null, salesAccountId: input.salesAccountId ?? null, expenseAccountId: input.expenseAccountId ?? null, updatedAt: new Date() })
          .where(eq(items.id, id))
        const pick = (i: ItemInput | ItemRow) => ({ name: i.name, sku: i.sku, salesPrice: i.salesPrice, purchaseCost: i.purchaseCost, reorderPoint: i.reorderPoint, active: i.active })
        await audit(tx, req, { action: 'item.updated', entity: 'item', entityId: id, summary: `Edited item ${input.sku} ${input.name}`, before: pick(before), after: pick(input) })
      })
    } catch (e) {
      if (isUniqueViolation(e, 'items_sku_key')) throw new HttpError(409, 'taken', `SKU ${input.sku} is already used.`, 'sku')
      if (isUniqueViolation(e, 'items_barcode_key')) throw new HttpError(409, 'taken', `Another item already has barcode ${input.barcode}.`, 'barcode')
      throw e
    }
    return { item: await itemDetail(db, ws.id, id) }
  })

  /* ---------- adjustments and transfers ---------- */

  app.get('/stock/documents', view, async (req) => {
    const q = parse(z.object({ kind: z.enum(['adjustment', 'transfer', 'receipt', 'delivery']).optional() }), req.query)
    return { documents: await stockDocumentsOf(db, workspaceOf(req).id, q.kind ? eq(stockDocuments.kind, q.kind) : undefined) }
  })

  app.get('/stock/documents/:id', view, async (req) => ({ document: await stockDocumentDetail(db, workspaceOf(req).id, idOf(req.params, 'stock document')) }))

  /** Counts, damage, expiry, opening stock: changes the books along with the shelves. */
  app.post('/stock/adjustments', manage, async (req, reply) => {
    const input = parse(AdjustmentInput, req.body)
    const ws = workspaceOf(req)
    const before = await onHandNow(db, input.lines.map((l) => l.itemId))
    const id = await db.transaction((tx) => postAdjustment(tx, req, ws, input))
    await warnLow(ws, before)
    return reply.code(201).send({ document: await stockDocumentDetail(db, ws.id, id) })
  })

  /** From one warehouse to another. Value stays the same, so the books don't change. */
  app.post('/stock/transfers', manage, async (req, reply) => {
    const input = parse(TransferInput, req.body)
    const ws = workspaceOf(req)
    const id = await db.transaction(async (tx) => {
      const from = await activeWarehouse(tx, ws.id, input.fromWarehouseId, 'fromWarehouseId')
      const to = await activeWarehouse(tx, ws.id, input.toWarehouseId, 'toWarehouseId')
      const number = await nextNumber(tx, ws.id, 'stock_transfer')
      const [doc] = await tx
        .insert(stockDocuments)
        .values({ workspaceId: ws.id, kind: 'transfer', number, date: input.date, warehouseId: from.id, toWarehouseId: to.id, notes: input.notes ?? null, createdBy: userOf(req).id })
        .returning()
      for (const [i, line] of input.lines.entries()) {
        const item = await lockStockItem(tx, ws.id, line.itemId)
        const before = await tx.select({ id: stockMoves.id }).from(stockMoves).where(eq(stockMoves.documentId, doc!.id))
        await stockOut(tx, ws, { item, warehouseId: from.id, quantity: line.quantity, lotNo: line.lotNo, kind: 'transfer', date: input.date, documentId: doc!.id, line: `Line ${i + 1}` })
        // what left, lot by lot and at the value it left at, arrives in the other warehouse
        const left = await tx
          .select()
          .from(stockMoves)
          .where(and(eq(stockMoves.documentId, doc!.id), eq(stockMoves.itemId, item.id), eq(stockMoves.warehouseId, from.id)))
        for (const m of left.filter((m) => !before.some((b) => b.id === m.id))) {
          await stockIn(tx, ws, { item, warehouseId: to.id, lotId: m.lotId, quantity: -m.quantity, value: -m.value, kind: 'transfer', date: input.date, documentId: doc!.id })
        }
      }
      await audit(tx, req, { action: 'stock.transferred', entity: 'stock_document', entityId: doc!.id, summary: `Transfer ${number}: ${input.lines.length} item${input.lines.length === 1 ? '' : 's'} from ${from.name} to ${to.name}` })
      return doc!.id
    })
    return reply.code(201).send({ document: await stockDocumentDetail(db, ws.id, id) })
  })

  /* ---------- apparel: size × colour variants ---------- */

  /** Makes a style's variants: one item per colour × size, copying the style's unit, prices and settings. */
  app.post('/items/:id/variants', manage, async (req, reply) => {
    const id = idOf(req.params, 'item')
    const input = parse(VariantsInput, req.body)
    const ws = workspaceOf(req)
    if (!hasFeature(ws.template, 'variants')) throw new HttpError(409, 'no-variants', 'Variants are part of the Apparel template.')
    const slug = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 8) || 'X'
    let made = 0
    await db.transaction(async (tx) => {
      const [style] = await tx.select().from(items).where(and(eq(items.id, id), eq(items.workspaceId, ws.id))).for('update')
      if (!style) throw new HttpError(404, 'not-found', 'That item doesn’t exist.')
      if (style.parentId) throw new HttpError(409, 'is-variant', 'That’s a variant already. Make variants from its style.')
      if (style.kind !== 'stock') throw new HttpError(409, 'invalid', 'Only stock items have variants.')
      const existing = new Set((await tx.select({ sku: items.sku }).from(items).where(eq(items.workspaceId, ws.id))).map((r) => r.sku))
      for (const colour of new Set(input.colours)) {
        for (const size of new Set(input.sizes)) {
          const sku = `${style.sku}-${slug(colour)}-${slug(size)}`.slice(0, 40)
          if (existing.has(sku)) continue
          await tx.insert(items).values({
            workspaceId: ws.id,
            sku,
            name: `${style.name}, ${colour}, ${size}`,
            description: style.description,
            kind: 'stock',
            unitId: style.unitId,
            salesPrice: style.salesPrice,
            purchaseCost: style.purchaseCost,
            salesVat: style.salesVat,
            trackLots: style.trackLots,
            trackExpiry: style.trackExpiry,
            salesAccountId: style.salesAccountId,
            expenseAccountId: style.expenseAccountId,
            attributes: { ...style.attributes, colour, size },
            parentId: style.id,
          })
          existing.add(sku)
          made++
        }
      }
      await audit(tx, req, { action: 'item.variants', entity: 'item', entityId: id, summary: `Made ${made} variants of ${style.sku} (${input.colours.join(', ')} × ${input.sizes.join(', ')})` })
    })
    return reply.code(201).send({ made, item: await itemDetail(db, ws.id, id) })
  })

  /* ---------- quality control: lots held until released ---------- */

  /** Lots waiting for QC, with what's on hand of each. */
  app.get('/lots/quarantine', view, async (req): Promise<{ lots: QuarantineLot[] }> => {
    const ws = workspaceOf(req)
    const rows = await db
      .select({
        lotId: stockLots.id,
        lotNo: stockLots.lotNo,
        expiryDate: stockLots.expiryDate,
        receivedOn: stockLots.createdAt,
        item: { id: items.id, sku: items.sku, name: items.name },
        unit: units.code,
        quantity: sql<number>`coalesce(sum(${stockMoves.quantity}), 0)`.mapWith(Number),
        value: sql<number>`coalesce(sum(${stockMoves.value}), 0)::bigint`.mapWith(Number),
      })
      .from(stockLots)
      .innerJoin(items, eq(items.id, stockLots.itemId))
      .innerJoin(units, eq(units.id, items.unitId))
      .leftJoin(stockMoves, eq(stockMoves.lotId, stockLots.id))
      .where(and(eq(stockLots.workspaceId, ws.id), eq(stockLots.status, 'quarantine')))
      .groupBy(stockLots.id, items.id, units.code)
      .orderBy(asc(stockLots.createdAt))
    return { lots: rows.map((r) => ({ ...r, item: { ...r.item, unit: r.unit }, quantity: q4(r.quantity), receivedOn: r.receivedOn.toISOString().slice(0, 10) })) }
  })

  const lotOf = async (tx: Tx, workspaceId: string, params: unknown) => {
    const lotId = idOf(params, 'lot')
    const [lot] = await tx.select({ lot: stockLots, item: items }).from(stockLots).innerJoin(items, eq(items.id, stockLots.itemId)).where(and(eq(stockLots.id, lotId), eq(stockLots.workspaceId, workspaceId))).for('update', { of: stockLots })
    if (!lot) throw new HttpError(404, 'not-found', 'That lot doesn’t exist.')
    if (lot.lot.status !== 'quarantine') throw new HttpError(409, 'decided', `Lot ${lot.lot.lotNo} has already been ${lot.lot.status}.`)
    return lot
  }

  /** QC passed: the lot can be sold and used. */
  app.post('/lots/:id/release', manage, async (req) => {
    const ws = workspaceOf(req)
    const note = parse(z.object({ note: z.string().trim().max(300).optional() }), req.body ?? {}).note
    await db.transaction(async (tx) => {
      const { lot, item } = await lotOf(tx, ws.id, req.params)
      await tx.update(stockLots).set({ status: 'released', decidedAt: new Date(), decidedBy: userOf(req).id }).where(eq(stockLots.id, lot.id))
      await audit(tx, req, { action: 'lot.released', entity: 'item', entityId: item.id, summary: `Released lot ${lot.lotNo} of ${item.name} after quality control${note ? `: ${note}` : ''}` })
    })
    return { ok: true }
  })

  /** QC failed: what's on hand of the lot is written off (to Spoilage where the template has it). */
  app.post('/lots/:id/reject', manage, async (req) => {
    const ws = workspaceOf(req)
    const input = parse(z.object({ date: z.iso.date(), note: z.string().trim().min(1, 'Say why it failed.').max(300) }), req.body)
    await db.transaction(async (tx) => {
      const { lot, item } = await lotOf(tx, ws.id, req.params)
      const held = await tx
        .select({ warehouseId: stockMoves.warehouseId, qty: sql<number>`sum(${stockMoves.quantity})`.mapWith(Number) })
        .from(stockMoves)
        .where(eq(stockMoves.lotId, lot.id))
        .groupBy(stockMoves.warehouseId)
        .having(sql`sum(${stockMoves.quantity}) > 0`)
      for (const h of held) {
        await postAdjustment(tx, req, ws, { date: input.date, warehouseId: h.warehouseId, reason: 'rejected', notes: `Lot ${lot.lotNo} failed quality control: ${input.note}`, lines: [{ itemId: item.id, change: -q4(h.qty), lotNo: lot.lotNo }] })
      }
      await tx.update(stockLots).set({ status: 'rejected', decidedAt: new Date(), decidedBy: userOf(req).id }).where(eq(stockLots.id, lot.id))
      await audit(tx, req, { action: 'lot.rejected', entity: 'item', entityId: item.id, summary: `Rejected lot ${lot.lotNo} of ${item.name}: ${input.note}` })
    })
    return { ok: true }
  })

  /* ---------- overview and valuation ---------- */

  app.get('/inventory/overview', view, async (req): Promise<{ overview: InventoryOverview }> => {
    const ws = workspaceOf(req)
    const rows = await db.select({ item: items, unit: units }).from(items).innerJoin(units, eq(units.id, items.unitId)).where(and(eq(items.workspaceId, ws.id), eq(items.kind, 'stock'), eq(items.active, true)))
    const totals = await totalsFor(db, ws.id)
    const all = rows.map((r) => itemOut(r.item, r.unit, totals.get(r.item.id)))
    const soon = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10)
    const expiring = await db
      .select({ itemId: items.id, sku: items.sku, name: items.name, lotNo: stockLots.lotNo, expiryDate: stockLots.expiryDate, warehouse: warehouses.name, warehouseId: warehouses.id, quantity: sql<number>`sum(${stockMoves.quantity})`.mapWith(Number) })
      .from(stockMoves)
      .innerJoin(stockLots, eq(stockLots.id, stockMoves.lotId))
      .innerJoin(items, eq(items.id, stockMoves.itemId))
      .innerJoin(warehouses, eq(warehouses.id, stockMoves.warehouseId))
      .where(and(eq(stockMoves.workspaceId, ws.id), isNotNull(stockLots.expiryDate), lte(stockLots.expiryDate, soon)))
      .groupBy(items.id, stockLots.id, warehouses.id)
      .having(sql`sum(${stockMoves.quantity}) > 0`)
      .orderBy(asc(stockLots.expiryDate))
      .limit(50)
    const [open] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.workspaceId, ws.id), inArray(purchaseOrders.status, ['issued', 'partly_received', 'received'])))
    return {
      overview: {
        stockValue: all.reduce((s, i) => s + i.value, 0),
        itemCount: all.length,
        low: all.filter((i) => i.low).map((i) => ({ id: i.id, sku: i.sku, name: i.name, onHand: i.onHand, reorderPoint: i.reorderPoint, reorderQty: i.reorderQty, unit: i.unit.code })),
        expiring: expiring.map((e) => ({ ...e, expiryDate: e.expiryDate!, quantity: q4(e.quantity) })),
        openPurchaseOrders: open?.n ?? 0,
      },
    }
  })

  /** Every stock item's quantity and value on a date: what the Inventory account should equal. */
  app.get('/inventory/valuation', view, async (req) => {
    const { asOf } = parse(z.object({ asOf: z.iso.date().default(todayInManila()) }), req.query)
    const ws = workspaceOf(req)
    const rows = await db
      .select({
        itemId: items.id,
        sku: items.sku,
        name: items.name,
        unit: units.code,
        quantity: sql<number>`coalesce(sum(${stockMoves.quantity}), 0)`.mapWith(Number),
        value: sql<number>`coalesce(sum(${stockMoves.value}), 0)::bigint`.mapWith(Number),
      })
      .from(stockMoves)
      .innerJoin(items, eq(items.id, stockMoves.itemId))
      .innerJoin(units, eq(units.id, items.unitId))
      .where(and(eq(stockMoves.workspaceId, ws.id), lte(stockMoves.date, asOf)))
      .groupBy(items.id, units.code)
      .having(or(ne(sql`sum(${stockMoves.quantity})`, 0), ne(sql`sum(${stockMoves.value})`, 0)))
      .orderBy(asc(items.name))
    const out = rows.map((r): ValuationRow => ({ ...r, quantity: q4(r.quantity), averageCost: r.quantity > 0 ? r.value / r.quantity : 0 }))
    return { asOf, rows: out, total: out.reduce((s, r) => s + r.value, 0) }
  })
}

