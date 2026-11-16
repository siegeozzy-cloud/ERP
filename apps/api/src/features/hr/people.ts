import {
  ClockInput,
  dailyRateOf,
  EmployeeInput,
  formatPeso,
  fullName,
  HolidayInput,
  LEAVE_STATUSES,
  LeaveDecisionInput,
  LeaveForInput,
  LeaveRequestInput,
  LeaveTypeUpdate,
  TimeEntryInput,
  type Employee,
  type EmployeeSummary,
  type GovRate,
  type Holiday,
  type HrOverview,
  type LeaveBalance,
  type LeaveRequest,
  type LeaveType,
  type MyHr,
  type PayBasis,
  type PayFrequency,
  type TimeEntry,
} from '@erp/shared'
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db, isUniqueViolation } from '../../db/client.ts'
import { employees, govRates, holidays, leaveRequests, leaveTypes, memberships, payrollLines, payrollRuns, timeEntries, users, type WorkspaceRow } from '../../db/schema.ts'
import { iso, type Executor } from '../../db/types.ts'
import { audit } from '../../lib/audit.ts'
import { decrypt, encrypt } from '../../lib/crypto.ts'
import { HttpError, parse } from '../../lib/errors.ts'
import { membersWith, notifyLater, sendPush } from '../../lib/push.ts'
import { userOf } from '../../lib/session.ts'
import { can, needs, workspaceOf } from '../../lib/workspace.ts'
import { nextNumber, todayInManila } from '../finance/ledger.ts'
import { runSummaries } from './payroll.ts'
import { fromManila, leaveDays, ratesOn, type HolidayMap } from './time.ts'

/** Employees, attendance, leave and holidays; and the self-service an employee does for themselves. */

const view = needs('hr.view', 'hr')
const manage = needs('hr.manage', 'hr')
const self = needs('member', 'hr')

const IdParam = z.object({ id: z.uuid() })
const idOf = (params: unknown, what: string) => {
  const r = IdParam.safeParse(params)
  if (!r.success) throw new HttpError(404, 'not-found', `That ${what} doesn’t exist.`)
  return r.data.id
}

type EmployeeRow = typeof employees.$inferSelect

/* ---------------------------------------------------------------------------------------------
 * Shapes
 * ------------------------------------------------------------------------------------------- */

const seal = (v: string | undefined) => (v ? encrypt(v) : null)
const open = (v: string | null) => (v ? decrypt(v) : null)
/** "34-1234567-8" → "••-•••••67-8": enough to tell numbers apart, not enough to use one. */
const mask = (v: string | null) => {
  if (!v) return null
  const digits = v.replace(/\D/g, '').length
  let seen = 0
  return v.replace(/\d/g, (d) => (++seen > digits - 3 ? d : '•'))
}

export async function holidayMap(db: Executor, workspaceId: string, from: string, to: string): Promise<HolidayMap> {
  const rows = await db.select().from(holidays).where(and(eq(holidays.workspaceId, workspaceId), gte(holidays.date, from), lte(holidays.date, to)))
  return new Map(rows.map((h) => [h.date, h.kind as 'regular' | 'special']))
}

function summaryOut(req: FastifyRequest, e: EmployeeRow, user: { id: string; name: string } | null, clockedIn: boolean): EmployeeSummary {
  const today = todayInManila()
  return {
    id: e.id,
    employeeNo: e.employeeNo,
    name: fullName(e),
    firstName: e.firstName,
    lastName: e.lastName,
    position: e.position,
    department: e.department,
    employmentType: e.employmentType as EmployeeSummary['employmentType'],
    hireDate: e.hireDate,
    separationDate: e.separationDate,
    active: !e.separationDate || e.separationDate >= today,
    user,
    pay: can(req, 'payroll.run')
      ? { payBasis: e.payBasis as PayBasis, rate: e.rate, payFrequency: e.payFrequency as PayFrequency, dailyRate: dailyRateOf({ ...e, payBasis: e.payBasis as PayBasis }), minimumWageEarner: e.minimumWageEarner }
      : null,
    clockedIn,
  }
}

const linkedUser = alias(users, 'linked_user')
const isClockedIn = sql<boolean>`exists (select 1 from time_entries t where t.employee_id = ${employees.id} and t.clock_out is null)`

async function employeeRows(db: Executor, workspaceId: string, where?: ReturnType<typeof and>) {
  return db
    .select({ e: employees, userName: linkedUser.name, clockedIn: isClockedIn })
    .from(employees)
    .leftJoin(linkedUser, eq(linkedUser.id, employees.userId))
    .where(and(eq(employees.workspaceId, workspaceId), where))
    .orderBy(asc(employees.lastName), asc(employees.firstName))
}

