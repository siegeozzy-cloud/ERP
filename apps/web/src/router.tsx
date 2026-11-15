import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, createRoute, createRouter, Link, notFound, Outlet, redirect } from '@tanstack/react-router'
import { ErrorPage, PendingPage } from '@/components/error-page'
import { Button } from '@/components/ui/button'
import { AppShell } from './app/AppShell'
import { DashboardPage } from './app/DashboardPage'
import { ModulePage } from './app/ModulePage'
import { moduleBySlug } from './app/modules'
import { AuthLayout } from './features/auth/AuthLayout'
import { ForgotPasswordPage } from './features/auth/ForgotPasswordPage'
import { ResetPasswordPage, type ResetSearch } from './features/auth/ResetPasswordPage'
import { sessionQuery } from './features/auth/session'
import { SignInPage, type SignInSearch } from './features/auth/SignInPage'
import { SignUpPage } from './features/auth/SignUpPage'
import { AccountsPage } from './features/finance/AccountsPage'
import { ContactsPage } from './features/finance/ContactsPage'
import { DocumentFormPage } from './features/finance/DocumentFormPage'
import { DocumentListPage } from './features/finance/DocumentListPage'
import { DocumentViewPage } from './features/finance/DocumentViewPage'
import { JournalFormPage, JournalListPage, JournalViewPage } from './features/finance/JournalPages'
import { FinanceLayout, OverviewPage } from './features/finance/OverviewPage'
import { ReportPage, ReportsIndexPage } from './features/finance/ReportPages'
import { AuditLogPage, JoinCodesPage, MembersPage, RolesPage, SettingsLayout, WorkspaceSettingsPage } from './features/settings/SettingsPages'
import { CreateWorkspacePage } from './features/workspaces/CreateWorkspacePage'
import { JoinWorkspacePage } from './features/workspaces/JoinWorkspacePage'
import { WelcomePage } from './features/workspaces/WelcomePage'
import { workspaceQuery, workspacesQuery } from './features/workspaces/queries'

type Context = { queryClient: QueryClient }

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)

/** The workspace someone was last in, so signing in takes them back to it. Per browser, and optional. */
const LAST_WORKSPACE = 'erp.lastWorkspace'
const remember = (id: string) => {
  try {
    localStorage.setItem(LAST_WORKSPACE, id)
  } catch {
    // storage blocked: they'll land in their first workspace instead
  }
}
const remembered = () => {
  try {
    return localStorage.getItem(LAST_WORKSPACE)
  } catch {
    return null
  }
}

function NotFound() {
  return (
    <div className="grid min-h-[60svh] place-items-center px-4 text-center">
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm font-medium">404</p>
        <h1 className="text-2xl font-semibold tracking-tight">There’s no page here</h1>
        <Button asChild>
          <Link to="/">Go to the dashboard</Link>
        </Button>
      </div>
    </div>
  )
}

const rootRoute = createRootRouteWithContext<Context>()({
  component: Outlet,
  notFoundComponent: NotFound,
  errorComponent: ErrorPage,
})

/* ---------- signed out ---------- */

const authLayout = createRoute({ getParentRoute: () => rootRoute, id: 'auth', component: AuthLayout })

/** Signed-in people have no business on sign-in or sign-up: send them on. */
async function guestOnly({ context }: { context: Context }) {
  if (await context.queryClient.ensureQueryData(sessionQuery)) throw redirect({ to: '/' })
}

const signInRoute = createRoute({
  getParentRoute: () => authLayout,
  path: 'sign-in',
  validateSearch: (s: Record<string, unknown>): SignInSearch => ({ redirect: str(s.redirect), verified: str(s.verified), reset: str(s.reset) }),
  beforeLoad: guestOnly,
  component: function SignIn() {
    return <SignInPage search={signInRoute.useSearch()} />
  },
})

const signUpRoute = createRoute({ getParentRoute: () => authLayout, path: 'sign-up', beforeLoad: guestOnly, component: SignUpPage })
const forgotRoute = createRoute({ getParentRoute: () => authLayout, path: 'forgot-password', beforeLoad: guestOnly, component: ForgotPasswordPage })

/** Not guest-only: someone signed in on this browser may still follow a reset link from their email. */
const resetRoute = createRoute({
  getParentRoute: () => authLayout,
  path: 'reset-password',
  validateSearch: (s: Record<string, unknown>): ResetSearch => ({ token: str(s.token), error: str(s.error) }),
  component: function Reset() {
    return <ResetPasswordPage search={resetRoute.useSearch()} />
  },
})

/* ---------- signed in ---------- */

const signedIn = createRoute({
  getParentRoute: () => rootRoute,
  id: 'signed-in',
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery)
    if (!session) throw redirect({ to: '/sign-in', search: { redirect: location.href === '/' ? undefined : location.href } })
  },
  component: Outlet,
})

/** "/" picks the workspace: the last one used, or the first, or the setup page if there's none. */
const homeRoute = createRoute({
  getParentRoute: () => signedIn,
  path: '/',
  beforeLoad: async ({ context }) => {
    const all = await context.queryClient.fetchQuery(workspacesQuery)
    if (all.length === 0) throw redirect({ to: '/welcome' })
    const last = remembered()
    const target = all.find((w) => w.id === last) ?? all[0]!
    throw redirect({ to: '/w/$workspaceId', params: { workspaceId: target.id } })
  },
})

const welcomeRoute = createRoute({ getParentRoute: () => signedIn, path: 'welcome', component: WelcomePage })
const newWorkspaceRoute = createRoute({ getParentRoute: () => signedIn, path: 'new-workspace', component: CreateWorkspacePage })
const joinRoute = createRoute({ getParentRoute: () => signedIn, path: 'join', component: JoinWorkspacePage })

