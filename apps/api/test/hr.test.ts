import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Account, Employee, EmployeeSummary, Form2316, LeaveRequest, MonthlyRemittance, MyHr, PayrollRun, Payslip, Role } from '@erp/shared'
import { eq, sql } from 'drizzle-orm'
import { buildApp } from '../src/app.ts'
import { db, pool, runMigrations } from '../src/db/client.ts'
import { employees, sessions, users } from '../src/db/schema.ts'
import { hashToken, newToken } from '../src/lib/crypto.ts'
import { testPushOutbox } from '../src/lib/push.ts'

// Phase 5: employees, clock-ins, leave, payroll runs posted to the books, payslips and the
// government reports. The second half of November 2026 is worked through for two people:
// Ana (₱30,000 a month, doesn't clock in) and Ben (₱755 a day, NCR minimum wage, clocks in).

const app = await buildApp()
const run = Date.now()

async function makeUser(name: string) {
  const [user] = await db
    .insert(users)
    .values({ email: `hr+${name.toLowerCase()}+${run}@example.com`, name, passwordHash: 'x', emailVerifiedAt: new Date(), termsAcceptedAt: new Date() })
    .returning()
  const token = newToken()
  await db.insert(sessions).values({ id: hashToken(token), userId: user!.id, remember: false, expiresAt: new Date(Date.now() + 3_600_000) })
  return {
    id: user!.id,
    call: async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) => {
      const r = await app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } })
      return { status: r.statusCode, body: r.body ? r.json() : undefined }
    },
  }
}

let owner: Awaited<ReturnType<typeof makeUser>>
let benUser: Awaited<ReturnType<typeof makeUser>>
let accountant: Awaited<ReturnType<typeof makeUser>>
let ws = ''
const w = (p: string) => `/api/w/${ws}${p}`
const call = (...a: Parameters<typeof owner.call>) => owner.call(...a)
const acct: Record<string, string> = {}
let ana: Employee
let ben: Employee

async function balanceOf(key: string) {
  const tb = (await call('GET', w('/reports/trial-balance?asOf=2026-12-31'))).body.report
  return tb.rows.find((r: { id: string }) => r.id === acct[key])?.balance ?? 0
}

before(async () => {
  await runMigrations()
  owner = await makeUser('Carmen')
  const r = await call('POST', '/api/workspaces', { template: 'wholesale', name: 'Carmen Trading', tin: '555-666-777-00000', vatStatus: 'vat', street: 'Binondo, Manila' })
  ws = r.body.workspace.id
  for (const a of (await call('GET', w('/accounts'))).body.accounts as Account[]) if (a.systemKey) acct[a.systemKey] = a.id
  const roles = (await call('GET', w('/roles'))).body.roles as Role[]
  const join = async (roleName: string, name: string) => {
    const code = (await call('POST', w('/join-codes'), { roleId: roles.find((x) => x.name === roleName)!.id })).body.code.code
    const u = await makeUser(name)
    assert.equal((await u.call('POST', '/api/workspaces/join', { code })).status, 200)
    return u
  }
  benUser = await join('Warehouse staff', 'Ben')
  accountant = await join('Accountant', 'Dolor')
})
after(async () => {
  await app.close()
  await pool.end()
})

