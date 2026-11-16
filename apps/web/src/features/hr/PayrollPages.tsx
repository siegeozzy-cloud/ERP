import {
  ADJUSTMENT_KIND_LABELS,
  ADJUSTMENT_KINDS,
  centavosToInput,
  DAY_TYPE_LABELS,
  DAY_TYPES,
  formatPeso,
  parsePeso,
  PAY_FREQUENCY_LABELS,
  RUN_STATUS_LABELS,
  type AdjustmentKind,
  type DayType,
  type PayFrequency,
  type PayInputs,
  type PayLine,
  type PayrollLine,
  type PayrollRun,
  type RemittanceRow,
  type RunKind,
  type RunStatus,
} from '@erp/shared'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Banknote, Download, Plus, Printer, RefreshCw, Send, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Field, FormError } from '@/components/form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { csvAmount, downloadCsv, EmptyState, LoadError, Loading, Money, PageHeader } from '@/features/finance/components'
import { financeQueries, useWorkspaceMutation } from '@/features/finance/queries'
import { useCan, useWorkspace, useWorkspaceId } from '@/features/workspaces/queries'
import { api } from '@/lib/api'
import { formatDate, formatMonth, today } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { hrQueries } from './queries'

/* =============================================================================================
 * Runs
 * =========================================================================================== */

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <Badge variant={status === 'paid' ? 'success' : status === 'posted' ? 'default' : 'outline'}>{RUN_STATUS_LABELS[status]}</Badge>
}

