import { centavosToInput, formatPeso, parsePeso, WO_STATUS_LABELS, type BomInput, type MrpRow, type WoStatus, type WorkCenter, type WorkOrder } from '@erp/shared'
import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { CheckCircle2, CirclePlay, ClipboardCheck, Copy, Factory, Pencil, Plus, Printer, Trash2, X, XCircle } from 'lucide-react'
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
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { EmptyState, LoadError, Loading, Money, PageHeader } from '@/features/finance/components'
import { financeQueries, useWorkspaceMutation } from '@/features/finance/queries'
import { formatQty, inventoryQueries } from '@/features/inventory/queries'
import { useCan, useWorkspace, useWorkspaceId } from '@/features/workspaces/queries'
import { api } from '@/lib/api'
import { formatDate, today } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { formatMinutes, mfgQueries } from './queries'

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/* =============================================================================================
 * Frame
 * =========================================================================================== */

const TABS = [
  { to: '/w/$workspaceId/manufacturing', label: 'Overview', exact: true },
  { to: '/w/$workspaceId/manufacturing/work-orders', label: 'Work orders' },
  { to: '/w/$workspaceId/manufacturing/boms', label: 'Bills of materials' },
  { to: '/w/$workspaceId/manufacturing/planning', label: 'Planning' },
  { to: '/w/$workspaceId/manufacturing/work-centers', label: 'Work centres' },
] as const

