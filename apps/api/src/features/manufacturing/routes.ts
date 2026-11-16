import {
  BomInput,
  formatPeso,
  MrpBuyInput,
  OPEN_WO_STATUSES,
  q4,
  WoCompleteInput,
  WorkCenterInput,
  WorkOrderInput,
  WoStartInput,
  type Bom,
  type BomSummary,
  type ManufacturingOverview,
  type MrpPlan,
  type MrpRow,
  type QcResult,
  type WorkCenter,
  type WorkOrder,
  type WorkOrderSummary,
} from '@erp/shared'
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db, isUniqueViolation } from '../../db/client.ts'
import {
  bomLines,
  bomOperations,
  boms,
  contacts,
  items,
  journalEntries,
  purchaseOrderLines,
  purchaseOrders,
  salesLines,
  salesOrders,
  stockLots,
  stockMoves,
  units,
  warehouses,
  woMaterials,
  woOperations,
  workCenters,
  workOrders,
  type WorkspaceRow,
} from '../../db/schema.ts'
import type { Executor, Tx } from '../../db/types.ts'
import { audit } from '../../lib/audit.ts'
import { HttpError, parse } from '../../lib/errors.ts'
import { userOf } from '../../lib/session.ts'
import { needs, workspaceOf } from '../../lib/workspace.ts'
import { nextNumber, postEntry, systemAccount, systemAccountIfAny, todayInManila } from '../finance/ledger.ts'
import { preparePo } from '../inventory/purchasing.ts'
import { warnLow } from '../inventory/routes.ts'
import { activeWarehouse, averageCost, itemTotals, lockStockItem, lotForReceipt, stockIn, stockOut } from '../inventory/stock.ts'

/**
 * Manufacturing (Phase 6). The money follows the stock, as everywhere else:
 *
 * - starting a work order takes its materials out of stock (earliest expiry first, never expired)
 *   at moving average cost: Dr Work in Process / Cr Inventory;
 * - completing it applies labour and overhead at each work centre's hourly rate, puts the good units
 *   into stock at their share of the cost, and writes off the rejects:
 *   Dr Inventory, Dr Spoilage (rejects) / Cr Labor and Overhead Applied, Cr Work in Process.
 *
 * So each work order's Work in Process comes back to zero, and the stock valuation still equals the
 * Inventory account. A completed work order can't be changed (a database trigger, migration 0016).
 */

const view = needs('manufacturing.view', 'manufacturing')
const manage = needs('manufacturing.manage', 'manufacturing')

const IdParam = z.object({ id: z.uuid() })
const idOf = (params: unknown, what: string) => {
  const r = IdParam.safeParse(params)
  if (!r.success) throw new HttpError(404, 'not-found', `That ${what} doesn’t exist.`)
  return r.data.id
}

/** Scales a BOM quantity (per batch) to a number of units. */
const scaled = (perBatch: number, outputQty: number, units: number) => q4((perBatch * units) / outputQty)
const opCost = (minutes: number, costPerHour: number) => Math.round((minutes * costPerHour) / 60)

/* ---------------------------------------------------------------------------------------------
 * Items, as manufacturing sees them
 * ------------------------------------------------------------------------------------------- */

async function itemRows(dbx: Executor, workspaceId: string, ids: string[]) {
  if (!ids.length) return new Map<string, { item: typeof items.$inferSelect; unit: string }>()
  const rows = await dbx
    .select({ item: items, unit: units.code })
    .from(items)
    .innerJoin(units, eq(units.id, items.unitId))
    .where(and(eq(items.workspaceId, workspaceId), inArray(items.id, [...new Set(ids)])))
  return new Map(rows.map((r) => [r.item.id, r]))
}

/** The active BOM of each product that has one. */
async function activeBoms(dbx: Executor, workspaceId: string) {
  const heads = await dbx.select().from(boms).where(and(eq(boms.workspaceId, workspaceId), eq(boms.active, true)))
  const lines = heads.length ? await dbx.select().from(bomLines).where(inArray(bomLines.bomId, heads.map((b) => b.id))) : []
  const ops = heads.length
    ? await dbx.select({ op: bomOperations, rate: workCenters.costPerHour }).from(bomOperations).innerJoin(workCenters, eq(workCenters.id, bomOperations.workCenterId)).where(inArray(bomOperations.bomId, heads.map((b) => b.id)))
    : []
  return new Map(
    heads.map((b) => [
      b.itemId,
      { bom: b, lines: lines.filter((l) => l.bomId === b.id), conversion: ops.filter((o) => o.op.bomId === b.id).reduce((s, o) => s + opCost(o.op.minutes, o.rate), 0) },
    ]),
  )
}

/**
 * What a unit of each item costs: average cost when it's in stock; otherwise, for a made item, its
 * BOM rolled up; otherwise its purchase cost.
 */
async function unitCosts(dbx: Executor, workspaceId: string, bomsByItem: Awaited<ReturnType<typeof activeBoms>>) {
  const memo = new Map<string, number>()
  const purchase = new Map((await dbx.select({ id: items.id, cost: items.purchaseCost }).from(items).where(eq(items.workspaceId, workspaceId))).map((r) => [r.id, r.cost]))
  // every item's quantity and value on hand, in one query
  const onHand = new Map(
    (
      await dbx
        .select({ id: stockMoves.itemId, qty: sql<number>`coalesce(sum(${stockMoves.quantity}), 0)`.mapWith(Number), value: sql<number>`coalesce(sum(${stockMoves.value}), 0)::bigint`.mapWith(Number) })
        .from(stockMoves)
        .where(eq(stockMoves.workspaceId, workspaceId))
        .groupBy(stockMoves.itemId)
    ).map((r) => [r.id, { qty: q4(r.qty), value: r.value }]),
  )
  async function cost(itemId: string, depth = 0): Promise<number> {
    if (memo.has(itemId)) return memo.get(itemId)!
    const totals = onHand.get(itemId) ?? { qty: 0, value: 0 }
    let c = totals.qty > 0 ? averageCost(totals) : (purchase.get(itemId) ?? 0)
    const made = bomsByItem.get(itemId)
    if (totals.qty <= 0 && made && depth < 10) {
      let batch = made.conversion
      for (const l of made.lines) batch += l.quantity * (await cost(l.itemId, depth + 1))
      c = batch / made.bom.outputQty
    }
    memo.set(itemId, c)
    return c
  }
  return cost
}

/* ---------------------------------------------------------------------------------------------
 * Bills of materials
 * ------------------------------------------------------------------------------------------- */

const bomCode = (sku: string, version: number) => `BOM-${sku}-${version}`