const workspaceLayout = createRoute({
  getParentRoute: () => signedIn,
  path: 'w/$workspaceId',
  beforeLoad: async ({ context, params }) => {
    try {
      await Promise.all([context.queryClient.ensureQueryData(workspaceQuery(params.workspaceId)), context.queryClient.ensureQueryData(workspacesQuery)])
    } catch {
      // not a member, or no such workspace: back to one they do have
      throw redirect({ to: '/' })
    }
    remember(params.workspaceId)
  },
  component: AppShell,
})

const dashboardRoute = createRoute({ getParentRoute: () => workspaceLayout, path: '/', component: DashboardPage })

const moduleRoute = createRoute({
  getParentRoute: () => workspaceLayout,
  path: 'm/$module',
  beforeLoad: ({ params }) => {
    if (!moduleBySlug(params.module)) throw notFound()
  },
  component: function Placeholder() {
    return <ModulePage module={moduleBySlug(moduleRoute.useParams().module)!} />
  },
})

/* ---------- finance ---------- */

const financeLayout = createRoute({ getParentRoute: () => workspaceLayout, path: 'finance', component: FinanceLayout })
const financeRoute = <P extends string>(path: P, component: () => React.ReactNode) => createRoute({ getParentRoute: () => financeLayout, path, component })

const overviewRoute = financeRoute('/', OverviewPage)
const invoicesRoute = financeRoute('invoices', () => <DocumentListPage kind="invoice" />)
const newInvoiceRoute = financeRoute('invoices/new', () => <DocumentFormPage kind="invoice" />)
const invoiceRoute = createRoute({
  getParentRoute: () => financeLayout,
  path: 'invoices/$id',
  component: function InvoiceView() {
    return <DocumentViewPage kind="invoice" id={invoiceRoute.useParams().id} />
  },
})
const editInvoiceRoute = createRoute({
  getParentRoute: () => financeLayout,
  path: 'invoices/$id/edit',
  component: function InvoiceEdit() {
    return <DocumentFormPage kind="invoice" id={editInvoiceRoute.useParams().id} />
  },
})
const billsRoute = financeRoute('bills', () => <DocumentListPage kind="bill" />)
const newBillRoute = financeRoute('bills/new', () => <DocumentFormPage kind="bill" />)
const billRoute = createRoute({
  getParentRoute: () => financeLayout,
  path: 'bills/$id',
  component: function BillView() {
    return <DocumentViewPage kind="bill" id={billRoute.useParams().id} />
  },
})
const editBillRoute = createRoute({
  getParentRoute: () => financeLayout,
  path: 'bills/$id/edit',
  component: function BillEdit() {
    return <DocumentFormPage kind="bill" id={editBillRoute.useParams().id} />
  },
})
const journalRoute = financeRoute('journal', JournalListPage)
const newEntryRoute = financeRoute('journal/new', () => <JournalFormPage />)
const entryRoute = createRoute({
  getParentRoute: () => financeLayout,
  path: 'journal/$id',
  component: function EntryView() {
    return <JournalViewPage id={entryRoute.useParams().id} />
  },
})
const editEntryRoute = createRoute({
  getParentRoute: () => financeLayout,
  path: 'journal/$id/edit',
  component: function EntryEdit() {
    return <JournalFormPage id={editEntryRoute.useParams().id} />
  },
})
const reportsRoute = financeRoute('reports', ReportsIndexPage)
const reportRoute = createRoute({
  getParentRoute: () => financeLayout,
  path: 'reports/$report',
  component: function Report() {
    return <ReportPage report={reportRoute.useParams().report} />
  },
})
const contactsRoute = financeRoute('contacts', ContactsPage)
const accountsRoute = financeRoute('accounts', AccountsPage)

/* ---------- settings ---------- */

const settingsLayout = createRoute({ getParentRoute: () => workspaceLayout, path: 'settings', component: SettingsLayout })
const settingsRoute = <P extends string>(path: P, component: () => React.ReactNode) => createRoute({ getParentRoute: () => settingsLayout, path, component })
const workspaceSettingsRoute = settingsRoute('/', WorkspaceSettingsPage)
const membersRoute = settingsRoute('members', MembersPage)
const joinCodesRoute = settingsRoute('join-codes', JoinCodesPage)
const rolesRoute = settingsRoute('roles', RolesPage)
const auditRoute = settingsRoute('audit', AuditLogPage)

const routeTree = rootRoute.addChildren([
  authLayout.addChildren([signInRoute, signUpRoute, forgotRoute, resetRoute]),
  signedIn.addChildren([
    homeRoute,
    welcomeRoute,
    newWorkspaceRoute,
    joinRoute,
    workspaceLayout.addChildren([
      dashboardRoute,
      moduleRoute,
      settingsLayout.addChildren([workspaceSettingsRoute, membersRoute, joinCodesRoute, rolesRoute, auditRoute]),
      financeLayout.addChildren([
        overviewRoute,
        invoicesRoute,
        newInvoiceRoute,
        invoiceRoute,
        editInvoiceRoute,
        billsRoute,
        newBillRoute,
        billRoute,
        editBillRoute,
        journalRoute,
        newEntryRoute,
        entryRoute,
        editEntryRoute,
        reportsRoute,
        reportRoute,
        contactsRoute,
        accountsRoute,
      ]),
    ]),
  ]),
])

export function makeRouter(queryClient: QueryClient) {
  return createRouter({ routeTree, context: { queryClient }, defaultPreload: 'intent', scrollRestoration: true, defaultErrorComponent: ErrorPage, defaultPendingComponent: PendingPage, defaultPendingMs: 300 })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>
  }
}
