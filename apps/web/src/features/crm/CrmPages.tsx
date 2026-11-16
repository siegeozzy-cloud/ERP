import {
  type PriceList,
  ACTIVITY_KIND_LABELS,
  ACTIVITY_KINDS,
  centavosToInput,
  formatPeso,
  LEAD_SOURCE_LABELS,
  LEAD_SOURCES,
  LEAD_STAGE_LABELS,
  LEAD_STAGES,
  leadName,
  OPEN_LEAD_STAGES,
  parsePeso,
  type Activity,
  type ActivityKind,
  type CustomerSummary,
  type Lead,
  type LeadSource,
  type LeadStage,
} from '@erp/shared'
import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { CalendarClock, FilePlus2, Mail, MessageSquare, Pencil, Phone, Plus, Search, ShoppingBag, Trash2, UserPlus, Users } from 'lucide-react'
import { useState, type DragEvent } from 'react'
import { Field, FormError } from '@/components/form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { DocumentStatusBadge, EmptyState, LoadError, Loading, Money, PageHeader } from '@/features/finance/components'
import { useWorkspaceMutation } from '@/features/finance/queries'
import { settingsQueries, useCan, useWorkspace, useWorkspaceId } from '@/features/workspaces/queries'
import { api, ApiError } from '@/lib/api'
import { formatDate, today } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { formatQty } from '@/features/inventory/queries'
import { crmQueries } from './queries'
import { OrderStatusBadge, QuoteStatusBadge } from './SalesPages'

/* =============================================================================================
 * Frame
 * =========================================================================================== */

const TABS = [
  { to: '/w/$workspaceId/crm', label: 'Overview', exact: true },
  { to: '/w/$workspaceId/crm/pipeline', label: 'Pipeline' },
  { to: '/w/$workspaceId/crm/customers', label: 'Customers' },
  { to: '/w/$workspaceId/crm/quotes', label: 'Quotes' },
  { to: '/w/$workspaceId/crm/orders', label: 'Sales orders' },
  { to: '/w/$workspaceId/crm/deliveries', label: 'Deliveries' },
  { to: '/w/$workspaceId/crm/price-lists', label: 'Price lists' },
] as const