export function ManufacturingLayout() {
  const workspace = useWorkspace()
  const can = useCan()
  if (!workspace.modules.includes('manufacturing')) {
    return <EmptyState title="Manufacturing is turned off">An owner or admin can turn it on in Settings → Workspace → Modules.</EmptyState>
  }
  if (!can('manufacturing.view')) {
    return <EmptyState title="Your role can’t see Manufacturing">You’re here as {workspace.role.name}. An owner or admin can change that.</EmptyState>
  }
  return (
    <>
      <nav aria-label="Manufacturing" className="-mx-4 mb-6 overflow-x-auto border-b px-4 md:mx-0 md:px-0 print:hidden">
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

const STATUS_VARIANT: Record<WoStatus, 'outline' | 'secondary' | 'default' | 'success'> = { draft: 'outline', released: 'secondary', in_progress: 'default', completed: 'success', cancelled: 'secondary' }

function WoStatusBadge({ status, late }: { status: WoStatus; late?: boolean }) {
  return (
    <span className="inline-flex gap-1">
      <Badge variant={STATUS_VARIANT[status]}>{WO_STATUS_LABELS[status]}</Badge>
      {late && <Badge className="bg-destructive text-white">Late</Badge>}
    </span>
  )
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
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

export function ManufacturingOverviewPage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const q = useQuery(mfgQueries.overview(workspaceId))
  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Loading />
  const o = q.data
  const busiest = Math.max(1, ...o.load.map((l) => l.minutes))
  const rejectRate = o.madeThisMonth + o.rejectedThisMonth > 0 ? (o.rejectedThisMonth / (o.madeThisMonth + o.rejectedThisMonth)) * 100 : 0
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap gap-2">
        {can('manufacturing.manage') && (
          <Button asChild>
            <Link to="/w/$workspaceId/manufacturing/work-orders/new" params={{ workspaceId }}>
              <Plus />
              New work order
            </Link>
          </Button>
        )}
        <Button variant="outline" asChild>
          <Link to="/w/$workspaceId/manufacturing/planning" params={{ workspaceId }}>
            <ClipboardCheck />
            Plan: {o.toMake} to make, {o.toBuy} to buy
          </Link>
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Open work orders" value={String(o.open)} note={o.late ? `${o.late} late` : undefined} />
        <Stat label="In progress" value={String(o.inProgress)} />
        <Stat label="Made this month" value={formatQty(o.madeThisMonth)} note="Units that passed QC" />
        <Stat label="Rejected this month" value={`${formatQty(o.rejectedThisMonth)}`} note={`${rejectRate.toFixed(1)}% of what was made`} />
      </div>
      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Coming up</CardTitle>
            <CardDescription>Open work orders, by due date.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">{o.dueSoon.length ? <WoTable rows={o.dueSoon} compact /> : <p className="text-muted-foreground px-6 text-sm">Nothing open.</p>}</CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Work centre load</CardTitle>
            <CardDescription>Time booked by open work orders starting in the next 14 days.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {o.load.length === 0 && <p className="text-muted-foreground text-sm">No work centres yet.</p>}
            {o.load.map((l) => (
              <div key={l.workCenter.id} className="grid gap-1.5">
                <div className="flex justify-between text-sm">
                  <span className="font-medium">{l.workCenter.name}</span>
                  <span className="text-muted-foreground tabular-nums">{formatMinutes(l.minutes)}</span>
                </div>
                <div className="bg-muted h-2 overflow-hidden rounded-full">
                  <div className="bg-primary h-full rounded-full" style={{ width: `${(l.minutes / busiest) * 100}%` }} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

/* =============================================================================================
 * Work orders
 * =========================================================================================== */

function WoTable({ rows, compact }: { rows: import('@erp/shared').WorkOrderSummary[]; compact?: boolean }) {
  const workspaceId = useWorkspaceId()
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-6">Work order</TableHead>
          <TableHead>Product</TableHead>
          <TableHead className="text-right">Quantity</TableHead>
          <TableHead>Due</TableHead>
          {!compact && <TableHead>For</TableHead>}
          <TableHead className="pr-6">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((w) => (
          <TableRow key={w.id}>
            <TableCell className="pl-6">
              <Link to="/w/$workspaceId/manufacturing/work-orders/$id" params={{ workspaceId, id: w.id }} className="font-medium whitespace-nowrap hover:underline">
                {w.number ?? 'Draft'}
              </Link>
            </TableCell>
            <TableCell>{w.item.name}</TableCell>
            <TableCell className="text-right tabular-nums">
              {w.status === 'completed' ? formatQty(w.goodQty) : formatQty(w.quantity)} {w.item.unit}
            </TableCell>
            <TableCell className={cn('whitespace-nowrap', w.late && 'text-destructive')}>{formatDate(w.dueDate)}</TableCell>
            {!compact && <TableCell className="text-muted-foreground">{w.salesOrder ? `${w.salesOrder.number ?? 'SO'} · ${w.salesOrder.customer}` : 'Stock'}</TableCell>}
            <TableCell className="pr-6">
              <WoStatusBadge status={w.status} late={w.late} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function WorkOrdersPage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const [status, setStatus] = useState('open')
  const q = useQuery(mfgQueries.workOrders(workspaceId, status))
  return (
    <div>
      <PageHeader
        title="Work orders"
        description="What to make, from which bill of materials, and by when."
        actions={
          can('manufacturing.manage') && (
            <Button asChild>
              <Link to="/w/$workspaceId/manufacturing/work-orders/new" params={{ workspaceId }}>
                <Plus />
                New work order
              </Link>
            </Button>
          )
        }
      />
      <div className="mb-4 flex gap-2">
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
        <EmptyState title="No work orders here">Make one from a product’s bill of materials, or from the plan.</EmptyState>
      ) : (
        <Card className="py-0">
          <WoTable rows={q.data} />
        </Card>
      )}
    </div>
  )
}

export type WoFormSearch = { itemId?: string; quantity?: string; salesOrderId?: string }

export function WorkOrderFormPage({ search, id }: { search?: WoFormSearch; id?: string }) {
  const workspaceId = useWorkspaceId()
  const navigate = useNavigate()
  const boms = useQuery(mfgQueries.boms(workspaceId))
  const warehouses = useQuery(inventoryQueries.warehouses(workspaceId))
  const existing = useQuery({ ...mfgQueries.workOrder(workspaceId, id ?? ''), enabled: !!id })
  const [v, setV] = useState<{ itemId: string; quantity: string; warehouseId: string; startDate: string; dueDate: string; notes: string } | null>(null)
  const [error, setError] = useState<string>()
  const save = useWorkspaceMutation((w, body: object) => (id ? api<{ workOrder: WorkOrder }>(`/w/${w}/work-orders/${id}`, { method: 'PUT', body }) : api<{ workOrder: WorkOrder }>(`/w/${w}/work-orders`, { method: 'POST', body })))
  if (!boms.data || !warehouses.data || (id && !existing.data)) return <Loading />
  const products = boms.data.filter((b) => b.active)
  const values = v ?? {
    itemId: existing.data?.item.id ?? search?.itemId ?? products[0]?.item.id ?? '',
    quantity: existing.data ? String(existing.data.quantity) : (search?.quantity ?? ''),
    warehouseId: existing.data?.warehouse.id ?? warehouses.data[0]?.id ?? '',
    startDate: existing.data?.startDate ?? today(),
    dueDate: existing.data?.dueDate ?? addDays(today(), 2),
    notes: existing.data?.notes ?? '',
  }
  const set = (k: keyof typeof values) => (e: { target: { value: string } }) => setV({ ...values, [k]: e.target.value })
  const bom = products.find((b) => b.item.id === values.itemId)
  if (!products.length) {
    return (
      <EmptyState
        title="No bills of materials yet"
        action={
          <Button asChild>
            <Link to="/w/$workspaceId/manufacturing/boms/new" params={{ workspaceId }}>
              Make one
            </Link>
          </Button>
        }
      >
        A work order makes a product from its bill of materials.
      </EmptyState>
    )
  }
  return (
    <div className="max-w-2xl">
      <PageHeader
        title={id ? `Edit ${existing.data?.number ?? 'draft work order'}` : 'New work order'}
        description={search?.salesOrderId || existing.data?.salesOrder ? 'Made to order: it shows on the sales order, with its cost against the price.' : 'Materials and steps come from the product’s bill of materials, scaled to the quantity.'}
      />
      <form
        className="grid gap-5"
        onSubmit={(e) => {
          e.preventDefault()
          setError(undefined)
          save.mutate(
            { itemId: values.itemId, quantity: Number(values.quantity), warehouseId: values.warehouseId, startDate: values.startDate, dueDate: values.dueDate, notes: values.notes, salesOrderId: existing.data?.salesOrder?.id ?? search?.salesOrderId ?? null },
            { onSuccess: (r) => void navigate({ to: '/w/$workspaceId/manufacturing/work-orders/$id', params: { workspaceId, id: r.workOrder.id } }), onError: (e) => setError(e.message) },
          )
        }}
      >
        <FormError message={error} />
        <div className="grid gap-2">
          <Label htmlFor="wo-item">Product</Label>
          <NativeSelect id="wo-item" value={values.itemId} onChange={set('itemId')}>
            {products.map((b) => (
              <option key={b.id} value={b.item.id}>
                {b.item.name} ({b.code})
              </option>
            ))}
          </NativeSelect>
          {bom && (
            <p className="text-muted-foreground text-sm">
              A batch makes {formatQty(bom.outputQty)} {bom.item.unit}, at about {formatPeso(bom.unitCost)} each.
            </p>
          )}
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="wo-qty">Quantity to make{bom ? ` (${bom.item.unit})` : ''}</Label>
            <Input id="wo-qty" inputMode="decimal" value={values.quantity} onChange={set('quantity')} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="wo-wh">Warehouse</Label>
            <NativeSelect id="wo-wh" value={values.warehouseId} onChange={set('warehouseId')}>
              {warehouses.data.filter((x) => x.active).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="wo-start">Start</Label>
            <Input id="wo-start" type="date" value={values.startDate} onChange={set('startDate')} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="wo-due">Due</Label>
            <Input id="wo-due" type="date" value={values.dueDate} onChange={set('dueDate')} required />
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="wo-notes">Notes</Label>
          <Textarea id="wo-notes" value={values.notes} onChange={set('notes')} />
        </div>
        <div className="flex gap-2">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : id ? 'Save' : 'Create draft'}
          </Button>
          <Button type="button" variant="outline" onClick={() => history.back()}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  )
}

function StartDialog({ wo, onClose }: { wo: WorkOrder; onClose: () => void }) {
  const [date, setDate] = useState(today())
  const [qty, setQty] = useState(() => Object.fromEntries(wo.materials.map((m) => [m.id, String(m.plannedQty)])))
  const [lot, setLot] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const start = useWorkspaceMutation((w, body: object) => api(`/w/${w}/work-orders/${wo.id}/start`, { method: 'POST', body }))
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Start {wo.number ?? 'the work order'}</DialogTitle>
          <DialogDescription>The materials leave {wo.warehouse.name} now, the lot that expires first going first (never an expired one). Change a quantity if more or less was used; name a lot to take that one.</DialogDescription>
        </DialogHeader>
        <FormError message={error} />
        <div className="grid gap-2">
          <Label htmlFor="start-date">Date</Label>
          <Input id="start-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" />
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Material</TableHead>
              <TableHead className="text-right">On hand</TableHead>
              <TableHead className="w-28">Use</TableHead>
              <TableHead className="w-32">Lot (optional)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {wo.materials.map((m) => (
              <TableRow key={m.id}>
                <TableCell>
                  {m.item.name}
                  <span className="text-muted-foreground block text-xs">
                    Planned {formatQty(m.plannedQty)} {m.item.unit}
                  </span>
                </TableCell>
                <TableCell className={cn('text-right tabular-nums', m.onHand < Number(qty[m.id]) && 'text-destructive')}>{formatQty(m.onHand)}</TableCell>
                <TableCell>
                  <Input aria-label={`Quantity of ${m.item.name}`} inputMode="decimal" value={qty[m.id]} onChange={(e) => setQty({ ...qty, [m.id]: e.target.value })} />
                </TableCell>
                <TableCell>{m.item.trackLots ? <Input aria-label={`Lot of ${m.item.name}`} value={lot[m.id] ?? ''} onChange={(e) => setLot({ ...lot, [m.id]: e.target.value })} placeholder="Earliest" /> : '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Back
          </Button>
          <Button
            disabled={start.isPending}
            onClick={() => {
              setError(undefined)
              start.mutate({ date, materials: wo.materials.map((m) => ({ materialId: m.id, quantity: Number(qty[m.id] || 0), lotNo: lot[m.id] || undefined })) }, { onSuccess: onClose, onError: (e) => setError(e.message) })
            }}
          >
            {start.isPending ? 'Starting…' : 'Issue materials and start'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CompleteDialog({ wo, onClose }: { wo: WorkOrder; onClose: () => void }) {
  const workspaceId = useWorkspaceId()
  const product = useQuery(inventoryQueries.item(workspaceId, wo.item.id))
  const [date, setDate] = useState(today())
  const [good, setGood] = useState(String(wo.quantity))
  const [rejected, setRejected] = useState('0')
  const [lotNo, setLotNo] = useState(`${wo.item.sku}-${today().replace(/-/g, '').slice(2)}`)
  const [expiry, setExpiry] = useState('')
  const [minutes, setMinutes] = useState(() => Object.fromEntries(wo.operations.map((o) => [o.id, String(o.plannedMinutes)])))
  const [qc, setQc] = useState(() => wo.qcChecks.map(() => ({ passed: true, note: '' })))
  const [error, setError] = useState<string>()
  const complete = useWorkspaceMutation((w, body: object) => api(`/w/${w}/work-orders/${wo.id}/complete`, { method: 'POST', body }))
  const tracksLots = product.data?.trackLots
  const tracksExpiry = product.data?.trackExpiry
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Complete {wo.number}</DialogTitle>
          <DialogDescription>Record what was made and the quality checks. Good units go into stock at what they cost; rejected ones are written off.</DialogDescription>
        </DialogHeader>
        <FormError message={error} />
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-2">
            <Label htmlFor="c-date">Date</Label>
            <Input id="c-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="c-good">Good ({wo.item.unit})</Label>
            <Input id="c-good" inputMode="decimal" value={good} onChange={(e) => setGood(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="c-rej">Rejected</Label>
            <Input id="c-rej" inputMode="decimal" value={rejected} onChange={(e) => setRejected(e.target.value)} />
          </div>
          {tracksLots && (
            <div className="grid gap-2">
              <Label htmlFor="c-lot">Batch / lot number</Label>
              <Input id="c-lot" value={lotNo} onChange={(e) => setLotNo(e.target.value)} />
            </div>
          )}
          {tracksExpiry && (
            <div className="grid gap-2">
              <Label htmlFor="c-exp">Best before</Label>
              <Input id="c-exp" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
            </div>
          )}
        </div>
        {wo.qcChecks.length > 0 && (
          <div className="grid gap-2">
            <p className="text-sm font-medium">Quality checks</p>
            {wo.qcChecks.map((check, i) => (
              <div key={check} className="grid gap-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm">{check}</span>
                  <div className="flex gap-1">
                    {[true, false].map((pass) => (
                      <Button key={String(pass)} type="button" size="sm" variant={qc[i]!.passed === pass ? (pass ? 'default' : 'destructive') : 'outline'} onClick={() => setQc(qc.map((c, j) => (j === i ? { ...c, passed: pass } : c)))}>
                        {pass ? 'Pass' : 'Fail'}
                      </Button>
                    ))}
                  </div>
                </div>
                {!qc[i]!.passed && <Input aria-label={`What went wrong: ${check}`} placeholder="What went wrong" value={qc[i]!.note} onChange={(e) => setQc(qc.map((c, j) => (j === i ? { ...c, note: e.target.value } : c)))} />}
              </div>
            ))}
          </div>
        )}
        {wo.operations.length > 0 && (
          <div className="grid gap-2">
            <p className="text-sm font-medium">Minutes spent</p>
            {wo.operations.map((o) => (
              <div key={o.id} className="flex items-center gap-3">
                <span className="flex-1 text-sm">
                  {o.description} <span className="text-muted-foreground">· {o.workCenter.name}</span>
                </span>
                <Input aria-label={`Minutes for ${o.description}`} inputMode="decimal" className="w-24" value={minutes[o.id]} onChange={(e) => setMinutes({ ...minutes, [o.id]: e.target.value })} />
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Back
          </Button>
          <Button
            disabled={complete.isPending}
            onClick={() => {
              setError(undefined)
              complete.mutate(
                {
                  date,
                  goodQty: Number(good || 0),
                  rejectedQty: Number(rejected || 0),
                  lotNo: tracksLots ? lotNo : undefined,
                  expiryDate: tracksExpiry ? expiry || null : null,
                  operations: wo.operations.map((o) => ({ operationId: o.id, minutes: Number(minutes[o.id] || 0) })),
                  qc: qc.map((c) => ({ passed: c.passed, note: c.note || undefined })),
                },
                { onSuccess: onClose, onError: (e) => setError(e.message) },
              )
            }}
          >
            {complete.isPending ? 'Completing…' : 'Complete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function WorkOrderPage({ id }: { id: string }) {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const navigate = useNavigate()
  const q = useQuery(mfgQueries.workOrder(workspaceId, id))
  const [dialog, setDialog] = useState<'start' | 'complete' | null>(null)
  const [error, setError] = useState<string>()
  const act = useWorkspaceMutation((w, action: 'release' | 'cancel') => api(`/w/${w}/work-orders/${id}/${action}`, { method: 'POST' }))
  const remove = useWorkspaceMutation((w) => api(`/w/${w}/work-orders/${id}`, { method: 'DELETE' }))
  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Loading />
  const wo = q.data
  const manage = can('manufacturing.manage')
  const run = (action: 'release' | 'cancel') => act.mutate(action, { onError: (e) => setError(e.message) })
  const plannedConversion = wo.operations.reduce((s, o) => s + o.cost, 0)
  return (
    <div className="space-y-6">
      <PageHeader
        title={wo.number ?? 'Draft work order'}
        description={
          <>
            {formatQty(wo.quantity)} {wo.item.unit} of{' '}
            <Link to="/w/$workspaceId/inventory/items/$id" params={{ workspaceId, id: wo.item.id }} className="text-foreground hover:underline">
              {wo.item.name}
            </Link>{' '}
            from{' '}
            <Link to="/w/$workspaceId/manufacturing/boms/$id" params={{ workspaceId, id: wo.bom.id }} className="text-foreground hover:underline">
              {wo.bom.code}
            </Link>{' '}
            · {formatDate(wo.startDate)} to {formatDate(wo.dueDate)} · {wo.warehouse.name}
          </>
        }
        actions={
          <>
            {manage && wo.status === 'draft' && (
              <>
                <Button variant="outline" asChild>
                  <Link to="/w/$workspaceId/manufacturing/work-orders/$id/edit" params={{ workspaceId, id }}>
                    <Pencil />
                    Edit
                  </Link>
                </Button>
                <Button variant="outline" onClick={() => run('release')} disabled={act.isPending}>
                  Release
                </Button>
              </>
            )}
            {manage && (wo.status === 'draft' || wo.status === 'released') && (
              <Button onClick={() => setDialog('start')}>
                <CirclePlay />
                Start
              </Button>
            )}
            {manage && wo.status === 'in_progress' && (
              <Button onClick={() => setDialog('complete')}>
                <CheckCircle2 />
                Complete
              </Button>
            )}
            {manage && ['draft', 'released', 'in_progress'].includes(wo.status) && (
              <Button
                variant="outline"
                onClick={() => confirm(wo.status === 'in_progress' ? 'Cancel it? Its materials go back to stock.' : 'Cancel this work order?') && run('cancel')}
                disabled={act.isPending}
              >
                <X />
                Cancel
              </Button>
            )}
            {manage && wo.status === 'draft' && (
              <Button
                variant="ghost"
                aria-label="Delete draft"
                onClick={() => confirm('Delete this draft?') && remove.mutate(undefined, { onSuccess: () => void navigate({ to: '/w/$workspaceId/manufacturing/work-orders', params: { workspaceId } }) })}
              >
                <Trash2 />
              </Button>
            )}
            <Button variant="ghost" onClick={() => print()} aria-label="Print job ticket">
              <Printer />
            </Button>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <WoStatusBadge status={wo.status} late={wo.late} />
        {wo.salesOrder && (
          <span className="text-muted-foreground text-sm">
            For {wo.salesOrder.number} · {wo.salesOrder.customer}
          </span>
        )}
        {wo.lot && (
          <span className="text-muted-foreground text-sm">
            Lot {wo.lot.lotNo}
            {wo.lot.expiryDate && `, best before ${formatDate(wo.lot.expiryDate)}`}
          </span>
        )}
      </div>
      <FormError message={error} />
      {wo.status === 'completed' && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Good" value={`${formatQty(wo.goodQty)} ${wo.item.unit}`} />
          <Stat label="Rejected" value={`${formatQty(wo.rejectedQty)} ${wo.item.unit}`} />
          <Stat label="Total cost" value={formatPeso(wo.materialCost + wo.conversionCost)} note={`Materials ${formatPeso(wo.materialCost)} + labour and overhead ${formatPeso(wo.conversionCost)}`} />
          <Stat label="Cost per unit" value={wo.unitCost !== null ? formatPeso(wo.unitCost) : '—'} />
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Materials</CardTitle>
          <CardDescription>{wo.status === 'draft' || wo.status === 'released' ? 'What starting will take out of stock.' : 'What went into Work in Process.'}</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Material</TableHead>
                <TableHead className="text-right">Planned</TableHead>
                <TableHead className="text-right">Used</TableHead>
                <TableHead className="pr-6 text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {wo.materials.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="pl-6">
                    {m.item.name}
                    {(wo.status === 'draft' || wo.status === 'released') && m.onHand < m.plannedQty && (
                      <span className="text-destructive block text-xs">
                        Short: {formatQty(m.onHand)} {m.item.unit} on hand
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQty(m.plannedQty)} {m.item.unit}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{m.issuedQty ? `${formatQty(m.issuedQty)} ${m.item.unit}` : '—'}</TableCell>
                  <TableCell className="pr-6 text-right">{m.issuedValue ? <Money value={m.issuedValue} /> : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            {wo.materialCost > 0 && (
              <TableFooter>
                <TableRow>
                  <TableCell className="pl-6" colSpan={3}>
                    Materials
                  </TableCell>
                  <TableCell className="pr-6 text-right">
                    <Money value={wo.materialCost} />
                  </TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </CardContent>
      </Card>
      {wo.operations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Routing</CardTitle>
            <CardDescription>The steps, and the labour and overhead each adds.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Step</TableHead>
                  <TableHead>Work centre</TableHead>
                  <TableHead className="text-right">Planned</TableHead>
                  <TableHead className="text-right">Actual</TableHead>
                  <TableHead className="pr-6 text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {wo.operations.map((o, i) => (
                  <TableRow key={o.id}>
                    <TableCell className="pl-6">
                      {i + 1}. {o.description}
                    </TableCell>
                    <TableCell>{o.workCenter.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMinutes(o.plannedMinutes)}</TableCell>
                    <TableCell className="text-right tabular-nums">{o.actualMinutes !== null ? formatMinutes(o.actualMinutes) : '—'}</TableCell>
                    <TableCell className="pr-6 text-right">
                      <Money value={o.cost} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="pl-6" colSpan={4}>
                    Labour and overhead{wo.status !== 'completed' && ' (planned)'}
                  </TableCell>
                  <TableCell className="pr-6 text-right">
                    <Money value={wo.status === 'completed' ? wo.conversionCost : plannedConversion} />
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>
      )}
      {wo.qcChecks.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Quality control</CardTitle>
            <CardDescription>{wo.qc.length ? 'Recorded when it was completed.' : 'Recorded when it’s completed.'}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {wo.qcChecks.map((check, i) => {
              const r = wo.qc[i]
              return (
                <div key={check} className="flex items-start gap-2 text-sm">
                  {!r ? <ClipboardCheck className="text-muted-foreground mt-0.5 size-4 shrink-0" /> : r.passed ? <CheckCircle2 className="text-success mt-0.5 size-4 shrink-0" /> : <XCircle className="text-destructive mt-0.5 size-4 shrink-0" />}
                  <span>
                    {check}
                    {r?.note && <span className="text-muted-foreground block">{r.note}</span>}
                  </span>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}
      {wo.entries.length > 0 && (
        <p className="text-muted-foreground text-sm print:hidden">
          In the books:{' '}
          {wo.entries.map((e, i) => (
            <span key={e.id}>
              {i > 0 && ', '}
              <Link to="/w/$workspaceId/finance/journal/$id" params={{ workspaceId, id: e.id }} className="text-foreground hover:underline">
                {e.number ?? 'entry'}
              </Link>{' '}
              ({e.memo})
            </span>
          ))}
        </p>
      )}
      {wo.notes && <p className="text-sm whitespace-pre-wrap">{wo.notes}</p>}
      {dialog === 'start' && <StartDialog wo={wo} onClose={() => setDialog(null)} />}
      {dialog === 'complete' && <CompleteDialog wo={wo} onClose={() => setDialog(null)} />}
    </div>
  )
}

/* =============================================================================================
 * Bills of materials
 * =========================================================================================== */

export function BomsPage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const q = useQuery(mfgQueries.boms(workspaceId))
  return (
    <div>
      <PageHeader
        title="Bills of materials"
        description="Recipes and formulas: what one batch of a product takes, the steps, and the quality checks."
        actions={
          can('manufacturing.manage') && (
            <Button asChild>
              <Link to="/w/$workspaceId/manufacturing/boms/new" params={{ workspaceId }}>
                <Plus />
                New bill of materials
              </Link>
            </Button>
          )
        }
      />
      {q.error ? (
        <LoadError error={q.error} />
      ) : !q.data ? (
        <Loading />
      ) : q.data.length === 0 ? (
        <EmptyState title="No bills of materials yet">Say what one batch of a product takes, and work orders and planning follow from it.</EmptyState>
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Product</TableHead>
                <TableHead>Code</TableHead>
                <TableHead className="text-right">Batch</TableHead>
                <TableHead className="text-right">Components</TableHead>
                <TableHead className="text-right">Cost per unit</TableHead>
                <TableHead className="pr-6" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((b) => (
                <TableRow key={b.id} className={cn(!b.active && 'text-muted-foreground')}>
                  <TableCell className="pl-6">
                    <Link to="/w/$workspaceId/manufacturing/boms/$id" params={{ workspaceId, id: b.id }} className="font-medium hover:underline">
                      {b.item.name}
                    </Link>
                  </TableCell>
                  <TableCell>{b.code}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQty(b.outputQty)} {b.item.unit}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{b.componentCount}</TableCell>
                  <TableCell className="text-right">
                    <Money value={b.unitCost} />
                  </TableCell>
                  <TableCell className="pr-6">{b.active ? <Badge variant="success">Active</Badge> : <Badge variant="secondary">Old version</Badge>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  )
}

export function BomPage({ id }: { id: string }) {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const navigate = useNavigate()
  const q = useQuery(mfgQueries.bom(workspaceId, id))
  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Loading />
  const b = q.data
  const batch = b.materialCost + b.conversionCost
  return (
    <div className="space-y-6">
      <PageHeader
        title={b.item.name}
        description={
          <>
            {b.code} · a batch makes {formatQty(b.outputQty)} {b.item.unit} · {b.active ? 'active' : 'an older version'}
          </>
        }
        actions={
          can('manufacturing.manage') && (
            <>
              <Button variant="outline" asChild>
                <Link to="/w/$workspaceId/manufacturing/boms/$id/edit" params={{ workspaceId, id }}>
                  <Pencil />
                  Edit
                </Link>
              </Button>
              <Button variant="outline" onClick={() => void navigate({ to: '/w/$workspaceId/manufacturing/boms/new', params: { workspaceId }, search: { copy: id } })}>
                <Copy />
                New version
              </Button>
              {b.active && (
                <Button onClick={() => void navigate({ to: '/w/$workspaceId/manufacturing/work-orders/new', params: { workspaceId }, search: { itemId: b.item.id, quantity: String(b.outputQty) } })}>
                  <Factory />
                  Make it
                </Button>
              )}
            </>
          )
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Materials per batch" value={formatPeso(b.materialCost)} note="At today’s average costs" />
        <Stat label="Labour and overhead" value={formatPeso(b.conversionCost)} />
        <Stat label="Batch" value={formatPeso(batch)} />
        <Stat label="Per unit" value={formatPeso(b.unitCost)} note={`Per ${b.item.unit}`} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Components</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Component</TableHead>
                <TableHead className="text-right">Per batch</TableHead>
                <TableHead className="text-right">Unit cost</TableHead>
                <TableHead className="pr-6 text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {b.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="pl-6">
                    <Link to="/w/$workspaceId/inventory/items/$id" params={{ workspaceId, id: l.item.id }} className="hover:underline">
                      {l.item.name}
                    </Link>
                    {l.item.made && (
                      <Badge variant="outline" className="ml-2">
                        Made here
                      </Badge>
                    )}
                    {l.notes && <span className="text-muted-foreground block text-xs">{l.notes}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQty(l.quantity)} {l.item.unit}
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={l.averageCost} />
                  </TableCell>
                  <TableCell className="pr-6 text-right">
                    <Money value={Math.round(l.quantity * l.averageCost)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {b.operations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Routing</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableBody>
                {b.operations.map((o, i) => (
                  <TableRow key={o.id}>
                    <TableCell className="pl-6">
                      {i + 1}. {o.description}
                    </TableCell>
                    <TableCell>{o.workCenter.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMinutes(o.minutes)}</TableCell>
                    <TableCell className="pr-6 text-right">
                      <Money value={o.cost} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Quality checks</CardTitle>
          </CardHeader>
          <CardContent>
            {b.qcChecks.length ? (
              <ul className="grid gap-2 text-sm">
                {b.qcChecks.map((c) => (
                  <li key={c} className="flex gap-2">
                    <ClipboardCheck className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                    {c}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">None.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Used in</CardTitle>
          </CardHeader>
          <CardContent>
            {b.usedIn.length ? (
              <ul className="grid gap-2 text-sm">
                {b.usedIn.map((u) => (
                  <li key={u.id}>
                    <Link to="/w/$workspaceId/manufacturing/boms/$id" params={{ workspaceId, id: u.id }} className="hover:underline">
                      {u.item.name}
                    </Link>{' '}
                    <span className="text-muted-foreground">{u.code}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">Not a component of anything else.</p>
            )}
          </CardContent>
        </Card>
      </div>
      {b.notes && <p className="text-sm whitespace-pre-wrap">{b.notes}</p>}
    </div>
  )
}

type BomDraft = { itemId: string; outputQty: string; active: boolean; notes: string; lines: { itemId: string; quantity: string; notes: string }[]; operations: { workCenterId: string; description: string; minutes: string }[]; qcChecks: string[] }

export function BomFormPage({ id, copy }: { id?: string; copy?: string }) {
  const workspaceId = useWorkspaceId()
  const navigate = useNavigate()
  const source = id ?? copy
  const existing = useQuery({ ...mfgQueries.bom(workspaceId, source ?? ''), enabled: !!source })
  const itemsQ = useQuery(inventoryQueries.items(workspaceId))
  const centres = useQuery(mfgQueries.workCenters(workspaceId))
  const [draft, setDraft] = useState<BomDraft | null>(null)
  const [error, setError] = useState<string>()
  const save = useWorkspaceMutation((w, body: BomInput) => (id ? api<{ bom: { id: string } }>(`/w/${w}/boms/${id}`, { method: 'PUT', body }) : api<{ bom: { id: string } }>(`/w/${w}/boms`, { method: 'POST', body })))
  if (!itemsQ.data || !centres.data || (source && !existing.data)) return <Loading />
  const stock = itemsQ.data.filter((i) => i.kind === 'stock' && i.active)
  const e = existing.data
  const d: BomDraft = draft ?? {
    itemId: e?.item.id ?? '',
    outputQty: e ? String(e.outputQty) : '1',
    active: e ? (copy ? true : e.active) : true,
    notes: e?.notes ?? '',
    lines: e ? e.lines.map((l) => ({ itemId: l.item.id, quantity: String(l.quantity), notes: l.notes ?? '' })) : [{ itemId: '', quantity: '', notes: '' }],
    operations: e ? e.operations.map((o) => ({ workCenterId: o.workCenter.id, description: o.description, minutes: String(o.minutes) })) : [],
    qcChecks: e ? e.qcChecks : [],
  }
  const set = (patch: Partial<BomDraft>) => setDraft({ ...d, ...patch })
  const unitOf = (itemId: string) => stock.find((i) => i.id === itemId)?.unit.code ?? ''
  return (
    <div className="max-w-4xl">
      <PageHeader title={id ? `Edit ${e?.code}` : copy ? `New version of ${e?.item.name}` : 'New bill of materials'} description={copy ? 'The new version replaces the active one when it’s saved as active. Work orders already made keep theirs.' : undefined} />
      <form
        className="grid gap-6"
        onSubmit={(ev) => {
          ev.preventDefault()
          setError(undefined)
          save.mutate(
            {
              itemId: d.itemId,
              outputQty: Number(d.outputQty),
              active: d.active,
              notes: d.notes,
              lines: d.lines.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity), notes: l.notes })),
              operations: d.operations.filter((o) => o.workCenterId).map((o) => ({ workCenterId: o.workCenterId, description: o.description, minutes: Number(o.minutes || 0) })),
              qcChecks: d.qcChecks.map((c) => c.trim()).filter(Boolean),
            },
            { onSuccess: (r) => void navigate({ to: '/w/$workspaceId/manufacturing/boms/$id', params: { workspaceId, id: r.bom.id } }), onError: (er) => setError(er.message) },
          )
        }}
      >
        <FormError message={error} />
        <div className="grid gap-5 sm:grid-cols-[1fr_10rem]">
          <div className="grid gap-2">
            <Label htmlFor="bom-item">Product</Label>
            <NativeSelect id="bom-item" value={d.itemId} onChange={(ev) => set({ itemId: ev.target.value })} disabled={!!id} required>
              <option value="">Choose…</option>
              {stock.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} ({i.sku})
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="bom-out">Batch makes{d.itemId && ` (${unitOf(d.itemId)})`}</Label>
            <Input id="bom-out" inputMode="decimal" value={d.outputQty} onChange={(ev) => set({ outputQty: ev.target.value })} required />
          </div>
        </div>

        <fieldset className="grid gap-3">
          <legend className="mb-2 text-sm font-medium">Components, per batch</legend>
          {d.lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_7rem_auto] gap-2">
              <NativeSelect aria-label={`Component ${i + 1}`} value={l.itemId} onChange={(ev) => set({ lines: d.lines.map((x, j) => (j === i ? { ...x, itemId: ev.target.value } : x)) })}>
                <option value="">Choose…</option>
                {stock
                  .filter((s) => s.id !== d.itemId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </NativeSelect>
              <Input aria-label={`Quantity of component ${i + 1}`} inputMode="decimal" placeholder={unitOf(l.itemId)} value={l.quantity} onChange={(ev) => set({ lines: d.lines.map((x, j) => (j === i ? { ...x, quantity: ev.target.value } : x)) })} />
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove component ${i + 1}`} onClick={() => set({ lines: d.lines.filter((_, j) => j !== i) })}>
                <X />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => set({ lines: [...d.lines, { itemId: '', quantity: '', notes: '' }] })}>
            <Plus />
            Add a component
          </Button>
        </fieldset>

        <fieldset className="grid gap-3">
          <legend className="mb-1 text-sm font-medium">Routing: the steps, in order</legend>
          {centres.data.length === 0 && (
            <p className="text-muted-foreground text-sm">
              Add{' '}
              <Link to="/w/$workspaceId/manufacturing/work-centers" params={{ workspaceId }} className="text-foreground underline">
                work centres
              </Link>{' '}
              to cost labour and overhead.
            </p>
          )}
          {d.operations.map((o, i) => (
            <div key={i} className="grid grid-cols-[10rem_1fr_6rem_auto] gap-2">
              <NativeSelect aria-label={`Work centre for step ${i + 1}`} value={o.workCenterId} onChange={(ev) => set({ operations: d.operations.map((x, j) => (j === i ? { ...x, workCenterId: ev.target.value } : x)) })}>
                <option value="">Where…</option>
                {centres.data
                  .filter((c) => c.active)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </NativeSelect>
              <Input aria-label={`Step ${i + 1}`} placeholder="What’s done" value={o.description} onChange={(ev) => set({ operations: d.operations.map((x, j) => (j === i ? { ...x, description: ev.target.value } : x)) })} />
              <Input aria-label={`Minutes for step ${i + 1}`} inputMode="decimal" placeholder="min" value={o.minutes} onChange={(ev) => set({ operations: d.operations.map((x, j) => (j === i ? { ...x, minutes: ev.target.value } : x)) })} />
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove step ${i + 1}`} onClick={() => set({ operations: d.operations.filter((_, j) => j !== i) })}>
                <X />
              </Button>
            </div>
          ))}
          {centres.data.length > 0 && (
            <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => set({ operations: [...d.operations, { workCenterId: '', description: '', minutes: '' }] })}>
              <Plus />
              Add a step
            </Button>
          )}
        </fieldset>

        <fieldset className="grid gap-3">
          <legend className="mb-1 text-sm font-medium">Quality checks, recorded on every work order</legend>
          {d.qcChecks.map((c, i) => (
            <div key={i} className="grid grid-cols-[1fr_auto] gap-2">
              <Input aria-label={`Check ${i + 1}`} placeholder="e.g. Weight 25 kg ± 100 g" value={c} onChange={(ev) => set({ qcChecks: d.qcChecks.map((x, j) => (j === i ? ev.target.value : x)) })} />
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove check ${i + 1}`} onClick={() => set({ qcChecks: d.qcChecks.filter((_, j) => j !== i) })}>
                <X />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => set({ qcChecks: [...d.qcChecks, ''] })}>
            <Plus />
            Add a check
          </Button>
        </fieldset>

        <div className="grid gap-2">
          <Label htmlFor="bom-notes">Notes</Label>
          <Textarea id="bom-notes" value={d.notes} onChange={(ev) => set({ notes: ev.target.value })} placeholder="Method, allergens, storage…" />
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="bom-active" checked={d.active} onCheckedChange={(c) => set({ active: c === true })} />
          <Label htmlFor="bom-active" className="font-normal">
            Active: the one work orders and planning use
          </Label>
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
 * Planning (MRP)
 * =========================================================================================== */

export function PlanningPage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const navigate = useNavigate()
  const q = useQuery(mfgQueries.mrp(workspaceId))
  const suppliers = useQuery(financeQueries.contacts(workspaceId, 'supplier'))
  const warehouses = useQuery(inventoryQueries.warehouses(workspaceId))
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [supplierFor, setSupplierFor] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const [done, setDone] = useState<string>()
  const makeAll = useWorkspaceMutation(async (w, rows: MrpRow[]) => {
    for (const r of rows) {
      await api(`/w/${w}/work-orders`, { method: 'POST', body: { itemId: r.item.id, quantity: r.suggested, warehouseId: warehouses.data![0]!.id, startDate: today(), dueDate: addDays(today(), 3), notes: 'From the production plan (MRP)' } })
    }
  })
  const buyAll = useWorkspaceMutation((w, body: object) => api<{ purchaseOrders: { id: string; supplier: string }[] }>(`/w/${w}/mrp/purchase-orders`, { method: 'POST', body }))
  if (q.error) return <LoadError error={q.error} />
  if (!q.data || !suppliers.data || !warehouses.data) return <Loading />
  const rows = q.data.rows
  const needed = rows.filter((r) => r.suggested > 0)
  const chosen = (action: 'make' | 'buy') => needed.filter((r) => r.action === action && (picked[r.item.id] ?? true))
  const supplierOf = (r: MrpRow) => supplierFor[r.item.id] ?? r.supplier?.id ?? ''
  return (
    <div className="space-y-6">
      <PageHeader
        title="Production plan"
        description="What open sales orders, reorder points and work orders need, against what’s on hand and on its way. Products are planned first; their materials follow from the bills of materials."
      />
      {error && <FormError message={error} />}
      {done && <p className="text-success text-sm">{done}</p>}
      {needed.length === 0 ? (
        <EmptyState title="Nothing to make or buy">Everything open is covered by stock, purchase orders and work orders.</EmptyState>
      ) : (
        <div className="flex flex-wrap gap-2">
          {can('manufacturing.manage') && chosen('make').length > 0 && (
            <Button
              disabled={makeAll.isPending}
              onClick={() =>
                makeAll.mutate(chosen('make'), {
                  onSuccess: () => {
                    setDone(`${chosen('make').length} draft work order(s) made. Release them from Work orders.`)
                    void navigate({ to: '/w/$workspaceId/manufacturing/work-orders', params: { workspaceId } })
                  },
                  onError: (e) => setError(e.message),
                })
              }
            >
              <Factory />
              Make {chosen('make').length} draft work order{chosen('make').length === 1 ? '' : 's'}
            </Button>
          )}
          {can('purchasing.manage') && chosen('buy').length > 0 && (
            <Button
              variant="outline"
              disabled={buyAll.isPending}
              onClick={() => {
                setError(undefined)
                const lines = chosen('buy').map((r) => ({ itemId: r.item.id, supplierId: supplierOf(r), quantity: r.suggested, unitCost: r.unitCost }))
                if (lines.some((l) => !l.supplierId)) return setError('Choose a supplier for each item to buy.')
                buyAll.mutate(
                  { warehouseId: warehouses.data[0]!.id, lines },
                  { onSuccess: (r) => setDone(`Draft purchase orders to ${r.purchaseOrders.map((p) => p.supplier).join(', ')}. Check and issue them in Inventory → Purchase orders.`), onError: (e) => setError(e.message) },
                )
              }}
            >
              Draft purchase orders for {chosen('buy').length} item{chosen('buy').length === 1 ? '' : 's'}
            </Button>
          )}
        </div>
      )}
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8 pl-6" />
              <TableHead>Item</TableHead>
              <TableHead className="text-right">Needed</TableHead>
              <TableHead className="text-right">On hand</TableHead>
              <TableHead className="text-right">Coming</TableHead>
              <TableHead className="text-right">Reorder at</TableHead>
              <TableHead className="text-right">Suggested</TableHead>
              <TableHead className="pr-6">From</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const need = r.demand.salesOrders + r.demand.workOrders + r.demand.planned
              return (
                <TableRow key={r.item.id} className={cn(r.suggested === 0 && 'text-muted-foreground')}>
                  <TableCell className="pl-6">
                    {r.suggested > 0 && <Checkbox aria-label={`Include ${r.item.name}`} checked={picked[r.item.id] ?? true} onCheckedChange={(c) => setPicked({ ...picked, [r.item.id]: c === true })} />}
                  </TableCell>
                  <TableCell style={{ paddingLeft: `${0.5 + r.level * 1.25}rem` }}>
                    <span className="font-medium">{r.item.name}</span>
                    <span className="text-muted-foreground block text-xs">
                      {r.action === 'make' ? 'Made here' : 'Bought'}
                      {r.demand.salesOrders > 0 && ` · ${formatQty(r.demand.salesOrders)} on sales orders`}
                      {r.demand.workOrders + r.demand.planned > 0 && ` · ${formatQty(r.demand.workOrders + r.demand.planned)} for production`}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(need)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(r.onHand)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(r.incoming.purchaseOrders + r.incoming.workOrders)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(r.reorderPoint)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{r.suggested > 0 ? `${r.action === 'make' ? 'Make' : 'Buy'} ${formatQty(r.suggested)} ${r.item.unit}` : '—'}</TableCell>
                  <TableCell className="pr-6">
                    {r.suggested > 0 && r.action === 'buy' ? (
                      <NativeSelect aria-label={`Supplier for ${r.item.name}`} value={supplierOf(r)} onChange={(e) => setSupplierFor({ ...supplierFor, [r.item.id]: e.target.value })} className="min-w-40">
                        <option value="">Supplier…</option>
                        {suppliers.data.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </NativeSelect>
                    ) : r.action === 'make' ? (
                      <span className="text-muted-foreground text-sm">Work order</span>
                    ) : null}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}

/* =============================================================================================
 * Work centres
 * =========================================================================================== */

function WorkCenterDialog({ centre, onClose }: { centre?: WorkCenter; onClose: () => void }) {
  const [code, setCode] = useState(centre?.code ?? '')
  const [name, setName] = useState(centre?.name ?? '')
  const [rate, setRate] = useState(centre ? centavosToInput(centre.costPerHour) : '')
  const [active, setActive] = useState(centre?.active ?? true)
  const [error, setError] = useState<string>()
  const save = useWorkspaceMutation((w, body: object) => (centre ? api(`/w/${w}/work-centers/${centre.id}`, { method: 'PUT', body }) : api(`/w/${w}/work-centers`, { method: 'POST', body })))
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{centre ? `Edit ${centre.name}` : 'New work centre'}</DialogTitle>
          <DialogDescription>A room, line or machine. Its hourly cost (wages and overhead) goes into what’s made there.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            const costPerHour = parsePeso(rate)
            if (costPerHour === null) return setError('Enter the cost per hour, like 450.00.')
            save.mutate({ code, name, costPerHour, active }, { onSuccess: onClose, onError: (er) => setError(er.message) })
          }}
        >
          <FormError message={error} />
          <div className="grid grid-cols-[8rem_1fr] gap-3">
            <div className="grid gap-2">
              <Label htmlFor="wc-code">Code</Label>
              <Input id="wc-code" value={code} onChange={(e) => setCode(e.target.value)} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="wc-name">Name</Label>
              <Input id="wc-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="wc-rate">Cost per hour (₱)</Label>
            <Input id="wc-rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} required />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="wc-active" checked={active} onCheckedChange={(c) => setActive(c === true)} />
            <Label htmlFor="wc-active" className="font-normal">
              In use
            </Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function WorkCentersPage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const q = useQuery(mfgQueries.workCenters(workspaceId))
  const [editing, setEditing] = useState<WorkCenter | 'new' | null>(null)
  return (
    <div>
      <PageHeader
        title="Work centres"
        description="Where work is done, and what an hour there costs."
        actions={
          can('manufacturing.manage') && (
            <Button onClick={() => setEditing('new')}>
              <Plus />
              New work centre
            </Button>
          )
        }
      />
      {q.error ? (
        <LoadError error={q.error} />
      ) : !q.data ? (
        <Loading />
      ) : q.data.length === 0 ? (
        <EmptyState title="No work centres yet">Add the mixing room, the packing line, the oven: whatever has a cost per hour.</EmptyState>
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Per hour</TableHead>
                <TableHead className="pr-6" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((c) => (
                <TableRow key={c.id} className={cn(!c.active && 'text-muted-foreground')}>
                  <TableCell className="pl-6 font-medium">{c.code}</TableCell>
                  <TableCell>
                    {c.name}
                    {!c.active && ' (not in use)'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={c.costPerHour} />
                  </TableCell>
                  <TableCell className="pr-6 text-right">
                    {can('manufacturing.manage') && (
                      <Button variant="ghost" size="sm" onClick={() => setEditing(c)}>
                        <Pencil />
                        Edit
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {editing && <WorkCenterDialog centre={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
