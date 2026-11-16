import {
  templateByKey,
  BILLING_METHOD_LABELS,
  BILLING_METHODS,
  centavosToInput,
  formatPeso,
  parsePeso,
  PROJECT_STATUS_LABELS,
  PROJECT_STATUSES,
  TASK_STATUS_LABELS,
  type BillingMethod,
  type MyTask,
  type Project,
  type ProjectStatus,
  type ProjectTask,
  type TaskStatus,
} from '@erp/shared'
import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { CheckCircle2, Clock, FileText, MapPin, Package, Pencil, Plus, Receipt, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { FormError } from '@/components/form'
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
import { financeQueries, useWorkspaceMutation } from '@/features/finance/queries'
import { hrQueries } from '@/features/hr/queries'
import { formatQty, inventoryQueries } from '@/features/inventory/queries'
import { settingsQueries, useCan, useWorkspace, useWorkspaceId } from '@/features/workspaces/queries'
import { api } from '@/lib/api'
import { formatDate, today } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { addDays, daysFrom, projectQueries } from './queries'

/* =============================================================================================
 * Frame
 * =========================================================================================== */

const TABS = [
  { to: '/w/$workspaceId/projects', label: 'Overview', exact: true },
  { to: '/w/$workspaceId/projects/all', label: 'Projects' },
  { to: '/w/$workspaceId/projects/timesheets', label: 'Timesheets' },
] as const

export function ProjectsLayout() {
  const workspace = useWorkspace()
  const can = useCan()
  if (!workspace.modules.includes('projects')) {
    return <EmptyState title="Projects is turned off">An owner or admin can turn it on in Settings → Workspace → Modules.</EmptyState>
  }
  if (!can('projects.view')) {
    return <EmptyState title="Your role can’t see Projects">Your own tasks and hours are under My time & pay.</EmptyState>
  }
  return (
    <>
      <nav aria-label="Projects" className="-mx-4 mb-6 overflow-x-auto border-b px-4 md:mx-0 md:px-0 print:hidden">
        <div className="flex min-w-max gap-1">
          {TABS.map((t) => (
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

const STATUS_VARIANT: Record<ProjectStatus, 'outline' | 'secondary' | 'default' | 'success'> = { planning: 'outline', active: 'default', on_hold: 'secondary', completed: 'success', cancelled: 'secondary' }

function ProjectStatusBadge({ status, late }: { status: ProjectStatus; late?: boolean }) {
  return (
    <span className="inline-flex gap-1">
      <Badge variant={STATUS_VARIANT[status]}>{PROJECT_STATUS_LABELS[status]}</Badge>
      {late && <Badge className="bg-destructive text-white">Late</Badge>}
    </span>
  )
}

function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: 'bad' | 'good' }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className={cn('text-xl tabular-nums', tone === 'bad' && 'text-destructive', tone === 'good' && 'text-success')}>{value}</CardTitle>
        {note && <p className="text-muted-foreground text-xs">{note}</p>}
      </CardHeader>
    </Card>
  )
}

function Bar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn('bg-muted h-2 overflow-hidden rounded-full', className)} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn('h-full rounded-full', value > 100 ? 'bg-destructive' : 'bg-primary')} style={{ width: `${Math.min(value, 100)}%` }} />
    </div>
  )
}

/* =============================================================================================
 * Overview and list
 * =========================================================================================== */

