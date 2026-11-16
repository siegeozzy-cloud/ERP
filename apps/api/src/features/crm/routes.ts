import { checkPriceList } from './prices.ts'
import {
  ActivityInput,
  CustomerInput,
  formatPeso,
  LEAD_STAGE_LABELS,
  LEAD_STAGE_ODDS,
  LEAD_STAGES,
  LeadInput,
  leadName,
  LeadStageInput,
  OPEN_LEAD_STAGES,
  q4,
  type Activity,
  type CrmOverview,
  type CustomerDetail,
  type CustomerSummary,
  type Lead,
  type LeadDetail,
  type LeadStage,
  type SalesItem,
} from '@erp/shared'
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client.ts'
import { contacts, crmActivities, items, leads, memberships, payments, quotes, salesInvoices, salesLines, salesOrders, units, users, warehouses } from '../../db/schema.ts'
import { iso, type Executor } from '../../db/types.ts'
import { audit } from '../../lib/audit.ts'
import { HttpError, parse } from '../../lib/errors.ts'
import { userOf } from '../../lib/session.ts'
import { needs, workspaceOf } from '../../lib/workspace.ts'
import { settledSql } from '../finance/documents.ts'
import { todayInManila } from '../finance/ledger.ts'
import { contactOut } from '../finance/setup-routes.ts'
import { exposureOf } from './exposure.ts'
import { orderSummaries, quoteSummaries } from './sales.ts'

/** Customers, leads and their activities, the sales overview, and the items the sales side sells. */

const view = needs('crm.view', 'crm')
const manage = needs('crm.manage', 'crm')

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

const owner = alias(users, 'owner')
const leadCustomer = alias(contacts, 'lead_customer')
const lastActivity = sql<Date | null>`(select max(a.created_at) from crm_activities a where a.lead_id = ${leads.id})`.mapWith((v) => (v ? new Date(v) : null))

const leadSelect = { l: leads, ownerName: owner.name, customerName: leadCustomer.name, lastActivity }

function leadOut(r: { l: typeof leads.$inferSelect; ownerName: string | null; customerName: string | null; lastActivity: Date | null }): Lead {
  return {
    id: r.l.id,
    title: r.l.title,
    companyName: r.l.companyName,
    personName: r.l.personName,
    email: r.l.email,
    phone: r.l.phone,
    source: r.l.source as Lead['source'],
    stage: r.l.stage,
    value: r.l.value,
    expectedClose: r.l.expectedClose,
    owner: r.l.ownerId && r.ownerName ? { id: r.l.ownerId, name: r.ownerName } : null,
    customer: r.l.customerId && r.customerName ? { id: r.l.customerId, name: r.customerName } : null,
    notes: r.l.notes,
    lostReason: r.l.lostReason,
    closedAt: iso(r.l.closedAt),
    lastActivityAt: iso(r.lastActivity),
    createdAt: r.l.createdAt.toISOString(),
  }
}

async function leadRows(db: Executor, workspaceId: string, where: ReturnType<typeof and>) {
  const rows = await db
    .select(leadSelect)
    .from(leads)
    .leftJoin(owner, eq(owner.id, leads.ownerId))
    .leftJoin(leadCustomer, eq(leadCustomer.id, leads.customerId))
    .where(and(eq(leads.workspaceId, workspaceId), where))
    .orderBy(desc(leads.updatedAt))
    .limit(500)
  return rows.map(leadOut)
}

async function leadDetail(db: Executor, workspaceId: string, id: string): Promise<LeadDetail> {
  const [lead] = await leadRows(db, workspaceId, eq(leads.id, id))
  if (!lead) throw new HttpError(404, 'not-found', 'That lead doesn’t exist.')
  return { ...lead, activities: await activitiesOf(db, { leadId: id }), quotes: await quoteSummaries(db, workspaceId, { leadId: id }) }
}

