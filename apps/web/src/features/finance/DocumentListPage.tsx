import type { DocumentStatus } from '@erp/shared'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useCan, useWorkspaceId } from '@/features/workspaces/queries'
import { formatDate, today } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { DocumentStatusBadge, EmptyState, LoadError, Loading, Money, PageHeader } from './components'
import { financeQueries } from './queries'

export type DocKind = 'invoice' | 'bill'

export const KIND_TEXT = {
  invoice: { plural: 'Sales invoices', one: 'invoice', contact: 'Customer', newLabel: 'New invoice', description: 'What customers owe you. Posting gives an invoice its number and records the sale.' },
  bill: { plural: 'Bills', one: 'bill', contact: 'Supplier', newLabel: 'Enter a bill', description: 'What you owe suppliers, with the tax you withhold from them.' },
} as const

const FILTERS: { value: DocumentStatus | undefined; label: string }[] = [
  { value: undefined, label: 'All' },
  { value: 'draft', label: 'Drafts' },
  { value: 'posted', label: 'Posted' },
  { value: 'void', label: 'Void' },
]

export function DocumentListPage({ kind }: { kind: DocKind }) {
  const workspaceId = useWorkspaceId()
  const navigate = useNavigate()
  const [status, setStatus] = useState<DocumentStatus | undefined>()
  const invoices = useQuery({ ...financeQueries.invoices(workspaceId, status), enabled: kind === 'invoice' })
  const bills = useQuery({ ...financeQueries.bills(workspaceId, status), enabled: kind === 'bill' })
  const query = kind === 'invoice' ? invoices : bills
  const rows = kind === 'invoice' ? invoices.data?.map((d) => ({ ...d, contact: d.customer, ref: null })) : bills.data?.map((d) => ({ ...d, contact: d.supplier, ref: d.supplierInvoiceNo }))
  const text = KIND_TEXT[kind]
  const now = today()
  const can = useCan()

  const open = (id: string) =>
    kind === 'invoice'
      ? navigate({ to: '/w/$workspaceId/finance/invoices/$id', params: { workspaceId, id } })
      : navigate({ to: '/w/$workspaceId/finance/bills/$id', params: { workspaceId, id } })

  const newButton = (
    <Button asChild>
      {kind === 'invoice' ? (
        <Link to="/w/$workspaceId/finance/invoices/new" params={{ workspaceId }}>
          <Plus />
          {text.newLabel}
        </Link>
      ) : (
        <Link to="/w/$workspaceId/finance/bills/new" params={{ workspaceId }}>
          <Plus />
          {text.newLabel}
        </Link>
      )}
    </Button>
  )

  return (
    <div>
      <PageHeader title={text.plural} description={text.description} actions={can('finance.edit') ? newButton : undefined} />
      <div className="mb-4 flex gap-1" role="tablist" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            role="tab"
            aria-selected={status === f.value}
            onClick={() => setStatus(f.value)}
            className={cn('rounded-md px-3 py-1.5 text-sm font-medium transition-colors', status === f.value ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:text-foreground')}
          >
            {f.label}
          </button>
        ))}
      </div>
      {query.error ? (
        <LoadError error={query.error} />
      ) : !rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title={status ? `No ${f(status)} ${text.one}s` : `No ${text.one}s yet`} action={status || !can('finance.edit') ? undefined : newButton} />
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>{text.contact}</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="hidden sm:table-cell">Due</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((d) => (
                <TableRow key={d.id} className="cursor-pointer" onClick={() => void open(d.id)}>
                  <TableCell className="font-medium whitespace-nowrap">
                    <button type="button" className="hover:underline" onClick={() => void open(d.id)}>
                      {d.number ?? 'Draft'}
                    </button>
                    {d.ref && <span className="text-muted-foreground block text-xs font-normal">Their no. {d.ref}</span>}
                  </TableCell>
                  <TableCell className="max-w-56 truncate">{d.contact.name}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(d.date)}</TableCell>
                  <TableCell className="hidden whitespace-nowrap sm:table-cell">{formatDate(d.dueDate)}</TableCell>
                  <TableCell className="text-right">
                    <Money value={d.total} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={d.balance} />
                  </TableCell>
                  <TableCell>
                    <DocumentStatusBadge status={d.status} balance={d.balance} dueDate={d.dueDate} today={now} />
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

const f = (s: DocumentStatus) => (s === 'posted' ? 'posted' : s)
