import { Check } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { Module } from './modules'

/** Placeholder for a module that hasn't been built yet: what it is, and what its phase delivers. */
export function ModulePage({ module: m }: { module: Module }) {
  const Icon = m.icon
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-4">
        <span className="bg-secondary grid size-12 shrink-0 place-items-center rounded-xl">
          <Icon className="size-6" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">{m.label}</h2>
            <Badge variant="outline">Coming in Phase {m.phase}</Badge>
          </div>
          <p className="text-muted-foreground">{m.summary}</p>
        </div>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>What’s planned</CardTitle>
          <CardDescription>Built in Phase {m.phase} of the roadmap.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-3">
            {m.planned.map((item) => (
              <li key={item} className="flex items-start gap-3 text-sm">
                <Check className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                {item}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
