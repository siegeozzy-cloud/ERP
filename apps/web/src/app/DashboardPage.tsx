import { AGING_LABELS, formatPeso, type Dashboard } from '@erp/shared'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight, CheckCircle2 } from 'lucide-react'
import { AmountBars, Legend, MonthBars, TrendLine } from '@/components/charts'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useUser } from '@/features/auth/session'
import { financeQueries } from '@/features/finance/queries'
import { LicenceWarnings } from '@/features/inventory/niche'
import { useCan, useWorkspace } from '@/features/workspaces/queries'
import { api } from '@/lib/api'
import { MODULES } from './modules'

function greeting(hour: number) {
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthLabel = (ym: string) => MONTHS[Number(ym.slice(5, 7)) - 1]!

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

/** Links into each module the workspace has on. */
const MODULE_PATHS: Record<string, string> = { finance: 'finance', inventory: 'inventory', crm: 'crm', hr: 'hr', manufacturing: 'manufacturing', projects: 'projects' }

export function DashboardPage() {
  const user = useUser()
  const workspace = useWorkspace()
  const can = useCan()
  const { data: overview } = useQuery({ ...financeQueries.overview(workspace.id), enabled: can('finance.view') })
  const { data: dash } = useQuery({ queryKey: ['w', workspace.id, 'dashboard'], queryFn: async () => (await api<{ dashboard: Dashboard }>(`/w/${workspace.id}/dashboard`)).dashboard })
  const modules = MODULES.filter((m) => (workspace.modules as string[]).includes(m.slug) && (m.slug !== 'hr' || can('hr.view')))
  const money = dash?.money
  const profit = money ? money.months.reduce((s, m) => s + m.income - m.expenses, 0) : 0
  return (
    <div className="space-y-8">
      <LicenceWarnings />
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">
          {greeting(new Date().getHours())}, {user.name.split(' ')[0]}
        </h2>
        <p className="text-muted-foreground">
          {workspace.name} · you’re {/^[aeiou]/i.test(workspace.role.name) ? 'an' : 'a'} {workspace.role.name}
        </p>
      </div>

      {overview && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Cash and bank" value={formatPeso(overview.cash)} />
          <Stat label="Customers owe you" value={formatPeso(overview.receivables)} note={overview.overdueInvoices ? `${overview.overdueInvoices} invoice${overview.overdueInvoices === 1 ? '' : 's'} overdue` : undefined} />
          <Stat label="You owe suppliers" value={formatPeso(overview.payables)} />
          <Stat label="Profit this month" value={formatPeso(overview.monthToDate.income - overview.monthToDate.expenses)} note={money ? `${formatPeso(profit)} over the last ${money.months.length} months` : undefined} />
        </div>
      )}

      {dash && dash.todo.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Needs attention</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {dash.todo.map((t) => (
              <Link key={t.key} to={`/w/${workspace.id}/${t.to}` as never} className="hover:bg-muted flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-sm transition-colors">
                <span>{t.label}</span>
                <span className="flex items-center gap-1 font-semibold tabular-nums">
                  {t.count}
                  <ArrowRight className="text-muted-foreground size-3.5" />
                </span>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}
      {dash && dash.todo.length === 0 && (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <CheckCircle2 className="text-success size-4" />
          Nothing waiting on you.
        </p>
      )}

      {money && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Income and expenses</CardTitle>
              <CardDescription>By month, from posted entries.</CardDescription>
              <Legend
                items={[
                  { label: 'Income', color: 'var(--series-1)' },
                  { label: 'Expenses', color: 'var(--series-2)' },
                ]}
              />
            </CardHeader>
            <CardContent>
              <MonthBars label="Income and expenses by month" series={['Income', 'Expenses']} data={money.months.map((m) => ({ label: monthLabel(m.month), values: [m.income, m.expenses] }))} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Cash and bank</CardTitle>
              <CardDescription>At the end of each month (this month: today).</CardDescription>
            </CardHeader>
            <CardContent>
              <TrendLine label="Cash and bank at each month's end" data={money.cash.map((c) => ({ label: monthLabel(c.month), value: c.balance }))} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>What customers owe, by age</CardTitle>
              <CardDescription>Unpaid invoices, by how far past their due date.</CardDescription>
            </CardHeader>
            <CardContent>
              {money.aging.every((a) => a.amount === 0) ? (
                <p className="text-muted-foreground text-sm">Nothing unpaid.</p>
              ) : (
                <AmountBars
                  label="Receivables by age"
                  data={money.aging.map((a) => ({ key: a.bucket, label: AGING_LABELS[a.bucket], value: a.amount, note: a.count ? `${a.count} invoice${a.count === 1 ? '' : 's'}` : undefined }))}
                  emphasis={(k) => k === '61-90' || k === '90+'}
                />
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Top customers</CardTitle>
              <CardDescription>Sales in the last 90 days, before VAT.</CardDescription>
            </CardHeader>
            <CardContent>
              {money.topCustomers.length === 0 ? (
                <p className="text-muted-foreground text-sm">No sales in the last 90 days.</p>
              ) : (
                <AmountBars label="Top customers by sales" data={money.topCustomers.map((c) => ({ key: c.id, label: c.name, value: c.sales }))} />
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <div>
        <h3 className="text-muted-foreground mb-3 text-sm font-medium">Modules</h3>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {modules.map(({ slug, label, icon: Icon, summary }) => (
            <Link
              key={slug}
              to={`/w/${workspace.id}/${MODULE_PATHS[slug]}` as never}
              className="group hover:border-foreground/20 focus-visible:ring-ring/50 flex items-start gap-3 rounded-xl border p-4 transition-colors outline-none focus-visible:ring-[3px]"
            >
              <span className="bg-secondary grid size-9 shrink-0 place-items-center rounded-lg">
                <Icon className="size-5" />
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 font-medium">
                  {label}
                  <ArrowRight className="size-4 opacity-0 transition-opacity group-hover:opacity-100" />
                </span>
                <span className="text-muted-foreground block text-sm">{summary}</span>
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
