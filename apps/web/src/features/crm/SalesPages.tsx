import { OrderProduction } from '@/features/manufacturing/MakeToOrder'
import { HazardNote } from '@/features/inventory/niche'
import {
  type QuotedPrice,
  centavosToInput,
  computeLine,
  computeTotals,
  formatPeso,
  formatRate,
  parsePeso,
  QUOTE_STATUS_LABELS,
  SO_STATUS_LABELS,
  VAT_TREATMENT_LABELS,
  VAT_TREATMENTS,
  type Quote,
  type QuoteStatus,
  type SalesLine,
  type SalesOrder,
  type SoStatus,
  type VatTreatment,
} from '@erp/shared'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Ban, Check, CheckCheck, Copy, FileText, Pencil, Plus, Printer, Send, ShoppingBag, Trash2, Truck, X } from 'lucide-react'
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
import { formatQty } from '@/features/inventory/queries'
import { useCan, useWorkspace, useWorkspaceId } from '@/features/workspaces/queries'
import { api } from '@/lib/api'
import { formatDate, today } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { crmQueries } from './queries'

/* =============================================================================================
 * Badges
 * =========================================================================================== */

export function QuoteStatusBadge({ status, expired }: { status: QuoteStatus; expired?: boolean }) {
  if (expired) return <Badge variant="secondary">Expired</Badge>
  const variant = status === 'accepted' ? 'success' : status === 'sent' ? 'default' : status === 'draft' ? 'outline' : 'secondary'
  return <Badge variant={variant}>{QUOTE_STATUS_LABELS[status]}</Badge>
}

const SO_VARIANT: Record<SoStatus, 'outline' | 'default' | 'secondary' | 'success'> = {
  draft: 'outline',
  confirmed: 'default',
  partly_delivered: 'default',
  delivered: 'success',
  closed: 'secondary',
  cancelled: 'secondary',
}

export function OrderStatusBadge({ status }: { status: SoStatus }) {
  return <Badge variant={SO_VARIANT[status]}>{SO_STATUS_LABELS[status]}</Badge>
}

/* =============================================================================================
 * Lists
 * =========================================================================================== */

