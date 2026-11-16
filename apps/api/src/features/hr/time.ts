import { emptyInputs, type DayType, type MinimumWages, type PayInputs, type PayrollRates } from '@erp/shared'
import { sql } from 'drizzle-orm'
import { employees } from '../../db/schema.ts'
import type { Executor } from '../../db/types.ts'
import { HttpError } from '../../lib/errors.ts'

/**
 * Dates and times for HR, in Philippine time (UTC+8, no daylight saving), and the working out of
 * what a pay period's clock-ins mean for pay.
 */

const MANILA = 8 * 3_600_000
/** The Manila calendar date of a moment: "2026-11-16". */
export const manilaDate = (d: Date) => new Date(d.getTime() + MANILA).toISOString().slice(0, 10)
/** Minutes since Manila midnight. */
export const manilaMinutes = (d: Date) => {
  const local = new Date(d.getTime() + MANILA)
  return local.getUTCHours() * 60 + local.getUTCMinutes()
}
/** "2026-11-16T08:02" in Manila → a moment. */
export const fromManila = (local: string) => new Date(`${local}:00+08:00`)
/** A moment → "2026-11-16T08:02" in Manila, for forms. */
export const toManila = (d: Date) => new Date(d.getTime() + MANILA).toISOString().slice(0, 16)

export const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
export const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay()
export function* daysBetween(from: string, to: string) {
  for (let d = from; d <= to; d = addDays(d, 1)) yield d
}
/** The last day of a date's month. */
export const monthEnd = (date: string) => {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + 1, 0)
  return d.toISOString().slice(0, 10)
}

type EmployeeRow = typeof employees.$inferSelect
export type HolidayMap = Map<string, 'regular' | 'special'>

export function dayTypeOf(date: string, restDays: number[], holidays: HolidayMap): DayType {
  const rest = restDays.includes(weekday(date))
  const h = holidays.get(date)
  if (h === 'regular') return rest ? 'holiday_rest' : 'holiday'
  if (h === 'special') return rest ? 'special_rest' : 'special'
  return rest ? 'rest' : 'regular'
}

/** Workdays a leave covers: not rest days, not holidays. */
export function leaveDays(start: string, end: string, halfDay: boolean, restDays: number[], holidays: HolidayMap) {
  let n = 0
  for (const d of daysBetween(start, end)) if (dayTypeOf(d, restDays, holidays) === 'regular') n++
  return halfDay ? n / 2 : n
}

/** Minutes of an entry between 10 pm and 6 am (Manila), exactly. */
function nightMinutes(from: Date, to: Date) {
  let ms = 0
  for (let d = addDays(manilaDate(from), -1); d <= manilaDate(to); d = addDays(d, 1)) {
    const start = fromManila(`${d}T22:00`).getTime()
    const end = fromManila(`${addDays(d, 1)}T06:00`).getTime()
    ms += Math.max(0, Math.min(end, to.getTime()) - Math.max(start, from.getTime()))
  }
  return ms / 60_000
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * A period's pay inputs from clock-ins, leave and holidays. Per day:
 * - worked time is the day's entries added up, less an hour's break when over 5 hours; up to 8
 *   hours is the day's work, the rest overtime;
 * - on an ordinary workday, time short of 8 hours is lateness/undertime; no clock-in and no leave
 *   is an absence; paid leave is paid;
 * - work on a rest day, special day or holiday earns that day's rate; a regular holiday not worked
 *   is still paid (daily-paid; monthly salaries already include it).
 * Someone who doesn't clock in is paid in full: every workday counts as worked, less unpaid leave.
 * Days before they were hired or after they left count as absences.
 */
export function deriveInputs(args: {
  employee: EmployeeRow
  periodStart: string
  periodEnd: string
  holidays: HolidayMap
  entries: { clockIn: Date; clockOut: Date | null }[]
  leave: Map<string, { fraction: number; paid: boolean }>
}): PayInputs {
  const e = args.employee
  const x = emptyInputs()
  const byDay = new Map<string, { worked: number; night: number }>()
  for (const t of args.entries) {
    if (!t.clockOut) continue
    const day = manilaDate(t.clockIn)
    const cur = byDay.get(day) ?? { worked: 0, night: 0 }
    cur.worked += (t.clockOut.getTime() - t.clockIn.getTime()) / 60_000
    cur.night += nightMinutes(t.clockIn, t.clockOut)
    byDay.set(day, cur)
  }
  for (const d of daysBetween(args.periodStart, args.periodEnd)) {
    const type = dayTypeOf(d, e.restDays, args.holidays)
    const employed = d >= e.hireDate && (!e.separationDate || d <= e.separationDate)
    if (!employed) {
      if (type === 'regular') x.absentDays += 1
      continue
    }
    const leave = args.leave.get(d)
    const leaveFraction = leave?.fraction ?? 0
    const day = byDay.get(d)
    const worked = day ? (day.worked > 300 ? day.worked - 60 : day.worked) : 0
    const regular = Math.min(480, worked)
    const overtime = Math.max(0, worked - 480)
    if (type === 'regular') {
      if (leave) {
        if (leave.paid) x.paidDays += leaveFraction
        else x.absentDays += leaveFraction
      }
      const due = 1 - leaveFraction
      if (due <= 0) continue
      if (!e.tracksAttendance) {
        x.daysWorked += due
      } else if (worked > 0) {
        x.daysWorked += due
        x.lateMinutes += Math.max(0, Math.round(480 * due - regular))
        x.overtime.regular += overtime / 60
        x.nightHours += (day?.night ?? 0) / 60
      } else {
        x.absentDays += due
      }
    } else {
      if (e.tracksAttendance && worked > 0) {
        x.dayHours[type] += regular / 60
        x.overtime[type] += overtime / 60
        x.nightHours += (day?.night ?? 0) / 60
      }
      if (type === 'holiday' && !(e.tracksAttendance && worked > 0)) x.paidDays += 1
    }
  }
  x.lateMinutes = Math.round(x.lateMinutes)
  x.nightHours = round2(x.nightHours)
  for (const k of Object.keys(x.overtime) as DayType[]) x.overtime[k] = round2(x.overtime[k])
  for (const k of Object.keys(x.dayHours) as DayType[]) x.dayHours[k] = round2(x.dayHours[k])
  return x
}

/** The government rates in force on a date: the newest row of each kind on or before it. */
export async function ratesOn(db: Executor, date: string): Promise<{ rates: PayrollRates; minimumWages: MinimumWages }> {
  const rows = await db.execute<{ kind: string; data: unknown }>(sql`
    select distinct on (kind) kind, data from gov_rates where effective_from <= ${date} order by kind, effective_from desc
  `)
  const by = new Map(rows.rows.map((r) => [r.kind, r.data]))
  for (const k of ['sss', 'philhealth', 'pagibig', 'wtax', 'premiums', 'thirteenth']) {
    if (!by.has(k)) throw new HttpError(409, 'missing-rates', `No ${k} rates are in force on ${date}.`)
  }
  return {
    rates: {
      sss: by.get('sss') as PayrollRates['sss'],
      philhealth: by.get('philhealth') as PayrollRates['philhealth'],
      pagibig: by.get('pagibig') as PayrollRates['pagibig'],
      wtax: by.get('wtax') as PayrollRates['wtax'],
      premiums: by.get('premiums') as PayrollRates['premiums'],
      thirteenthExempt: (by.get('thirteenth') as { thirteenthExempt: number }).thirteenthExempt,
    },
    minimumWages: (by.get('minimum_wage') ?? {}) as MinimumWages,
  }
}
