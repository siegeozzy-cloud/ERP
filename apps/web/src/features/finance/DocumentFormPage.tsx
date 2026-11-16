import {
  centavosToInput,
  computeLine,
  computeTotals,
  formatPeso,
  formatRate,
  parsePeso,
  VAT_TREATMENT_LABELS,
  VAT_TREATMENTS,
  type Account,
  type Bill,
  type Invoice,
  type TaxCode,
  type VatTreatment,
} from '@erp/shared'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Controller, useFieldArray, useForm, type FieldPath } from 'react-hook-form'
import { FormError } from '@/components/form'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { projectQueries } from '@/features/projects/queries'
import { inventoryQueries } from '@/features/inventory/queries'
import { useCan, useWorkspace } from '@/features/workspaces/queries'
import { api, ApiError } from '@/lib/api'
import { today } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { LoadError, Loading, PageHeader } from './components'
import { ContactDialog } from './ContactsPage'
import { KIND_TEXT, type DocKind } from './DocumentListPage'
import { financeQueries, useWorkspaceMutation } from './queries'

type LineValues = { description: string; quantity: string; unitPrice: string; vat: VatTreatment; accountId: string; ewtCodeId: string; itemId: string; poLineId: string; soLineId: string }
type Values = { contactId: string; supplierInvoiceNo: string; date: string; dueDate: string; pricesIncludeVat: boolean; notes: string; warehouseId: string; projectId: string; lines: LineValues[] }

const NEW_CONTACT = '__new'

/** The VAT rate in force on a date, as the API will use it. */
function vatRateOn(taxCodes: TaxCode[], date: string) {
  return (
    taxCodes
      .filter((t) => t.code === 'VAT12' && t.active && t.effectiveFrom <= date)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]?.rateBp ?? 1200
  )
}

/** /invoices/new, /invoices/$id/edit and the same for bills. Loads the draft, then shows the form. */
export function DocumentFormPage({ kind, id }: { kind: DocKind; id?: string }) {
  const workspace = useWorkspace()
  const invoice = useQuery({ ...financeQueries.invoice(workspace.id, id ?? ''), enabled: kind === 'invoice' && !!id })
  const bill = useQuery({ ...financeQueries.bill(workspace.id, id ?? ''), enabled: kind === 'bill' && !!id })
  const accounts = useQuery(financeQueries.accounts(workspace.id))
  const taxCodes = useQuery(financeQueries.taxCodes(workspace.id))
  const doc = kind === 'invoice' ? invoice : bill

  if (doc.error) return <LoadError error={doc.error} />
  if ((id && !doc.data) || !accounts.data || !taxCodes.data) return <Loading />
  if (doc.data && doc.data.status !== 'draft') {
    return (
      <p className="text-muted-foreground py-10 text-center text-sm">
        This {KIND_TEXT[kind].one} is posted, so it can’t be edited. Void it and enter it again if it’s wrong.
      </p>
    )
  }
  return <DocumentForm key={id ?? 'new'} kind={kind} existing={doc.data} accounts={accounts.data} taxCodes={taxCodes.data} />
}

