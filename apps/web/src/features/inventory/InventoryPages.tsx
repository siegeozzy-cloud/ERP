import {
  centavosToInput,
  formatPeso,
  ITEM_KIND_LABELS,
  ITEM_KINDS,
  MOVE_KIND_LABELS,
  parsePeso,
  templateByKey,
  hasFeature,
  type ItemDetail,
  type QuarantineLot,
  VAT_TREATMENT_LABELS,
  VAT_TREATMENTS,
  WarehouseInput,
  type InventoryOverview,
  type Item,
  type ItemKind,
  type VatTreatment,
  type Warehouse,
} from '@erp/shared'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { ArrowLeftRight, ClipboardList, Pencil, Plus, Printer, Search, ShoppingCart, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import type { z } from 'zod'
import { Field, FormError } from '@/components/form'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState, LoadError, Loading, Money, PageHeader } from '@/features/finance/components'
import { financeQueries, useWorkspaceMutation } from '@/features/finance/queries'
import { useCan, useWorkspace, useWorkspaceId } from '@/features/workspaces/queries'
import { api, ApiError } from '@/lib/api'
import { formatDate, today } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { formatQty, inventoryQueries } from './queries'

/* =============================================================================================
 * Frame
 * =========================================================================================== */

const TABS = [
  { to: '/w/$workspaceId/inventory', label: 'Overview', exact: true },
  { to: '/w/$workspaceId/inventory/items', label: 'Items' },
  { to: '/w/$workspaceId/inventory/purchase-orders', label: 'Purchase orders' },
  { to: '/w/$workspaceId/inventory/stock', label: 'Stock moves' },
  { to: '/w/$workspaceId/inventory/valuation', label: 'Valuation' },
  { to: '/w/$workspaceId/inventory/warehouses', label: 'Warehouses' },
] as const

