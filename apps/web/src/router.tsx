import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, createRoute, createRouter, Link, Outlet, redirect } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { AppShell } from './app/AppShell'
import { DashboardPage } from './app/DashboardPage'
import { ModulePage } from './app/ModulePage'
import { MODULES } from './app/modules'
import { AuthLayout } from './features/auth/AuthLayout'
import { ForgotPasswordPage } from './features/auth/ForgotPasswordPage'
import { ResetPasswordPage, type ResetSearch } from './features/auth/ResetPasswordPage'
import { sessionQuery } from './features/auth/session'
import { SignInPage, type SignInSearch } from './features/auth/SignInPage'
import { SignUpPage } from './features/auth/SignUpPage'

type Context = { queryClient: QueryClient }

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)

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
})

/* ---------- signed out ---------- */

const authLayout = createRoute({ getParentRoute: () => rootRoute, id: 'auth', component: AuthLayout })

/** Signed-in people have no business on sign-in or sign-up: send them to the dashboard. */
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

const appLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery)
    if (!session) throw redirect({ to: '/sign-in', search: { redirect: location.href === '/' ? undefined : location.href } })
  },
  component: AppShell,
})

const dashboardRoute = createRoute({ getParentRoute: () => appLayout, path: '/', component: DashboardPage })

const moduleRoutes = MODULES.map((m) =>
  createRoute({
    getParentRoute: () => appLayout,
    path: m.path,
    component: () => <ModulePage module={m} />,
  }),
)

const routeTree = rootRoute.addChildren([
  authLayout.addChildren([signInRoute, signUpRoute, forgotRoute, resetRoute]),
  appLayout.addChildren([dashboardRoute, ...moduleRoutes]),
])

export function makeRouter(queryClient: QueryClient) {
  return createRouter({ routeTree, context: { queryClient }, defaultPreload: 'intent', scrollRestoration: true })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>
  }
}