function DocumentForm({ kind, existing, accounts, taxCodes }: { kind: DocKind; existing?: Invoice | Bill; accounts: Account[]; taxCodes: TaxCode[] }) {
  const workspace = useWorkspace()
  const workspaceId = workspace.id
  const navigate = useNavigate()
  const text = KIND_TEXT[kind]
  const role = kind === 'invoice' ? 'customer' : 'supplier'
  const contacts = useQuery(financeQueries.contacts(workspaceId, role))
  const [addingContact, setAddingContact] = useState(false)

  const lineAccounts = accounts.filter((a) => a.active && (kind === 'invoice' ? a.type === 'income' : a.type === 'expense' || (a.type === 'asset' && a.subtype === 'other')))
  const defaultAccount = kind === 'invoice' ? (accounts.find((a) => a.systemKey === 'sales')?.id ?? '') : ''
  const defaultVat: VatTreatment = kind === 'invoice' && workspace.vatStatus === 'non_vat' ? 'none' : 'vatable'
  const vatOptions = VAT_TREATMENTS.filter((t) => kind === 'bill' || (workspace.vatStatus === 'vat' ? t !== 'none' : t === 'none'))
  const ewtCodes = taxCodes.filter((t) => t.kind === 'ewt' && t.active)
  const blankLine = (ewtCodeId = ''): LineValues => ({ description: '', quantity: '1', unitPrice: '', vat: defaultVat, accountId: defaultAccount, ewtCodeId, itemId: '', poLineId: '', soLineId: '' })
  // items on invoices (Phase 3), when Inventory is on and the role can see it
  const can = useCan()
  const usesItems = kind === 'invoice' && workspace.modules.includes('inventory') && can('inventory.view')
  const itemsQ = useQuery({ ...inventoryQueries.items(workspaceId), enabled: usesItems })
  const warehousesQ = useQuery({ ...inventoryQueries.warehouses(workspaceId), enabled: usesItems })
  const grniAccount = accounts.find((a) => a.systemKey === 'grni')
  // Phase 7: tag it to a project for job costing (a project's page links here with ?projectId=)
  const initialProjectId = new URLSearchParams(window.location.search).get('projectId')
  const usesProjects = workspace.modules.includes('projects') && can('projects.view')
  const projectsQ = useQuery({ ...projectQueries.list(workspaceId), enabled: usesProjects })

  const form = useForm<Values>({
    defaultValues: existing
      ? {
          contactId: 'customer' in existing ? existing.customer.id : existing.supplier.id,
          supplierInvoiceNo: 'supplierInvoiceNo' in existing ? (existing.supplierInvoiceNo ?? '') : '',
          date: existing.date,
          dueDate: existing.dueDate ?? '',
          pricesIncludeVat: existing.pricesIncludeVat,
          notes: existing.notes ?? '',
          warehouseId: 'warehouseId' in existing ? (existing.warehouseId ?? '') : '',
          projectId: existing.projectId ?? '',
          lines: existing.lines.map((l) => ({
            itemId: l.itemId ?? '',
            poLineId: l.poLineId ?? '',
            soLineId: l.soLineId ?? '',
            description: l.description,
            quantity: String(l.quantity),
            unitPrice: centavosToInput(l.unitPrice),
            vat: l.vat,
            accountId: l.accountId,
            ewtCodeId: l.ewtCodeId ?? '',
          })),
        }
      : { contactId: '', supplierInvoiceNo: '', date: today(), dueDate: '', pricesIncludeVat: false, notes: '', warehouseId: '', projectId: initialProjectId ?? '', lines: [blankLine()] },
  })
  const lines = useFieldArray({ control: form.control, name: 'lines' })
  const { errors, isSubmitting } = form.formState
  const values = form.watch()

  // live totals, worked out the same way the API will
  const vatRateBp = vatRateOn(taxCodes, values.date || today())
  const computed = values.lines.map((l) => {
    const quantity = Number(l.quantity)
    const unitPrice = parsePeso(l.unitPrice ?? '')
    const ewt = ewtCodes.find((t) => t.id === l.ewtCodeId)
    const amounts =
      Number.isFinite(quantity) && quantity > 0 && unitPrice !== null && unitPrice >= 0
        ? computeLine({ quantity, unitPrice, vat: l.vat, vatRateBp, ewtRateBp: ewt?.rateBp }, values.pricesIncludeVat)
        : { gross: 0, net: 0, vatAmount: 0, ewtAmount: 0 }
    return { ...amounts, vat: l.vat }
  })
  const totals = computeTotals(computed)

  const save = useWorkspaceMutation(async (w, { body, post }: { body: object; post: boolean }) => {
    const path = kind === 'invoice' ? 'invoices' : 'bills'
    const saved = existing
      ? await api<Record<string, Invoice | Bill>>(`/w/${w}/${path}/${existing.id}`, { method: 'PUT', body })
      : await api<Record<string, Invoice | Bill>>(`/w/${w}/${path}`, { method: 'POST', body })
    const doc = saved[kind]!
    if (post) await api(`/w/${w}/${path}/${doc.id}/post`, { method: 'POST' })
    return doc.id
  })

  /** Checks what the browser can, turns pesos into centavos, and sends it. */
  const submit = (post: boolean) =>
    form.handleSubmit(async (v) => {
      let ok = true
      const fail = (name: FieldPath<Values>, message: string) => {
        form.setError(name, { message })
        ok = false
      }
      if (!v.contactId) fail('contactId', `Choose a ${role}.`)
      if (!v.date) fail('date', 'Enter the date.')
      v.lines.forEach((l, i) => {
        if (!l.description.trim()) fail(`lines.${i}.description`, 'Describe this line.')
        if (!(Number(l.quantity) > 0)) fail(`lines.${i}.quantity`, 'More than 0.')
        if (parsePeso(l.unitPrice) === null) fail(`lines.${i}.unitPrice`, 'Enter a price, like 1,250.00.')
        if (!l.accountId) fail(`lines.${i}.accountId`, 'Choose an account.')
      })
      if (!ok) return
      const body = {
        [kind === 'invoice' ? 'customerId' : 'supplierId']: v.contactId,
        ...(kind === 'bill' ? { supplierInvoiceNo: v.supplierInvoiceNo } : {}),
        ...(kind === 'invoice' ? { warehouseId: v.warehouseId || null } : {}),
        projectId: v.projectId || null,
        date: v.date,
        dueDate: v.dueDate || null,
        pricesIncludeVat: v.pricesIncludeVat,
        notes: v.notes,
        lines: v.lines.map((l) => ({
          description: l.description.trim(),
          quantity: Number(l.quantity),
          unitPrice: parsePeso(l.unitPrice),
          vat: l.vat,
          accountId: l.accountId,
          ewtCodeId: kind === 'bill' && l.ewtCodeId ? l.ewtCodeId : null,
          itemId: l.itemId || null,
          poLineId: l.poLineId || null,
          soLineId: l.soLineId || null,
        })),
      }
      try {
        const id = await save.mutateAsync({ body, post })
        if (kind === 'invoice') await navigate({ to: '/w/$workspaceId/finance/invoices/$id', params: { workspaceId, id } })
        else await navigate({ to: '/w/$workspaceId/finance/bills/$id', params: { workspaceId, id } })
      } catch (e) {
        const field = e instanceof ApiError ? e.field : undefined
        if (field && ['customerId', 'supplierId'].includes(field)) form.setError('contactId', { message: (e as Error).message })
        else if (field === 'date' || field === 'dueDate' || field === 'warehouseId') form.setError(field, { message: (e as Error).message })
        else form.setError('root', { message: e instanceof Error ? e.message : 'Something went wrong. Try again.' })
      }
    })

  /** Picking an item fills in what it is, its price and where its sales go. */
  function pickItem(i: number, itemId: string) {
    const it = itemsQ.data?.find((x) => x.id === itemId)
    if (!it) return
    form.setValue(`lines.${i}.description`, it.name)
    form.setValue(`lines.${i}.unitPrice`, centavosToInput(it.salesPrice))
    if (vatOptions.includes(it.salesVat)) form.setValue(`lines.${i}.vat`, it.salesVat)
    form.setValue(`lines.${i}.accountId`, it.salesAccountId ?? defaultAccount)
    if (it.kind === 'stock' && !form.getValues('warehouseId')) form.setValue('warehouseId', warehousesQ.data?.find((w) => w.active)?.id ?? '')
    // the customer's price list, when they have one (Phase 8)
    const customerId = form.getValues('contactId')
    if (customerId) {
      void api<{ price: { price: number } }>(`/w/${workspaceId}/sales/price?itemId=${itemId}&customerId=${customerId}&quantity=${Number(form.getValues(`lines.${i}.quantity`)) || 1}`)
        .then(({ price }) => form.setValue(`lines.${i}.unitPrice`, centavosToInput(price.price)))
        .catch(() => undefined)
    }
  }

  /** Picking a supplier fills their usual withholding code into lines that have none. */
  function onContactChange(id: string) {
    if (id === NEW_CONTACT) {
      setAddingContact(true)
      return
    }
    form.setValue('contactId', id)
    form.clearErrors('contactId')
    const ewt = contacts.data?.find((c) => c.id === id)?.defaultEwtCodeId
    if (kind === 'bill' && ewt) form.getValues('lines').forEach((l, i) => !l.ewtCodeId && form.setValue(`lines.${i}.ewtCodeId`, ewt))
  }

  const lineError = (i: number, key: keyof LineValues) => errors.lines?.[i]?.[key]?.message
  const supplierDefault = kind === 'bill' ? (contacts.data?.find((c) => c.id === values.contactId)?.defaultEwtCodeId ?? '') : ''

  return (
    <div>
      <PageHeader
        title={existing ? `Edit draft ${text.one}` : kind === 'invoice' ? 'New sales invoice' : 'New bill'}
        description={kind === 'invoice' ? 'Saved as a draft until you post it. Posting gives it the next invoice number.' : 'Enter it as the supplier wrote it. Withholding is worked out per line.'}
      />
      <form noValidate className="space-y-6" onSubmit={submit(false)}>
        <FormError message={errors.root?.message} />
        <Card>
          <CardContent className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div className="grid gap-2 md:col-span-2">
              <Label htmlFor="contactId">{text.contact}</Label>
              <NativeSelect id="contactId" value={values.contactId} onChange={(e) => onContactChange(e.target.value)} aria-invalid={!!errors.contactId}>
                <option value="">Choose…</option>
                {contacts.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.tin ? ` · ${c.tin}` : ''}
                  </option>
                ))}
                <option value={NEW_CONTACT}>+ Add a new {role}…</option>
              </NativeSelect>
              {errors.contactId && <p className="text-destructive text-sm">{errors.contactId.message}</p>}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="date">Date</Label>
              <Input id="date" type="date" aria-invalid={!!errors.date} {...form.register('date')} />
              {errors.date && <p className="text-destructive text-sm">{errors.date.message}</p>}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="dueDate">Due date</Label>
              <Input id="dueDate" type="date" {...form.register('dueDate')} />
              {errors.dueDate && <p className="text-destructive text-sm">{errors.dueDate.message}</p>}
            </div>
            {kind === 'bill' && (
              <div className="grid gap-2 md:col-span-2">
                <Label htmlFor="supplierInvoiceNo">Supplier’s invoice number</Label>
                <Input id="supplierInvoiceNo" {...form.register('supplierInvoiceNo')} />
              </div>
            )}
            {usesItems && (
              <div className="grid gap-2 md:col-span-2">
                <Label htmlFor="warehouseId">Goods leave from</Label>
                <NativeSelect id="warehouseId" aria-invalid={!!errors.warehouseId} {...form.register('warehouseId')}>
                  <option value="">No stock items on this invoice</option>
                  {warehousesQ.data
                    ?.filter((w) => w.active)
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                </NativeSelect>
                {errors.warehouseId && <p className="text-destructive text-sm">{errors.warehouseId.message}</p>}
              </div>
            )}
            {usesProjects && !!projectsQ.data?.length && (
              <div className="grid gap-2 md:col-span-2">
                <Label htmlFor="projectId">Project</Label>
                <NativeSelect id="projectId" {...form.register('projectId')}>
                  <option value="">None</option>
                  {projectsQ.data
                    .filter((p) => p.status !== 'cancelled' || p.id === values.projectId)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.number} · {p.name}
                      </option>
                    ))}
                </NativeSelect>
                <p className="text-muted-foreground text-sm">{kind === 'bill' ? 'Counts as a cost of the project.' : 'Counts as the project’s revenue.'}</p>
              </div>
            )}
            <div className="flex items-center gap-2 md:col-span-2 lg:col-span-4">
              <Controller
                control={form.control}
                name="pricesIncludeVat"
                render={({ field }) => <Checkbox id="pricesIncludeVat" checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} />}
              />
              <Label htmlFor="pricesIncludeVat" className="font-normal">
                Prices already include VAT
              </Label>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-3">
          {lines.fields.map((field, i) => (
            <Card key={field.id} className="gap-0 py-4">
              <CardContent className="grid gap-3 px-4 md:grid-cols-12">
                {usesItems && itemsQ.data && (
                  <div className="grid gap-1.5 md:col-span-12">
                    <Label htmlFor={`l${i}-item`} className="text-muted-foreground text-xs">
                      Item
                    </Label>
                    <NativeSelect id={`l${i}-item`} {...form.register(`lines.${i}.itemId`, { onChange: (e) => pickItem(i, e.target.value) })}>
                      <option value="">No item (type a description)</option>
                      {itemsQ.data
                        ?.filter((it) => it.active)
                        .map((it) => (
                          <option key={it.id} value={it.id}>
                            {it.sku} · {it.name}
                            {it.kind === 'stock' ? ` (${it.onHand} ${it.unit.code} on hand)` : ''}
                          </option>
                        ))}
                    </NativeSelect>
                  </div>
                )}
                {values.lines[i]?.soLineId && (
                  <p className="text-muted-foreground text-xs md:col-span-12">From the sales order. The goods left on its delivery, so posting books only the sale.</p>
                )}
                {values.lines[i]?.poLineId && (
                  <p className="text-muted-foreground text-xs md:col-span-12">From the purchase order. Goods already received clear “Goods Received Not Invoiced”.</p>
                )}
                <div className="grid gap-1.5 md:col-span-5">
                  <Label htmlFor={`l${i}-description`} className="text-muted-foreground text-xs">
                    Description
                  </Label>
                  <Input id={`l${i}-description`} aria-invalid={!!lineError(i, 'description')} {...form.register(`lines.${i}.description`)} />
                  {lineError(i, 'description') && <p className="text-destructive text-xs">{lineError(i, 'description')}</p>}
                </div>
                <div className="grid grid-cols-2 gap-3 md:col-span-4">
                  <div className="grid gap-1.5">
                    <Label htmlFor={`l${i}-quantity`} className="text-muted-foreground text-xs">
                      Quantity
                    </Label>
                    <Input id={`l${i}-quantity`} inputMode="decimal" className="text-right" aria-invalid={!!lineError(i, 'quantity')} {...form.register(`lines.${i}.quantity`)} />
                    {lineError(i, 'quantity') && <p className="text-destructive text-xs">{lineError(i, 'quantity')}</p>}
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor={`l${i}-unitPrice`} className="text-muted-foreground text-xs">
                      Unit price (₱)
                    </Label>
                    <Input id={`l${i}-unitPrice`} inputMode="decimal" className="text-right" placeholder="0.00" aria-invalid={!!lineError(i, 'unitPrice')} {...form.register(`lines.${i}.unitPrice`)} />
                    {lineError(i, 'unitPrice') && <p className="text-destructive text-xs">{lineError(i, 'unitPrice')}</p>}
                  </div>
                </div>
                <div className="flex items-end justify-between gap-2 md:col-span-3 md:flex-col md:items-end">
                  <span className="text-muted-foreground text-xs md:hidden">Amount</span>
                  <span className="text-lg font-medium tabular-nums md:pt-6">{formatPeso(computed[i]?.gross ?? 0)}</span>
                </div>
                <div className="grid gap-1.5 md:col-span-3">
                  <Label htmlFor={`l${i}-vat`} className="text-muted-foreground text-xs">
                    VAT
                  </Label>
                  <NativeSelect id={`l${i}-vat`} {...form.register(`lines.${i}.vat`)}>
                    {vatOptions.map((t) => (
                      <option key={t} value={t}>
                        {VAT_TREATMENT_LABELS[t]}
                        {t === 'vatable' ? ` (${formatRate(vatRateBp)})` : ''}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className={cn('grid gap-1.5', kind === 'bill' ? 'md:col-span-4' : 'md:col-span-8')}>
                  <Label htmlFor={`l${i}-account`} className="text-muted-foreground text-xs">
                    Account
                  </Label>
{values.lines[i]?.poLineId && grniAccount && values.lines[i]?.accountId === grniAccount.id ? (
                    // set by the purchase order: the goods were put on the books when they arrived
                    <p id={`l${i}-account`} className="bg-muted text-muted-foreground flex h-9 items-center rounded-md px-3 text-sm">
                      Goods received (from PO)
                    </p>
                  ) : (
                                      <NativeSelect id={`l${i}-account`} aria-invalid={!!lineError(i, 'accountId')} {...form.register(`lines.${i}.accountId`)}>
                    <option value="">Choose…</option>
                    {lineAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </NativeSelect>
                  )}
                  {lineError(i, 'accountId') && <p className="text-destructive text-xs">{lineError(i, 'accountId')}</p>}
                </div>
                {kind === 'bill' && (
                  <div className="grid gap-1.5 md:col-span-4">
                    <Label htmlFor={`l${i}-ewt`} className="text-muted-foreground text-xs">
                      Tax withheld
                    </Label>
                    <NativeSelect id={`l${i}-ewt`} {...form.register(`lines.${i}.ewtCodeId`)}>
                      <option value="">None</option>
                      {ewtCodes.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.atc} · {formatRate(t.rateBp)} · {t.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                )}
                <div className="flex items-end justify-end md:col-span-1">
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} disabled={lines.fields.length === 1} onClick={() => lines.remove(i)}>
                    <Trash2 />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
          <Button type="button" variant="outline" onClick={() => lines.append(blankLine(supplierDefault))}>
            <Plus />
            Add a line
          </Button>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <div className="grid content-start gap-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" rows={3} placeholder={kind === 'invoice' ? 'Printed on the invoice, e.g. payment instructions.' : 'For your own reference.'} {...form.register('notes')} />
          </div>
          <Card className="gap-0 py-4">
            <CardContent className="grid gap-2 px-4 text-sm">
              {totals.vatableAmount > 0 && <TotalRow label="VATable amount" value={totals.vatableAmount} />}
              {totals.zeroRatedAmount > 0 && <TotalRow label="Zero-rated" value={totals.zeroRatedAmount} />}
              {totals.exemptAmount > 0 && <TotalRow label="VAT-exempt" value={totals.exemptAmount} />}
              {totals.nonVatAmount > 0 && <TotalRow label="Non-VAT" value={totals.nonVatAmount} />}
              {totals.vatAmount > 0 && <TotalRow label={`VAT (${formatRate(vatRateBp)})`} value={totals.vatAmount} />}
              <TotalRow label="Total" value={totals.total} strong />
              {kind === 'bill' && totals.ewtAmount > 0 && (
                <>
                  <TotalRow label="Less tax withheld" value={-totals.ewtAmount} />
                  <TotalRow label="Amount to pay the supplier" value={totals.amountDue} strong />
                </>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          {existing ? (
            <Button type="button" variant="ghost" asChild>
              {kind === 'invoice' ? (
                <Link to="/w/$workspaceId/finance/invoices/$id" params={{ workspaceId, id: existing.id }}>
                  Cancel
                </Link>
              ) : (
                <Link to="/w/$workspaceId/finance/bills/$id" params={{ workspaceId, id: existing.id }}>
                  Cancel
                </Link>
              )}
            </Button>
          ) : null}
          <Button type="submit" variant="outline" disabled={isSubmitting}>
            Save draft
          </Button>
          <Button type="button" disabled={isSubmitting} onClick={submit(true)}>
            {isSubmitting ? 'Saving…' : kind === 'invoice' ? 'Save and post' : 'Save and post'}
          </Button>
        </div>
      </form>
      <ContactDialog open={addingContact} onOpenChange={setAddingContact} role={role} onSaved={(c) => onContactChange(c.id)} />
    </div>
  )
}

function TotalRow({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className={cn('flex justify-between gap-4', strong && 'border-t pt-2 text-base font-semibold')}>
      <span className={strong ? '' : 'text-muted-foreground'}>{label}</span>
      <span className="tabular-nums">{formatPeso(value)}</span>
    </div>
  )
}
