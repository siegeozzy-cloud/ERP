import {
  centavosToInput,
  computeLine,
  computeTotals,
  formatPeso,
  formatRate,
  parsePeso,
  PO_STATUS_LABELS,
  VAT_TREATMENT_LABELS,
  VAT_TREATMENTS,
  type PoStatus,
  type PurchaseOrder,
  type VatTreatment,
} from '@erp/shared'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Ban, CheckCheck, FileText, PackageCheck, Pencil, Plus, Printer, Send, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { FormError } from '@/components/form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { EmptyState, LoadError, Loading, Money, PageHeader } from '@/features/finance/components'
import { financeQueries, useWorkspaceMutation } from '@/features/finance/queries'
import { useCan, useWorkspace, useWorkspaceId } from '@/features/workspaces/queries'
import { api } from '@/lib/api'
import { formatDate, today } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { formatQty, inventoryQueries } from './queries'

const STATUS_VARIANT: Record<PoStatus, 'outline' | 'default' | 'secondary' | 'success'> = {
  draft: 'outline',
  issued: 'default',
  partly_received: 'default',
  received: 'success',
  closed: 'secondary',
  cancelled: 'secondary',
}

export function PoStatusBadge({ status }: { status: PoStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{PO_STATUS_LABELS[status]}</Badge>
}

export function PurchaseOrdersPage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const navigate = useNavigate()
  const [status, setStatus] = useState<PoStatus | ''>('')
  const q = useQuery(inventoryQueries.purchaseOrders(workspaceId, status || undefined))
  const newButton = (
    <Button asChild>
      <Link to="/w/$workspaceId/inventory/purchase-orders/new" params={{ workspaceId }}>
        <Plus />
        New purchase order
      </Link>
    </Button>
  )
  return (
    <div>
      <PageHeader title="Purchase orders" description="Order from suppliers, receive what arrives, then bill it." actions={can('purchasing.manage') ? newButton : undefined} />
      <NativeSelect aria-label="Show" className="mb-4 w-48" value={status} onChange={(e) => setStatus(e.target.value as PoStatus | '')}>
        <option value="">All</option>
        {Object.entries(PO_STATUS_LABELS).map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </NativeSelect>
      {q.error ? (
        <LoadError error={q.error} />
      ) : !q.data ? (
        <Loading />
      ) : q.data.length === 0 ? (
        <EmptyState title="No purchase orders" action={can('purchasing.manage') && !status ? newButton : undefined} />
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="hidden md:table-cell">Deliver to</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((po) => (
                <TableRow key={po.id} className="cursor-pointer" onClick={() => void navigate({ to: '/w/$workspaceId/inventory/purchase-orders/$id', params: { workspaceId, id: po.id } })}>
                  <TableCell className="font-medium whitespace-nowrap">{po.number ?? 'Draft'}</TableCell>
                  <TableCell className="max-w-56 truncate">{po.supplier.name}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(po.date)}</TableCell>
                  <TableCell className="text-muted-foreground hidden md:table-cell">{po.warehouse.name}</TableCell>
                  <TableCell className="text-right">
                    <Money value={po.total} />
                  </TableCell>
                  <TableCell>
                    <PoStatusBadge status={po.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

type Line = { itemId: string; description: string; quantity: string; unitCost: string; vat: VatTreatment; ewtCodeId: string }

export function PurchaseOrderFormPage({ id }: { id?: string }) {
  const workspaceId = useWorkspaceId()
  const existing = useQuery({ ...inventoryQueries.purchaseOrder(workspaceId, id ?? ''), enabled: !!id })
  if (existing.error) return <LoadError error={existing.error} />
  if (id && !existing.data) return <Loading />
  if (existing.data && existing.data.status !== 'draft') return <p className="text-muted-foreground py-10 text-center text-sm">This purchase order has been issued, so it can’t be edited.</p>
  return <PoForm key={id ?? 'new'} existing={existing.data} />
}

function PoForm({ existing }: { existing?: PurchaseOrder }) {
  const workspace = useWorkspace()
  const workspaceId = workspace.id
  const navigate = useNavigate()
  const suppliers = useQuery(financeQueries.contacts(workspaceId, 'supplier'))
  const items = useQuery(inventoryQueries.items(workspaceId))
  const warehouses = useQuery(inventoryQueries.warehouses(workspaceId))
  const taxCodes = useQuery(financeQueries.taxCodes(workspaceId))
  const defaultVat: VatTreatment = 'vatable'
  const [supplierId, setSupplierId] = useState(existing?.supplier.id ?? '')
  const [date, setDate] = useState(existing?.date ?? today())
  const [expectedDate, setExpectedDate] = useState(existing?.expectedDate ?? '')
  const [warehouseId, setWarehouseId] = useState(existing?.warehouse.id ?? '')
  const [pricesIncludeVat, setPricesIncludeVat] = useState(existing?.pricesIncludeVat ?? false)
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [lines, setLines] = useState<Line[]>(
    existing?.lines.map((l) => ({ itemId: l.item.id, description: l.description, quantity: String(l.quantity), unitCost: centavosToInput(l.unitCost), vat: l.vat, ewtCodeId: l.ewtCodeId ?? '' })) ?? [
      { itemId: '', description: '', quantity: '1', unitCost: '', vat: defaultVat, ewtCodeId: '' },
    ],
  )
  const [error, setError] = useState<string>()
  const save = useWorkspaceMutation(async (w, { body, issue }: { body: object; issue: boolean }) => {
    const { purchaseOrder } = existing
      ? await api<{ purchaseOrder: PurchaseOrder }>(`/w/${w}/purchase-orders/${existing.id}`, { method: 'PUT', body })
      : await api<{ purchaseOrder: PurchaseOrder }>(`/w/${w}/purchase-orders`, { method: 'POST', body })
    if (issue) await api(`/w/${w}/purchase-orders/${purchaseOrder.id}/issue`, { method: 'POST' })
    return purchaseOrder.id
  })

  if (!suppliers.data || !items.data || !warehouses.data || !taxCodes.data) return <Loading />
  const openWh = warehouses.data.filter((w) => w.active)
  const whId = warehouseId || openWh[0]?.id || ''
  const ewtCodes = taxCodes.data.filter((t) => t.kind === 'ewt' && t.active)
  const vatRate = taxCodes.data.filter((t) => t.code === 'VAT12' && t.effectiveFrom <= date).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]?.rateBp ?? 1200
  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const computed = lines.map((l) => {
    const q = Number(l.quantity)
    const p = parsePeso(l.unitCost)
    const ewt = ewtCodes.find((t) => t.id === l.ewtCodeId)
    return { ...(q > 0 && p !== null ? computeLine({ quantity: q, unitPrice: p, vat: l.vat, vatRateBp: vatRate, ewtRateBp: ewt?.rateBp }, pricesIncludeVat) : { gross: 0, net: 0, vatAmount: 0, ewtAmount: 0 }), vat: l.vat }
  })
  const totals = computeTotals(computed)

  async function submit(issue: boolean) {
    setError(undefined)
    if (!supplierId) return setError('Choose a supplier.')
    for (const [i, l] of lines.entries()) {
      if (!l.itemId) return setError(`Line ${i + 1}: choose an item.`)
      if (!(Number(l.quantity) > 0)) return setError(`Line ${i + 1}: enter the quantity.`)
      if (parsePeso(l.unitCost) === null) return setError(`Line ${i + 1}: enter the unit cost, like 1,200.00.`)
    }
    try {
      const id = await save.mutateAsync({
        issue,
        body: {
          supplierId,
          date,
          expectedDate: expectedDate || null,
          warehouseId: whId,
          pricesIncludeVat,
          notes,
          lines: lines.map((l) => ({ itemId: l.itemId, description: l.description, quantity: Number(l.quantity), unitCost: parsePeso(l.unitCost), vat: l.vat, ewtCodeId: l.ewtCodeId || null })),
        },
      })
      await navigate({ to: '/w/$workspaceId/inventory/purchase-orders/$id', params: { workspaceId, id } })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div>
      <PageHeader title={existing ? 'Edit draft purchase order' : 'New purchase order'} description="Saved as a draft until you issue it. Issuing gives it the next PO number." />
      <div className="space-y-6">
        <FormError message={error} />
        <Card>
          <CardContent className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div className="grid gap-2 md:col-span-2">
              <Label htmlFor="po-supplier">Supplier</Label>
              <NativeSelect id="po-supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">Choose…</option>
                {suppliers.data.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="po-date">Date</Label>
              <Input id="po-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="po-expected">Expected by</Label>
              <Input id="po-expected" type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
            </div>
            <div className="grid gap-2 md:col-span-2">
              <Label htmlFor="po-wh">Deliver to</Label>
              <NativeSelect id="po-wh" value={whId} onChange={(e) => setWarehouseId(e.target.value)}>
                {openWh.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex items-center gap-2 md:col-span-2">
              <Checkbox id="po-incl" checked={pricesIncludeVat} onCheckedChange={(v) => setPricesIncludeVat(v === true)} />
              <Label htmlFor="po-incl" className="font-normal">
                Prices already include VAT
              </Label>
            </div>
          </CardContent>
        </Card>
        {lines.map((l, i) => (
          <Card key={i} className="py-4">
            <CardContent className="grid gap-3 px-4 md:grid-cols-12">
              <div className="grid gap-1.5 md:col-span-5">
                <Label htmlFor={`po${i}-item`} className="text-muted-foreground text-xs">
                  Item
                </Label>
                <NativeSelect
                  id={`po${i}-item`}
                  value={l.itemId}
                  onChange={(e) => {
                    const it = items.data!.find((x) => x.id === e.target.value)
                    set(i, { itemId: e.target.value, description: it?.name ?? '', unitCost: it?.purchaseCost ? centavosToInput(it.purchaseCost) : l.unitCost })
                  }}
                >
                  <option value="">Choose…</option>
                  {items.data!
                    .filter((it) => it.active)
                    .map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.sku} · {it.name}
                      </option>
                    ))}
                </NativeSelect>
              </div>
              <div className="grid grid-cols-2 gap-3 md:col-span-4">
                <div className="grid gap-1.5">
                  <Label htmlFor={`po${i}-qty`} className="text-muted-foreground text-xs">
                    Quantity
                  </Label>
                  <Input id={`po${i}-qty`} inputMode="decimal" className="text-right" value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`po${i}-cost`} className="text-muted-foreground text-xs">
                    Unit cost (₱)
                  </Label>
                  <Input id={`po${i}-cost`} inputMode="decimal" className="text-right" value={l.unitCost} onChange={(e) => set(i, { unitCost: e.target.value })} />
                </div>
              </div>
              <div className="flex items-end justify-end md:col-span-3">
                <span className="text-lg font-medium tabular-nums">{formatPeso(computed[i]?.gross ?? 0)}</span>
              </div>
              <div className="grid gap-1.5 md:col-span-4">
                <Label htmlFor={`po${i}-vat`} className="text-muted-foreground text-xs">
                  VAT
                </Label>
                <NativeSelect id={`po${i}-vat`} value={l.vat} onChange={(e) => set(i, { vat: e.target.value as VatTreatment })}>
                  {VAT_TREATMENTS.map((t) => (
                    <option key={t} value={t}>
                      {VAT_TREATMENT_LABELS[t]}
                      {t === 'vatable' ? ` (${formatRate(vatRate)})` : ''}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="grid gap-1.5 md:col-span-7">
                <Label htmlFor={`po${i}-ewt`} className="text-muted-foreground text-xs">
                  Tax withheld
                </Label>
                <NativeSelect id={`po${i}-ewt`} value={l.ewtCodeId} onChange={(e) => set(i, { ewtCodeId: e.target.value })}>
                  <option value="">None</option>
                  {ewtCodes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.atc} · {formatRate(t.rateBp)} · {t.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex items-end justify-end md:col-span-1">
                <Button type="button" variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                  <Trash2 />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
        <Button type="button" variant="outline" onClick={() => setLines((ls) => [...ls, { itemId: '', description: '', quantity: '1', unitCost: '', vat: defaultVat, ewtCodeId: '' }])}>
          <Plus />
          Add an item
        </Button>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="grid content-start gap-2">
            <Label htmlFor="po-notes">Notes for the supplier</Label>
            <Textarea id="po-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <Card className="gap-0 py-4">
            <CardContent className="grid gap-2 px-4 text-sm">
              {totals.vatAmount > 0 && <Row label="VAT" value={totals.vatAmount} />}
              <Row label="Total" value={totals.total} strong />
              {totals.ewtAmount > 0 && <Row label="Less tax withheld" value={-totals.ewtAmount} />}
            </CardContent>
          </Card>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => void submit(false)} disabled={save.isPending}>
            Save draft
          </Button>
          <Button onClick={() => void submit(true)} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save and issue'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className={cn('flex justify-between gap-4', strong && 'border-t pt-2 text-base font-semibold')}>
      <span className={strong ? '' : 'text-muted-foreground'}>{label}</span>
      <span className="tabular-nums">{formatPeso(value)}</span>
    </div>
  )
}

export function PurchaseOrderPage({ id }: { id: string }) {
  const workspace = useWorkspace()
  const workspaceId = workspace.id
  const can = useCan()
  const navigate = useNavigate()
  const q = useQuery(inventoryQueries.purchaseOrder(workspaceId, id))
  const [receiving, setReceiving] = useState(false)
  const act = useWorkspaceMutation((w, what: 'issue' | 'cancel' | 'close' | 'delete' | 'bill') =>
    what === 'delete' ? api(`/w/${w}/purchase-orders/${id}`, { method: 'DELETE' }) : api<{ billId?: string }>(`/w/${w}/purchase-orders/${id}/${what}`, { method: 'POST' }),
  )
  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Loading />
  const po = q.data
  const open = ['issued', 'partly_received', 'received'].includes(po.status)
  const toReceive = po.lines.some((l) => l.item.kind === 'stock' && l.receivedQty < l.quantity)
  const canBill = po.lines.some((l) => (l.item.kind === 'stock' ? l.receivedQty : l.quantity) > l.billedQty)

  async function run(what: 'issue' | 'cancel' | 'close' | 'delete' | 'bill') {
    const result = (await act.mutateAsync(what)) as { billId?: string } | undefined
    if (what === 'delete') await navigate({ to: '/w/$workspaceId/inventory/purchase-orders', params: { workspaceId } })
    if (what === 'bill' && result?.billId) await navigate({ to: '/w/$workspaceId/finance/bills/$id/edit', params: { workspaceId, id: result.billId } })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">{po.number ?? 'Draft purchase order'}</h2>
            <PoStatusBadge status={po.status} />
          </div>
          <p className="text-muted-foreground text-sm">
            {po.supplier.name} · {formatDate(po.date)}
            {po.expectedDate && ` · expected ${formatDate(po.expectedDate)}`} · to {po.warehouse.name}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {po.status === 'draft' && can('purchasing.manage') && (
            <>
              <Button variant="ghost" onClick={() => void run('delete').catch(() => undefined)}>
                <Trash2 />
                Delete
              </Button>
              <Button variant="outline" asChild>
                <Link to="/w/$workspaceId/inventory/purchase-orders/$id/edit" params={{ workspaceId, id }}>
                  <Pencil />
                  Edit
                </Link>
              </Button>
              <Button onClick={() => void run('issue').catch(() => undefined)} disabled={act.isPending}>
                <Send />
                Issue
              </Button>
            </>
          )}
          {open && can('purchasing.manage') && po.lines.every((l) => l.receivedQty === 0 && l.billedQty === 0) && (
            <Button variant="ghost" onClick={() => void run('cancel').catch(() => undefined)}>
              <Ban />
              Cancel
            </Button>
          )}
          {open && can('purchasing.manage') && po.lines.some((l) => l.receivedQty > 0 || l.billedQty > 0) && (
            <Button variant="ghost" onClick={() => void run('close').catch(() => undefined)}>
              <CheckCheck />
              Close
            </Button>
          )}
          {po.status !== 'draft' && (
            <Button variant="outline" onClick={() => window.print()}>
              <Printer />
              Print
            </Button>
          )}
          {open && canBill && can('finance.edit') && (
            <Button variant="outline" onClick={() => void run('bill').catch(() => undefined)} disabled={act.isPending}>
              <FileText />
              Create bill
            </Button>
          )}
          {open && toReceive && can('inventory.manage') && (
            <Button onClick={() => setReceiving(true)}>
              <PackageCheck />
              Receive goods
            </Button>
          )}
        </div>
      </div>
      {act.error && (
        <Alert variant="destructive">
          <AlertDescription>{act.error.message}</AlertDescription>
        </Alert>
      )}

      <article className="bg-card space-y-6 rounded-xl border p-6 md:p-10 print:border-0 print:p-0">
        <header className="flex flex-wrap justify-between gap-6 border-b pb-6">
          <div>
            <p className="text-lg font-semibold">{workspace.name}</p>
            <p className="text-muted-foreground text-sm">TIN {workspace.tin}</p>
            <p className="text-muted-foreground max-w-xs text-sm">{workspace.registeredAddress}</p>
          </div>
          <div className="text-right">
            <p className="text-sm font-semibold tracking-widest uppercase">Purchase order</p>
            <p className="text-xl font-semibold">{po.number ?? '—'}</p>
            <p className="text-muted-foreground text-sm">{formatDate(po.date)}</p>
          </div>
        </header>
        <div>
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Supplier</p>
          <p className="font-medium">{po.supplier.name}</p>
          <p className="text-muted-foreground text-sm">Deliver to {po.warehouse.name}</p>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-0">Item</TableHead>
              <TableHead className="text-right">Ordered</TableHead>
              <TableHead className="text-right print:hidden">Received</TableHead>
              <TableHead className="text-right print:hidden">Billed</TableHead>
              <TableHead className="text-right">Unit cost</TableHead>
              <TableHead className="pr-0 text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {po.lines.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="min-w-48 pl-0">
                  {l.description}
                  <span className="text-muted-foreground block text-xs">{l.item.sku}</span>
                </TableCell>
                <TableCell className="text-right whitespace-nowrap tabular-nums">
                  {formatQty(l.quantity)} {l.item.unit}
                </TableCell>
                <TableCell className="text-right tabular-nums print:hidden">{l.item.kind === 'stock' ? formatQty(l.receivedQty) : '—'}</TableCell>
                <TableCell className="text-right tabular-nums print:hidden">{formatQty(l.billedQty)}</TableCell>
                <TableCell className="text-right">
                  <Money value={l.unitCost} />
                </TableCell>
                <TableCell className="pr-0 text-right">
                  <Money value={l.gross} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex justify-end">
          <dl className="grid min-w-56 gap-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">VAT</dt>
              <dd className="tabular-nums">{formatPeso(po.vatAmount)}</dd>
            </div>
            <div className="flex justify-between border-t pt-1.5 text-base font-semibold">
              <dt>Total</dt>
              <dd className="tabular-nums">{formatPeso(po.total)}</dd>
            </div>
          </dl>
        </div>
        {po.notes && <p className="text-muted-foreground text-sm whitespace-pre-line">{po.notes}</p>}
      </article>

      {(po.receipts.length > 0 || po.bills.length > 0) && (
        <div className="grid gap-6 md:grid-cols-2 print:hidden">
          <Card>
            <CardHeader>
              <CardTitle>Received</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {po.receipts.length === 0 && <p className="text-muted-foreground">Nothing yet.</p>}
              {po.receipts.map((r) => (
                <Link key={r.id} to="/w/$workspaceId/inventory/stock/$id" params={{ workspaceId, id: r.id }} className="flex justify-between hover:underline">
                  <span>
                    {r.number} · {formatDate(r.date)}
                  </span>
                  <span className="tabular-nums">{formatPeso(r.value)}</span>
                </Link>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Bills</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {po.bills.length === 0 && <p className="text-muted-foreground">Nothing yet.</p>}
              {po.bills.map((b) => (
                <Link key={b.id} to="/w/$workspaceId/finance/bills/$id" params={{ workspaceId, id: b.id }} className="flex justify-between hover:underline">
                  <span>
                    {b.number ?? 'Draft bill'} · {b.status}
                  </span>
                  <span className="tabular-nums">{formatPeso(b.total)}</span>
                </Link>
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      <Dialog open={receiving} onOpenChange={setReceiving}>
        <DialogContent className="sm:max-w-2xl">{receiving && <ReceiveForm po={po} onDone={() => setReceiving(false)} />}</DialogContent>
      </Dialog>
    </div>
  )
}

/** What arrived: quantity per line (defaults to what's still expected), and lots for tracked items. */
function ReceiveForm({ po, onDone }: { po: PurchaseOrder; onDone: () => void }) {
  const workspaceId = useWorkspaceId()
  const warehouses = useQuery(inventoryQueries.warehouses(workspaceId))
  const pending = po.lines.filter((l) => l.item.kind === 'stock' && l.receivedQty < l.quantity)
  const [date, setDate] = useState(today())
  const [warehouseId, setWarehouseId] = useState(po.warehouse.id)
  const [rows, setRows] = useState(pending.map((l) => ({ poLineId: l.id, quantity: String(l.quantity - l.receivedQty), lotNo: '', expiryDate: '' })))
  const [error, setError] = useState<string>()
  const receive = useWorkspaceMutation((w, body: object) => api(`/w/${w}/purchase-orders/${po.id}/receive`, { method: 'POST', body }))
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  async function submit() {
    setError(undefined)
    const lines = rows.filter((r) => Number(r.quantity) > 0).map((r) => ({ ...r, quantity: Number(r.quantity), expiryDate: r.expiryDate || null }))
    if (!lines.length) return setError('Enter how many of at least one item arrived.')
    try {
      await receive.mutateAsync({ date, warehouseId, lines })
      onDone()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Receive goods on {po.number}</DialogTitle>
        <DialogDescription>Enter what actually arrived. The rest stays expected. Stock goes on the books at the order’s cost.</DialogDescription>
      </DialogHeader>
      <FormError message={error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="r-date">Date received</Label>
          <Input id="r-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="r-wh">Into</Label>
          <NativeSelect id="r-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            {warehouses.data
              ?.filter((w) => w.active)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
          </NativeSelect>
        </div>
      </div>
      {pending.map((l, i) => (
        <div key={l.id} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-6">
          <div className="sm:col-span-6">
            <p className="font-medium">{l.description}</p>
            <p className="text-muted-foreground text-xs">
              {formatQty(l.quantity - l.receivedQty)} {l.item.unit} still expected
            </p>
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor={`r${i}-qty`} className="text-muted-foreground text-xs">
              Arrived ({l.item.unit})
            </Label>
            <Input id={`r${i}-qty`} inputMode="decimal" className="text-right" value={rows[i]!.quantity} onChange={(e) => set(i, { quantity: e.target.value })} />
          </div>
          {l.item.trackLots && (
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor={`r${i}-lot`} className="text-muted-foreground text-xs">
                Lot number
              </Label>
              <Input id={`r${i}-lot`} value={rows[i]!.lotNo} onChange={(e) => set(i, { lotNo: e.target.value })} />
            </div>
          )}
          {l.item.trackExpiry && (
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor={`r${i}-exp`} className="text-muted-foreground text-xs">
                Expires
              </Label>
              <Input id={`r${i}-exp`} type="date" value={rows[i]!.expiryDate} onChange={(e) => set(i, { expiryDate: e.target.value })} />
            </div>
          )}
        </div>
      ))}
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={receive.isPending}>
          {receive.isPending ? 'Receiving…' : 'Receive'}
        </Button>
      </DialogFooter>
    </div>
  )
}
