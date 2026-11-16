import {
  templateByKey,
  dailyRateOf,
  formatPeso,
  fullName,
  MilestoneInput,
  ProjectInput,
  ProjectMaterialsInput,
  TaskInput,
  TaskProgressInput,
  TimesheetInput,
  type JobCosting,
  type PayBasis,
  type Milestone,
  type MyTask,
  type Project,
  type ProjectsOverview,
  type ProjectSummary,
  type ProjectTask,
  type TimesheetEntry,
} from '@erp/shared'
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client.ts'
import {
  bills,
  contacts,
  documentLines,
  employees,
  items,
  projectMilestones,
  projects,
  projectTasks,
  salesInvoices,
  stockMoves,
  timesheets,
  users,
  type WorkspaceRow,
} from '../../db/schema.ts'
import type { Executor, Tx } from '../../db/types.ts'
import { audit } from '../../lib/audit.ts'
import { HttpError, parse } from '../../lib/errors.ts'
import { notifyLater, sendPush } from '../../lib/push.ts'
import { userOf } from '../../lib/session.ts'
import { can, needs, workspaceOf } from '../../lib/workspace.ts'
import { prepareDocument } from '../finance/documents.ts'
import { nextNumber, postEntry, systemAccount, systemAccountIfAny, todayInManila } from '../finance/ledger.ts'
import { warnLow } from '../inventory/routes.ts'
import { activeWarehouse, itemTotals, lockStockItem, stockOut } from '../inventory/stock.ts'

/**
 * Projects (Phase 7). Job costing reads from what the rest of the system already records:
 *
 * - labour: timesheets, at the employee's daily rate ÷ 8 (payroll books the wages; this only
 *   assigns them to projects, so it makes no journal entry);
 * - materials: stock taken for the project, Dr Direct Project Costs / Cr Inventory;
 * - bills tagged to the project, before VAT;
 * - revenue: invoices tagged to the project, before VAT. Milestones and unbilled hours become
 *   draft invoices in one step; voiding one frees them to bill again (finance/document-routes.ts).
 */

const view = needs('projects.view', 'projects')
const manage = needs('projects.manage', 'projects')
const self = needs('member', 'projects')

const IdParam = z.object({ id: z.uuid() })
const idOf = (params: unknown, what: string, key = 'id') => {
  const r = IdParam.safeParse({ id: (params as Record<string, unknown>)[key] })
  if (!r.success) throw new HttpError(404, 'not-found', `That ${what} doesn’t exist.`)
  return r.data.id
}

const round2 = (n: number) => Math.round(n * 100) / 100

/* ---------------------------------------------------------------------------------------------
 * Reading
 * ------------------------------------------------------------------------------------------- */

/** How far along: task progress weighted by estimated hours (or counted, when none are estimated). */
function percentOf(tasks: { estimatedHours: number; progress: number }[]) {
  if (!tasks.length) return 0
  const hours = tasks.reduce((s, t) => s + t.estimatedHours, 0)
  return Math.round(hours > 0 ? tasks.reduce((s, t) => s + t.estimatedHours * t.progress, 0) / hours : tasks.reduce((s, t) => s + t.progress, 0) / tasks.length)
}

async function costing(dbx: Executor, projectIds: string[]) {
  const out = new Map<string, Omit<JobCosting, 'budgetUsed' | 'forecastCost' | 'profit' | 'totalCost'>>()
  for (const id of projectIds) out.set(id, { revenue: 0, draftRevenue: 0, labour: 0, materials: 0, bills: 0, hours: 0, unbilledHours: 0 })
  if (!projectIds.length) return out
  const time = await dbx
    .select({
      id: timesheets.projectId,
      cost: sql<number>`coalesce(sum(${timesheets.cost}), 0)`.mapWith(Number),
      hours: sql<number>`coalesce(sum(${timesheets.hours}), 0)`.mapWith(Number),
      unbilled: sql<number>`coalesce(sum(${timesheets.hours}) filter (where ${timesheets.billable} and ${timesheets.invoiceId} is null), 0)`.mapWith(Number),
    })
    .from(timesheets)
    .where(inArray(timesheets.projectId, projectIds))
    .groupBy(timesheets.projectId)
  for (const t of time) Object.assign(out.get(t.id)!, { labour: t.cost, hours: round2(t.hours), unbilledHours: round2(t.unbilled) })
  const mats = await dbx
    .select({ id: stockMoves.projectId, value: sql<number>`coalesce(-sum(${stockMoves.value}), 0)::bigint`.mapWith(Number) })
    .from(stockMoves)
    .where(inArray(stockMoves.projectId, projectIds))
    .groupBy(stockMoves.projectId)
  for (const m of mats) out.get(m.id!)!.materials = m.value
  const billed = await dbx
    .select({ id: bills.projectId, net: sql<number>`coalesce(sum(${bills.total} - ${bills.vatAmount}), 0)::bigint`.mapWith(Number) })
    .from(bills)
    .where(and(inArray(bills.projectId, projectIds), eq(bills.status, 'posted')))
    .groupBy(bills.projectId)
  for (const b of billed) out.get(b.id!)!.bills = b.net
  const sold = await dbx
    .select({
      id: salesInvoices.projectId,
      posted: sql<number>`coalesce(sum(${salesInvoices.total} - ${salesInvoices.vatAmount}) filter (where ${salesInvoices.status} = 'posted'), 0)::bigint`.mapWith(Number),
      draft: sql<number>`coalesce(sum(${salesInvoices.total} - ${salesInvoices.vatAmount}) filter (where ${salesInvoices.status} = 'draft'), 0)::bigint`.mapWith(Number),
    })
    .from(salesInvoices)
    .where(inArray(salesInvoices.projectId, projectIds))
    .groupBy(salesInvoices.projectId)
  for (const s of sold) Object.assign(out.get(s.id!)!, { revenue: s.posted, draftRevenue: s.draft })
  return out
}