test('employees: ID numbers are encrypted, masked for those who only view, and pay is hidden from them', async () => {
  const bad = await call('POST', w('/employees'), { firstName: 'X', lastName: 'Y', position: 'Clerk', hireDate: '2026-01-01', rate: 1, sssNo: '12345' })
  assert.equal(bad.body.error.field, 'sssNo')

  const a = await call('POST', w('/employees'), {
    firstName: 'Ana',
    lastName: 'Reyes',
    position: 'Bookkeeper',
    hireDate: '2026-01-05',
    payBasis: 'monthly',
    rate: 30_000_00,
    tracksAttendance: false,
    tin: '123-456-789-00000',
    sssNo: '34-1234567-8',
    philhealthNo: '12-345678901-2',
    pagibigNo: '1234-5678-9012',
  })
  assert.equal(a.status, 201, JSON.stringify(a.body))
  ana = a.body.employee
  assert.equal(ana.employeeNo, 'EMP-000001')
  assert.equal(ana.sssNo, '34-1234567-8')
  const [stored] = await db.select().from(employees).where(eq(employees.id, ana.id))
  assert.ok(stored!.sssNoEnc && !stored!.sssNoEnc.includes('1234567'))

  const b = await call('POST', w('/employees'), {
    firstName: 'Ben',
    lastName: 'Cruz',
    position: 'Warehouse helper',
    hireDate: '2026-11-16',
    payBasis: 'daily',
    rate: 755_00,
    workDaysPerYear: 313,
    minimumWageEarner: true,
    restDays: [0],
    workRegionCode: '130000000',
    userId: benUser.id,
    sssNo: '33-7654321-0',
  })
  assert.equal(b.status, 201, JSON.stringify(b.body))
  ben = b.body.employee
  assert.equal(ben.minimumWageWarning, null)
  assert.equal(ben.user?.id, benUser.id)

  // under the NCR minimum wage gets a warning (not a refusal: the employer may know better)
  const low = await call('POST', w('/employees'), { firstName: 'Lito', lastName: 'Santos', position: 'Helper', hireDate: '2026-11-01', separationDate: '2026-11-10', payBasis: 'daily', rate: 600_00, workRegionCode: '130000000', tracksAttendance: false })
  assert.match(low.body.employee.minimumWageWarning, /under the NCR minimum wage of ₱755\.00/)

  const seen = (await accountant.call('GET', w(`/employees/${ana.id}`))).body.employee as Employee
  assert.equal(seen.sssNo, '••-•••••67-8')
  assert.equal(seen.pay, null)
  assert.equal((await accountant.call('PUT', w(`/employees/${ana.id}`), { ...ana })).status, 403)
  assert.equal((await benUser.call('GET', w('/employees'))).status, 403)

  // editing with the ID boxes left blank keeps them
  const edited = await call('PUT', w(`/employees/${ana.id}`), { firstName: 'Ana', lastName: 'Reyes', position: 'Senior bookkeeper', hireDate: '2026-01-05', payBasis: 'monthly', rate: 30_000_00, tracksAttendance: false })
  assert.equal(edited.body.employee.sssNo, '34-1234567-8')
  assert.equal(edited.body.employee.position, 'Senior bookkeeper')
})

test('clocking in from the phone: with where they were, once at a time', async () => {
  const me0 = (await benUser.call('GET', w('/me/hr'))).body.me as MyHr
  assert.equal(me0.employee?.name, 'Ben Cruz')
  assert.equal(me0.openEntry, null)
  const inn = await benUser.call('POST', w('/me/clock'), { action: 'in', latitude: 14.5995, longitude: 120.9842, accuracy: 12, source: 'phone' })
  assert.equal(inn.status, 200, JSON.stringify(inn.body))
  assert.equal(inn.body.today[0].inLocation.latitude, 14.5995)
  assert.equal(inn.body.today[0].source, 'phone')
  assert.equal((await benUser.call('POST', w('/me/clock'), { action: 'in' })).body.error.code, 'already-in')
  assert.equal((await call('GET', w('/hr/overview'))).body.overview.clockedIn[0].name, 'Ben Cruz')
  assert.equal((await benUser.call('POST', w('/me/clock'), { action: 'out', source: 'phone' })).status, 200)
  assert.equal((await benUser.call('POST', w('/me/clock'), { action: 'out' })).body.error.code, 'not-in')
  // HR removes the test punch, so it doesn't count in this month's payroll
  const today = (await benUser.call('GET', w('/me/hr'))).body.me.today as { id: string }[]
  assert.equal((await call('DELETE', w(`/attendance/${today[0]!.id}`))).status, 204)
  // the owner isn't an employee here
  assert.equal((await call('POST', w('/me/clock'), { action: 'in' })).body.error.code, 'not-an-employee')
})

let leave: LeaveRequest