async function employeeDetail(req: FastifyRequest, id: string): Promise<Employee> {
  const ws = workspaceOf(req)
  const [row] = await employeeRows(db, ws.id, eq(employees.id, id))
  if (!row) throw new HttpError(404, 'not-found', 'That employee doesn’t exist.')
  const e = row.e
  const full = can(req, 'hr.manage')
  const show = (v: string | null) => (full ? open(v) : mask(open(v)))
  let minimumWageWarning: string | null = null
  if (can(req, 'payroll.run')) {
    const region = e.workRegionCode ?? ws.regionCode
    const { minimumWages } = await ratesOn(db, todayInManila())
    const min = region ? minimumWages[region] : undefined
    const daily = dailyRateOf({ ...e, payBasis: e.payBasis as PayBasis })
    if (min && daily < min.daily) minimumWageWarning = `${formatPeso(daily)} a day is under the ${min.region} minimum wage of ${formatPeso(min.daily)}.`
  }
  return {
    ...summaryOut(req, e, e.userId && row.userName ? { id: e.userId, name: row.userName } : null, row.clockedIn),
    middleName: e.middleName,
    birthDate: e.birthDate,
    email: e.email,
    phone: e.phone,
    address: e.address,
    tin: show(e.tinEnc),
    sssNo: show(e.sssNoEnc),
    philhealthNo: show(e.philhealthNoEnc),
    pagibigNo: show(e.pagibigNoEnc),
    workDaysPerYear: e.workDaysPerYear,
    tracksAttendance: e.tracksAttendance,
    shiftStart: e.shiftStart,
    restDays: e.restDays,
    workRegionCode: e.workRegionCode,
    minimumWageWarning,
    leave: await balances(db, ws.id, e, todayInManila().slice(0, 4)),
  }
}

/** Plain values only: the encrypted IDs are opened just for the people allowed to see them. */
export const govIds = (e: EmployeeRow) => ({ tin: open(e.tinEnc), sssNo: open(e.sssNoEnc), philhealthNo: open(e.philhealthNoEnc), pagibigNo: open(e.pagibigNoEnc) })

const leaveTypeOut = (t: typeof leaveTypes.$inferSelect): LeaveType => ({ id: t.id, code: t.code, name: t.name, paid: t.paid, daysPerYear: t.daysPerYear, active: t.active })

/** Leave taken and asked for this year, against what each kind allows. */
async function balances(db: Executor, workspaceId: string, e: EmployeeRow, year: string): Promise<LeaveBalance[]> {
  const types = await db.select().from(leaveTypes).where(and(eq(leaveTypes.workspaceId, workspaceId), eq(leaveTypes.active, true))).orderBy(asc(leaveTypes.name))
  const used = await db
    .select({ typeId: leaveRequests.leaveTypeId, status: leaveRequests.status, days: sql<number>`sum(${leaveRequests.days})`.mapWith(Number) })
    .from(leaveRequests)
    .where(and(eq(leaveRequests.employeeId, e.id), inArray(leaveRequests.status, ['approved', 'pending']), sql`to_char(${leaveRequests.startDate}, 'YYYY') = ${year}`))
    .groupBy(leaveRequests.leaveTypeId, leaveRequests.status)
  return types.map((t) => {
    const u = used.filter((r) => r.typeId === t.id)
    const taken = u.find((r) => r.status === 'approved')?.days ?? 0
    const pending = u.find((r) => r.status === 'pending')?.days ?? 0
    return { leaveType: leaveTypeOut(t), entitled: t.daysPerYear, used: taken, pending, left: t.daysPerYear === null ? null : t.daysPerYear - taken - pending }
  })
}

const entryOut = (t: typeof timeEntries.$inferSelect, e: { id: string; name: string }): TimeEntry => ({
  id: t.id,
  employee: e,
  clockIn: t.clockIn.toISOString(),
  clockOut: iso(t.clockOut),
  inLocation: t.inLatitude !== null && t.inLongitude !== null ? { latitude: t.inLatitude, longitude: t.inLongitude, accuracy: t.inAccuracy } : null,
  outLocation: t.outLatitude !== null && t.outLongitude !== null ? { latitude: t.outLatitude, longitude: t.outLongitude, accuracy: t.outAccuracy } : null,
  source: t.source as TimeEntry['source'],
  note: t.note,
})

async function entries(db: Executor, workspaceId: string, from: string, to: string, employeeId?: string) {
  const rows = await db
    .select({ t: timeEntries, e: employees })
    .from(timeEntries)
    .innerJoin(employees, eq(employees.id, timeEntries.employeeId))
    .where(
      and(
        eq(timeEntries.workspaceId, workspaceId),
        gte(timeEntries.clockIn, fromManila(`${from}T00:00`)),
        lte(timeEntries.clockIn, fromManila(`${to}T23:59`)),
        employeeId ? eq(timeEntries.employeeId, employeeId) : undefined,
      ),
    )
    .orderBy(desc(timeEntries.clockIn))
    .limit(2000)
  return rows.map((r) => entryOut(r.t, { id: r.e.id, name: fullName(r.e) }))
}