async function summaries(dbx: Executor, workspaceId: string, where?: ReturnType<typeof and>): Promise<ProjectSummary[]> {
  const rows = await dbx
    .select({ p: projects, customer: { id: contacts.id, name: contacts.name }, manager: { id: users.id, name: users.name } })
    .from(projects)
    .leftJoin(contacts, eq(contacts.id, projects.customerId))
    .leftJoin(users, eq(users.id, projects.managerId))
    .where(and(eq(projects.workspaceId, workspaceId), where))
    .orderBy(desc(projects.startDate), desc(projects.number))
  const ids = rows.map((r) => r.p.id)
  const tasks = ids.length ? await dbx.select({ projectId: projectTasks.projectId, estimatedHours: projectTasks.estimatedHours, progress: projectTasks.progress }).from(projectTasks).where(inArray(projectTasks.projectId, ids)) : []
  const costs = await costing(dbx, ids)
  const today = todayInManila()
  return rows.map((r) => {
    const c = costs.get(r.p.id)!
    return {
      id: r.p.id,
      number: r.p.number,
      name: r.p.name,
      status: r.p.status,
      billing: r.p.billing,
      customer: r.customer?.id ? r.customer : null,
      manager: r.manager?.id ? r.manager : null,
      startDate: r.p.startDate,
      endDate: r.p.endDate,
      contractValue: r.p.contractValue,
      costBudget: r.p.costBudget,
      percentComplete: r.p.status === 'completed' ? 100 : percentOf(tasks.filter((t) => t.projectId === r.p.id)),
      costToDate: c.labour + c.materials + c.bills,
      late: (r.p.status === 'active' || r.p.status === 'planning') && r.p.endDate < today,
    }
  })
}

function taskOut(t: typeof projectTasks.$inferSelect, assignee: { id: string; name: string } | null, logged: number): ProjectTask {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    milestoneId: t.milestoneId,
    assignee,
    startDate: t.startDate,
    endDate: t.endDate,
    estimatedHours: t.estimatedHours,
    loggedHours: round2(logged),
    progress: t.progress,
    status: t.status,
    dependsOnId: t.dependsOnId,
    fieldWork: t.fieldWork,
    location: t.location,
    doneAt: t.doneAt ? { at: t.doneAt.toISOString(), latitude: t.doneLatitude, longitude: t.doneLongitude } : null,
    notes: t.notes,
  }
}

async function tasksOf(dbx: Executor, where: ReturnType<typeof and>) {
  const rows = await dbx
    .select({ t: projectTasks, assignee: { id: users.id, name: users.name }, logged: sql<number>`(select coalesce(sum(ts.hours), 0) from timesheets ts where ts.task_id = ${projectTasks.id})`.mapWith(Number) })
    .from(projectTasks)
    .leftJoin(users, eq(users.id, projectTasks.assigneeId))
    .where(where)
    .orderBy(asc(projectTasks.startDate), asc(projectTasks.createdAt))
  return rows.map((r) => ({ projectId: r.t.projectId, task: taskOut(r.t, r.assignee?.id ? r.assignee : null, r.logged) }))
}

async function projectDetail(dbx: Executor, workspaceId: string, id: string): Promise<Project> {
  const [summary] = await summaries(dbx, workspaceId, and(eq(projects.id, id)))
  if (!summary) throw new HttpError(404, 'not-found', 'That project doesn’t exist.')
  const [p] = await dbx.select().from(projects).where(eq(projects.id, id))
  const ms = await dbx
    .select({ m: projectMilestones, inv: { id: salesInvoices.id, number: salesInvoices.number, status: salesInvoices.status } })
    .from(projectMilestones)
    .leftJoin(salesInvoices, eq(salesInvoices.id, projectMilestones.invoiceId))
    .where(eq(projectMilestones.projectId, id))
    .orderBy(asc(projectMilestones.dueDate))
  const milestones: Milestone[] = ms.map((r) => ({
    id: r.m.id,
    name: r.m.name,
    dueDate: r.m.dueDate,
    amount: r.m.amount,
    status: r.m.invoiceId ? 'invoiced' : r.m.doneAt ? 'done' : 'open',
    doneAt: r.m.doneAt?.toISOString() ?? null,
    invoice: r.inv?.id ? r.inv : null,
  }))
  const tasks = (await tasksOf(dbx, and(eq(projectTasks.projectId, id)))).map((t) => t.task)
  const c = (await costing(dbx, [id])).get(id)!
  const totalCost = c.labour + c.materials + c.bills
  const pct = summary.percentComplete
  const issues = await dbx
    .select({ date: stockMoves.date, value: stockMoves.value, qty: stockMoves.quantity, name: items.name, id: stockMoves.id })
    .from(stockMoves)
    .innerJoin(items, eq(items.id, stockMoves.itemId))
    .where(eq(stockMoves.projectId, id))
  const billRows = await dbx
    .select({ id: bills.id, date: bills.date, number: bills.number, net: sql<number>`${bills.total} - ${bills.vatAmount}`.mapWith(Number), supplier: contacts.name, notes: bills.notes })
    .from(bills)
    .innerJoin(contacts, eq(contacts.id, bills.supplierId))
    .where(and(eq(bills.projectId, id), eq(bills.status, 'posted')))
  const costEntries = [
    ...issues.map((m) => ({ id: m.id, date: m.date, kind: 'materials' as const, reference: null, description: `${-m.qty} × ${m.name}`, amount: -m.value })),
    ...billRows.map((b) => ({ id: b.id, date: b.date, kind: 'bill' as const, reference: b.number, description: b.notes ? `${b.supplier}: ${b.notes}` : b.supplier, amount: b.net })),
  ].sort((a, b) => (a.date < b.date ? 1 : -1))
  const [retentionInvoice] = p!.retentionInvoiceId ? await dbx.select({ id: salesInvoices.id, number: salesInvoices.number }).from(salesInvoices).where(eq(salesInvoices.id, p!.retentionInvoiceId)) : []
  return {
    ...summary,
    retentionBp: p!.retentionBp,
    retention: { held: ms.reduce((sum, r) => sum + (r.m.invoiceId ? r.m.retention : 0), 0), invoice: retentionInvoice ?? null },
    siteAddress: p!.siteAddress,
    description: p!.description,
    hourlyRate: p!.hourlyRate,
    milestones,
    tasks,
    costing: {
      ...c,
      totalCost,
      profit: c.revenue - totalCost,
      budgetUsed: p!.costBudget > 0 ? Math.round((totalCost / p!.costBudget) * 100) : 0,
      forecastCost: pct > 0 && pct < 100 ? Math.round(totalCost / (pct / 100)) : pct >= 100 ? totalCost : null,
    },
    costEntries,
  }
}

