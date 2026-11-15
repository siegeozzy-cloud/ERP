import { formatPeso } from '@erp/shared'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useUser } from '@/features/auth/session'
import { financeQueries } from '@/features/finance/queries'
import { useCan, useWorkspace } from '@/features/workspaces/queries'
import { MODULES } from './modules'

function greeting(hour: number) {
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-xl tabular-nums">{value}</CardTitle>
      </CardHeader>
    </Card>
  )
}

export function DashboardPage() {
  const user = useUser()
  const workspace = useWorkspace()
  const can = useCan()
  const { data: overview } = useQuery({ ...financeQueries.overview(workspace.id), enabled: can('finance.view') })
  const modules = MODULES.filter((m) => (workspace.modules as string[]).includes(m.slug))
  return (
    <div className="space-y-8">
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
          <Stat label="Customers owe you" value={formatPeso(overview.receivables)} />
          <Stat label="You owe suppliers" value={formatPeso(overview.payables)} />
          <Stat label="Profit this month" value={formatPeso(overview.monthToDate.income - overview.monthToDate.expenses)} />
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {modules.map(({ slug, label, icon: Icon, phase, ready, summary }) => {
          const card = (
            <Card className="group-hover:border-foreground/20 h-full gap-4 transition-colors">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <span className="bg-secondary grid size-9 place-items-center rounded-lg">
                    <Icon className="size-5" />
                  </span>
                  {ready ? <Badge variant="success">Ready</Badge> : <Badge variant="secondary">Phase {phase}</Badge>}
                </div>
                <CardTitle className="mt-3 flex items-center gap-1.5">
                  {label}
                  <ArrowRight className="size-4 opacity-0 transition-opacity group-hover:opacity-100" />
                </CardTitle>
                <CardDescription>{summary}</CardDescription>
              </CardHeader>
            </Card>
          )
          const linkClass = 'group focus-visible:ring-ring/50 rounded-xl outline-none focus-visible:ring-[3px]'
          return slug === 'finance' ? (
            <Link key={slug} to="/w/$workspaceId/finance" params={{ workspaceId: workspace.id }} className={linkClass}>
              {card}
            </Link>
          ) : (
            <Link key={slug} to="/w/$workspaceId/m/$module" params={{ workspaceId: workspace.id, module: slug }} className={linkClass}>
              {card}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