async function activitiesOf(db: Executor, of: { leadId?: string; contactId?: string }): Promise<Activity[]> {
  const rows = await db
    .select({ a: crmActivities, authorName: users.name, leadTitle: leads.title })
    .from(crmActivities)
    .leftJoin(users, eq(users.id, crmActivities.createdBy))
    .leftJoin(leads, eq(leads.id, crmActivities.leadId))
    .where(
      of.leadId
        ? eq(crmActivities.leadId, of.leadId)
        : // a customer's own activities, and those on their leads
          or(eq(crmActivities.contactId, of.contactId!), inArray(crmActivities.leadId, db.select({ id: leads.id }).from(leads).where(eq(leads.customerId, of.contactId!)))),
    )
    .orderBy(desc(crmActivities.date), desc(crmActivities.createdAt))
    .limit(200)
  return rows.map((r) => ({
    id: r.a.id,
    kind: r.a.kind,
    body: r.a.body,
    date: r.a.date,
    author: r.a.createdBy && r.authorName ? { id: r.a.createdBy, name: r.authorName } : null,
    lead: r.a.leadId && r.leadTitle ? { id: r.a.leadId, title: r.leadTitle } : null,
    createdAt: r.a.createdAt.toISOString(),
  }))
}

async function customerSummaries(db: Executor, workspaceId: string, filter: { id?: string; q?: string } = {}): Promise<CustomerSummary[]> {
  const rows = await db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.workspaceId, workspaceId),
        eq(contacts.isCustomer, true),
        filter.id ? eq(contacts.id, filter.id) : undefined,
        filter.q ? or(ilike(contacts.name, like(filter.q)), ilike(contacts.tin, like(filter.q)), ilike(contacts.email, like(filter.q))) : undefined,
      ),
    )
    .orderBy(asc(contacts.name))
    .limit(500)
  const exposure = await exposureOf(db, workspaceId, filter.id)
  const openLeads = await db
    .select({ customerId: leads.customerId, n: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(eq(leads.workspaceId, workspaceId), inArray(leads.stage, [...OPEN_LEAD_STAGES])))
    .groupBy(leads.customerId)
  const leadsBy = new Map(openLeads.map((r) => [r.customerId, r.n]))
  return rows.map((c) => {
    const e = exposure.get(c.id) ?? { owed: 0, overdue: 0, onOrder: 0 }
    return { ...contactOut(c), owed: e.owed, overdue: e.overdue, onOrder: e.onOrder, openLeads: leadsBy.get(c.id) ?? 0 }
  })
}

/** A customer of this workspace. */
async function customerRow(db: Executor, workspaceId: string, id: string) {
  const [row] = await db.select().from(contacts).where(and(eq(contacts.id, id), eq(contacts.workspaceId, workspaceId), eq(contacts.isCustomer, true)))
  if (!row) throw new HttpError(404, 'not-found', 'That customer doesn’t exist.')
  return row
}

async function checkMember(db: Executor, workspaceId: string, userId: string | null | undefined) {
  if (!userId) return
  const [m] = await db.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
  if (!m) throw new HttpError(400, 'invalid', 'Choose someone in this workspace.', 'ownerId')
}

const leadValues = (input: z.output<typeof LeadInput>) => ({
  title: input.title,
  companyName: input.companyName ?? null,
  personName: input.personName ?? null,
  email: input.email ?? null,
  phone: input.phone ?? null,
  source: input.source,
  value: input.value,
  expectedClose: input.expectedClose ?? null,
  ownerId: input.ownerId ?? null,
  customerId: input.customerId ?? null,
  notes: input.notes ?? null,
})

/* ---------------------------------------------------------------------------------------------
 * Routes
 * ------------------------------------------------------------------------------------------- */

