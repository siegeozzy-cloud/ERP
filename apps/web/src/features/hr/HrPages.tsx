import {
  centavosToInput,
  EMPLOYMENT_TYPE_LABELS,
  EMPLOYMENT_TYPES,
  formatPeso,
  GOV_RATE_LABELS,
  HOLIDAY_KIND_LABELS,
  LEAVE_STATUS_LABELS,
  PAY_FREQUENCY_LABELS,
  parsePeso,
  WEEKDAYS,
  type Employee,
  type EmploymentType,
  type GovRate,
  type HolidayKind,
  type LeaveStatus,
  type LeaveType,
  type PayBasis,
  type PayFrequency,
  type TimeEntry,
} from '@erp/shared'
import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { CalendarPlus, Check, MapPin, Pencil, Plus, Trash2, UserPlus, X } from 'lucide-react'
import { useState } from 'react'
import { Field, FormError } from '@/components/form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { EmptyState, LoadError, Loading, Money, PageHeader } from '@/features/finance/components'
import { useWorkspaceMutation } from '@/features/finance/queries'
import { psgcQueries, settingsQueries, useCan, useWorkspace, useWorkspaceId } from '@/features/workspaces/queries'
import { api, ApiError } from '@/lib/api'
import { formatDate, today } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { clockTime, hoursBetween, hrQueries, manilaDay, manilaLocal } from './queries'

/* =============================================================================================
 * Frame
 * =========================================================================================== */

const TABS = [
  { to: '/w/$workspaceId/hr', label: 'Overview', exact: true },
  { to: '/w/$workspaceId/hr/employees', label: 'Employees' },
  { to: '/w/$workspaceId/hr/attendance', label: 'Attendance' },
  { to: '/w/$workspaceId/hr/leave', label: 'Leave' },
  { to: '/w/$workspaceId/hr/payroll', label: 'Payroll', payroll: true },
  { to: '/w/$workspaceId/hr/reports', label: 'Government reports', payroll: true },
  { to: '/w/$workspaceId/hr/settings', label: 'Settings' },
] as const

export function HrLayout() {
  const workspace = useWorkspace()
  const can = useCan()
  if (!workspace.modules.includes('hr')) {
    return <EmptyState title="HR & Payroll is turned off">An owner or admin can turn it on in Settings → Workspace → Modules.</EmptyState>
  }
  if (!can('hr.view')) {
    return (
      <EmptyState
        title="Your role can’t see HR"
        action={
          <Button asChild>
            <Link to="/w/$workspaceId/me" params={{ workspaceId: workspace.id }}>
              Go to My time & pay
            </Link>
          </Button>
        }
      >
        You can still clock in, ask for leave and see your payslips.
      </EmptyState>
    )
  }
  return (
    <>
      <nav aria-label="HR and payroll" className="-mx-4 mb-6 overflow-x-auto border-b px-4 md:mx-0 md:px-0 print:hidden">
        <div className="flex min-w-max gap-1">
          {TABS.filter((t) => !('payroll' in t) || can('payroll.run')).map((t) => (
            <Link
              key={t.to}
              to={t.to}
              params={{ workspaceId: workspace.id }}
              activeOptions={{ exact: 'exact' in t && t.exact }}
              className="text-muted-foreground hover:text-foreground -mb-px border-b-2 border-transparent px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors"
              activeProps={{ className: 'border-foreground! text-foreground!', 'aria-current': 'page' }}
            >
              {t.label}
            </Link>
          ))}
        </div>
      </nav>
      <Outlet />
    </>
  )
}

export function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-xl tabular-nums">{value}</CardTitle>
        {note && <p className="text-muted-foreground text-xs">{note}</p>}
      </CardHeader>
    </Card>
  )
}

/* =============================================================================================
 * Overview
 * =========================================================================================== */

