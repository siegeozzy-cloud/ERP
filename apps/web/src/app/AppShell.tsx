import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { Building2, Check, ChevronsUpDown, KeyRound, LayoutDashboard, LogOut, Menu, Plus, Settings } from 'lucide-react'
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
import { useCan, useWorkspace, workspacesQuery } from '@/features/workspaces/queries'
import { MODULES } from './modules'

const navLink =
  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
const navLinkActive = 'bg-sidebar-accent text-sidebar-accent-foreground'
const active = { className: navLinkActive, 'aria-current': 'page' as const }

/** Which workspace this is, and the way to the others. */
function WorkspaceSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const workspace = useWorkspace()
  const { data: all = [] } = useQuery(workspacesQuery)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="bg-background hover:bg-accent flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors">
          <Building2 className="text-muted-foreground size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{workspace.name}</span>
            <span className="text-muted-foreground block truncate text-xs">{workspace.role.name}</span>
          </span>
          <ChevronsUpDown className="text-muted-foreground size-4 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">Workspaces</DropdownMenuLabel>
        {all.map((w) => (
          <DropdownMenuItem key={w.id} asChild>
            <Link to="/w/$workspaceId" params={{ workspaceId: w.id }} onClick={onNavigate}>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{w.name}</span>
                <span className="text-muted-foreground block truncate text-xs">{w.roleName}</span>
              </span>
              {w.id === workspace.id && <Check />}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/new-workspace" onClick={onNavigate}>
            <Plus />
            Create a workspace
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/join" onClick={onNavigate}>
            <KeyRound />
            Join with a code
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Brand, workspace and the module links. Shown in the sidebar, and in a sheet on narrow screens. */
function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { id: workspaceId, modules } = useWorkspace()
  const can = useCan()
  // only what this workspace has turned on, and Finance only for roles that may see it
  const shown = MODULES.filter((m) => (modules as string[]).includes(m.slug) && (m.slug !== 'finance' || can('finance.view')))
  return (
    <div className="flex h-full flex-col gap-6 p-4">
      <Brand className="px-2 pt-1" />
      <WorkspaceSwitcher onNavigate={onNavigate} />
      <nav className="grid gap-1" aria-label="Modules">
        <Link to="/w/$workspaceId" params={{ workspaceId }} onClick={onNavigate} className={navLink} activeProps={active} activeOptions={{ exact: true }}>
          <LayoutDashboard className="size-4 shrink-0" />
          Dashboard
        </Link>
        {shown.map(({ slug, label, icon: Icon, ready }) =>
          slug === 'finance' ? (
            <Link key={slug} to="/w/$workspaceId/finance" params={{ workspaceId }} onClick={onNavigate} className={navLink} activeProps={active}>
              <Icon className="size-4 shrink-0" />
              {label}
            </Link>
          ) : (
            <Link key={slug} to="/w/$workspaceId/m/$module" params={{ workspaceId, module: slug }} onClick={onNavigate} className={navLink} activeProps={active}>
              <Icon className="size-4 shrink-0" />
              <span className="flex-1">{label}</span>
              {!ready && <span className="text-muted-foreground text-xs font-normal">Soon</span>}
            </Link>
          ),
        )}
        <Link to="/w/$workspaceId/settings" params={{ workspaceId }} onClick={onNavigate} className={navLink} activeProps={active}>
          <Settings className="size-4 shrink-0" />
          Settings
        </Link>
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

/** The page title, from the module the address belongs to. */
function usePageTitle() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const segment = pathname.split('/')[3] === 'm' ? pathname.split('/')[4] : pathname.split('/')[3]
  if (segment === 'settings') return 'Settings'
  return MODULES.find((m) => m.slug === segment)?.label ?? 'Dashboard'
}

/**
 * The frame around every page inside a workspace: sidebar (or menu button), top bar, and the page.
 * Hidden when printing, so an invoice or a BIR form prints on its own.
 */
export function AppShell() {
  const [menuOpen, setMenuOpen] = useState(false)
  const title = usePageTitle()
  return (
    <div className="flex min-h-svh">
      <aside className="bg-sidebar sticky top-0 hidden h-svh w-64 shrink-0 border-r md:block print:hidden">
        <SidebarContent />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky top-0 z-30 flex h-14 items-center gap-2 border-b px-4 backdrop-blur md:px-8 print:hidden">
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
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8 md:py-8 print:max-w-none print:p-0">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