export default async function crmRoutes(app: FastifyInstance) {
  /* ---------- overview ---------- */

  app.get('/crm/overview', view, async (req): Promise<{ overview: CrmOverview }> => {
    const ws = workspaceOf(req)
    const today = todayInManila()
    const monthStart = `${today.slice(0, 7)}-01`
    const byStage = await db
      .select({ stage: leads.stage, count: sql<number>`count(*)::int`, value: sql<number>`coalesce(sum(${leads.value}), 0)::bigint`.mapWith(Number) })
      .from(leads)
      .where(and(eq(leads.workspaceId, ws.id), inArray(leads.stage, [...OPEN_LEAD_STAGES])))
      .groupBy(leads.stage)
    const pipeline = OPEN_LEAD_STAGES.map((stage) => byStage.find((r) => r.stage === stage) ?? { stage, count: 0, value: 0 })
    const [won] = await db
      .select({ count: sql<number>`count(*)::int`, value: sql<number>`coalesce(sum(${leads.value}), 0)::bigint`.mapWith(Number) })
      .from(leads)
      .where(and(eq(leads.workspaceId, ws.id), eq(leads.stage, 'won'), gte(leads.closedAt, new Date(`${monthStart}T00:00:00+08:00`))))
    const [open] = await db
      .select({ count: sql<number>`count(*)::int`, value: sql<number>`coalesce(sum(${quotes.total}), 0)::bigint`.mapWith(Number) })
      .from(quotes)
      .where(and(eq(quotes.workspaceId, ws.id), eq(quotes.status, 'sent')))
    // orders with goods still to go out, and orders with something delivered but not invoiced
    const [work] = await db
      .select({
        toDeliver: sql<number>`count(distinct ${salesOrders.id}) filter (where ${items.kind} = 'stock' and ${salesLines.deliveredQty} < ${salesLines.quantity} and ${salesOrders.status} in ('confirmed', 'partly_delivered'))::int`,
        toInvoice: sql<number>`count(distinct ${salesOrders.id}) filter (where (case when ${items.kind} = 'stock' then ${salesLines.deliveredQty} else ${salesLines.quantity} end) > ${salesLines.invoicedQty})::int`,
      })
      .from(salesOrders)
      .innerJoin(salesLines, eq(salesLines.orderId, salesOrders.id))
      .innerJoin(items, eq(items.id, salesLines.itemId))
      .where(and(eq(salesOrders.workspaceId, ws.id), inArray(salesOrders.status, ['confirmed', 'partly_delivered', 'delivered', 'closed'])))
    const [sales] = await db
      .select({ net: sql<number>`coalesce(sum(${salesInvoices.total} - ${salesInvoices.vatAmount}), 0)::bigint`.mapWith(Number) })
      .from(salesInvoices)
      .where(and(eq(salesInvoices.workspaceId, ws.id), eq(salesInvoices.status, 'posted'), gte(salesInvoices.date, monthStart), lte(salesInvoices.date, today)))
    const soon = new Date(`${today}T00:00:00Z`)
    soon.setUTCDate(soon.getUTCDate() + 14)
    const closingSoon = (await leadRows(db, ws.id, and(inArray(leads.stage, [...OPEN_LEAD_STAGES]), lte(leads.expectedClose, soon.toISOString().slice(0, 10)))))
      .sort((a, b) => (a.expectedClose ?? '').localeCompare(b.expectedClose ?? ''))
      .slice(0, 8)
    return {
      overview: {
        pipeline,
        weighted: Math.round(pipeline.reduce((s, p) => s + (p.value * LEAD_STAGE_ODDS[p.stage]) / 100, 0)),
        openQuotes: { count: open?.count ?? 0, value: open?.value ?? 0 },
        toDeliver: work?.toDeliver ?? 0,
        toInvoice: work?.toInvoice ?? 0,
        wonThisMonth: { count: won?.count ?? 0, value: won?.value ?? 0 },
        salesThisMonth: sales?.net ?? 0,
        closingSoon,
      },
    }
  })

  /** What can be sold: for the quote and order forms, without needing Inventory permissions. */
  app.get('/sales/items', view, async (req) => {
    const ws = workspaceOf(req)
    const rows = await db
      .select({ i: items, unit: units.code, onHand: sql<number>`coalesce((select sum(m.quantity) from stock_moves m where m.item_id = ${items.id}), 0)`.mapWith(Number) })
      .from(items)
      .innerJoin(units, eq(units.id, items.unitId))
      .where(and(eq(items.workspaceId, ws.id), eq(items.active, true)))
      .orderBy(asc(items.name))
    return {
      items: rows.map((r): SalesItem => ({ id: r.i.id, sku: r.i.sku, name: r.i.name, kind: r.i.kind, unit: r.unit, salesPrice: r.i.salesPrice, salesVat: r.i.salesVat, onHand: q4(r.onHand) })),
    }
  })

  /** Where orders can ship from, for the order form (sales staff don't see Inventory). */
  app.get('/sales/warehouses', view, async (req) => {
    const rows = await db
      .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name })
      .from(warehouses)
      .where(and(eq(warehouses.workspaceId, workspaceOf(req).id), eq(warehouses.active, true)))
      .orderBy(asc(warehouses.code))
    return { warehouses: rows }
  })

  /* ---------- customers ---------- */

  app.get('/crm/customers', view, async (req) => {
    const q = parse(z.object({ q: z.string().trim().max(100).optional() }), req.query)
    return { customers: await customerSummaries(db, workspaceOf(req).id, { q: q.q || undefined }) }
  })

  app.get('/crm/customers/:id', view, async (req): Promise<{ customer: CustomerDetail }> => {
    const id = idOf(req.params, 'customer')
    const ws = workspaceOf(req)
    const [summary] = await customerSummaries(db, ws.id, { id })
    if (!summary) throw new HttpError(404, 'not-found', 'That customer doesn’t exist.')
    const invoices = await db
      .select({ inv: salesInvoices, settled: settledSql(payments.invoiceId, salesInvoices.id) })
      .from(salesInvoices)
      .where(and(eq(salesInvoices.workspaceId, ws.id), eq(salesInvoices.customerId, id)))
      .orderBy(desc(salesInvoices.date), desc(salesInvoices.createdAt))
      .limit(100)
    return {
      customer: {
        ...summary,
        quotes: await quoteSummaries(db, ws.id, { customerId: id }),
        orders: await orderSummaries(db, ws.id, { customerId: id }),
        invoices: invoices.map(({ inv, settled }) => ({
          id: inv.id,
          number: inv.number,
          status: inv.status,
          date: inv.date,
          dueDate: inv.dueDate,
          total: inv.total,
          balance: inv.status === 'posted' ? inv.amountDue - settled : inv.status === 'draft' ? inv.amountDue : 0,
        })),
        leads: await leadRows(db, ws.id, eq(leads.customerId, id)),
        activities: await activitiesOf(db, { contactId: id }),
      },
    }
  })

  app.post('/crm/customers', manage, async (req, reply) => {
    const input = parse(CustomerInput, req.body)
    const ws = workspaceOf(req)
    const row = await db.transaction(async (tx) => {
      const [r] = await tx
        .insert(contacts)
        .values({
          workspaceId: ws.id,
          name: input.name,
          tin: input.tin ?? null,
          address: input.address ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          isCustomer: true,
          paymentTermsDays: input.paymentTermsDays ?? null,
          creditLimit: input.creditLimit ?? null,
          priceListId: (await checkPriceList(tx, ws.id, input.priceListId)) ?? null,
        })
        .returning()
      await audit(tx, req, { action: 'contact.created', entity: 'contact', entityId: r!.id, summary: `Added customer ${r!.name}` })
      return r!
    })
    const [summary] = await customerSummaries(db, ws.id, { id: row.id })
    return reply.code(201).send({ customer: summary })
  })

  /** Edits the customer's details and terms. A supplier flag and withholding code stay as they are. */
  app.put('/crm/customers/:id', manage, async (req) => {
    const id = idOf(req.params, 'customer')
    const input = parse(CustomerInput, req.body)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const before = await customerRow(tx, ws.id, id)
      const values = {
        name: input.name,
        tin: input.tin ?? null,
        address: input.address ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        paymentTermsDays: input.paymentTermsDays ?? null,
        creditLimit: input.creditLimit ?? null,
        priceListId: (await checkPriceList(tx, ws.id, input.priceListId)) ?? null,
      }
      await tx.update(contacts).set({ ...values, updatedAt: new Date() }).where(eq(contacts.id, id))
      const pick = (c: typeof values) => ({ name: c.name, tin: c.tin, address: c.address, email: c.email, phone: c.phone, paymentTermsDays: c.paymentTermsDays, creditLimit: c.creditLimit })
      const limitNote = before.creditLimit !== values.creditLimit ? ` (credit limit ${values.creditLimit === null ? 'removed' : formatPeso(values.creditLimit)})` : ''
      await audit(tx, req, { action: 'contact.updated', entity: 'contact', entityId: id, summary: `Edited customer ${values.name}${limitNote}`, before: pick(before), after: pick(values) })
    })
    const [summary] = await customerSummaries(db, ws.id, { id })
    return { customer: summary }
  })

  app.post('/crm/customers/:id/activities', manage, async (req, reply) => {
    const id = idOf(req.params, 'customer')
    const input = parse(ActivityInput, req.body)
    const ws = workspaceOf(req)
    const customer = await customerRow(db, ws.id, id)
    await db.transaction(async (tx) => {
      const [a] = await tx.insert(crmActivities).values({ workspaceId: ws.id, contactId: id, kind: input.kind, body: input.body, date: input.date, createdBy: userOf(req).id }).returning()
      await audit(tx, req, { action: 'activity.logged', entity: 'contact', entityId: id, summary: `Logged a ${input.kind} with ${customer.name}`, after: { activityId: a!.id } })
    })
    return reply.code(201).send({ activities: await activitiesOf(db, { contactId: id }) })
  })

  /* ---------- leads ---------- */

  app.get('/leads', view, async (req) => {
    const q = parse(z.object({ stage: z.enum(LEAD_STAGES).optional(), ownerId: z.uuid().optional(), q: z.string().trim().max(100).optional() }), req.query)
    const ws = workspaceOf(req)
    const search = q.q ? or(ilike(leads.title, like(q.q)), ilike(leads.companyName, like(q.q)), ilike(leads.personName, like(q.q))) : undefined
    return { leads: await leadRows(db, ws.id, and(q.stage ? eq(leads.stage, q.stage) : undefined, q.ownerId ? eq(leads.ownerId, q.ownerId) : undefined, search)) }
  })

  app.get('/leads/:id', view, async (req) => ({ lead: await leadDetail(db, workspaceOf(req).id, idOf(req.params, 'lead')) }))

  app.post('/leads', manage, async (req, reply) => {
    const input = parse(LeadInput, req.body)
    const ws = workspaceOf(req)
    await checkMember(db, ws.id, input.ownerId)
    if (input.customerId) await customerRow(db, ws.id, input.customerId)
    const id = await db.transaction(async (tx) => {
      const [l] = await tx
        .insert(leads)
        .values({ workspaceId: ws.id, ...leadValues(input), ownerId: input.ownerId === undefined ? userOf(req).id : (input.ownerId ?? null), createdBy: userOf(req).id })
        .returning()
      await audit(tx, req, { action: 'lead.created', entity: 'lead', entityId: l!.id, summary: `Added lead “${l!.title}” (${formatPeso(l!.value)})` })
      return l!.id
    })
    return reply.code(201).send({ lead: await leadDetail(db, ws.id, id) })
  })

  app.put('/leads/:id', manage, async (req) => {
    const id = idOf(req.params, 'lead')
    const input = parse(LeadInput, req.body)
    const ws = workspaceOf(req)
    await checkMember(db, ws.id, input.ownerId)
    if (input.customerId) await customerRow(db, ws.id, input.customerId)
    await db.transaction(async (tx) => {
      const [before] = await tx.select().from(leads).where(and(eq(leads.id, id), eq(leads.workspaceId, ws.id))).for('update')
      if (!before) throw new HttpError(404, 'not-found', 'That lead doesn’t exist.')
      await tx.update(leads).set({ ...leadValues(input), updatedAt: new Date() }).where(eq(leads.id, id))
      await audit(tx, req, {
        action: 'lead.updated',
        entity: 'lead',
        entityId: id,
        summary: `Edited lead “${input.title}”`,
        before: { title: before.title, value: before.value, ownerId: before.ownerId, expectedClose: before.expectedClose },
        after: { title: input.title, value: input.value, ownerId: input.ownerId ?? null, expectedClose: input.expectedClose ?? null },
      })
    })
    return { lead: await leadDetail(db, ws.id, id) }
  })

  /** Moves a lead along the pipeline. Won and lost close it; moving it back reopens it. */
  app.patch('/leads/:id/stage', manage, async (req) => {
    const id = idOf(req.params, 'lead')
    const input = parse(LeadStageInput, req.body)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const [before] = await tx.select().from(leads).where(and(eq(leads.id, id), eq(leads.workspaceId, ws.id))).for('update')
      if (!before) throw new HttpError(404, 'not-found', 'That lead doesn’t exist.')
      if (before.stage === input.stage) return
      const closes = input.stage === 'won' || input.stage === 'lost'
      await tx
        .update(leads)
        .set({ stage: input.stage, lostReason: input.stage === 'lost' ? input.lostReason! : null, closedAt: closes ? new Date() : null, updatedAt: new Date() })
        .where(eq(leads.id, id))
      const why = input.stage === 'lost' ? ` (${input.lostReason})` : ''
      await audit(tx, req, {
        action: 'lead.stage_changed',
        entity: 'lead',
        entityId: id,
        summary: `Moved lead “${before.title}” from ${LEAD_STAGE_LABELS[before.stage]} to ${LEAD_STAGE_LABELS[input.stage as LeadStage]}${why}`,
        before: { stage: before.stage },
        after: { stage: input.stage },
      })
    })
    return { lead: await leadDetail(db, ws.id, id) }
  })

  app.delete('/leads/:id', manage, async (req, reply) => {
    const id = idOf(req.params, 'lead')
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const [before] = await tx.select().from(leads).where(and(eq(leads.id, id), eq(leads.workspaceId, ws.id))).for('update')
      if (!before) throw new HttpError(404, 'not-found', 'That lead doesn’t exist.')
      await tx.delete(leads).where(eq(leads.id, id))
      await audit(tx, req, { action: 'lead.deleted', entity: 'lead', entityId: id, summary: `Deleted lead “${before.title}”` })
    })
    return reply.code(204).send()
  })

  /** Makes the lead's company (or person) a customer, so they can be quoted. */
  app.post('/leads/:id/convert', manage, async (req) => {
    const id = idOf(req.params, 'lead')
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const [lead] = await tx.select().from(leads).where(and(eq(leads.id, id), eq(leads.workspaceId, ws.id))).for('update')
      if (!lead) throw new HttpError(404, 'not-found', 'That lead doesn’t exist.')
      if (lead.customerId) throw new HttpError(409, 'already-customer', 'This lead is already a customer.')
      const name = leadName({ companyName: lead.companyName, personName: lead.personName, customer: null })
      const [c] = await tx.insert(contacts).values({ workspaceId: ws.id, name, email: lead.email, phone: lead.phone, isCustomer: true }).returning()
      await tx.update(leads).set({ customerId: c!.id, stage: lead.stage === 'new' ? 'qualified' : lead.stage, updatedAt: new Date() }).where(eq(leads.id, id))
      await audit(tx, req, { action: 'contact.created', entity: 'contact', entityId: c!.id, summary: `Added customer ${name} from lead “${lead.title}”` })
    })
    return { lead: await leadDetail(db, ws.id, id) }
  })

  app.post('/leads/:id/activities', manage, async (req, reply) => {
    const id = idOf(req.params, 'lead')
    const input = parse(ActivityInput, req.body)
    const ws = workspaceOf(req)
    const [lead] = await db.select().from(leads).where(and(eq(leads.id, id), eq(leads.workspaceId, ws.id)))
    if (!lead) throw new HttpError(404, 'not-found', 'That lead doesn’t exist.')
    await db.transaction(async (tx) => {
      const [a] = await tx.insert(crmActivities).values({ workspaceId: ws.id, leadId: id, kind: input.kind, body: input.body, date: input.date, createdBy: userOf(req).id }).returning()
      await tx.update(leads).set({ updatedAt: new Date() }).where(eq(leads.id, id))
      await audit(tx, req, { action: 'activity.logged', entity: 'lead', entityId: id, summary: `Logged a ${input.kind} on lead “${lead.title}”`, after: { activityId: a!.id } })
    })
    return reply.code(201).send({ lead: await leadDetail(db, ws.id, id) })
  })
}
