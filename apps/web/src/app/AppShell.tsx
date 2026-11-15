import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { Building2, LayoutDashboard, LogOut, Menu } from 'lucide-react'
import { useState } from 'react'
import { Brand } from '@/components/brand'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { useSignOut, useUser } from '@/features/auth/session'
import { MODULES } from './modules'

const NAV = [{ path: '/', label: 'Dashboard', icon: LayoutDashboard }, ...MODULES] as const

const navLink =
  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
const navLinkActive = 'bg-sidebar-accent text-sidebar-accent-foreground'

/** Brand, workspace and the module links. Shown in the sidebar, and in a sheet on narrow screens. */
function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col gap-6 p-4">
      <Brand className="px-2 pt-1" />
      <div className="bg-background flex items-center gap-3 rounded-lg border px-3 py-2.5">
        <Building2 className="text-muted-foreground size-4 shrink-0" />
        <div className="min-w-0 text-sm">
          <p className="truncate font-medium">No workspace yet</p>
          <p className="text-muted-foreground truncate text-xs">Create or join one in Phase 1</p>
        </div>
      </div>
      <nav className="grid gap-1" aria-label="Modules">
        {NAV.map(({ path, label, icon: Icon }) => (
          <Link
            key={path}
            to={path}
            onClick={onNavigate}
            className={navLink}
            activeProps={{ className: navLinkActive, 'aria-current': 'page' }}
            activeOptions={{ exact: path === '/' }}
          >
            <Icon className="size-4 shrink-0" />
            {label}
          </Link>
        ))}
      </nav>
      <p className="text-muted-foreground mt-auto px-2 text-xs">Demo – not registered with the BIR.</p>
    </div>
  )
}

function initials(name: string) {
  const parts = name.split(' ').filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase()
}

function UserMenu() {
  const user = useUser()
  const signOut = useSignOut()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="gap-2 px-2" aria-label="Account menu">
          <span className="bg-secondary text-secondary-foreground grid size-8 place-items-center rounded-full text-xs font-semibold">{initials(user.name)}</span>
          <span className="hidden max-w-40 truncate text-sm sm:inline">{user.name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="grid gap-0.5">
          <span className="truncate">{user.name}</span>
          <span className="text-muted-foreground truncate text-xs font-normal">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The title of the page being shown, from the module it belongs to. */
function usePageTitle() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  return NAV.find((n) => (n.path === '/' ? pathname === '/' : pathname.startsWith(n.path)))?.label ?? ''
}

/** The frame around every signed-in page: sidebar (or menu button), top bar, and the page itself. */
export function AppShell() {
  const [menuOpen, setMenuOpen] = useState(false)
  const title = usePageTitle()
  return (
    <div className="flex min-h-svh">
      <aside className="bg-sidebar sticky top-0 hidden h-svh w-64 shrink-0 border-r md:block">
        <SidebarContent />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky top-0 z-30 flex h-14 items-center gap-2 border-b px-4 backdrop-blur md:px-8">
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="-ml-2 md:hidden" aria-label="Open menu">
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent className="bg-sidebar">
              <SheetTitle className="sr-only">Menu</SheetTitle>
              <SheetDescription className="sr-only">Go to another module</SheetDescription>
              <SidebarContent onNavigate={() => setMenuOpen(false)} />
            </SheetContent>
          </Sheet>
          <h1 className="truncate text-base font-semibold">{title}</h1>
          <div className="ml-auto">
            <UserMenu />
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8 md:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