const decider = alias(users, 'decider')
async function leaveList(db: Executor, workspaceId: string, where?: ReturnType<typeof and>): Promise<LeaveRequest[]> {
  const rows = await db
    .select({ l: leaveRequests, e: employees, t: leaveTypes, deciderName: decider.name })
    .from(leaveRequests)
    .innerJoin(employees, eq(employees.id, leaveRequests.employeeId))
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .leftJoin(decider, eq(decider.id, leaveRequests.decidedBy))
    .where(and(eq(leaveRequests.workspaceId, workspaceId), where))
    .orderBy(desc(leaveRequests.startDate), desc(leaveRequests.createdAt))
    .limit(500)
  return rows.map((r) => ({
    id: r.l.id,
    employee: { id: r.e.id, name: fullName(r.e) },
    leaveType: { id: r.t.id, name: r.t.name, paid: r.t.paid },
    startDate: r.l.startDate,
    endDate: r.l.endDate,
    halfDay: r.l.halfDay,
    days: r.l.days,
    reason: r.l.reason,
    status: r.l.status,
    decidedBy: r.l.decidedBy && r.deciderName ? { id: r.l.decidedBy, name: r.deciderName } : null,
    decidedAt: iso(r.l.decidedAt),
    decisionNote: r.l.decisionNote,
    createdAt: r.l.createdAt.toISOString(),
  }))
}

/* ---------------------------------------------------------------------------------------------
 * Rules shared by HR and self-service
 * ------------------------------------------------------------------------------------------- */

/** The employee the signed-in member is, in this workspace. */
async function myEmployee(req: FastifyRequest) {
  const [e] = await db.select().from(employees).where(and(eq(employees.workspaceId, workspaceOf(req).id), eq(employees.userId, userOf(req).id)))
  return e ?? null
}
async function requireMe(req: FastifyRequest) {
  const e = await myEmployee(req)
  if (!e) throw new HttpError(403, 'not-an-employee', 'You aren’t on this workspace’s list of employees. Ask HR to link your account to your employee record.')
  return e
}

async function fileLeave(req: FastifyRequest, ws: WorkspaceRow, e: EmployeeRow, input: z.output<typeof LeaveRequestInput>) {
  const [type] = await db.select().from(leaveTypes).where(and(eq(leaveTypes.id, input.leaveTypeId), eq(leaveTypes.workspaceId, ws.id)))
  if (!type?.active) throw new HttpError(400, 'invalid', 'Choose the kind of leave.', 'leaveTypeId')
  const days = leaveDays(input.startDate, input.endDate, input.halfDay, e.restDays, await holidayMap(db, ws.id, input.startDate, input.endDate))
  if (days === 0) throw new HttpError(400, 'invalid', 'Those days are all rest days or holidays, so no leave is needed.', 'endDate')
  const [overlap] = await db
    .select({ id: leaveRequests.id })
    .from(leaveRequests)
    .where(and(eq(leaveRequests.employeeId, e.id), inArray(leaveRequests.status, ['pending', 'approved']), lte(leaveRequests.startDate, input.endDate), gte(leaveRequests.endDate, input.startDate)))
  if (overlap) throw new HttpError(409, 'overlap', 'There’s already leave filed for some of those days.', 'startDate')
  if (type.daysPerYear !== null) {
    const balance = (await balances(db, ws.id, e, input.startDate.slice(0, 4))).find((b) => b.leaveType.id === type.id)
    if (balance && balance.left !== null && days > balance.left) {
      throw new HttpError(409, 'no-balance', `Only ${balance.left} day(s) of ${type.name} left this year (${days} asked for).`, 'endDate')
    }
  }
  const [row] = await db
    .insert(leaveRequests)
    .values({ workspaceId: ws.id, employeeId: e.id, leaveTypeId: type.id, startDate: input.startDate, endDate: input.endDate, halfDay: input.halfDay, days, reason: input.reason ?? null, createdBy: userOf(req).id })
    .returning()
  await audit(db, req, { action: 'leave.requested', entity: 'leave_request', entityId: row!.id, summary: `${fullName(e)} asked for ${days} day(s) of ${type.name} from ${input.startDate}` })
  await notifyLater(async () => {
    const people = await membersWith(ws.id, 'hr.manage', userOf(req).id)
    await sendPush(people, { title: `${ws.name}: leave request`, body: `${fullName(e)}: ${days} day(s) of ${type.name} from ${input.startDate}`, data: { workspaceId: ws.id, screen: 'approvals' } })
  })
  return row!.id
}

