import { AdjustmentInput, checkAttributes, ContactInput, ImportInput, IMPORT_KINDS, ItemInput, parsePeso, templateByKey, type ImportKind, type ImportResult } from '@erp/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db, isUniqueViolation } from '../../db/client.ts'
import { contacts, items, units, warehouses, type WorkspaceRow } from '../../db/schema.ts'
import type { Tx } from '../../db/types.ts'
import { audit } from '../../lib/audit.ts'
import { HttpError, parse } from '../../lib/errors.ts'
import { can, needs, workspaceOf } from '../../lib/workspace.ts'
import { todayInManila } from '../finance/ledger.ts'
import { postAdjustment } from '../inventory/routes.ts'

/**
 * Excel import (Phase 9). Rows arrive as text keyed by column (shared/imports.ts). Each is turned into
 * the same input the forms send and checked with the same rules; then everything is saved in one
 * transaction, or nothing is. A dry run does all of it and rolls back, so the person sees every
 * problem before anything is saved.
 */

type Row = Record<string, string>
type Problem = { row: number; message: string }

const yes = (v: string | undefined) => /^(y|yes|true|1|oo)$/i.test((v ?? '').trim())
const blank = (v: string | undefined) => !v || !v.trim()
const num = (v: string | undefined) => (blank(v) ? undefined : Number(String(v).replace(/,/g, '')))
const money = (v: string | undefined) => (blank(v) ? 0 : parsePeso(String(v)))
/** The first message of a failed parse, with the field it's about. */
const firstIssue = (e: z.ZodError) => {
  const i = e.issues[0]!
  return `${i.path.length ? `${String(i.path[0])}: ` : ''}${i.message}`
}

class Rollback extends Error {}

async function importItems(tx: Tx, ws: WorkspaceRow, rows: Row[], problems: Problem[]) {
  const unitRows = await tx.select().from(units).where(eq(units.workspaceId, ws.id))
  const unitByCode = new Map(unitRows.map((u) => [u.code.toLowerCase(), u.id]))
  const fields = templateByKey(ws.template)?.itemFields ?? []
  const prepared: { row: number; input: z.output<typeof ItemInput> }[] = []
  const seen = new Map<string, number>()
  rows.forEach((r, i) => {
    const row = i + 2
    const unitId = unitByCode.get((r.unit ?? '').trim().toLowerCase())
    if (!unitId) return problems.push({ row, message: `Unit “${r.unit ?? ''}” isn’t one of this workspace’s (${unitRows.map((u) => u.code).join(', ')}).` })
    const salesPrice = money(r.salesPrice)
    const purchaseCost = money(r.purchaseCost)
    if (salesPrice === null || purchaseCost === null) return problems.push({ row, message: 'Prices are amounts in pesos, like 1,500.00.' })
    const attrs = Object.fromEntries(Object.entries(r).filter(([k, v]) => k.startsWith('attr:') && !blank(v)).map(([k, v]) => [k.slice(5), v.trim()]))
    const checked = checkAttributes(fields, attrs)
    if ('key' in checked) return problems.push({ row, message: checked.message })
    const parsed = ItemInput.safeParse({
      sku: r.sku,
      name: r.name,
      kind: blank(r.kind) ? 'stock' : r.kind!.trim().toLowerCase(),
      unitId,
      salesPrice,
      purchaseCost,
      barcode: r.barcode,
      reorderPoint: num(r.reorderPoint) ?? 0,
      reorderQty: num(r.reorderQty) ?? 0,
      trackLots: yes(r.trackLots) || yes(r.trackExpiry),
      trackExpiry: yes(r.trackExpiry),
      attributes: checked.ok,
    })
    if (!parsed.success) return problems.push({ row, message: firstIssue(parsed.error) })
    const twice = seen.get(parsed.data.sku)
    if (twice) return problems.push({ row, message: `SKU ${parsed.data.sku} is also on row ${twice}.` })
    seen.set(parsed.data.sku, row)
    prepared.push({ row, input: parsed.data })
  })
  if (problems.length) return { created: 0, updated: 0 }

  const existing = new Map((await tx.select().from(items).where(and(eq(items.workspaceId, ws.id), inArray(items.sku, prepared.map((p) => p.input.sku))))).map((i) => [i.sku, i]))
  let created = 0
  let updated = 0
  for (const { row, input } of prepared) {
    const before = existing.get(input.sku)
    try {
      if (before) {
        // what it is and how it's counted stay as they are; names, prices and settings are updated
        await tx
          .update(items)
          .set({ name: input.name, salesPrice: input.salesPrice, purchaseCost: input.purchaseCost, barcode: input.barcode ?? before.barcode, reorderPoint: input.reorderPoint, reorderQty: input.reorderQty, attributes: { ...before.attributes, ...input.attributes }, updatedAt: new Date() })
          .where(eq(items.id, before.id))
        updated++
      } else {
        await tx.insert(items).values({ ...input, workspaceId: ws.id, description: null, barcode: input.barcode ?? null })
        created++
      }
    } catch (e) {
      if (isUniqueViolation(e, 'items_barcode_key')) throw new HttpError(409, 'import-failed', `Row ${row}: another item already has barcode ${input.barcode}.`)
      throw e
    }
  }
  return { created, updated }
}