async function bomSummaries(dbx: Executor, workspaceId: string, where?: ReturnType<typeof eq>): Promise<BomSummary[]> {
  const rows = await dbx
    .select({ bom: boms, item: { id: items.id, sku: items.sku, name: items.name }, unit: units.code, n: sql<number>`(select count(*)::int from bom_lines bl where bl.bom_id = ${boms.id})` })
    .from(boms)
    .innerJoin(items, eq(items.id, boms.itemId))
    .innerJoin(units, eq(units.id, items.unitId))
    .where(and(eq(boms.workspaceId, workspaceId), where))
    .orderBy(asc(items.name), desc(boms.version))
  const byItem = await activeBoms(dbx, workspaceId)
  const cost = await unitCosts(dbx, workspaceId, byItem)
  const ids = rows.map((r) => r.bom.id)
  const allLines = ids.length ? await dbx.select().from(bomLines).where(inArray(bomLines.bomId, ids)) : []
  const allOps = ids.length
    ? await dbx.select({ bomId: bomOperations.bomId, m: bomOperations.minutes, rate: workCenters.costPerHour }).from(bomOperations).innerJoin(workCenters, eq(workCenters.id, bomOperations.workCenterId)).where(inArray(bomOperations.bomId, ids))
    : []
  const out: BomSummary[] = []
  for (const r of rows) {
    const lines = allLines.filter((l) => l.bomId === r.bom.id)
    const ops = allOps.filter((o) => o.bomId === r.bom.id)
    let batch = ops.reduce((s, o) => s + opCost(o.m, o.rate), 0)
    for (const l of lines) batch += l.quantity * (await cost(l.itemId))
    out.push({
      id: r.bom.id,
      code: bomCode(r.item.sku, r.bom.version),
      version: r.bom.version,
      active: r.bom.active,
      item: { ...r.item, unit: r.unit },
      outputQty: r.bom.outputQty,
      componentCount: r.n,
      unitCost: Math.round(batch / r.bom.outputQty),
    })
  }
  return out
}

async function bomDetail(dbx: Executor, workspaceId: string, id: string): Promise<Bom> {
  const [summary] = await bomSummaries(dbx, workspaceId, eq(boms.id, id))
  if (!summary) throw new HttpError(404, 'not-found', 'That bill of materials doesn’t exist.')
  const [head] = await dbx.select().from(boms).where(eq(boms.id, id))
  const byItem = await activeBoms(dbx, workspaceId)
  const cost = await unitCosts(dbx, workspaceId, byItem)
  const lines = await dbx
    .select({ l: bomLines, item: items, unit: units.code })
    .from(bomLines)
    .innerJoin(items, eq(items.id, bomLines.itemId))
    .innerJoin(units, eq(units.id, items.unitId))
    .where(eq(bomLines.bomId, id))
    .orderBy(asc(bomLines.position))
  const ops = await dbx.select({ op: bomOperations, wc: workCenters }).from(bomOperations).innerJoin(workCenters, eq(workCenters.id, bomOperations.workCenterId)).where(eq(bomOperations.bomId, id)).orderBy(asc(bomOperations.position))
  const usedIn = await dbx
    .select({ id: boms.id, sku: items.sku, version: boms.version, itemId: items.id, name: items.name })
    .from(bomLines)
    .innerJoin(boms, eq(boms.id, bomLines.bomId))
    .innerJoin(items, eq(items.id, boms.itemId))
    .where(and(eq(bomLines.itemId, head!.itemId), eq(boms.active, true)))
  const outLines = []
  let materialCost = 0
  for (const r of lines) {
    const c = await cost(r.item.id)
    materialCost += r.l.quantity * c
    outLines.push({
      id: r.l.id,
      item: { id: r.item.id, sku: r.item.sku, name: r.item.name, unit: r.unit, trackLots: r.item.trackLots, made: byItem.has(r.item.id) },
      quantity: r.l.quantity,
      notes: r.l.notes,
      averageCost: Math.round(c),
    })
  }
  const operations = ops.map((o) => ({
    id: o.op.id,
    workCenter: { id: o.wc.id, code: o.wc.code, name: o.wc.name, costPerHour: o.wc.costPerHour },
    description: o.op.description,
    minutes: o.op.minutes,
    cost: opCost(o.op.minutes, o.wc.costPerHour),
  }))
  return {
    ...summary,
    notes: head!.notes,
    lines: outLines,
    operations,
    qcChecks: head!.qcChecks,
    materialCost: Math.round(materialCost),
    conversionCost: operations.reduce((s, o) => s + o.cost, 0),
    usedIn: usedIn.map((u) => ({ id: u.id, code: bomCode(u.sku, u.version), item: { id: u.itemId, name: u.name } })),
  }
}

/** Checks a BOM's product and components, and that it doesn't (through other BOMs) contain itself. */
async function checkBom(tx: Tx, ws: WorkspaceRow, input: z.output<typeof BomInput>) {
  const rows = await itemRows(tx, ws.id, [input.itemId, ...input.lines.map((l) => l.itemId)])
  const product = rows.get(input.itemId)
  if (!product || product.item.kind !== 'stock') throw new HttpError(400, 'invalid', 'Choose a stock item to make.', 'itemId')
  for (const [i, l] of input.lines.entries()) {
    const c = rows.get(l.itemId)
    if (!c || c.item.kind !== 'stock') throw new HttpError(400, 'invalid', `Component ${i + 1}: choose a stock item.`, 'lines')
    if (l.itemId === input.itemId) throw new HttpError(400, 'invalid', `${product.item.name} can’t be one of its own components.`, 'lines')
  }
  if (input.operations.length) {
    const ids = [...new Set(input.operations.map((o) => o.workCenterId))]
    const found = await tx.select({ id: workCenters.id }).from(workCenters).where(and(eq(workCenters.workspaceId, ws.id), inArray(workCenters.id, ids)))
    if (found.length !== ids.length) throw new HttpError(400, 'invalid', 'Choose a work centre for each step.', 'operations')
  }
  // a component made from something that contains this product would loop forever
  const byItem = await activeBoms(tx, ws.id)
  const seen = new Set<string>()
  const walk = (itemId: string, path: string[]): string[] | null => {
    if (itemId === input.itemId) return path
    if (seen.has(itemId)) return null
    seen.add(itemId)
    for (const l of byItem.get(itemId)?.lines ?? []) {
      const found = walk(l.itemId, [...path, l.itemId])
      if (found) return found
    }
    return null
  }
  for (const l of input.lines) {
    const loop = walk(l.itemId, [l.itemId])
    if (loop) {
      const names = await itemRows(tx, ws.id, loop)
      throw new HttpError(400, 'bom-loop', `That would make ${product.item.name} out of itself (through ${loop.map((id) => names.get(id)?.item.name).join(' → ')}).`, 'lines')
    }
  }
  return product
}