async function clock(req: FastifyRequest, e: EmployeeRow, input: z.output<typeof ClockInput>) {
  const ws = workspaceOf(req)
  const at = new Date()
  const [openEntry] = await db.select().from(timeEntries).where(and(eq(timeEntries.employeeId, e.id), isNull(timeEntries.clockOut)))
  if (input.action === 'in') {
    if (openEntry) throw new HttpError(409, 'already-in', `You clocked in at ${openEntry.clockIn.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' })} and haven’t clocked out.`)
    try {
      await db.insert(timeEntries).values({
        workspaceId: ws.id,
        employeeId: e.id,
        clockIn: at,
        inLatitude: input.latitude ?? null,
        inLongitude: input.longitude ?? null,
        inAccuracy: input.accuracy ?? null,
        source: input.source,
        createdBy: userOf(req).id,
      })
    } catch (err) {
      if (isUniqueViolation(err, 'time_entries_one_open')) throw new HttpError(409, 'already-in', 'You’re already clocked in.')
      throw err
    }
  } else {
    if (!openEntry) throw new HttpError(409, 'not-in', 'You aren’t clocked in.')
    await db
      .update(timeEntries)
      .set({ clockOut: at, outLatitude: input.latitude ?? null, outLongitude: input.longitude ?? null, outAccuracy: input.accuracy ?? null, updatedAt: at })
      .where(eq(timeEntries.id, openEntry.id))
  }
}

/** HR's employee values from the form. Pay fields only change for someone who may run payroll. */
function employeeValues(req: FastifyRequest, input: z.output<typeof EmployeeInput>, current?: EmployeeRow) {
  const payroll = can(req, 'payroll.run')
  const keepId = (next: string | undefined, sealed: string | null | undefined) => (next === undefined && current ? sealed : seal(next))
  return {
    firstName: input.firstName,
    middleName: input.middleName ?? null,
    lastName: input.lastName,
    birthDate: input.birthDate ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    address: input.address ?? null,
    position: input.position,
    department: input.department ?? null,
    employmentType: input.employmentType,
    hireDate: input.hireDate,
    separationDate: input.separationDate ?? null,
    userId: input.userId ?? null,
    // a blank ID on an edit keeps what's stored (the form shows a masked copy); a new one replaces it
    tinEnc: keepId(input.tin, current?.tinEnc),
    sssNoEnc: keepId(input.sssNo, current?.sssNoEnc),
    philhealthNoEnc: keepId(input.philhealthNo, current?.philhealthNoEnc),
    pagibigNoEnc: keepId(input.pagibigNo, current?.pagibigNoEnc),
    tracksAttendance: input.tracksAttendance,
    shiftStart: input.shiftStart,
    restDays: [...new Set(input.restDays)].sort(),
    workRegionCode: input.workRegionCode ?? null,
    ...(payroll || !current
      ? {
          payBasis: input.payBasis,
          rate: payroll ? input.rate : 0,
          payFrequency: input.payFrequency,
          workDaysPerYear: input.workDaysPerYear,
          minimumWageEarner: input.minimumWageEarner,
        }
      : {}),
  }
}

async function checkLinkedUser(workspaceId: string, userId: string | null | undefined) {
  if (!userId) return
  const [m] = await db.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
  if (!m) throw new HttpError(400, 'invalid', 'Choose someone who is a member of this workspace.', 'userId')
}

/* ---------------------------------------------------------------------------------------------
 * Routes
 * ------------------------------------------------------------------------------------------- */