export function ProjectsOverviewPage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const o = useQuery(projectQueries.overview(workspaceId))
  const list = useQuery(projectQueries.list(workspaceId, 'open'))
  if (o.error) return <LoadError error={o.error} />
  if (!o.data || !list.data) return <Loading />
  return (
    <div className="space-y-8">
      {can('projects.manage') && (
        <Button asChild>
          <Link to="/w/$workspaceId/projects/new" params={{ workspaceId }}>
            <Plus />
            New project
          </Link>
        </Button>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Active projects" value={String(o.data.active)} note={o.data.late ? `${o.data.late} past their end date` : undefined} />
        <Stat label="Contract value (open)" value={formatPeso(o.data.contractValue)} />
        <Stat label="Cost to date (open)" value={formatPeso(o.data.costToDate)} />
        <Stat label="Hours, last 7 days" value={formatQty(o.data.hoursThisWeek)} />
      </div>
      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Open projects</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5">
            {list.data.length === 0 && <p className="text-muted-foreground text-sm">None open.</p>}
            {list.data.map((p) => {
              const used = p.costBudget > 0 ? Math.round((p.costToDate / p.costBudget) * 100) : 0
              return (
                <div key={p.id} className="grid gap-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <Link to="/w/$workspaceId/projects/$id" params={{ workspaceId, id: p.id }} className="font-medium hover:underline">
                      {p.name}
                    </Link>
                    <ProjectStatusBadge status={p.status} late={p.late} />
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {p.number} · {p.customer?.name ?? 'Internal'} · until {formatDate(p.endDate)}
                  </p>
                  <div className="grid grid-cols-2 gap-4 text-xs">
                    <div className="grid gap-1">
                      <span className="text-muted-foreground">Done: {p.percentComplete}%</span>
                      <Bar value={p.percentComplete} />
                    </div>
                    <div className="grid gap-1">
                      <span className="text-muted-foreground">{p.costBudget > 0 ? `Budget used: ${used}%` : 'No budget'}</span>
                      <Bar value={used} />
                    </div>
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Due in the next two weeks</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {o.data.dueSoon.length === 0 && <p className="text-muted-foreground text-sm">Nothing due.</p>}
            {o.data.dueSoon.map((d, i) => (
              <div key={i} className="flex items-start justify-between gap-3 text-sm">
                <span>
                  {d.kind === 'milestone' ? '◆ ' : ''}
                  {d.name}
                  <Link to="/w/$workspaceId/projects/$id" params={{ workspaceId, id: d.project.id }} className="text-muted-foreground block text-xs hover:underline">
                    {d.project.number} · {d.project.name}
                  </Link>
                </span>
                <span className={cn('whitespace-nowrap', d.dueDate < today() && 'text-destructive')}>{formatDate(d.dueDate)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export function ProjectsPage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const [status, setStatus] = useState('open')
  const q = useQuery(projectQueries.list(workspaceId, status))
  return (
    <div>
      <PageHeader
        title="Projects"
        actions={
          can('projects.manage') && (
            <Button asChild>
              <Link to="/w/$workspaceId/projects/new" params={{ workspaceId }}>
                <Plus />
                New project
              </Link>
            </Button>
          )
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        {[
          ['open', 'Open'],
          ['completed', 'Completed'],
          ['cancelled', 'Cancelled'],
          ['all', 'All'],
        ].map(([v, label]) => (
          <Button key={v} size="sm" variant={status === v ? 'default' : 'outline'} onClick={() => setStatus(v!)}>
            {label}
          </Button>
        ))}
      </div>
      {q.error ? (
        <LoadError error={q.error} />
      ) : !q.data ? (
        <Loading />
      ) : q.data.length === 0 ? (
        <EmptyState title="No projects here" />
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Project</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Dates</TableHead>
                <TableHead className="text-right">Done</TableHead>
                <TableHead className="text-right">Cost / budget</TableHead>
                <TableHead className="pr-6">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="pl-6">
                    <Link to="/w/$workspaceId/projects/$id" params={{ workspaceId, id: p.id }} className="font-medium hover:underline">
                      {p.name}
                    </Link>
                    <span className="text-muted-foreground block text-xs">{p.number}</span>
                  </TableCell>
                  <TableCell>{p.customer?.name ?? <span className="text-muted-foreground">Internal</span>}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatDate(p.startDate)} – {formatDate(p.endDate)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{p.percentComplete}%</TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">
                    <Money value={p.costToDate} />
                    {p.costBudget > 0 && (
                      <span className="text-muted-foreground">
                        {' '}
                        / <Money value={p.costBudget} />
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="pr-6">
                    <ProjectStatusBadge status={p.status} late={p.late} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  )
}

/* =============================================================================================
 * Project form
 * =========================================================================================== */

export function ProjectFormPage({ id }: { id?: string }) {
  const workspaceId = useWorkspaceId()
  const workspace = useWorkspace()
  const navigate = useNavigate()
  const existing = useQuery({ ...projectQueries.one(workspaceId, id ?? ''), enabled: !!id })
  const customers = useQuery(financeQueries.contacts(workspaceId, 'customer'))
  const members = useQuery(settingsQueries.members(workspaceId))
  const [v, setV] = useState<Record<string, string> | null>(null)
  const [error, setError] = useState<string>()
  const save = useWorkspaceMutation((w, body: object) => (id ? api<{ project: Project }>(`/w/${w}/projects/${id}`, { method: 'PUT', body }) : api<{ project: Project }>(`/w/${w}/projects`, { method: 'POST', body })))
  if ((id && !existing.data) || !customers.data || !members.data) return <Loading />
  const e = existing.data
  const values = v ?? {
    name: e?.name ?? '',
    customerId: e?.customer?.id ?? '',
    managerId: e?.manager?.id ?? '',
    status: e?.status ?? 'planning',
    startDate: e?.startDate ?? today(),
    endDate: e?.endDate ?? addDays(today(), 30),
    billing: e?.billing ?? 'fixed',
    contractValue: e ? centavosToInput(e.contractValue) : '',
    hourlyRate: e ? centavosToInput(e.hourlyRate) : '',
    costBudget: e ? centavosToInput(e.costBudget) : '',
    retention: e ? String(e.retentionBp / 100) : String((templateByKey(workspace.template)?.retentionBp ?? 0) / 100),
    siteAddress: e?.siteAddress ?? '',
    description: e?.description ?? '',
  }
  const set = (k: string) => (ev: { target: { value: string } }) => setV({ ...values, [k]: ev.target.value })
  const money = (s: string) => (s.trim() === '' ? 0 : parsePeso(s))
  return (
    <div className="max-w-3xl">
      <PageHeader title={e ? `Edit ${e.number}` : 'New project'} />
      <form
        className="grid gap-5"
        onSubmit={(ev) => {
          ev.preventDefault()
          setError(undefined)
          const amounts = { contractValue: money(values.contractValue!), hourlyRate: money(values.hourlyRate!), costBudget: money(values.costBudget!) }
          if (Object.values(amounts).some((x) => x === null)) return setError('Enter amounts like 150,000.00.')
          save.mutate(
            {
              ...values,
              ...amounts,
              retention: undefined,
              retentionBp: values.billing === 'fixed' ? Math.round(Number(values.retention || 0) * 100) : 0,
              customerId: values.customerId || null,
              managerId: values.managerId || null,
            },
            { onSuccess: (r) => void navigate({ to: '/w/$workspaceId/projects/$id', params: { workspaceId, id: r.project.id } }), onError: (er) => setError(er.message) },
          )
        }}
      >
        <FormError message={error} />
        <div className="grid gap-2">
          <Label htmlFor="p-name">Name</Label>
          <Input id="p-name" value={values.name} onChange={set('name')} required placeholder="e.g. Kape Tayo Maginhawa: electrical fit-out" />
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="p-billing">Billing</Label>
            <NativeSelect id="p-billing" value={values.billing} onChange={set('billing')}>
              {BILLING_METHODS.map((b) => (
                <option key={b} value={b}>
                  {BILLING_METHOD_LABELS[b]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="p-customer">Customer</Label>
            <NativeSelect id="p-customer" value={values.customerId} onChange={set('customerId')}>
              <option value="">{values.billing === 'none' ? 'None (internal)' : 'Choose…'}</option>
              {customers.data.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          {values.billing === 'fixed' && (
            <div className="grid gap-2">
              <Label htmlFor="p-contract">Contract price (₱, before VAT)</Label>
              <Input id="p-contract" inputMode="decimal" value={values.contractValue} onChange={set('contractValue')} />
            </div>
          )}
          {values.billing === 'fixed' && (
            <div className="grid gap-2">
              <Label htmlFor="p-ret">Retention held by the customer (%)</Label>
              <Input id="p-ret" inputMode="decimal" value={values.retention} onChange={set('retention')} />
            </div>
          )}
          {values.billing === 'hourly' && (
            <div className="grid gap-2">
              <Label htmlFor="p-rate">Billed per hour (₱, before VAT)</Label>
              <Input id="p-rate" inputMode="decimal" value={values.hourlyRate} onChange={set('hourlyRate')} />
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="p-budget">Cost budget (₱)</Label>
            <Input id="p-budget" inputMode="decimal" value={values.costBudget} onChange={set('costBudget')} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="p-start">Start</Label>
            <Input id="p-start" type="date" value={values.startDate} onChange={set('startDate')} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="p-end">End</Label>
            <Input id="p-end" type="date" value={values.endDate} onChange={set('endDate')} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="p-manager">Project manager</Label>
            <NativeSelect id="p-manager" value={values.managerId} onChange={set('managerId')}>
              <option value="">{e ? 'Nobody' : 'Me'}</option>
              {members.data.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="p-status">Status</Label>
            <NativeSelect id="p-status" value={values.status} onChange={set('status')}>
              {PROJECT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PROJECT_STATUS_LABELS[s]}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="p-site">Site address</Label>
          <Input id="p-site" value={values.siteAddress} onChange={set('siteAddress')} placeholder="Where field work happens" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="p-desc">Scope</Label>
          <Textarea id="p-desc" value={values.description} onChange={set('description')} />
        </div>
        <div className="flex gap-2">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button type="button" variant="outline" onClick={() => history.back()}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  )
}

/* =============================================================================================
 * Gantt chart
 * =========================================================================================== */


/**
 * Tasks as bars across the days (progress shaded in), milestones as diamonds, and a line at today.
 * Scrolls sideways on a narrow screen; the names stay put.
 */
function Gantt({ project, onTask }: { project: Project; onTask?: (t: ProjectTask) => void }) {
  const dates = [project.startDate, project.endDate, ...project.tasks.flatMap((t) => [t.startDate, t.endDate]), ...project.milestones.map((m) => m.dueDate)]
  const from = addDays(dates.reduce((a, b) => (a < b ? a : b)), -2)
  const to = addDays(dates.reduce((a, b) => (a > b ? a : b)), 3)
  const days = daysFrom(from, to) + 1
  // fits a short project in the card; a long one scrolls, opening on today
  const DAY_PX = Math.max(9, Math.min(24, Math.floor(720 / days)))
  const width = days * DAY_PX
  const x = (d: string) => daysFrom(from, d) * DAY_PX
  const t0 = today()
  const weeks = Array.from({ length: Math.ceil(days / 7) }, (_, i) => addDays(from, i * 7))
  const byId = new Map(project.tasks.map((t) => [t.id, t]))
  const rows = [...project.tasks.map((t) => ({ kind: 'task' as const, t })), ...project.milestones.map((m) => ({ kind: 'milestone' as const, m }))].sort((a, b) => {
    const da = a.kind === 'task' ? a.t.startDate : a.m.dueDate
    const db = b.kind === 'task' ? b.t.startDate : b.m.dueDate
    return da < db ? -1 : da > db ? 1 : 0
  })
  if (!rows.length) return <p className="text-muted-foreground text-sm">Add tasks and milestones to see them on the chart.</p>
  const toToday = (el: HTMLDivElement | null) => {
    if (el && el.scrollLeft === 0 && t0 > from) el.scrollLeft = Math.max(0, x(t0) - el.clientWidth / 2)
  }
  return (
    <div className="grid grid-cols-[minmax(8rem,14rem)_minmax(0,1fr)] overflow-hidden rounded-md border text-sm">
      <div className="bg-muted/40 border-r">
        <div className="h-8 border-b" />
        {rows.map((r) => (
          <div key={r.kind === 'task' ? r.t.id : r.m.id} className="flex h-9 items-center truncate border-b px-3 last:border-b-0">
            {r.kind === 'task' ? (
              <button type="button" className="truncate text-left hover:underline" onClick={() => onTask?.(r.t)} title={r.t.name}>
                {r.t.fieldWork && <MapPin className="text-muted-foreground mr-1 inline size-3" />}
                {r.t.name}
              </button>
            ) : (
              <span className="truncate font-medium" title={r.m.name}>
                ◆ {r.m.name}
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="overflow-x-auto" ref={toToday}>
        <div className="relative" style={{ width }}>
          <div className="flex h-8 border-b">
            {weeks.map((w) => (
              <div key={w} className="text-muted-foreground shrink-0 overflow-hidden border-l px-1 pt-2 text-[11px] whitespace-nowrap first:border-l-0" style={{ width: 7 * DAY_PX }}>
                {formatDate(w).replace(/, \d{4}$/, '')}
              </div>
            ))}
          </div>
          {t0 >= from && t0 <= to && <div className="bg-destructive/70 absolute top-8 bottom-0 z-10 w-px" style={{ left: x(t0) + DAY_PX / 2 }} title="Today" />}
          {rows.map((r) =>
            r.kind === 'task' ? (
              <div key={r.t.id} className="relative h-9 border-b last:border-b-0">
                <div
                  className={cn('absolute top-2 h-5 overflow-hidden rounded', r.t.status === 'done' ? 'bg-success/30' : r.t.endDate < t0 ? 'bg-destructive/25' : 'bg-primary/20')}
                  style={{ left: x(r.t.startDate), width: (daysFrom(r.t.startDate, r.t.endDate) + 1) * DAY_PX }}
                  title={`${r.t.name}: ${formatDate(r.t.startDate)} – ${formatDate(r.t.endDate)}, ${r.t.progress}%${r.t.dependsOnId ? ` · after ${byId.get(r.t.dependsOnId)?.name}` : ''}`}
                >
                  <div className={cn('h-full', r.t.status === 'done' ? 'bg-success/70' : 'bg-primary/70')} style={{ width: `${r.t.progress}%` }} />
                </div>
                {r.t.dependsOnId && byId.has(r.t.dependsOnId) && (
                  <div className="border-muted-foreground/50 absolute top-[18px] h-px border-t border-dashed" style={{ left: x(byId.get(r.t.dependsOnId)!.endDate) + DAY_PX, width: Math.max(0, x(r.t.startDate) - x(byId.get(r.t.dependsOnId)!.endDate) - DAY_PX) }} />
                )}
              </div>
            ) : (
              <div key={r.m.id} className="relative h-9 border-b last:border-b-0">
                <div
                  className={cn('absolute top-2.5 size-4 rotate-45 rounded-[2px]', r.m.status === 'open' ? (r.m.dueDate < t0 ? 'bg-destructive' : 'bg-foreground') : 'bg-success')}
                  style={{ left: x(r.m.dueDate) + DAY_PX / 2 - 8 }}
                  title={`${r.m.name}: ${formatDate(r.m.dueDate)}`}
                />
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  )
}

/* =============================================================================================
 * Project page
 * =========================================================================================== */

function TaskDialog({ project, task, onClose }: { project: Project; task?: ProjectTask; onClose: () => void }) {
  const workspaceId = useWorkspaceId()
  const members = useQuery(settingsQueries.members(workspaceId))
  const [v, setV] = useState({
    name: task?.name ?? '',
    description: task?.description ?? '',
    milestoneId: task?.milestoneId ?? '',
    assigneeId: task?.assignee?.id ?? '',
    startDate: task?.startDate ?? today(),
    endDate: task?.endDate ?? addDays(today(), 3),
    estimatedHours: task ? String(task.estimatedHours) : '',
    dependsOnId: task?.dependsOnId ?? '',
    fieldWork: task?.fieldWork ?? false,
    location: task?.location ?? project.siteAddress ?? '',
  })
  const [error, setError] = useState<string>()
  const save = useWorkspaceMutation((w, body: object) => (task ? api(`/w/${w}/projects/${project.id}/tasks/${task.id}`, { method: 'PUT', body }) : api(`/w/${w}/projects/${project.id}/tasks`, { method: 'POST', body })))
  const remove = useWorkspaceMutation((w) => api(`/w/${w}/projects/${project.id}/tasks/${task!.id}`, { method: 'DELETE' }))
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{task ? 'Edit task' : 'New task'}</DialogTitle>
          <DialogDescription>Whoever it’s assigned to sees it under My tasks, and on the phone.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate(
              { ...v, estimatedHours: Number(v.estimatedHours || 0), milestoneId: v.milestoneId || null, assigneeId: v.assigneeId || null, dependsOnId: v.dependsOnId || null },
              { onSuccess: onClose, onError: (er) => setError(er.message) },
            )
          }}
        >
          <FormError message={error} />
          <div className="grid gap-2">
            <Label htmlFor="t-name">Task</Label>
            <Input id="t-name" value={v.name} onChange={set('name')} required />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="t-start">Start</Label>
              <Input id="t-start" type="date" value={v.startDate} onChange={set('startDate')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="t-end">End</Label>
              <Input id="t-end" type="date" value={v.endDate} onChange={set('endDate')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="t-who">Assigned to</Label>
              <NativeSelect id="t-who" value={v.assigneeId} onChange={set('assigneeId')}>
                <option value="">Nobody yet</option>
                {members.data?.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="t-hours">Estimated hours</Label>
              <Input id="t-hours" inputMode="decimal" value={v.estimatedHours} onChange={set('estimatedHours')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="t-after">Starts after</Label>
              <NativeSelect id="t-after" value={v.dependsOnId} onChange={set('dependsOnId')}>
                <option value="">Nothing</option>
                {project.tasks
                  .filter((t) => t.id !== task?.id)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="t-ms">Milestone</Label>
              <NativeSelect id="t-ms" value={v.milestoneId} onChange={set('milestoneId')}>
                <option value="">None</option>
                {project.milestones.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="t-field" checked={v.fieldWork} onCheckedChange={(c) => setV({ ...v, fieldWork: c === true })} />
            <Label htmlFor="t-field" className="font-normal">
              Field work: done on site, from the phone
            </Label>
          </div>
          {v.fieldWork && (
            <div className="grid gap-2">
              <Label htmlFor="t-loc">Where</Label>
              <Input id="t-loc" value={v.location} onChange={set('location')} />
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="t-desc">Details</Label>
            <Textarea id="t-desc" value={v.description} onChange={set('description')} />
          </div>
          <DialogFooter className="sm:justify-between">
            {task ? (
              <Button type="button" variant="ghost" onClick={() => confirm('Remove this task? Hours logged to it stay on the project.') && remove.mutate(undefined, { onSuccess: onClose })}>
                <Trash2 />
                Remove
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={save.isPending}>
                Save
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function MilestoneDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [name, setName] = useState('')
  const [dueDate, setDueDate] = useState(project.endDate)
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string>()
  const save = useWorkspaceMutation((w, body: object) => api(`/w/${w}/projects/${project.id}/milestones`, { method: 'POST', body }))
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New milestone</DialogTitle>
          {project.billing === 'fixed' && <DialogDescription>Reaching it bills its amount. The milestones of a fixed-price project usually add up to the contract price.</DialogDescription>}
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            const a = amount.trim() === '' ? 0 : parsePeso(amount)
            if (a === null) return setError('Enter the amount, like 150,000.00.')
            save.mutate({ name, dueDate, amount: a }, { onSuccess: onClose, onError: (er) => setError(er.message) })
          }}
        >
          <FormError message={error} />
          <div className="grid gap-2">
            <Label htmlFor="m-name">Milestone</Label>
            <Input id="m-name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Rough-in done" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="m-due">Due</Label>
              <Input id="m-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
            {project.billing === 'fixed' && (
              <div className="grid gap-2">
                <Label htmlFor="m-amount">Bills (₱, before VAT)</Label>
                <Input id="m-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function MaterialsDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const workspaceId = useWorkspaceId()
  const itemsQ = useQuery(inventoryQueries.items(workspaceId))
  const warehouses = useQuery(inventoryQueries.warehouses(workspaceId))
  const [date, setDate] = useState(today())
  const [warehouseId, setWarehouseId] = useState('')
  const [lines, setLines] = useState([{ itemId: '', quantity: '' }])
  const [error, setError] = useState<string>()
  const save = useWorkspaceMutation((w, body: object) => api(`/w/${w}/projects/${project.id}/materials`, { method: 'POST', body }))
  const stock = itemsQ.data?.filter((i) => i.kind === 'stock' && i.active && i.onHand > 0) ?? []
  const wh = warehouseId || warehouses.data?.[0]?.id || ''
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Take materials for {project.number}</DialogTitle>
          <DialogDescription>They leave stock at average cost and count as the project’s cost (Direct Project Costs).</DialogDescription>
        </DialogHeader>
        <FormError message={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="mat-date">Date</Label>
            <Input id="mat-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mat-wh">From</Label>
            <NativeSelect id="mat-wh" value={wh} onChange={(e) => setWarehouseId(e.target.value)}>
              {warehouses.data?.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1fr_7rem] gap-2">
            <NativeSelect aria-label={`Item ${i + 1}`} value={l.itemId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, itemId: e.target.value } : x)))}>
              <option value="">Choose…</option>
              {stock.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({formatQty(s.onHand)} {s.unit.code})
                </option>
              ))}
            </NativeSelect>
            <Input aria-label={`Quantity ${i + 1}`} inputMode="decimal" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setLines([...lines, { itemId: '', quantity: '' }])}>
          <Plus />
          Another item
        </Button>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={save.isPending}
            onClick={() =>
              save.mutate(
                { date, warehouseId: wh, lines: lines.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity) })) },
                { onSuccess: onClose, onError: (er) => setError(er.message) },
              )
            }
          >
            Take from stock
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Logging hours: your own, or (for project managers who can see HR) anyone's. */
export function LogTimeDialog({ projectId, taskId, onClose }: { projectId?: string; taskId?: string; onClose: () => void }) {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const mine = useQuery(projectQueries.myTimesheets(workspaceId))
  const anyone = can('projects.manage') && can('hr.view')
  const employees = useQuery({ ...hrQueries.employees(workspaceId), enabled: anyone })
  const [v, setV] = useState({ projectId: projectId ?? '', taskId: taskId ?? '', employeeId: '', date: today(), hours: '', billable: true, note: '' })
  const [error, setError] = useState<string>()
  const save = useWorkspaceMutation((w, body: object) => api(`/w/${w}/timesheets`, { method: 'POST', body }))
  if (!mine.data) return null
  const project = mine.data.projects.find((p) => p.id === v.projectId)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log time</DialogTitle>
          <DialogDescription>{mine.data.employee ? `As ${mine.data.employee.name}, unless you choose someone else.` : 'You aren’t on the employee list, so choose who did the work.'}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate({ ...v, hours: Number(v.hours), taskId: v.taskId || null, employeeId: v.employeeId || null }, { onSuccess: onClose, onError: (er) => setError(er.message) })
          }}
        >
          <FormError message={error} />
          <div className="grid gap-2">
            <Label htmlFor="ts-project">Project</Label>
            <NativeSelect id="ts-project" value={v.projectId} onChange={(e) => setV({ ...v, projectId: e.target.value, taskId: '' })} required>
              <option value="">Choose…</option>
              {mine.data.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number} · {p.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          {project && project.tasks.length > 0 && (
            <div className="grid gap-2">
              <Label htmlFor="ts-task">Task</Label>
              <NativeSelect id="ts-task" value={v.taskId} onChange={(e) => setV({ ...v, taskId: e.target.value })}>
                <option value="">General</option>
                {project.tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
          {anyone && (
            <div className="grid gap-2">
              <Label htmlFor="ts-emp">Who</Label>
              <NativeSelect id="ts-emp" value={v.employeeId} onChange={(e) => setV({ ...v, employeeId: e.target.value })}>
                <option value="">{mine.data.employee?.name ?? 'Choose…'}</option>
                {employees.data
                  ?.filter((x) => x.active && x.id !== mine.data.employee?.id)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
              </NativeSelect>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="ts-date">Date</Label>
              <Input id="ts-date" type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ts-hours">Hours</Label>
              <Input id="ts-hours" inputMode="decimal" value={v.hours} onChange={(e) => setV({ ...v, hours: e.target.value })} required />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ts-note">What was done</Label>
            <Input id="ts-note" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="ts-bill" checked={v.billable} onCheckedChange={(c) => setV({ ...v, billable: c === true })} />
            <Label htmlFor="ts-bill" className="font-normal">
              Billable (time-and-materials projects)
            </Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              Log
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function TimesheetTable({ projectId, showBilling = true }: { projectId?: string; showBilling?: boolean }) {
  const workspaceId = useWorkspaceId()
  const q = useQuery(projectQueries.timesheets(workspaceId, projectId))
  const remove = useWorkspaceMutation((w, id: string) => api(`/w/${w}/timesheets/${id}`, { method: 'DELETE' }))
  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Loading />
  if (!q.data.length) return <p className="text-muted-foreground px-6 text-sm">No time logged yet.</p>
  const showCost = q.data.some((t) => t.cost !== null)
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-6">Date</TableHead>
          {!projectId && <TableHead>Project</TableHead>}
          <TableHead>Who</TableHead>
          <TableHead>Task</TableHead>
          <TableHead className="text-right">Hours</TableHead>
          {showCost && <TableHead className="text-right">Cost</TableHead>}
          <TableHead className="pr-6" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {q.data.map((t) => (
          <TableRow key={t.id}>
            <TableCell className="pl-6 whitespace-nowrap">{formatDate(t.date)}</TableCell>
            {!projectId && (
              <TableCell>
                <Link to="/w/$workspaceId/projects/$id" params={{ workspaceId, id: t.project.id }} className="hover:underline">
                  {t.project.number}
                </Link>
              </TableCell>
            )}
            <TableCell>{t.employee.name}</TableCell>
            <TableCell>
              {t.task?.name ?? <span className="text-muted-foreground">General</span>}
              {t.note && <span className="text-muted-foreground block text-xs">{t.note}</span>}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatQty(t.hours)}
              {showBilling && !t.billable && <span className="text-muted-foreground block text-xs">not billed</span>}
            </TableCell>
            {showCost && <TableCell className="text-right">{t.cost !== null ? <Money value={t.cost} /> : '—'}</TableCell>}
            <TableCell className="pr-6 text-right">
              {t.invoice ? (
                <Link to="/w/$workspaceId/finance/invoices/$id" params={{ workspaceId, id: t.invoice.id }} className="text-muted-foreground text-xs hover:underline">
                  {t.invoice.number ?? 'Draft invoice'}
                </Link>
              ) : (
                <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => confirm('Remove these hours?') && remove.mutate(t.id)}>
                  <Trash2 />
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

const TASK_VARIANT: Record<TaskStatus, 'outline' | 'default' | 'success'> = { todo: 'outline', in_progress: 'default', done: 'success' }

export function ProjectPage({ id }: { id: string }) {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const navigate = useNavigate()
  const q = useQuery(projectQueries.one(workspaceId, id))
  const [dialog, setDialog] = useState<null | 'task' | 'milestone' | 'materials' | 'time'>(null)
  const [editing, setEditing] = useState<ProjectTask | undefined>()
  const [error, setError] = useState<string>()
  const progress = useWorkspaceMutation((w, { taskId, status }: { taskId: string; status: TaskStatus }) => api(`/w/${w}/projects/${id}/tasks/${taskId}/progress`, { method: 'POST', body: { status } }))
  const milestoneDone = useWorkspaceMutation((w, { mid, done }: { mid: string; done: boolean }) => api(`/w/${w}/projects/${id}/milestones/${mid}/done`, { method: 'POST', body: { done } }))
  const bill = useWorkspaceMutation((w, path: string) => api<{ invoiceId: string }>(`/w/${w}/projects/${id}/${path}`, { method: 'POST', body: {} }))
  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Loading />
  const p = q.data
  const manage = can('projects.manage')
  const c = p.costing
  const toInvoice = (r: { invoiceId: string }) => void navigate({ to: '/w/$workspaceId/finance/invoices/$id', params: { workspaceId, id: r.invoiceId } })
  const onBill = (path: string) => {
    setError(undefined)
    bill.mutate(path, { onSuccess: toInvoice, onError: (e) => setError(e.message) })
  }
  return (
    <div className="space-y-6">
      <PageHeader
        title={p.name}
        description={
          <>
            {p.number} · {p.billing === 'none' ? 'Internal, not billed' : `${p.customer?.name} · ${BILLING_METHOD_LABELS[p.billing as BillingMethod]}`} · {formatDate(p.startDate)} – {formatDate(p.endDate)}
            {p.manager && ` · run by ${p.manager.name}`}
          </>
        }
        actions={
          <>
            <Button variant="outline" onClick={() => setDialog('time')}>
              <Clock />
              Log time
            </Button>
            {manage && (
              <>
                <Button variant="outline" onClick={() => setDialog('materials')}>
                  <Package />
                  Take materials
                </Button>
                {can('finance.edit') && (
                  <Button variant="outline" asChild>
                    <a href={`/w/${workspaceId}/finance/bills/new?projectId=${id}`}>
                      <FileText />
                      Enter a bill
                    </a>
                  </Button>
                )}
                {p.billing === 'hourly' && can('finance.edit') && (
                  <Button onClick={() => onBill('invoice-hours')} disabled={bill.isPending || c.unbilledHours === 0}>
                    <Receipt />
                    Bill {formatQty(c.unbilledHours)} h
                  </Button>
                )}
                <Button variant="ghost" asChild aria-label="Edit project">
                  <Link to="/w/$workspaceId/projects/$id/edit" params={{ workspaceId, id }}>
                    <Pencil />
                  </Link>
                </Button>
              </>
            )}
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <ProjectStatusBadge status={p.status} late={p.late} />
        {p.siteAddress && (
          <span className="text-muted-foreground inline-flex items-center gap-1 text-sm">
            <MapPin className="size-3.5" />
            {p.siteAddress}
          </span>
        )}
      </div>
      <FormError message={error} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Done" value={`${p.percentComplete}%`} note={`${formatQty(c.hours)} hours logged`} />
        <Stat
          label="Cost to date"
          value={formatPeso(c.totalCost)}
          note={p.costBudget > 0 ? `${c.budgetUsed}% of the ${formatPeso(p.costBudget)} budget${c.forecastCost !== null ? `; heading for ${formatPeso(c.forecastCost)}` : ''}` : undefined}
          tone={c.budgetUsed > 100 || (c.forecastCost !== null && p.costBudget > 0 && c.forecastCost > p.costBudget) ? 'bad' : undefined}
        />
        <Stat
          label={p.billing === 'none' ? 'Contractors and materials' : 'Invoiced'}
          value={formatPeso(p.billing === 'none' ? c.bills + c.materials : c.revenue)}
          note={p.billing === 'fixed' ? `of ${formatPeso(p.contractValue)}${c.draftRevenue ? `; ${formatPeso(c.draftRevenue)} on drafts` : ''}` : p.billing === 'hourly' ? `${formatQty(c.unbilledHours)} h not billed yet` : `Labour ${formatPeso(c.labour)} on top`}
        />
        {p.billing === 'none' ? (
          <Stat label="Budget left" value={p.costBudget > 0 ? formatPeso(p.costBudget - c.totalCost) : '—'} tone={p.costBudget > 0 && c.totalCost > p.costBudget ? 'bad' : undefined} note={p.costBudget > 0 ? undefined : 'No budget set'} />
        ) : (
          <Stat label="Profit so far" value={formatPeso(c.profit)} tone={c.profit < 0 ? 'bad' : c.profit > 0 ? 'good' : undefined} note="Invoiced, less cost to date" />
        )}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle>Schedule</CardTitle>
            <CardDescription>Bars are tasks (shaded as far as they’ve got), diamonds are milestones; the red line is today.</CardDescription>
          </div>
          {manage && (
            <Button
              size="sm"
              onClick={() => {
                setEditing(undefined)
                setDialog('task')
              }}
            >
              <Plus />
              Task
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <Gantt
            project={p}
            onTask={
              manage
                ? (t) => {
                    setEditing(t)
                    setDialog('task')
                  }
                : undefined
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tasks</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {p.tasks.length === 0 ? (
            <p className="text-muted-foreground px-6 text-sm">No tasks yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Task</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>Dates</TableHead>
                  <TableHead className="text-right">Hours</TableHead>
                  <TableHead className="pr-6">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.tasks.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="pl-6">
                      {t.name}
                      {t.fieldWork && (
                        <span className="text-muted-foreground block text-xs">
                          <MapPin className="mr-0.5 inline size-3" />
                          {t.location ?? 'On site'}
                          {t.doneAt?.latitude != null && ' · marked done on site'}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{t.assignee?.name ?? <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell className={cn('whitespace-nowrap', t.status !== 'done' && t.endDate < today() && 'text-destructive')}>
                      {formatDate(t.startDate)} – {formatDate(t.endDate)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatQty(t.loggedHours)}
                      {t.estimatedHours > 0 && <span className="text-muted-foreground"> / {formatQty(t.estimatedHours)}</span>}
                    </TableCell>
                    <TableCell className="pr-6">
                      {manage ? (
                        <NativeSelect aria-label={`Status of ${t.name}`} className="w-44" value={t.status} onChange={(e) => progress.mutate({ taskId: t.id, status: e.target.value as TaskStatus })}>
                          {(['todo', 'in_progress', 'done'] as const).map((s) => (
                            <option key={s} value={s}>
                              {TASK_STATUS_LABELS[s]}
                              {s === 'in_progress' && t.status === 'in_progress' ? ` · ${t.progress}%` : ''}
                            </option>
                          ))}
                        </NativeSelect>
                      ) : (
                        <Badge variant={TASK_VARIANT[t.status]}>{TASK_STATUS_LABELS[t.status]}</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader className="flex flex-row items-start justify-between gap-3">
            <div className="space-y-1.5">
              <CardTitle>Milestones</CardTitle>
              {p.billing === 'fixed' && <CardDescription>Bill each one when it’s reached.</CardDescription>}
            </div>
            {manage && (
              <Button size="sm" variant="outline" onClick={() => setDialog('milestone')}>
                <Plus />
                Milestone
              </Button>
            )}
          </CardHeader>
          <CardContent className="grid gap-3">
            {p.milestones.length === 0 && <p className="text-muted-foreground text-sm">None yet.</p>}
            {p.retentionBp > 0 && (
              <div className="bg-muted/40 flex flex-wrap items-center justify-between gap-2 rounded-md p-3 text-sm">
                <span>
                  {p.retentionBp / 100}% retention held: <strong>{formatPeso(p.retention.held)}</strong>
                  <span className="text-muted-foreground block text-xs">Each milestone is billed less this; it’s released at turnover.</span>
                </span>
                {p.retention.invoice ? (
                  <Link to="/w/$workspaceId/finance/invoices/$id" params={{ workspaceId, id: p.retention.invoice.id }} className="text-muted-foreground text-xs hover:underline">
                    Released on {p.retention.invoice.number ?? 'a draft invoice'}
                  </Link>
                ) : (
                  manage &&
                  can('finance.edit') &&
                  p.retention.held > 0 &&
                  (p.status === 'completed' || p.milestones.every((m) => m.status === 'invoiced')) && (
                    <Button size="sm" variant="outline" disabled={bill.isPending} onClick={() => onBill('invoice-retention')}>
                      Bill the retention
                    </Button>
                  )
                )}
              </div>
            )}
            {p.milestones.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2">
                  {m.status === 'open' ? <span className="border-muted-foreground size-4 rounded-full border" /> : <CheckCircle2 className="text-success size-4" />}
                  <span>
                    {m.name}
                    <span className="text-muted-foreground block text-xs">
                      {formatDate(m.dueDate)}
                      {m.amount > 0 && ` · ${formatPeso(m.amount)}`}
                    </span>
                  </span>
                </span>
                <span className="flex gap-1">
                  {m.invoice ? (
                    <Link to="/w/$workspaceId/finance/invoices/$id" params={{ workspaceId, id: m.invoice.id }} className="text-muted-foreground text-xs hover:underline">
                      {m.invoice.number ?? 'Draft invoice'}
                    </Link>
                  ) : (
                    manage && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => milestoneDone.mutate({ mid: m.id, done: m.status === 'open' })}>
                          {m.status === 'open' ? 'Reached' : 'Reopen'}
                        </Button>
                        {p.billing === 'fixed' && m.amount > 0 && can('finance.edit') && (
                          <Button size="sm" variant="outline" disabled={bill.isPending} onClick={() => onBill(`milestones/${m.id}/invoice`)}>
                            Bill it
                          </Button>
                        )}
                      </>
                    )
                  )}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Job cost</CardTitle>
            <CardDescription>Before VAT. Labour is hours × each person’s daily rate ÷ 8.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {(
              [
                ['Labour', c.labour],
                ['Materials from stock', c.materials],
                ['Bills from suppliers', c.bills],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex justify-between">
                <span>{label}</span>
                <Money value={value} />
              </div>
            ))}
            <div className="flex justify-between border-t pt-2 font-medium">
              <span>Total cost</span>
              <Money value={c.totalCost} />
            </div>
            {p.costBudget > 0 && <Bar value={c.budgetUsed} className="mt-1" />}
            {p.costEntries.length > 0 && (
              <ul className="text-muted-foreground mt-3 grid gap-1 text-xs">
                {p.costEntries.slice(0, 8).map((e) => (
                  <li key={`${e.kind}-${e.id}`} className="flex min-w-0 justify-between gap-2">
                    <span className="min-w-0 truncate" title={e.description}>
                      {formatDate(e.date)} · {e.reference ? `${e.reference}: ` : ''}
                      {e.description}
                    </span>
                    <Money value={e.amount} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Time</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <TimesheetTable projectId={id} showBilling={p.billing === 'hourly'} />
        </CardContent>
      </Card>
      {p.description && <p className="text-sm whitespace-pre-wrap">{p.description}</p>}

      {dialog === 'task' && <TaskDialog project={p} task={editing} onClose={() => setDialog(null)} />}
      {dialog === 'milestone' && <MilestoneDialog project={p} onClose={() => setDialog(null)} />}
      {dialog === 'materials' && <MaterialsDialog project={p} onClose={() => setDialog(null)} />}
      {dialog === 'time' && <LogTimeDialog projectId={id} onClose={() => setDialog(null)} />}
    </div>
  )
}

/* =============================================================================================
 * Timesheets, and the member's own work
 * =========================================================================================== */

export function TimesheetsPage() {
  const [logging, setLogging] = useState(false)
  return (
    <div>
      <PageHeader
        title="Timesheets"
        description="Hours on every project, newest first."
        actions={
          <Button onClick={() => setLogging(true)}>
            <Clock />
            Log time
          </Button>
        }
      />
      <Card className="py-0">
        <TimesheetTable />
      </Card>
      {logging && <LogTimeDialog onClose={() => setLogging(false)} />}
    </div>
  )
}

/** On My time & pay: the tasks assigned to me, and logging my hours. */
export function MyWork() {
  const workspaceId = useWorkspaceId()
  const q = useQuery(projectQueries.myTasks(workspaceId))
  const [logging, setLogging] = useState<{ projectId: string; taskId: string } | null | 'any'>(null)
  const update = useWorkspaceMutation((w, { task, status }: { task: MyTask; status: TaskStatus }) => api(`/w/${w}/me/tasks/${task.id}/progress`, { method: 'POST', body: { status } }))
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>My tasks</CardTitle>
          <CardDescription>Assigned to you on projects. Field work shows on the phone too.</CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => setLogging('any')}>
          <Clock />
          Log time
        </Button>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!q.data ? (
          <Loading />
        ) : q.data.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing assigned to you.</p>
        ) : (
          q.data.map((t) => (
            <div key={t.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
              <div className="min-w-0">
                <p className="font-medium">{t.name}</p>
                <p className="text-muted-foreground text-xs">
                  {t.project.number} · {t.project.name} · due {formatDate(t.endDate)}
                  {t.fieldWork && ` · ${t.location ?? t.project.siteAddress ?? 'on site'}`}
                </p>
              </div>
              <div className="flex gap-2">
                <Badge variant={TASK_VARIANT[t.status]}>{TASK_STATUS_LABELS[t.status]}</Badge>
                {t.status !== 'done' && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setLogging({ projectId: t.project.id, taskId: t.id })}>
                      Hours
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => update.mutate({ task: t, status: t.status === 'todo' ? 'in_progress' : 'done' })}>
                      {t.status === 'todo' ? 'Start' : 'Done'}
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </CardContent>
      {logging && <LogTimeDialog projectId={logging === 'any' ? undefined : logging.projectId} taskId={logging === 'any' ? undefined : logging.taskId} onClose={() => setLogging(null)} />}
    </Card>
  )
}
