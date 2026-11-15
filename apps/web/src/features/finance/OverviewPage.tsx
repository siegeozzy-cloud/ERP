import { formatPeso } from '@erp/shared'
import { useQuery } from '@tanstack/react-query'
import { Link, Outlet } from '@tanstack/react-router'
import { BookOpen, FilePlus2, FileText, ReceiptText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useCan, useWorkspace } from '@/features/workspaces/queries'
import { formatDate, today } from '@/lib/dates'
import { DocumentStatusBadge, EmptyState, FinanceTabs, LoadError, Loading, Money } from './components'
import { financeQueries } from './queries'

/** The frame for every Finance page: its tabs, then the page. */
export function FinanceLayout() {
  const can = useCan()
  const { role } = useWorkspace()
  if (!can('finance.view')) {
    return (
      <EmptyState title="Your role can’t see Finance">
        You’re here as {role.name}. An owner or admin can change that.
      </EmptyState>
    )
  }
  return (
    <>
      <FinanceTabs />
      <Outlet />
    </>
  )
}

function Stat({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-xl tabular-nums">{formatPeso(value)}</CardTitle>
        {note && <p className="text-muted-foreground text-xs">{note}</p>}
      </CardHeader>
    </Card>
  )
}

export function OverviewPage() {
  const workspace = useWorkspace()
  const workspaceId = workspace.id
  const overview = useQuery(financeQueries.overview(workspaceId))
  const invoices = useQuery(financeQueries.invoices(workspaceId))
  const now = today()
  const can = useCan()

  if (overview.error) return <LoadError error={overview.error} />
  if (!overview.data) return <Loading />
  const o = overview.data

  return (
    <div className="space-y-8">
      {can('finance.edit') && <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link to="/w/$workspaceId/finance/invoices/new" params={{ workspaceId }}>
            <FilePlus2 />
            New invoice
          </Link>
        </Button>
        <Button variant="outline" asChild>
          <Link to="/w/$workspaceId/finance/bills/new" params={{ workspaceId }}>
            <ReceiptText />
            Enter a bill
          </Link>
        </Button>
        <Button variant="outline" asChild>
          <Link to="/w/$workspaceId/finance/journal/new" params={{ workspaceId }}>
            <BookOpen />
            Journal entry
          </Link>
        </Button>
      </div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Cash and bank" value={o.cash} />
        <Stat label="Customers owe you" value={o.receivables} note={o.overdueInvoices ? `${o.overdueInvoices} overdue invoice${o.overdueInvoices === 1 ? '' : 's'}` : undefined} />
        <Stat label="You owe suppliers" value={o.payables} note={o.overdueBills ? `${o.overdueBills} overdue bill${o.overdueBills === 1 ? '' : 's'}` : undefined} />
        <Stat label="Income this month" value={o.monthToDate.income} />
        <Stat label="Expenses this month" value={o.monthToDate.expenses} />
        <Stat label="Profit this month" value={o.monthToDate.income - o.monthToDate.expenses} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="size-4" />
            Recent invoices
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {!invoices.data?.length ? (
            <p className="text-muted-foreground px-6 text-sm">No invoices yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Number</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead className="pr-6">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.data.slice(0, 6).map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="pl-6 font-medium">
                      <Link to="/w/$workspaceId/finance/invoices/$id" params={{ workspaceId, id: inv.id }} className="hover:underline">
                        {inv.number ?? 'Draft'}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-48 truncate">{inv.customer.name}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDate(inv.date)}</TableCell>
                    <TableCell className="text-right">
                      <Money value={inv.balance} />
                    </TableCell>
                    <TableCell className="pr-6">
                      <DocumentStatusBadge status={inv.status} balance={inv.balance} dueDate={inv.dueDate} today={now} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