export default async function peopleRoutes(app: FastifyInstance) {
  /* ---------- overview ---------- */

  app.get('/hr/overview', view, async (req): Promise<{ overview: HrOverview }> => {
    const ws = workspaceOf(req)
    const today = todayInManila()
    const active = await employeeRows(db, ws.id, or(isNull(employees.separationDate), gte(employees.separationDate, today)))
    const open = await db
      .select({ e: employees, since: timeEntries.clockIn })
      .from(timeEntries)
      .innerJoin(employees, eq(employees.id, timeEntries.employeeId))
      .where(and(eq(timeEntries.workspaceId, ws.id), isNull(timeEntries.clockOut)))
      .orderBy(asc(timeEntries.clockIn))
    const away = await leaveList(db, ws.id, and(eq(leaveRequests.status, 'approved'), lte(leaveRequests.startDate, today), gte(leaveRequests.endDate, today)))
    const [pending] = await db.select({ n: sql<number>`count(*)::int` }).from(leaveRequests).where(and(eq(leaveRequests.workspaceId, ws.id), eq(leaveRequests.status, 'pending')))
    const upcoming = await db.select().from(holidays).where(and(eq(holidays.workspaceId, ws.id), gte(holidays.date, today))).orderBy(asc(holidays.date)).limit(4)
    const runs = can(req, 'payroll.run') ? await runSummaries(db, ws.id, 1) : []
    return {
      overview: {
        headcount: active.length,
        clockedIn: open.map((r) => ({ id: r.e.id, name: fullName(r.e), since: r.since.toISOString() })),
        onLeaveToday: away.map((l) => ({ id: l.employee.id, name: l.employee.name, leaveType: l.leaveType.name })),
        pendingLeave: pending?.n ?? 0,
        lastRun: runs[0] ?? null,
        upcomingHolidays: upcoming.map((h) => ({ id: h.id, date: h.date, name: h.name, kind: h.kind as Holiday['kind'] })),
      },
    }
  })

  /* ---------- employees ---------- */

  app.get('/employees', view, async (req) => {
    const ws = workspaceOf(req)
    const rows = await employeeRows(db, ws.id)
    return { employees: rows.map((r) => summaryOut(req, r.e, r.e.userId && r.userName ? { id: r.e.userId, name: r.userName } : null, r.clockedIn)) }
  })

  app.get('/employees/:id', view, async (req) => ({ employee: await employeeDetail(req, idOf(req.params, 'employee')) }))

  app.post('/employees', manage, async (req, reply) => {
    const input = parse(EmployeeInput, req.body)
    const ws = workspaceOf(req)
    await checkLinkedUser(ws.id, input.userId)
    try {
      const id = await db.transaction(async (tx) => {
        const employeeNo = await nextNumber(tx, ws.id, 'employee')
        const [row] = await tx.insert(employees).values({ workspaceId: ws.id, employeeNo, ...employeeValues(req, input) }).returning()
        await audit(tx, req, { action: 'employee.created', entity: 'employee', entityId: row!.id, summary: `Added employee ${employeeNo} ${fullName(row!)}, ${row!.position}` })
        return row!.id
      })
      return reply.code(201).send({ employee: await employeeDetail(req, id) })
    } catch (e) {
      if (isUniqueViolation(e, 'employees_user_key')) throw new HttpError(409, 'taken', 'That member is already linked to another employee.', 'userId')
      throw e
    }
  })

  app.put('/employees/:id', manage, async (req) => {
    const id = idOf(req.params, 'employee')
    const input = parse(EmployeeInput, req.body)
    const ws = workspaceOf(req)
    await checkLinkedUser(ws.id, input.userId)
    try {
      await db.transaction(async (tx) => {
        const [before] = await tx.select().from(employees).where(and(eq(employees.id, id), eq(employees.workspaceId, ws.id))).for('update')
        if (!before) throw new HttpError(404, 'not-found', 'That employee doesn’t exist.')
        const values = employeeValues(req, input, before)
        await tx.update(employees).set({ ...values, updatedAt: new Date() }).where(eq(employees.id, id))
        // what changed, without the sealed ID numbers
        const plain = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.endsWith('Enc')))
        const after = { ...before, ...values }
        const changed = Object.keys(plain(values)).filter((k) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((after as Record<string, unknown>)[k]))
        const idsChanged = (['tinEnc', 'sssNoEnc', 'philhealthNoEnc', 'pagibigNoEnc'] as const).filter((k) => values[k] !== before[k]).map((k) => k.replace('Enc', ''))
        await audit(tx, req, {
          action: 'employee.updated',
          entity: 'employee',
          entityId: id,
          summary: `Edited employee ${before.employeeNo} ${fullName(after)}${idsChanged.length ? ` (new ${idsChanged.join(', ')})` : ''}`,
          before: Object.fromEntries(changed.map((k) => [k, (before as Record<string, unknown>)[k]])),
          after: Object.fromEntries(changed.map((k) => [k, (after as Record<string, unknown>)[k]])),
        })
      })
    } catch (e) {
      if (isUniqueViolation(e, 'employees_user_key')) throw new HttpError(409, 'taken', 'That member is already linked to another employee.', 'userId')
      throw e
    }
    return { employee: await employeeDetail(req, id) }
  })

  /* ---------- attendance ---------- */

  const Range = z.object({ from: z.iso.date(), to: z.iso.date(), employeeId: z.uuid().optional() }).refine((r) => r.to >= r.from, { message: 'Choose a range.', path: ['to'] })

  app.get('/attendance', view, async (req) => {
    const q = parse(Range, req.query)
    return { entries: await entries(db, workspaceOf(req).id, q.from, q.to, q.employeeId) }
  })

  app.post('/attendance', manage, async (req, reply) => {
    const input = parse(TimeEntryInput, req.body)
    const ws = workspaceOf(req)
    const [e] = await db.select().from(employees).where(and(eq(employees.id, input.employeeId), eq(employees.workspaceId, ws.id)))
    if (!e) throw new HttpError(400, 'invalid', 'Choose the employee.', 'employeeId')
    try {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(timeEntries)
          .values({ workspaceId: ws.id, employeeId: e.id, clockIn: fromManila(input.clockIn), clockOut: input.clockOut ? fromManila(input.clockOut) : null, source: 'manual', note: input.note ?? null, createdBy: userOf(req).id })
          .returning()
        await audit(tx, req, { action: 'attendance.added', entity: 'time_entry', entityId: row!.id, summary: `Added time for ${fullName(e)}: ${input.clockIn.replace('T', ' ')} to ${input.clockOut?.replace('T', ' ') ?? '(still in)'}` })
      })
    } catch (err) {
      if (isUniqueViolation(err, 'time_entries_one_open')) throw new HttpError(409, 'already-in', `${fullName(e)} is already clocked in. Enter the time out too.`, 'clockOut')
      throw err
    }
    return reply.code(201).send({ ok: true })
  })

  app.put('/attendance/:id', manage, async (req) => {
    const id = idOf(req.params, 'time entry')
    const input = parse(TimeEntryInput, req.body)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const [before] = await tx.select().from(timeEntries).where(and(eq(timeEntries.id, id), eq(timeEntries.workspaceId, ws.id))).for('update')
      if (!before) throw new HttpError(404, 'not-found', 'That time entry doesn’t exist.')
      if (before.employeeId !== input.employeeId) throw new HttpError(400, 'invalid', 'A time entry stays with its employee.', 'employeeId')
      const clockIn = fromManila(input.clockIn)
      const clockOut = input.clockOut ? fromManila(input.clockOut) : null
      await tx.update(timeEntries).set({ clockIn, clockOut, note: input.note ?? null, updatedAt: new Date() }).where(eq(timeEntries.id, id))
      await audit(tx, req, {
        action: 'attendance.edited',
        entity: 'time_entry',
        entityId: id,
        summary: `Changed a time entry${input.note ? `: ${input.note}` : ''}`,
        before: { clockIn: before.clockIn, clockOut: before.clockOut },
        after: { clockIn, clockOut },
      })
    })
    return { ok: true }
  })

  app.delete('/attendance/:id', manage, async (req, reply) => {
    const id = idOf(req.params, 'time entry')
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const [before] = await tx.select().from(timeEntries).where(and(eq(timeEntries.id, id), eq(timeEntries.workspaceId, ws.id))).for('update')
      if (!before) throw new HttpError(404, 'not-found', 'That time entry doesn’t exist.')
      await tx.delete(timeEntries).where(eq(timeEntries.id, id))
      await audit(tx, req, { action: 'attendance.deleted', entity: 'time_entry', entityId: id, summary: 'Deleted a time entry', before: { employeeId: before.employeeId, clockIn: before.clockIn, clockOut: before.clockOut } })
    })
    return reply.code(204).send()
  })

  /* ---------- leave ---------- */

  app.get('/leave/types', view, async (req) => {
    const rows = await db.select().from(leaveTypes).where(eq(leaveTypes.workspaceId, workspaceOf(req).id)).orderBy(asc(leaveTypes.name))
    return { leaveTypes: rows.map(leaveTypeOut) }
  })

  app.put('/leave/types/:id', manage, async (req) => {
    const id = idOf(req.params, 'leave type')
    const input = parse(LeaveTypeUpdate, req.body)
    const ws = workspaceOf(req)
    const [before] = await db.select().from(leaveTypes).where(and(eq(leaveTypes.id, id), eq(leaveTypes.workspaceId, ws.id)))
    if (!before) throw new HttpError(404, 'not-found', 'That leave type doesn’t exist.')
    const row = await db.transaction(async (tx) => {
      const [r] = await tx.update(leaveTypes).set(input).where(eq(leaveTypes.id, id)).returning()
      await audit(tx, req, { action: 'leave_type.updated', entity: 'leave_type', entityId: id, summary: `Changed ${input.name}`, before: { paid: before.paid, daysPerYear: before.daysPerYear, active: before.active }, after: input })
      return r!
    })
    return { leaveType: leaveTypeOut(row) }
  })

  app.get('/leave/requests', view, async (req) => {
    const q = parse(z.object({ status: z.enum(LEAVE_STATUSES).optional(), employeeId: z.uuid().optional() }), req.query)
    return { requests: await leaveList(db, workspaceOf(req).id, and(q.status ? eq(leaveRequests.status, q.status) : undefined, q.employeeId ? eq(leaveRequests.employeeId, q.employeeId) : undefined)) }
  })

  /** HR filing leave for someone (it still needs approving, by HR). */
  app.post('/leave/requests', manage, async (req, reply) => {
    const input = parse(LeaveForInput, req.body)
    const ws = workspaceOf(req)
    const [e] = await db.select().from(employees).where(and(eq(employees.id, input.employeeId), eq(employees.workspaceId, ws.id)))
    if (!e) throw new HttpError(400, 'invalid', 'Choose the employee.', 'employeeId')
    const id = await fileLeave(req, ws, e, input)
    return reply.code(201).send({ request: (await leaveList(db, ws.id, eq(leaveRequests.id, id)))[0] })
  })

  for (const decision of ['approve', 'reject'] as const) {
    app.post(`/leave/requests/:id/${decision}`, manage, async (req) => {
      const id = idOf(req.params, 'leave request')
      const input = parse(LeaveDecisionInput, req.body ?? {})
      const ws = workspaceOf(req)
      const decided = await db.transaction(async (tx) => {
        const [l] = await tx.select().from(leaveRequests).where(and(eq(leaveRequests.id, id), eq(leaveRequests.workspaceId, ws.id))).for('update')
        if (!l) throw new HttpError(404, 'not-found', 'That leave request doesn’t exist.')
        if (l.status !== 'pending') throw new HttpError(409, 'decided', 'That request has already been decided.')
        const [e] = await tx.select().from(employees).where(eq(employees.id, l.employeeId))
        if (e!.userId === userOf(req).id) throw new HttpError(403, 'own-request', 'Someone else has to decide your own leave.')
        const status = decision === 'approve' ? 'approved' : 'rejected'
        await tx.update(leaveRequests).set({ status, decidedBy: userOf(req).id, decidedAt: new Date(), decisionNote: input.note ?? null }).where(eq(leaveRequests.id, id))
        await audit(tx, req, { action: `leave.${status}`, entity: 'leave_request', entityId: id, summary: `${decision === 'approve' ? 'Approved' : 'Turned down'} ${l.days} day(s) of leave for ${fullName(e!)} from ${l.startDate}` })
        return { employee: e!, status, leave: l }
      })
      await notifyLater(async () => {
        if (!decided.employee.userId) return
        await sendPush([decided.employee.userId], {
          title: `${ws.name}: leave ${decided.status === 'approved' ? 'approved' : 'not approved'}`,
          body: `Your leave from ${decided.leave.startDate} (${decided.leave.days} day(s))${input.note ? `: ${input.note}` : ''}`,
          data: { workspaceId: ws.id, screen: 'leave' },
        })
      })
      return { request: (await leaveList(db, ws.id, eq(leaveRequests.id, id)))[0] }
    })
  }

  /** Cancelling approved leave (it was filed by mistake, or plans changed). */
  app.post('/leave/requests/:id/cancel', manage, async (req) => {
    const id = idOf(req.params, 'leave request')
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const [l] = await tx.select().from(leaveRequests).where(and(eq(leaveRequests.id, id), eq(leaveRequests.workspaceId, ws.id))).for('update')
      if (!l) throw new HttpError(404, 'not-found', 'That leave request doesn’t exist.')
      if (!['pending', 'approved'].includes(l.status)) throw new HttpError(409, 'decided', 'Only waiting or approved leave can be cancelled.')
      await tx.update(leaveRequests).set({ status: 'cancelled' }).where(eq(leaveRequests.id, id))
      await audit(tx, req, { action: 'leave.cancelled', entity: 'leave_request', entityId: id, summary: `Cancelled ${l.days} day(s) of leave from ${l.startDate}` })
    })
    return { request: (await leaveList(db, ws.id, eq(leaveRequests.id, id)))[0] }
  })

  /* ---------- holidays and government rates ---------- */

  app.get('/holidays', view, async (req) => {
    const q = parse(z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }), req.query)
    const year = q.year ?? Number(todayInManila().slice(0, 4))
    const rows = await db
      .select()
      .from(holidays)
      .where(and(eq(holidays.workspaceId, workspaceOf(req).id), gte(holidays.date, `${year}-01-01`), lte(holidays.date, `${year}-12-31`)))
      .orderBy(asc(holidays.date))
    return { holidays: rows.map((h): Holiday => ({ id: h.id, date: h.date, name: h.name, kind: h.kind as Holiday['kind'] })) }
  })

  app.post('/holidays', manage, async (req, reply) => {
    const input = parse(HolidayInput, req.body)
    const ws = workspaceOf(req)
    try {
      const row = await db.transaction(async (tx) => {
        const [r] = await tx.insert(holidays).values({ workspaceId: ws.id, ...input }).returning()
        await audit(tx, req, { action: 'holiday.added', entity: 'holiday', entityId: r!.id, summary: `Added ${input.kind === 'regular' ? 'regular holiday' : 'special day'} ${input.name} on ${input.date}` })
        return r!
      })
      return reply.code(201).send({ holiday: { id: row.id, date: row.date, name: row.name, kind: row.kind } })
    } catch (e) {
      if (isUniqueViolation(e, 'holidays_date_key')) throw new HttpError(409, 'taken', 'There’s already a holiday on that date.', 'date')
      throw e
    }
  })

  app.delete('/holidays/:id', manage, async (req, reply) => {
    const id = idOf(req.params, 'holiday')
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const [h] = await tx.select().from(holidays).where(and(eq(holidays.id, id), eq(holidays.workspaceId, ws.id)))
      if (!h) throw new HttpError(404, 'not-found', 'That holiday doesn’t exist.')
      await tx.delete(holidays).where(eq(holidays.id, id))
      await audit(tx, req, { action: 'holiday.removed', entity: 'holiday', entityId: id, summary: `Removed ${h.name} on ${h.date}` })
    })
    return reply.code(204).send()
  })

  app.get('/gov-rates', view, async () => {
    const rows = await db.select().from(govRates).orderBy(asc(govRates.kind), desc(govRates.effectiveFrom))
    return { rates: rows.map((r): GovRate => ({ id: r.id, kind: r.kind as GovRate['kind'], effectiveFrom: r.effectiveFrom, source: r.source, data: r.data })) }
  })

  /* ---------- self-service: the signed-in member as an employee ---------- */

  app.get('/me/hr', self, async (req): Promise<{ me: MyHr }> => {
    const ws = workspaceOf(req)
    const e = await myEmployee(req)
    if (!e) return { me: { employee: null, openEntry: null, today: [], leave: [], requests: [], payslips: [] } }
    const today = todayInManila()
    const mine = await entries(db, ws.id, today, today, e.id)
    const [openRow] = await db.select().from(timeEntries).where(and(eq(timeEntries.employeeId, e.id), isNull(timeEntries.clockOut)))
    const slips = await db
      .select({ l: payrollLines, r: payrollRuns })
      .from(payrollLines)
      .innerJoin(payrollRuns, eq(payrollRuns.id, payrollLines.runId))
      .where(and(eq(payrollLines.employeeId, e.id), ne(payrollRuns.status, 'draft')))
      .orderBy(desc(payrollRuns.payDate))
      .limit(24)
    return {
      me: {
        employee: { id: e.id, employeeNo: e.employeeNo, name: fullName(e), position: e.position, shiftStart: e.shiftStart },
        openEntry: openRow ? entryOut(openRow, { id: e.id, name: fullName(e) }) : null,
        today: mine,
        leave: await balances(db, ws.id, e, today.slice(0, 4)),
        requests: (await leaveList(db, ws.id, eq(leaveRequests.employeeId, e.id))).slice(0, 20),
        payslips: slips.map((s) => ({ id: s.l.id, runNumber: s.r.number, kind: s.r.kind as 'regular' | 'thirteenth', periodStart: s.r.periodStart, periodEnd: s.r.periodEnd, payDate: s.r.payDate, net: s.l.net })),
      },
    }
  })

  app.post('/me/clock', self, async (req) => {
    const input = parse(ClockInput, req.body)
    const e = await requireMe(req)
    if (e.separationDate && e.separationDate < todayInManila()) throw new HttpError(403, 'separated', 'Your employment has ended, so you can’t clock in here.')
    await clock(req, e, input)
    const ws = workspaceOf(req)
    const today = todayInManila()
    return { today: await entries(db, ws.id, today, today, e.id), clockedIn: input.action === 'in' }
  })

  app.get('/me/attendance', self, async (req) => {
    const q = parse(Range, req.query)
    const e = await requireMe(req)
    return { entries: await entries(db, workspaceOf(req).id, q.from, q.to, e.id) }
  })

  app.post('/me/leave', self, async (req, reply) => {
    const input = parse(LeaveRequestInput, req.body)
    const e = await requireMe(req)
    const ws = workspaceOf(req)
    const id = await fileLeave(req, ws, e, input)
    return reply.code(201).send({ request: (await leaveList(db, ws.id, eq(leaveRequests.id, id)))[0] })
  })

  app.post('/me/leave/:id/cancel', self, async (req) => {
    const id = idOf(req.params, 'leave request')
    const e = await requireMe(req)
    const ws = workspaceOf(req)
    const [l] = await db.select().from(leaveRequests).where(and(eq(leaveRequests.id, id), eq(leaveRequests.employeeId, e.id)))
    if (!l) throw new HttpError(404, 'not-found', 'That leave request doesn’t exist.')
    if (l.status !== 'pending') throw new HttpError(409, 'decided', 'It’s been decided already. Ask HR to cancel approved leave.')
    await db.update(leaveRequests).set({ status: 'cancelled' }).where(eq(leaveRequests.id, id))
    await audit(db, req, { action: 'leave.cancelled', entity: 'leave_request', entityId: id, summary: `${fullName(e)} withdrew a leave request from ${l.startDate}` })
    return { request: (await leaveList(db, ws.id, eq(leaveRequests.id, id)))[0] }
  })

  app.get('/me/leave-types', self, async (req) => {
    const rows = await db.select().from(leaveTypes).where(and(eq(leaveTypes.workspaceId, workspaceOf(req).id), eq(leaveTypes.active, true))).orderBy(asc(leaveTypes.name))
    return { leaveTypes: rows.map(leaveTypeOut) }
  })
}