test('leave: asked for on the phone, counted in workdays, approved by HR, and checked against the balance', async () => {
  const types = (await benUser.call('GET', w('/me/leave-types'))).body.leaveTypes as { id: string; code: string }[]
  const vl = types.find((t) => t.code === 'VL')!.id
  const pushes = testPushOutbox.length
  // Friday 20 to Sunday 22 November: Sunday is his rest day, so 2 days
  const r = await benUser.call('POST', w('/me/leave'), { leaveTypeId: vl, startDate: '2026-11-20', endDate: '2026-11-22', reason: 'Family matter' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  leave = r.body.request
  assert.equal(leave.days, 2)
  assert.equal(testPushOutbox.length, pushes + 1)
  assert.ok(testPushOutbox.at(-1)!.userIds.includes(owner.id))
  assert.equal((await benUser.call('POST', w('/me/leave'), { leaveTypeId: vl, startDate: '2026-11-21', endDate: '2026-11-21' })).body.error.code, 'overlap')
  assert.equal((await benUser.call('POST', w('/me/leave'), { leaveTypeId: vl, startDate: '2026-12-01', endDate: '2026-12-05' })).body.error.code, 'no-balance') // 5 days, 3 left
  assert.equal((await benUser.call('POST', w(`/leave/requests/${leave.id}/approve`))).status, 403)
  // he changes his mind about Saturday: withdraw and ask again for Friday only
  await benUser.call('POST', w(`/me/leave/${leave.id}/cancel`))
  leave = (await benUser.call('POST', w('/me/leave'), { leaveTypeId: vl, startDate: '2026-11-20', endDate: '2026-11-20' })).body.request
  const approved = await call('POST', w(`/leave/requests/${leave.id}/approve`), { note: 'Okay' })
  assert.equal(approved.body.request.status, 'approved')
  assert.deepEqual(testPushOutbox.at(-1)!.userIds, [benUser.id])
  const me = (await benUser.call('GET', w('/me/hr'))).body.me as MyHr
  assert.deepEqual(
    me.leave.filter((b) => b.leaveType.code === 'VL').map((b) => [b.used, b.left]),
    [[1, 4]],
  )
})

let first: PayrollRun
let second: PayrollRun

test('first half of November: Ana only (Ben starts on the 16th); tax but no contributions', async () => {
  const r = await call('POST', w('/payroll/runs'), { frequency: 'semi_monthly', periodStart: '2026-11-01', periodEnd: '2026-11-15', payDate: '2026-11-15' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  first = r.body.run
  assert.deepEqual(first.lines.map((l) => l.employee.name), ['Ana Reyes', 'Lito Santos'])
  const a = first.lines.find((l) => l.employee.id === ana.id)!
  assert.equal(a.result.gross, 15_000_00)
  assert.equal(a.result.sss.ee, 0)
  assert.equal(a.result.tax, 687_45)
  // Lito left on the 10th: paid the workdays he was here (Mon 2nd is a special day, not paid; 3–7 and 9–10)
  const lito = first.lines.find((l) => l.employee.name === 'Lito Santos')!
  assert.equal(lito.inputs.daysWorked, 7)
  first = (await call('POST', w(`/payroll/runs/${first.id}/post`))).body.run
  assert.equal(first.number, 'PR-000001')
  assert.equal(first.status, 'posted')
  assert.equal((await call('POST', w('/payroll/runs'), { frequency: 'semi_monthly', periodStart: '2026-11-10', periodEnd: '2026-11-20', payDate: '2026-11-20' })).body.error.code, 'overlap')
})

test('second half: Ben’s clock-ins become days, lateness, overtime, rest-day work and holiday pay', async () => {
  const time = (day: number, from: string, to: string) => call('POST', w('/attendance'), { employeeId: ben.id, clockIn: `2026-11-${day}T${from}`, clockOut: `2026-11-${day}T${to}` })
  assert.equal((await time(16, '08:00', '17:00')).status, 201) // Mon: 8 h after the hour's break
  await time(17, '08:30', '17:00') // Tue: 30 min short
  // Wed 18: no clock-in → absent
  await time(19, '08:00', '20:00') // Thu: 3 h overtime
  // Fri 20: approved leave
  await time(22, '08:00', '12:00') // Sun (rest day): 4 h
  await time(23, '18:00', '23:00') // Mon: 5 h, 1 of them after 10 pm
  // Mon 30: Bonifacio Day, a regular holiday, not worked → still paid

  const r = await call('POST', w('/payroll/runs'), { frequency: 'semi_monthly', periodStart: '2026-11-16', periodEnd: '2026-11-30', payDate: '2026-11-30' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  second = r.body.run
  assert.equal(second.takesContributions, true)
  const b = second.lines.find((l) => l.employee.id === ben.id)!
  assert.equal(b.inputs.daysWorked, 4) // 16, 17, 19, 23
  assert.equal(b.inputs.paidDays, 2) // leave on the 20th, Bonifacio Day
  assert.equal(b.inputs.lateMinutes, 30 + 180) // Tue's half hour, Mon 23rd's 3 hours short
  assert.equal(b.inputs.overtime.regular, 3)
  assert.equal(b.inputs.dayHours.rest, 4)
  assert.equal(b.inputs.nightHours, 1)
  assert.equal(b.result.tax, 0) // minimum wage earner
  assert.deepEqual([b.result.sss.msc, b.result.sss.ee, b.result.pagibig.ee], [5_000_00, 250_00, 200_00])

  // Ana's second half takes the whole month's contributions on ₱30,000
  const a = second.lines.find((l) => l.employee.id === ana.id)!
  assert.deepEqual([a.result.sss.ee, a.result.sss.er, a.result.sss.ec, a.result.philhealth.ee, a.result.pagibig.ee], [1_500_00, 3_000_00, 30_00, 750_00, 200_00])
  assert.equal(a.result.tax, 319_95)
  assert.equal(a.result.net, 12_230_05)

  // a rice allowance (de minimis) and a cash advance, added by hand
  const net = b.result.net
  const edited = await call('PUT', w(`/payroll/runs/${second.id}/lines/${b.id}`), {
    inputs: {
      ...b.inputs,
      adjustments: [
        { label: 'Rice allowance', amount: 1_000_00, kind: 'nontaxable' },
        { label: 'Cash advance', amount: 500_00, kind: 'deduction' },
      ],
    },
  })
  assert.equal(edited.status, 200, JSON.stringify(edited.body))
  const b2 = (edited.body.run as PayrollRun).lines.find((l) => l.employee.id === ben.id)!
  assert.equal(b2.edited, true)
  assert.equal(b2.result.net, net + 1_000_00 - 500_00)
  // reading clock-ins again leaves an edited line alone
  const refreshed = (await call('POST', w(`/payroll/runs/${second.id}/refresh`))).body.run as PayrollRun
  assert.equal(refreshed.lines.find((l) => l.employee.id === ben.id)!.result.net, b2.result.net)
  second = refreshed
})

test('posting books the payroll; paying clears it; the payslips reach the phone', async () => {
  const pushes = testPushOutbox.length
  const posted = await call('POST', w(`/payroll/runs/${second.id}/post`))
  assert.equal(posted.status, 200, JSON.stringify(posted.body))
  second = posted.body.run
  assert.equal(second.number, 'PR-000002')
  assert.deepEqual(testPushOutbox.at(-1)!.userIds, [benUser.id])
  assert.equal(testPushOutbox.length, pushes + 1)

  const sum = (f: (l: PayrollRun['lines'][number]) => number) => second.lines.reduce((s, l) => s + f(l), 0)
  const allGross = first.gross + second.gross
  assert.equal(await balanceOf('salaries'), allGross)
  assert.equal(await balanceOf('sss_payable'), -sum((l) => l.result.sss.ee + l.result.sss.er + l.result.sss.ec))
  assert.equal(await balanceOf('wtax_comp_payable'), -(687_45 + 319_95))
  assert.equal(await balanceOf('payroll_deductions'), -500_00)
  assert.equal(await balanceOf('salaries_payable'), -(first.net + second.net))
  assert.equal(second.employerCost, second.gross + sum((l) => l.result.sss.er + l.result.sss.ec + l.result.philhealth.er + l.result.pagibig.er))

  const bank = acct.bank!
  assert.equal((await call('POST', w(`/payroll/runs/${second.id}/pay`), { date: '2026-11-30', accountId: acct.sales })).body.error.field, 'accountId')
  await call('POST', w(`/payroll/runs/${first.id}/pay`), { date: '2026-11-15', accountId: bank })
  const paid = await call('POST', w(`/payroll/runs/${second.id}/pay`), { date: '2026-11-30', accountId: bank })
  assert.equal(paid.body.run.status, 'paid')
  assert.equal(await balanceOf('salaries_payable'), 0)
  const tb = (await call('GET', w('/reports/trial-balance?asOf=2026-12-31'))).body.report
  assert.equal(tb.totalDebit, tb.totalCredit)

  // Ben sees his own payslip, not Ana's
  const me = (await benUser.call('GET', w('/me/hr'))).body.me as MyHr
  assert.equal(me.payslips.length, 1)
  const slip = (await benUser.call('GET', w(`/me/payslips/${me.payslips[0]!.id}`))).body.payslip as Payslip
  assert.equal(slip.employee.sssNo, '33-7654321-0')
  assert.ok(slip.result.earnings.some((l) => l.label === 'Rice allowance'))
  const anaLine = second.lines.find((l) => l.employee.id === ana.id)!
  assert.equal((await benUser.call('GET', w(`/me/payslips/${anaLine.id}`))).status, 404)
})

test('posted payroll can’t be changed, even in the database', async () => {
  const refused = (e: unknown) => /posted payroll can.t be changed/.test(String((e as { cause?: Error }).cause?.message))
  await assert.rejects(db.execute(sql`update payroll_lines set net = 1 where run_id = ${second.id}`), refused)
  await assert.rejects(db.execute(sql`update payroll_runs set period_end = '2026-12-31' where id = ${second.id}`), refused)
  assert.equal((await call('DELETE', w(`/payroll/runs/${second.id}`))).status, 409)
})

test('the month’s remittances (R-3, RF-1, Pag-IBIG, 1601-C) and Ana’s 2316', async () => {
  const m = (await call('GET', w('/payroll/reports/monthly?month=2026-11'))).body.report as MonthlyRemittance
  const anaSss = m.sss.find((r) => r.employeeId === ana.id)!
  assert.deepEqual([anaSss.idNumber, anaSss.base, anaSss.ee, anaSss.er, anaSss.ec], ['34-1234567-8', 30_000_00, 1_500_00, 3_000_00, 30_00])
  assert.equal(m.philhealth.length, 2)
  assert.equal(m.pagibig.find((r) => r.employeeId === ben.id)!.er, 200_00)
  assert.equal(m.wtax.withheld, 687_45 + 319_95)
  assert.ok(m.wtax.nonTaxableMwe > 0) // Ben's pay
  assert.equal(m.wtax.nonTaxableDeMinimis, 1_000_00)

  const f = (await call('GET', w(`/payroll/reports/2316?year=2026&employeeId=${ana.id}`))).body.report as Form2316
  assert.equal(f.gross, 30_000_00)
  assert.equal(f.taxable, 15_000_00 + 12_550_00)
  assert.equal(f.taxDue, 0) // well under ₱250,000 a year
  assert.equal(f.difference, -(687_45 + 319_95)) // to refund at year end
})

test('13th month pay from the year’s basic pay, tax-free under ₱90,000', async () => {
  const r = await call('POST', w('/payroll/runs'), { kind: 'thirteenth', periodStart: '2026-01-01', periodEnd: '2026-12-31', payDate: '2026-12-15' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const t = r.body.run as PayrollRun
  const a = t.lines.find((l) => l.employee.id === ana.id)!
  assert.equal(a.result.gross, Math.round(30_000_00 / 12))
  assert.equal(a.result.tax, 0)
  const posted = (await call('POST', w(`/payroll/runs/${t.id}/post`))).body.run as PayrollRun
  assert.equal(await balanceOf('thirteenth_month'), posted.gross)
})

test('HR & payroll can’t be reached with the module off', async () => {
  const current = (await call('GET', w(''))).body.workspace
  await call('PATCH', w(''), { ...current, modules: ['finance', 'inventory'] })
  assert.equal((await call('GET', w('/employees'))).body.error.code, 'module-off')
  assert.equal((await benUser.call('POST', w('/me/clock'), { action: 'in' })).body.error.code, 'module-off')
  await call('PATCH', w(''), { ...current, modules: current.modules })
  const list = (await call('GET', w('/employees'))).body.employees as EmployeeSummary[]
  assert.equal(list.length, 3)
})