const lastDay = (month: string) => {
  const d = new Date(`${month}-01T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + 1, 0)
  return d.toISOString().slice(0, 10)
}

/** The cutoff today falls in: the 1st to 15th, or the 16th to the end of the month. */
function currentCutoff(frequency: PayFrequency) {
  const t = today()
  const month = t.slice(0, 7)
  if (frequency === 'monthly') return { periodStart: `${month}-01`, periodEnd: lastDay(month) }
  return Number(t.slice(8)) <= 15 ? { periodStart: `${month}-01`, periodEnd: `${month}-15` } : { periodStart: `${month}-16`, periodEnd: lastDay(month) }
}

export function PayrollRunsPage() {
  const workspaceId = useWorkspaceId()
  const navigate = useNavigate()
  const q = useQuery(hrQueries.runs(workspaceId))
  const [creating, setCreating] = useState(false)
  const newButton = (
    <Button onClick={() => setCreating(true)}>
      <Plus />
      New payroll
    </Button>
  )
  return (
    <div>
      <PageHeader title="Payroll" description="Each run is worked out from clock-ins, leave and holidays with the government rates in force. Check it, post it, then mark it paid." actions={newButton} />
      {q.error ? (
        <LoadError error={q.error} />
      ) : !q.data ? (
        <Loading />
      ) : q.data.length === 0 ? (
        <EmptyState title="No payroll yet" action={newButton} />
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Period</TableHead>
                <TableHead className="hidden md:table-cell">Pay day</TableHead>
                <TableHead className="hidden text-right sm:table-cell">People</TableHead>
                <TableHead className="text-right">Net pay</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((r) => (
                <TableRow key={r.id} className="cursor-pointer" onClick={() => void navigate({ to: '/w/$workspaceId/hr/payroll/$id', params: { workspaceId, id: r.id } })}>
                  <TableCell className="font-medium whitespace-nowrap">{r.number ?? 'Draft'}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {r.kind === 'thirteenth' ? `13th month ${r.periodEnd.slice(0, 4)}` : `${formatDate(r.periodStart)} – ${formatDate(r.periodEnd)}`}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden md:table-cell">{formatDate(r.payDate)}</TableCell>
                  <TableCell className="hidden text-right tabular-nums sm:table-cell">{r.headcount}</TableCell>
                  <TableCell className="text-right">
                    <Money value={r.net} />
                  </TableCell>
                  <TableCell>
                    <RunStatusBadge status={r.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>{creating && <NewRunForm onDone={() => setCreating(false)} />}</DialogContent>
      </Dialog>
    </div>
  )
}

function NewRunForm({ onDone }: { onDone: () => void }) {
  const workspaceId = useWorkspaceId()
  const navigate = useNavigate()
  const [kind, setKind] = useState<RunKind>('regular')
  const [frequency, setFrequency] = useState<PayFrequency>('semi_monthly')
  const cut = currentCutoff(frequency)
  const year = today().slice(0, 4)
  const [periodStart, setStart] = useState(cut.periodStart)
  const [periodEnd, setEnd] = useState(cut.periodEnd)
  const [payDate, setPayDate] = useState(cut.periodEnd)
  const [error, setError] = useState<string>()
  const create = useWorkspaceMutation((w, body: object) => api<{ run: PayrollRun }>(`/w/${w}/payroll/runs`, { method: 'POST', body }))
  const pick = (k: RunKind, f: PayFrequency) => {
    setKind(k)
    setFrequency(f)
    const c = k === 'thirteenth' ? { periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` } : currentCutoff(f)
    setStart(c.periodStart)
    setEnd(c.periodEnd)
    setPayDate(k === 'thirteenth' ? `${year}-12-15` : c.periodEnd)
  }
  async function submit() {
    setError(undefined)
    try {
      const r = await create.mutateAsync({ kind, frequency, periodStart, periodEnd, payDate })
      onDone()
      await navigate({ to: '/w/$workspaceId/hr/payroll/$id', params: { workspaceId, id: r.run.id } })
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>New payroll</DialogTitle>
        <DialogDescription>A draft for everyone paid on that schedule. Contributions are taken in the run that ends the month, on the whole month’s pay.</DialogDescription>
      </DialogHeader>
      <FormError message={error} />
      <Field id="r-kind" label="What">
        <NativeSelect id="r-kind" value={kind === 'thirteenth' ? 'thirteenth' : frequency} onChange={(e) => (e.target.value === 'thirteenth' ? pick('thirteenth', frequency) : pick('regular', e.target.value as PayFrequency))}>
          {Object.entries(PAY_FREQUENCY_LABELS).map(([k, label]) => (
            <option key={k} value={k}>
              Pay: {label.toLowerCase()}
            </option>
          ))}
          <option value="thirteenth">13th month pay</option>
        </NativeSelect>
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="r-start" label="From">
          <Input id="r-start" type="date" value={periodStart} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field id="r-end" label="To">
          <Input id="r-end" type="date" value={periodEnd} onChange={(e) => setEnd(e.target.value)} />
        </Field>
        <Field id="r-pay" label="Pay day">
          <Input id="r-pay" type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
        </Field>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={create.isPending}>
          {create.isPending ? 'Working it out…' : 'Work it out'}
        </Button>
      </DialogFooter>
    </div>
  )
}

const contributions = (l: PayrollLine) => l.result.sss.ee + l.result.philhealth.ee + l.result.pagibig.ee

