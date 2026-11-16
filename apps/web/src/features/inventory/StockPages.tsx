import { ADJUSTMENT_REASON_LABELS, ADJUSTMENT_REASONS, centavosToInput, parsePeso, type AdjustmentReason, type Item, type StockDocument } from '@erp/shared'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowLeftRight, BookOpen, ClipboardList, Plus, Printer, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { FormError } from '@/components/form'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { EmptyState, LoadError, Loading, Money, PageHeader } from '@/features/finance/components'
import { useWorkspaceMutation } from '@/features/finance/queries'
import { useCan, useWorkspaceId } from '@/features/workspaces/queries'
import { api } from '@/lib/api'
import { formatDate, today } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { formatQty, inventoryQueries } from './queries'

const KIND_LABELS: Record<StockDocument['kind'], string> = { adjustment: 'Adjustment', transfer: 'Transfer', receipt: 'Goods received', delivery: 'Delivered' }

/** An item picker that only offers stock items that are on. */
export function StockItemSelect({ id, value, onChange, items, invalid }: { id: string; value: string; onChange: (v: string) => void; items: Item[]; invalid?: boolean }) {
  return (
    <NativeSelect id={id} value={value} aria-invalid={invalid} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose an item…</option>
      {items
        .filter((i) => i.kind === 'stock' && i.active)
        .map((i) => (
          <option key={i.id} value={i.id}>
            {i.sku} · {i.name}
          </option>
        ))}
    </NativeSelect>
  )
}

