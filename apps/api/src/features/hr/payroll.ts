import {
  computePay,
  computeThirteenth,
  dailyRateOf,
  formatPeso,
  fullName,
  PayInputs,
  PayrollRunInput,
  PayRunPaymentInput,
  taxFromTable,
  type Form2316,
  type MonthlyRemittance,
  type PayBasis,
  type PayFrequency,
  type PayResult,
  type Payslip,
  type PayrollLine,
  type PayrollRates,
  type PayrollRun,
  type PayrollRunSummary,
  type RemittanceRow,
  type RunKind,
} from '@erp/shared'
import { and, asc, desc, eq, gte, isNull, lte, ne, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client.ts'
import { accounts, employees, leaveRequests, leaveTypes, payrollLines, payrollRuns, timeEntries, type WorkspaceRow } from '../../db/schema.ts'
import type { Executor, Tx } from '../../db/types.ts'
import { audit } from '../../lib/audit.ts'
import { HttpError, parse } from '../../lib/errors.ts'
import { notifyLater, sendPush } from '../../lib/push.ts'
import { userOf } from '../../lib/session.ts'
import { needs, workspaceOf } from '../../lib/workspace.ts'
import { nextNumber, postEntry, systemAccount } from '../finance/ledger.ts'
import { govIds, holidayMap } from './people.ts'
import { daysBetween, deriveInputs, fromManila, monthEnd, ratesOn } from './time.ts'

/**
 * Payroll runs: a draft is worked out from clock-ins, leave and the rates in force, can be checked
 * and edited line by line, then posted (it gets its PR- number, its journal entry, and payslips go
 * out) and finally marked paid.
 *
 * Posting: Dr Salaries and Wages (or 13th Month Pay) for the gross, Dr Contributions for the
 * employer's share / Cr SSS, PhilHealth and Pag-IBIG Payable (both shares), Cr Withholding Tax on
 * Compensation Payable, Cr Other Payroll Deductions, Cr Salaries Payable for the net. Paying it:
 * Dr Salaries Payable / Cr the cash or bank account.
 */

const run = needs('payroll.run', 'hr')
const self = needs('member', 'hr')

const IdParam = z.object({ id: z.uuid() })
const idOf = (params: unknown, what: string) => {
  const r = IdParam.safeParse(params)
  if (!r.success) throw new HttpError(404, 'not-found', `That ${what} doesn’t exist.`)
  return r.data.id
}

type RunRow = typeof payrollRuns.$inferSelect
type LineRow = typeof payrollLines.$inferSelect
type EmployeeRow = typeof employees.$inferSelect

/* ---------------------------------------------------------------------------------------------
 * Working out a line
 * ------------------------------------------------------------------------------------------- */

const asPay = (e: EmployeeRow) => ({ payBasis: e.payBasis as PayBasis, rate: e.rate, workDaysPerYear: e.workDaysPerYear, minimumWageEarner: e.minimumWageEarner })

/** Inputs from the period's clock-ins, approved leave and holidays. */
async function inputsFor(db: Executor, ws: WorkspaceRow, r: Pick<RunRow, 'periodStart' | 'periodEnd'>, e: EmployeeRow) {
  const hols = await holidayMap(db, ws.id, r.periodStart, r.periodEnd)
  const entries = await db
    .select({ clockIn: timeEntries.clockIn, clockOut: timeEntries.clockOut })
    .from(timeEntries)
    .where(and(eq(timeEntries.employeeId, e.id), gte(timeEntries.clockIn, fromManila(`${r.periodStart}T00:00`)), lte(timeEntries.clockIn, fromManila(`${r.periodEnd}T23:59`))))
  const leaves = await db
    .select({ l: leaveRequests, paid: leaveTypes.paid })
    .from(leaveRequests)
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .where(and(eq(leaveRequests.employeeId, e.id), eq(leaveRequests.status, 'approved'), lte(leaveRequests.startDate, r.periodEnd), gte(leaveRequests.endDate, r.periodStart)))
  const leave = new Map<string, { fraction: number; paid: boolean }>()
  for (const { l, paid } of leaves) for (const d of daysBetween(l.startDate, l.endDate)) leave.set(d, { fraction: l.halfDay ? 0.5 : 1, paid })
  return deriveInputs({ employee: e, periodStart: r.periodStart, periodEnd: r.periodEnd, holidays: hols, entries, leave })
}

/** Figures this employee has already been paid in posted runs (for month-to-date and the year). */
async function paidBefore(db: Executor, employeeId: string, runId: string, where: ReturnType<typeof and>) {
  const [row] = await db
    .select({
      grossTaxable: sql<number>`coalesce(sum(${payrollLines.grossTaxable}), 0)::bigint`.mapWith(Number),
      basic: sql<number>`coalesce(sum(${payrollLines.basic}), 0)::bigint`.mapWith(Number),
      gross: sql<number>`coalesce(sum(${payrollLines.gross}), 0)::bigint`.mapWith(Number),
      taxable: sql<number>`coalesce(sum(${payrollLines.taxable}), 0)::bigint`.mapWith(Number),
    })
    .from(payrollLines)
    .innerJoin(payrollRuns, eq(payrollRuns.id, payrollLines.runId))
    .where(and(eq(payrollLines.employeeId, employeeId), ne(payrollRuns.id, runId), ne(payrollRuns.status, 'draft'), where))
  return row ?? { grossTaxable: 0, basic: 0, gross: 0, taxable: 0 }
}

async function resultFor(db: Executor, r: RunRow, e: EmployeeRow, inputs: PayInputs, rates: PayrollRates): Promise<PayResult> {
  if (r.kind === 'thirteenth') {
    const year = r.periodEnd.slice(0, 4)
    const inYear = (kind: RunKind) => and(eq(payrollRuns.kind, kind), gte(payrollRuns.payDate, `${year}-01-01`), lte(payrollRuns.payDate, `${year}-12-31`))
    const regular = await paidBefore(db, e.id, r.id, inYear('regular'))
    const thirteenth = await paidBefore(db, e.id, r.id, inYear('thirteenth'))
    return computeThirteenth({ basicThisYear: regular.basic, alreadyPaid: thirteenth.gross, taxableThisYear: regular.taxable, minimumWageEarner: e.minimumWageEarner, rates })
  }
  const month = r.periodEnd.slice(0, 7)
  const before = await paidBefore(db, e.id, r.id, and(eq(payrollRuns.kind, 'regular'), gte(payrollRuns.periodEnd, `${month}-01`), lte(payrollRuns.periodEnd, monthEnd(r.periodEnd))))
  return computePay({ employee: asPay(e), frequency: r.frequency as PayFrequency, inputs, rates, takesContributions: r.takesContributions, monthToDate: { grossTaxable: before.grossTaxable } })
}

const lineColumns = (e: EmployeeRow, inputs: PayInputs, result: PayResult) => ({
  payBasis: e.payBasis,
  dailyRate: dailyRateOf(asPay(e)),
  minimumWageEarner: e.minimumWageEarner,
  inputs,
  result,
  basic: result.basic,
  gross: result.gross,
  grossTaxable: result.grossTaxable,
  nonTaxable: result.nonTaxable,
  taxable: result.taxable,
  sssMsc: result.sss.msc,
  sssEe: result.sss.ee,
  sssEr: result.sss.er,
  sssEc: result.sss.ec,
  philhealthBase: result.philhealth.base,
  philhealthEe: result.philhealth.ee,
  philhealthEr: result.philhealth.er,
  pagibigBase: result.pagibig.base,
  pagibigEe: result.pagibig.ee,
  pagibigEr: result.pagibig.er,
  tax: result.tax,
  otherDeductions: result.otherDeductions,
  net: result.net,
})

/** Works out every line of a draft again. Lines edited by hand keep their inputs; the rest are re-read from clock-ins. */
async function recompute(tx: Tx, ws: WorkspaceRow, r: RunRow, opts: { rederive: boolean }) {
  const { rates } = await ratesOn(tx, r.periodEnd)
  const lines = await tx.select({ l: payrollLines, e: employees }).from(payrollLines).innerJoin(employees, eq(employees.id, payrollLines.employeeId)).where(eq(payrollLines.runId, r.id))
  for (const { l, e } of lines) {
    const inputs = opts.rederive && !l.edited && r.kind === 'regular' ? await inputsFor(tx, ws, r, e) : PayInputs.parse(l.inputs)
    await tx.update(payrollLines).set(lineColumns(e, inputs, await resultFor(tx, r, e, inputs, rates))).where(eq(payrollLines.id, l.id))
  }
}

/* ---------------------------------------------------------------------------------------------
 * Shapes
 * ------------------------------------------------------------------------------------------- */

const totalsSql = {
  headcount: sql<number>`count(${payrollLines.id})::int`,
  gross: sql<number>`coalesce(sum(${payrollLines.gross}), 0)::bigint`.mapWith(Number),
  net: sql<number>`coalesce(sum(${payrollLines.net}), 0)::bigint`.mapWith(Number),
  employer: sql<number>`coalesce(sum(${payrollLines.sssEr} + ${payrollLines.sssEc} + ${payrollLines.philhealthEr} + ${payrollLines.pagibigEr}), 0)::bigint`.mapWith(Number),
}

const summaryOut = (r: RunRow, t: { headcount: number; gross: number; net: number; employer: number }): PayrollRunSummary => ({
  id: r.id,
  number: r.number,
  kind: r.kind as RunKind,
  frequency: r.frequency as PayFrequency,
  periodStart: r.periodStart,
  periodEnd: r.periodEnd,
  payDate: r.payDate,
  status: r.status,
  takesContributions: r.takesContributions,
  headcount: t.headcount,
  gross: t.gross,
  net: t.net,
  employerCost: t.gross + t.employer,
  journalEntryId: r.journalEntryId,
  paymentEntryId: r.paymentEntryId,
})

export async function runSummaries(db: Executor, workspaceId: string, limit = 100) {
  const rows = await db
    .select({ r: payrollRuns, ...totalsSql })
    .from(payrollRuns)
    .leftJoin(payrollLines, eq(payrollLines.runId, payrollRuns.id))
    .where(eq(payrollRuns.workspaceId, workspaceId))
    .groupBy(payrollRuns.id)
    .orderBy(desc(payrollRuns.periodEnd), desc(payrollRuns.createdAt))
    .limit(limit)
  return rows.map((x) => summaryOut(x.r, x))
}

async function runDetail(db: Executor, workspaceId: string, id: string): Promise<PayrollRun> {
  const [summary] = await db
    .select({ r: payrollRuns, ...totalsSql })
    .from(payrollRuns)
    .leftJoin(payrollLines, eq(payrollLines.runId, payrollRuns.id))
    .where(and(eq(payrollRuns.id, id), eq(payrollRuns.workspaceId, workspaceId)))
    .groupBy(payrollRuns.id)
  if (!summary) throw new HttpError(404, 'not-found', 'That payroll doesn’t exist.')
  const lines = await db
    .select({ l: payrollLines, e: employees })
    .from(payrollLines)
    .innerJoin(employees, eq(employees.id, payrollLines.employeeId))
    .where(eq(payrollLines.runId, id))
    .orderBy(asc(employees.lastName), asc(employees.firstName))
  return {
    ...summaryOut(summary.r, summary),
    lines: lines.map(
      ({ l, e }): PayrollLine => ({
        id: l.id,
        employee: { id: e.id, employeeNo: e.employeeNo, name: fullName(e), position: e.position },
        payBasis: l.payBasis as PayBasis,
        dailyRate: l.dailyRate,
        inputs: PayInputs.parse(l.inputs),
        edited: l.edited,
        result: l.result as PayResult,
      }),
    ),
  }
}

async function lockRun(tx: Tx, workspaceId: string, id: string) {
  const [r] = await tx.select().from(payrollRuns).where(and(eq(payrollRuns.id, id), eq(payrollRuns.workspaceId, workspaceId))).for('update')
  if (!r) throw new HttpError(404, 'not-found', 'That payroll doesn’t exist.')
  return r
}

async function payslip(db: Executor, ws: WorkspaceRow, lineId: string, employeeId?: string): Promise<Payslip> {
  const [row] = await db
    .select({ l: payrollLines, r: payrollRuns, e: employees })
    .from(payrollLines)
    .innerJoin(payrollRuns, eq(payrollRuns.id, payrollLines.runId))
    .innerJoin(employees, eq(employees.id, payrollLines.employeeId))
    .where(and(eq(payrollLines.id, lineId), eq(payrollLines.workspaceId, ws.id), employeeId ? and(eq(payrollLines.employeeId, employeeId), ne(payrollRuns.status, 'draft')) : undefined))
  if (!row) throw new HttpError(404, 'not-found', 'That payslip doesn’t exist.')
  const ids = govIds(row.e)
  return {
    id: row.l.id,
    run: { id: row.r.id, number: row.r.number, kind: row.r.kind as RunKind, periodStart: row.r.periodStart, periodEnd: row.r.periodEnd, payDate: row.r.payDate, status: row.r.status },
    employer: { name: ws.name, tin: ws.tin, address: ws.registeredAddress },
    employee: { id: row.e.id, employeeNo: row.e.employeeNo, name: fullName(row.e), position: row.e.position, ...ids },
    result: row.l.result as PayResult,
  }
}

/* ---------------------------------------------------------------------------------------------
 * Reports
 * ------------------------------------------------------------------------------------------- */

async function postedLines(db: Executor, workspaceId: string, where: ReturnType<typeof and>) {
  return db
    .select({ l: payrollLines, r: payrollRuns, e: employees })
    .from(payrollLines)
    .innerJoin(payrollRuns, eq(payrollRuns.id, payrollLines.runId))
    .innerJoin(employees, eq(employees.id, payrollLines.employeeId))
    .where(and(eq(payrollLines.workspaceId, workspaceId), ne(payrollRuns.status, 'draft'), where))
    .orderBy(asc(employees.lastName), asc(employees.firstName))
}

async function monthlyRemittance(db: Executor, workspaceId: string, month: string): Promise<MonthlyRemittance> {
  const from = `${month}-01`
  const to = monthEnd(from)
  // contributions belong to the month the pay was for; withholding to the month it was paid
  const contrib = await postedLines(db, workspaceId, and(eq(payrollRuns.kind, 'regular'), gte(payrollRuns.periodEnd, from), lte(payrollRuns.periodEnd, to)))
  const paid = await postedLines(db, workspaceId, and(gte(payrollRuns.payDate, from), lte(payrollRuns.payDate, to)))
  const group = (pick: (l: LineRow) => { base: number; ee: number; er: number; ec?: number }, idOf: (ids: ReturnType<typeof govIds>) => string | null) => {
    const by = new Map<string, RemittanceRow>()
    for (const { l, e } of contrib) {
      const v = pick(l)
      if (!v.ee && !v.er) continue
      const cur = by.get(e.id) ?? { employeeId: e.id, employeeNo: e.employeeNo, name: `${e.lastName}, ${e.firstName}${e.middleName ? ` ${e.middleName[0]}.` : ''}`, idNumber: idOf(govIds(e)), base: 0, ee: 0, er: 0, ...(v.ec !== undefined ? { ec: 0 } : {}) }
      cur.base = Math.max(cur.base, v.base)
      cur.ee += v.ee
      cur.er += v.er
      if (v.ec !== undefined) cur.ec = (cur.ec ?? 0) + v.ec
      by.set(e.id, cur)
    }
    return [...by.values()]
  }
  const wtax = { totalCompensation: 0, nonTaxableMwe: 0, nonTaxableThirteenth: 0, nonTaxableDeMinimis: 0, nonTaxableContributions: 0, taxable: 0, withheld: 0, employees: 0 }
  const people = new Set<string>()
  for (const { l, r } of paid) {
    people.add(l.employeeId)
    const contributions = l.sssEe + l.philhealthEe + l.pagibigEe
    wtax.totalCompensation += l.gross
    if (r.kind === 'thirteenth') wtax.nonTaxableThirteenth += l.nonTaxable
    else wtax.nonTaxableDeMinimis += l.nonTaxable
    wtax.nonTaxableContributions += contributions
    if (l.minimumWageEarner) wtax.nonTaxableMwe += l.taxable
    else wtax.taxable += l.taxable
    wtax.withheld += l.tax
  }
  wtax.employees = people.size
  return {
    month,
    sss: group((l) => ({ base: l.sssMsc, ee: l.sssEe, er: l.sssEr, ec: l.sssEc }), (i) => i.sssNo),
    philhealth: group((l) => ({ base: l.philhealthBase, ee: l.philhealthEe, er: l.philhealthEr }), (i) => i.philhealthNo),
    pagibig: group((l) => ({ base: l.pagibigBase, ee: l.pagibigEe, er: l.pagibigEr }), (i) => i.pagibigNo),
    wtax,
  }
}

async function form2316(db: Executor, ws: WorkspaceRow, year: number, employeeId: string): Promise<Form2316> {
  const [e] = await db.select().from(employees).where(and(eq(employees.id, employeeId), eq(employees.workspaceId, ws.id)))
  if (!e) throw new HttpError(404, 'not-found', 'That employee doesn’t exist.')
  const lines = await postedLines(db, ws.id, and(eq(payrollLines.employeeId, employeeId), gte(payrollRuns.payDate, `${year}-01-01`), lte(payrollRuns.payDate, `${year}-12-31`)))
  const n = { mwe: 0, thirteenth: 0, deMinimis: 0, contributions: 0, total: 0 }
  let gross = 0
  let taxable = 0
  let withheld = 0
  for (const { l, r } of lines) {
    gross += l.gross
    withheld += l.tax
    n.contributions += l.sssEe + l.philhealthEe + l.pagibigEe
    if (r.kind === 'thirteenth') n.thirteenth += l.nonTaxable
    else n.deMinimis += l.nonTaxable
    if (l.minimumWageEarner) n.mwe += l.taxable
    else taxable += l.taxable
  }
  n.total = n.mwe + n.thirteenth + n.deMinimis + n.contributions
  const { rates } = await ratesOn(db, `${year}-12-31`)
  const taxDue = taxFromTable(rates.wtax.annual, taxable)
  const ids = govIds(e)
  return {
    year,
    employee: { name: fullName(e), tin: ids.tin, address: e.address, minimumWageEarner: e.minimumWageEarner },
    employer: { name: ws.name, tin: ws.tin, address: ws.registeredAddress },
    gross,
    nonTaxable: n,
    taxable,
    taxDue,
    withheld,
    difference: taxDue - withheld,
  }
}

/* ---------------------------------------------------------------------------------------------
 * Routes
 * ------------------------------------------------------------------------------------------- */

export default async function payrollRoutes(app: FastifyInstance) {
  app.get('/payroll/runs', run, async (req) => ({ runs: await runSummaries(db, workspaceOf(req).id) }))

  app.get('/payroll/runs/:id', run, async (req) => ({ run: await runDetail(db, workspaceOf(req).id, idOf(req.params, 'payroll')) }))

  /** A draft run for everyone paid on that schedule, worked out from the period's clock-ins. */
  app.post('/payroll/runs', run, async (req, reply) => {
    const input = parse(PayrollRunInput, req.body)
    const ws = workspaceOf(req)
    const { rates } = await ratesOn(db, input.periodEnd)
    const id = await db.transaction(async (tx) => {
      if (input.kind === 'regular') {
        const [clash] = await tx
          .select({ number: payrollRuns.number, start: payrollRuns.periodStart, end: payrollRuns.periodEnd })
          .from(payrollRuns)
          .where(and(eq(payrollRuns.workspaceId, ws.id), eq(payrollRuns.kind, 'regular'), eq(payrollRuns.frequency, input.frequency), lte(payrollRuns.periodStart, input.periodEnd), gte(payrollRuns.periodEnd, input.periodStart)))
        if (clash) throw new HttpError(409, 'overlap', `Payroll ${clash.number ?? '(draft)'} already covers ${clash.start} to ${clash.end}.`, 'periodStart')
      }
      const people = await tx
        .select()
        .from(employees)
        .where(
          and(
            eq(employees.workspaceId, ws.id),
            input.kind === 'regular' ? eq(employees.payFrequency, input.frequency) : undefined,
            lte(employees.hireDate, input.periodEnd),
            or(isNull(employees.separationDate), gte(employees.separationDate, input.periodStart)),
          ),
        )
        .orderBy(asc(employees.lastName))
      if (!people.length) throw new HttpError(409, 'nobody', input.kind === 'regular' ? 'Nobody is paid on that schedule in that period. Add employees first, or check their pay frequency.' : 'Nobody worked here that year.')
      const [r] = await tx
        .insert(payrollRuns)
        .values({
          workspaceId: ws.id,
          kind: input.kind,
          frequency: input.frequency,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          payDate: input.payDate,
          takesContributions: input.kind === 'regular' && (input.frequency === 'monthly' || input.periodEnd === monthEnd(input.periodEnd)),
          createdBy: userOf(req).id,
        })
        .returning()
      for (const e of people) {
        const inputs = input.kind === 'regular' ? await inputsFor(tx, ws, r!, e) : PayInputs.parse({})
        await tx.insert(payrollLines).values({ workspaceId: ws.id, runId: r!.id, employeeId: e.id, ...lineColumns(e, inputs, await resultFor(tx, r!, e, inputs, rates)) })
      }
      await audit(tx, req, { action: 'payroll.drafted', entity: 'payroll_run', entityId: r!.id, summary: `Drafted ${input.kind === 'thirteenth' ? '13th month pay' : 'payroll'} for ${input.periodStart} to ${input.periodEnd} (${people.length} employees)` })
      return r!.id
    })
    return reply.code(201).send({ run: await runDetail(db, ws.id, id) })
  })

  /** Changes one person's inputs (overtime, absences, allowances, deductions) and works their pay out again. */
  app.put('/payroll/runs/:id/lines/:lineId', run, async (req) => {
    const id = idOf(req.params, 'payroll')
    const lineId = idOf({ id: (req.params as { lineId?: string }).lineId }, 'payroll line')
    const inputs = PayInputs.parse(parse(z.object({ inputs: PayInputs }), req.body).inputs)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const r = await lockRun(tx, ws.id, id)
      if (r.status !== 'draft') throw new HttpError(409, 'locked', 'A posted payroll can’t be changed. Correct it in the next payroll.')
      const [row] = await tx.select({ l: payrollLines, e: employees }).from(payrollLines).innerJoin(employees, eq(employees.id, payrollLines.employeeId)).where(and(eq(payrollLines.id, lineId), eq(payrollLines.runId, id)))
      if (!row) throw new HttpError(404, 'not-found', 'That payroll line doesn’t exist.')
      const { rates } = await ratesOn(tx, r.periodEnd)
      const result = await resultFor(tx, r, row.e, inputs, rates)
      await tx.update(payrollLines).set({ ...lineColumns(row.e, inputs, result), edited: true }).where(eq(payrollLines.id, lineId))
      await audit(tx, req, { action: 'payroll.line_edited', entity: 'payroll_run', entityId: id, summary: `Changed ${fullName(row.e)}’s pay inputs: net ${formatPeso(row.l.net)} → ${formatPeso(result.net)}`, before: row.l.inputs, after: inputs })
    })
    return { run: await runDetail(db, ws.id, id) }
  })

  /** Reads clock-ins and leave again (for lines not edited by hand) and works everything out again. */
  app.post('/payroll/runs/:id/refresh', run, async (req) => {
    const id = idOf(req.params, 'payroll')
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const r = await lockRun(tx, ws.id, id)
      if (r.status !== 'draft') throw new HttpError(409, 'locked', 'A posted payroll can’t be changed.')
      await recompute(tx, ws, r, { rederive: true })
    })
    return { run: await runDetail(db, ws.id, id) }
  })

  app.delete('/payroll/runs/:id', run, async (req, reply) => {
    const id = idOf(req.params, 'payroll')
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const r = await lockRun(tx, ws.id, id)
      if (r.status !== 'draft') throw new HttpError(409, 'locked', 'A posted payroll can’t be deleted.')
      await tx.delete(payrollRuns).where(eq(payrollRuns.id, id))
      await audit(tx, req, { action: 'payroll.deleted', entity: 'payroll_run', entityId: id, summary: `Deleted a draft payroll for ${r.periodStart} to ${r.periodEnd}` })
    })
    return reply.code(204).send()
  })

  /** Posting: worked out a last time, numbered, booked, and the payslips go out. */
  app.post('/payroll/runs/:id/post', run, async (req) => {
    const id = idOf(req.params, 'payroll')
    const ws = workspaceOf(req)
    const notify: { userId: string }[] = []
    let number = ''
    await db.transaction(async (tx) => {
      const r = await lockRun(tx, ws.id, id)
      if (r.status !== 'draft') throw new HttpError(409, 'locked', 'That payroll has already been posted.')
      await recompute(tx, ws, r, { rederive: false })
      const lines = await tx.select({ l: payrollLines, e: employees }).from(payrollLines).innerJoin(employees, eq(employees.id, payrollLines.employeeId)).where(eq(payrollLines.runId, id))
      const negative = lines.find((x) => x.l.net < 0)
      if (negative) throw new HttpError(409, 'negative-pay', `${fullName(negative.e)}’s deductions are more than their pay (${formatPeso(negative.l.net)}). Change their line first.`)
      const sum = (f: (l: LineRow) => number) => lines.reduce((s, x) => s + f(x.l), 0)
      const gross = sum((l) => l.gross)
      if (gross <= 0) throw new HttpError(409, 'nothing', 'There’s nothing to pay on this payroll.')
      number = await nextNumber(tx, ws.id, 'payroll_run')
      const key = (k: string) => systemAccount(tx, ws.id, k)
      const entry = await postEntry(
        tx,
        { workspaceId: ws.id, date: r.periodEnd, memo: `Payroll ${number}: ${r.kind === 'thirteenth' ? '13th month pay' : `${r.periodStart} to ${r.periodEnd}`}`, source: 'payroll', sourceId: id, createdBy: userOf(req).id },
        [
          { accountId: await key(r.kind === 'thirteenth' ? 'thirteenth_month' : 'salaries'), debit: gross },
          { accountId: await key('contributions_expense'), debit: sum((l) => l.sssEr + l.sssEc + l.philhealthEr + l.pagibigEr) },
          { accountId: await key('sss_payable'), credit: sum((l) => l.sssEe + l.sssEr + l.sssEc) },
          { accountId: await key('philhealth_payable'), credit: sum((l) => l.philhealthEe + l.philhealthEr) },
          { accountId: await key('pagibig_payable'), credit: sum((l) => l.pagibigEe + l.pagibigEr) },
          { accountId: await key('wtax_comp_payable'), credit: sum((l) => l.tax) },
          { accountId: await key('payroll_deductions'), credit: sum((l) => l.otherDeductions) },
          { accountId: await key('salaries_payable'), credit: sum((l) => l.net) },
        ],
      )
      await tx.update(payrollRuns).set({ status: 'posted', number, journalEntryId: entry.id, postedAt: new Date(), updatedAt: new Date() }).where(eq(payrollRuns.id, id))
      await audit(tx, req, { action: 'payroll.posted', entity: 'payroll_run', entityId: id, summary: `Posted payroll ${number} for ${lines.length} employees: ${formatPeso(gross)} gross, ${formatPeso(sum((l) => l.net))} net` })
      for (const x of lines) if (x.e.userId) notify.push({ userId: x.e.userId })
    })
    await notifyLater(async () => {
      if (notify.length) await sendPush(notify.map((n) => n.userId), { title: `${ws.name}: payslip`, body: `Your payslip for payroll ${number} is ready.`, data: { workspaceId: ws.id, screen: 'payslips' } })
    })
    return { run: await runDetail(db, ws.id, id) }
  })

  /** The net pay went out from a cash or bank account. */
  app.post('/payroll/runs/:id/pay', needs('finance.post', 'hr'), async (req) => {
    const id = idOf(req.params, 'payroll')
    const input = parse(PayRunPaymentInput, req.body)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const r = await lockRun(tx, ws.id, id)
      if (r.status !== 'posted') throw new HttpError(409, 'locked', r.status === 'draft' ? 'Post the payroll first.' : 'That payroll has already been paid.')
      if (input.date < r.periodStart) throw new HttpError(400, 'invalid', 'Pay can’t go out before the period starts.', 'date')
      const [cash] = await tx.select().from(accounts).where(and(eq(accounts.id, input.accountId), eq(accounts.workspaceId, ws.id)))
      if (!cash || cash.type !== 'asset' || !['cash', 'bank'].includes(cash.subtype) || !cash.active) throw new HttpError(400, 'invalid', 'Choose a cash or bank account.', 'accountId')
      const [t] = await tx.select({ net: sql<number>`coalesce(sum(${payrollLines.net}), 0)::bigint`.mapWith(Number) }).from(payrollLines).where(eq(payrollLines.runId, id))
      const entry = await postEntry(
        tx,
        { workspaceId: ws.id, date: input.date, memo: `Payroll ${r.number} paid from ${cash.name}`, source: 'payroll_payment', sourceId: id, createdBy: userOf(req).id },
        [
          { accountId: await systemAccount(tx, ws.id, 'salaries_payable'), debit: t!.net },
          { accountId: cash.id, credit: t!.net },
        ],
      )
      await tx.update(payrollRuns).set({ status: 'paid', paymentEntryId: entry.id, updatedAt: new Date() }).where(eq(payrollRuns.id, id))
      await audit(tx, req, { action: 'payroll.paid', entity: 'payroll_run', entityId: id, summary: `Paid payroll ${r.number}: ${formatPeso(t!.net)} from ${cash.name}` })
    })
    return { run: await runDetail(db, ws.id, id) }
  })

  app.get('/payroll/lines/:id', run, async (req) => ({ payslip: await payslip(db, workspaceOf(req), idOf(req.params, 'payslip')) }))

  /* ---------- reports ---------- */

  app.get('/payroll/reports/monthly', run, async (req) => {
    const q = parse(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Choose a month.') }), req.query)
    return { report: await monthlyRemittance(db, workspaceOf(req).id, q.month) }
  })

  app.get('/payroll/reports/2316', run, async (req) => {
    const q = parse(z.object({ year: z.coerce.number().int().min(2000).max(2100), employeeId: z.uuid('Choose the employee.') }), req.query)
    return { report: await form2316(db, workspaceOf(req), q.year, q.employeeId) }
  })

  /* ---------- self-service ---------- */

  app.get('/me/payslips/:id', self, async (req) => {
    const ws = workspaceOf(req)
    const [e] = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.workspaceId, ws.id), eq(employees.userId, userOf(req).id)))
    if (!e) throw new HttpError(404, 'not-found', 'That payslip doesn’t exist.')
    return { payslip: await payslip(db, ws, idOf(req.params, 'payslip'), e.id) }
  })
}