async function writeBomLines(tx: Tx, workspaceId: string, bomId: string, input: z.output<typeof BomInput>) {
  await tx.insert(bomLines).values(input.lines.map((l, position) => ({ workspaceId, bomId, position, itemId: l.itemId, quantity: l.quantity, notes: l.notes ?? null })))
  if (input.operations.length) {
    await tx.insert(bomOperations).values(input.operations.map((o, position) => ({ workspaceId, bomId, position, workCenterId: o.workCenterId, description: o.description, minutes: o.minutes })))
  }
}

/* ---------------------------------------------------------------------------------------------
 * Work orders
 * ------------------------------------------------------------------------------------------- */

const isLate = (w: { status: string; dueDate: string }) => (OPEN_WO_STATUSES as readonly string[]).includes(w.status) && w.dueDate < todayInManila()

async function woSummaries(dbx: Executor, workspaceId: string, where?: ReturnType<typeof and>): Promise<WorkOrderSummary[]> {
  const rows = await dbx
    .select({
      w: workOrders,
      item: { id: items.id, sku: items.sku, name: items.name },
      unit: units.code,
      warehouse: { id: warehouses.id, name: warehouses.name },
      so: { id: salesOrders.id, number: salesOrders.number },
      customer: contacts.name,
    })
    .from(workOrders)
    .innerJoin(items, eq(items.id, workOrders.itemId))
    .innerJoin(units, eq(units.id, items.unitId))
    .innerJoin(warehouses, eq(warehouses.id, workOrders.warehouseId))
    .leftJoin(salesOrders, eq(salesOrders.id, workOrders.salesOrderId))
    .leftJoin(contacts, eq(contacts.id, salesOrders.customerId))
    .where(and(eq(workOrders.workspaceId, workspaceId), where))
    .orderBy(asc(workOrders.dueDate), desc(workOrders.createdAt))
  return rows.map((r) => ({
    id: r.w.id,
    number: r.w.number,
    status: r.w.status,
    item: { ...r.item, unit: r.unit },
    quantity: r.w.quantity,
    goodQty: r.w.goodQty,
    rejectedQty: r.w.rejectedQty,
    startDate: r.w.startDate,
    dueDate: r.w.dueDate,
    warehouse: r.warehouse,
    salesOrder: r.so?.id ? { id: r.so.id, number: r.so.number, customer: r.customer ?? '' } : null,
    late: isLate(r.w),
  }))
}

async function woDetail(dbx: Executor, workspaceId: string, id: string): Promise<WorkOrder> {
  const [summary] = await woSummaries(dbx, workspaceId, and(eq(workOrders.id, id)))
  if (!summary) throw new HttpError(404, 'not-found', 'That work order doesn’t exist.')
  const [w] = await dbx.select().from(workOrders).where(eq(workOrders.id, id))
  const [bom] = await dbx.select({ id: boms.id, version: boms.version, outputQty: boms.outputQty }).from(boms).where(eq(boms.id, w!.bomId))
  const mats = await dbx
    .select({ m: woMaterials, item: items, unit: units.code })
    .from(woMaterials)
    .innerJoin(items, eq(items.id, woMaterials.itemId))
    .innerJoin(units, eq(units.id, items.unitId))
    .where(eq(woMaterials.workOrderId, id))
    .orderBy(asc(woMaterials.position))
  const ops = await dbx.select({ o: woOperations, wc: workCenters }).from(woOperations).innerJoin(workCenters, eq(workCenters.id, woOperations.workCenterId)).where(eq(woOperations.workOrderId, id)).orderBy(asc(woOperations.position))
  const [lot] = w!.lotId ? await dbx.select().from(stockLots).where(eq(stockLots.id, w!.lotId)) : []
  const entries = await dbx
    .select({ id: journalEntries.id, number: journalEntries.number, memo: journalEntries.memo })
    .from(journalEntries)
    .where(and(eq(journalEntries.source, 'production'), eq(journalEntries.sourceId, id)))
    .orderBy(asc(journalEntries.createdAt))
  const materials = []
  for (const r of mats) {
    materials.push({
      id: r.m.id,
      item: { id: r.item.id, sku: r.item.sku, name: r.item.name, unit: r.unit, trackLots: r.item.trackLots },
      plannedQty: r.m.plannedQty,
      issuedQty: r.m.issuedQty,
      issuedValue: r.m.issuedValue,
      onHand: (await itemTotals(dbx, r.item.id)).qty,
    })
  }
  const qc = (w!.qc as QcResult[]) ?? []
  return {
    ...summary,
    bom: { id: bom!.id, code: bomCode(summary.item.sku, bom!.version), outputQty: bom!.outputQty },
    notes: w!.notes,
    materials,
    operations: ops.map((o) => ({
      id: o.o.id,
      workCenter: { id: o.wc.id, code: o.wc.code, name: o.wc.name },
      description: o.o.description,
      plannedMinutes: o.o.plannedMinutes,
      actualMinutes: o.o.actualMinutes,
      cost: o.o.actualMinutes !== null ? o.o.cost : opCost(o.o.plannedMinutes, o.wc.costPerHour),
    })),
    qcChecks: w!.qcChecks,
    qc,
    lot: lot ? { lotNo: lot.lotNo, expiryDate: lot.expiryDate } : null,
    materialCost: w!.materialCost,
    conversionCost: w!.conversionCost,
    unitCost: w!.status === 'completed' && w!.goodQty > 0 ? Math.round((w!.materialCost + w!.conversionCost) / (w!.goodQty + w!.rejectedQty)) : null,
    startedAt: w!.startedAt?.toISOString() ?? null,
    completedAt: w!.completedAt?.toISOString() ?? null,
    entries,
  }
}

async function lockWo(tx: Tx, workspaceId: string, id: string) {
  const [w] = await tx.select().from(workOrders).where(and(eq(workOrders.id, id), eq(workOrders.workspaceId, workspaceId))).for('update')
  if (!w) throw new HttpError(404, 'not-found', 'That work order doesn’t exist.')
  return w
}

