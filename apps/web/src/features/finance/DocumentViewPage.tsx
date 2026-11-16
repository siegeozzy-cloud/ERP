import { HazardNote, LicenceLines } from '@/features/inventory/niche'
import { centavosToInput, formatPeso, formatRate, parsePeso, type Bill, type Invoice, type Payment } from '@erp/shared'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Ban, BookOpen, CircleDollarSign, Pencil, Printer, Send, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useCan, useWorkspace } from '@/features/workspaces/queries'
import { api } from '@/lib/api'
import { formatDate, today } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { DocumentStatusBadge, LoadError, Loading, Money } from './components'
import { KIND_TEXT, type DocKind } from './DocumentListPage'
import { financeQueries, useWorkspaceMutation } from './queries'

type Doc = Invoice | Bill

const pathOf = (kind: DocKind) => (kind === 'invoice' ? 'invoices' : 'bills')

export function DocumentViewPage({ kind, id }: { kind: DocKind; id: string }) {
  const workspace = useWorkspace()
  const invoice = useQuery({ ...financeQueries.invoice(workspace.id, id), enabled: kind === 'invoice' })
  const bill = useQuery({ ...financeQueries.bill(workspace.id, id), enabled: kind === 'bill' })
  const query = kind === 'invoice' ? invoice : bill
  if (query.error) return <LoadError error={query.error} />
  if (!query.data) return <Loading />
  return <DocumentView kind={kind} doc={query.data} />
}

