import type { Employee, EmployeeSummary, Form2316, GovRate, Holiday, HrOverview, LeaveRequest, LeaveStatus, LeaveType, MonthlyRemittance, MyHr, PayrollRun, PayrollRunSummary, Payslip, TimeEntry } from '@erp/shared'
import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'

// Same rule as the other modules: every key starts with ['w', workspaceId], so one change refreshes
// the whole workspace (posting payroll moves the ledger and the payslips at once).

const qs = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string | number] => e[1] !== undefined && e[1] !== '').map(([k, v]) => [k, String(v)])).toString()
  return s ? `?${s}` : ''
}

export const hrQueries = {
  overview: (w: string) => queryOptions({ queryKey: ['w', w, 'hr-overview'], queryFn: async () => (await api<{ overview: HrOverview }>(`/w/${w}/hr/overview`)).overview }),
  employees: (w: string) => queryOptions({ queryKey: ['w', w, 'employees'], queryFn: async () => (await api<{ employees: EmployeeSummary[] }>(`/w/${w}/employees`)).employees }),
  employee: (w: string, id: string) => queryOptions({ queryKey: ['w', w, 'employee', id], queryFn: async () => (await api<{ employee: Employee }>(`/w/${w}/employees/${id}`)).employee }),
  attendance: (w: string, from: string, to: string, employeeId?: string) =>
    queryOptions({ queryKey: ['w', w, 'attendance', from, to, employeeId ?? ''], queryFn: async () => (await api<{ entries: TimeEntry[] }>(`/w/${w}/attendance${qs({ from, to, employeeId })}`)).entries }),
  leaveTypes: (w: string) => queryOptions({ queryKey: ['w', w, 'leave-types'], queryFn: async () => (await api<{ leaveTypes: LeaveType[] }>(`/w/${w}/leave/types`)).leaveTypes }),
  leave: (w: string, status?: LeaveStatus) => queryOptions({ queryKey: ['w', w, 'leave', status ?? 'all'], queryFn: async () => (await api<{ requests: LeaveRequest[] }>(`/w/${w}/leave/requests${qs({ status })}`)).requests }),
  holidays: (w: string, year: number) => queryOptions({ queryKey: ['w', w, 'holidays', year], queryFn: async () => (await api<{ holidays: Holiday[] }>(`/w/${w}/holidays${qs({ year })}`)).holidays }),
  govRates: (w: string) => queryOptions({ queryKey: ['w', w, 'gov-rates'], queryFn: async () => (await api<{ rates: GovRate[] }>(`/w/${w}/gov-rates`)).rates, staleTime: 10 * 60_000 }),
  runs: (w: string) => queryOptions({ queryKey: ['w', w, 'payroll-runs'], queryFn: async () => (await api<{ runs: PayrollRunSummary[] }>(`/w/${w}/payroll/runs`)).runs }),
  run: (w: string, id: string) => queryOptions({ queryKey: ['w', w, 'payroll-run', id], queryFn: async () => (await api<{ run: PayrollRun }>(`/w/${w}/payroll/runs/${id}`)).run }),
  payslip: (w: string, id: string, mine: boolean) =>
    queryOptions({ queryKey: ['w', w, 'payslip', id, mine], queryFn: async () => (await api<{ payslip: Payslip }>(`/w/${w}/${mine ? 'me/payslips' : 'payroll/lines'}/${id}`)).payslip }),
  monthly: (w: string, month: string) => queryOptions({ queryKey: ['w', w, 'payroll-monthly', month], queryFn: async () => (await api<{ report: MonthlyRemittance }>(`/w/${w}/payroll/reports/monthly${qs({ month })}`)).report }),
  form2316: (w: string, year: number, employeeId: string) =>
    queryOptions({ queryKey: ['w', w, 'form-2316', year, employeeId], queryFn: async () => (await api<{ report: Form2316 }>(`/w/${w}/payroll/reports/2316${qs({ year, employeeId })}`)).report, enabled: !!employeeId }),
  me: (w: string) => queryOptions({ queryKey: ['w', w, 'me-hr'], queryFn: async () => (await api<{ me: MyHr }>(`/w/${w}/me/hr`)).me }),
  myLeaveTypes: (w: string) => queryOptions({ queryKey: ['w', w, 'my-leave-types'], queryFn: async () => (await api<{ leaveTypes: LeaveType[] }>(`/w/${w}/me/leave-types`)).leaveTypes }),
}

/** "08:02" in Manila for an ISO timestamp. */
export const clockTime = (iso: string) => new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
/** "2026-11-16" in Manila for an ISO timestamp. */
export const manilaDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(iso))
/** "2026-11-16T08:02" in Manila, for a datetime-local input. */
export const manilaLocal = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 8 * 3_600_000)
  return d.toISOString().slice(0, 16)
}
/** Hours between two timestamps, to one decimal. */
export const hoursBetween = (a: string, b: string) => Math.round(((new Date(b).getTime() - new Date(a).getTime()) / 3_600_000) * 10) / 10