/** The work order's materials and steps, copied from the product's active BOM and scaled. */
async function planWo(tx: Tx, ws: WorkspaceRow, input: z.output<typeof WorkOrderInput>) {
  const [bom] = await tx.select().from(boms).where(and(eq(boms.workspaceId, ws.id), eq(boms.itemId, input.itemId), eq(boms.active, true)))
  if (!bom) throw new HttpError(400, 'no-bom', 'That product has no active bill of materials. Make one first.', 'itemId')
  await activeWarehouse(tx, ws.id, input.warehouseId)
  if (input.salesOrderId) {
    const [so] = await tx.select({ id: salesOrders.id }).from(salesOrders).where(and(eq(salesOrders.id, input.salesOrderId), eq(salesOrders.workspaceId, ws.id)))
    if (!so) throw new HttpError(400, 'invalid', 'Choose a sales order in this workspace.', 'salesOrderId')
  }
  const lines = await tx.select().from(bomLines).where(eq(bomLines.bomId, bom.id)).orderBy(asc(bomLines.position))
  const ops = await tx.select({ op: bomOperations, rate: workCenters.costPerHour }).from(bomOperations).innerJoin(workCenters, eq(workCenters.id, bomOperations.workCenterId)).where(eq(bomOperations.bomId, bom.id)).orderBy(asc(bomOperations.position))
  return {
    bom,
    materials: lines.map((l, position) => ({ position, itemId: l.itemId, plannedQty: scaled(l.quantity, bom.outputQty, input.quantity) })),
    operations: ops.map((o, position) => ({ position, workCenterId: o.op.workCenterId, description: o.op.description, plannedMinutes: Math.round(scaled(o.op.minutes, bom.outputQty, input.quantity) * 100) / 100, costPerHour: o.rate })),
  }
}

async function writeWoPlan(tx: Tx, workspaceId: string, woId: string, plan: Awaited<ReturnType<typeof planWo>>) {
  await tx.insert(woMaterials).values(plan.materials.map((m) => ({ ...m, workspaceId, workOrderId: woId })))
  if (plan.operations.length) await tx.insert(woOperations).values(plan.operations.map((o) => ({ ...o, workspaceId, workOrderId: woId })))
}

const describe = (w: { number: string | null }, name: string, qty: number, unit: string) => `${w.number ?? 'Draft work order'} (${qty} ${unit} ${name})`

/* ---------------------------------------------------------------------------------------------
 * Planning
 * ------------------------------------------------------------------------------------------- */

export async function mrpPlan(dbx: Executor, workspaceId: string): Promise<MrpPlan> {
  const today = todayInManila()
  const stock = await dbx
    .select({ item: items, unit: units.code })
    .from(items)
    .innerJoin(units, eq(units.id, items.unitId))
    .where(and(eq(items.workspaceId, workspaceId), eq(items.kind, 'stock'), eq(items.active, true)))
  const sum = (rows: { itemId: string; qty: number }[]) => new Map(rows.map((r) => [r.itemId, Number(r.qty)]))

  // on hand, leaving out expired lots
  const onHand = sum(
    await dbx
      .select({ itemId: stockMoves.itemId, qty: sql<number>`sum(${stockMoves.quantity})`.mapWith(Number) })
      .from(stockMoves)
      .leftJoin(stockLots, eq(stockLots.id, stockMoves.lotId))
      .where(and(eq(stockMoves.workspaceId, workspaceId), or(isNull(stockLots.expiryDate), gte(stockLots.expiryDate, today))))
      .groupBy(stockMoves.itemId),
  )
  const fromPos = sum(
    await dbx
      .select({ itemId: purchaseOrderLines.itemId, qty: sql<number>`sum(${purchaseOrderLines.quantity} - ${purchaseOrderLines.receivedQty})`.mapWith(Number) })
      .from(purchaseOrderLines)
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.poId))
      .where(and(eq(purchaseOrders.workspaceId, workspaceId), inArray(purchaseOrders.status, ['issued', 'partly_received'])))
      .groupBy(purchaseOrderLines.itemId),
  )
  const fromWos = sum(
    await dbx
      .select({ itemId: workOrders.itemId, qty: sql<number>`sum(${workOrders.quantity})`.mapWith(Number) })
      .from(workOrders)
      .where(and(eq(workOrders.workspaceId, workspaceId), inArray(workOrders.status, ['draft', 'released', 'in_progress'])))
      .groupBy(workOrders.itemId),
  )
  const forSales = sum(
    await dbx
      .select({ itemId: salesLines.itemId, qty: sql<number>`sum(greatest(${salesLines.quantity} - ${salesLines.deliveredQty}, 0))`.mapWith(Number) })
      .from(salesLines)
      .innerJoin(salesOrders, eq(salesOrders.id, salesLines.orderId))
      .where(and(eq(salesOrders.workspaceId, workspaceId), inArray(salesOrders.status, ['confirmed', 'partly_delivered'])))
      .groupBy(salesLines.itemId),
  )
  // materials still to come out for work orders not yet started
  const forWos = sum(
    await dbx
      .select({ itemId: woMaterials.itemId, qty: sql<number>`sum(${woMaterials.plannedQty})`.mapWith(Number) })
      .from(woMaterials)
      .innerJoin(workOrders, eq(workOrders.id, woMaterials.workOrderId))
      .where(and(eq(workOrders.workspaceId, workspaceId), inArray(workOrders.status, ['draft', 'released'])))
      .groupBy(woMaterials.itemId),
  )
  const byItem = await activeBoms(dbx, workspaceId)

  // low-level codes: a component sits one level below the deepest product that uses it
  const level = new Map(stock.map((s) => [s.item.id, 0]))
  for (let pass = 0, changed = true; changed && pass < 20; pass++) {
    changed = false
    for (const [parent, b] of byItem) {
      for (const l of b.lines) {
        const want = (level.get(parent) ?? 0) + 1
        if ((level.get(l.itemId) ?? 0) < want) {
          level.set(l.itemId, want)
          changed = true
        }
      }
    }
  }

  // where each item was last bought, and at what
  const lastBuys = await dbx
    .select({ itemId: purchaseOrderLines.itemId, supplierId: contacts.id, supplier: contacts.name, unitCost: purchaseOrderLines.unitCost, date: purchaseOrders.date })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.poId))
    .innerJoin(contacts, eq(contacts.id, purchaseOrders.supplierId))
    .where(and(eq(purchaseOrders.workspaceId, workspaceId), ne(purchaseOrders.status, 'cancelled')))
    .orderBy(desc(purchaseOrders.date), desc(purchaseOrders.createdAt))
  const lastBuy = new Map<string, (typeof lastBuys)[number]>()
  for (const b of lastBuys) if (!lastBuy.has(b.itemId)) lastBuy.set(b.itemId, b)

  const planned = new Map<string, number>()
  const rows: MrpRow[] = []
  for (const s of [...stock].sort((a, b) => (level.get(a.item.id)! - level.get(b.item.id)!) || a.item.name.localeCompare(b.item.name))) {
    const id = s.item.id
    const demand = { salesOrders: q4(forSales.get(id) ?? 0), workOrders: q4(forWos.get(id) ?? 0), planned: q4(planned.get(id) ?? 0) }
    const incoming = { purchaseOrders: q4(fromPos.get(id) ?? 0), workOrders: q4(fromWos.get(id) ?? 0) }
    const have = q4(onHand.get(id) ?? 0)
    const projected = have + incoming.purchaseOrders + incoming.workOrders - demand.salesOrders - demand.workOrders - demand.planned
    const short = s.item.reorderPoint - projected
    // short of the reorder point (or of zero): make or buy the shortfall, or the reorder quantity if that's more
    const suggested = projected < s.item.reorderPoint || projected < 0 ? Math.ceil(Math.max(short, s.item.reorderQty, 0) - 1e-9) : 0
    const made = byItem.get(id)
    if (made && suggested > 0) {
      for (const l of made.lines) planned.set(l.itemId, (planned.get(l.itemId) ?? 0) + scaled(l.quantity, made.bom.outputQty, suggested))
    }
    const buy = lastBuy.get(id)
    const moving = suggested > 0 || demand.salesOrders + demand.workOrders + demand.planned > 0 || incoming.purchaseOrders + incoming.workOrders > 0 || !!made
    if (!moving) continue
    rows.push({
      item: { id, sku: s.item.sku, name: s.item.name, unit: s.unit },
      action: made ? 'make' : 'buy',
      level: level.get(id) ?? 0,
      demand,
      onHand: have,
      incoming,
      reorderPoint: s.item.reorderPoint,
      suggested,
      supplier: !made && buy ? { id: buy.supplierId, name: buy.supplier } : null,
      unitCost: !made && buy ? buy.unitCost : s.item.purchaseCost,
    })
  }
  return { asOf: today, rows }
}

