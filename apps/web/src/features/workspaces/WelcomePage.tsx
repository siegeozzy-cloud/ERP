import { Link } from '@tanstack/react-router'
import { Building2, KeyRound } from 'lucide-react'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useUser } from '@/features/auth/session'
import { OnboardingLayout } from './OnboardingLayout'

/** Right after signing up: start a business's workspace, or join one with a code from its owner. */
export function WelcomePage() {
  const user = useUser()
  const choices = [
    { to: '/new-workspace' as const, icon: Building2, title: 'Create a workspace', text: 'For your own business. You’ll pick what kind of business it is, then enter its details.' },
    { to: '/join' as const, icon: KeyRound, title: 'Join with a code', text: 'Someone at your company gave you a code like 7K3Q-9XPA.' },
  ]
  return (
    <OnboardingLayout>
      <div className="mb-8 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome, {user.name.split(' ')[0]}</h1>
        <p className="text-muted-foreground">Everything here happens inside a workspace: one business, its books and its people.</p>
      </div>
      <div className="grid gap-4">
        {choices.map(({ to, icon: Icon, title, text }) => (
          <Link key={to} to={to} className="group focus-visible:ring-ring/50 rounded-xl outline-none focus-visible:ring-[3px]">
            <Card className="group-hover:border-foreground/30 transition-colors">
              <CardHeader className="grid-cols-[auto_1fr] items-center gap-x-4">
                <span className="bg-secondary row-span-2 grid size-11 place-items-center rounded-lg">
                  <Icon className="size-5" />
                </span>
                <CardTitle>{title}</CardTitle>
                <CardDescription>{text}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </OnboardingLayout>
  )
}
