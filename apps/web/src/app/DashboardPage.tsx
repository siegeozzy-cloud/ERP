import { Link } from '@tanstack/react-router'
import { ArrowRight, Building2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useUser } from '@/features/auth/session'
import { MODULES } from './modules'

function greeting(hour: number) {
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export function DashboardPage() {
  const user = useUser()
  const firstName = user.name.split(' ')[0]
  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">
          {greeting(new Date().getHours())}, {firstName}
        </h2>
        <p className="text-muted-foreground">Here’s what this ERP will cover. Each module opens as its phase is built.</p>
      </div>

      <Card className="border-dashed">
        <CardHeader className="grid-cols-[auto_1fr] items-center gap-x-4">
          <Building2 className="text-muted-foreground row-span-2 size-8" />
          <CardTitle>Set up your workspace</CardTitle>
          <CardDescription>
            Next up (Phase 1): create a workspace from a template for your kind of business, or join your company’s with a one-time code.
          </CardDescription>
        </CardHeader>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {MODULES.map(({ path, label, icon: Icon, phase, summary }) => (
          <Link key={path} to={path} className="group focus-visible:ring-ring/50 rounded-xl outline-none focus-visible:ring-[3px]">
            <Card className="group-hover:border-foreground/20 h-full gap-4 transition-colors">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <span className="bg-secondary grid size-9 place-items-center rounded-lg">
                    <Icon className="size-5" />
                  </span>
                  <Badge variant="secondary">Phase {phase}</Badge>
                </div>
                <CardTitle className="mt-3 flex items-center gap-1.5">
                  {label}
                  <ArrowRight className="size-4 opacity-0 transition-opacity group-hover:opacity-100" />
                </CardTitle>
                <CardDescription>{summary}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