async function importContacts(tx: Tx, ws: WorkspaceRow, rows: Row[], problems: Problem[]) {
  const prepared: { row: number; input: z.output<typeof ContactInput> }[] = []
  const seen = new Map<string, number>()
  rows.forEach((r, i) => {
    const row = i + 2
    const type = (r.type ?? '').trim().toLowerCase()
    if (!['customer', 'supplier', 'both'].includes(type)) return problems.push({ row, message: 'Type is customer, supplier or both.' })
    const creditLimit = blank(r.creditLimit) ? null : parsePeso(r.creditLimit!)
    if (creditLimit === null && !blank(r.creditLimit)) return problems.push({ row, message: 'The credit limit is an amount in pesos.' })
    const parsed = ContactInput.safeParse({
      name: r.name,
      tin: r.tin,
      address: r.address,
      email: r.email,
      phone: r.phone,
      isCustomer: type !== 'supplier',
      isSupplier: type !== 'customer',
      paymentTermsDays: num(r.paymentTermsDays) ?? null,
      creditLimit,
    })
    if (!parsed.success) return problems.push({ row, message: firstIssue(parsed.error) })
    const key = parsed.data.name.toLowerCase()
    if (seen.has(key)) return problems.push({ row, message: `${parsed.data.name} is also on row ${seen.get(key)}.` })
    seen.set(key, row)
    prepared.push({ row, input: parsed.data })
  })
  if (problems.length) return { created: 0, updated: 0 }
  const existing = new Map(
    (await tx.select().from(contacts).where(and(eq(contacts.workspaceId, ws.id), inArray(sql`lower(${contacts.name})`, prepared.map((p) => p.input.name.toLowerCase()))))).map((c) => [c.name.toLowerCase(), c]),
  )
  let created = 0
  let updated = 0
  for (const { input } of prepared) {
    const values = { name: input.name, tin: input.tin ?? null, address: input.address ?? null, email: input.email ?? null, phone: input.phone ?? null, paymentTermsDays: input.paymentTermsDays ?? null, creditLimit: input.creditLimit ?? null }
    const before = existing.get(input.name.toLowerCase())
    if (before) {
      // the same name is the same contact: details updated, and it may become both customer and supplier
      await tx.update(contacts).set({ ...values, isCustomer: before.isCustomer || input.isCustomer, isSupplier: before.isSupplier || input.isSupplier, updatedAt: new Date() }).where(eq(contacts.id, before.id))
      updated++
    } else {
      await tx.insert(contacts).values({ ...values, workspaceId: ws.id, isCustomer: input.isCustomer, isSupplier: input.isSupplier })
      created++
    }
  }
  return { created, updated }
}