export function CrmLayout() {
  const workspace = useWorkspace()
  const can = useCan()
  if (!workspace.modules.includes('crm')) {
    return <EmptyState title="Sales & CRM is turned off">An owner or admin can turn it on in Settings → Workspace → Modules.</EmptyState>
  }
  if (!can('crm.view')) {
    return <EmptyState title="Your role can’t see Sales & CRM">You’re here as {workspace.role.name}. An owner or admin can change that.</EmptyState>
  }
  return (
    <>
      <nav aria-label="Sales and CRM" className="-mx-4 mb-6 overflow-x-auto border-b px-4 md:mx-0 md:px-0 print:hidden">
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

/* =============================================================================================
 * Overview
 * =========================================================================================== */

function Stat({ label, value, note, to }: { label: string; value: string; note?: string; to?: string }) {
  const workspaceId = useWorkspaceId()
  const card = (
    <Card className={cn('h-full gap-1 py-4', to && 'hover:border-foreground/20 transition-colors')}>
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-xl tabular-nums">{value}</CardTitle>
        {note && <p className="text-muted-foreground text-xs">{note}</p>}
      </CardHeader>
    </Card>
  )
  return to ? (
    <Link to={to} params={{ workspaceId }} className="focus-visible:ring-ring/50 rounded-xl outline-none focus-visible:ring-[3px]">
      {card}
    </Link>
  ) : (
    card
  )
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function CrmOverviewPage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const q = useQuery(crmQueries.overview(workspaceId))
  const [adding, setAdding] = useState(false)
  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Loading />
  const o = q.data
  const pipelineTotal = o.pipeline.reduce((s, p) => s + p.value, 0)
  const top = Math.max(1, ...o.pipeline.map((p) => p.value))
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap gap-2">
        {can('crm.manage') && (
          <>
            <Button onClick={() => setAdding(true)}>
              <Plus />
              New lead
            </Button>
            <Button variant="outline" asChild>
              <Link to="/w/$workspaceId/crm/quotes/new" params={{ workspaceId }}>
                <FilePlus2 />
                New quote
              </Link>
            </Button>
          </>
        )}
        {can('sales.manage') && (
          <Button variant="outline" asChild>
            <Link to="/w/$workspaceId/crm/orders/new" params={{ workspaceId }}>
              <ShoppingBag />
              New sales order
            </Link>
          </Button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Sales this month" value={formatPeso(o.salesThisMonth)} note="Posted invoices, before VAT" />
        <Stat label="Won this month" value={formatPeso(o.wonThisMonth.value)} note={plural(o.wonThisMonth.count, 'lead')} />
        <Stat label="Open quotes" value={formatPeso(o.openQuotes.value)} note={`${plural(o.openQuotes.count, 'quote')} waiting for an answer`} to="/w/$workspaceId/crm/quotes" />
        <Stat label="Orders to work on" value={plural(o.toDeliver, 'to deliver', 'to deliver')} note={`${o.toInvoice} with goods to invoice`} to="/w/$workspaceId/crm/orders" />
      </div>
      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Pipeline</CardTitle>
            <CardDescription>
              {formatPeso(pipelineTotal)} in open leads · {formatPeso(o.weighted)} weighted by how likely each stage is to close
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {o.pipeline.map((p) => (
              <div key={p.stage} className="grid gap-1">
                <div className="flex justify-between text-sm">
                  <span>
                    {LEAD_STAGE_LABELS[p.stage]} <span className="text-muted-foreground">· {p.count}</span>
                  </span>
                  <span className="tabular-nums">{formatPeso(p.value)}</span>
                </div>
                <div className="bg-muted h-2 overflow-hidden rounded-full">
                  <div className="bg-primary h-full rounded-full" style={{ width: `${(p.value / top) * 100}%` }} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Closing soon</CardTitle>
            <CardDescription>Open leads expected to close in the next two weeks, or already late.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {o.closingSoon.length === 0 && <p className="text-muted-foreground">Nothing due.</p>}
            {o.closingSoon.map((l) => (
              <Link key={l.id} to="/w/$workspaceId/crm/leads/$id" params={{ workspaceId, id: l.id }} className="flex items-start justify-between gap-3 hover:underline">
                <span className="min-w-0">
                  <span className="block truncate">{l.title}</span>
                  <span className="text-muted-foreground block truncate text-xs">{leadName(l)}</span>
                </span>
                <span className={cn('shrink-0 text-xs tabular-nums', l.expectedClose! < today() && 'text-destructive')}>{formatDate(l.expectedClose)}</span>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
      <LeadDialog open={adding} onOpenChange={setAdding} />
    </div>
  )
}

/* =============================================================================================
 * Pipeline: a board of open leads by stage; drag a card to move it
 * =========================================================================================== */

export function PipelinePage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const navigate = useNavigate()
  const q = useQuery(crmQueries.leads(workspaceId))
  const [adding, setAdding] = useState(false)
  const [showClosed, setShowClosed] = useState(false)
  const [dragging, setDragging] = useState<string>()
  const [over, setOver] = useState<LeadStage>()
  const move = useWorkspaceMutation((w, { id, stage, lostReason }: { id: string; stage: LeadStage; lostReason?: string }) => api(`/w/${w}/leads/${id}/stage`, { method: 'PATCH', body: { stage, lostReason } }))
  const editable = can('crm.manage')

  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Loading />
  const leads = q.data
  const closed = leads.filter((l) => l.stage === 'won' || l.stage === 'lost')

  function drop(stage: LeadStage, e: DragEvent) {
    e.preventDefault()
    setOver(undefined)
    const lead = leads.find((l) => l.id === e.dataTransfer.getData('text/plain'))
    if (!lead || lead.stage === stage) return
    move.mutate({ id: lead.id, stage })
  }

  return (
    <div>
      <PageHeader
        title="Pipeline"
        description={editable ? 'Every open lead by stage. Drag a card to move it along, or open it to log a call.' : 'Every open lead by stage.'}
        actions={
          editable ? (
            <Button onClick={() => setAdding(true)}>
              <Plus />
              New lead
            </Button>
          ) : undefined
        }
      />
      {move.error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{move.error.message}</AlertDescription>
        </Alert>
      )}
      <div className="-mx-4 overflow-x-auto px-4 pb-2 md:mx-0 md:px-0">
        <div className="grid min-w-[56rem] grid-cols-4 gap-3">
          {OPEN_LEAD_STAGES.map((stage) => {
            const here = leads.filter((l) => l.stage === stage)
            return (
              <section
                key={stage}
                aria-label={LEAD_STAGE_LABELS[stage]}
                className={cn('bg-muted/40 flex min-h-48 flex-col gap-2 rounded-xl border p-2 transition-colors', over === stage && 'border-primary bg-primary/5')}
                onDragOver={(e) => {
                  if (!editable) return
                  e.preventDefault()
                  setOver(stage)
                }}
                onDragLeave={() => setOver((s) => (s === stage ? undefined : s))}
                onDrop={(e) => drop(stage, e)}
              >
                <header className="flex items-baseline justify-between px-1 pt-1">
                  <h3 className="text-sm font-semibold">
                    {LEAD_STAGE_LABELS[stage]} <span className="text-muted-foreground font-normal">{here.length}</span>
                  </h3>
                  <span className="text-muted-foreground text-xs tabular-nums">{formatPeso(here.reduce((s, l) => s + l.value, 0))}</span>
                </header>
                {here.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    draggable={editable}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', l.id)
                      setDragging(l.id)
                    }}
                    onDragEnd={() => setDragging(undefined)}
                    onClick={() => void navigate({ to: '/w/$workspaceId/crm/leads/$id', params: { workspaceId, id: l.id } })}
                    className={cn('bg-card hover:border-foreground/20 grid gap-1 rounded-lg border p-3 text-left text-sm shadow-xs transition', dragging === l.id && 'opacity-50')}
                  >
                    <span className="font-medium">{l.title}</span>
                    <span className="text-muted-foreground truncate text-xs">{leadName(l)}</span>
                    <span className="mt-1 flex items-center justify-between gap-2 text-xs">
                      <span className="font-medium tabular-nums">{formatPeso(l.value)}</span>
                      {l.expectedClose && (
                        <span className={cn('text-muted-foreground flex items-center gap-1', l.expectedClose < today() && 'text-destructive')}>
                          <CalendarClock className="size-3" />
                          {formatDate(l.expectedClose)}
                        </span>
                      )}
                    </span>
                    {l.owner && <span className="text-muted-foreground text-xs">{l.owner.name}</span>}
                  </button>
                ))}
                {here.length === 0 && <p className="text-muted-foreground px-1 py-4 text-center text-xs">No leads here.</p>}
              </section>
            )
          })}
        </div>
      </div>

      <div className="mt-8">
        <Button variant="ghost" onClick={() => setShowClosed((s) => !s)}>
          {showClosed ? 'Hide' : 'Show'} won and lost ({closed.length})
        </Button>
        {showClosed && closed.length > 0 && (
          <div className="mt-3 rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lead</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="hidden md:table-cell">Why lost</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {closed.map((l) => (
                  <TableRow key={l.id} className="cursor-pointer" onClick={() => void navigate({ to: '/w/$workspaceId/crm/leads/$id', params: { workspaceId, id: l.id } })}>
                    <TableCell>
                      {l.title}
                      <span className="text-muted-foreground block text-xs">{leadName(l)}</span>
                    </TableCell>
                    <TableCell>
                      <LeadStageBadge stage={l.stage} />
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden max-w-64 truncate md:table-cell">{l.lostReason}</TableCell>
                    <TableCell className="text-right">
                      <Money value={l.value} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
      <LeadDialog open={adding} onOpenChange={setAdding} />
    </div>
  )
}

export function LeadStageBadge({ stage }: { stage: LeadStage }) {
  return <Badge variant={stage === 'won' ? 'success' : stage === 'lost' ? 'secondary' : 'default'}>{LEAD_STAGE_LABELS[stage]}</Badge>
}

/** Losing a lead asks why, so the team can learn from it. */
function LostDialog({ lead, onClose }: { lead?: Lead; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string>()
  const lose = useWorkspaceMutation((w, body: object) => api(`/w/${w}/leads/${lead!.id}/stage`, { method: 'PATCH', body }))
  async function submit() {
    setError(undefined)
    if (!reason.trim()) return setError('Say why it was lost.')
    try {
      await lose.mutateAsync({ stage: 'lost', lostReason: reason })
      setReason('')
      onClose()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <Dialog open={!!lead} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark as lost</DialogTitle>
          <DialogDescription>{lead?.title}</DialogDescription>
        </DialogHeader>
        <FormError message={error} />
        <Field id="lost-reason" label="Why was it lost?" hint="Price, timing, went with a competitor, no budget…">
          <Textarea id="lost-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={lose.isPending}>
            Mark as lost
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* =============================================================================================
 * A lead: adding and editing
 * =========================================================================================== */

function LeadDialog({ open, onOpenChange, lead, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; lead?: Lead; onSaved?: (id: string) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">{open && <LeadForm lead={lead} onDone={(id) => (onOpenChange(false), id && onSaved?.(id))} />}</DialogContent>
    </Dialog>
  )
}

function LeadForm({ lead, onDone }: { lead?: Lead; onDone: (id?: string) => void }) {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const navigate = useNavigate()
  const members = useQuery({ ...settingsQueries.members(workspaceId), enabled: can('members.view') })
  const customers = useQuery(crmQueries.customers(workspaceId))
  const [v, setV] = useState({
    title: lead?.title ?? '',
    companyName: lead?.companyName ?? '',
    personName: lead?.personName ?? '',
    email: lead?.email ?? '',
    phone: lead?.phone ?? '',
    source: (lead?.source ?? 'referral') as LeadSource,
    value: lead ? centavosToInput(lead.value) : '',
    expectedClose: lead?.expectedClose ?? '',
    ownerId: lead?.owner?.id ?? '',
    customerId: lead?.customer?.id ?? '',
    notes: lead?.notes ?? '',
  })
  const [error, setError] = useState<{ message: string; field?: string }>()
  const set = (patch: Partial<typeof v>) => setV((x) => ({ ...x, ...patch }))
  const save = useWorkspaceMutation((w, body: object) =>
    lead ? api<{ lead: Lead }>(`/w/${w}/leads/${lead.id}`, { method: 'PUT', body }) : api<{ lead: Lead }>(`/w/${w}/leads`, { method: 'POST', body }),
  )

  async function submit() {
    setError(undefined)
    const value = v.value.trim() ? parsePeso(v.value) : 0
    if (value === null || value < 0) return setError({ message: 'Enter the value in pesos, like 90,000.', field: 'value' })
    try {
      const r = await save.mutateAsync({ ...v, value, expectedClose: v.expectedClose || null, ownerId: v.ownerId || (lead ? null : undefined), customerId: v.customerId || null })
      onDone(r.lead.id)
      if (!lead) await navigate({ to: '/w/$workspaceId/crm/leads/$id', params: { workspaceId, id: r.lead.id } })
    } catch (e) {
      setError({ message: (e as Error).message, field: e instanceof ApiError ? e.field : undefined })
    }
  }
  const err = (f: string) => (error?.field === f ? error.message : undefined)

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{lead ? 'Edit lead' : 'New lead'}</DialogTitle>
        <DialogDescription>Someone who might buy. Add what you know now; the rest can come later.</DialogDescription>
      </DialogHeader>
      {error && !error.field && <FormError message={error.message} />}
      <Field id="lead-title" label="What they want" error={err('title')}>
        <Input id="lead-title" placeholder="Weekly rice supply for 3 branches" value={v.title} onChange={(e) => set({ title: e.target.value })} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="lead-company" label="Company" error={err('companyName')}>
          <Input id="lead-company" value={v.companyName} onChange={(e) => set({ companyName: e.target.value })} />
        </Field>
        <Field id="lead-person" label="Contact person">
          <Input id="lead-person" value={v.personName} onChange={(e) => set({ personName: e.target.value })} />
        </Field>
        <Field id="lead-phone" label="Phone">
          <Input id="lead-phone" inputMode="tel" value={v.phone} onChange={(e) => set({ phone: e.target.value })} />
        </Field>
        <Field id="lead-email" label="Email" error={err('email')}>
          <Input id="lead-email" type="email" value={v.email} onChange={(e) => set({ email: e.target.value })} />
        </Field>
        <Field id="lead-value" label="Could be worth (₱)" error={err('value')}>
          <Input id="lead-value" inputMode="decimal" className="text-right" placeholder="0.00" value={v.value} onChange={(e) => set({ value: e.target.value })} />
        </Field>
        <Field id="lead-close" label="Expected to close" error={err('expectedClose')}>
          <Input id="lead-close" type="date" value={v.expectedClose} onChange={(e) => set({ expectedClose: e.target.value })} />
        </Field>
        <Field id="lead-source" label="Where they came from">
          <NativeSelect id="lead-source" value={v.source} onChange={(e) => set({ source: e.target.value as LeadSource })}>
            {LEAD_SOURCES.map((s) => (
              <option key={s} value={s}>
                {LEAD_SOURCE_LABELS[s]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {members.data && (
          <Field id="lead-owner" label="Who’s working it" error={err('ownerId')}>
            <NativeSelect id="lead-owner" value={v.ownerId} onChange={(e) => set({ ownerId: e.target.value })}>
              <option value="">{lead ? 'Nobody' : 'Me'}</option>
              {members.data.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                  {m.isYou ? ' (you)' : ''}
                </option>
              ))}
            </NativeSelect>
          </Field>
        )}
        <Field id="lead-customer" label="Already a customer?" className="sm:col-span-2">
          <NativeSelect id="lead-customer" value={v.customerId} onChange={(e) => set({ customerId: e.target.value })}>
            <option value="">No, a new prospect</option>
            {customers.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <Field id="lead-notes" label="Notes">
        <Textarea id="lead-notes" rows={3} value={v.notes} onChange={(e) => set({ notes: e.target.value })} />
      </Field>
      <DialogFooter>
        <Button variant="outline" onClick={() => onDone()}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : lead ? 'Save' : 'Add lead'}
        </Button>
      </DialogFooter>
    </div>
  )
}

/* =============================================================================================
 * A lead's page
 * =========================================================================================== */

export function LeadPage({ id }: { id: string }) {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const navigate = useNavigate()
  const q = useQuery(crmQueries.lead(workspaceId, id))
  const [editing, setEditing] = useState(false)
  const [losing, setLosing] = useState(false)
  const act = useWorkspaceMutation((w, what: { stage: LeadStage } | 'convert' | 'delete') =>
    what === 'delete'
      ? api(`/w/${w}/leads/${id}`, { method: 'DELETE' })
      : what === 'convert'
        ? api(`/w/${w}/leads/${id}/convert`, { method: 'POST' })
        : api(`/w/${w}/leads/${id}/stage`, { method: 'PATCH', body: what }),
  )
  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Loading />
  const l = q.data
  const editable = can('crm.manage')

  async function remove() {
    if (!window.confirm(`Delete the lead “${l.title}”? Its activities go with it.`)) return
    await act.mutateAsync('delete')
    await navigate({ to: '/w/$workspaceId/crm/pipeline', params: { workspaceId } })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">{l.title}</h2>
            <LeadStageBadge stage={l.stage} />
          </div>
          <p className="text-muted-foreground text-sm">
            {leadName(l)}
            {l.personName && l.personName !== leadName(l) && ` · ${l.personName}`} · {formatPeso(l.value)}
            {l.expectedClose && ` · closes ${formatDate(l.expectedClose)}`}
          </p>
        </div>
        {editable && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" onClick={() => void remove().catch(() => undefined)}>
              <Trash2 />
              Delete
            </Button>
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil />
              Edit
            </Button>
            {!l.customer && (
              <Button variant="outline" onClick={() => act.mutate('convert')} disabled={act.isPending}>
                <UserPlus />
                Make a customer
              </Button>
            )}
            {l.customer && (
              <Button asChild>
                <Link to="/w/$workspaceId/crm/quotes/new" params={{ workspaceId }} search={{ customerId: l.customer.id, leadId: l.id }}>
                  <FilePlus2 />
                  New quote
                </Link>
              </Button>
            )}
          </div>
        )}
      </div>
      {act.error && (
        <Alert variant="destructive">
          <AlertDescription>{act.error.message}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {editable && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Stage">
              {LEAD_STAGES.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={l.stage === s ? 'default' : 'outline'}
                  aria-pressed={l.stage === s}
                  disabled={act.isPending}
                  onClick={() => (s === l.stage ? undefined : s === 'lost' ? setLosing(true) : act.mutate({ stage: s }))}
                >
                  {LEAD_STAGE_LABELS[s]}
                </Button>
              ))}
            </div>
          )}
          {l.stage === 'lost' && l.lostReason && (
            <Alert>
              <AlertDescription>Lost: {l.lostReason}</AlertDescription>
            </Alert>
          )}
          <ActivityLog activities={l.activities} path={`leads/${l.id}`} editable={editable} />
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              {l.customer && (
                <Detail label="Customer">
                  <Link to="/w/$workspaceId/crm/customers/$id" params={{ workspaceId, id: l.customer.id }} className="hover:underline">
                    {l.customer.name}
                  </Link>
                </Detail>
              )}
              {l.personName && <Detail label="Contact person">{l.personName}</Detail>}
              {l.phone && (
                <Detail label="Phone">
                  <a href={`tel:${l.phone.replace(/\s/g, '')}`} className="hover:underline">
                    {l.phone}
                  </a>
                </Detail>
              )}
              {l.email && (
                <Detail label="Email">
                  <a href={`mailto:${l.email}`} className="hover:underline">
                    {l.email}
                  </a>
                </Detail>
              )}
              <Detail label="Came from">{LEAD_SOURCE_LABELS[l.source]}</Detail>
              <Detail label="Working it">{l.owner?.name ?? 'Nobody yet'}</Detail>
              {l.notes && <p className="text-muted-foreground whitespace-pre-line">{l.notes}</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Quotes</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {l.quotes.length === 0 && <p className="text-muted-foreground">{l.customer ? 'None yet.' : 'Make them a customer to quote them.'}</p>}
              {l.quotes.map((qt) => (
                <Link key={qt.id} to="/w/$workspaceId/crm/quotes/$id" params={{ workspaceId, id: qt.id }} className="flex items-center justify-between gap-2 hover:underline">
                  <span>
                    {qt.number ?? 'Draft'} <QuoteStatusBadge status={qt.status} expired={qt.expired} />
                  </span>
                  <span className="tabular-nums">{formatPeso(qt.total)}</span>
                </Link>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
      <LeadDialog open={editing} onOpenChange={setEditing} lead={l} />
      <LostDialog lead={losing ? l : undefined} onClose={() => setLosing(false)} />
    </div>
  )
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  )
}

/* =============================================================================================
 * Activities: the log on a lead or a customer
 * =========================================================================================== */

const ACTIVITY_ICONS: Record<ActivityKind, typeof Phone> = { note: MessageSquare, call: Phone, meeting: Users, email: Mail }

function ActivityLog({ activities, path, editable }: { activities: Activity[]; path: string; editable: boolean }) {
  const workspaceId = useWorkspaceId()
  const [kind, setKind] = useState<ActivityKind>('call')
  const [body, setBody] = useState('')
  const [date, setDate] = useState(today())
  const [error, setError] = useState<string>()
  const log = useWorkspaceMutation((w, input: object) => api(`/w/${w}/${path}/activities`, { method: 'POST', body: input }))

  async function submit() {
    setError(undefined)
    if (!body.trim()) return setError('Write what happened.')
    try {
      await log.mutateAsync({ kind, body, date })
      setBody('')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        <CardDescription>Calls, meetings, emails and notes, newest first.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        {editable && (
          <div className="grid gap-3 rounded-lg border p-3">
            <FormError message={error} />
            <div className="flex flex-wrap gap-2">
              <NativeSelect aria-label="Kind" className="w-36" value={kind} onChange={(e) => setKind(e.target.value as ActivityKind)}>
                {ACTIVITY_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {ACTIVITY_KIND_LABELS[k]}
                  </option>
                ))}
              </NativeSelect>
              <Input aria-label="Date" type="date" className="w-40" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <Textarea aria-label="What happened" rows={2} placeholder="Called Mia: wants a sample sack before ordering." value={body} onChange={(e) => setBody(e.target.value)} />
            <div className="flex justify-end">
              <Button size="sm" onClick={() => void submit()} disabled={log.isPending}>
                Log it
              </Button>
            </div>
          </div>
        )}
        {activities.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing logged yet.</p>
        ) : (
          <ol className="grid gap-4">
            {activities.map((a) => {
              const Icon = ACTIVITY_ICONS[a.kind]
              return (
                <li key={a.id} className="flex gap-3 text-sm">
                  <span className="bg-secondary grid size-8 shrink-0 place-items-center rounded-full">
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-muted-foreground text-xs">
                      {ACTIVITY_KIND_LABELS[a.kind]} · {formatDate(a.date)}
                      {a.author && ` · ${a.author.name}`}
                      {a.lead && path.startsWith('crm/customers') && (
                        <>
                          {' · '}
                          <Link to="/w/$workspaceId/crm/leads/$id" params={{ workspaceId, id: a.lead.id }} className="hover:underline">
                            {a.lead.title}
                          </Link>
                        </>
                      )}
                    </p>
                    <p className="whitespace-pre-line">{a.body}</p>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}

/* =============================================================================================
 * Customers
 * =========================================================================================== */

export function CustomersPage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const q = useQuery(crmQueries.customers(workspaceId))
  const [adding, setAdding] = useState(false)
  const shown = q.data?.filter((c) => !search || `${c.name} ${c.tin ?? ''} ${c.email ?? ''}`.toLowerCase().includes(search.toLowerCase()))
  const newButton = (
    <Button onClick={() => setAdding(true)}>
      <Plus />
      New customer
    </Button>
  )
  return (
    <div>
      <PageHeader title="Customers" description="Who buys from you, what they owe, and what’s on order." actions={can('crm.manage') ? newButton : undefined} />
      <div className="relative mb-4 max-w-sm">
        <Search className="text-muted-foreground absolute top-2.5 left-3 size-4" />
        <Input aria-label="Search customers" placeholder="Search by name, TIN or email" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {q.error ? (
        <LoadError error={q.error} />
      ) : !shown ? (
        <Loading />
      ) : shown.length === 0 ? (
        <EmptyState title={search ? 'No customers match' : 'No customers yet'} action={can('crm.manage') && !search ? newButton : undefined} />
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead className="hidden md:table-cell">Phone</TableHead>
                <TableHead className="text-right">Owes</TableHead>
                <TableHead className="hidden text-right sm:table-cell">On order</TableHead>
                <TableHead className="hidden text-right lg:table-cell">Credit limit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((c) => (
                <TableRow key={c.id} className="cursor-pointer" onClick={() => void navigate({ to: '/w/$workspaceId/crm/customers/$id', params: { workspaceId, id: c.id } })}>
                  <TableCell className="max-w-64">
                    <span className="block truncate font-medium">{c.name}</span>
                    {c.openLeads > 0 && <span className="text-muted-foreground text-xs">{plural(c.openLeads, 'open lead')}</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden md:table-cell">{c.phone}</TableCell>
                  <TableCell className="text-right">
                    <Money value={c.owed} />
                    {c.overdue > 0 && <span className="text-destructive block text-xs">{formatPeso(c.overdue)} overdue</span>}
                  </TableCell>
                  <TableCell className="hidden text-right sm:table-cell">
                    <Money value={c.onOrder} />
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-right lg:table-cell">{c.creditLimit === null ? '—' : <Money value={c.creditLimit} />}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <CustomerDialog open={adding} onOpenChange={setAdding} onSaved={(id) => void navigate({ to: '/w/$workspaceId/crm/customers/$id', params: { workspaceId, id } })} />
    </div>
  )
}

export function CustomerDialog({ open, onOpenChange, customer, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; customer?: CustomerSummary; onSaved?: (id: string) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {open && (
          <CustomerForm
            customer={customer}
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

function CustomerForm({ customer, onDone }: { customer?: CustomerSummary; onDone: (id?: string) => void }) {
  const [v, setV] = useState({
    name: customer?.name ?? '',
    tin: customer?.tin ?? '',
    address: customer?.address ?? '',
    email: customer?.email ?? '',
    phone: customer?.phone ?? '',
    paymentTermsDays: customer?.paymentTermsDays?.toString() ?? '',
    creditLimit: customer?.creditLimit != null ? centavosToInput(customer.creditLimit) : '',
    priceListId: customer?.priceListId ?? '',
  })
  const priceLists = useQuery(crmQueries.priceLists(useWorkspaceId()))
  const [error, setError] = useState<{ message: string; field?: string }>()
  const set = (patch: Partial<typeof v>) => setV((x) => ({ ...x, ...patch }))
  const save = useWorkspaceMutation((w, body: object) =>
    customer ? api<{ customer: CustomerSummary }>(`/w/${w}/crm/customers/${customer.id}`, { method: 'PUT', body }) : api<{ customer: CustomerSummary }>(`/w/${w}/crm/customers`, { method: 'POST', body }),
  )
  const err = (f: string) => (error?.field === f ? error.message : undefined)

  async function submit() {
    setError(undefined)
    const creditLimit = v.creditLimit.trim() ? parsePeso(v.creditLimit) : null
    if (creditLimit !== null && creditLimit < 0) return setError({ message: 'Enter the limit in pesos.', field: 'creditLimit' })
    if (v.creditLimit.trim() && creditLimit === null) return setError({ message: 'Enter the limit in pesos, like 100,000.', field: 'creditLimit' })
    const terms = v.paymentTermsDays.trim() ? Number(v.paymentTermsDays) : null
    if (terms !== null && !Number.isInteger(terms)) return setError({ message: 'Enter whole days, like 30.', field: 'paymentTermsDays' })
    try {
      const r = await save.mutateAsync({ ...v, paymentTermsDays: terms, creditLimit, priceListId: v.priceListId || null })
      onDone(r.customer.id)
    } catch (e) {
      setError({ message: (e as Error).message, field: e instanceof ApiError ? e.field : undefined })
    }
  }

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{customer ? 'Edit customer' : 'New customer'}</DialogTitle>
        <DialogDescription>The registered name and TIN print on their invoices.</DialogDescription>
      </DialogHeader>
      {error && !error.field && <FormError message={error.message} />}
      <Field id="cu-name" label="Registered name" error={err('name')}>
        <Input id="cu-name" value={v.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="cu-tin" label="TIN" error={err('tin')}>
          <Input id="cu-tin" placeholder="000-000-000-00000" value={v.tin} onChange={(e) => set({ tin: e.target.value })} />
        </Field>
        <Field id="cu-phone" label="Phone">
          <Input id="cu-phone" inputMode="tel" value={v.phone} onChange={(e) => set({ phone: e.target.value })} />
        </Field>
        <Field id="cu-email" label="Email" error={err('email')} className="sm:col-span-2">
          <Input id="cu-email" type="email" value={v.email} onChange={(e) => set({ email: e.target.value })} />
        </Field>
        <Field id="cu-address" label="Address" className="sm:col-span-2">
          <Textarea id="cu-address" rows={2} value={v.address} onChange={(e) => set({ address: e.target.value })} />
        </Field>
        <Field id="cu-terms" label="Days to pay" error={err('paymentTermsDays')} hint="Blank: due on receipt.">
          <Input id="cu-terms" inputMode="numeric" className="text-right" placeholder="30" value={v.paymentTermsDays} onChange={(e) => set({ paymentTermsDays: e.target.value })} />
        </Field>
        <Field id="cu-limit" label="Credit limit (₱)" error={err('creditLimit')} hint="Blank: no limit.">
          <Input id="cu-limit" inputMode="decimal" className="text-right" value={v.creditLimit} onChange={(e) => set({ creditLimit: e.target.value })} />
        </Field>
        {!!priceLists.data?.length && (
          <Field id="cu-prices" label="Price list" error={err('priceListId')} hint="Their prices fill in on quotes, orders and invoices." className="sm:col-span-2">
            <NativeSelect id="cu-prices" value={v.priceListId} onChange={(e) => set({ priceListId: e.target.value })}>
              <option value="">None: the items’ own prices</option>
              {priceLists.data.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {!p.active ? ' (off)' : ''}
                </option>
              ))}
            </NativeSelect>
          </Field>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onDone()}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : customer ? 'Save' : 'Add customer'}
        </Button>
      </DialogFooter>
    </div>
  )
}

export function CustomerPage({ id }: { id: string }) {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const navigate = useNavigate()
  const q = useQuery(crmQueries.customer(workspaceId, id))
  const [editing, setEditing] = useState(false)
  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Loading />
  const c = q.data
  const creditLeft = c.creditLimit === null ? null : c.creditLimit - c.owed - c.onOrder
  const todayStr = today()

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">{c.name}</h2>
          <p className="text-muted-foreground text-sm">
            {[c.tin && `TIN ${c.tin}`, c.paymentTermsDays !== null ? (c.paymentTermsDays === 0 ? 'Due on receipt' : `${c.paymentTermsDays} days to pay`) : null].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {can('crm.manage') && (
            <>
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil />
                Edit
              </Button>
              <Button variant="outline" asChild>
                <Link to="/w/$workspaceId/crm/quotes/new" params={{ workspaceId }} search={{ customerId: c.id }}>
                  <FilePlus2 />
                  New quote
                </Link>
              </Button>
            </>
          )}
          {can('sales.manage') && (
            <Button asChild>
              <Link to="/w/$workspaceId/crm/orders/new" params={{ workspaceId }} search={{ customerId: c.id }}>
                <ShoppingBag />
                New sales order
              </Link>
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Owes you" value={formatPeso(c.owed)} />
        <Stat label="Overdue" value={formatPeso(c.overdue)} />
        <Stat label="On order, not invoiced" value={formatPeso(c.onOrder)} />
        <Stat label="Credit left" value={creditLeft === null ? 'No limit' : formatPeso(creditLeft)} note={c.creditLimit !== null ? `of ${formatPeso(c.creditLimit)}` : undefined} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Sales orders</CardTitle>
            </CardHeader>
            <CardContent>
              {c.orders.length === 0 ? (
                <p className="text-muted-foreground text-sm">None yet.</p>
              ) : (
                <Table>
                  <TableBody>
                    {c.orders.map((o) => (
                      <TableRow key={o.id} className="cursor-pointer" onClick={() => void navigate({ to: '/w/$workspaceId/crm/orders/$id', params: { workspaceId, id: o.id } })}>
                        <TableCell className="pl-0 font-medium">{o.number ?? 'Draft'}</TableCell>
                        <TableCell className="text-muted-foreground">{formatDate(o.date)}</TableCell>
                        <TableCell>
                          <OrderStatusBadge status={o.status} />
                        </TableCell>
                        <TableCell className="pr-0 text-right">
                          <Money value={o.total} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Invoices</CardTitle>
            </CardHeader>
            <CardContent>
              {c.invoices.length === 0 ? (
                <p className="text-muted-foreground text-sm">None yet.</p>
              ) : (
                <Table>
                  <TableBody>
                    {c.invoices.map((inv) => (
                      <TableRow
                        key={inv.id}
                        className={cn(can('finance.view') && 'cursor-pointer')}
                        onClick={() => can('finance.view') && void navigate({ to: '/w/$workspaceId/finance/invoices/$id', params: { workspaceId, id: inv.id } })}
                      >
                        <TableCell className="pl-0 font-medium">{inv.number ?? 'Draft'}</TableCell>
                        <TableCell className="text-muted-foreground">{formatDate(inv.date)}</TableCell>
                        <TableCell>
                          <DocumentStatusBadge status={inv.status} balance={inv.balance} dueDate={inv.dueDate} today={todayStr} />
                        </TableCell>
                        <TableCell className="pr-0 text-right">
                          <Money value={inv.total} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
          <ActivityLog activities={c.activities} path={`crm/customers/${c.id}`} editable={can('crm.manage')} />
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Contact</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              {c.phone && (
                <Detail label="Phone">
                  <a href={`tel:${c.phone.replace(/\s/g, '')}`} className="hover:underline">
                    {c.phone}
                  </a>
                </Detail>
              )}
              {c.email && (
                <Detail label="Email">
                  <a href={`mailto:${c.email}`} className="hover:underline">
                    {c.email}
                  </a>
                </Detail>
              )}
              {c.address && <Detail label="Address">{c.address}</Detail>}
              {!c.phone && !c.email && !c.address && <p className="text-muted-foreground">No contact details yet.</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Quotes</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {c.quotes.length === 0 && <p className="text-muted-foreground">None yet.</p>}
              {c.quotes.map((qt) => (
                <Link key={qt.id} to="/w/$workspaceId/crm/quotes/$id" params={{ workspaceId, id: qt.id }} className="flex items-center justify-between gap-2 hover:underline">
                  <span>
                    {qt.number ?? 'Draft'} <QuoteStatusBadge status={qt.status} expired={qt.expired} />
                  </span>
                  <span className="tabular-nums">{formatPeso(qt.total)}</span>
                </Link>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Leads</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {c.leads.length === 0 && <p className="text-muted-foreground">None.</p>}
              {c.leads.map((l) => (
                <Link key={l.id} to="/w/$workspaceId/crm/leads/$id" params={{ workspaceId, id: l.id }} className="flex items-center justify-between gap-2 hover:underline">
                  <span className="truncate">{l.title}</span>
                  <LeadStageBadge stage={l.stage} />
                </Link>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
      <CustomerDialog open={editing} onOpenChange={setEditing} customer={c} />
    </div>
  )
}

/* =============================================================================================
 * Price lists (Phase 8)
 * =========================================================================================== */

function PriceListDialog({ list, onClose }: { list?: PriceList; onClose: () => void }) {
  const workspaceId = useWorkspaceId()
  const items = useQuery(crmQueries.items(workspaceId))
  const [name, setName] = useState(list?.name ?? '')
  const [notes, setNotes] = useState(list?.notes ?? '')
  const [active, setActive] = useState(list?.active ?? true)
  const [lines, setLines] = useState(list?.lines.map((l) => ({ itemId: l.item.id, minQty: String(l.minQty), price: centavosToInput(l.price) })) ?? [{ itemId: '', minQty: '0', price: '' }])
  const [error, setError] = useState<string>()
  const save = useWorkspaceMutation((w, body: object) => (list ? api(`/w/${w}/price-lists/${list.id}`, { method: 'PUT', body }) : api(`/w/${w}/price-lists`, { method: 'POST', body })))
  const set = (i: number, patch: Partial<(typeof lines)[number]>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{list ? `Edit ${list.name}` : 'New price list'}</DialogTitle>
          <DialogDescription>Prices before VAT. Add a line per quantity break: from 0, from a case, from ten cases. The highest break an order reaches wins.</DialogDescription>
        </DialogHeader>
        <FormError message={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="pl-name" label="Name">
            <Input id="pl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dealers" />
          </Field>
          <Field id="pl-notes" label="Notes">
            <Input id="pl-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-2">
          <div className="text-muted-foreground grid grid-cols-[1fr_6rem_7rem_auto] gap-2 text-xs">
            <span>Item</span>
            <span className="text-right">From qty</span>
            <span className="text-right">Price (₱)</span>
            <span className="w-9" />
          </div>
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_6rem_7rem_auto] gap-2">
              <NativeSelect aria-label={`Item ${i + 1}`} value={l.itemId} onChange={(e) => set(i, { itemId: e.target.value, price: l.price || centavosToInput(items.data?.find((x) => x.id === e.target.value)?.salesPrice ?? 0) })}>
                <option value="">Choose…</option>
                {items.data?.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.sku} · {x.name}
                  </option>
                ))}
              </NativeSelect>
              <Input aria-label={`From quantity ${i + 1}`} inputMode="decimal" className="text-right" value={l.minQty} onChange={(e) => set(i, { minQty: e.target.value })} />
              <Input aria-label={`Price ${i + 1}`} inputMode="decimal" className="text-right" value={l.price} onChange={(e) => set(i, { price: e.target.value })} />
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setLines((ls) => [...ls, { itemId: ls.at(-1)?.itemId ?? '', minQty: '', price: '' }])}>
            <Plus />
            Add a price
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="pl-active" checked={active} onCheckedChange={(c) => setActive(c === true)} />
          <Label htmlFor="pl-active" className="font-normal">
            In use
          </Label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={save.isPending}
            onClick={() => {
              setError(undefined)
              const parsed = lines.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, minQty: Number(l.minQty || 0), price: parsePeso(l.price) }))
              if (parsed.some((l) => l.price === null)) return setError('Enter each price, like 37.50.')
              save.mutate({ name, notes, active, lines: parsed }, { onSuccess: onClose, onError: (e) => setError(e.message) })
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function PriceListsPage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const q = useQuery(crmQueries.priceLists(workspaceId))
  const [editing, setEditing] = useState<PriceList | 'new' | null>(null)
  return (
    <div>
      <PageHeader
        title="Price lists"
        description="Prices for kinds of customers (dealers, resellers, key accounts), with quantity breaks. Give a customer a list on their record."
        actions={
          can('crm.manage') && (
            <Button onClick={() => setEditing('new')}>
              <Plus />
              New price list
            </Button>
          )
        }
      />
      {q.error ? (
        <LoadError error={q.error} />
      ) : !q.data ? (
        <Loading />
      ) : q.data.length === 0 ? (
        <EmptyState title="No price lists yet">Everyone pays the items’ own prices until you make one.</EmptyState>
      ) : (
        <div className="grid gap-4">
          {q.data.map((p) => (
            <Card key={p.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div className="space-y-1.5">
                  <CardTitle>
                    {p.name} {!p.active && <Badge variant="secondary">Off</Badge>}
                  </CardTitle>
                  <CardDescription>
                    {p.customerCount} customer{p.customerCount === 1 ? '' : 's'}
                    {p.notes ? ` · ${p.notes}` : ''}
                  </CardDescription>
                </div>
                {can('crm.manage') && (
                  <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>
                    <Pencil />
                    Edit
                  </Button>
                )}
              </CardHeader>
              <CardContent className="px-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-6">Item</TableHead>
                      <TableHead className="text-right">From</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="pr-6 text-right">Usual</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {p.lines.map((l) => (
                      <TableRow key={l.id}>
                        <TableCell className="pl-6">{l.item.name}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatQty(l.minQty)} {l.item.unit}
                        </TableCell>
                        <TableCell className="text-right">
                          <Money value={l.price} />
                        </TableCell>
                        <TableCell className="text-muted-foreground pr-6 text-right">
                          <Money value={l.item.salesPrice} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {editing && <PriceListDialog list={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