export function QuotesPage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const navigate = useNavigate()
  const [status, setStatus] = useState<QuoteStatus | ''>('')
  const q = useQuery(crmQueries.quotes(workspaceId, status || undefined))
  const newButton = (
    <Button asChild>
      <Link to="/w/$workspaceId/crm/quotes/new" params={{ workspaceId }}>
        <Plus />
        New quote
      </Link>
    </Button>
  )
  return (
    <div>
      <PageHeader title="Quotes" description="Prices offered to customers. An accepted quote becomes a sales order." actions={can('crm.manage') ? newButton : undefined} />
      <NativeSelect aria-label="Show" className="mb-4 w-48" value={status} onChange={(e) => setStatus(e.target.value as QuoteStatus | '')}>
        <option value="">All</option>
        {Object.entries(QUOTE_STATUS_LABELS).map(([k, label]) => (
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
        <EmptyState title="No quotes" action={can('crm.manage') && !status ? newButton : undefined} />
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="hidden md:table-cell">Valid until</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((qt) => (
                <TableRow key={qt.id} className="cursor-pointer" onClick={() => void navigate({ to: '/w/$workspaceId/crm/quotes/$id', params: { workspaceId, id: qt.id } })}>
                  <TableCell className="font-medium whitespace-nowrap">{qt.number ?? 'Draft'}</TableCell>
                  <TableCell className="max-w-56 truncate">{qt.customer.name}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(qt.date)}</TableCell>
                  <TableCell className="text-muted-foreground hidden md:table-cell">{qt.validUntil ? formatDate(qt.validUntil) : '—'}</TableCell>
                  <TableCell className="text-right">
                    <Money value={qt.total} />
                  </TableCell>
                  <TableCell>
                    <QuoteStatusBadge status={qt.status} expired={qt.expired} />
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

export function OrdersPage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const navigate = useNavigate()
  const [status, setStatus] = useState<SoStatus | ''>('')
  const q = useQuery(crmQueries.orders(workspaceId, status || undefined))
  const newButton = (
    <Button asChild>
      <Link to="/w/$workspaceId/crm/orders/new" params={{ workspaceId }}>
        <Plus />
        New sales order
      </Link>
    </Button>
  )
  return (
    <div>
      <PageHeader title="Sales orders" description="What customers have ordered: confirm it, deliver it, then invoice what went out." actions={can('sales.manage') ? newButton : undefined} />
      <NativeSelect aria-label="Show" className="mb-4 w-48" value={status} onChange={(e) => setStatus(e.target.value as SoStatus | '')}>
        <option value="">All</option>
        {Object.entries(SO_STATUS_LABELS).map(([k, label]) => (
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
        <EmptyState title="No sales orders" action={can('sales.manage') && !status ? newButton : undefined} />
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="hidden md:table-cell">Deliver by</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((o) => (
                <TableRow key={o.id} className="cursor-pointer" onClick={() => void navigate({ to: '/w/$workspaceId/crm/orders/$id', params: { workspaceId, id: o.id } })}>
                  <TableCell className="font-medium whitespace-nowrap">{o.number ?? 'Draft'}</TableCell>
                  <TableCell className="max-w-56 truncate">
                    {o.customer.name}
                    {o.customerPoNo && <span className="text-muted-foreground block text-xs">Their PO {o.customerPoNo}</span>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(o.date)}</TableCell>
                  <TableCell className={cn('text-muted-foreground hidden md:table-cell', o.deliveryDate && o.deliveryDate < today() && ['confirmed', 'partly_delivered'].includes(o.status) && 'text-destructive')}>
                    {o.deliveryDate ? formatDate(o.deliveryDate) : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={o.total} />
                  </TableCell>
                  <TableCell>
                    <OrderStatusBadge status={o.status} />
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

/* =============================================================================================
 * The form: quotes and sales orders have the same lines
 * =========================================================================================== */

type Kind = 'quote' | 'order'
type Line = { itemId: string; description: string; quantity: string; unitPrice: string; vat: VatTreatment }

export function SalesFormPage({ kind, id, customerId, leadId }: { kind: Kind; id?: string; customerId?: string; leadId?: string }) {
  const workspaceId = useWorkspaceId()
  const quote = useQuery({ ...crmQueries.quote(workspaceId, id ?? ''), enabled: kind === 'quote' && !!id })
  const order = useQuery({ ...crmQueries.order(workspaceId, id ?? ''), enabled: kind === 'order' && !!id })
  const existing = kind === 'quote' ? quote : order
  if (existing.error) return <LoadError error={existing.error} />
  if (id && !existing.data) return <Loading />
  if (existing.data && existing.data.status !== 'draft') {
    return <p className="text-muted-foreground py-10 text-center text-sm">{kind === 'quote' ? 'This quote has been sent, so it can’t be edited. Make a revised copy instead.' : 'This order has been confirmed, so it can’t be edited.'}</p>
  }
  return <SalesForm key={id ?? 'new'} kind={kind} existing={existing.data} customerId={customerId} leadId={leadId} />
}

function SalesForm({ kind, existing, customerId: initialCustomer, leadId }: { kind: Kind; existing?: Quote | SalesOrder; customerId?: string; leadId?: string }) {
  const workspace = useWorkspace()
  const workspaceId = workspace.id
  const navigate = useNavigate()
  const can = useCan()
  const customers = useQuery(crmQueries.customers(workspaceId))
  const items = useQuery(crmQueries.items(workspaceId))
  const warehouses = useQuery({ ...crmQueries.warehouses(workspaceId), enabled: kind === 'order' })
  const taxCodes = useQuery({ ...financeQueries.taxCodes(workspaceId), enabled: can('finance.view') })
  const asOrder = existing && 'customerPoNo' in existing ? existing : undefined
  const asQuote = existing && 'validUntil' in existing ? existing : undefined
  const defaultVat: VatTreatment = workspace.vatStatus === 'non_vat' ? 'none' : 'vatable'
  const vatOptions = VAT_TREATMENTS.filter((t) => (workspace.vatStatus === 'vat' ? t !== 'none' : t === 'none'))
  const [customerId, setCustomerId] = useState(existing?.customer.id ?? initialCustomer ?? '')
  const [date, setDate] = useState(existing?.date ?? today())
  const [validUntil, setValidUntil] = useState(asQuote ? (asQuote.validUntil ?? '') : addDays(today(), 30))
  const [deliveryDate, setDeliveryDate] = useState(asOrder?.deliveryDate ?? '')
  const [warehouseId, setWarehouseId] = useState(asOrder?.warehouse?.id ?? '')
  const [customerPoNo, setCustomerPoNo] = useState(asOrder?.customerPoNo ?? '')
  const [pricesIncludeVat, setPricesIncludeVat] = useState(existing?.pricesIncludeVat ?? false)
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [lines, setLines] = useState<Line[]>(
    existing?.lines.map((l) => ({ itemId: l.item.id, description: l.description, quantity: String(l.quantity), unitPrice: centavosToInput(l.unitPrice), vat: l.vat })) ?? [
      { itemId: '', description: '', quantity: '1', unitPrice: '', vat: defaultVat },
    ],
  )
  const [error, setError] = useState<string>()
  const save = useWorkspaceMutation(async (w, { body, advance }: { body: object; advance: boolean }) => {
    const base = kind === 'quote' ? 'quotes' : 'sales-orders'
    const saved = existing
      ? await api<{ quote?: Quote; salesOrder?: SalesOrder }>(`/w/${w}/${base}/${existing.id}`, { method: 'PUT', body })
      : await api<{ quote?: Quote; salesOrder?: SalesOrder }>(`/w/${w}/${base}`, { method: 'POST', body })
    const doc = (saved.quote ?? saved.salesOrder)!
    if (advance) await api(`/w/${w}/${base}/${doc.id}/${kind === 'quote' ? 'send' : 'confirm'}`, { method: 'POST' })
    return doc.id
  })

  if (!customers.data || !items.data) return <Loading />
  const openWh = warehouses.data ?? []
  const whId = warehouseId || openWh[0]?.id || ''
  const vatRate = taxCodes.data?.filter((t) => t.code === 'VAT12' && t.effectiveFrom <= date).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]?.rateBp ?? 1200
  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  /** The customer's price for the item at this quantity: their price list's break, else the item's price. */
  const fillPrice = async (i: number, itemId: string, quantity: string) => {
    if (!itemId) return
    try {
      const { price } = await api<{ price: QuotedPrice }>(`/w/${workspaceId}/sales/price?itemId=${itemId}&quantity=${Number(quantity) || 1}${customerId ? `&customerId=${customerId}` : ''}`)
      set(i, { unitPrice: centavosToInput(price.price) })
    } catch {
      // keep what's there
    }
  }
  const computed = lines.map((l) => {
    const qty = Number(l.quantity)
    const p = parsePeso(l.unitPrice)
    return { ...(qty > 0 && p !== null && p >= 0 ? computeLine({ quantity: qty, unitPrice: p, vat: l.vat, vatRateBp: vatRate }, pricesIncludeVat) : { gross: 0, net: 0, vatAmount: 0, ewtAmount: 0 }), vat: l.vat }
  })
  const totals = computeTotals(computed)
  const ships = lines.some((l) => items.data!.find((it) => it.id === l.itemId)?.kind === 'stock')
  const customer = customers.data.find((c) => c.id === customerId)
  const creditLeft = customer?.creditLimit != null ? customer.creditLimit - customer.owed - customer.onOrder : null

  async function submit(advance: boolean) {
    setError(undefined)
    if (!customerId) return setError('Choose a customer.')
    for (const [i, l] of lines.entries()) {
      if (!l.itemId) return setError(`Line ${i + 1}: choose an item.`)
      if (!(Number(l.quantity) > 0)) return setError(`Line ${i + 1}: enter the quantity.`)
      if (parsePeso(l.unitPrice) === null) return setError(`Line ${i + 1}: enter the price, like 1,500.00.`)
    }
    const body = {
      customerId,
      date,
      pricesIncludeVat,
      notes,
      lines: lines.map((l) => ({ itemId: l.itemId, description: l.description, quantity: Number(l.quantity), unitPrice: parsePeso(l.unitPrice), vat: l.vat })),
      ...(kind === 'quote'
        ? { validUntil: validUntil || null, leadId: asQuote?.lead?.id ?? leadId ?? null }
        : { deliveryDate: deliveryDate || null, warehouseId: whId || null, customerPoNo }),
    }
    try {
      const id = await save.mutateAsync({ body, advance })
      if (kind === 'quote') await navigate({ to: '/w/$workspaceId/crm/quotes/$id', params: { workspaceId, id } })
      else await navigate({ to: '/w/$workspaceId/crm/orders/$id', params: { workspaceId, id } })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const word = kind === 'quote' ? 'quote' : 'sales order'
  return (
    <div>
      <PageHeader
        title={existing ? `Edit draft ${word}` : `New ${word}`}
        description={kind === 'quote' ? 'Saved as a draft until you send it. Sending gives it the next QT number.' : 'Saved as a draft until you confirm it. Confirming gives it the next SO number and checks the customer’s credit limit.'}
      />
      <div className="space-y-6">
        <FormError message={error} />
        <Card>
          <CardContent className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div className="grid gap-2 md:col-span-2">
              <Label htmlFor="s-customer">Customer</Label>
              <NativeSelect id="s-customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">Choose…</option>
                {customers.data.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
              {customer && (customer.owed > 0 || creditLeft !== null) && (
                <p className={cn('text-xs', creditLeft !== null && creditLeft < totals.total ? 'text-destructive' : 'text-muted-foreground')}>
                  Owes {formatPeso(customer.owed)}
                  {creditLeft !== null && ` · ${formatPeso(Math.max(0, creditLeft))} of credit left`}
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="s-date">Date</Label>
              <Input id="s-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            {kind === 'quote' ? (
              <div className="grid gap-2">
                <Label htmlFor="s-valid">Valid until</Label>
                <Input id="s-valid" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
              </div>
            ) : (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="s-deliver">Deliver by</Label>
                  <Input id="s-deliver" type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
                </div>
                {ships && openWh.length > 0 && (
                  <div className="grid gap-2 md:col-span-2">
                    <Label htmlFor="s-wh">Ships from</Label>
                    <NativeSelect id="s-wh" value={whId} onChange={(e) => setWarehouseId(e.target.value)}>
                      {openWh.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                )}
                <div className="grid gap-2">
                  <Label htmlFor="s-po">Their PO number</Label>
                  <Input id="s-po" value={customerPoNo} onChange={(e) => setCustomerPoNo(e.target.value)} />
                </div>
              </>
            )}
            {workspace.vatStatus === 'vat' && (
              <div className="flex items-center gap-2 md:col-span-2">
                <Checkbox id="s-incl" checked={pricesIncludeVat} onCheckedChange={(v) => setPricesIncludeVat(v === true)} />
                <Label htmlFor="s-incl" className="font-normal">
                  Prices already include VAT
                </Label>
              </div>
            )}
          </CardContent>
        </Card>
        {lines.map((l, i) => {
          const it = items.data!.find((x) => x.id === l.itemId)
          const short = it?.kind === 'stock' && Number(l.quantity) > it.onHand
          return (
            <Card key={i} className="py-4">
              <CardContent className="grid gap-3 px-4 md:grid-cols-12">
                <div className="grid gap-1.5 md:col-span-5">
                  <Label htmlFor={`s${i}-item`} className="text-muted-foreground text-xs">
                    Item
                  </Label>
                  <NativeSelect
                    id={`s${i}-item`}
                    value={l.itemId}
                    onChange={(e) => {
                      const pick = items.data!.find((x) => x.id === e.target.value)
                      set(i, {
                        itemId: e.target.value,
                        description: pick?.name ?? '',
                        unitPrice: pick ? centavosToInput(pick.salesPrice) : l.unitPrice,
                        vat: pick && vatOptions.includes(pick.salesVat) ? pick.salesVat : defaultVat,
                      })
                      void fillPrice(i, e.target.value, l.quantity)
                    }}
                  >
                    <option value="">Choose…</option>
                    {items.data!.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.sku} · {x.name}
                        {x.kind === 'stock' ? ` (${formatQty(x.onHand)} ${x.unit} on hand)` : ''}
                      </option>
                    ))}
                  </NativeSelect>
                  {short && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      Only {formatQty(it.onHand)} {it.unit} on hand now.
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3 md:col-span-4">
                  <div className="grid gap-1.5">
                    <Label htmlFor={`s${i}-qty`} className="text-muted-foreground text-xs">
                      Quantity{it ? ` (${it.unit})` : ''}
                    </Label>
                    <Input id={`s${i}-qty`} inputMode="decimal" className="text-right" value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} onBlur={() => void fillPrice(i, l.itemId, l.quantity)} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor={`s${i}-price`} className="text-muted-foreground text-xs">
                      Unit price (₱)
                    </Label>
                    <Input id={`s${i}-price`} inputMode="decimal" className="text-right" value={l.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value })} />
                  </div>
                </div>
                <div className="flex items-end justify-end md:col-span-3">
                  <span className="text-lg font-medium tabular-nums">{formatPeso(computed[i]?.gross ?? 0)}</span>
                </div>
                <div className="grid gap-1.5 md:col-span-8">
                  <Label htmlFor={`s${i}-desc`} className="text-muted-foreground text-xs">
                    Description
                  </Label>
                  <Input id={`s${i}-desc`} value={l.description} onChange={(e) => set(i, { description: e.target.value })} />
                </div>
                <div className="grid gap-1.5 md:col-span-3">
                  <Label htmlFor={`s${i}-vat`} className="text-muted-foreground text-xs">
                    VAT
                  </Label>
                  <NativeSelect id={`s${i}-vat`} value={l.vat} onChange={(e) => set(i, { vat: e.target.value as VatTreatment })}>
                    {vatOptions.map((t) => (
                      <option key={t} value={t}>
                        {VAT_TREATMENT_LABELS[t]}
                        {t === 'vatable' ? ` (${formatRate(vatRate)})` : ''}
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
          )
        })}
        <Button type="button" variant="outline" onClick={() => setLines((ls) => [...ls, { itemId: '', description: '', quantity: '1', unitPrice: '', vat: defaultVat }])}>
          <Plus />
          Add an item
        </Button>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="grid content-start gap-2">
            <Label htmlFor="s-notes">{kind === 'quote' ? 'Terms and notes for the customer' : 'Notes'}</Label>
            <Textarea id="s-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <Card className="gap-0 py-4">
            <CardContent className="grid gap-2 px-4 text-sm">
              {totals.vatAmount > 0 && <Row label="VAT" value={totals.vatAmount} />}
              <Row label="Total" value={totals.total} strong />
            </CardContent>
          </Card>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => void submit(false)} disabled={save.isPending}>
            Save draft
          </Button>
          <Button onClick={() => void submit(true)} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : kind === 'quote' ? 'Save and send' : 'Save and confirm'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function Row({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className={cn('flex justify-between gap-4', strong && 'border-t pt-2 text-base font-semibold')}>
      <span className={strong ? '' : 'text-muted-foreground'}>{label}</span>
      <span className="tabular-nums">{formatPeso(value)}</span>
    </div>
  )
}

/* =============================================================================================
 * The printed document both share
 * =========================================================================================== */

function SalesDocument({ title, number, date, customer, meta, lines, showProgress, totals, notes }: {
  title: string
  number: string | null
  date: string
  customer: string
  meta: string[]
  lines: SalesLine[]
  showProgress: boolean
  totals: { vatableAmount: number; zeroRatedAmount: number; exemptAmount: number; vatAmount: number; total: number }
  notes: string | null
}) {
  const workspace = useWorkspace()
  return (
    <article className="bg-card space-y-6 rounded-xl border p-6 md:p-10 print:border-0 print:p-0">
      <header className="flex flex-wrap justify-between gap-6 border-b pb-6">
        <div>
          <p className="text-lg font-semibold">{workspace.name}</p>
          <p className="text-muted-foreground text-sm">TIN {workspace.tin}</p>
          <p className="text-muted-foreground max-w-xs text-sm">{workspace.registeredAddress}</p>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold tracking-widest uppercase">{title}</p>
          <p className="text-xl font-semibold">{number ?? '—'}</p>
          <p className="text-muted-foreground text-sm">{formatDate(date)}</p>
        </div>
      </header>
      <div>
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Customer</p>
        <p className="font-medium">{customer}</p>
        {meta.map((m) => (
          <p key={m} className="text-muted-foreground text-sm">
            {m}
          </p>
        ))}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-0">Item</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            {showProgress && <TableHead className="text-right print:hidden">Delivered</TableHead>}
            {showProgress && <TableHead className="text-right print:hidden">Invoiced</TableHead>}
            <TableHead className="text-right">Unit price</TableHead>
            <TableHead className="pr-0 text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((l) => (
            <TableRow key={l.id}>
              <TableCell className="min-w-48 pl-0">
                {l.description}
                <span className="text-muted-foreground block text-xs">
                  {l.item.sku}
                  {l.vat !== 'vatable' && l.vat !== 'none' ? ` · ${VAT_TREATMENT_LABELS[l.vat]}` : ''}
                </span>
              </TableCell>
              <TableCell className="text-right whitespace-nowrap tabular-nums">
                {formatQty(l.quantity)} {l.item.unit}
              </TableCell>
              {showProgress && <TableCell className="text-right tabular-nums print:hidden">{l.item.kind === 'stock' ? formatQty(l.deliveredQty) : '—'}</TableCell>}
              {showProgress && <TableCell className="text-right tabular-nums print:hidden">{formatQty(l.invoicedQty)}</TableCell>}
              <TableCell className="text-right">
                <Money value={l.unitPrice} />
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
          {totals.vatableAmount > 0 && (
            <div className="flex justify-between gap-6">
              <dt className="text-muted-foreground">VATable sales</dt>
              <dd className="tabular-nums">{formatPeso(totals.vatableAmount)}</dd>
            </div>
          )}
          {totals.zeroRatedAmount > 0 && (
            <div className="flex justify-between gap-6">
              <dt className="text-muted-foreground">Zero-rated</dt>
              <dd className="tabular-nums">{formatPeso(totals.zeroRatedAmount)}</dd>
            </div>
          )}
          {totals.exemptAmount > 0 && (
            <div className="flex justify-between gap-6">
              <dt className="text-muted-foreground">VAT-exempt</dt>
              <dd className="tabular-nums">{formatPeso(totals.exemptAmount)}</dd>
            </div>
          )}
          {totals.vatAmount > 0 && (
            <div className="flex justify-between gap-6">
              <dt className="text-muted-foreground">VAT</dt>
              <dd className="tabular-nums">{formatPeso(totals.vatAmount)}</dd>
            </div>
          )}
          <div className="flex justify-between gap-6 border-t pt-1.5 text-base font-semibold">
            <dt>Total</dt>
            <dd className="tabular-nums">{formatPeso(totals.total)}</dd>
          </div>
        </dl>
      </div>
      {notes && <p className="text-muted-foreground text-sm whitespace-pre-line">{notes}</p>}
      <p className="text-muted-foreground hidden text-xs print:block">Demo – not registered with the BIR. Not an invoice.</p>
    </article>
  )
}

/* =============================================================================================
 * A quote
 * =========================================================================================== */

export function QuotePage({ id }: { id: string }) {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const navigate = useNavigate()
  const q = useQuery(crmQueries.quote(workspaceId, id))
  type Action = 'send' | 'accept' | 'decline' | 'copy' | 'order' | 'delete'
  const act = useWorkspaceMutation((w, what: Action) =>
    what === 'delete' ? api(`/w/${w}/quotes/${id}`, { method: 'DELETE' }) : api<{ quote?: Quote; salesOrder?: SalesOrder }>(`/w/${w}/quotes/${id}/${what}`, { method: 'POST' }),
  )
  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Loading />
  const qt = q.data
  const manage = can('crm.manage')

  async function run(what: Action) {
    const r = (await act.mutateAsync(what)) as { quote?: Quote; salesOrder?: SalesOrder } | undefined
    if (what === 'delete') await navigate({ to: '/w/$workspaceId/crm/quotes', params: { workspaceId } })
    if (what === 'copy' && r?.quote) await navigate({ to: '/w/$workspaceId/crm/quotes/$id/edit', params: { workspaceId, id: r.quote.id } })
    if (what === 'order' && r?.salesOrder) await navigate({ to: '/w/$workspaceId/crm/orders/$id/edit', params: { workspaceId, id: r.salesOrder.id } })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">{qt.number ?? 'Draft quote'}</h2>
            <QuoteStatusBadge status={qt.status} expired={qt.expired} />
          </div>
          <p className="text-muted-foreground text-sm">
            <Link to="/w/$workspaceId/crm/customers/$id" params={{ workspaceId, id: qt.customer.id }} className="hover:underline">
              {qt.customer.name}
            </Link>{' '}
            · {formatDate(qt.date)}
            {qt.validUntil && ` · valid until ${formatDate(qt.validUntil)}`}
            {qt.lead && (
              <>
                {' · '}
                <Link to="/w/$workspaceId/crm/leads/$id" params={{ workspaceId, id: qt.lead.id }} className="hover:underline">
                  {qt.lead.title}
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {qt.status === 'draft' && manage && (
            <>
              <Button variant="ghost" onClick={() => void run('delete').catch(() => undefined)}>
                <Trash2 />
                Delete
              </Button>
              <Button variant="outline" asChild>
                <Link to="/w/$workspaceId/crm/quotes/$id/edit" params={{ workspaceId, id }}>
                  <Pencil />
                  Edit
                </Link>
              </Button>
              <Button onClick={() => void run('send').catch(() => undefined)} disabled={act.isPending}>
                <Send />
                Mark as sent
              </Button>
            </>
          )}
          {qt.status !== 'draft' && manage && (
            <Button variant="ghost" onClick={() => void run('copy').catch(() => undefined)} disabled={act.isPending}>
              <Copy />
              Revise as a copy
            </Button>
          )}
          {qt.status !== 'draft' && (
            <Button variant="outline" onClick={() => window.print()}>
              <Printer />
              Print
            </Button>
          )}
          {qt.status === 'sent' && manage && !qt.expired && (
            <>
              <Button variant="outline" onClick={() => void run('decline').catch(() => undefined)} disabled={act.isPending}>
                <X />
                Declined
              </Button>
              <Button onClick={() => void run('accept').catch(() => undefined)} disabled={act.isPending}>
                <Check />
                Accepted
              </Button>
            </>
          )}
          {qt.status === 'accepted' && !qt.salesOrder && can('sales.manage') && (
            <Button onClick={() => void run('order').catch(() => undefined)} disabled={act.isPending}>
              <ShoppingBag />
              Make a sales order
            </Button>
          )}
          {qt.salesOrder && (
            <Button asChild>
              <Link to="/w/$workspaceId/crm/orders/$id" params={{ workspaceId, id: qt.salesOrder.id }}>
                <ShoppingBag />
                {qt.salesOrder.number ?? 'Draft sales order'}
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
      {qt.expired && (
        <Alert className="print:hidden">
          <AlertDescription>This quote has expired. Revise it as a copy to quote again at today’s prices.</AlertDescription>
        </Alert>
      )}
      <SalesDocument
        title="Quotation"
        number={qt.number}
        date={qt.date}
        customer={qt.customer.name}
        meta={qt.validUntil ? [`Valid until ${formatDate(qt.validUntil)}`] : []}
        lines={qt.lines}
        showProgress={false}
        totals={qt}
        notes={qt.notes}
      />
    </div>
  )
}

/* =============================================================================================
 * A sales order
 * =========================================================================================== */

export function OrderPage({ id }: { id: string }) {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const navigate = useNavigate()
  const q = useQuery(crmQueries.order(workspaceId, id))
  const [delivering, setDelivering] = useState(false)
  type Action = 'confirm' | 'cancel' | 'close' | 'delete' | 'invoice'
  const act = useWorkspaceMutation((w, what: Action) =>
    what === 'delete' ? api(`/w/${w}/sales-orders/${id}`, { method: 'DELETE' }) : api<{ invoiceId?: string }>(`/w/${w}/sales-orders/${id}/${what}`, { method: 'POST' }),
  )
  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Loading />
  const o = q.data
  const open = ['confirmed', 'partly_delivered', 'delivered'].includes(o.status)
  const toDeliver = o.lines.some((l) => l.item.kind === 'stock' && l.deliveredQty < l.quantity)
  const toInvoice = o.lines.some((l) => (l.item.kind === 'stock' ? l.deliveredQty : l.quantity) > l.invoicedQty)
  const touched = o.lines.some((l) => l.deliveredQty > 0 || l.invoicedQty > 0)
  const manage = can('sales.manage')

  async function run(what: Action) {
    const r = (await act.mutateAsync(what)) as { invoiceId?: string } | undefined
    if (what === 'delete') await navigate({ to: '/w/$workspaceId/crm/orders', params: { workspaceId } })
    if (what === 'invoice' && r?.invoiceId) await navigate({ to: '/w/$workspaceId/finance/invoices/$id/edit', params: { workspaceId, id: r.invoiceId } })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">{o.number ?? 'Draft sales order'}</h2>
            <OrderStatusBadge status={o.status} />
          </div>
          <p className="text-muted-foreground text-sm">
            <Link to="/w/$workspaceId/crm/customers/$id" params={{ workspaceId, id: o.customer.id }} className="hover:underline">
              {o.customer.name}
            </Link>{' '}
            · {formatDate(o.date)}
            {o.deliveryDate && ` · deliver by ${formatDate(o.deliveryDate)}`}
            {o.warehouse && ` · from ${o.warehouse.name}`}
            {o.quote && (
              <>
                {' · '}
                <Link to="/w/$workspaceId/crm/quotes/$id" params={{ workspaceId, id: o.quote.id }} className="hover:underline">
                  quote {o.quote.number}
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {o.status === 'draft' && manage && (
            <>
              <Button variant="ghost" onClick={() => void run('delete').catch(() => undefined)}>
                <Trash2 />
                Delete
              </Button>
              <Button variant="outline" asChild>
                <Link to="/w/$workspaceId/crm/orders/$id/edit" params={{ workspaceId, id }}>
                  <Pencil />
                  Edit
                </Link>
              </Button>
              <Button onClick={() => void run('confirm').catch(() => undefined)} disabled={act.isPending}>
                <Check />
                Confirm
              </Button>
            </>
          )}
          {open && manage && !touched && (
            <Button variant="ghost" onClick={() => void run('cancel').catch(() => undefined)}>
              <Ban />
              Cancel
            </Button>
          )}
          {open && manage && touched && toDeliver && (
            <Button variant="ghost" onClick={() => void run('close').catch(() => undefined)}>
              <CheckCheck />
              Close
            </Button>
          )}
          {o.status !== 'draft' && (
            <Button variant="outline" onClick={() => window.print()}>
              <Printer />
              Print
            </Button>
          )}
          {(open || o.status === 'closed') && toInvoice && can('finance.edit') && (
            <Button variant="outline" onClick={() => void run('invoice').catch(() => undefined)} disabled={act.isPending}>
              <FileText />
              Create invoice
            </Button>
          )}
          {['confirmed', 'partly_delivered'].includes(o.status) && toDeliver && can('inventory.manage') && (
            <Button onClick={() => setDelivering(true)}>
              <Truck />
              Deliver
            </Button>
          )}
        </div>
      </div>
      {act.error && (
        <Alert variant="destructive">
          <AlertDescription>{act.error.message}</AlertDescription>
        </Alert>
      )}

      <SalesDocument
        title="Sales order"
        number={o.number}
        date={o.date}
        customer={o.customer.name}
        meta={[o.customerPoNo ? `Their PO ${o.customerPoNo}` : '', o.deliveryDate ? `Deliver by ${formatDate(o.deliveryDate)}` : ''].filter(Boolean)}
        lines={o.lines}
        showProgress={o.status !== 'draft'}
        totals={o}
        notes={o.notes}
      />

      <OrderProduction order={o} />

      {o.status !== 'draft' && (o.deliveries.length > 0 || o.invoices.length > 0) && (
        <div className="grid gap-6 md:grid-cols-2 print:hidden">
          <Card>
            <CardHeader>
              <CardTitle>Deliveries</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {o.deliveries.length === 0 && <p className="text-muted-foreground">Nothing yet.</p>}
              {o.deliveries.map((d) => (
                <Link key={d.id} to="/w/$workspaceId/crm/deliveries/$id" params={{ workspaceId, id: d.id }} className="flex justify-between hover:underline">
                  <span>
                    {d.number} · {formatDate(d.date)}
                  </span>
                </Link>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Invoices</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {o.invoices.length === 0 && <p className="text-muted-foreground">Nothing yet.</p>}
              {o.invoices.map((inv) =>
                can('finance.view') ? (
                  <Link key={inv.id} to="/w/$workspaceId/finance/invoices/$id" params={{ workspaceId, id: inv.id }} className="flex justify-between hover:underline">
                    <span>
                      {inv.number ?? 'Draft invoice'} · {inv.status}
                    </span>
                    <span className="tabular-nums">{formatPeso(inv.total)}</span>
                  </Link>
                ) : (
                  <p key={inv.id} className="flex justify-between">
                    <span>
                      {inv.number ?? 'Draft invoice'} · {inv.status}
                    </span>
                    <span className="tabular-nums">{formatPeso(inv.total)}</span>
                  </p>
                ),
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <Dialog open={delivering} onOpenChange={setDelivering}>
        <DialogContent className="sm:max-w-2xl">{delivering && <DeliverForm order={o} onDone={() => setDelivering(false)} />}</DialogContent>
      </Dialog>
    </div>
  )
}

/** What went out: quantity per line (defaults to what's still to deliver), and a lot if it matters. */
function DeliverForm({ order, onDone }: { order: SalesOrder; onDone: () => void }) {
  const workspaceId = useWorkspaceId()
  const navigate = useNavigate()
  const warehouses = useQuery(crmQueries.warehouses(workspaceId))
  const pending = order.lines.filter((l) => l.item.kind === 'stock' && l.deliveredQty < l.quantity)
  const [date, setDate] = useState(today())
  const [warehouseId, setWarehouseId] = useState(order.warehouse?.id ?? '')
  const [notes, setNotes] = useState('')
  const [rows, setRows] = useState(pending.map((l) => ({ soLineId: l.id, quantity: String(Math.round((l.quantity - l.deliveredQty) * 10_000) / 10_000), lotNo: '' })))
  const [error, setError] = useState<string>()
  const deliver = useWorkspaceMutation((w, body: object) => api<{ delivery: { id: string } }>(`/w/${w}/sales-orders/${order.id}/deliver`, { method: 'POST', body }))
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const whId = warehouseId || warehouses.data?.[0]?.id || ''

  async function submit() {
    setError(undefined)
    const lines = rows.filter((r) => Number(r.quantity) > 0).map((r) => ({ ...r, quantity: Number(r.quantity) }))
    if (!lines.length) return setError('Enter how many of at least one item went out.')
    try {
      const r = await deliver.mutateAsync({ date, warehouseId: whId, notes, lines })
      onDone()
      await navigate({ to: '/w/$workspaceId/crm/deliveries/$id', params: { workspaceId, id: r.delivery.id } })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Deliver {order.number}</DialogTitle>
        <DialogDescription>Enter what actually went out. The rest stays on the order. Lots that expire first go first unless you name one.</DialogDescription>
      </DialogHeader>
      <FormError message={error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="d-date">Date delivered</Label>
          <Input id="d-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="d-wh">From</Label>
          <NativeSelect id="d-wh" value={whId} onChange={(e) => setWarehouseId(e.target.value)}>
            {warehouses.data?.map((w) => (
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
              {formatQty(l.quantity - l.deliveredQty)} {l.item.unit} still to deliver
            </p>
          </div>
          <div className="grid gap-1.5 sm:col-span-3">
            <Label htmlFor={`d${i}-qty`} className="text-muted-foreground text-xs">
              Went out ({l.item.unit})
            </Label>
            <Input id={`d${i}-qty`} inputMode="decimal" className="text-right" value={rows[i]!.quantity} onChange={(e) => set(i, { quantity: e.target.value })} />
          </div>
          {l.item.trackLots && (
            <div className="grid gap-1.5 sm:col-span-3">
              <Label htmlFor={`d${i}-lot`} className="text-muted-foreground text-xs">
                Lot (blank: earliest expiry)
              </Label>
              <Input id={`d${i}-lot`} value={rows[i]!.lotNo} onChange={(e) => set(i, { lotNo: e.target.value })} />
            </div>
          )}
        </div>
      ))}
      <div className="grid gap-2">
        <Label htmlFor="d-notes">Notes for the driver or customer</Label>
        <Textarea id="d-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={deliver.isPending}>
          {deliver.isPending ? 'Delivering…' : 'Deliver'}
        </Button>
      </DialogFooter>
    </div>
  )
}

/* =============================================================================================
 * Deliveries
 * =========================================================================================== */

export function DeliveriesPage() {
  const workspaceId = useWorkspaceId()
  const navigate = useNavigate()
  const q = useQuery(crmQueries.deliveries(workspaceId))
  return (
    <div>
      <PageHeader title="Deliveries" description="Delivery receipts: what went to whom, from which order." />
      {q.error ? (
        <LoadError error={q.error} />
      ) : !q.data ? (
        <Loading />
      ) : q.data.length === 0 ? (
        <EmptyState title="Nothing delivered yet">Deliver a confirmed sales order and its receipt shows here.</EmptyState>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="hidden md:table-cell">Order</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Items</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((d) => (
                <TableRow key={d.id} className="cursor-pointer" onClick={() => void navigate({ to: '/w/$workspaceId/crm/deliveries/$id', params: { workspaceId, id: d.id } })}>
                  <TableCell className="font-medium whitespace-nowrap">{d.number}</TableCell>
                  <TableCell className="max-w-56 truncate">{d.customer.name}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(d.date)}</TableCell>
                  <TableCell className="text-muted-foreground hidden md:table-cell">{d.salesOrder.number}</TableCell>
                  <TableCell className="hidden text-right tabular-nums sm:table-cell">{d.lines.length}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

export function DeliveryPage({ id }: { id: string }) {
  const workspace = useWorkspace()
  const workspaceId = workspace.id
  const q = useQuery(crmQueries.delivery(workspaceId, id))
  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Loading />
  const d = q.data
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">{d.number}</h2>
          <p className="text-muted-foreground text-sm">
            {d.customer.name} · {formatDate(d.date)} · on{' '}
            <Link to="/w/$workspaceId/crm/orders/$id" params={{ workspaceId, id: d.salesOrder.id }} className="hover:underline">
              {d.salesOrder.number}
            </Link>
          </p>
        </div>
        <Button variant="outline" onClick={() => window.print()}>
          <Printer />
          Print
        </Button>
      </div>
      <article className="bg-card space-y-6 rounded-xl border p-6 md:p-10 print:border-0 print:p-0">
        <header className="flex flex-wrap justify-between gap-6 border-b pb-6">
          <div>
            <p className="text-lg font-semibold">{workspace.name}</p>
            <p className="text-muted-foreground text-sm">TIN {workspace.tin}</p>
            <p className="text-muted-foreground max-w-xs text-sm">{workspace.registeredAddress}</p>
          </div>
          <div className="text-right">
            <p className="text-sm font-semibold tracking-widest uppercase">Delivery receipt</p>
            <p className="text-xl font-semibold">{d.number}</p>
            <p className="text-muted-foreground text-sm">{formatDate(d.date)}</p>
          </div>
        </header>
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Delivered to</p>
            <p className="font-medium">{d.customer.name}</p>
            {d.customer.tin && <p className="text-muted-foreground text-sm">TIN {d.customer.tin}</p>}
            {d.customer.address && <p className="text-muted-foreground max-w-xs text-sm">{d.customer.address}</p>}
          </div>
          <div className="sm:text-right">
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Order</p>
            <p className="font-medium">{d.salesOrder.number}</p>
            {d.salesOrder.customerPoNo && <p className="text-muted-foreground text-sm">Your PO {d.salesOrder.customerPoNo}</p>}
            <p className="text-muted-foreground text-sm">From {d.warehouse.name}</p>
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-0">Item</TableHead>
              <TableHead>Lot</TableHead>
              <TableHead className="pr-0 text-right">Quantity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.lines.map((l, i) => (
              <TableRow key={i}>
                <TableCell className="pl-0">
                  {l.item.name}
                  <span className="text-muted-foreground block text-xs">{l.item.sku}</span>
                  <HazardNote itemId={l.item.id} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {l.lotNo ?? '—'}
                  {l.expiryDate && <span className="block text-xs">expires {formatDate(l.expiryDate)}</span>}
                </TableCell>
                <TableCell className="pr-0 text-right whitespace-nowrap tabular-nums">
                  {formatQty(l.quantity)} {l.item.unit}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {d.notes && <p className="text-muted-foreground text-sm whitespace-pre-line">{d.notes}</p>}
        <div className="grid gap-10 pt-10 sm:grid-cols-2">
          <div className="border-t pt-2 text-sm">Released by</div>
          <div className="border-t pt-2 text-sm">Received in good order by (name, signature, date)</div>
        </div>
        <p className="text-muted-foreground text-xs">Demo – not registered with the BIR. This is not an invoice.</p>
      </article>
    </div>
  )
}