async function importOpeningStock(tx: Tx, req: FastifyRequest, ws: WorkspaceRow, rows: Row[], date: string, problems: Problem[]) {
  const whs = await tx.select().from(warehouses).where(eq(warehouses.workspaceId, ws.id))
  const whByCode = new Map(whs.map((w) => [w.code.toLowerCase(), w]))
  const skus = [...new Set(rows.map((r) => (r.sku ?? '').trim().toUpperCase()))]
  const itemBySku = new Map((await tx.select().from(items).where(and(eq(items.workspaceId, ws.id), inArray(items.sku, skus)))).map((i) => [i.sku, i]))
  // one opening adjustment per warehouse, remembering which sheet row each line came from
  const groups = new Map<string, { rows: number[]; lines: z.input<typeof AdjustmentInput>['lines'] }>()
  rows.forEach((r, i) => {
    const row = i + 2
    const item = itemBySku.get((r.sku ?? '').trim().toUpperCase())
    if (!item) return problems.push({ row, message: `No item with SKU ${r.sku ?? ''}. Import the items first.` })
    const wh = blank(r.warehouse) ? whs[0] : whByCode.get(r.warehouse!.trim().toLowerCase())
    if (!wh) return problems.push({ row, message: `No warehouse with code ${r.warehouse}.` })
    const quantity = num(r.quantity)
    if (!(quantity! > 0)) return problems.push({ row, message: 'The quantity must be more than zero.' })
    const unitCost = parsePeso(r.unitCost ?? '')
    if (unitCost === null) return problems.push({ row, message: 'The unit cost is an amount in pesos, like 1,050.00.' })
    const g = groups.get(wh.id) ?? { rows: [], lines: [] }
    g.rows.push(row)
    g.lines.push({ itemId: item.id, change: quantity!, unitCost, lotNo: blank(r.lotNo) ? undefined : r.lotNo!.trim(), expiryDate: blank(r.expiryDate) ? undefined : r.expiryDate!.trim() })
    groups.set(wh.id, g)
  })
  if (problems.length) return { created: 0, updated: 0 }
  let created = 0
  for (const [warehouseId, g] of groups) {
    const input = AdjustmentInput.safeParse({ date, warehouseId, reason: 'opening', notes: 'Opening stock, imported from a spreadsheet', lines: g.lines })
    if (!input.success) {
      const at = input.error.issues[0]!.path
      problems.push({ row: at[0] === 'lines' && typeof at[1] === 'number' ? g.rows[at[1]]! : g.rows[0]!, message: input.error.issues[0]!.message })
      continue
    }
    try {
      await postAdjustment(tx, req, ws, input.data)
    } catch (e) {
      // "Line 3: …" from the stock engine is the third row of this warehouse's group
      const m = /^Line (\d+): ([\s\S]*)$/.exec((e as Error).message)
      if (e instanceof HttpError && m) problems.push({ row: g.rows[Number(m[1]) - 1] ?? g.rows[0]!, message: m[2]! })
      else if (e instanceof HttpError) problems.push({ row: g.rows[0]!, message: e.message })
      else throw e
      continue
    }
    created += g.lines.length
  }
  return { created, updated: 0 }
}

export default async function importRoutes(app: FastifyInstance) {
  /** Spreadsheets are bigger than forms: this route takes up to 5 MB. */
  app.post('/import/:kind', { ...needs('member'), bodyLimit: 5 * 1024 * 1024, config: { permission: 'member', rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req): Promise<{ result: ImportResult }> => {
    const kind = z.enum(IMPORT_KINDS).safeParse((req.params as { kind?: string }).kind)
    if (!kind.success) throw new HttpError(404, 'not-found', 'There’s no import of that kind.')
    const allowed: Record<ImportKind, boolean> = { items: can(req, 'inventory.manage'), contacts: can(req, 'finance.edit') || can(req, 'crm.manage'), 'opening-stock': can(req, 'inventory.manage') }
    if (!allowed[kind.data]) throw new HttpError(403, 'forbidden', 'Your role can’t import those.')
    const ws = workspaceOf(req)
    if (kind.data !== 'contacts' && !ws.modules.includes('inventory')) throw new HttpError(403, 'module-off', 'Inventory is turned off for this workspace.')
    const input = parse(ImportInput, req.body)
    const problems: Problem[] = []
    let counts = { created: 0, updated: 0 }
    try {
      await db.transaction(async (tx) => {
        if (kind.data === 'items') counts = await importItems(tx, ws, input.rows, problems)
        else if (kind.data === 'contacts') counts = await importContacts(tx, ws, input.rows, problems)
        else counts = await importOpeningStock(tx, req, ws, input.rows, input.date ?? todayInManila(), problems)
        if (problems.length || input.dryRun) throw new Rollback()
        await audit(tx, req, { action: 'import', entity: kind.data, entityId: ws.id, summary: `Imported ${kind.data.replace('-', ' ')} from a spreadsheet: ${counts.created} new, ${counts.updated} updated` })
      })
    } catch (e) {
      if (!(e instanceof Rollback)) throw e
    }
    const saved = !problems.length && !input.dryRun
    return { result: { ...(problems.length ? { created: 0, updated: 0 } : counts), errors: problems.sort((a, b) => a.row - b.row).slice(0, 200), saved } }
  })
}