export function HrOverviewPage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const q = useQuery(hrQueries.overview(workspaceId))
  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Loading />
  const o = q.data
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Employees" value={String(o.headcount)} />
        <Stat label="Clocked in now" value={String(o.clockedIn.length)} />
        <Stat label="On leave today" value={String(o.onLeaveToday.length)} />
        <Stat label="Leave to decide" value={String(o.pendingLeave)} />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Clocked in</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {o.clockedIn.length === 0 && <p className="text-muted-foreground">Nobody right now.</p>}
            {o.clockedIn.map((c) => (
              <Link key={c.id} to="/w/$workspaceId/hr/employees/$id" params={{ workspaceId, id: c.id }} className="flex justify-between hover:underline">
                <span>{c.name}</span>
                <span className="text-muted-foreground">since {clockTime(c.since)}</span>
              </Link>
            ))}
            {o.onLeaveToday.map((l) => (
              <p key={l.id} className="text-muted-foreground flex justify-between">
                <span>{l.name}</span>
                <span>{l.leaveType}</span>
              </p>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Coming holidays</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {o.upcomingHolidays.length === 0 && <p className="text-muted-foreground">None set. Add next year’s in Settings.</p>}
            {o.upcomingHolidays.map((h) => (
              <p key={h.id} className="flex justify-between gap-3">
                <span>{h.name}</span>
                <span className="text-muted-foreground shrink-0">{formatDate(h.date)}</span>
              </p>
            ))}
          </CardContent>
        </Card>
        {can('payroll.run') && (
          <Card>
            <CardHeader>
              <CardTitle>Last payroll</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {!o.lastRun ? (
                <p className="text-muted-foreground">None yet.</p>
              ) : (
                <Link to="/w/$workspaceId/hr/payroll/$id" params={{ workspaceId, id: o.lastRun.id }} className="grid gap-1 hover:underline">
                  <span className="font-medium">
                    {o.lastRun.number ?? 'Draft'} · {formatDate(o.lastRun.periodStart)} to {formatDate(o.lastRun.periodEnd)}
                  </span>
                  <span className="text-muted-foreground">
                    {o.lastRun.headcount} people · {formatPeso(o.lastRun.net)} net
                  </span>
                </Link>
              )}
              <Button variant="outline" size="sm" asChild className="mt-2 w-fit">
                <Link to="/w/$workspaceId/hr/payroll" params={{ workspaceId }}>
                  Payroll
                </Link>
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
      {o.pendingLeave > 0 && (
        <Button asChild>
          <Link to="/w/$workspaceId/hr/leave" params={{ workspaceId }}>
            Decide {o.pendingLeave} leave request{o.pendingLeave === 1 ? '' : 's'}
          </Link>
        </Button>
      )}
    </div>
  )
}

/* =============================================================================================
 * Employees
 * =========================================================================================== */

export function EmployeesPage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const navigate = useNavigate()
  const q = useQuery(hrQueries.employees(workspaceId))
  const [adding, setAdding] = useState(false)
  const [showFormer, setShowFormer] = useState(false)
  const shown = q.data?.filter((e) => showFormer || e.active)
  const newButton = (
    <Button onClick={() => setAdding(true)}>
      <UserPlus />
      New employee
    </Button>
  )
  return (
    <div>
      <PageHeader title="Employees" description="Everyone on the payroll. Link each to their member account so they can clock in and see payslips on the phone." actions={can('hr.manage') ? newButton : undefined} />
      <div className="mb-4 flex items-center gap-2">
        <Checkbox id="former" checked={showFormer} onCheckedChange={(v) => setShowFormer(v === true)} />
        <Label htmlFor="former" className="font-normal">
          Show people who have left
        </Label>
      </div>
      {q.error ? (
        <LoadError error={q.error} />
      ) : !shown ? (
        <Loading />
      ) : shown.length === 0 ? (
        <EmptyState title="No employees yet" action={can('hr.manage') ? newButton : undefined} />
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="hidden md:table-cell">Position</TableHead>
                <TableHead className="hidden lg:table-cell">Since</TableHead>
                {can('payroll.run') && <TableHead className="text-right">Rate</TableHead>}
                <TableHead>Now</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((e) => (
                <TableRow key={e.id} className="cursor-pointer" onClick={() => void navigate({ to: '/w/$workspaceId/hr/employees/$id', params: { workspaceId, id: e.id } })}>
                  <TableCell>
                    <span className="font-medium">{e.name}</span>
                    <span className="text-muted-foreground block text-xs">{e.employeeNo}</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden md:table-cell">
                    {e.position}
                    {e.department && ` · ${e.department}`}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden lg:table-cell">{formatDate(e.hireDate)}</TableCell>
                  {can('payroll.run') && (
                    <TableCell className="text-right whitespace-nowrap">
                      {e.pay && (
                        <>
                          <Money value={e.pay.rate} />
                          <span className="text-muted-foreground text-xs"> /{e.pay.payBasis === 'monthly' ? 'mo' : 'day'}</span>
                        </>
                      )}
                    </TableCell>
                  )}
                  <TableCell>{!e.active ? <Badge variant="secondary">Left</Badge> : e.clockedIn ? <Badge variant="success">In</Badge> : null}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <EmployeeDialog open={adding} onOpenChange={setAdding} onSaved={(id) => void navigate({ to: '/w/$workspaceId/hr/employees/$id', params: { workspaceId, id } })} />
    </div>
  )
}

function EmployeeDialog({ open, onOpenChange, employee, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; employee?: Employee; onSaved?: (id: string) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        {open && (
          <EmployeeForm
            employee={employee}
            onDone={(id) => {
              onOpenChange(false)
              if (id) onSaved?.(id)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function EmployeeForm({ employee: e, onDone }: { employee?: Employee; onDone: (id?: string) => void }) {
  const workspace = useWorkspace()
  const can = useCan()
  const members = useQuery({ ...settingsQueries.members(workspace.id), enabled: can('members.view') })
  const regions = useQuery(psgcQueries.regions())
  const pay = can('payroll.run')
  const [v, setV] = useState({
    firstName: e?.firstName ?? '',
    middleName: e?.middleName ?? '',
    lastName: e?.lastName ?? '',
    birthDate: e?.birthDate ?? '',
    email: e?.email ?? '',
    phone: e?.phone ?? '',
    address: e?.address ?? '',
    position: e?.position ?? '',
    department: e?.department ?? '',
    employmentType: (e?.employmentType ?? 'regular') as EmploymentType,
    hireDate: e?.hireDate ?? today(),
    separationDate: e?.separationDate ?? '',
    userId: e?.user?.id ?? '',
    tin: '',
    sssNo: '',
    philhealthNo: '',
    pagibigNo: '',
    payBasis: (e?.pay?.payBasis ?? 'monthly') as PayBasis,
    rate: e?.pay ? centavosToInput(e.pay.rate) : '',
    payFrequency: (e?.pay?.payFrequency ?? 'semi_monthly') as PayFrequency,
    workDaysPerYear: String(e?.workDaysPerYear ?? 261),
    minimumWageEarner: e?.pay?.minimumWageEarner ?? false,
    tracksAttendance: e?.tracksAttendance ?? true,
    shiftStart: e?.shiftStart ?? '08:00',
    restDays: e?.restDays ?? [0],
    workRegionCode: e?.workRegionCode ?? (workspace.barangayCode ? `${workspace.barangayCode.slice(0, 2)}0000000` : ''),
  })
  const [error, setError] = useState<{ message: string; field?: string }>()
  const set = (patch: Partial<typeof v>) => setV((x) => ({ ...x, ...patch }))
  const err = (f: string) => (error?.field === f ? error.message : undefined)
  const save = useWorkspaceMutation((w, body: object) => (e ? api<{ employee: Employee }>(`/w/${w}/employees/${e.id}`, { method: 'PUT', body }) : api<{ employee: Employee }>(`/w/${w}/employees`, { method: 'POST', body })))

  async function submit() {
    setError(undefined)
    const rate = pay ? parsePeso(v.rate) : (e?.pay?.rate ?? 0)
    if (pay && (rate === null || rate <= 0)) return setError({ message: 'Enter the rate in pesos, like 25,000.', field: 'rate' })
    try {
      const r = await save.mutateAsync({
        ...v,
        rate,
        workDaysPerYear: Number(v.workDaysPerYear),
        birthDate: v.birthDate || null,
        separationDate: v.separationDate || null,
        userId: v.userId || null,
        workRegionCode: v.workRegionCode || null,
      })
      onDone(r.employee.id)
    } catch (x) {
      setError({ message: (x as Error).message, field: x instanceof ApiError ? x.field : undefined })
    }
  }

  const idHint = (current: string | null | undefined) => (e && current ? `On file: ${current}. Leave blank to keep it.` : undefined)
  return (
    <div className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{e ? `Edit ${e.name}` : 'New employee'}</DialogTitle>
        <DialogDescription>Government ID numbers are stored encrypted and shown in full only to people who manage HR.</DialogDescription>
      </DialogHeader>
      {error && <FormError message={error.message} />}
      <section className="grid gap-4 sm:grid-cols-3">
        <Field id="e-first" label="First name" error={err('firstName')}>
          <Input id="e-first" value={v.firstName} onChange={(x) => set({ firstName: x.target.value })} />
        </Field>
        <Field id="e-middle" label="Middle name">
          <Input id="e-middle" value={v.middleName} onChange={(x) => set({ middleName: x.target.value })} />
        </Field>
        <Field id="e-last" label="Last name" error={err('lastName')}>
          <Input id="e-last" value={v.lastName} onChange={(x) => set({ lastName: x.target.value })} />
        </Field>
        <Field id="e-position" label="Position" error={err('position')}>
          <Input id="e-position" value={v.position} onChange={(x) => set({ position: x.target.value })} />
        </Field>
        <Field id="e-dept" label="Department">
          <Input id="e-dept" value={v.department} onChange={(x) => set({ department: x.target.value })} />
        </Field>
        <Field id="e-type" label="Employment">
          <NativeSelect id="e-type" value={v.employmentType} onChange={(x) => set({ employmentType: x.target.value as EmploymentType })}>
            {EMPLOYMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {EMPLOYMENT_TYPE_LABELS[t]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="e-hired" label="Hired" error={err('hireDate')}>
          <Input id="e-hired" type="date" value={v.hireDate} onChange={(x) => set({ hireDate: x.target.value })} />
        </Field>
        <Field id="e-left" label="Last day (if they left)" error={err('separationDate')}>
          <Input id="e-left" type="date" value={v.separationDate} onChange={(x) => set({ separationDate: x.target.value })} />
        </Field>
        <Field id="e-birth" label="Birthday">
          <Input id="e-birth" type="date" value={v.birthDate} onChange={(x) => set({ birthDate: x.target.value })} />
        </Field>
        <Field id="e-phone" label="Phone">
          <Input id="e-phone" inputMode="tel" value={v.phone} onChange={(x) => set({ phone: x.target.value })} />
        </Field>
        <Field id="e-email" label="Email" error={err('email')} className="sm:col-span-2">
          <Input id="e-email" type="email" value={v.email} onChange={(x) => set({ email: x.target.value })} />
        </Field>
        <Field id="e-address" label="Address" className="sm:col-span-3">
          <Input id="e-address" value={v.address} onChange={(x) => set({ address: x.target.value })} />
        </Field>
        {members.data && (
          <Field id="e-user" label="Signs in as" error={err('userId')} hint="For clock-in, leave and payslips on the phone." className="sm:col-span-3">
            <NativeSelect id="e-user" value={v.userId} onChange={(x) => set({ userId: x.target.value })}>
              <option value="">Nobody (no app access)</option>
              {members.data.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name} · {m.email}
                </option>
              ))}
            </NativeSelect>
          </Field>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <h3 className="text-sm font-semibold sm:col-span-2">Government numbers</h3>
        <Field id="e-tin" label="TIN" error={err('tin')} hint={idHint(e?.tin)}>
          <Input id="e-tin" placeholder="123-456-789-00000" value={v.tin} onChange={(x) => set({ tin: x.target.value })} />
        </Field>
        <Field id="e-sss" label="SSS" error={err('sssNo')} hint={idHint(e?.sssNo)}>
          <Input id="e-sss" placeholder="34-1234567-8" value={v.sssNo} onChange={(x) => set({ sssNo: x.target.value })} />
        </Field>
        <Field id="e-ph" label="PhilHealth" error={err('philhealthNo')} hint={idHint(e?.philhealthNo)}>
          <Input id="e-ph" placeholder="12-345678901-2" value={v.philhealthNo} onChange={(x) => set({ philhealthNo: x.target.value })} />
        </Field>
        <Field id="e-pi" label="Pag-IBIG MID" error={err('pagibigNo')} hint={idHint(e?.pagibigNo)}>
          <Input id="e-pi" placeholder="1234-5678-9012" value={v.pagibigNo} onChange={(x) => set({ pagibigNo: x.target.value })} />
        </Field>
      </section>

      {pay && (
        <section className="grid gap-4 sm:grid-cols-3">
          <h3 className="text-sm font-semibold sm:col-span-3">Pay</h3>
          <Field id="e-basis" label="Paid by">
            <NativeSelect id="e-basis" value={v.payBasis} onChange={(x) => set({ payBasis: x.target.value as PayBasis })}>
              <option value="monthly">The month</option>
              <option value="daily">The day</option>
            </NativeSelect>
          </Field>
          <Field id="e-rate" label={v.payBasis === 'monthly' ? 'Monthly salary (₱)' : 'Daily rate (₱)'} error={err('rate')}>
            <Input id="e-rate" inputMode="decimal" className="text-right" value={v.rate} onChange={(x) => set({ rate: x.target.value })} />
          </Field>
          <Field id="e-freq" label="Paid">
            <NativeSelect id="e-freq" value={v.payFrequency} onChange={(x) => set({ payFrequency: x.target.value as PayFrequency })}>
              {Object.entries(PAY_FREQUENCY_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id="e-factor" label="Days paid a year" hint="261 for a 5-day week, 313 for a 6-day week.">
            <NativeSelect id="e-factor" value={v.workDaysPerYear} onChange={(x) => set({ workDaysPerYear: x.target.value })}>
              <option value="261">261</option>
              <option value="313">313</option>
              <option value="365">365</option>
            </NativeSelect>
          </Field>
          <Field id="e-region" label="Works in (for minimum wage)" className="sm:col-span-2">
            <NativeSelect id="e-region" value={v.workRegionCode} onChange={(x) => set({ workRegionCode: x.target.value })}>
              <option value="">Not set</option>
              {regions.data?.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="flex items-center gap-2 sm:col-span-3">
            <Checkbox id="e-mwe" checked={v.minimumWageEarner} onCheckedChange={(x) => set({ minimumWageEarner: x === true })} />
            <Label htmlFor="e-mwe" className="font-normal">
              Minimum wage earner (no income tax withheld)
            </Label>
          </div>
        </section>
      )}

      <section className="grid gap-4 sm:grid-cols-3">
        <h3 className="text-sm font-semibold sm:col-span-3">Schedule</h3>
        <Field id="e-shift" label="Shift starts">
          <Input id="e-shift" type="time" value={v.shiftStart} onChange={(x) => set({ shiftStart: x.target.value })} />
        </Field>
        <div className="grid gap-2 sm:col-span-2">
          <span className="text-sm font-medium">Rest days</span>
          <div className="flex flex-wrap gap-3">
            {WEEKDAYS.map((d, i) => (
              <label key={d} className="flex items-center gap-1.5 text-sm">
                <Checkbox checked={v.restDays.includes(i)} onCheckedChange={(x) => set({ restDays: x === true ? [...v.restDays, i] : v.restDays.filter((r) => r !== i) })} />
                {d.slice(0, 3)}
              </label>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 sm:col-span-3">
          <Checkbox id="e-tracks" checked={v.tracksAttendance} onCheckedChange={(x) => set({ tracksAttendance: x === true })} />
          <Label htmlFor="e-tracks" className="font-normal">
            Clocks in: absences, lateness and overtime come from clock-ins (otherwise paid in full unless the payroll is edited)
          </Label>
        </div>
      </section>
      <DialogFooter>
        <Button variant="outline" onClick={() => onDone()}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : e ? 'Save' : 'Add employee'}
        </Button>
      </DialogFooter>
    </div>
  )
}

export function EmployeePage({ id }: { id: string }) {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const q = useQuery(hrQueries.employee(workspaceId, id))
  const from = addDaysTo(today(), -13)
  const time = useQuery(hrQueries.attendance(workspaceId, from, today(), id))
  const [editing, setEditing] = useState(false)
  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Loading />
  const e = q.data
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">{e.name}</h2>
            {!e.active ? <Badge variant="secondary">Left {formatDate(e.separationDate)}</Badge> : e.clockedIn && <Badge variant="success">Clocked in</Badge>}
          </div>
          <p className="text-muted-foreground text-sm">
            {e.employeeNo} · {e.position}
            {e.department && `, ${e.department}`} · {EMPLOYMENT_TYPE_LABELS[e.employmentType]} since {formatDate(e.hireDate)}
          </p>
        </div>
        {can('hr.manage') && (
          <Button variant="outline" onClick={() => setEditing(true)}>
            <Pencil />
            Edit
          </Button>
        )}
      </div>
      {e.minimumWageWarning && (
        <Alert variant="destructive">
          <AlertDescription>{e.minimumWageWarning}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <Row label="Signs in as" value={e.user?.name ?? 'Not linked'} />
            <Row label="Phone" value={e.phone} />
            <Row label="Email" value={e.email} />
            <Row label="Birthday" value={e.birthDate && formatDate(e.birthDate)} />
            <Row label="Shift starts" value={e.shiftStart} />
            <Row label="Rest days" value={e.restDays.map((d) => WEEKDAYS[d]).join(', ') || 'None'} />
            <Row label="Clocks in" value={e.tracksAttendance ? 'Yes' : 'No: paid in full'} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Government numbers</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <Row label="TIN" value={e.tin} />
            <Row label="SSS" value={e.sssNo} />
            <Row label="PhilHealth" value={e.philhealthNo} />
            <Row label="Pag-IBIG" value={e.pagibigNo} />
          </CardContent>
        </Card>
        {e.pay && (
          <Card>
            <CardHeader>
              <CardTitle>Pay</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              <Row label={e.pay.payBasis === 'monthly' ? 'Monthly salary' : 'Daily rate'} value={formatPeso(e.pay.rate)} />
              <Row label="Daily rate" value={formatPeso(e.pay.dailyRate)} />
              <Row label="Paid" value={PAY_FREQUENCY_LABELS[e.pay.payFrequency]} />
              <Row label="Days paid a year" value={String(e.workDaysPerYear)} />
              <Row label="Tax" value={e.pay.minimumWageEarner ? 'Minimum wage earner: none' : 'Withheld each payroll'} />
            </CardContent>
          </Card>
        )}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Leave this year</CardTitle>
          </CardHeader>
          <CardContent>
            <LeaveBalances balances={e.leave} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Last two weeks</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {time.data?.length === 0 && <p className="text-muted-foreground">No clock-ins.</p>}
            {time.data?.map((t) => (
              <p key={t.id} className="flex justify-between gap-3">
                <span>{formatDate(manilaDay(t.clockIn))}</span>
                <span className="text-muted-foreground tabular-nums">
                  {clockTime(t.clockIn)} – {t.clockOut ? clockTime(t.clockOut) : 'still in'}
                </span>
              </p>
            ))}
          </CardContent>
        </Card>
      </div>
      <EmployeeDialog open={editing} onOpenChange={setEditing} employee={e} />
    </div>
  )
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value || '—'}</span>
    </div>
  )
}

export function LeaveBalances({ balances }: { balances: Employee['leave'] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-0">Leave</TableHead>
          <TableHead className="text-right">Used</TableHead>
          <TableHead className="text-right">Waiting</TableHead>
          <TableHead className="pr-0 text-right">Left</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {balances.map((b) => (
          <TableRow key={b.leaveType.id}>
            <TableCell className="pl-0">
              {b.leaveType.name}
              {!b.leaveType.paid && <span className="text-muted-foreground text-xs"> · unpaid</span>}
            </TableCell>
            <TableCell className="text-right tabular-nums">{b.used}</TableCell>
            <TableCell className="text-right tabular-nums">{b.pending || '—'}</TableCell>
            <TableCell className="pr-0 text-right tabular-nums">{b.left === null ? 'no limit' : `${b.left} of ${b.entitled}`}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

const addDaysTo = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/* =============================================================================================
 * Attendance
 * =========================================================================================== */

export function AttendancePage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const [from, setFrom] = useState(addDaysTo(today(), -6))
  const [to, setTo] = useState(today())
  const [employeeId, setEmployeeId] = useState('')
  const people = useQuery(hrQueries.employees(workspaceId))
  const q = useQuery(hrQueries.attendance(workspaceId, from, to, employeeId || undefined))
  const [editing, setEditing] = useState<TimeEntry | 'new' | null>(null)
  const remove = useWorkspaceMutation((w, id: string) => api(`/w/${w}/attendance/${id}`, { method: 'DELETE' }))
  const days = [...new Set(q.data?.map((t) => manilaDay(t.clockIn)))]
  return (
    <div>
      <PageHeader
        title="Attendance"
        description="Clock-ins from the phone and the web, with where they were. Fix a missed clock-out here; every change is in the audit log."
        actions={
          can('hr.manage') ? (
            <Button onClick={() => setEditing('new')}>
              <Plus />
              Add time
            </Button>
          ) : undefined
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field id="a-from" label="From">
          <Input id="a-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field id="a-to" label="To">
          <Input id="a-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field id="a-emp" label="Employee">
          <NativeSelect id="a-emp" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Everyone</option>
            {people.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      {remove.error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{remove.error.message}</AlertDescription>
        </Alert>
      )}
      {q.error ? (
        <LoadError error={q.error} />
      ) : !q.data ? (
        <Loading />
      ) : q.data.length === 0 ? (
        <EmptyState title="No clock-ins in those days" />
      ) : (
        <div className="space-y-6">
          {days.map((d) => (
            <div key={d}>
              <h3 className="mb-2 text-sm font-semibold">{formatDate(d)}</h3>
              <div className="rounded-xl border">
                <Table>
                  <TableBody>
                    {q.data!
                      .filter((t) => manilaDay(t.clockIn) === d)
                      .map((t) => (
                        <TableRow key={t.id}>
                          <TableCell className="w-1/3 font-medium">{t.employee.name}</TableCell>
                          <TableCell className="tabular-nums">
                            {clockTime(t.clockIn)} – {t.clockOut ? clockTime(t.clockOut) : <Badge variant="success">in</Badge>}
                            {t.clockOut && <span className="text-muted-foreground"> · {hoursBetween(t.clockIn, t.clockOut)} h</span>}
                          </TableCell>
                          <TableCell className="text-muted-foreground hidden text-xs md:table-cell">
                            {t.source === 'manual' ? `Entered by HR${t.note ? `: ${t.note}` : ''}` : t.source === 'phone' ? 'Phone' : 'Web'}
                            {t.inLocation && (
                              <a
                                className="ml-2 inline-flex items-center gap-0.5 hover:underline"
                                href={`https://www.google.com/maps?q=${t.inLocation.latitude},${t.inLocation.longitude}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                <MapPin className="size-3" />
                                where
                              </a>
                            )}
                          </TableCell>
                          <TableCell className="w-24 text-right">
                            {can('hr.manage') && (
                              <>
                                <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => setEditing(t)}>
                                  <Pencil />
                                </Button>
                                <Button variant="ghost" size="icon" aria-label="Delete" onClick={() => window.confirm('Delete this time entry?') && remove.mutate(t.id)}>
                                  <Trash2 />
                                </Button>
                              </>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ))}
        </div>
      )}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>{editing !== null && <TimeForm entry={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} />}</DialogContent>
      </Dialog>
    </div>
  )
}

function TimeForm({ entry, onDone }: { entry?: TimeEntry; onDone: () => void }) {
  const workspaceId = useWorkspaceId()
  const people = useQuery(hrQueries.employees(workspaceId))
  const [employeeId, setEmployeeId] = useState(entry?.employee.id ?? '')
  const [clockIn, setClockIn] = useState(entry ? manilaLocal(entry.clockIn) : `${today()}T08:00`)
  const [clockOut, setClockOut] = useState(entry?.clockOut ? manilaLocal(entry.clockOut) : `${today()}T17:00`)
  const [note, setNote] = useState(entry?.note ?? '')
  const [error, setError] = useState<string>()
  const save = useWorkspaceMutation((w, body: object) => api(entry ? `/w/${w}/attendance/${entry.id}` : `/w/${w}/attendance`, { method: entry ? 'PUT' : 'POST', body }))
  async function submit() {
    setError(undefined)
    if (!employeeId) return setError('Choose the employee.')
    try {
      await save.mutateAsync({ employeeId, clockIn, clockOut: clockOut || null, note })
      onDone()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{entry ? 'Fix a time entry' : 'Add time'}</DialogTitle>
        <DialogDescription>Times are Philippine time. Say why in the note: it goes in the audit log.</DialogDescription>
      </DialogHeader>
      <FormError message={error} />
      <Field id="t-emp" label="Employee">
        <NativeSelect id="t-emp" value={employeeId} disabled={!!entry} onChange={(e) => setEmployeeId(e.target.value)}>
          <option value="">Choose…</option>
          {people.data
            ?.filter((p) => p.active)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </NativeSelect>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="t-in" label="In">
          <Input id="t-in" type="datetime-local" value={clockIn} onChange={(e) => setClockIn(e.target.value)} />
        </Field>
        <Field id="t-out" label="Out">
          <Input id="t-out" type="datetime-local" value={clockOut} onChange={(e) => setClockOut(e.target.value)} />
        </Field>
      </div>
      <Field id="t-note" label="Note">
        <Input id="t-note" placeholder="Forgot to clock out" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={save.isPending}>
          Save
        </Button>
      </DialogFooter>
    </div>
  )
}

/* =============================================================================================
 * Leave
 * =========================================================================================== */

export function LeaveStatusBadge({ status }: { status: LeaveStatus }) {
  return <Badge variant={status === 'approved' ? 'success' : status === 'pending' ? 'default' : 'secondary'}>{LEAVE_STATUS_LABELS[status]}</Badge>
}

export function LeavePage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const [status, setStatus] = useState<LeaveStatus | ''>('pending')
  const q = useQuery(hrQueries.leave(workspaceId, status || undefined))
  const [filing, setFiling] = useState(false)
  const decide = useWorkspaceMutation((w, { id, what }: { id: string; what: 'approve' | 'reject' | 'cancel' }) => api(`/w/${w}/leave/requests/${id}/${what}`, { method: 'POST', body: {} }))
  return (
    <div>
      <PageHeader
        title="Leave"
        description="Requests from the phone land here. Approved paid leave is paid in the payroll; unpaid leave is deducted."
        actions={
          can('hr.manage') ? (
            <Button onClick={() => setFiling(true)}>
              <CalendarPlus />
              File leave for someone
            </Button>
          ) : undefined
        }
      />
      <NativeSelect aria-label="Show" className="mb-4 w-48" value={status} onChange={(e) => setStatus(e.target.value as LeaveStatus | '')}>
        <option value="">All</option>
        {Object.entries(LEAVE_STATUS_LABELS).map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </NativeSelect>
      {decide.error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{decide.error.message}</AlertDescription>
        </Alert>
      )}
      {q.error ? (
        <LoadError error={q.error} />
      ) : !q.data ? (
        <Loading />
      ) : q.data.length === 0 ? (
        <EmptyState title={status === 'pending' ? 'Nothing waiting' : 'No leave'} />
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Who</TableHead>
                <TableHead>Leave</TableHead>
                <TableHead>Days</TableHead>
                <TableHead className="hidden md:table-cell">Why</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-medium">{l.employee.name}</TableCell>
                  <TableCell>
                    {l.leaveType.name}
                    <span className="text-muted-foreground block text-xs">
                      {formatDate(l.startDate)}
                      {l.endDate !== l.startDate && ` to ${formatDate(l.endDate)}`}
                      {l.halfDay && ' (half day)'}
                    </span>
                  </TableCell>
                  <TableCell className="tabular-nums">{l.days}</TableCell>
                  <TableCell className="text-muted-foreground hidden max-w-64 truncate md:table-cell">{l.reason}</TableCell>
                  <TableCell>
                    <LeaveStatusBadge status={l.status} />
                    {l.decidedBy && <span className="text-muted-foreground block text-xs">{l.decidedBy.name}</span>}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {can('hr.manage') && l.status === 'pending' && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => decide.mutate({ id: l.id, what: 'reject' })} disabled={decide.isPending}>
                          <X />
                          No
                        </Button>
                        <Button size="sm" onClick={() => decide.mutate({ id: l.id, what: 'approve' })} disabled={decide.isPending}>
                          <Check />
                          Approve
                        </Button>
                      </>
                    )}
                    {can('hr.manage') && l.status === 'approved' && (
                      <Button size="sm" variant="ghost" onClick={() => window.confirm('Cancel this approved leave?') && decide.mutate({ id: l.id, what: 'cancel' })}>
                        Cancel
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Dialog open={filing} onOpenChange={setFiling}>
        <DialogContent>{filing && <LeaveForm forSomeone onDone={() => setFiling(false)} />}</DialogContent>
      </Dialog>
    </div>
  )
}

/** Asking for leave: for yourself (self-service) or, for HR, on someone's behalf. */
export function LeaveForm({ forSomeone, onDone }: { forSomeone?: boolean; onDone: () => void }) {
  const workspaceId = useWorkspaceId()
  const people = useQuery({ ...hrQueries.employees(workspaceId), enabled: !!forSomeone })
  const types = useQuery(forSomeone ? hrQueries.leaveTypes(workspaceId) : hrQueries.myLeaveTypes(workspaceId))
  const [employeeId, setEmployeeId] = useState('')
  const [leaveTypeId, setLeaveTypeId] = useState('')
  const [startDate, setStart] = useState(today())
  const [endDate, setEnd] = useState(today())
  const [halfDay, setHalfDay] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string>()
  const save = useWorkspaceMutation((w, body: object) => api(forSomeone ? `/w/${w}/leave/requests` : `/w/${w}/me/leave`, { method: 'POST', body }))
  async function submit() {
    setError(undefined)
    try {
      await save.mutateAsync({ ...(forSomeone ? { employeeId } : {}), leaveTypeId, startDate, endDate: halfDay ? startDate : endDate, halfDay, reason })
      onDone()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const active = (types.data as LeaveType[] | undefined)?.filter((t) => t.active)
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{forSomeone ? 'File leave' : 'Ask for leave'}</DialogTitle>
        <DialogDescription>Rest days and holidays in between aren’t counted.</DialogDescription>
      </DialogHeader>
      <FormError message={error} />
      {forSomeone && (
        <Field id="l-emp" label="Employee">
          <NativeSelect id="l-emp" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Choose…</option>
            {people.data
              ?.filter((p) => p.active)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </NativeSelect>
        </Field>
      )}
      <Field id="l-type" label="Kind of leave">
        <NativeSelect id="l-type" value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)}>
          <option value="">Choose…</option>
          {active?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.paid ? '' : ' (unpaid)'}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="l-start" label="From">
          <Input id="l-start" type="date" value={startDate} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field id="l-end" label="To">
          <Input id="l-end" type="date" value={halfDay ? startDate : endDate} disabled={halfDay} onChange={(e) => setEnd(e.target.value)} />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="l-half" checked={halfDay} onCheckedChange={(v) => setHalfDay(v === true)} />
        <Label htmlFor="l-half" className="font-normal">
          Half a day
        </Label>
      </div>
      <Field id="l-reason" label="Reason">
        <Textarea id="l-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={save.isPending}>
          {forSomeone ? 'File it' : 'Send request'}
        </Button>
      </DialogFooter>
    </div>
  )
}

/* =============================================================================================
 * Settings: holidays, leave types, government rates
 * =========================================================================================== */

export function HrSettingsPage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const [year, setYear] = useState(Number(today().slice(0, 4)))
  const hols = useQuery(hrQueries.holidays(workspaceId, year))
  const types = useQuery(hrQueries.leaveTypes(workspaceId))
  const rates = useQuery(hrQueries.govRates(workspaceId))
  const [adding, setAdding] = useState(false)
  const [editingType, setEditingType] = useState<LeaveType | null>(null)
  const removeHoliday = useWorkspaceMutation((w, id: string) => api(`/w/${w}/holidays/${id}`, { method: 'DELETE' }))
  const manage = can('hr.manage')
  return (
    <div className="space-y-10">
      <section>
        <PageHeader
          title="Holidays"
          description="Regular holidays pay 200% when worked; special days 130%. Special days are often announced at short notice: add them here, and Eid’l Fitr and Eid’l Adha when proclaimed."
          actions={
            manage ? (
              <Button onClick={() => setAdding(true)}>
                <Plus />
                Add a holiday
              </Button>
            ) : undefined
          }
        />
        <NativeSelect aria-label="Year" className="mb-4 w-32" value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {[-1, 0, 1].map((d) => {
            const y = Number(today().slice(0, 4)) + d
            return (
              <option key={y} value={y}>
                {y}
              </option>
            )
          })}
        </NativeSelect>
        {hols.data?.length === 0 ? (
          <EmptyState title={`No holidays set for ${year}`} />
        ) : (
          <div className="rounded-xl border">
            <Table>
              <TableBody>
                {hols.data?.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell className="w-40 whitespace-nowrap">{formatDate(h.date)}</TableCell>
                    <TableCell>{h.name}</TableCell>
                    <TableCell>
                      <Badge variant={h.kind === 'regular' ? 'default' : 'outline'}>{HOLIDAY_KIND_LABELS[h.kind]}</Badge>
                    </TableCell>
                    <TableCell className="w-12 text-right">
                      {manage && (
                        <Button variant="ghost" size="icon" aria-label={`Remove ${h.name}`} onClick={() => window.confirm(`Remove ${h.name}?`) && removeHoliday.mutate(h.id)}>
                          <Trash2 />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section>
        <PageHeader title="Kinds of leave" description="What the law gives (service incentive, maternity, paternity, solo parent, VAWC, special leave for women) and what the company adds." />
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Leave</TableHead>
                <TableHead>Paid</TableHead>
                <TableHead className="text-right">Days a year</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {types.data?.map((t) => (
                <TableRow key={t.id} className={cn(!t.active && 'text-muted-foreground')}>
                  <TableCell>
                    {t.name}
                    {!t.active && ' (off)'}
                  </TableCell>
                  <TableCell>{t.paid ? 'Paid' : 'Unpaid'}</TableCell>
                  <TableCell className="text-right tabular-nums">{t.daysPerYear ?? 'no limit'}</TableCell>
                  <TableCell className="w-12 text-right">
                    {manage && (
                      <Button variant="ghost" size="icon" aria-label={`Edit ${t.name}`} onClick={() => setEditingType(t)}>
                        <Pencil />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section>
        <PageHeader title="Government rates" description="The rates payroll uses, each from the date it applies. A new circular is added as a new row; payroll picks whichever is in force for the period it pays. Check them against the latest issuances." />
        <div className="grid gap-3 md:grid-cols-2">
          {rates.data?.map((r) => (
            <Card key={r.id} className="gap-2 py-4">
              <CardHeader className="px-4">
                <CardTitle className="text-base">{GOV_RATE_LABELS[r.kind]}</CardTitle>
                <CardDescription>From {formatDate(r.effectiveFrom)}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-1 px-4 text-sm">
                <p>{rateSummary(r)}</p>
                <p className="text-muted-foreground text-xs">{r.source}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>{adding && <HolidayForm onDone={() => setAdding(false)} />}</DialogContent>
      </Dialog>
      <Dialog open={!!editingType} onOpenChange={(o) => !o && setEditingType(null)}>
        <DialogContent>{editingType && <LeaveTypeForm type={editingType} onDone={() => setEditingType(null)} />}</DialogContent>
      </Dialog>
    </div>
  )
}

const pct = (bp: number) => `${bp / 100}%`
function rateSummary(r: GovRate) {
  const d = r.data as Record<string, never>
  switch (r.kind) {
    case 'sss':
      return `${pct(d.eeBp)} employee, ${pct(d.erBp)} employer, on salary credits ${formatPeso(d.minMsc)} to ${formatPeso(d.maxMsc)}; EC ${formatPeso(d.ecLow)} or ${formatPeso(d.ecHigh)}.`
    case 'philhealth':
      return `${pct(d.rateBp)} of basic salary between ${formatPeso(d.floor)} and ${formatPeso(d.ceiling)}, shared equally.`
    case 'pagibig':
      return `${pct(d.eeBp)} employee and ${pct(d.erBp)} employer on up to ${formatPeso(d.maxBase)}.`
    case 'wtax':
      return `Semi-monthly, monthly and annual tables; nothing withheld up to ${formatPeso((d.monthly as unknown as { over: number }[])[0]!.over)} a month.`
    case 'premiums':
      return `Overtime +${(d.regularOvertime as number) - 100}%; rest day ${(d.days as Record<string, number>).rest}%, regular holiday ${(d.days as Record<string, number>).holiday}%; night +${pct(d.nightBp)}.`
    case 'thirteenth':
      return `Tax-free up to ${formatPeso(d.thirteenthExempt)} a year, with other benefits.`
    case 'minimum_wage':
      return Object.values(d as Record<string, { region: string; daily: number }>)
        .map((m) => `${m.region}: ${formatPeso(m.daily)} a day`)
        .join('; ')
  }
}

function HolidayForm({ onDone }: { onDone: () => void }) {
  const [date, setDate] = useState(today())
  const [name, setName] = useState('')
  const [kind, setKind] = useState<HolidayKind>('special')
  const [error, setError] = useState<string>()
  const save = useWorkspaceMutation((w, body: object) => api(`/w/${w}/holidays`, { method: 'POST', body }))
  async function submit() {
    setError(undefined)
    try {
      await save.mutateAsync({ date, name, kind })
      onDone()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Add a holiday</DialogTitle>
        <DialogDescription>From the proclamation, or a local holiday where you operate.</DialogDescription>
      </DialogHeader>
      <FormError message={error} />
      <Field id="h-date" label="Date">
        <Input id="h-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Field id="h-name" label="Name">
        <Input id="h-name" placeholder="Eid’l Fitr" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field id="h-kind" label="Kind">
        <NativeSelect id="h-kind" value={kind} onChange={(e) => setKind(e.target.value as HolidayKind)}>
          <option value="regular">{HOLIDAY_KIND_LABELS.regular}</option>
          <option value="special">{HOLIDAY_KIND_LABELS.special}</option>
        </NativeSelect>
      </Field>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={save.isPending}>
          Add
        </Button>
      </DialogFooter>
    </div>
  )
}

function LeaveTypeForm({ type, onDone }: { type: LeaveType; onDone: () => void }) {
  const [name, setName] = useState(type.name)
  const [paid, setPaid] = useState(type.paid)
  const [days, setDays] = useState(type.daysPerYear?.toString() ?? '')
  const [active, setActive] = useState(type.active)
  const [error, setError] = useState<string>()
  const save = useWorkspaceMutation((w, body: object) => api(`/w/${w}/leave/types/${type.id}`, { method: 'PUT', body }))
  async function submit() {
    setError(undefined)
    try {
      await save.mutateAsync({ name, paid, daysPerYear: days.trim() === '' ? null : Number(days), active })
      onDone()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{type.name}</DialogTitle>
        <DialogDescription>Days given each calendar year. Leave blank for no limit.</DialogDescription>
      </DialogHeader>
      <FormError message={error} />
      <Field id="lt-name" label="Name">
        <Input id="lt-name" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field id="lt-days" label="Days a year">
        <Input id="lt-days" inputMode="decimal" className="text-right" value={days} onChange={(e) => setDays(e.target.value)} />
      </Field>
      <div className="flex items-center gap-2">
        <Checkbox id="lt-paid" checked={paid} onCheckedChange={(v) => setPaid(v === true)} />
        <Label htmlFor="lt-paid" className="font-normal">
          Paid
        </Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="lt-active" checked={active} onCheckedChange={(v) => setActive(v === true)} />
        <Label htmlFor="lt-active" className="font-normal">
          People can ask for it
        </Label>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={save.isPending}>
          Save
        </Button>
      </DialogFooter>
    </div>
  )
}