export function InventoryLayout() {
  const workspace = useWorkspace()
  const can = useCan()
  if (!workspace.modules.includes('inventory')) {
    return (
      <EmptyState title="Inventory is turned off">
        An owner or admin can turn it on in Settings → Workspace → Modules.
      </EmptyState>
    )
  }
  if (!can('inventory.view')) {
    return <EmptyState title="Your role can’t see Inventory">You’re here as {workspace.role.name}. An owner or admin can change that.</EmptyState>
  }
  return (
    <>
      <nav aria-label="Inventory" className="-mx-4 mb-6 overflow-x-auto border-b px-4 md:mx-0 md:px-0 print:hidden">
        <div className="flex min-w-max gap-1">
          {[...TABS, ...(hasFeature(workspace.template, 'qcRelease') ? [{ to: '/w/$workspaceId/inventory/quality' as const, label: 'Quality control' }] : [])].map((t) => (
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

/**
 * Lots already past their date, pulled off the shelves in one go: an "expired" adjustment per
 * warehouse. Templates with a spoilage account (Food) book the loss there.
 */
function WriteOffExpired({ lots }: { lots: InventoryOverview['expiring'] }) {
  const [error, setError] = useState<string | null>(null)
  const writeOff = useWorkspaceMutation(async (w, rows: InventoryOverview['expiring']) => {
    for (const warehouseId of new Set(rows.map((r) => r.warehouseId))) {
      await api(`/w/${w}/stock/adjustments`, {
        method: 'POST',
        body: {
          date: today(),
          warehouseId,
          reason: 'expired',
          notes: 'Expired lots pulled from the shelves and written off',
          lines: rows.filter((r) => r.warehouseId === warehouseId).map((r) => ({ itemId: r.itemId, change: -r.quantity, lotNo: r.lotNo })),
        },
      })
    }
  })
  const expired = lots.filter((l) => l.expiryDate < today())
  if (!expired.length) return null
  return (
    <div className="grid gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={writeOff.isPending}
        onClick={() => {
          setError(null)
          if (!confirm(`Write off ${expired.length} expired lot${expired.length === 1 ? '' : 's'}? Their stock leaves the books as a loss.`)) return
          writeOff.mutate(expired, { onError: (e) => setError(e.message) })
        }}
      >
        <Trash2 />
        {writeOff.isPending ? 'Writing off…' : `Write off ${expired.length} expired`}
      </Button>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  )
}

export function InventoryOverviewPage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const q = useQuery(inventoryQueries.overview(workspaceId))
  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Loading />
  const o = q.data
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap gap-2">
        {can('purchasing.manage') && (
          <Button asChild>
            <Link to="/w/$workspaceId/inventory/purchase-orders/new" params={{ workspaceId }}>
              <ShoppingCart />
              New purchase order
            </Link>
          </Button>
        )}
        {can('inventory.manage') && (
          <>
            <Button variant="outline" asChild>
              <Link to="/w/$workspaceId/inventory/stock/adjust" params={{ workspaceId }}>
                <ClipboardList />
                Count or adjust
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/w/$workspaceId/inventory/stock/transfer" params={{ workspaceId }}>
                <ArrowLeftRight />
                Move stock
              </Link>
            </Button>
          </>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Stock value" value={formatPeso(o.stockValue)} note="At moving average cost" />
        <Stat label="Stock items" value={String(o.itemCount)} />
        <Stat label="Running low" value={String(o.low.length)} />
        <Stat label="Open purchase orders" value={String(o.openPurchaseOrders)} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Running low</CardTitle>
            <CardDescription>At or below their reorder point.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {o.low.length === 0 ? (
              <p className="text-muted-foreground px-6 text-sm">Nothing is running low.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Item</TableHead>
                    <TableHead className="text-right">On hand</TableHead>
                    <TableHead className="pr-6 text-right">Reorder</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {o.low.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell className="pl-6">
                        <Link to="/w/$workspaceId/inventory/items/$id" params={{ workspaceId, id: i.id }} className="font-medium hover:underline">
                          {i.name}
                        </Link>
                        <span className="text-muted-foreground block text-xs">{i.sku}</span>
                      </TableCell>
                      <TableCell className="text-destructive text-right tabular-nums">
                        {formatQty(i.onHand)} {i.unit}
                      </TableCell>
                      <TableCell className="pr-6 text-right tabular-nums">{i.reorderQty ? `${formatQty(i.reorderQty)} ${i.unit}` : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
            <div className="space-y-1.5">
              <CardTitle>Expiring within 90 days</CardTitle>
              <CardDescription>Lots to sell first. Expired ones (in red) can’t be sold.</CardDescription>
            </div>
            {can('inventory.manage') && <WriteOffExpired lots={o.expiring} />}
          </CardHeader>
          <CardContent className="px-0">
            {o.expiring.length === 0 ? (
              <p className="text-muted-foreground px-6 text-sm">No lots expire in the next 90 days.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Item and lot</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="pr-6 text-right">Quantity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {o.expiring.map((e) => (
                    <TableRow key={`${e.itemId}-${e.lotNo}-${e.warehouse}`}>
                      <TableCell className="pl-6">
                        <span className="font-medium">{e.name}</span>
                        <span className="text-muted-foreground block text-xs">
                          Lot {e.lotNo} · {e.warehouse}
                        </span>
                      </TableCell>
                      <TableCell className={e.expiryDate < today() ? 'text-destructive whitespace-nowrap' : 'whitespace-nowrap'}>{formatDate(e.expiryDate)}</TableCell>
                      <TableCell className="pr-6 text-right tabular-nums">{formatQty(e.quantity)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

/* =============================================================================================
 * Items
 * =========================================================================================== */

type ItemValues = {
  sku: string
  name: string
  description: string
  kind: ItemKind
  barcode: string
  unitId: string
  salesPrice: string
  purchaseCost: string
  salesVat: VatTreatment
  trackLots: boolean
  trackExpiry: boolean
  reorderPoint: string
  reorderQty: string
  salesAccountId: string
  expenseAccountId: string
  active: boolean
  attributes: Record<string, string>
}

/** Adding or editing an item. Mounts with the dialog, so every opening starts from the item (or blank). */
function ItemForm({ item, onDone }: { item?: Item; onDone: (id: string) => void }) {
  const workspace = useWorkspace()
  const template = templateByKey(workspace.template)
  const unitsQ = useQuery(inventoryQueries.units(workspace.id))
  const accounts = useQuery(financeQueries.accounts(workspace.id))
  const form = useForm<ItemValues>({
    defaultValues: {
      sku: item?.sku ?? '',
      name: item?.name ?? '',
      description: item?.description ?? '',
      kind: item?.kind ?? 'stock',
      barcode: item?.barcode ?? '',
      unitId: item?.unit.id ?? '',
      salesPrice: item ? centavosToInput(item.salesPrice) : '',
      purchaseCost: item ? centavosToInput(item.purchaseCost) : '',
      salesVat: item?.salesVat ?? (workspace.vatStatus === 'vat' ? 'vatable' : 'none'),
      // a new item starts the way the workspace's template says (Food: lots and expiry tracked)
      trackLots: item?.trackLots ?? template?.itemDefaults?.trackLots ?? false,
      trackExpiry: item?.trackExpiry ?? template?.itemDefaults?.trackExpiry ?? false,
      reorderPoint: item ? String(item.reorderPoint) : '0',
      reorderQty: item ? String(item.reorderQty) : '0',
      salesAccountId: item?.salesAccountId ?? '',
      expenseAccountId: item?.expenseAccountId ?? '',
      active: item?.active ?? true,
      attributes: item?.attributes ?? {},
    },
  })
  const { errors, isSubmitting } = form.formState
  const kind = form.watch('kind')
  const save = useWorkspaceMutation((w, body: object) =>
    item ? api<{ item: Item }>(`/w/${w}/items/${item.id}`, { method: 'PUT', body }) : api<{ item: Item }>(`/w/${w}/items`, { method: 'POST', body }),
  )

  const onSubmit = form.handleSubmit(async (v) => {
    const salesPrice = v.salesPrice.trim() ? parsePeso(v.salesPrice) : 0
    const purchaseCost = v.purchaseCost.trim() ? parsePeso(v.purchaseCost) : 0
    if (salesPrice === null) return form.setError('salesPrice', { message: 'Enter an amount, like 1,500.00.' })
    if (purchaseCost === null) return form.setError('purchaseCost', { message: 'Enter an amount, like 1,100.00.' })
    try {
      const { item: saved } = await save.mutateAsync({
        ...v,
        salesPrice,
        purchaseCost,
        reorderPoint: v.kind === 'stock' ? Number(v.reorderPoint || 0) : 0,
        reorderQty: v.kind === 'stock' ? Number(v.reorderQty || 0) : 0,
        trackLots: v.kind === 'stock' && v.trackLots,
        trackExpiry: v.kind === 'stock' && v.trackLots && v.trackExpiry,
        salesAccountId: v.salesAccountId || null,
        expenseAccountId: v.expenseAccountId || null,
      })
      onDone(saved.id)
    } catch (e) {
      const field = e instanceof ApiError ? e.field : undefined
      if (field && field in v) form.setError(field as keyof ItemValues, { message: (e as Error).message })
      else form.setError('root', { message: (e as Error).message })
    }
  })

  const vatOptions = VAT_TREATMENTS.filter((t) => (workspace.vatStatus === 'vat' ? t !== 'none' : t === 'none'))
  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{item ? `Edit ${item.name}` : 'New item'}</DialogTitle>
        <DialogDescription>Something you sell, buy or keep in stock.</DialogDescription>
      </DialogHeader>
      <FormError message={errors.root?.message} />
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        <Field id="i-sku" label="SKU" error={errors.sku?.message}>
          <Input id="i-sku" className="uppercase" {...form.register('sku')} />
        </Field>
        <Field id="i-name" label="Name" error={errors.name?.message}>
          <Input id="i-name" {...form.register('name')} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="i-kind" label="Type" error={errors.kind?.message}>
          <NativeSelect id="i-kind" {...form.register('kind')}>
            {ITEM_KINDS.map((k) => (
              <option key={k} value={k}>
                {ITEM_KIND_LABELS[k]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="i-unit" label="Unit" error={errors.unitId?.message}>
          <NativeSelect id="i-unit" {...form.register('unitId')}>
            <option value="">Choose…</option>
            {unitsQ.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.code})
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="i-price" label="Selling price (₱)" error={errors.salesPrice?.message}>
          <Input id="i-price" inputMode="decimal" className="text-right" {...form.register('salesPrice')} />
        </Field>
        <Field id="i-cost" label="Usual cost (₱)" error={errors.purchaseCost?.message}>
          <Input id="i-cost" inputMode="decimal" className="text-right" {...form.register('purchaseCost')} />
        </Field>
        <Field id="i-vat" label="Sold as">
          <NativeSelect id="i-vat" {...form.register('salesVat')}>
            {vatOptions.map((t) => (
              <option key={t} value={t}>
                {VAT_TREATMENT_LABELS[t]}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <Field id="i-barcode" label="Barcode" error={errors.barcode?.message} hint="Scan it with the phone app to look the item up.">
        <Input id="i-barcode" inputMode="numeric" {...form.register('barcode')} />
      </Field>
      {/* the template's own fields: FDA registration, hazard class, brand… */}
      {!!template?.itemFields?.length && (
        <div className="grid gap-4 sm:grid-cols-2">
          {template.itemFields.map((f) => (
            <Field key={f.key} id={`i-attr-${f.key}`} label={`${f.label}${f.requiredForSale ? ' (needed to sell)' : ''}`} hint={f.hint}>
              {f.options ? (
                <NativeSelect id={`i-attr-${f.key}`} {...form.register(`attributes.${f.key}`)}>
                  <option value="">—</option>
                  {f.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </NativeSelect>
              ) : (
                <Input id={`i-attr-${f.key}`} type={f.kind === 'url' ? 'url' : f.kind === 'date' ? 'date' : 'text'} inputMode={f.kind === 'number' ? 'decimal' : undefined} {...form.register(`attributes.${f.key}`)} />
              )}
            </Field>
          ))}
        </div>
      )}
      {kind === 'stock' && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="i-rop" label="Reorder when down to" error={errors.reorderPoint?.message} hint="0 means never warn.">
              <Input id="i-rop" inputMode="decimal" className="text-right" {...form.register('reorderPoint')} />
            </Field>
            <Field id="i-roq" label="Usual order quantity" error={errors.reorderQty?.message}>
              <Input id="i-roq" inputMode="decimal" className="text-right" {...form.register('reorderQty')} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-6">
            {(['trackLots', 'trackExpiry'] as const).map((name) => (
              <div key={name} className="flex items-center gap-2">
                <Controller control={form.control} name={name} render={({ field }) => <Checkbox id={`i-${name}`} checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} disabled={!!item && name === 'trackLots'} />} />
                <Label htmlFor={`i-${name}`} className="font-normal">
                  {name === 'trackLots' ? 'Track lots (batch numbers)' : 'Track expiry dates'}
                </Label>
              </div>
            ))}
          </div>
          {errors.trackExpiry && <p className="text-destructive -mt-2 text-sm">{errors.trackExpiry.message}</p>}
        </>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="i-sales-acct" label="Sales go to">
          <NativeSelect id="i-sales-acct" {...form.register('salesAccountId')}>
            <option value="">Sales (default)</option>
            {accounts.data
              ?.filter((a) => a.type === 'income' && a.active)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name}
                </option>
              ))}
          </NativeSelect>
        </Field>
        {kind === 'service' && (
          <Field id="i-exp-acct" label="Purchases go to">
            <NativeSelect id="i-exp-acct" {...form.register('expenseAccountId')}>
              <option value="">Choose on each bill</option>
              {accounts.data
                ?.filter((a) => (a.type === 'expense' || a.type === 'asset') && a.active)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
            </NativeSelect>
          </Field>
        )}
      </div>
      {item && (
        <div className="flex items-center gap-2">
          <Controller control={form.control} name="active" render={({ field }) => <Checkbox id="i-active" checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} />} />
          <Label htmlFor="i-active" className="font-normal">
            Active (turned-off items can’t go on new documents)
          </Label>
        </div>
      )}
      <DialogFooter>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Save item'}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function ItemDialog({ open, onOpenChange, item, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; item?: Item; onSaved?: (id: string) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {open && (
          <ItemForm
            item={item}
            onDone={(id) => {
              onOpenChange(false)
              onSaved?.(id)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

export function ItemsPage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const navigate = useNavigate()
  const q = useQuery(inventoryQueries.items(workspaceId))
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)
  const open = (id: string) => navigate({ to: '/w/$workspaceId/inventory/items/$id', params: { workspaceId, id } })
  const term = search.trim().toLowerCase()
  const shown = q.data?.filter((i) => !term || i.name.toLowerCase().includes(term) || i.sku.toLowerCase().includes(term) || i.barcode === search.trim())

  return (
    <div>
      <PageHeader
        title="Items"
        description="What you sell and buy. Stock items are counted; services aren’t."
        actions={
          can('inventory.manage') ? (
            <Button onClick={() => setAdding(true)}>
              <Plus />
              New item
            </Button>
          ) : undefined
        }
      />
      <div className="relative mb-4 max-w-sm">
        <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <Input aria-label="Search items" placeholder="Search by name, SKU or barcode" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {q.error ? (
        <LoadError error={q.error} />
      ) : !shown ? (
        <Loading />
      ) : shown.length === 0 ? (
        <EmptyState title={term ? 'No items match' : 'No items yet'} action={!term && can('inventory.manage') ? <Button onClick={() => setAdding(true)}>Add your first item</Button> : undefined} />
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">On hand</TableHead>
                <TableHead className="hidden text-right md:table-cell">Avg. cost</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Price</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((i) => (
                <TableRow key={i.id} className={i.active ? 'cursor-pointer' : 'cursor-pointer opacity-60'} onClick={() => void open(i.id)}>
                  <TableCell className="min-w-56">
                    <button type="button" className="text-left font-medium hover:underline" onClick={() => void open(i.id)}>
                      {i.name}
                    </button>
                    <span className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                      {i.sku}
                      {i.kind === 'service' && <Badge variant="secondary">Service</Badge>}
                      {i.low && <Badge className="bg-destructive text-white">Low</Badge>}
                      {!i.active && <Badge variant="outline">Off</Badge>}
                    </span>
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">{i.kind === 'stock' ? `${formatQty(i.onHand)} ${i.unit.code}` : '—'}</TableCell>
                  <TableCell className="hidden text-right md:table-cell">{i.kind === 'stock' ? <Money value={Math.round(i.averageCost)} /> : '—'}</TableCell>
                  <TableCell className="text-right">{i.kind === 'stock' ? <Money value={i.value} /> : '—'}</TableCell>
                  <TableCell className="hidden text-right sm:table-cell">
                    <Money value={i.salesPrice} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <ItemDialog open={adding} onOpenChange={setAdding} onSaved={(id) => void open(id)} />
    </div>
  )
}

/** The template's extra fields on an item: FDA registration, hazard class, brand… */
function ItemAttributes({ item }: { item: ItemDetail }) {
  const workspace = useWorkspace()
  const fields = (templateByKey(workspace.template)?.itemFields ?? []).filter((f) => item.attributes[f.key])
  const missing = (templateByKey(workspace.template)?.itemFields ?? []).filter((f) => f.requiredForSale && !item.attributes[f.key])
  if (!fields.length && !missing.length) return null
  return (
    <Card>
      <CardContent className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((f) => (
          <div key={f.key} className="text-sm">
            <p className="text-muted-foreground text-xs">{f.label}</p>
            {f.kind === 'url' ? (
              <a href={item.attributes[f.key]} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                Open
              </a>
            ) : (
              <p>{item.attributes[f.key]}</p>
            )}
          </div>
        ))}
        {missing.map((f) => (
          <p key={f.key} className="text-destructive text-sm sm:col-span-2 lg:col-span-3">
            No {f.label.replace(/ no\.$/, ' number')} yet: it can’t be sold until it has one.
          </p>
        ))}
      </CardContent>
    </Card>
  )
}

/** Apparel: the style's colours × sizes, with what's on hand of each, and making more. */
function VariantsCard({ item }: { item: ItemDetail }) {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const [colours, setColours] = useState('')
  const [sizes, setSizes] = useState('')
  const [error, setError] = useState<string>()
  const make = useWorkspaceMutation((w, body: object) => api<{ made: number }>(`/w/${w}/items/${item.id}/variants`, { method: 'POST', body }))
  const split = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)
  // sizes in the order people read them (XS, S, M, L, XL…, then numbers), colours as made
  const SIZE_ORDER = ['XXXS', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', 'XXXL', '3XL', '4XL']
  const rank = (z: string) => (SIZE_ORDER.includes(z.toUpperCase()) ? SIZE_ORDER.indexOf(z.toUpperCase()) : Number.isFinite(Number(z)) ? 100 + Number(z) : 1000)
  const cs = [...new Set(item.variants.map((v) => v.colour))]
  const ss = [...new Set(item.variants.map((v) => v.size))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  const cell = (c: string, z: string) => item.variants.find((v) => v.colour === c && v.size === z)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sizes and colours</CardTitle>
        <CardDescription>Each variant is its own item (with its own SKU and stock), made from this style.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {item.variants.length > 0 && (
          <div className="overflow-x-auto">
            <table className="text-sm">
              <thead>
                <tr>
                  <th className="pr-4 text-left font-medium" />
                  {ss.map((z) => (
                    <th key={z} className="px-3 py-1 text-right font-medium">
                      {z}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cs.map((c) => (
                  <tr key={c} className="border-t">
                    <th className="py-1.5 pr-4 text-left font-medium">{c}</th>
                    {ss.map((z) => {
                      const v = cell(c, z)
                      return (
                        <td key={z} className="px-3 py-1.5 text-right tabular-nums">
                          {v ? (
                            <Link to="/w/$workspaceId/inventory/items/$id" params={{ workspaceId, id: v.id }} className={cn('hover:underline', v.onHand <= 0 && 'text-muted-foreground')} title={v.sku}>
                              {formatQty(v.onHand)}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">·</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {can('inventory.manage') && (
          <form
            className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault()
              setError(undefined)
              make.mutate({ colours: split(colours), sizes: split(sizes) }, { onSuccess: () => (setColours(''), setSizes('')), onError: (er) => setError(er.message) })
            }}
          >
            <Field id="v-colours" label="Colours (separated by commas)">
              <Input id="v-colours" value={colours} onChange={(e) => setColours(e.target.value)} placeholder="Navy, White" />
            </Field>
            <Field id="v-sizes" label="Sizes">
              <Input id="v-sizes" value={sizes} onChange={(e) => setSizes(e.target.value)} placeholder="S, M, L, XL" />
            </Field>
            <Button type="submit" disabled={make.isPending}>
              Make variants
            </Button>
            {error && <p className="text-destructive text-sm sm:col-span-3">{error}</p>}
          </form>
        )}
      </CardContent>
    </Card>
  )
}

/** Lots waiting for quality control (templates with quality release, like Pharma). */
export function QualityPage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const q = useQuery({ queryKey: ['w', workspaceId, 'quarantine'], queryFn: async () => (await api<{ lots: QuarantineLot[] }>(`/w/${workspaceId}/lots/quarantine`)).lots })
  const [error, setError] = useState<string>()
  const decide = useWorkspaceMutation((w, { lotId, action, note }: { lotId: string; action: 'release' | 'reject'; note?: string }) =>
    api(`/w/${w}/lots/${lotId}/${action}`, { method: 'POST', body: action === 'reject' ? { date: today(), note } : { note } }),
  )
  return (
    <div>
      <PageHeader title="Quality control" description="Lots received or made wait here until QC releases them. They can’t be sold or used until then; a rejected lot is written off." />
      <FormError message={error} />
      {q.error ? (
        <LoadError error={q.error} />
      ) : !q.data ? (
        <Loading />
      ) : q.data.length === 0 ? (
        <EmptyState title="Nothing waiting">Every lot on hand has been released.</EmptyState>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Item and lot</TableHead>
                <TableHead>Received</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead className="pr-6" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((l) => (
                <TableRow key={l.lotId}>
                  <TableCell className="pl-6">
                    <Link to="/w/$workspaceId/inventory/items/$id" params={{ workspaceId, id: l.item.id }} className="font-medium hover:underline">
                      {l.item.name}
                    </Link>
                    <span className="text-muted-foreground block text-xs">Lot {l.lotNo}</span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(l.receivedOn)}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(l.expiryDate)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQty(l.quantity)} {l.item.unit}
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={l.value} />
                  </TableCell>
                  <TableCell className="pr-6 text-right whitespace-nowrap">
                    {can('inventory.manage') && (
                      <>
                        <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => {
                          const note = prompt(`Why did lot ${l.lotNo} fail? It will be written off.`)
                          if (note) decide.mutate({ lotId: l.lotId, action: 'reject', note }, { onError: (e) => setError(e.message) })
                        }}>
                          Reject
                        </Button>
                        <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ lotId: l.lotId, action: 'release' }, { onError: (e) => setError(e.message) })}>
                          Release
                        </Button>
                      </>
                    )}
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

export function ItemDetailPage({ id }: { id: string }) {
  const workspaceId = useWorkspaceId()
  const workspace = useWorkspace()
  const can = useCan()
  const q = useQuery(inventoryQueries.item(workspaceId, id))
  const [editing, setEditing] = useState(false)
  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Loading />
  const i = q.data
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">{i.name}</h2>
            {i.low && <Badge className="bg-destructive text-white">Running low</Badge>}
            {!i.active && <Badge variant="outline">Off</Badge>}
          </div>
          <p className="text-muted-foreground text-sm">
            {i.sku} · {ITEM_KIND_LABELS[i.kind]}
            {i.barcode && ` · Barcode ${i.barcode}`}
            {i.trackLots && ` · Lots${i.trackExpiry ? ' and expiry' : ''} tracked`}
          </p>
          {i.parent && (
            <p className="text-sm">
              A variant of{' '}
              <Link to="/w/$workspaceId/inventory/items/$id" params={{ workspaceId, id: i.parent.id }} className="underline underline-offset-2">
                {i.parent.name}
              </Link>
            </p>
          )}
        </div>
        {can('inventory.manage') && (
          <Button variant="outline" onClick={() => setEditing(true)}>
            <Pencil />
            Edit
          </Button>
        )}
      </div>
      {i.kind === 'stock' && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="On hand" value={`${formatQty(i.onHand)} ${i.unit.code}`} note={i.reorderPoint ? `Reorder at ${formatQty(i.reorderPoint)}` : undefined} />
          <Stat label="Value" value={formatPeso(i.value)} />
          <Stat label="Average cost" value={formatPeso(Math.round(i.averageCost))} note={`per ${i.unit.code}`} />
          <Stat label="Selling price" value={formatPeso(i.salesPrice)} note={`per ${i.unit.code}`} />
        </div>
      )}
      <ItemAttributes item={i} />
      {i.kind === 'stock' && !i.parent && hasFeature(workspace.template, 'variants') && <VariantsCard item={i} />}
      {i.kind === 'stock' && (
        <Card>
          <CardHeader>
            <CardTitle>Where it is</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            {i.levels.length === 0 ? (
              <p className="text-muted-foreground px-6 text-sm">None in stock.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Warehouse</TableHead>
                    {i.trackLots && <TableHead>Lot</TableHead>}
                    {i.trackExpiry && <TableHead>Expires</TableHead>}
                    <TableHead className="pr-6 text-right">Quantity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {i.levels.map((l) => (
                    <TableRow key={`${l.warehouse.id}-${l.lot?.id ?? ''}`}>
                      <TableCell className="pl-6">{l.warehouse.name}</TableCell>
                      {i.trackLots && (
                        <TableCell>
                          {l.lot?.lotNo ?? '—'}
                          {l.lot && l.lot.status !== 'released' && (
                            <Badge variant="outline" className="ml-2">
                              {l.lot.status === 'quarantine' ? 'Waiting for QC' : 'Rejected'}
                            </Badge>
                          )}
                        </TableCell>
                      )}
                      {i.trackExpiry && <TableCell className={l.lot?.expiryDate && l.lot.expiryDate < today() ? 'text-destructive' : ''}>{formatDate(l.lot?.expiryDate)}</TableCell>}
                      <TableCell className="pr-6 text-right tabular-nums">
                        {formatQty(l.quantity)} {i.unit.code}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
      {i.kind === 'stock' && (
        <Card>
          <CardHeader>
            <CardTitle>Movements</CardTitle>
            <CardDescription>The latest 100. These can’t be changed; corrections are new adjustments.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {i.moves.length === 0 ? (
              <p className="text-muted-foreground px-6 text-sm">No movements yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Date</TableHead>
                    <TableHead>What</TableHead>
                    <TableHead className="hidden sm:table-cell">Where</TableHead>
                    <TableHead className="text-right">Quantity</TableHead>
                    <TableHead className="pr-6 text-right">Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {i.moves.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="pl-6 whitespace-nowrap">{formatDate(m.date)}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {MOVE_KIND_LABELS[m.kind]}
                        {m.reference && <span className="text-muted-foreground"> · {m.reference}</span>}
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden sm:table-cell">
                        {m.warehouse.code}
                        {m.lot && ` · ${m.lot.lotNo}`}
                      </TableCell>
                      <TableCell className={m.quantity < 0 ? 'text-right tabular-nums' : 'text-success text-right tabular-nums'}>
                        {m.quantity > 0 ? '+' : ''}
                        {formatQty(m.quantity)}
                      </TableCell>
                      <TableCell className="pr-6 text-right">
                        <Money value={m.value} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
      <ItemDialog open={editing} onOpenChange={setEditing} item={i} />
    </div>
  )
}

/* =============================================================================================
 * Warehouses
 * =========================================================================================== */

function WarehouseForm({ warehouse, onDone }: { warehouse?: Warehouse; onDone: () => void }) {
  const form = useForm<z.input<typeof WarehouseInput>, unknown, z.output<typeof WarehouseInput>>({
    resolver: zodResolver(WarehouseInput),
    defaultValues: { code: warehouse?.code ?? '', name: warehouse?.name ?? '', address: warehouse?.address ?? '', active: warehouse?.active ?? true },
  })
  const { errors, isSubmitting } = form.formState
  const save = useWorkspaceMutation((w, body: object) => (warehouse ? api(`/w/${w}/warehouses/${warehouse.id}`, { method: 'PUT', body }) : api(`/w/${w}/warehouses`, { method: 'POST', body })))
  const onSubmit = form.handleSubmit(async (v) => {
    try {
      await save.mutateAsync(v)
      onDone()
    } catch (e) {
      const field = e instanceof ApiError ? e.field : undefined
      if (field === 'code' || field === 'active') form.setError(field, { message: (e as Error).message })
      else form.setError('root', { message: (e as Error).message })
    }
  })
  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{warehouse ? `Edit ${warehouse.name}` : 'New warehouse'}</DialogTitle>
        <DialogDescription>Anywhere stock is kept: a warehouse, a branch, a delivery truck.</DialogDescription>
      </DialogHeader>
      <FormError message={errors.root?.message} />
      <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
        <Field id="w-code" label="Code" error={errors.code?.message}>
          <Input id="w-code" className="uppercase" {...form.register('code')} />
        </Field>
        <Field id="w-name" label="Name" error={errors.name?.message}>
          <Input id="w-name" {...form.register('name')} />
        </Field>
      </div>
      <Field id="w-address" label="Address" error={errors.address?.message}>
        <Input id="w-address" {...form.register('address')} />
      </Field>
      {warehouse && (
        <div className="grid gap-1">
          <div className="flex items-center gap-2">
            <Controller control={form.control} name="active" render={({ field }) => <Checkbox id="w-active" checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} />} />
            <Label htmlFor="w-active" className="font-normal">
              Open (closed warehouses can’t receive or send stock)
            </Label>
          </div>
          {errors.active && <p className="text-destructive text-sm">{errors.active.message}</p>}
        </div>
      )}
      <DialogFooter>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function WarehousesPage() {
  const workspaceId = useWorkspaceId()
  const can = useCan()
  const q = useQuery(inventoryQueries.warehouses(workspaceId))
  const [editing, setEditing] = useState<Warehouse | 'new' | null>(null)
  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Loading />
  return (
    <div>
      <PageHeader
        title="Warehouses"
        actions={
          can('inventory.manage') ? (
            <Button onClick={() => setEditing('new')}>
              <Plus />
              New warehouse
            </Button>
          ) : undefined
        }
      />
      <div className="rounded-xl border">
        <Table>
          <TableBody>
            {q.data.map((w) => (
              <TableRow key={w.id} className={w.active ? '' : 'opacity-60'}>
                <TableCell className="w-24 font-medium">{w.code}</TableCell>
                <TableCell>
                  {w.name}
                  {w.address && <span className="text-muted-foreground block text-xs">{w.address}</span>}
                </TableCell>
                <TableCell className="text-right">
                  {!w.active && <Badge variant="outline">Closed</Badge>}
                  {can('inventory.manage') && (
                    <Button variant="ghost" size="sm" onClick={() => setEditing(w)}>
                      Edit
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>{editing !== null && <WarehouseForm warehouse={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} />}</DialogContent>
      </Dialog>
    </div>
  )
}

/* =============================================================================================
 * Valuation
 * =========================================================================================== */

export function ValuationPage() {
  const workspace = useWorkspace()
  const [asOf, setAsOf] = useState(today())
  const q = useQuery(inventoryQueries.valuation(workspace.id, asOf))
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <div className="grid gap-1.5">
          <Label htmlFor="asOf" className="text-muted-foreground text-xs">
            As of
          </Label>
          <Input id="asOf" type="date" className="w-40" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} />
        </div>
        <Button variant="outline" className="ml-auto" onClick={() => window.print()}>
          <Printer />
          Print
        </Button>
      </div>
      <div className="space-y-0.5">
        <p className="text-muted-foreground text-sm">
          {workspace.name} · TIN {workspace.tin}
        </p>
        <h2 className="text-2xl font-semibold tracking-tight">Stock valuation</h2>
        <p className="text-muted-foreground text-sm">As of {formatDate(asOf)}, at moving average cost. This equals the Inventory account in the trial balance.</p>
      </div>
      {q.error ? (
        <LoadError error={q.error} />
      ) : !q.data ? (
        <Loading />
      ) : q.data.rows.length === 0 ? (
        <EmptyState title="No stock on this date" />
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead className="text-right">Avg. cost</TableHead>
                <TableHead className="text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.rows.map((r) => (
                <TableRow key={r.itemId}>
                  <TableCell className="min-w-48">
                    {r.name}
                    <span className="text-muted-foreground block text-xs">{r.sku}</span>
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">
                    {formatQty(r.quantity)} {r.unit}
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={Math.round(r.averageCost)} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={r.value} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={3}>Total</TableCell>
                <TableCell className="text-right">
                  <Money value={q.data.total} />
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}
    </div>
  )
}

