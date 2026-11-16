import { z } from 'zod'
import { applyRate } from './money.ts'
import { textField } from './workspace.ts'

// HR & payroll (Phase 5), following DOLE, SSS, PhilHealth, Pag-IBIG and BIR rules.
//
// Every government rate lives in a table with the date it applies from (docs/plan.md rule 7): the
// payroll engine below takes them as a parameter and never hard-codes a rate. Money is centavos.

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use ${max} characters or fewer.`)
    .transform((v) => (v === '' ? undefined : v))
    .optional()

const dateSchema = z.iso.date('Enter a date.')
const centavos = (label: string) => z.number(`Enter the ${label}.`).int(`Enter the ${label} to the centavo.`).min(0, `The ${label} can’t be negative.`).max(100_000_000_000, `That ${label} is too large.`)
const hours = (label: string) => z.coerce.number().min(0, `${label} can’t be negative.`).max(744, `That’s more hours than the month has.`)

/** Government ID numbers, as people type them. Stored encrypted; shown masked. */
const idNumber = (label: string, pattern: RegExp, example: string) =>
  z
    .string()
    .trim()
    .transform((v) => (v === '' ? undefined : v))
    .pipe(z.string().regex(pattern, `Enter the ${label} like ${example}.`).optional())
    .optional()

export const SSS_NO = idNumber('SSS number', /^\d{2}-?\d{7}-?\d$/, '34-1234567-8')
export const PHILHEALTH_NO = idNumber('PhilHealth number', /^\d{2}-?\d{9}-?\d$/, '12-345678901-2')
export const PAGIBIG_NO = idNumber('Pag-IBIG MID number', /^\d{4}-?\d{4}-?\d{4}$/, '1234-5678-9012')
export const EMPLOYEE_TIN = idNumber('TIN', /^\d{3}-?\d{3}-?\d{3}(-?\d{3,5})?$/, '123-456-789-00000')

/* ---------------------------------------------------------------------------------------------
 * Employees
 * ------------------------------------------------------------------------------------------- */

export const PAY_BASES = ['monthly', 'daily'] as const
export type PayBasis = (typeof PAY_BASES)[number]
export const PAY_FREQUENCIES = ['semi_monthly', 'monthly'] as const
export type PayFrequency = (typeof PAY_FREQUENCIES)[number]
export const PAY_FREQUENCY_LABELS: Record<PayFrequency, string> = { semi_monthly: 'Twice a month (15th and end of month)', monthly: 'Once a month' }
export const EMPLOYMENT_TYPES = ['regular', 'probationary', 'contractual', 'project'] as const
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number]
export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = { regular: 'Regular', probationary: 'Probationary', contractual: 'Contractual', project: 'Project-based' }
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

export const EmployeeInput = z
  .object({
    firstName: textField('first name', 80),
    middleName: optionalText(80),
    lastName: textField('last name', 80),
    birthDate: dateSchema.nullish(),
    email: z
      .string()
      .trim()
      .transform((v) => (v === '' ? undefined : v.toLowerCase()))
      .pipe(z.email('Enter a valid email address.').optional())
      .optional(),
    phone: optionalText(40),
    address: optionalText(300),
    position: textField('position', 80),
    department: optionalText(80),
    employmentType: z.enum(EMPLOYMENT_TYPES).default('regular'),
    hireDate: dateSchema,
    separationDate: dateSchema.nullish(),
    /** The member who signs in as this employee (for clock-in, leave and payslips on the phone). */
    userId: z.uuid().nullish(),
    tin: EMPLOYEE_TIN,
    sssNo: SSS_NO,
    philhealthNo: PHILHEALTH_NO,
    pagibigNo: PAGIBIG_NO,
    // pay: only someone who may run payroll sees or changes these
    payBasis: z.enum(PAY_BASES).default('monthly'),
    /** Centavos: the monthly salary, or the daily rate. */
    rate: centavos('rate'),
    payFrequency: z.enum(PAY_FREQUENCIES).default('semi_monthly'),
    /** Days paid in a year, to turn a monthly salary into a daily rate: 261 (5-day week) or 313 (6-day week). */
    workDaysPerYear: z.number().int().min(200).max(366).default(261),
    /** Minimum wage earners pay no income tax on their pay (TRAIN law). */
    minimumWageEarner: z.boolean().default(false),
    /** Whether absences, lateness and overtime come from clock-ins. Otherwise pay is in full unless edited. */
    tracksAttendance: z.boolean().default(true),
    shiftStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a time like 08:00.').default('08:00'),
    /** Weekdays off, 0 = Sunday. */
    restDays: z.array(z.number().int().min(0).max(6)).max(6).default([0]),
    /** PSGC region where they work, for the minimum wage check. */
    workRegionCode: z.string().max(12).nullish(),
  })
  .refine((e) => !e.separationDate || e.separationDate >= e.hireDate, { message: 'They can’t leave before they were hired.', path: ['separationDate'] })
export type EmployeeInput = z.input<typeof EmployeeInput>

export type EmployeeSummary = {
  id: string
  employeeNo: string
  name: string
  firstName: string
  lastName: string
  position: string
  department: string | null
  employmentType: EmploymentType
  hireDate: string
  separationDate: string | null
  active: boolean
  user: { id: string; name: string } | null
  /** Null when the viewer may not see pay. */
  pay: { payBasis: PayBasis; rate: number; payFrequency: PayFrequency; dailyRate: number; minimumWageEarner: boolean } | null
  clockedIn: boolean
}

export type Employee = EmployeeSummary & {
  middleName: string | null
  birthDate: string | null
  email: string | null
  phone: string | null
  address: string | null
  /** Masked (•••-•••-789) unless the viewer may manage HR. */
  tin: string | null
  sssNo: string | null
  philhealthNo: string | null
  pagibigNo: string | null
  workDaysPerYear: number
  tracksAttendance: boolean
  shiftStart: string
  restDays: number[]
  workRegionCode: string | null
  /** Set when the daily rate is under the region's minimum wage. */
  minimumWageWarning: string | null
  leave: LeaveBalance[]
}

export const fullName = (e: { firstName: string; middleName?: string | null; lastName: string }) => `${e.firstName} ${e.middleName ? `${e.middleName[0]}. ` : ''}${e.lastName}`

/** A monthly salary as a daily rate: × 12 ÷ days paid in a year. */
export const dailyRateOf = (e: { payBasis: PayBasis; rate: number; workDaysPerYear: number }) => (e.payBasis === 'daily' ? e.rate : Math.round((e.rate * 12) / e.workDaysPerYear))
/** What they earn in a month, for contributions based on salary. */
export const monthlyRateOf = (e: { payBasis: PayBasis; rate: number; workDaysPerYear: number }) => (e.payBasis === 'monthly' ? e.rate : Math.round((e.rate * e.workDaysPerYear) / 12))

/* ---------------------------------------------------------------------------------------------
 * Attendance
 * ------------------------------------------------------------------------------------------- */

export const ClockInput = z.object({
  action: z.enum(['in', 'out']),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  /** Metres. */
  accuracy: z.number().min(0).max(100_000).nullish(),
  source: z.enum(['phone', 'web']).default('web'),
})
export type ClockInput = z.input<typeof ClockInput>

/** HR adding or fixing a time entry by hand. Times are Manila local, "2026-11-16T08:02". */
export const TimeEntryInput = z
  .object({
    employeeId: z.uuid('Choose the employee.'),
    clockIn: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Enter the time in.'),
    clockOut: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Enter the time out.')
      .nullish(),
    note: optionalText(300),
  })
  .refine((t) => !t.clockOut || t.clockOut > t.clockIn, { message: 'Time out must be after time in.', path: ['clockOut'] })
  .refine((t) => !t.clockOut || Date.parse(`${t.clockOut}:00Z`) - Date.parse(`${t.clockIn}:00Z`) <= 24 * 3_600_000, { message: 'One entry can’t be longer than 24 hours.', path: ['clockOut'] })
export type TimeEntryInput = z.input<typeof TimeEntryInput>

export type TimeEntry = {
  id: string
  employee: { id: string; name: string }
  /** ISO timestamps. */
  clockIn: string
  clockOut: string | null
  inLocation: { latitude: number; longitude: number; accuracy: number | null } | null
  outLocation: { latitude: number; longitude: number; accuracy: number | null } | null
  source: 'phone' | 'web' | 'manual'
  note: string | null
}

/* ---------------------------------------------------------------------------------------------
 * Holidays and leave
 * ------------------------------------------------------------------------------------------- */

export const HOLIDAY_KINDS = ['regular', 'special'] as const
export type HolidayKind = (typeof HOLIDAY_KINDS)[number]
export const HOLIDAY_KIND_LABELS: Record<HolidayKind, string> = { regular: 'Regular holiday', special: 'Special non-working day' }
export const HolidayInput = z.object({ date: dateSchema, name: textField('holiday name', 120), kind: z.enum(HOLIDAY_KINDS) })
export type HolidayInput = z.input<typeof HolidayInput>
export type Holiday = { id: string; date: string; name: string; kind: HolidayKind }

export type LeaveType = { id: string; code: string; name: string; paid: boolean; daysPerYear: number | null; active: boolean }
export const LeaveTypeUpdate = z.object({
  name: textField('leave name', 80),
  paid: z.boolean(),
  /** Null: no yearly limit. */
  daysPerYear: z.number().min(0).max(366).nullable(),
  active: z.boolean(),
})
export type LeaveBalance = { leaveType: LeaveType; entitled: number | null; used: number; pending: number; left: number | null }

export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const
export type LeaveStatus = (typeof LEAVE_STATUSES)[number]
export const LEAVE_STATUS_LABELS: Record<LeaveStatus, string> = { pending: 'Waiting', approved: 'Approved', rejected: 'Not approved', cancelled: 'Cancelled' }

export const LeaveRequestInput = z
  .object({
    leaveTypeId: z.uuid('Choose the kind of leave.'),
    startDate: dateSchema,
    endDate: dateSchema,
    halfDay: z.boolean().default(false),
    reason: optionalText(500),
  })
  .refine((l) => l.endDate >= l.startDate, { message: 'The last day can’t be before the first.', path: ['endDate'] })
  .refine((l) => !l.halfDay || l.startDate === l.endDate, { message: 'A half day is one day.', path: ['halfDay'] })
export type LeaveRequestInput = z.input<typeof LeaveRequestInput>
/** HR filing leave for someone. */
export const LeaveForInput = LeaveRequestInput.and(z.object({ employeeId: z.uuid('Choose the employee.') }))

export const LeaveDecisionInput = z.object({ note: optionalText(300) })

export type LeaveRequest = {
  id: string
  employee: { id: string; name: string }
  leaveType: { id: string; name: string; paid: boolean }
  startDate: string
  endDate: string
  halfDay: boolean
  /** Workdays it covers. */
  days: number
  reason: string | null
  status: LeaveStatus
  decidedBy: { id: string; name: string } | null
  decidedAt: string | null
  decisionNote: string | null
  createdAt: string
}

/* ---------------------------------------------------------------------------------------------
 * Government rates (data, effective-dated)
 * ------------------------------------------------------------------------------------------- */

export type TaxBracket = { over: number; base: number; rateBp: number }

export type PayrollRates = {
  sss: { minMsc: number; maxMsc: number; step: number; eeBp: number; erBp: number; ecThreshold: number; ecLow: number; ecHigh: number }
  philhealth: { rateBp: number; floor: number; ceiling: number }
  pagibig: { lowThreshold: number; eeLowBp: number; eeBp: number; erBp: number; maxBase: number }
  wtax: { semi_monthly: TaxBracket[]; monthly: TaxBracket[]; annual: TaxBracket[] }
  /** Percent of the hourly rate for hours on each kind of day; overtime on top (see payroll engine). */
  premiums: { regularOvertime: number; dayOvertime: number; nightBp: number; days: Record<Exclude<DayType, 'regular'>, number> }
  /** 13th month pay and other benefits tax-exempt up to this much a year. */
  thirteenthExempt: number
}

export const GOV_RATE_KINDS = ['sss', 'philhealth', 'pagibig', 'wtax', 'premiums', 'thirteenth', 'minimum_wage'] as const
export type GovRateKind = (typeof GOV_RATE_KINDS)[number]
export const GOV_RATE_LABELS: Record<GovRateKind, string> = {
  sss: 'SSS contributions',
  philhealth: 'PhilHealth premiums',
  pagibig: 'Pag-IBIG contributions',
  wtax: 'Withholding tax on compensation (TRAIN)',
  premiums: 'Premium pay (Labor Code)',
  thirteenth: '13th month pay',
  minimum_wage: 'Minimum wage',
}
export type GovRate = { id: string; kind: GovRateKind; effectiveFrom: string; source: string; data: unknown }
export type MinimumWages = Record<string, { region: string; daily: number }>

/* ---------------------------------------------------------------------------------------------
 * The payroll engine
 * ------------------------------------------------------------------------------------------- */

/** Kinds of day: ordinary, rest day, special non-working day, regular holiday, and combinations. */
export const DAY_TYPES = ['regular', 'rest', 'special', 'special_rest', 'holiday', 'holiday_rest'] as const
export type DayType = (typeof DAY_TYPES)[number]
export const DAY_TYPE_LABELS: Record<DayType, string> = {
  regular: 'Ordinary day',
  rest: 'Rest day',
  special: 'Special day',
  special_rest: 'Special day on a rest day',
  holiday: 'Regular holiday',
  holiday_rest: 'Regular holiday on a rest day',
}

export const ADJUSTMENT_KINDS = ['earning', 'nontaxable', 'deduction'] as const
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number]
export const ADJUSTMENT_KIND_LABELS: Record<AdjustmentKind, string> = { earning: 'Taxable pay', nontaxable: 'Non-taxable (de minimis)', deduction: 'Deduction' }

const byDay = z.object(Object.fromEntries(DAY_TYPES.map((d) => [d, hours(DAY_TYPE_LABELS[d]).default(0)])) as Record<DayType, z.ZodDefault<ReturnType<typeof hours>>>)

/**
 * What a period's pay is worked out from. Filled in from clock-ins (for those who clock in), and
 * editable before the run is posted.
 */
export const PayInputs = z.object({
  /** Daily-paid: ordinary workdays worked. */
  daysWorked: z.coerce.number().min(0).max(31).default(0),
  /** Daily-paid: paid leave days and regular holidays not worked (both paid at the daily rate). */
  paidDays: z.coerce.number().min(0).max(31).default(0),
  /** Monthly-paid: unpaid absences. */
  absentDays: z.coerce.number().min(0).max(31).default(0),
  /** Late arrival and undertime. */
  lateMinutes: z.coerce.number().min(0).max(44_640).default(0),
  /** Hours worked (up to 8 a day) on days that aren't ordinary workdays. `regular` is unused. */
  dayHours: byDay.default(Object.fromEntries(DAY_TYPES.map((d) => [d, 0])) as never),
  /** Hours past 8 in a day, by the kind of day. */
  overtime: byDay.default(Object.fromEntries(DAY_TYPES.map((d) => [d, 0])) as never),
  /** Hours worked between 10 pm and 6 am. */
  nightHours: hours('Night hours').default(0),
  adjustments: z
    .array(z.object({ label: textField('description', 80), amount: centavos('amount').min(1, 'Enter the amount.'), kind: z.enum(ADJUSTMENT_KINDS) }))
    .max(30)
    .default([]),
})
export type PayInputs = z.output<typeof PayInputs>
export type PayInputsInput = z.input<typeof PayInputs>
export const emptyInputs = (): PayInputs => PayInputs.parse({})

export type PayLine = { code: string; label: string; amount: number; detail?: string }

/** One employee's pay for one run: what the payslip shows and the ledger and reports add up. */
export type PayResult = {
  earnings: PayLine[]
  deductions: PayLine[]
  employer: PayLine[]
  basic: number
  gross: number
  /** Gross less non-taxable pay. */
  grossTaxable: number
  nonTaxable: number
  /** What tax is worked out on: gross taxable less the employee's contributions. */
  taxable: number
  sss: { msc: number; ee: number; er: number; ec: number }
  philhealth: { base: number; ee: number; er: number }
  pagibig: { base: number; ee: number; er: number }
  tax: number
  otherDeductions: number
  net: number
  /** Things to look at before posting, like pay going below zero. */
  warnings: string[]
}

/** Tax from a bracket table: the base of the highest bracket reached, plus its rate on the excess. */
export function taxFromTable(table: TaxBracket[], taxable: number) {
  if (taxable <= 0) return 0
  const bracket = [...table].sort((a, b) => b.over - a.over).find((b) => taxable > b.over)
  return bracket ? bracket.base + applyRate(taxable - bracket.over, bracket.rateBp) : 0
}

/** SSS monthly salary credit: brackets ₱500 wide, centred on each credit (₱5,250–₱5,749.99 → ₱5,500). */
export function sssMsc(r: PayrollRates['sss'], monthlyComp: number) {
  const msc = r.step * Math.floor((monthlyComp + r.step / 2) / r.step)
  return Math.min(r.maxMsc, Math.max(r.minMsc, msc))
}

export function sssContribution(r: PayrollRates['sss'], monthlyComp: number) {
  const msc = sssMsc(r, monthlyComp)
  return { msc, ee: applyRate(msc, r.eeBp), er: applyRate(msc, r.erBp), ec: msc < r.ecThreshold ? r.ecLow : r.ecHigh }
}

/** 5% of monthly basic salary, kept between the floor and ceiling, shared equally. */
export function philhealthContribution(r: PayrollRates['philhealth'], monthlyBasic: number) {
  const base = Math.min(r.ceiling, Math.max(r.floor, monthlyBasic))
  const total = applyRate(base, r.rateBp)
  const ee = Math.floor(total / 2)
  return { base, ee, er: total - ee }
}

export function pagibigContribution(r: PayrollRates['pagibig'], monthlyComp: number) {
  const base = Math.min(r.maxBase, monthlyComp)
  return { base, ee: applyRate(base, monthlyComp <= r.lowThreshold ? r.eeLowBp : r.eeBp), er: applyRate(base, r.erBp) }
}

const peso = (n: number) => `₱${(n / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const num = (n: number) => String(Math.round(n * 100) / 100)

/**
 * One period's pay. Rules:
 * - Hourly rate = daily rate ÷ 8. A monthly salary becomes a daily rate × 12 ÷ days paid a year.
 * - Monthly-paid: half the salary each cutoff (all of it monthly), less absences and lateness.
 *   Their salary already pays holidays, so work on a holiday or special day earns only the premium
 *   above 100%; work on a rest day earns the full rest-day rate.
 * - Daily-paid: days worked plus paid days (leave, unworked regular holidays) at the daily rate.
 * - Overtime: +25% on an ordinary day; +30% on top of the day's rate on any other day.
 * - Night differential: +10% of the hourly rate for hours from 10 pm to 6 am.
 * - Contributions are taken once a month, in the run that ends the month, on the whole month's pay
 *   (`monthToDate` is what earlier runs that month already paid). Tax uses the run's table, on pay
 *   less contributions; minimum wage earners pay none.
 */
export function computePay(input: {
  employee: { payBasis: PayBasis; rate: number; workDaysPerYear: number; minimumWageEarner: boolean }
  frequency: PayFrequency
  inputs: PayInputs
  rates: PayrollRates
  /** Whether this run takes the month's contributions (it ends the month, or is the month's only run). */
  takesContributions: boolean
  monthToDate: { grossTaxable: number }
}): PayResult {
  const { employee: e, inputs: x, rates } = input
  const daily = dailyRateOf(e)
  const hourly = daily / 8
  const earnings: PayLine[] = []
  const deductions: PayLine[] = []
  const employer: PayLine[] = []
  const warnings: string[] = []

  // basic pay
  let basic: number
  if (e.payBasis === 'monthly') {
    const salary = input.frequency === 'semi_monthly' ? Math.round(e.rate / 2) : e.rate
    earnings.push({ code: 'basic', label: 'Basic pay', amount: salary, detail: input.frequency === 'semi_monthly' ? `half of ${peso(e.rate)}` : undefined })
    const absent = Math.round(x.absentDays * daily)
    if (absent) earnings.push({ code: 'absences', label: 'Absences', amount: -absent, detail: `${num(x.absentDays)} day(s) × ${peso(daily)}` })
    basic = salary - absent
  } else {
    const days = x.daysWorked + x.paidDays
    basic = Math.round(days * daily)
    earnings.push({ code: 'basic', label: 'Basic pay', amount: basic, detail: `${num(x.daysWorked)} worked + ${num(x.paidDays)} paid day(s) × ${peso(daily)}` })
  }
  const late = Math.round((x.lateMinutes / 60) * hourly)
  if (late) {
    earnings.push({ code: 'late', label: 'Late and undertime', amount: -late, detail: `${num(x.lateMinutes)} min` })
    basic -= late
  }

  // work on rest days, special days and holidays
  const p = rates.premiums
  for (const d of DAY_TYPES) {
    if (d === 'regular' || !x.dayHours[d]) continue
    const pct = p.days[d] - (e.payBasis === 'monthly' && d !== 'rest' ? 100 : 0)
    const amount = Math.round((x.dayHours[d] * hourly * pct) / 100)
    if (amount) earnings.push({ code: `day_${d}`, label: `Work on ${DAY_TYPE_LABELS[d].toLowerCase()}`, amount, detail: `${num(x.dayHours[d])} h × ${pct}%` })
  }
  for (const d of DAY_TYPES) {
    if (!x.overtime[d]) continue
    const pct = d === 'regular' ? p.regularOvertime : Math.round((p.days[d] * p.dayOvertime) / 100)
    earnings.push({ code: `ot_${d}`, label: d === 'regular' ? 'Overtime' : `Overtime, ${DAY_TYPE_LABELS[d].toLowerCase()}`, amount: Math.round((x.overtime[d] * hourly * pct) / 100), detail: `${num(x.overtime[d])} h × ${pct}%` })
  }
  if (x.nightHours) earnings.push({ code: 'night', label: 'Night differential', amount: Math.round(x.nightHours * hourly * (p.nightBp / 10_000)), detail: `${num(x.nightHours)} h × ${p.nightBp / 100}%` })

  let nonTaxable = 0
  let otherDeductions = 0
  for (const a of x.adjustments) {
    if (a.kind === 'deduction') {
      deductions.push({ code: 'other', label: a.label, amount: a.amount })
      otherDeductions += a.amount
    } else {
      earnings.push({ code: a.kind, label: a.label, amount: a.amount, detail: a.kind === 'nontaxable' ? 'non-taxable' : undefined })
      if (a.kind === 'nontaxable') nonTaxable += a.amount
    }
  }
  const gross = earnings.reduce((s, l) => s + l.amount, 0)
  const grossTaxable = gross - nonTaxable

  // the month's contributions
  let sss = { msc: 0, ee: 0, er: 0, ec: 0 }
  let philhealth = { base: 0, ee: 0, er: 0 }
  let pagibig = { base: 0, ee: 0, er: 0 }
  if (input.takesContributions) {
    const monthComp = input.monthToDate.grossTaxable + grossTaxable
    const monthlyBasic = monthlyRateOf(e)
    sss = sssContribution(rates.sss, monthComp)
    philhealth = philhealthContribution(rates.philhealth, monthlyBasic)
    pagibig = pagibigContribution(rates.pagibig, monthlyBasic)
    deductions.unshift(
      { code: 'sss', label: 'SSS', amount: sss.ee, detail: `5% of ${peso(sss.msc)} salary credit` },
      { code: 'philhealth', label: 'PhilHealth', amount: philhealth.ee },
      { code: 'pagibig', label: 'Pag-IBIG', amount: pagibig.ee },
    )
    employer.push(
      { code: 'sss', label: 'SSS', amount: sss.er },
      { code: 'sss_ec', label: 'SSS employees’ compensation', amount: sss.ec },
      { code: 'philhealth', label: 'PhilHealth', amount: philhealth.er },
      { code: 'pagibig', label: 'Pag-IBIG', amount: pagibig.er },
    )
  }
  const contributions = sss.ee + philhealth.ee + pagibig.ee
  const taxable = Math.max(0, grossTaxable - contributions)
  const tax = e.minimumWageEarner ? 0 : taxFromTable(rates.wtax[input.frequency], taxable)
  if (tax) deductions.push({ code: 'tax', label: 'Withholding tax', amount: tax })
  const net = gross - contributions - tax - otherDeductions
  if (net < 0) warnings.push('Deductions are more than the pay. Reduce a deduction or move it to the next payroll.')
  return { earnings, deductions, employer, basic, gross, grossTaxable, nonTaxable, taxable, sss, philhealth, pagibig, tax, otherDeductions, net, warnings }
}

/**
 * 13th month pay (PD 851): a twelfth of the basic pay earned in the year, less any already paid.
 * Tax-exempt up to the yearly cap; tax on the excess is the annual tax with it less without it.
 */
export function computeThirteenth(input: { basicThisYear: number; alreadyPaid: number; taxableThisYear: number; minimumWageEarner: boolean; rates: PayrollRates }): PayResult {
  const amount = Math.max(0, Math.round(input.basicThisYear / 12) - input.alreadyPaid)
  const exemptLeft = Math.max(0, input.rates.thirteenthExempt - input.alreadyPaid)
  const excess = Math.max(0, amount - exemptLeft)
  const annual = input.rates.wtax.annual
  const tax = input.minimumWageEarner || !excess ? 0 : taxFromTable(annual, input.taxableThisYear + excess) - taxFromTable(annual, input.taxableThisYear)
  return {
    earnings: [{ code: 'thirteenth', label: '13th month pay', amount, detail: `${peso(input.basicThisYear)} basic pay this year ÷ 12${input.alreadyPaid ? `, less ${peso(input.alreadyPaid)} paid` : ''}` }],
    deductions: tax ? [{ code: 'tax', label: 'Withholding tax', amount: tax, detail: `on ${peso(excess)} over the ${peso(input.rates.thirteenthExempt)} exemption` }] : [],
    employer: [],
    basic: 0,
    gross: amount,
    grossTaxable: excess,
    nonTaxable: amount - excess,
    taxable: excess,
    sss: { msc: 0, ee: 0, er: 0, ec: 0 },
    philhealth: { base: 0, ee: 0, er: 0 },
    pagibig: { base: 0, ee: 0, er: 0 },
    tax,
    otherDeductions: 0,
    net: amount - tax,
    warnings: [],
  }
}

/* ---------------------------------------------------------------------------------------------
 * Payroll runs
 * ------------------------------------------------------------------------------------------- */

export const RUN_KINDS = ['regular', 'thirteenth'] as const
export type RunKind = (typeof RUN_KINDS)[number]
export const RUN_STATUSES = ['draft', 'posted', 'paid'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]
export const RUN_STATUS_LABELS: Record<RunStatus, string> = { draft: 'Draft', posted: 'Posted', paid: 'Paid' }

export const PayrollRunInput = z
  .object({
    kind: z.enum(RUN_KINDS).default('regular'),
    frequency: z.enum(PAY_FREQUENCIES).default('semi_monthly'),
    periodStart: dateSchema,
    periodEnd: dateSchema,
    payDate: dateSchema,
  })
  .refine((r) => r.periodEnd >= r.periodStart, { message: 'The period can’t end before it starts.', path: ['periodEnd'] })
  .refine((r) => r.payDate >= r.periodStart, { message: 'Pay day can’t be before the period starts.', path: ['payDate'] })
export type PayrollRunInput = z.input<typeof PayrollRunInput>

export const PayRunPaymentInput = z.object({ date: dateSchema, accountId: z.uuid('Choose the cash or bank account.') })

export type PayrollRunSummary = {
  id: string
  number: string | null
  kind: RunKind
  frequency: PayFrequency
  periodStart: string
  periodEnd: string
  payDate: string
  status: RunStatus
  takesContributions: boolean
  headcount: number
  gross: number
  net: number
  employerCost: number
  journalEntryId: string | null
  paymentEntryId: string | null
}

export type PayrollLine = {
  id: string
  employee: { id: string; employeeNo: string; name: string; position: string }
  payBasis: PayBasis
  dailyRate: number
  inputs: PayInputs
  /** Whether the inputs were filled from clock-ins, or edited by hand. */
  edited: boolean
  result: PayResult
}

export type PayrollRun = PayrollRunSummary & { lines: PayrollLine[] }

/** A payslip: one line of a posted run, with who it's for and who paid it. */
export type Payslip = {
  id: string
  run: { id: string; number: string | null; kind: RunKind; periodStart: string; periodEnd: string; payDate: string; status: RunStatus }
  employer: { name: string; tin: string; address: string }
  employee: { id: string; employeeNo: string; name: string; position: string; tin: string | null; sssNo: string | null; philhealthNo: string | null; pagibigNo: string | null }
  result: PayResult
}

/* ---------------------------------------------------------------------------------------------
 * Self-service and reports
 * ------------------------------------------------------------------------------------------- */

export type MyHr = {
  employee: { id: string; employeeNo: string; name: string; position: string; shiftStart: string } | null
  openEntry: TimeEntry | null
  today: TimeEntry[]
  leave: LeaveBalance[]
  requests: LeaveRequest[]
  payslips: { id: string; runNumber: string | null; kind: RunKind; periodStart: string; periodEnd: string; payDate: string; net: number }[]
}

export type HrOverview = {
  headcount: number
  clockedIn: { id: string; name: string; since: string }[]
  onLeaveToday: { id: string; name: string; leaveType: string }[]
  pendingLeave: number
  lastRun: PayrollRunSummary | null
  upcomingHolidays: Holiday[]
}

export type RemittanceRow = { employeeId: string; employeeNo: string; name: string; idNumber: string | null; base: number; ee: number; er: number; ec?: number }
/** SSS R-3, PhilHealth RF-1 and the Pag-IBIG remittance list, and the 1601-C figures, for one month. */
export type MonthlyRemittance = {
  month: string
  sss: RemittanceRow[]
  philhealth: RemittanceRow[]
  pagibig: RemittanceRow[]
  /** BIR 1601-C. */
  wtax: { totalCompensation: number; nonTaxableMwe: number; nonTaxableThirteenth: number; nonTaxableDeMinimis: number; nonTaxableContributions: number; taxable: number; withheld: number; employees: number }
}

/** BIR 2316: an employee's pay and tax for the year. */
export type Form2316 = {
  year: number
  employee: { name: string; tin: string | null; address: string | null; minimumWageEarner: boolean }
  employer: { name: string; tin: string; address: string }
  gross: number
  nonTaxable: { mwe: number; thirteenth: number; deMinimis: number; contributions: number; total: number }
  taxable: number
  taxDue: number
  withheld: number
  /** Positive: still owed by the employee; negative: to refund. */
  difference: number
}