function DocumentView({ kind, doc }: { kind: DocKind; doc: Doc }) {
  const workspace = useWorkspace()
  const workspaceId = workspace.id
  const navigate = useNavigate()
  const text = KIND_TEXT[kind]
  const can = useCan()
  const [paying, setPaying] = useState(false)
  const [voiding, setVoiding] = useState<{ what: 'document' } | { what: 'payment'; payment: Payment } | null>(null)
  const action = useWorkspaceMutation((w, a: 'post' | 'delete') => api(`/w/${w}/${pathOf(kind)}/${doc.id}${a === 'post' ? '/post' : ''}`, { method: a === 'post' ? 'POST' : 'DELETE' }))

  const contact = 'customer' in doc ? doc.customer : doc.supplier
  const seller = kind === 'invoice' ? { name: workspace.name, tin: workspace.tin, address: workspace.registeredAddress } : { name: contact.name, tin: contact.tin, address: contact.address }
  const buyer = kind === 'invoice' ? { name: contact.name, tin: contact.tin, address: contact.address } : { name: workspace.name, tin: workspace.tin, address: workspace.registeredAddress }
  const nonVatSeller = kind === 'invoice' && workspace.vatStatus === 'non_vat'

  async function run(a: 'post' | 'delete') {
    await action.mutateAsync(a)
    if (a === 'delete') {
      if (kind === 'invoice') await navigate({ to: '/w/$workspaceId/finance/invoices', params: { workspaceId } })
      else await navigate({ to: '/w/$workspaceId/finance/bills', params: { workspaceId } })
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-semibold tracking-tight">{doc.number ?? `Draft ${text.one}`}</h2>
          <DocumentStatusBadge status={doc.status} balance={doc.balance} dueDate={doc.dueDate} today={today()} />
        </div>
        <div className="flex flex-wrap gap-2">
          {doc.status === 'draft' && can('finance.edit') && (
            <>
              <Button variant="ghost" onClick={() => void run('delete')} disabled={action.isPending}>
                <Trash2 />
                Delete
              </Button>
              <Button variant="outline" asChild>
                {kind === 'invoice' ? (
                  <Link to="/w/$workspaceId/finance/invoices/$id/edit" params={{ workspaceId, id: doc.id }}>
                    <Pencil />
                    Edit
                  </Link>
                ) : (
                  <Link to="/w/$workspaceId/finance/bills/$id/edit" params={{ workspaceId, id: doc.id }}>
                    <Pencil />
                    Edit
                  </Link>
                )}
              </Button>
            </>
          )}
          {doc.status === 'draft' && can('finance.post') && (
            <Button onClick={() => void run('post')} disabled={action.isPending}>
              <Send />
              {action.isPending ? 'Posting…' : 'Post'}
            </Button>
          )}
          {doc.status === 'posted' && (
            <>
              {can('finance.post') && (
                <Button variant="ghost" onClick={() => setVoiding({ what: 'document' })}>
                  <Ban />
                  Void
                </Button>
              )}
              <Button variant="outline" onClick={() => window.print()}>
                <Printer />
                Print
              </Button>
              {doc.balance > 0 && can('finance.post') && (
                <Button onClick={() => setPaying(true)}>
                  <CircleDollarSign />
                  {kind === 'invoice' ? 'Record payment' : 'Pay'}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      {action.error && (
        <Alert variant="destructive" className="print:hidden">
          <AlertDescription>{action.error.message}</AlertDescription>
        </Alert>
      )}

      {/* the document itself: what prints */}
      <article className={cn('bg-card relative rounded-xl border p-6 shadow-sm md:p-10 print:rounded-none print:border-0 print:p-0 print:shadow-none', doc.status === 'void' && 'opacity-70')}>
        {doc.status !== 'posted' && (
          // a faint watermark across the middle, so it can't hide any of the document's details
          <span aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center overflow-hidden">
            <span className="text-foreground/[0.07] -rotate-12 rounded-xl border-8 border-current px-6 py-2 text-7xl font-black tracking-widest uppercase md:text-8xl">{doc.status}</span>
          </span>
        )}
        <header className="flex flex-wrap justify-between gap-6 border-b pb-6">
          <div className="space-y-1">
            <p className="text-lg font-semibold">{seller.name}</p>
            <p className="text-muted-foreground text-sm">
              {kind === 'invoice' ? (nonVatSeller ? 'Non-VAT Reg.' : 'VAT Reg.') : ''} TIN {seller.tin ?? 'not on file'}
            </p>
            {seller.address && <p className="text-muted-foreground max-w-xs text-sm whitespace-pre-line">{seller.address}</p>}
            {kind === 'invoice' && <LicenceLines />}
          </div>
          <div className="space-y-1 text-right">
            <p className="text-sm font-semibold tracking-widest uppercase">{kind === 'invoice' ? 'Sales Invoice' : 'Bill'}</p>
            <p className="text-xl font-semibold tabular-nums">{doc.number ?? '—'}</p>
            {'supplierInvoiceNo' in doc && doc.supplierInvoiceNo && <p className="text-muted-foreground text-sm">Supplier’s no. {doc.supplierInvoiceNo}</p>}
            <p className="text-muted-foreground text-sm">Date: {formatDate(doc.date)}</p>
            {doc.dueDate && <p className="text-muted-foreground text-sm">Due: {formatDate(doc.dueDate)}</p>}
          </div>
        </header>

        <section className="border-b py-6">
          <p className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">{kind === 'invoice' ? 'Sold to' : 'Billed to'}</p>
          <p className="font-medium">{buyer.name}</p>
          <p className="text-muted-foreground text-sm">TIN {buyer.tin ?? 'not on file'}</p>
          {buyer.address && <p className="text-muted-foreground text-sm whitespace-pre-line">{buyer.address}</p>}
        </section>

        <Table className="my-4">
          <TableHeader>
            <TableRow>
              <TableHead className="pl-0">Description</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Unit price</TableHead>
              {kind === 'bill' && <TableHead>Withheld</TableHead>}
              <TableHead className="pr-0 text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {doc.lines.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="min-w-48 pl-0">
                  {l.description}
                  {kind === 'invoice' && <HazardNote itemId={l.itemId} />}
                  {l.vat !== 'vatable' && <span className="text-muted-foreground ml-2 text-xs">({l.vat === 'zero_rated' ? 'zero-rated' : l.vat === 'exempt' ? 'VAT-exempt' : 'non-VAT'})</span>}
                </TableCell>
                <TableCell className="text-right tabular-nums">{l.quantity}</TableCell>
                <TableCell className="text-right">
                  <Money value={l.unitPrice} />
                </TableCell>
                {kind === 'bill' && <TableCell className="whitespace-nowrap">{l.atc ? `${l.atc} · ${formatRate(l.ewtRateBp ?? 0)}` : '—'}</TableCell>}
                <TableCell className="pr-0 text-right">
                  <Money value={l.gross} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <div className="flex flex-wrap justify-between gap-6">
          <div className="max-w-sm text-sm">{doc.notes && <p className="text-muted-foreground whitespace-pre-line">{doc.notes}</p>}</div>
          <dl className="grid min-w-64 gap-1.5 text-sm">
            {workspace.vatStatus === 'vat' || kind === 'bill' ? (
              <>
                <Row label="VATable sales" value={doc.vatableAmount} />
                <Row label="VAT-exempt sales" value={doc.exemptAmount} />
                <Row label="Zero-rated sales" value={doc.zeroRatedAmount} />
                {doc.nonVatAmount > 0 && <Row label="Non-VAT" value={doc.nonVatAmount} />}
                <Row label="VAT amount" value={doc.vatAmount} />
              </>
            ) : null}
            <Row label="Total amount due" value={doc.total} strong />
            {kind === 'bill' && doc.ewtAmount > 0 && (
              <>
                <Row label="Less tax withheld" value={-doc.ewtAmount} />
                <Row label="Payable to supplier" value={doc.amountDue} strong />
              </>
            )}
          </dl>
        </div>

        <footer className="text-muted-foreground mt-10 space-y-1 border-t pt-4 text-center text-xs">
          {nonVatSeller && <p className="font-semibold uppercase">This document is not valid for claim of input tax.</p>}
          <p>Demo – not registered with the BIR (no CAS permit). Not a valid {kind === 'invoice' ? 'invoice' : 'document'} for tax purposes.</p>
        </footer>
      </article>

      {doc.payments.length > 0 && (
        <section className="space-y-3 print:hidden">
          <h3 className="font-semibold">Payments</h3>
          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="hidden sm:table-cell">Account</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  {kind === 'invoice' && <TableHead className="text-right">Withheld</TableHead>}
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {doc.payments.map((p) => (
                  <TableRow key={p.id} className={p.status === 'void' ? 'opacity-60' : ''}>
                    <TableCell className="font-medium whitespace-nowrap">
                      {p.number}
                      {p.reference && <span className="text-muted-foreground block text-xs font-normal">{p.reference}</span>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{formatDate(p.date)}</TableCell>
                    <TableCell className="hidden sm:table-cell">{p.account.name}</TableCell>
                    <TableCell className="text-right">
                      <Money value={p.amount} />
                    </TableCell>
                    {kind === 'invoice' && (
                      <TableCell className="text-right">
                        <Money value={p.withheld} />
                      </TableCell>
                    )}
                    <TableCell className="text-right">
                      {p.status === 'void' ? (
                        <span className="text-muted-foreground text-xs">Void</span>
                      ) : !can('finance.post') ? null : (
                        <Button variant="ghost" size="sm" onClick={() => setVoiding({ what: 'payment', payment: p })}>
                          Void
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {doc.journalEntryId && (
        <p className="print:hidden">
          <Button variant="link" className="px-0" asChild>
            <Link to="/w/$workspaceId/finance/journal/$id" params={{ workspaceId, id: doc.journalEntryId }}>
              <BookOpen />
              See the journal entry
            </Link>
          </Button>
        </p>
      )}

      <PaymentDialog kind={kind} doc={doc} open={paying} onOpenChange={setPaying} />
      <VoidDialog kind={kind} doc={doc} target={voiding} onClose={() => setVoiding(null)} />
    </div>
  )
}

function Row({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className={cn('flex justify-between gap-6', strong && 'border-t pt-1.5 text-base font-semibold')}>
      <dt className={strong ? '' : 'text-muted-foreground'}>{label}</dt>
      <dd className="tabular-nums">{formatPeso(value)}</dd>
    </div>
  )
}

/**
 * Money in against an invoice (with any tax the customer withheld), or out against a bill.
 * The form lives inside the dialog's content, which mounts on every opening, so it always starts
 * from fresh defaults however the dialog was opened.
 */
function PaymentDialog({ kind, doc, open, onOpenChange }: { kind: DocKind; doc: Doc; open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <PaymentForm kind={kind} doc={doc} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function PaymentForm({ kind, doc, onDone }: { kind: DocKind; doc: Doc; onDone: () => void }) {
  const workspace = useWorkspace()
  const { data: accounts = [] } = useQuery(financeQueries.accounts(workspace.id))
  const cashAccounts = accounts.filter((a) => a.active && (a.subtype === 'cash' || a.subtype === 'bank'))
  const [date, setDate] = useState(today())
  const [chosenAccount, setAccountId] = useState('')
  const [amount, setAmount] = useState(centavosToInput(doc.balance))
  const [withheld, setWithheld] = useState('')
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string | null>(null)
  const pay = useWorkspaceMutation((w, body: object) => api(`/w/${w}/${pathOf(kind)}/${doc.id}/payments`, { method: 'POST', body }))
  // the bank account unless they pick another; the accounts may still be loading on the first render
  const accountId = chosenAccount || cashAccounts.find((a) => a.subtype === 'bank')?.id || cashAccounts[0]?.id || ''

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const a = parsePeso(amount)
    const w = withheld ? parsePeso(withheld) : 0
    if (a === null || a <= 0) return setError('Enter the amount, like 12,500.00.')
    if (w === null) return setError('Enter the tax withheld, like 250.00, or leave it blank.')
    try {
      await pay.mutateAsync({ date, accountId, amount: a, withheld: w, reference })
      onDone()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <>
        <DialogHeader>
          <DialogTitle>{kind === 'invoice' ? `Payment for ${doc.number}` : `Pay ${doc.number}`}</DialogTitle>
          <DialogDescription>{formatPeso(doc.balance)} is still owed.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4" noValidate>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="p-date">Date</Label>
              <Input id="p-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="p-account">{kind === 'invoice' ? 'Received into' : 'Paid from'}</Label>
              <NativeSelect id="p-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {cashAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="p-amount">{kind === 'invoice' ? 'Amount received (₱)' : 'Amount paid (₱)'}</Label>
              <Input id="p-amount" inputMode="decimal" className="text-right" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            {kind === 'invoice' && (
              <div className="grid gap-2">
                <Label htmlFor="p-withheld">Tax they withheld (₱)</Label>
                <Input id="p-withheld" inputMode="decimal" className="text-right" placeholder="0.00" value={withheld} onChange={(e) => setWithheld(e.target.value)} />
              </div>
            )}
          </div>
          {kind === 'invoice' && <p className="text-muted-foreground -mt-2 text-xs">If the customer withheld tax, ask them for a Form 2307. It counts as tax you’ve already paid.</p>}
          <div className="grid gap-2">
            <Label htmlFor="p-ref">Reference</Label>
            <Input id="p-ref" placeholder="Check number, transfer reference…" value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onDone}>
              Cancel
            </Button>
            <Button type="submit" disabled={pay.isPending}>
              {pay.isPending ? 'Recording…' : 'Record payment'}
            </Button>
          </DialogFooter>
        </form>
    </>
  )
}

/** Voiding a document or one of its payments. The number stays used and a reversing entry is made. */
type VoidTarget = { what: 'document' } | { what: 'payment'; payment: Payment }

function VoidDialog({ kind, doc, target, onClose }: { kind: DocKind; doc: Doc; target: VoidTarget | null; onClose: () => void }) {
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>{target && <VoidForm kind={kind} doc={doc} target={target} onClose={onClose} />}</DialogContent>
    </Dialog>
  )
}

function VoidForm({ kind, doc, target, onClose }: { kind: DocKind; doc: Doc; target: VoidTarget; onClose: () => void }) {
  const [date, setDate] = useState(today())
  const run = useWorkspaceMutation((w, body: { date: string }) =>
    target.what === 'payment' ? api(`/w/${w}/payments/${target.payment.id}/void`, { method: 'POST', body }) : api(`/w/${w}/${pathOf(kind)}/${doc.id}/void`, { method: 'POST', body }),
  )
  const label = target.what === 'payment' ? `payment ${target.payment.number}` : `${KIND_TEXT[kind].one} ${doc.number}`

  return (
    <>
        <DialogHeader>
          <DialogTitle>Void {label}?</DialogTitle>
          <DialogDescription>
            It stays on record, marked void, and a reversing journal entry takes it out of the books. {target.what === 'document' && 'Its number won’t be used again.'}
          </DialogDescription>
        </DialogHeader>
        {run.error && (
          <Alert variant="destructive">
            <AlertDescription>{run.error.message}</AlertDescription>
          </Alert>
        )}
        <div className="grid gap-2">
          <Label htmlFor="v-date">Date of the reversal</Label>
          <Input id="v-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Keep it
          </Button>
          <Button variant="destructive" disabled={run.isPending} onClick={() => run.mutateAsync({ date }).then(onClose, () => undefined)}>
            {run.isPending ? 'Voiding…' : 'Void'}
          </Button>
        </DialogFooter>
    </>
  )
}
