import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, LogOut } from 'lucide-react'
import type { ReactNode } from 'react'
import { Brand } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { useSignOut } from '@/features/auth/session'
import { workspacesQuery } from './queries'

/**
 * The frame for creating or joining a workspace: brand, and the way out. Someone with no workspace
 * yet can only sign out; someone with one can go back to it.
 */
export function OnboardingLayout({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const signOut = useSignOut()
  const { data: workspaces } = useQuery(workspacesQuery)
  const hasAny = (workspaces?.length ?? 0) > 0
  return (
    <div className="bg-muted/40 min-h-svh">
      <header className="bg-background flex h-14 items-center border-b px-4 md:px-8">
        <Link to="/">
          <Brand />
        </Link>
        <div className="ml-auto">
          {hasAny ? (
            <Button variant="ghost" size="sm" asChild>
              <Link to="/">
                <ArrowLeft />
                Back to my workspace
              </Link>
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => void signOut()}>
              <LogOut />
              Sign out
            </Button>
          )}
        </div>
      </header>
      <main className={wide ? 'mx-auto max-w-5xl px-4 py-10' : 'mx-auto max-w-xl px-4 py-10'}>{children}</main>
    </div>
  )
}