export function StockDocumentsPage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const navigate = useNavigate()
  const [kind, setKind] = useState('')
  const q = useQuery(inventoryQueries.documents(workspaceId, kind || undefined))
  return (
    <div>
      <PageHeader
        title="Stock moves"
        description="Every adjustment, transfer and delivery received. Sales show on each item’s page."
        actions={
          can('inventory.manage') ? (
            <>
              <Button variant="outline" asChild>
                <Link to="/w/$workspaceId/inventory/stock/transfer" params={{ workspaceId }}>
                  <ArrowLeftRight />
                  Move stock
                </Link>
              </Button>
              <Button asChild>
                <Link to="/w/$workspaceId/inventory/stock/adjust" params={{ workspaceId }}>
                  <ClipboardList />
                  Count or adjust
                </Link>
              </Button>
            </>
          ) : undefined
        }
      />
      <NativeSelect aria-label="Show" className="mb-4 w-48" value={kind} onChange={(e) => setKind(e.target.value)}>
        <option value="">Everything</option>
        <option value="adjustment">Adjustments</option>
        <option value="transfer">Transfers</option>
        <option value="receipt">Goods received</option>
        <option value="delivery">Delivered</option>
      </NativeSelect>
      {q.error ? (
        <LoadError error={q.error} />
      ) : !q.data ? (
        <Loading />
      ) : q.data.length === 0 ? (
        <EmptyState title="No stock moves yet">Opening stock is entered as an adjustment with the reason “Opening stock”.</EmptyState>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>What</TableHead>
                <TableHead className="hidden md:table-cell">Where</TableHead>
                <TableHead className="text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((d) => (
                <TableRow key={d.id} className="cursor-pointer" onClick={() => void navigate({ to: '/w/$workspaceId/inventory/stock/$id', params: { workspaceId, id: d.id } })}>
                  <TableCell className="font-medium whitespace-nowrap">{d.number}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(d.date)}</TableCell>
                  <TableCell>
                    {KIND_LABELS[d.kind]}
                    {d.reason && <span className="text-muted-foreground"> · {ADJUSTMENT_REASON_LABELS[d.reason]}</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden md:table-cell">
                    {d.warehouse.name}
                    {d.toWarehouse && ` → ${d.toWarehouse.name}`}
                  </TableCell>
                  <TableCell className="text-right">{d.kind === 'transfer' ? '—' : <Money value={d.value} />}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

export function StockDocumentPage({ id }: { id: string }) {
  const workspaceId = useWorkspaceId()
  const q = useQuery(inventoryQueries.document(workspaceId, id))
  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Loading />
  const d = q.data
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">{d.number}</h2>
            <Badge variant="secondary">{KIND_LABELS[d.kind]}</Badge>
          </div>
          <p className="text-muted-foreground text-sm">
            {formatDate(d.date)} · {d.warehouse.name}
            {d.toWarehouse && ` → ${d.toWarehouse.name}`}
            {d.reason && ` · ${ADJUSTMENT_REASON_LABELS[d.reason]}`}
          </p>
        </div>
        <Button variant="outline" onClick={() => window.print()} className="print:hidden">
          <Printer />
          Print
        </Button>
      </div>
      {d.notes && <p className="whitespace-pre-line">{d.notes}</p>}
      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>Lot</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
              {d.kind !== 'transfer' && <TableHead className="text-right">Value</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.lines.map((l, i) => (
              <TableRow key={i}>
                <TableCell className="min-w-48">
                  <Link to="/w/$workspaceId/inventory/items/$id" params={{ workspaceId, id: l.item.id }} className="font-medium hover:underline">
                    {l.item.name}
                  </Link>
                  <span className="text-muted-foreground block text-xs">{l.item.sku}</span>
                </TableCell>
                <TableCell>{l.lotNo ?? '—'}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {l.quantity > 0 && d.kind === 'adjustment' ? '+' : ''}
                  {formatQty(l.quantity)}
                </TableCell>
                {d.kind !== 'transfer' && (
                  <TableCell className="text-right">
                    <Money value={l.value} />
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {d.journalEntryId && (
        <Button variant="link" className="px-0 print:hidden" asChild>
          <Link to="/w/$workspaceId/finance/journal/$id" params={{ workspaceId, id: d.journalEntryId }}>
            <BookOpen />
            See the journal entry
          </Link>
        </Button>
      )}
    </div>
  )
}

type AdjLine = { itemId: string; mode: 'change' | 'counted'; amount: string; unitCost: string; lotNo: string; expiryDate: string }
const blankAdj = (): AdjLine => ({ itemId: '', mode: 'counted', amount: '', unitCost: '', lotNo: '', expiryDate: '' })

/** A count (enter what's on the shelf) or a change (+ found, − lost). Opening stock is one too. */
export function AdjustmentPage() {
  const workspaceId = useWorkspaceId()
  const navigate = useNavigate()
  const items = useQuery(inventoryQueries.items(workspaceId))
  const warehouses = useQuery(inventoryQueries.warehouses(workspaceId))
  const [date, setDate] = useState(today())
  const [warehouseId, setWarehouseId] = useState('')
  const [reason, setReason] = useState<AdjustmentReason>('count')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<AdjLine[]>([blankAdj()])
  const [error, setError] = useState<string>()
  const save = useWorkspaceMutation((w, body: object) => api<{ document: StockDocument }>(`/w/${w}/stock/adjustments`, { method: 'POST', body }))

  if (!items.data || !warehouses.data) return <Loading />
  const open = warehouses.data.filter((w) => w.active)
  const where = warehouseId || open[0]?.id || ''
  const set = (i: number, patch: Partial<AdjLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const itemOf = (id: string) => items.data!.find((i) => i.id === id)

  async function submit() {
    setError(undefined)
    const body = {
      date,
      warehouseId: where,
      reason,
      notes,
      lines: [] as object[],
    }
    for (const [i, l] of lines.entries()) {
      if (!l.itemId) return setError(`Line ${i + 1}: choose an item.`)
      const n = Number(l.amount)
      if (!l.amount.trim() || !Number.isFinite(n)) return setError(`Line ${i + 1}: enter ${l.mode === 'counted' ? 'what you counted' : 'the change, like -3 or 10'}.`)
      const cost = l.unitCost.trim() ? parsePeso(l.unitCost) : undefined
      if (cost === null) return setError(`Line ${i + 1}: enter the unit cost like 1,100.00, or leave it blank.`)
      body.lines.push({ itemId: l.itemId, [l.mode]: n, unitCost: cost, lotNo: l.lotNo, expiryDate: l.expiryDate || null })
    }
    try {
      const { document } = await save.mutateAsync(body)
      await navigate({ to: '/w/$workspaceId/inventory/stock/$id', params: { workspaceId, id: document.id } })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div>
      <PageHeader title="Count or adjust stock" description="Counted: enter what’s on the shelf and the difference is worked out. Change: + for found, − for lost. Each line moves the books too." />
      <div className="space-y-6">
        <FormError message={error} />
        <Card>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="a-date">Date</Label>
              <Input id="a-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="a-wh">Warehouse</Label>
              <NativeSelect id="a-wh" value={where} onChange={(e) => setWarehouseId(e.target.value)}>
                {open.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="a-reason">Reason</Label>
              <NativeSelect id="a-reason" value={reason} onChange={(e) => setReason(e.target.value as AdjustmentReason)}>
                {ADJUSTMENT_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {ADJUSTMENT_REASON_LABELS[r]}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </CardContent>
        </Card>
        {lines.map((l, i) => {
          const item = itemOf(l.itemId)
          const comingIn = l.mode === 'change' ? Number(l.amount) > 0 : true
          return (
            <Card key={i} className="py-4">
              <CardContent className="grid gap-3 px-4 md:grid-cols-12">
                <div className="grid gap-1.5 md:col-span-4">
                  <Label htmlFor={`a${i}-item`} className="text-muted-foreground text-xs">
                    Item
                  </Label>
                  <StockItemSelect id={`a${i}-item`} value={l.itemId} items={items.data!} onChange={(v) => set(i, { itemId: v, unitCost: itemOf(v)?.purchaseCost ? centavosToInput(itemOf(v)!.purchaseCost) : '' })} />
                </div>
                <div className="grid gap-1.5 md:col-span-2">
                  <Label htmlFor={`a${i}-mode`} className="text-muted-foreground text-xs">
                    Enter
                  </Label>
                  <NativeSelect id={`a${i}-mode`} value={l.mode} onChange={(e) => set(i, { mode: e.target.value as AdjLine['mode'] })}>
                    <option value="counted">Counted</option>
                    <option value="change">Change (±)</option>
                  </NativeSelect>
                </div>
                <div className="grid gap-1.5 md:col-span-2">
                  <Label htmlFor={`a${i}-qty`} className="text-muted-foreground text-xs">
                    {l.mode === 'counted' ? 'On the shelf' : 'Change'} {item ? `(${item.unit.code})` : ''}
                  </Label>
                  <Input id={`a${i}-qty`} inputMode="decimal" className="text-right" value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} />
                </div>
                <div className={cn('grid gap-1.5 md:col-span-3', !comingIn && 'opacity-50')}>
                  <Label htmlFor={`a${i}-cost`} className="text-muted-foreground text-xs">
                    Unit cost if more (₱)
                  </Label>
                  <Input id={`a${i}-cost`} inputMode="decimal" className="text-right" placeholder="Average cost" value={l.unitCost} onChange={(e) => set(i, { unitCost: e.target.value })} />
                </div>
                <div className="flex items-end justify-end md:col-span-1">
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                    <Trash2 />
                  </Button>
                </div>
                {item?.trackLots && (
                  <>
                    <div className="grid gap-1.5 md:col-span-4">
                      <Label htmlFor={`a${i}-lot`} className="text-muted-foreground text-xs">
                        Lot number
                      </Label>
                      <Input id={`a${i}-lot`} value={l.lotNo} onChange={(e) => set(i, { lotNo: e.target.value })} />
                    </div>
                    {item.trackExpiry && (
                      <div className="grid gap-1.5 md:col-span-4">
                        <Label htmlFor={`a${i}-exp`} className="text-muted-foreground text-xs">
                          Expiry (for a new lot)
                        </Label>
                        <Input id={`a${i}-exp`} type="date" value={l.expiryDate} onChange={(e) => set(i, { expiryDate: e.target.value })} />
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          )
        })}
        <Button type="button" variant="outline" onClick={() => setLines((ls) => [...ls, blankAdj()])}>
          <Plus />
          Add an item
        </Button>
        <div className="grid gap-2">
          <Label htmlFor="a-notes">Notes</Label>
          <Textarea id="a-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div className="flex justify-end">
          <Button onClick={() => void submit()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save adjustment'}
          </Button>
        </div>
      </div>
    </div>
  )
}

type MoveLine = { itemId: string; quantity: string; lotNo: string }

export function TransferPage() {
  const workspaceId = useWorkspaceId()
  const navigate = useNavigate()
  const items = useQuery(inventoryQueries.items(workspaceId))
  const warehouses = useQuery(inventoryQueries.warehouses(workspaceId))
  const [date, setDate] = useState(today())
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [lines, setLines] = useState<MoveLine[]>([{ itemId: '', quantity: '', lotNo: '' }])
  const [error, setError] = useState<string>()
  const save = useWorkspaceMutation((w, body: object) => api<{ document: StockDocument }>(`/w/${w}/stock/transfers`, { method: 'POST', body }))

  if (!items.data || !warehouses.data) return <Loading />
  const open = warehouses.data.filter((w) => w.active)
  if (open.length < 2) return <EmptyState title="You need two warehouses to move stock between">Add another in Inventory → Warehouses.</EmptyState>
  const fromId = from || open[0]!.id
  const toId = to || open.find((w) => w.id !== fromId)!.id
  const set = (i: number, patch: Partial<MoveLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))

  async function submit() {
    setError(undefined)
    for (const [i, l] of lines.entries()) {
      if (!l.itemId) return setError(`Line ${i + 1}: choose an item.`)
      if (!(Number(l.quantity) > 0)) return setError(`Line ${i + 1}: enter how many.`)
    }
    try {
      const { document } = await save.mutateAsync({ date, fromWarehouseId: fromId, toWarehouseId: toId, lines: lines.map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity), lotNo: l.lotNo })) })
      await navigate({ to: '/w/$workspaceId/inventory/stock/$id', params: { workspaceId, id: document.id } })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div>
      <PageHeader title="Move stock" description="From one warehouse to another. Its value doesn’t change, so the books don’t either." />
      <div className="space-y-6">
        <FormError message={error} />
        <Card>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="t-date">Date</Label>
              <Input id="t-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="t-from">From</Label>
              <NativeSelect id="t-from" value={fromId} onChange={(e) => setFrom(e.target.value)}>
                {open.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="t-to">To</Label>
              <NativeSelect id="t-to" value={toId} onChange={(e) => setTo(e.target.value)}>
                {open
                  .filter((w) => w.id !== fromId)
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
              </NativeSelect>
            </div>
          </CardContent>
        </Card>
        {lines.map((l, i) => {
          const item = items.data!.find((x) => x.id === l.itemId)
          return (
            <Card key={i} className="py-4">
              <CardContent className="grid gap-3 px-4 md:grid-cols-12">
                <div className="grid gap-1.5 md:col-span-6">
                  <Label htmlFor={`t${i}-item`} className="text-muted-foreground text-xs">
                    Item
                  </Label>
                  <StockItemSelect id={`t${i}-item`} value={l.itemId} items={items.data!} onChange={(v) => set(i, { itemId: v })} />
                </div>
                <div className="grid gap-1.5 md:col-span-2">
                  <Label htmlFor={`t${i}-qty`} className="text-muted-foreground text-xs">
                    Quantity {item ? `(${item.unit.code})` : ''}
                  </Label>
                  <Input id={`t${i}-qty`} inputMode="decimal" className="text-right" value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} />
                </div>
                <div className="grid gap-1.5 md:col-span-3">
                  <Label htmlFor={`t${i}-lot`} className="text-muted-foreground text-xs">
                    Lot {item?.trackLots ? '(blank: earliest expiry first)' : ''}
                  </Label>
                  <Input id={`t${i}-lot`} disabled={!item?.trackLots} value={l.lotNo} onChange={(e) => set(i, { lotNo: e.target.value })} />
                </div>
                <div className="flex items-end justify-end md:col-span-1">
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                    <Trash2 />
                  </Button>
                </div>
              </CardContent>
            </Card>
          )
        })}
        <Button type="button" variant="outline" onClick={() => setLines((ls) => [...ls, { itemId: '', quantity: '', lotNo: '' }])}>
          <Plus />
          Add an item
        </Button>
        <div className="flex justify-end">
          <Button onClick={() => void submit()} disabled={save.isPending}>
            {save.isPending ? 'Moving…' : 'Move stock'}
          </Button>
        </div>
      </div>
    </div>
  )
}