async function lockProject(tx: Tx, workspaceId: string, id: string) {
  const [p] = await tx.select().from(projects).where(and(eq(projects.id, id), eq(projects.workspaceId, workspaceId))).for('update')
  if (!p) throw new HttpError(404, 'not-found', 'That project doesn’t exist.')
  return p
}

/** Checks the people and contacts a project names belong to this workspace. */
async function checkProject(tx: Tx, ws: WorkspaceRow, input: z.output<typeof ProjectInput>) {
  if (input.customerId) {
    const [c] = await tx.select().from(contacts).where(and(eq(contacts.id, input.customerId), eq(contacts.workspaceId, ws.id)))
    if (!c?.isCustomer) throw new HttpError(400, 'invalid', 'Choose a customer.', 'customerId')
  }
  if (input.managerId) await checkMember(tx, ws.id, input.managerId, 'managerId')
}

async function checkMember(dbx: Executor, workspaceId: string, userId: string, field: string) {
  const [m] = await dbx.execute<{ ok: number }>(sql`select 1 as ok from memberships where workspace_id = ${workspaceId} and user_id = ${userId}`).then((r) => r.rows)
  if (!m) throw new HttpError(400, 'invalid', 'Choose someone in this workspace.', field)
}

async function checkTask(tx: Tx, ws: WorkspaceRow, projectId: string, input: z.output<typeof TaskInput>, taskId?: string) {
  if (input.assigneeId) await checkMember(tx, ws.id, input.assigneeId, 'assigneeId')
  if (input.milestoneId) {
    const [m] = await tx.select({ id: projectMilestones.id }).from(projectMilestones).where(and(eq(projectMilestones.id, input.milestoneId), eq(projectMilestones.projectId, projectId)))
    if (!m) throw new HttpError(400, 'invalid', 'Choose a milestone of this project.', 'milestoneId')
  }
  if (input.dependsOnId) {
    if (input.dependsOnId === taskId) throw new HttpError(400, 'invalid', 'A task can’t wait for itself.', 'dependsOnId')
    const all = await tx.select({ id: projectTasks.id, dependsOnId: projectTasks.dependsOnId }).from(projectTasks).where(eq(projectTasks.projectId, projectId))
    const byId = new Map(all.map((t) => [t.id, t]))
    if (!byId.has(input.dependsOnId)) throw new HttpError(400, 'invalid', 'Choose a task of this project.', 'dependsOnId')
    // waiting on something that (eventually) waits on this one would never start
    for (let at: string | null | undefined = input.dependsOnId, n = 0; at && n < 500; at = byId.get(at)?.dependsOnId, n++) {
      if (at === taskId) throw new HttpError(400, 'invalid', 'That would make the tasks wait for each other forever.', 'dependsOnId')
    }
  }
}

function notifyAssignee(ws: WorkspaceRow, assigneeId: string | null | undefined, by: string, task: string, project: string) {
  if (!assigneeId || assigneeId === by) return Promise.resolve()
  return notifyLater(() => sendPush([assigneeId], { title: ws.name, body: `New task for you: ${task} (${project})`, data: { workspaceId: ws.id, screen: 'tasks' } }))
}

/** The employee record of the signed-in member, for logging their own time. */
async function myEmployee(req: FastifyRequest) {
  const [e] = await db.select().from(employees).where(and(eq(employees.workspaceId, workspaceOf(req).id), eq(employees.userId, userOf(req).id)))
  return e ?? null
}

async function timesheetList(dbx: Executor, workspaceId: string, where: ReturnType<typeof and>, showCost: boolean): Promise<TimesheetEntry[]> {
  const rows = await dbx
    .select({ t: timesheets, p: { id: projects.id, number: projects.number, name: projects.name }, task: { id: projectTasks.id, name: projectTasks.name }, e: employees, inv: { id: salesInvoices.id, number: salesInvoices.number } })
    .from(timesheets)
    .innerJoin(projects, eq(projects.id, timesheets.projectId))
    .innerJoin(employees, eq(employees.id, timesheets.employeeId))
    .leftJoin(projectTasks, eq(projectTasks.id, timesheets.taskId))
    .leftJoin(salesInvoices, eq(salesInvoices.id, timesheets.invoiceId))
    .where(and(eq(timesheets.workspaceId, workspaceId), where))
    .orderBy(desc(timesheets.date), desc(timesheets.createdAt))
    .limit(500)
  return rows.map((r) => ({
    id: r.t.id,
    date: r.t.date,
    project: r.p,
    task: r.task?.id ? r.task : null,
    employee: { id: r.e.id, name: fullName(r.e) },
    hours: r.t.hours,
    billable: r.t.billable,
    note: r.t.note,
    cost: showCost ? r.t.cost : null,
    invoice: r.inv?.id ? r.inv : null,
  }))
}