/* ---------------------------------------------------------------------------------------------
 * Routes
 * ------------------------------------------------------------------------------------------- */

export default async function manufacturingRoutes(app: FastifyInstance) {
  /* ---------- work centres ---------- */

  const wcOut = (w: typeof workCenters.$inferSelect): WorkCenter => ({ id: w.id, code: w.code, name: w.name, costPerHour: w.costPerHour, active: w.active })

  app.get('/work-centers', view, async (req) => ({
    workCenters: (await db.select().from(workCenters).where(eq(workCenters.workspaceId, workspaceOf(req).id)).orderBy(asc(workCenters.code))).map(wcOut),
  }))

  app.post('/work-centers', manage, async (req, reply) => {
    const input = parse(WorkCenterInput, req.body)
    const ws = workspaceOf(req)
    try {
      const row = await db.transaction(async (tx) => {
        const [w] = await tx.insert(workCenters).values({ ...input, workspaceId: ws.id }).returning()
        await audit(tx, req, { action: 'work_center.created', entity: 'work_center', entityId: w!.id, summary: `Added work centre ${w!.code} (${formatPeso(w!.costPerHour)} an hour)` })
        return w!
      })
      return reply.code(201).send({ workCenter: wcOut(row) })
    } catch (e) {
      if (isUniqueViolation(e, 'work_centers_code_key')) throw new HttpError(409, 'taken', 'There’s already a work centre with that code.', 'code')
      throw e
    }
  })

  app.put('/work-centers/:id', manage, async (req) => {
    const id = idOf(req.params, 'work centre')
    const input = parse(WorkCenterInput, req.body)
    const ws = workspaceOf(req)
    try {
      const row = await db.transaction(async (tx) => {
        const [w] = await tx.update(workCenters).set(input).where(and(eq(workCenters.id, id), eq(workCenters.workspaceId, ws.id))).returning()
        if (!w) throw new HttpError(404, 'not-found', 'That work centre doesn’t exist.')
        await audit(tx, req, { action: 'work_center.updated', entity: 'work_center', entityId: id, summary: `Edited work centre ${w.code}` })
        return w
      })
      return { workCenter: wcOut(row) }
    } catch (e) {
      if (isUniqueViolation(e, 'work_centers_code_key')) throw new HttpError(409, 'taken', 'There’s already a work centre with that code.', 'code')
      throw e
    }
  })

  /* ---------- bills of materials ---------- */

  app.get('/boms', view, async (req) => ({ boms: await bomSummaries(db, workspaceOf(req).id) }))
  app.get('/boms/:id', view, async (req) => ({ bom: await bomDetail(db, workspaceOf(req).id, idOf(req.params, 'bill of materials')) }))

  /** A new BOM is the next version for its product; made active, it replaces the one before. */
  app.post('/boms', manage, async (req, reply) => {
    const input = parse(BomInput, req.body)
    const ws = workspaceOf(req)
    const id = await db.transaction(async (tx) => {
      const product = await checkBom(tx, ws, input)
      const [last] = await tx.select({ v: sql<number>`coalesce(max(${boms.version}), 0)::int` }).from(boms).where(eq(boms.itemId, input.itemId))
      if (input.active) await tx.update(boms).set({ active: false, updatedAt: new Date() }).where(and(eq(boms.itemId, input.itemId), eq(boms.active, true)))
      const [b] = await tx
        .insert(boms)
        .values({ workspaceId: ws.id, itemId: input.itemId, version: (last?.v ?? 0) + 1, outputQty: input.outputQty, active: input.active, notes: input.notes ?? null, qcChecks: input.qcChecks, createdBy: userOf(req).id })
        .returning()
      await writeBomLines(tx, ws.id, b!.id, input)
      await audit(tx, req, { action: 'bom.created', entity: 'bom', entityId: b!.id, summary: `Made ${bomCode(product.item.sku, b!.version)} for ${product.item.name}: ${input.lines.length} components` })
      return b!.id
    })
    return reply.code(201).send({ bom: await bomDetail(db, ws.id, id) })
  })

  /** Editing in place. Work orders already made keep their own copy of the materials. */
  app.put('/boms/:id', manage, async (req) => {
    const id = idOf(req.params, 'bill of materials')
    const input = parse(BomInput, req.body)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const [b] = await tx.select().from(boms).where(and(eq(boms.id, id), eq(boms.workspaceId, ws.id))).for('update')
      if (!b) throw new HttpError(404, 'not-found', 'That bill of materials doesn’t exist.')
      if (b.itemId !== input.itemId) throw new HttpError(400, 'invalid', 'A bill of materials can’t change product. Make a new one for the other product.', 'itemId')
      const product = await checkBom(tx, ws, input)
      if (input.active && !b.active) await tx.update(boms).set({ active: false, updatedAt: new Date() }).where(and(eq(boms.itemId, b.itemId), eq(boms.active, true)))
      await tx.update(boms).set({ outputQty: input.outputQty, active: input.active, notes: input.notes ?? null, qcChecks: input.qcChecks, updatedAt: new Date() }).where(eq(boms.id, id))
      await tx.delete(bomLines).where(eq(bomLines.bomId, id))
      await tx.delete(bomOperations).where(eq(bomOperations.bomId, id))
      await writeBomLines(tx, ws.id, id, input)
      await audit(tx, req, { action: 'bom.updated', entity: 'bom', entityId: id, summary: `Edited ${bomCode(product.item.sku, b.version)}` })
    })
    return { bom: await bomDetail(db, ws.id, id) }
  })

  app.delete('/boms/:id', manage, async (req, reply) => {
    const id = idOf(req.params, 'bill of materials')
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const [b] = await tx.select().from(boms).where(and(eq(boms.id, id), eq(boms.workspaceId, ws.id)))
      if (!b) throw new HttpError(404, 'not-found', 'That bill of materials doesn’t exist.')
      const [used] = await tx.select({ id: workOrders.id }).from(workOrders).where(eq(workOrders.bomId, id)).limit(1)
      if (used) throw new HttpError(409, 'in-use', 'Work orders were made from this bill of materials, so it stays on record. Turn it off instead.')
      await tx.delete(boms).where(eq(boms.id, id))
      await audit(tx, req, { action: 'bom.deleted', entity: 'bom', entityId: id, summary: `Deleted version ${b.version} of a bill of materials` })
    })
    return reply.code(204).send()
  })

  /* ---------- work orders ---------- */

  app.get('/work-orders', view, async (req) => {
    const q = parse(z.object({ status: z.enum(['open', 'draft', 'released', 'in_progress', 'completed', 'cancelled']).optional(), itemId: z.uuid().optional() }), req.query)
    const status = q.status === 'open' ? inArray(workOrders.status, [...OPEN_WO_STATUSES]) : q.status ? eq(workOrders.status, q.status) : undefined
    return { workOrders: await woSummaries(db, workspaceOf(req).id, and(status, q.itemId ? eq(workOrders.itemId, q.itemId) : undefined)) }
  })

  app.get('/work-orders/:id', view, async (req) => ({ workOrder: await woDetail(db, workspaceOf(req).id, idOf(req.params, 'work order')) }))

  app.post('/work-orders', manage, async (req, reply) => {
    const input = parse(WorkOrderInput, req.body)
    const ws = workspaceOf(req)
    const id = await db.transaction(async (tx) => {
      const plan = await planWo(tx, ws, input)
      const [w] = await tx
        .insert(workOrders)
        .values({
          workspaceId: ws.id,
          bomId: plan.bom.id,
          itemId: input.itemId,
          quantity: input.quantity,
          warehouseId: input.warehouseId,
          startDate: input.startDate,
          dueDate: input.dueDate,
          salesOrderId: input.salesOrderId ?? null,
          notes: input.notes ?? null,
          qcChecks: plan.bom.qcChecks,
          createdBy: userOf(req).id,
        })
        .returning()
      await writeWoPlan(tx, ws.id, w!.id, plan)
      const [item] = await tx.select({ name: items.name }).from(items).where(eq(items.id, input.itemId))
      await audit(tx, req, { action: 'wo.drafted', entity: 'work_order', entityId: w!.id, summary: `Drafted a work order for ${input.quantity} × ${item!.name}, due ${input.dueDate}` })
      return w!.id
    })
    return reply.code(201).send({ workOrder: await woDetail(db, ws.id, id) })
  })

  app.put('/work-orders/:id', manage, async (req) => {
    const id = idOf(req.params, 'work order')
    const input = parse(WorkOrderInput, req.body)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const w = await lockWo(tx, ws.id, id)
      if (w.status !== 'draft' && w.status !== 'released') throw new HttpError(409, 'locked', 'A started work order can’t be edited.')
      const plan = await planWo(tx, ws, input)
      await tx.delete(woMaterials).where(eq(woMaterials.workOrderId, id))
      await tx.delete(woOperations).where(eq(woOperations.workOrderId, id))
      await writeWoPlan(tx, ws.id, id, plan)
      await tx
        .update(workOrders)
        .set({ bomId: plan.bom.id, itemId: input.itemId, quantity: input.quantity, warehouseId: input.warehouseId, startDate: input.startDate, dueDate: input.dueDate, salesOrderId: input.salesOrderId ?? null, notes: input.notes ?? null, qcChecks: plan.bom.qcChecks, updatedAt: new Date() })
        .where(eq(workOrders.id, id))
      await audit(tx, req, { action: 'wo.edited', entity: 'work_order', entityId: id, summary: `Edited ${w.number ?? 'a draft work order'}: ${input.quantity} units, due ${input.dueDate}` })
    })
    return { workOrder: await woDetail(db, ws.id, id) }
  })

  app.delete('/work-orders/:id', manage, async (req, reply) => {
    const id = idOf(req.params, 'work order')
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const w = await lockWo(tx, ws.id, id)
      if (w.status !== 'draft') throw new HttpError(409, 'locked', 'Only a draft can be deleted. Cancel a released work order instead.')
      await tx.delete(workOrders).where(eq(workOrders.id, id))
      await audit(tx, req, { action: 'wo.deleted', entity: 'work_order', entityId: id, summary: 'Deleted a draft work order' })
    })
    return reply.code(204).send()
  })

  /** Releasing gives it its number and puts it on the floor's list. */
  app.post('/work-orders/:id/release', manage, async (req) => {
    const id = idOf(req.params, 'work order')
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const w = await lockWo(tx, ws.id, id)
      if (w.status !== 'draft') throw new HttpError(409, 'locked', 'Only a draft can be released.')
      const number = await nextNumber(tx, ws.id, 'work_order')
      await tx.update(workOrders).set({ status: 'released', number, updatedAt: new Date() }).where(eq(workOrders.id, id))
      await audit(tx, req, { action: 'wo.released', entity: 'work_order', entityId: id, summary: `Released ${number} (${w.quantity} units, due ${w.dueDate})` })
    })
    return { workOrder: await woDetail(db, ws.id, id) }
  })

  /** Starting takes the materials out of stock into Work in Process. A draft is released on the way. */
  app.post('/work-orders/:id/start', manage, async (req) => {
    const id = idOf(req.params, 'work order')
    const input = parse(WoStartInput, req.body)
    const ws = workspaceOf(req)
    const mats = await db.select({ itemId: woMaterials.itemId }).from(woMaterials).where(eq(woMaterials.workOrderId, id))
    const before = new Map<string, number>()
    for (const m of mats) before.set(m.itemId, (await itemTotals(db, m.itemId)).qty)
    await db.transaction(async (tx) => {
      const w = await lockWo(tx, ws.id, id)
      if (w.status !== 'draft' && w.status !== 'released') throw new HttpError(409, 'locked', w.status === 'in_progress' ? 'It has already started.' : 'This work order is finished.')
      const number = w.number ?? (await nextNumber(tx, ws.id, 'work_order'))
      const lines = await tx.select({ m: woMaterials, name: items.name }).from(woMaterials).innerJoin(items, eq(items.id, woMaterials.itemId)).where(eq(woMaterials.workOrderId, id)).orderBy(asc(woMaterials.position))
      const given = new Map(input.materials.map((m) => [m.materialId, m]))
      for (const m of input.materials) if (!lines.some((l) => l.m.id === m.materialId)) throw new HttpError(400, 'invalid', 'That material isn’t on this work order.', 'materials')
      let total = 0
      for (const { m, name } of lines) {
        const use = given.get(m.id)
        const quantity = use ? use.quantity : m.plannedQty
        if (quantity <= 0) continue
        const item = await lockStockItem(tx, ws.id, m.itemId)
        const value = await stockOut(tx, ws, { item, warehouseId: w.warehouseId, quantity, lotNo: use?.lotNo, kind: 'consume', date: input.date, workOrderId: id, line: name })
        await tx.update(woMaterials).set({ issuedQty: quantity, issuedValue: value }).where(eq(woMaterials.id, m.id))
        total += value
      }
      if (total > 0) {
        const [inventory, wip] = [await systemAccount(tx, ws.id, 'inventory'), await systemAccount(tx, ws.id, 'wip')]
        await postEntry(tx, { workspaceId: ws.id, date: input.date, memo: `${number}: materials into production`, source: 'production', sourceId: id, createdBy: userOf(req).id }, [
          { accountId: wip, debit: total },
          { accountId: inventory, credit: total },
        ])
      }
      await tx.update(workOrders).set({ status: 'in_progress', number, materialCost: total, startedAt: new Date(), updatedAt: new Date() }).where(eq(workOrders.id, id))
      await audit(tx, req, { action: 'wo.started', entity: 'work_order', entityId: id, summary: `Started ${number}: materials worth ${formatPeso(total)} into production` })
    })
    await warnLow(ws, before)
    return { workOrder: await woDetail(db, ws.id, id) }
  })

  /** Completing: labour and overhead applied, the good units into stock, the rejects written off. */
  app.post('/work-orders/:id/complete', manage, async (req) => {
    const id = idOf(req.params, 'work order')
    const input = parse(WoCompleteInput, req.body)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const w = await lockWo(tx, ws.id, id)
      if (w.status !== 'in_progress') throw new HttpError(409, 'locked', w.status === 'completed' ? 'It’s already complete.' : 'Start the work order first: that takes its materials out of stock.')
      // quality control: every check answered, and a reason for each that failed
      if (input.qc.length !== w.qcChecks.length) throw new HttpError(400, 'qc', `Record all ${w.qcChecks.length} quality checks.`, 'qc')
      const qc: QcResult[] = w.qcChecks.map((check, i) => ({ check, passed: input.qc[i]!.passed, note: input.qc[i]!.note ?? null }))
      const failed = qc.filter((c) => !c.passed)
      if (failed.some((c) => !c.note)) throw new HttpError(400, 'qc', 'Say what went wrong for each check that failed.', 'qc')
      if (failed.length && input.rejectedQty <= 0) throw new HttpError(400, 'qc', 'A check failed: enter how many units were rejected.', 'rejectedQty')

      const item = await lockStockItem(tx, ws.id, w.itemId)
      const [unit] = await tx.select({ code: units.code }).from(units).where(eq(units.id, item.unitId))
      const lot = input.goodQty > 0 ? await lotForReceipt(tx, ws, item, input.lotNo, input.expiryDate, item.name, { hold: true }) : null

      // labour and overhead, at the minutes actually spent (or the routing's)
      const ops = await tx.select().from(woOperations).where(eq(woOperations.workOrderId, id))
      const minutes = new Map(input.operations.map((o) => [o.operationId, o.minutes]))
      let conversion = 0
      for (const o of ops) {
        const actual = minutes.get(o.id) ?? o.plannedMinutes
        const cost = opCost(actual, o.costPerHour)
        conversion += cost
        await tx.update(woOperations).set({ actualMinutes: actual, cost }).where(eq(woOperations.id, o.id))
      }

      const total = w.materialCost + conversion
      const made = input.goodQty + input.rejectedQty
      const goodValue = Math.round((total * input.goodQty) / made)
      const rejectValue = total - goodValue
      if (input.goodQty > 0) {
        await stockIn(tx, ws, { item, warehouseId: w.warehouseId, lotId: lot?.id ?? null, quantity: input.goodQty, value: goodValue, kind: 'produce', date: input.date, workOrderId: id })
      }
      const scrap = rejectValue > 0 ? ((await systemAccountIfAny(tx, ws.id, 'spoilage')) ?? (await systemAccount(tx, ws.id, 'inventory_adjustments'))) : null
      await postEntry(
        tx,
        { workspaceId: ws.id, date: input.date, memo: `${w.number}: ${input.goodQty} ${unit?.code ?? ''} of ${item.name} made${input.rejectedQty ? `, ${input.rejectedQty} rejected` : ''}`, source: 'production', sourceId: id, createdBy: userOf(req).id },
        [
          { accountId: await systemAccount(tx, ws.id, 'inventory'), debit: goodValue, description: 'Finished goods into stock' },
          ...(scrap ? [{ accountId: scrap, debit: rejectValue, description: 'Rejected in quality control' }] : []),
          { accountId: await systemAccount(tx, ws.id, 'applied_overhead'), credit: conversion, description: 'Labour and overhead applied' },
          { accountId: await systemAccount(tx, ws.id, 'wip'), credit: w.materialCost, description: 'Out of work in process' },
        ],
      )
      await tx
        .update(workOrders)
        .set({ status: 'completed', goodQty: input.goodQty, rejectedQty: input.rejectedQty, qc, lotId: lot?.id ?? null, conversionCost: conversion, notes: input.notes ?? w.notes, completedAt: new Date(), updatedAt: new Date() })
        .where(eq(workOrders.id, id))
      await audit(tx, req, {
        action: 'wo.completed',
        entity: 'work_order',
        entityId: id,
        summary: `Completed ${describe(w, item.name, input.goodQty, unit?.code ?? '')}${input.rejectedQty ? `; ${input.rejectedQty} rejected (${failed.map((c) => c.check).join('; ') || 'no check failed'})` : ''}`,
      })
    })
    return { workOrder: await woDetail(db, ws.id, id) }
  })

  /** Cancelling. A started one puts its materials back, at what they were taken out at. */
  app.post('/work-orders/:id/cancel', manage, async (req) => {
    const id = idOf(req.params, 'work order')
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const w = await lockWo(tx, ws.id, id)
      if (w.status === 'completed' || w.status === 'cancelled') throw new HttpError(409, 'locked', 'This work order is finished.')
      const date = todayInManila()
      if (w.status === 'in_progress') {
        const taken = await tx.select().from(stockMoves).where(and(eq(stockMoves.workOrderId, id), eq(stockMoves.kind, 'consume')))
        for (const m of taken) {
          const item = await lockStockItem(tx, ws.id, m.itemId)
          await stockIn(tx, ws, { item, warehouseId: m.warehouseId, lotId: m.lotId, quantity: -m.quantity, value: -m.value, kind: 'return', date, workOrderId: id })
        }
        if (w.materialCost > 0) {
          await postEntry(tx, { workspaceId: ws.id, date, memo: `${w.number}: cancelled, materials back to stock`, source: 'production', sourceId: id, createdBy: userOf(req).id }, [
            { accountId: await systemAccount(tx, ws.id, 'inventory'), debit: w.materialCost },
            { accountId: await systemAccount(tx, ws.id, 'wip'), credit: w.materialCost },
          ])
        }
        await tx.update(woMaterials).set({ issuedQty: 0, issuedValue: 0 }).where(eq(woMaterials.workOrderId, id))
      }
      await tx.update(workOrders).set({ status: 'cancelled', materialCost: 0, updatedAt: new Date() }).where(eq(workOrders.id, id))
      await audit(tx, req, { action: 'wo.cancelled', entity: 'work_order', entityId: id, summary: `Cancelled ${w.number ?? 'a work order'}${w.status === 'in_progress' ? ', materials returned to stock' : ''}` })
    })
    return { workOrder: await woDetail(db, ws.id, id) }
  })

  /* ---------- planning and overview ---------- */

  app.get('/mrp', view, async (req) => ({ plan: await mrpPlan(db, workspaceOf(req).id) }))

  /** Buy suggestions become draft purchase orders, one per supplier, for the buyer to check and issue. */
  app.post('/mrp/purchase-orders', needs('purchasing.manage', 'manufacturing'), async (req, reply) => {
    const input = parse(MrpBuyInput, req.body)
    const ws = workspaceOf(req)
    const date = todayInManila()
    const made: { id: string; supplier: string }[] = []
    await db.transaction(async (tx) => {
      for (const supplierId of new Set(input.lines.map((l) => l.supplierId))) {
        const lines = input.lines.filter((l) => l.supplierId === supplierId).map((l) => ({ itemId: l.itemId, quantity: l.quantity, unitCost: l.unitCost, vat: ws.vatStatus === 'vat' ? ('vatable' as const) : ('none' as const) }))
        const prepared = await preparePo(tx, ws, { supplierId, date, expectedDate: null, warehouseId: input.warehouseId, pricesIncludeVat: false, notes: 'From the production plan (MRP)', lines })
        const [po] = await tx
          .insert(purchaseOrders)
          .values({ workspaceId: ws.id, supplierId, date, warehouseId: input.warehouseId, pricesIncludeVat: false, notes: 'From the production plan (MRP)', ...prepared.totals, createdBy: userOf(req).id })
          .returning()
        await tx.insert(purchaseOrderLines).values(prepared.lines.map((l) => ({ ...l, workspaceId: ws.id, poId: po!.id })))
        await audit(tx, req, { action: 'po.drafted', entity: 'purchase_order', entityId: po!.id, summary: `Drafted a purchase order to ${prepared.supplier.name} from the production plan (${formatPeso(prepared.totals.total)})` })
        made.push({ id: po!.id, supplier: prepared.supplier.name })
      }
    })
    return reply.code(201).send({ purchaseOrders: made })
  })

  app.get('/manufacturing/overview', view, async (req): Promise<{ overview: ManufacturingOverview }> => {
    const ws = workspaceOf(req)
    const today = todayInManila()
    const open = await woSummaries(db, ws.id, inArray(workOrders.status, [...OPEN_WO_STATUSES]))
    const monthStart = `${today.slice(0, 8)}01`
    const [month] = await db
      .select({ good: sql<number>`coalesce(sum(${workOrders.goodQty}), 0)`.mapWith(Number), rejected: sql<number>`coalesce(sum(${workOrders.rejectedQty}), 0)`.mapWith(Number) })
      .from(workOrders)
      .where(and(eq(workOrders.workspaceId, ws.id), eq(workOrders.status, 'completed'), gte(workOrders.completedAt, new Date(`${monthStart}T00:00:00+08:00`))))
    const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10)
    // minutes booked at each work centre by open work orders starting in the next two weeks (or overdue)
    const centres = await db.select().from(workCenters).where(and(eq(workCenters.workspaceId, ws.id), eq(workCenters.active, true))).orderBy(asc(workCenters.code))
    const booked = await db
      .select({ id: woOperations.workCenterId, minutes: sql<number>`sum(${woOperations.plannedMinutes})`.mapWith(Number) })
      .from(woOperations)
      .innerJoin(workOrders, eq(workOrders.id, woOperations.workOrderId))
      .where(and(eq(workOrders.workspaceId, ws.id), inArray(workOrders.status, [...OPEN_WO_STATUSES]), lte(workOrders.startDate, horizon)))
      .groupBy(woOperations.workCenterId)
    const minutesAt = new Map(booked.map((b) => [b.id, b.minutes]))
    const load = centres.map((c) => ({ id: c.id, code: c.code, name: c.name, minutes: minutesAt.get(c.id) ?? 0 }))
    const plan = await mrpPlan(db, ws.id)
    return {
      overview: {
        open: open.length,
        inProgress: open.filter((w) => w.status === 'in_progress').length,
        late: open.filter((w) => w.late).length,
        madeThisMonth: q4(month?.good ?? 0),
        rejectedThisMonth: q4(month?.rejected ?? 0),
        load: load.map((l) => ({ workCenter: { id: l.id, code: l.code, name: l.name }, minutes: Math.round(l.minutes) })),
        dueSoon: open.slice(0, 8),
        toMake: plan.rows.filter((r) => r.suggested > 0 && r.action === 'make').length,
        toBuy: plan.rows.filter((r) => r.suggested > 0 && r.action === 'buy').length,
      },
    }
  })
}
