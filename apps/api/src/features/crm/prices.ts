import { PriceListInput, type PriceList, type QuotedPrice } from '@erp/shared'
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db, isUniqueViolation } from '../../db/client.ts'
import { contacts, items, priceListLines, priceLists, units } from '../../db/schema.ts'
import type { Executor } from '../../db/types.ts'
import { audit } from '../../lib/audit.ts'
import { HttpError, parse } from '../../lib/errors.ts'
import { needs, workspaceOf } from '../../lib/workspace.ts'

/**
 * Price lists (Phase 8, from the Wholesale pack; any workspace can use them). A customer on a list
 * gets its prices, with quantity breaks; everything else sells at the item's own price. The price
 * fills in on quotes, orders and invoices, and can still be changed there.
 */

/** A price list named on a customer must be this workspace's. */
export async function checkPriceList(dbx: Executor, workspaceId: string, id: string | null | undefined) {
  if (!id) return id
  const [p] = await dbx.select({ id: priceLists.id }).from(priceLists).where(and(eq(priceLists.id, id), eq(priceLists.workspaceId, workspaceId)))
  if (!p) throw new HttpError(400, 'invalid', 'Choose a price list in this workspace.', 'priceListId')
  return id
}

/** What an item sells for to a customer at a quantity: their list's best break reached, else the item's price. */
export async function priceFor(dbx: Executor, workspaceId: string, itemId: string, customerId: string | null, quantity: number): Promise<QuotedPrice> {
  const [item] = await dbx.select({ price: items.salesPrice }).from(items).where(and(eq(items.id, itemId), eq(items.workspaceId, workspaceId)))
  if (!item) throw new HttpError(404, 'not-found', 'That item doesn’t exist.')
  if (customerId) {
    const [row] = await dbx
      .select({ price: priceListLines.price, list: priceLists.name })
      .from(contacts)
      .innerJoin(priceLists, and(eq(priceLists.id, contacts.priceListId), eq(priceLists.active, true)))
      .innerJoin(priceListLines, and(eq(priceListLines.priceListId, priceLists.id), eq(priceListLines.itemId, itemId), lte(priceListLines.minQty, quantity)))
      .where(and(eq(contacts.id, customerId), eq(contacts.workspaceId, workspaceId)))
      .orderBy(desc(priceListLines.minQty))
      .limit(1)
    if (row) return { price: row.price, source: 'list', priceList: row.list }
  }
  return { price: item.price, source: 'item', priceList: null }
}

async function listDetail(dbx: Executor, workspaceId: string, id: string): Promise<PriceList> {
  const [p] = await dbx.select().from(priceLists).where(and(eq(priceLists.id, id), eq(priceLists.workspaceId, workspaceId)))
  if (!p) throw new HttpError(404, 'not-found', 'That price list doesn’t exist.')
  const [n] = await dbx.select({ n: sql<number>`count(*)::int` }).from(contacts).where(eq(contacts.priceListId, id))
  const lines = await dbx
    .select({ l: priceListLines, item: { id: items.id, sku: items.sku, name: items.name, salesPrice: items.salesPrice }, unit: units.code })
    .from(priceListLines)
    .innerJoin(items, eq(items.id, priceListLines.itemId))
    .innerJoin(units, eq(units.id, items.unitId))
    .where(eq(priceListLines.priceListId, id))
    .orderBy(asc(items.name), asc(priceListLines.minQty))
  return { id: p.id, name: p.name, notes: p.notes, active: p.active, customerCount: n?.n ?? 0, lines: lines.map((r) => ({ id: r.l.id, item: { ...r.item, unit: r.unit }, minQty: r.l.minQty, price: r.l.price })) }
}

export default async function priceRoutes(app: FastifyInstance) {
  const view = needs('crm.view', 'crm')
  const manage = needs('crm.manage', 'crm')

  app.get('/price-lists', view, async (req) => {
    const ws = workspaceOf(req)
    const rows = await db.select({ id: priceLists.id }).from(priceLists).where(eq(priceLists.workspaceId, ws.id)).orderBy(asc(priceLists.name))
    const out: PriceList[] = []
    for (const r of rows) out.push(await listDetail(db, ws.id, r.id))
    return { priceLists: out }
  })

  app.get('/price-lists/:id', view, async (req) => ({ priceList: await listDetail(db, workspaceOf(req).id, z.object({ id: z.uuid() }).parse(req.params).id) }))

  async function save(workspaceId: string, input: z.output<typeof PriceListInput>, id: string | null) {
    const ids = [...new Set(input.lines.map((l) => l.itemId))]
    if (ids.length) {
      const found = await db.select({ id: items.id }).from(items).where(and(eq(items.workspaceId, workspaceId), inArray(items.id, ids)))
      if (found.length !== ids.length) throw new HttpError(400, 'invalid', 'Choose items in this workspace.', 'lines')
    }
    const keys = input.lines.map((l) => `${l.itemId}:${l.minQty}`)
    if (new Set(keys).size !== keys.length) throw new HttpError(400, 'invalid', 'An item has the same quantity break twice.', 'lines')
    try {
      return await db.transaction(async (tx) => {
        let listId = id
        if (listId) await tx.update(priceLists).set({ name: input.name, notes: input.notes ?? null, active: input.active, updatedAt: new Date() }).where(eq(priceLists.id, listId))
        else listId = (await tx.insert(priceLists).values({ workspaceId, name: input.name, notes: input.notes ?? null, active: input.active }).returning())[0]!.id
        await tx.delete(priceListLines).where(eq(priceListLines.priceListId, listId))
        if (input.lines.length) await tx.insert(priceListLines).values(input.lines.map((l) => ({ workspaceId, priceListId: listId!, itemId: l.itemId, minQty: l.minQty, price: l.price })))
        return listId
      })
    } catch (e) {
      if (isUniqueViolation(e, 'price_lists_name_key')) throw new HttpError(409, 'taken', 'There’s already a price list with that name.', 'name')
      throw e
    }
  }

  app.post('/price-lists', manage, async (req, reply) => {
    const input = parse(PriceListInput, req.body)
    const ws = workspaceOf(req)
    const id = await save(ws.id, input, null)
    await db.transaction((tx) => audit(tx, req, { action: 'price_list.created', entity: 'price_list', entityId: id, summary: `Made price list “${input.name}” (${input.lines.length} prices)` }))
    return reply.code(201).send({ priceList: await listDetail(db, ws.id, id) })
  })

  app.put('/price-lists/:id', manage, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params)
    const input = parse(PriceListInput, req.body)
    const ws = workspaceOf(req)
    await listDetail(db, ws.id, id)
    await save(ws.id, input, id)
    await db.transaction((tx) => audit(tx, req, { action: 'price_list.updated', entity: 'price_list', entityId: id, summary: `Edited price list “${input.name}” (${input.lines.length} prices)` }))
    return { priceList: await listDetail(db, ws.id, id) }
  })

  /** The price to fill in on a quote, order or invoice line. */
  app.get('/sales/price', needs('member'), async (req) => {
    const q = parse(z.object({ itemId: z.uuid(), customerId: z.uuid().optional(), quantity: z.coerce.number().min(0).default(1) }), req.query)
    return { price: await priceFor(db, workspaceOf(req).id, q.itemId, q.customerId ?? null, q.quantity) }
  })
}