/** A draft invoice to the project's customer, at their payment terms, tagged to the project. */
async function draftProjectInvoice(tx: Tx, req: FastifyRequest, ws: WorkspaceRow, p: typeof projects.$inferSelect, date: string, lines: { description: string; quantity: number; unitPrice: number }[], notes: string) {
  if (!p.customerId) throw new HttpError(409, 'internal', 'An internal project has no customer to bill.')
  const accountId = (await systemAccountIfAny(tx, ws.id, 'contract_revenue')) ?? (await systemAccountIfAny(tx, ws.id, 'service_revenue')) ?? (await systemAccount(tx, ws.id, 'sales'))
  const vat = ws.vatStatus === 'vat' ? ('vatable' as const) : ('none' as const)
  const prepared = await prepareDocument(tx, ws, 'invoice', { contactId: p.customerId, date, pricesIncludeVat: false, lines: lines.map((l) => ({ ...l, vat, accountId })) })
  const due = prepared.contact.paymentTermsDays !== null ? new Date(Date.parse(`${date}T00:00:00Z`) + prepared.contact.paymentTermsDays * 86_400_000).toISOString().slice(0, 10) : null
  const [inv] = await tx
    .insert(salesInvoices)
    .values({ workspaceId: ws.id, customerId: p.customerId, projectId: p.id, date, dueDate: due, pricesIncludeVat: false, notes, ...prepared.totals, createdBy: userOf(req).id })
    .returning({ id: salesInvoices.id })
  await tx.insert(documentLines).values(prepared.lines.map((l) => ({ ...l, workspaceId: ws.id, invoiceId: inv!.id, billId: null })))
  await audit(tx, req, { action: 'invoice.drafted', entity: 'invoice', entityId: inv!.id, summary: `Drafted a sales invoice for ${prepared.contact.name} from ${p.number} (${formatPeso(prepared.totals.total)})` })
  return inv!.id
}

/* ---------------------------------------------------------------------------------------------
 * Routes
 * ------------------------------------------------------------------------------------------- */