export function PayrollRunPage({ id }: { id: string }) {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const navigate = useNavigate()
  const q = useQuery(hrQueries.run(workspaceId, id))
  const [editing, setEditing] = useState<PayrollLine | null>(null)
  const [paying, setPaying] = useState(false)
  const act = useWorkspaceMutation((w, what: 'refresh' | 'post' | 'delete') => (what === 'delete' ? api(`/w/${w}/payroll/runs/${id}`, { method: 'DELETE' }) : api(`/w/${w}/payroll/runs/${id}/${what}`, { method: 'POST' })))
  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Loading />
  const r = q.data
  const draft = r.status === 'draft'
  const sum = (f: (l: PayrollLine) => number) => r.lines.reduce((s, l) => s + f(l), 0)
  const warnings = r.lines.flatMap((l) => l.result.warnings.map((w) => `${l.employee.name}: ${w}`))

  async function run(what: 'refresh' | 'post' | 'delete') {
    if (what === 'post' && !window.confirm(`Post this payroll? ${formatPeso(sum((l) => l.result.net))} net pay to ${r.lines.length} people goes on the books, and their payslips go out. It can’t be changed afterwards.`)) return
    if (what === 'delete' && !window.confirm('Delete this draft?')) return
    await act.mutateAsync(what)
    if (what === 'delete') await navigate({ to: '/w/$workspaceId/hr/payroll', params: { workspaceId } })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">{r.number ?? 'Draft payroll'}</h2>
            <RunStatusBadge status={r.status} />
          </div>
          <p className="text-muted-foreground text-sm">
            {r.kind === 'thirteenth' ? `13th month pay for ${r.periodEnd.slice(0, 4)}` : `${formatDate(r.periodStart)} to ${formatDate(r.periodEnd)}`} · pay day {formatDate(r.payDate)}
            {r.kind === 'regular' && (r.takesContributions ? ' · takes the month’s contributions' : ' · contributions come with the month-end payroll')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {draft && (
            <>
              <Button variant="ghost" onClick={() => void run('delete').catch(() => undefined)}>
                <Trash2 />
                Delete
              </Button>
              {r.kind === 'regular' && (
                <Button variant="outline" onClick={() => void run('refresh').catch(() => undefined)} disabled={act.isPending}>
                  <RefreshCw />
                  Read clock-ins again
                </Button>
              )}
              <Button onClick={() => void run('post').catch(() => undefined)} disabled={act.isPending}>
                <Send />
                Post
              </Button>
            </>
          )}
          {r.status === 'posted' && can('finance.post') && (
            <Button onClick={() => setPaying(true)}>
              <Banknote />
              Mark as paid
            </Button>
          )}
          {r.journalEntryId && can('finance.view') && (
            <Button variant="outline" asChild>
              <Link to="/w/$workspaceId/finance/journal/$id" params={{ workspaceId, id: r.journalEntryId }}>
                Journal entry
              </Link>
            </Button>
          )}
        </div>
      </div>
      {act.error && (
        <Alert variant="destructive">
          <AlertDescription>{act.error.message}</AlertDescription>
        </Alert>
      )}
      {warnings.map((w) => (
        <Alert key={w} variant="destructive">
          <AlertDescription>{w}</AlertDescription>
        </Alert>
      ))}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="gap-1 py-4">
          <CardHeader className="px-4">
            <p className="text-muted-foreground text-sm">Gross pay</p>
            <CardTitle className="text-xl tabular-nums">{formatPeso(r.gross)}</CardTitle>
          </CardHeader>
        </Card>
        <Card className="gap-1 py-4">
          <CardHeader className="px-4">
            <p className="text-muted-foreground text-sm">Net pay</p>
            <CardTitle className="text-xl tabular-nums">{formatPeso(r.net)}</CardTitle>
          </CardHeader>
        </Card>
        <Card className="gap-1 py-4">
          <CardHeader className="px-4">
            <p className="text-muted-foreground text-sm">Tax withheld</p>
            <CardTitle className="text-xl tabular-nums">{formatPeso(sum((l) => l.result.tax))}</CardTitle>
          </CardHeader>
        </Card>
        <Card className="gap-1 py-4">
          <CardHeader className="px-4">
            <p className="text-muted-foreground text-sm">Cost to the business</p>
            <CardTitle className="text-xl tabular-nums">{formatPeso(r.employerCost)}</CardTitle>
          </CardHeader>
        </Card>
      </div>
      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Employee</TableHead>
              <TableHead className="text-right">Gross</TableHead>
              <TableHead className="hidden text-right md:table-cell">SSS, PhilHealth, Pag-IBIG</TableHead>
              <TableHead className="hidden text-right md:table-cell">Tax</TableHead>
              <TableHead className="hidden text-right lg:table-cell">Other deductions</TableHead>
              <TableHead className="text-right">Net</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.lines.map((l) => (
              <TableRow key={l.id} className="cursor-pointer" onClick={() => setEditing(l)}>
                <TableCell>
                  <span className="font-medium">{l.employee.name}</span>
                  <span className="text-muted-foreground block text-xs">
                    {l.employee.position}
                    {l.edited && ' · edited'}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <Money value={l.result.gross} />
                </TableCell>
                <TableCell className="hidden text-right md:table-cell">
                  <Money value={contributions(l)} />
                </TableCell>
                <TableCell className="hidden text-right md:table-cell">
                  <Money value={l.result.tax} />
                </TableCell>
                <TableCell className="hidden text-right lg:table-cell">
                  <Money value={l.result.otherDeductions} />
                </TableCell>
                <TableCell className={cn('text-right font-medium', l.result.net < 0 && 'text-destructive')}>
                  <Money value={l.result.net} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell>{r.lines.length} people</TableCell>
              <TableCell className="text-right">
                <Money value={r.gross} />
              </TableCell>
              <TableCell className="hidden text-right md:table-cell">
                <Money value={sum(contributions)} />
              </TableCell>
              <TableCell className="hidden text-right md:table-cell">
                <Money value={sum((l) => l.result.tax)} />
              </TableCell>
              <TableCell className="hidden text-right lg:table-cell">
                <Money value={sum((l) => l.result.otherDeductions)} />
              </TableCell>
              <TableCell className="text-right">
                <Money value={r.net} />
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-3xl">{editing && <LineDialog run={r} line={editing} onDone={() => setEditing(null)} />}</DialogContent>
      </Dialog>
      <Dialog open={paying} onOpenChange={setPaying}>
        <DialogContent>{paying && <PayForm run={r} onDone={() => setPaying(false)} />}</DialogContent>
      </Dialog>
    </div>
  )
}

/** One person's pay: the breakdown, and (on a draft) the inputs to change. */
function LineDialog({ run, line, onDone }: { run: PayrollRun; line: PayrollLine; onDone: () => void }) {
  const workspaceId = useWorkspaceId()
  const draft = run.status === 'draft' && run.kind === 'regular'
  const [x, setX] = useState<PayInputs>(line.inputs)
  const [adj, setAdj] = useState(line.inputs.adjustments.map((a) => ({ ...a, amount: centavosToInput(a.amount) })))
  const [error, setError] = useState<string>()
  const save = useWorkspaceMutation((w, inputs: PayInputs) => api(`/w/${w}/payroll/runs/${run.id}/lines/${line.id}`, { method: 'PUT', body: { inputs } }))
  const num = (v: string) => (v.trim() === '' ? 0 : Number(v))
  const daily = line.payBasis === 'daily'
  async function submit() {
    setError(undefined)
    const adjustments = []
    for (const a of adj) {
      const amount = parsePeso(a.amount)
      if (!a.label.trim() || amount === null || amount <= 0) return setError('Each addition or deduction needs a description and an amount.')
      adjustments.push({ label: a.label, kind: a.kind, amount })
    }
    try {
      await save.mutateAsync({ ...x, adjustments })
      onDone()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const box = (id: string, label: string, value: number, onChange: (n: number) => void) => (
    <Field id={id} label={label}>
      <Input id={id} inputMode="decimal" className="text-right" defaultValue={value || ''} disabled={!draft} onChange={(e) => onChange(num(e.target.value))} />
    </Field>
  )
  return (
    <div className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{line.employee.name}</DialogTitle>
        <DialogDescription>
          {line.employee.position} · {daily ? 'daily' : 'monthly'} rate, {formatPeso(line.dailyRate)} a day
          {draft && !line.edited && run.kind === 'regular' && ' · from clock-ins'}
        </DialogDescription>
      </DialogHeader>
      <FormError message={error} />
      {draft && (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            {daily ? box('x-days', 'Days worked', x.daysWorked, (n) => setX({ ...x, daysWorked: n })) : box('x-absent', 'Days absent', x.absentDays, (n) => setX({ ...x, absentDays: n }))}
            {daily && box('x-paid', 'Paid days off', x.paidDays, (n) => setX({ ...x, paidDays: n }))}
            {box('x-late', 'Late / undertime (min)', x.lateMinutes, (n) => setX({ ...x, lateMinutes: n }))}
            {box('x-night', 'Night hours', x.nightHours, (n) => setX({ ...x, nightHours: n }))}
          </div>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day</TableHead>
                  <TableHead className="text-right">Hours worked</TableHead>
                  <TableHead className="text-right">Overtime hours</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {DAY_TYPES.map((d: DayType) => (
                  <TableRow key={d}>
                    <TableCell>{DAY_TYPE_LABELS[d]}</TableCell>
                    <TableCell className="text-right">
                      {d === 'regular' ? (
                        <span className="text-muted-foreground text-xs">in basic pay</span>
                      ) : (
                        <Input aria-label={`Hours worked, ${DAY_TYPE_LABELS[d]}`} inputMode="decimal" className="ml-auto w-24 text-right" defaultValue={x.dayHours[d] || ''} onChange={(e) => setX({ ...x, dayHours: { ...x.dayHours, [d]: num(e.target.value) } })} />
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Input aria-label={`Overtime, ${DAY_TYPE_LABELS[d]}`} inputMode="decimal" className="ml-auto w-24 text-right" defaultValue={x.overtime[d] || ''} onChange={(e) => setX({ ...x, overtime: { ...x.overtime, [d]: num(e.target.value) } })} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="grid gap-2">
            <p className="text-sm font-medium">Additions and deductions</p>
            {adj.map((a, i) => (
              <div key={i} className="grid grid-cols-12 gap-2">
                <Input aria-label="Description" className="col-span-5" placeholder="Rice allowance" value={a.label} onChange={(e) => setAdj(adj.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} />
                <NativeSelect aria-label="Kind" className="col-span-4" value={a.kind} onChange={(e) => setAdj(adj.map((y, j) => (j === i ? { ...y, kind: e.target.value as AdjustmentKind } : y)))}>
                  {ADJUSTMENT_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {ADJUSTMENT_KIND_LABELS[k]}
                    </option>
                  ))}
                </NativeSelect>
                <Input aria-label="Amount" className="col-span-2 text-right" inputMode="decimal" value={a.amount} onChange={(e) => setAdj(adj.map((y, j) => (j === i ? { ...y, amount: e.target.value } : y)))} />
                <Button variant="ghost" size="icon" className="col-span-1" aria-label="Remove" onClick={() => setAdj(adj.filter((_, j) => j !== i))}>
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" className="w-fit" onClick={() => setAdj([...adj, { label: '', kind: 'earning', amount: '' }])}>
              <Plus />
              Add
            </Button>
          </div>
        </>
      )}
      <PayBreakdown lines={line.result} />
      <DialogFooter>
        <Button variant="outline" asChild>
          <Link to="/w/$workspaceId/hr/payslips/$id" params={{ workspaceId, id: line.id }}>
            <Printer />
            Payslip
          </Link>
        </Button>
        {draft ? (
          <Button onClick={() => void submit()} disabled={save.isPending}>
            {save.isPending ? 'Working it out…' : 'Save and work it out'}
          </Button>
        ) : (
          <Button onClick={onDone}>Close</Button>
        )}
      </DialogFooter>
    </div>
  )
}

/** Earnings, deductions and the employer's share, as on a payslip. */
export function PayBreakdown({ lines: r }: { lines: PayrollLine['result'] }) {
  const list = (title: string, items: PayLine[], total?: number) => (
    <div className="grid content-start gap-1.5 text-sm">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{title}</p>
      {items.length === 0 && <p className="text-muted-foreground">None</p>}
      {items.map((l, i) => (
        <div key={i} className="flex justify-between gap-4">
          <span>
            {l.label}
            {l.detail && <span className="text-muted-foreground block text-xs">{l.detail}</span>}
          </span>
          <span className="tabular-nums">{formatPeso(l.amount)}</span>
        </div>
      ))}
      {total !== undefined && (
        <div className="flex justify-between gap-4 border-t pt-1.5 font-medium">
          <span>Total</span>
          <span className="tabular-nums">{formatPeso(total)}</span>
        </div>
      )}
    </div>
  )
  return (
    <div className="grid gap-6">
      <div className="grid gap-6 sm:grid-cols-2">
        {list('Earnings', r.earnings, r.gross)}
        {list('Deductions', r.deductions, r.gross - r.net)}
      </div>
      <div className="bg-muted flex items-center justify-between rounded-lg px-4 py-3">
        <span className="font-medium">Take-home pay</span>
        <span className="text-xl font-semibold tabular-nums">{formatPeso(r.net)}</span>
      </div>
      {r.employer.length > 0 && <div className="print:hidden">{list('Paid by the employer on top', r.employer)}</div>}
    </div>
  )
}

function PayForm({ run, onDone }: { run: PayrollRun; onDone: () => void }) {
  const workspaceId = useWorkspaceId()
  const accounts = useQuery(financeQueries.accounts(workspaceId))
  const cash = accounts.data?.filter((a) => a.active && a.type === 'asset' && (a.subtype === 'cash' || a.subtype === 'bank'))
  const [accountId, setAccountId] = useState('')
  const [date, setDate] = useState(run.payDate)
  const [error, setError] = useState<string>()
  const pay = useWorkspaceMutation((w, body: object) => api(`/w/${w}/payroll/runs/${run.id}/pay`, { method: 'POST', body }))
  const chosen = accountId || cash?.find((a) => a.subtype === 'bank')?.id || cash?.[0]?.id || ''
  async function submit() {
    setError(undefined)
    try {
      await pay.mutateAsync({ date, accountId: chosen })
      onDone()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Mark {run.number} as paid</DialogTitle>
        <DialogDescription>{formatPeso(run.net)} net pay went out. This clears Salaries Payable against the account it came from.</DialogDescription>
      </DialogHeader>
      <FormError message={error} />
      <Field id="p-date" label="Paid on">
        <Input id="p-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Field id="p-acct" label="From">
        <NativeSelect id="p-acct" value={chosen} onChange={(e) => setAccountId(e.target.value)}>
          {cash?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} · {a.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={pay.isPending}>
          Mark as paid
        </Button>
      </DialogFooter>
    </div>
  )
}

/* =============================================================================================
 * Payslip (HR's view and the employee's own)
 * =========================================================================================== */

export function PayslipPage({ id, mine }: { id: string; mine?: boolean }) {
  const workspaceId = useWorkspaceId()
  const q = useQuery(hrQueries.payslip(workspaceId, id, !!mine))
  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Loading />
  const p = q.data
  return (
    <div className="space-y-6">
      <div className="flex justify-end print:hidden">
        <Button variant="outline" onClick={() => window.print()}>
          <Printer />
          Print
        </Button>
      </div>
      <article className="bg-card mx-auto max-w-3xl space-y-6 rounded-xl border p-6 md:p-10 print:border-0 print:p-0">
        <header className="flex flex-wrap justify-between gap-6 border-b pb-6">
          <div>
            <p className="text-lg font-semibold">{p.employer.name}</p>
            <p className="text-muted-foreground text-sm">TIN {p.employer.tin}</p>
            <p className="text-muted-foreground max-w-xs text-sm">{p.employer.address}</p>
          </div>
          <div className="text-right">
            <p className="text-sm font-semibold tracking-widest uppercase">{p.run.kind === 'thirteenth' ? '13th month pay' : 'Payslip'}</p>
            <p className="font-semibold">{p.run.number ?? 'Draft'}</p>
            <p className="text-muted-foreground text-sm">
              {p.run.kind === 'thirteenth' ? p.run.periodEnd.slice(0, 4) : `${formatDate(p.run.periodStart)} – ${formatDate(p.run.periodEnd)}`}
            </p>
            <p className="text-muted-foreground text-sm">Paid {formatDate(p.run.payDate)}</p>
          </div>
        </header>
        <div className="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <p className="font-medium">{p.employee.name}</p>
            <p className="text-muted-foreground">
              {p.employee.employeeNo} · {p.employee.position}
            </p>
          </div>
          <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 sm:justify-self-end">
            <dt>TIN</dt>
            <dd>{p.employee.tin ?? '—'}</dd>
            <dt>SSS</dt>
            <dd>{p.employee.sssNo ?? '—'}</dd>
            <dt>PhilHealth</dt>
            <dd>{p.employee.philhealthNo ?? '—'}</dd>
            <dt>Pag-IBIG</dt>
            <dd>{p.employee.pagibigNo ?? '—'}</dd>
          </dl>
        </div>
        <PayBreakdown lines={p.result} />
        <p className="text-muted-foreground text-xs">Demo – not registered with the BIR. Keep this payslip; it shows what was withheld and remitted for you.</p>
      </article>
    </div>
  )
}

/* =============================================================================================
 * Government reports
 * =========================================================================================== */

export function PayrollReportsPage() {
  const workspace = useWorkspace()
  const [month, setMonth] = useState(today().slice(0, 7))
  const [year, setYear] = useState(Number(today().slice(0, 4)))
  const [employeeId, setEmployeeId] = useState('')
  const q = useQuery(hrQueries.monthly(workspace.id, month))
  const people = useQuery(hrQueries.employees(workspace.id))
  const f = useQuery(hrQueries.form2316(workspace.id, year, employeeId))

  const table = (title: string, form: string, idLabel: string, rows: RemittanceRow[], baseLabel: string, file: string) => (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div>
          <CardTitle>{title}</CardTitle>
          <p className="text-muted-foreground text-sm">{form}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!rows.length}
          onClick={() =>
            downloadCsv(
              `${file}-${month}.csv`,
              [idLabel, 'Name', baseLabel, 'Employee share', 'Employer share', ...(rows.some((r) => r.ec !== undefined) ? ['EC'] : [])],
              rows.map((r) => [r.idNumber, r.name, csvAmount(r.base), csvAmount(r.ee), csvAmount(r.er), ...(r.ec !== undefined ? [csvAmount(r.ec)] : [])]),
            )
          }
        >
          <Download />
          CSV
        </Button>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing for this month. Contributions are taken in the payroll that ends the month.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-0">{idLabel}</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">{baseLabel}</TableHead>
                <TableHead className="text-right">Employee</TableHead>
                <TableHead className="text-right">Employer</TableHead>
                {rows.some((r) => r.ec !== undefined) && <TableHead className="pr-0 text-right">EC</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.employeeId}>
                  <TableCell className="pl-0 tabular-nums">{r.idNumber ?? <span className="text-destructive">missing</span>}</TableCell>
                  <TableCell>{r.name}</TableCell>
                  <TableCell className="text-right">
                    <Money value={r.base} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={r.ee} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={r.er} />
                  </TableCell>
                  {r.ec !== undefined && (
                    <TableCell className="pr-0 text-right">
                      <Money value={r.ec} />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="pl-0" colSpan={3}>
                  Total to remit
                </TableCell>
                <TableCell className="text-right">
                  <Money value={rows.reduce((s, r) => s + r.ee, 0)} />
                </TableCell>
                <TableCell className="text-right">
                  <Money value={rows.reduce((s, r) => s + r.er, 0)} />
                </TableCell>
                {rows.some((r) => r.ec !== undefined) && (
                  <TableCell className="pr-0 text-right">
                    <Money value={rows.reduce((s, r) => s + (r.ec ?? 0), 0)} />
                  </TableCell>
                )}
              </TableRow>
            </TableFooter>
          </Table>
        )}
      </CardContent>
    </Card>
  )

  return (
    <div className="space-y-10">
      <section className="space-y-6">
        <PageHeader title="Monthly remittances" description="What to pay SSS, PhilHealth, Pag-IBIG and the BIR for a month, from posted payroll. Labelled as a demo: not registered with the BIR." />
        <div className="flex items-center gap-3">
          <Input aria-label="Month" type="month" className="w-48" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          <span className="text-muted-foreground text-sm">{formatMonth(month)}</span>
        </div>
        {q.error ? (
          <LoadError error={q.error} />
        ) : !q.data ? (
          <Loading />
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle>BIR Form 1601-C</CardTitle>
                <p className="text-muted-foreground text-sm">Monthly remittance of income tax withheld on compensation · {q.data.wtax.employees} employees paid this month</p>
              </CardHeader>
              <CardContent>
                <dl className="grid max-w-lg gap-1.5 text-sm">
                  {(
                    [
                      ['Total compensation', q.data.wtax.totalCompensation],
                      ['Less non-taxable: minimum wage earners', q.data.wtax.nonTaxableMwe],
                      ['Less non-taxable: 13th month and other benefits', q.data.wtax.nonTaxableThirteenth],
                      ['Less non-taxable: de minimis', q.data.wtax.nonTaxableDeMinimis],
                      ['Less: SSS, PhilHealth, Pag-IBIG (employee share)', q.data.wtax.nonTaxableContributions],
                      ['Taxable compensation', q.data.wtax.taxable],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label} className="flex justify-between gap-6">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="tabular-nums">{formatPeso(value)}</dd>
                    </div>
                  ))}
                  <div className="flex justify-between gap-6 border-t pt-1.5 font-semibold">
                    <dt>Tax withheld, to remit</dt>
                    <dd className="tabular-nums">{formatPeso(q.data.wtax.withheld)}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
            {table('SSS', 'R-3 contribution collection list', 'SSS number', q.data.sss, 'Salary credit', 'sss-r3')}
            {table('PhilHealth', 'RF-1 employer remittance report', 'PhilHealth number', q.data.philhealth, 'Basic salary', 'philhealth-rf1')}
            {table('Pag-IBIG', 'Membership contributions remittance', 'Pag-IBIG MID', q.data.pagibig, 'Salary base', 'pagibig-mcrf')}
          </>
        )}
      </section>

      <section className="space-y-6 print:break-before-page">
        <PageHeader title="BIR Form 2316" description="Certificate of compensation paid and tax withheld, for each employee for the year." />
        <div className="flex flex-wrap gap-3 print:hidden">
          <NativeSelect aria-label="Year" className="w-32" value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {[0, 1].map((d) => {
              const y = Number(today().slice(0, 4)) - d
              return (
                <option key={y} value={y}>
                  {y}
                </option>
              )
            })}
          </NativeSelect>
          <NativeSelect aria-label="Employee" className="w-64" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Choose an employee…</option>
            {people.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
          {f.data && (
            <Button variant="outline" onClick={() => window.print()}>
              <Printer />
              Print
            </Button>
          )}
        </div>
        {f.error && <LoadError error={f.error} />}
        {f.data && (
          <article className="bg-card max-w-2xl space-y-5 rounded-xl border p-6 print:border-0 print:p-0">
            <header className="flex flex-wrap justify-between gap-4 border-b pb-4">
              <div>
                <p className="text-sm font-semibold tracking-widest uppercase">BIR Form 2316</p>
                <p className="text-muted-foreground text-sm">For the year {f.data.year}</p>
              </div>
              <p className="text-muted-foreground text-xs">Demo – not registered with the BIR</p>
            </header>
            <div className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <p className="text-muted-foreground text-xs uppercase">Employee</p>
                <p className="font-medium">{f.data.employee.name}</p>
                <p className="text-muted-foreground">TIN {f.data.employee.tin ?? '—'}</p>
                {f.data.employee.minimumWageEarner && <p className="text-muted-foreground">Minimum wage earner</p>}
              </div>
              <div>
                <p className="text-muted-foreground text-xs uppercase">Employer</p>
                <p className="font-medium">{f.data.employer.name}</p>
                <p className="text-muted-foreground">TIN {f.data.employer.tin}</p>
              </div>
            </div>
            <dl className="grid gap-1.5 text-sm">
              {(
                [
                  ['Gross compensation', f.data.gross],
                  ['Non-taxable: minimum wage pay', f.data.nonTaxable.mwe],
                  ['Non-taxable: 13th month and other benefits', f.data.nonTaxable.thirteenth],
                  ['Non-taxable: de minimis', f.data.nonTaxable.deMinimis],
                  ['Non-taxable: SSS, PhilHealth, Pag-IBIG', f.data.nonTaxable.contributions],
                  ['Taxable compensation', f.data.taxable],
                  ['Tax due for the year', f.data.taxDue],
                  ['Tax withheld', f.data.withheld],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex justify-between gap-6">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="tabular-nums">{formatPeso(value)}</dd>
                </div>
              ))}
              <div className="flex justify-between gap-6 border-t pt-1.5 font-semibold">
                <dt>{f.data.difference > 0 ? 'Still to withhold' : f.data.difference < 0 ? 'Withheld too much: refund' : 'Settled'}</dt>
                <dd className="tabular-nums">{formatPeso(Math.abs(f.data.difference))}</dd>
              </div>
            </dl>
          </article>
        )}
      </section>
    </div>
  )
}