export default async function projectRoutes(app: FastifyInstance) {
  app.get('/projects', view, async (req) => {
    const q = parse(z.object({ status: z.enum(['open', 'planning', 'active', 'on_hold', 'completed', 'cancelled']).optional() }), req.query)
    const where = q.status === 'open' ? inArray(projects.status, ['planning', 'active', 'on_hold']) : q.status ? eq(projects.status, q.status) : undefined
    return { projects: await summaries(db, workspaceOf(req).id, and(where)) }
  })

  app.get('/projects/overview', view, async (req): Promise<{ overview: ProjectsOverview }> => {
    const ws = workspaceOf(req)
    const open = await summaries(db, ws.id, and(inArray(projects.status, ['planning', 'active', 'on_hold'])))
    const today = todayInManila()
    const weekAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10)
    const soon = new Date(Date.parse(`${today}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10)
    const [week] = await db.select({ h: sql<number>`coalesce(sum(${timesheets.hours}), 0)`.mapWith(Number) }).from(timesheets).where(and(eq(timesheets.workspaceId, ws.id), gte(timesheets.date, weekAgo), lte(timesheets.date, today)))
    const ids = open.map((p) => p.id)
    const ms = ids.length
      ? await db.select({ m: projectMilestones }).from(projectMilestones).where(and(inArray(projectMilestones.projectId, ids), isNull(projectMilestones.doneAt), isNull(projectMilestones.invoiceId), lte(projectMilestones.dueDate, soon)))
      : []
    const ts = ids.length ? await db.select().from(projectTasks).where(and(inArray(projectTasks.projectId, ids), ne(projectTasks.status, 'done'), lte(projectTasks.endDate, soon))) : []
    const byId = new Map(open.map((p) => [p.id, p]))
    const ref = (id: string) => ({ id, number: byId.get(id)!.number, name: byId.get(id)!.name })
    return {
      overview: {
        active: open.filter((p) => p.status === 'active').length,
        late: open.filter((p) => p.late).length,
        contractValue: open.reduce((s, p) => s + p.contractValue, 0),
        costToDate: open.reduce((s, p) => s + p.costToDate, 0),
        hoursThisWeek: round2(week?.h ?? 0),
        dueSoon: [
          ...ms.map((r) => ({ project: ref(r.m.projectId), kind: 'milestone' as const, name: r.m.name, dueDate: r.m.dueDate })),
          ...ts.map((t) => ({ project: ref(t.projectId), kind: 'task' as const, name: t.name, dueDate: t.endDate })),
        ]
          .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))
          .slice(0, 12),
      },
    }
  })

  app.get('/projects/:id', view, async (req) => ({ project: await projectDetail(db, workspaceOf(req).id, idOf(req.params, 'project')) }))

  app.post('/projects', manage, async (req, reply) => {
    const input = parse(ProjectInput, req.body)
    const ws = workspaceOf(req)
    const id = await db.transaction(async (tx) => {
      await checkProject(tx, ws, input)
      const number = await nextNumber(tx, ws.id, 'project')
      const [p] = await tx
        .insert(projects)
        .values({ ...input, retentionBp: input.retentionBp ?? templateByKey(ws.template)?.retentionBp ?? 0, workspaceId: ws.id, number, customerId: input.billing === 'none' ? (input.customerId ?? null) : input.customerId!, managerId: input.managerId ?? userOf(req).id, siteAddress: input.siteAddress ?? null, description: input.description ?? null, createdBy: userOf(req).id })
        .returning()
      await audit(tx, req, { action: 'project.created', entity: 'project', entityId: p!.id, summary: `Started project ${number}: ${input.name}` })
      return p!.id
    })
    return reply.code(201).send({ project: await projectDetail(db, ws.id, id) })
  })

  app.put('/projects/:id', manage, async (req) => {
    const id = idOf(req.params, 'project')
    const input = parse(ProjectInput, req.body)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const p = await lockProject(tx, ws.id, id)
      await checkProject(tx, ws, input)
      await tx
        .update(projects)
        .set({ ...input, retentionBp: input.retentionBp ?? p.retentionBp, customerId: input.customerId ?? null, managerId: input.managerId ?? null, siteAddress: input.siteAddress ?? null, description: input.description ?? null, updatedAt: new Date() })
        .where(eq(projects.id, id))
      await audit(tx, req, { action: 'project.updated', entity: 'project', entityId: id, summary: `Edited ${p.number}${p.status !== input.status ? `: now ${input.status.replace('_', ' ')}` : ''}` })
    })
    return { project: await projectDetail(db, ws.id, id) }
  })

  /** Only a project nothing has been recorded against: after that it's cancelled, and stays on record. */
  app.delete('/projects/:id', manage, async (req, reply) => {
    const id = idOf(req.params, 'project')
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const p = await lockProject(tx, ws.id, id)
      const [used] = await tx.execute<{ n: number }>(
        sql`select (select count(*) from timesheets where project_id = ${id}) + (select count(*) from stock_moves where project_id = ${id}) + (select count(*) from sales_invoices where project_id = ${id}) + (select count(*) from bills where project_id = ${id}) as n`,
      ).then((r) => r.rows)
      if (Number(used?.n) > 0) throw new HttpError(409, 'in-use', 'Time, materials or invoices are recorded against this project. Cancel it instead.')
      await tx.delete(projects).where(eq(projects.id, id))
      await audit(tx, req, { action: 'project.deleted', entity: 'project', entityId: id, summary: `Deleted project ${p.number}` })
    })
    return reply.code(204).send()
  })

  /* ---------- milestones ---------- */

  app.post('/projects/:id/milestones', manage, async (req, reply) => {
    const id = idOf(req.params, 'project')
    const input = parse(MilestoneInput, req.body)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const p = await lockProject(tx, ws.id, id)
      await tx.insert(projectMilestones).values({ ...input, workspaceId: ws.id, projectId: id })
      await audit(tx, req, { action: 'milestone.added', entity: 'project', entityId: id, summary: `Added milestone “${input.name}” to ${p.number}` })
    })
    return reply.code(201).send({ project: await projectDetail(db, ws.id, id) })
  })

  const milestoneOf = async (tx: Tx, projectId: string, params: unknown) => {
    const mid = idOf(params, 'milestone', 'milestoneId')
    const [m] = await tx.select().from(projectMilestones).where(and(eq(projectMilestones.id, mid), eq(projectMilestones.projectId, projectId))).for('update')
    if (!m) throw new HttpError(404, 'not-found', 'That milestone doesn’t exist.')
    return m
  }

  app.put('/projects/:id/milestones/:milestoneId', manage, async (req) => {
    const id = idOf(req.params, 'project')
    const input = parse(MilestoneInput, req.body)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      await lockProject(tx, ws.id, id)
      const m = await milestoneOf(tx, id, req.params)
      if (m.invoiceId && input.amount !== m.amount) throw new HttpError(409, 'invoiced', 'It’s been invoiced: its amount can’t change. Void the invoice first.', 'amount')
      await tx.update(projectMilestones).set(input).where(eq(projectMilestones.id, m.id))
    })
    return { project: await projectDetail(db, ws.id, id) }
  })

  app.delete('/projects/:id/milestones/:milestoneId', manage, async (req) => {
    const id = idOf(req.params, 'project')
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const p = await lockProject(tx, ws.id, id)
      const m = await milestoneOf(tx, id, req.params)
      if (m.invoiceId) throw new HttpError(409, 'invoiced', 'It’s been invoiced. Void the invoice first.')
      await tx.delete(projectMilestones).where(eq(projectMilestones.id, m.id))
      await audit(tx, req, { action: 'milestone.deleted', entity: 'project', entityId: id, summary: `Removed milestone “${m.name}” from ${p.number}` })
    })
    return { project: await projectDetail(db, ws.id, id) }
  })

  /** Reached (or not, after all). */
  app.post('/projects/:id/milestones/:milestoneId/done', manage, async (req) => {
    const id = idOf(req.params, 'project')
    const { done } = parse(z.object({ done: z.boolean().default(true) }), req.body ?? {})
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const p = await lockProject(tx, ws.id, id)
      const m = await milestoneOf(tx, id, req.params)
      await tx.update(projectMilestones).set({ doneAt: done ? (m.doneAt ?? new Date()) : null }).where(eq(projectMilestones.id, m.id))
      await audit(tx, req, { action: done ? 'milestone.done' : 'milestone.reopened', entity: 'project', entityId: id, summary: `${done ? 'Reached' : 'Reopened'} milestone “${m.name}” on ${p.number}` })
    })
    return { project: await projectDetail(db, ws.id, id) }
  })

  /** Fixed price: a draft invoice for the milestone's amount. */
  app.post('/projects/:id/milestones/:milestoneId/invoice', needs('finance.edit', 'projects'), async (req, reply) => {
    const id = idOf(req.params, 'project')
    const ws = workspaceOf(req)
    const invoiceId = await db.transaction(async (tx) => {
      const p = await lockProject(tx, ws.id, id)
      const m = await milestoneOf(tx, id, req.params)
      if (m.invoiceId) throw new HttpError(409, 'invoiced', 'That milestone is already on an invoice.')
      if (m.amount <= 0) throw new HttpError(400, 'invalid', 'Give the milestone an amount to bill first.', 'amount')
      // retention: the customer holds back a share of each milestone until turnover (Construction: 10%)
      const retention = Math.round((m.amount * p.retentionBp) / 10_000)
      const description = retention ? `${p.name}: ${m.name} (${formatPeso(m.amount)}, less ${p.retentionBp / 100}% retention of ${formatPeso(retention)})` : `${p.name}: ${m.name}`
      const invoiceId = await draftProjectInvoice(tx, req, ws, p, todayInManila(), [{ description, quantity: 1, unitPrice: m.amount - retention }], `${p.number}, milestone “${m.name}”`)
      await tx.update(projectMilestones).set({ invoiceId, retention, doneAt: m.doneAt ?? new Date() }).where(eq(projectMilestones.id, m.id))
      return invoiceId
    })
    return reply.code(201).send({ invoiceId })
  })

  /** At turnover: the retention held back from every milestone, on one invoice. */
  app.post('/projects/:id/invoice-retention', needs('finance.edit', 'projects'), async (req, reply) => {
    const id = idOf(req.params, 'project')
    const ws = workspaceOf(req)
    const invoiceId = await db.transaction(async (tx) => {
      const p = await lockProject(tx, ws.id, id)
      if (p.retentionInvoiceId) throw new HttpError(409, 'billed', 'The retention is already on an invoice.')
      const ms = await tx.select().from(projectMilestones).where(eq(projectMilestones.projectId, id))
      const held = ms.reduce((s, m) => s + (m.invoiceId ? m.retention : 0), 0)
      if (held <= 0) throw new HttpError(409, 'nothing-held', 'No retention has been held on this project.')
      if (p.status !== 'completed' && ms.some((m) => !m.invoiceId)) {
        throw new HttpError(409, 'not-yet', 'Retention is released at turnover: bill every milestone, or mark the project completed, first.')
      }
      const invoiceId = await draftProjectInvoice(tx, req, ws, p, todayInManila(), [{ description: `${p.name}: release of ${p.retentionBp / 100}% retention`, quantity: 1, unitPrice: held }], `${p.number}, retention released at turnover`)
      await tx.update(projects).set({ retentionInvoiceId: invoiceId, updatedAt: new Date() }).where(eq(projects.id, id))
      return invoiceId
    })
    return reply.code(201).send({ invoiceId })
  })

  /** Time and materials: the billable hours not yet billed, at the project's rate, on a draft invoice. */
  app.post('/projects/:id/invoice-hours', needs('finance.edit', 'projects'), async (req, reply) => {
    const id = idOf(req.params, 'project')
    const { upTo } = parse(z.object({ upTo: z.iso.date().optional() }), req.body ?? {})
    const ws = workspaceOf(req)
    const invoiceId = await db.transaction(async (tx) => {
      const p = await lockProject(tx, ws.id, id)
      if (p.billing !== 'hourly') throw new HttpError(409, 'not-hourly', 'Only a time-and-materials project bills by the hour.')
      const open = await tx
        .select({ t: timesheets, task: projectTasks.name })
        .from(timesheets)
        .leftJoin(projectTasks, eq(projectTasks.id, timesheets.taskId))
        .where(and(eq(timesheets.projectId, id), eq(timesheets.billable, true), isNull(timesheets.invoiceId), upTo ? lte(timesheets.date, upTo) : undefined))
        .for('update', { of: timesheets })
      if (!open.length) throw new HttpError(409, 'nothing-to-bill', 'No billable hours are waiting to be invoiced.')
      // one line per task, so the customer sees what the hours were for
      const byTask = new Map<string, number>()
      for (const r of open) byTask.set(r.task ?? 'General work', (byTask.get(r.task ?? 'General work') ?? 0) + r.t.hours)
      const from = open.reduce((m, r) => (r.t.date < m ? r.t.date : m), open[0]!.t.date)
      const to = open.reduce((m, r) => (r.t.date > m ? r.t.date : m), open[0]!.t.date)
      const invoiceId = await draftProjectInvoice(
        tx,
        req,
        ws,
        p,
        todayInManila(),
        [...byTask].map(([task, hours]) => ({ description: `${p.name}: ${task} (hours)`, quantity: round2(hours), unitPrice: p.hourlyRate })),
        `${p.number}, work from ${from} to ${to}`,
      )
      await tx.update(timesheets).set({ invoiceId }).where(inArray(timesheets.id, open.map((r) => r.t.id)))
      return invoiceId
    })
    return reply.code(201).send({ invoiceId })
  })

  /* ---------- tasks ---------- */

  app.post('/projects/:id/tasks', manage, async (req, reply) => {
    const id = idOf(req.params, 'project')
    const input = parse(TaskInput, req.body)
    const ws = workspaceOf(req)
    let projectNo = ''
    await db.transaction(async (tx) => {
      const p = await lockProject(tx, ws.id, id)
      projectNo = p.number
      await checkTask(tx, ws, id, input)
      await tx.insert(projectTasks).values({ ...input, workspaceId: ws.id, projectId: id, description: input.description ?? null, location: input.location ?? null, milestoneId: input.milestoneId ?? null, assigneeId: input.assigneeId ?? null, dependsOnId: input.dependsOnId ?? null })
      await audit(tx, req, { action: 'task.added', entity: 'project', entityId: id, summary: `Added task “${input.name}” to ${p.number}` })
    })
    await notifyAssignee(ws, input.assigneeId, userOf(req).id, input.name, projectNo)
    return reply.code(201).send({ project: await projectDetail(db, ws.id, id) })
  })

  const taskOf = async (tx: Tx, projectId: string, params: unknown) => {
    const tid = idOf(params, 'task', 'taskId')
    const [t] = await tx.select().from(projectTasks).where(and(eq(projectTasks.id, tid), eq(projectTasks.projectId, projectId))).for('update')
    if (!t) throw new HttpError(404, 'not-found', 'That task doesn’t exist.')
    return t
  }

  app.put('/projects/:id/tasks/:taskId', manage, async (req) => {
    const id = idOf(req.params, 'project')
    const input = parse(TaskInput, req.body)
    const ws = workspaceOf(req)
    let reassigned: { to: string | null; project: string } | null = null
    await db.transaction(async (tx) => {
      const p = await lockProject(tx, ws.id, id)
      const t = await taskOf(tx, id, req.params)
      await checkTask(tx, ws, id, input, t.id)
      await tx
        .update(projectTasks)
        .set({ ...input, description: input.description ?? null, location: input.location ?? null, milestoneId: input.milestoneId ?? null, assigneeId: input.assigneeId ?? null, dependsOnId: input.dependsOnId ?? null, updatedAt: new Date() })
        .where(eq(projectTasks.id, t.id))
      if ((input.assigneeId ?? null) !== t.assigneeId) reassigned = { to: input.assigneeId ?? null, project: p.number }
    })
    if (reassigned) await notifyAssignee(ws, (reassigned as { to: string | null }).to, userOf(req).id, input.name, (reassigned as { project: string }).project)
    return { project: await projectDetail(db, ws.id, id) }
  })

  app.delete('/projects/:id/tasks/:taskId', manage, async (req) => {
    const id = idOf(req.params, 'project')
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const p = await lockProject(tx, ws.id, id)
      const t = await taskOf(tx, id, req.params)
      await tx.delete(projectTasks).where(eq(projectTasks.id, t.id))
      await audit(tx, req, { action: 'task.deleted', entity: 'project', entityId: id, summary: `Removed task “${t.name}” from ${p.number} (its logged hours stay on the project)` })
    })
    return { project: await projectDetail(db, ws.id, id) }
  })

  /** Progress, by the project's managers or by whoever the task is assigned to (web or phone). */
  async function recordProgress(req: FastifyRequest, projectId: string | null, taskId: string) {
    const input = parse(TaskProgressInput, req.body)
    const ws = workspaceOf(req)
    const me = userOf(req).id
    await db.transaction(async (tx) => {
      const [t] = await tx
        .select({ t: projectTasks, number: projects.number })
        .from(projectTasks)
        .innerJoin(projects, eq(projects.id, projectTasks.projectId))
        .where(and(eq(projectTasks.id, taskId), eq(projects.workspaceId, ws.id), projectId ? eq(projects.id, projectId) : undefined))
        .for('update', { of: projectTasks })
      if (!t) throw new HttpError(404, 'not-found', 'That task doesn’t exist.')
      if (t.t.assigneeId !== me && !can(req, 'projects.manage')) throw new HttpError(403, 'forbidden', 'Only the person it’s assigned to, or a project manager, can update this task.')
      const progress = input.status === 'done' ? 100 : input.status === 'todo' ? (input.progress ?? 0) : (input.progress ?? Math.max(t.t.progress, 10))
      const done = input.status === 'done'
      await tx
        .update(projectTasks)
        .set({
          status: input.status,
          progress: Math.min(progress, done ? 100 : 99),
          notes: input.note ? [t.t.notes, `${todayInManila()}: ${input.note}`].filter(Boolean).join('\n') : t.t.notes,
          doneAt: done ? (t.t.doneAt ?? new Date()) : null,
          doneLatitude: done ? (input.latitude ?? t.t.doneLatitude) : null,
          doneLongitude: done ? (input.longitude ?? t.t.doneLongitude) : null,
          updatedAt: new Date(),
        })
        .where(eq(projectTasks.id, taskId))
      await audit(tx, req, { action: 'task.progress', entity: 'project', entityId: t.t.projectId, summary: `${t.t.name} (${t.number}): ${done ? 'done' : `${input.status.replace('_', ' ')}, ${progress}%`}${input.latitude ? ' (location recorded)' : ''}` })
    })
  }

  app.post('/projects/:id/tasks/:taskId/progress', view, async (req) => {
    const id = idOf(req.params, 'project')
    await recordProgress(req, id, idOf(req.params, 'task', 'taskId'))
    return { project: await projectDetail(db, workspaceOf(req).id, id) }
  })

  /* ---------- materials ---------- */

  app.post('/projects/:id/materials', manage, async (req, reply) => {
    const id = idOf(req.params, 'project')
    const input = parse(ProjectMaterialsInput, req.body)
    const ws = workspaceOf(req)
    const before = new Map<string, number>()
    for (const l of input.lines) before.set(l.itemId, (await itemTotals(db, l.itemId)).qty)
    await db.transaction(async (tx) => {
      const p = await lockProject(tx, ws.id, id)
      const warehouse = await activeWarehouse(tx, ws.id, input.warehouseId)
      let total = 0
      for (const [i, l] of input.lines.entries()) {
        const item = await lockStockItem(tx, ws.id, l.itemId)
        total += await stockOut(tx, ws, { item, warehouseId: warehouse.id, quantity: l.quantity, lotNo: l.lotNo, kind: 'consume', date: input.date, line: `Line ${i + 1}`, projectId: id })
      }
      await postEntry(tx, { workspaceId: ws.id, date: input.date, memo: `${p.number}: materials from ${warehouse.name}${input.note ? ` (${input.note})` : ''}`, source: 'project', sourceId: id, createdBy: userOf(req).id }, [
        { accountId: await systemAccount(tx, ws.id, 'project_costs'), debit: total },
        { accountId: await systemAccount(tx, ws.id, 'inventory'), credit: total },
      ])
      await audit(tx, req, { action: 'project.materials', entity: 'project', entityId: id, summary: `Took materials worth ${formatPeso(total)} for ${p.number}` })
    })
    await warnLow(ws, before)
    return reply.code(201).send({ project: await projectDetail(db, ws.id, id) })
  })

  /* ---------- timesheets ---------- */

  app.get('/timesheets', view, async (req) => {
    const q = parse(z.object({ projectId: z.uuid().optional(), employeeId: z.uuid().optional(), from: z.iso.date().optional(), to: z.iso.date().optional() }), req.query)
    return {
      timesheets: await timesheetList(
        db,
        workspaceOf(req).id,
        and(q.projectId ? eq(timesheets.projectId, q.projectId) : undefined, q.employeeId ? eq(timesheets.employeeId, q.employeeId) : undefined, q.from ? gte(timesheets.date, q.from) : undefined, q.to ? lte(timesheets.date, q.to) : undefined),
        can(req, 'payroll.run'),
      ),
    }
  })

  /** Anyone on the employee list logs their own hours; a project manager may log anyone's. */
  app.post('/timesheets', self, async (req, reply) => {
    const input = parse(TimesheetInput, req.body)
    const ws = workspaceOf(req)
    const mine = await myEmployee(req)
    const employeeId = input.employeeId ?? mine?.id
    if (!employeeId) throw new HttpError(403, 'not-an-employee', 'You aren’t on this workspace’s list of employees, so there’s no one to log the time for.')
    if (employeeId !== mine?.id && !can(req, 'projects.manage')) throw new HttpError(403, 'forbidden', 'You can only log your own time.')
    const id = await db.transaction(async (tx) => {
      const [p] = await tx.select().from(projects).where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, ws.id)))
      if (!p) throw new HttpError(400, 'invalid', 'Choose a project.', 'projectId')
      if (p.status === 'completed' || p.status === 'cancelled') throw new HttpError(409, 'closed', `${p.number} is ${p.status}: time can’t be logged to it.`, 'projectId')
      if (input.taskId) {
        const [t] = await tx.select({ id: projectTasks.id }).from(projectTasks).where(and(eq(projectTasks.id, input.taskId), eq(projectTasks.projectId, p.id)))
        if (!t) throw new HttpError(400, 'invalid', 'Choose a task of that project.', 'taskId')
      }
      const [e] = await tx.select().from(employees).where(and(eq(employees.id, employeeId), eq(employees.workspaceId, ws.id)))
      if (!e) throw new HttpError(400, 'invalid', 'Choose an employee.', 'employeeId')
      const costRate = Math.round(dailyRateOf({ ...e, payBasis: e.payBasis as PayBasis }) / 8)
      const [row] = await tx
        .insert(timesheets)
        .values({ workspaceId: ws.id, projectId: p.id, taskId: input.taskId ?? null, employeeId, date: input.date, hours: input.hours, billable: p.billing === 'hourly' && input.billable, note: input.note ?? null, costRate, cost: Math.round(costRate * input.hours), createdBy: userOf(req).id })
        .returning({ id: timesheets.id })
      // logging time on a task that hadn't started means it has
      if (input.taskId) await tx.update(projectTasks).set({ status: 'in_progress', progress: sql`greatest(${projectTasks.progress}, 10)` }).where(and(eq(projectTasks.id, input.taskId), eq(projectTasks.status, 'todo')))
      await audit(tx, req, { action: 'timesheet.logged', entity: 'project', entityId: p.id, summary: `${input.hours} h on ${p.number} for ${fullName(e)} (${input.date})` })
      return row!.id
    })
    return reply.code(201).send({ timesheet: (await timesheetList(db, ws.id, and(eq(timesheets.id, id)), can(req, 'payroll.run')))[0] })
  })

  app.delete('/timesheets/:id', self, async (req, reply) => {
    const id = idOf(req.params, 'time entry')
    const ws = workspaceOf(req)
    const mine = await myEmployee(req)
    await db.transaction(async (tx) => {
      const [t] = await tx.select().from(timesheets).where(and(eq(timesheets.id, id), eq(timesheets.workspaceId, ws.id))).for('update')
      if (!t) throw new HttpError(404, 'not-found', 'That time entry doesn’t exist.')
      if (t.employeeId !== mine?.id && !can(req, 'projects.manage')) throw new HttpError(403, 'forbidden', 'You can only remove your own time.')
      if (t.invoiceId) throw new HttpError(409, 'invoiced', 'Those hours are on an invoice. Void the invoice first.')
      await tx.delete(timesheets).where(eq(timesheets.id, id))
      await audit(tx, req, { action: 'timesheet.deleted', entity: 'project', entityId: t.projectId, summary: `Removed ${t.hours} h logged for ${t.date}` })
    })
    return reply.code(204).send()
  })

  /* ---------- the signed-in member's own work (web and phone) ---------- */

  app.get('/me/tasks', self, async (req): Promise<{ tasks: MyTask[] }> => {
    const ws = workspaceOf(req)
    const rows = await tasksOf(db, and(eq(projectTasks.assigneeId, userOf(req).id), eq(projectTasks.workspaceId, ws.id)))
    const ids = [...new Set(rows.map((r) => r.projectId))]
    const ps = ids.length ? await db.select().from(projects).where(and(inArray(projects.id, ids), inArray(projects.status, ['planning', 'active', 'on_hold']))) : []
    const byId = new Map(ps.map((p) => [p.id, p]))
    const recent = new Date(Date.now() - 14 * 86_400_000)
    return {
      tasks: rows
        .filter((r) => byId.has(r.projectId) && (r.task.status !== 'done' || (r.task.doneAt && new Date(r.task.doneAt.at) > recent)))
        .map((r) => {
          const p = byId.get(r.projectId)!
          return { ...r.task, project: { id: p.id, number: p.number, name: p.name, siteAddress: p.siteAddress } }
        })
        .sort((a, b) => (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) || (a.endDate < b.endDate ? -1 : 1)),
    }
  })

  app.post('/me/tasks/:id/progress', self, async (req) => {
    await recordProgress(req, null, idOf(req.params, 'task'))
    return { ok: true }
  })

  /** Projects time can be logged to, and the member's own recent entries. */
  app.get('/me/timesheets', self, async (req) => {
    const ws = workspaceOf(req)
    const mine = await myEmployee(req)
    const open = await db.select({ id: projects.id, number: projects.number, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ws.id), inArray(projects.status, ['planning', 'active', 'on_hold']))).orderBy(asc(projects.number))
    const tasks = open.length ? await db.select({ id: projectTasks.id, projectId: projectTasks.projectId, name: projectTasks.name }).from(projectTasks).where(and(inArray(projectTasks.projectId, open.map((p) => p.id)), ne(projectTasks.status, 'done'))) : []
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
    return {
      employee: mine ? { id: mine.id, name: fullName(mine) } : null,
      projects: open.map((p) => ({ ...p, tasks: tasks.filter((t) => t.projectId === p.id).map((t) => ({ id: t.id, name: t.name })) })),
      entries: mine ? await timesheetList(db, ws.id, and(eq(timesheets.employeeId, mine.id), gte(timesheets.date, from)), false) : [],
    }
  })
}

