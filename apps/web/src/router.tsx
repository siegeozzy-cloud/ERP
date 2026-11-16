import type { QueryClient } from '@tanstack/react-query'
import { lazy } from 'react'
import { createRootRouteWithContext, createRoute, createRouter, Link, notFound, Outlet, redirect, type RouteComponent } from '@tanstack/react-router'
import { ErrorPage, PendingPage } from '@/components/error-page'
import { Button } from '@/components/ui/button'
import { AppShell } from './app/AppShell'
import { moduleBySlug } from './app/modules'
import { AuthLayout } from './features/auth/AuthLayout'
import { LandingPage } from './features/landing/LandingPage'
import { ForgotPasswordPage } from './features/auth/ForgotPasswordPage'
import { ResetPasswordPage, type ResetSearch } from './features/auth/ResetPasswordPage'
import { sessionQuery } from './features/auth/session'
import { SignInPage, type SignInSearch } from './features/auth/SignInPage'
import { SignUpPage } from './features/auth/SignUpPage'
import type { WoFormSearch } from './features/manufacturing/ManufacturingPages'
import { workspaceQuery, workspacesQuery } from './features/workspaces/queries'

// Each module's pages load when first visited (Phase 9): the first download is the shell, sign-in
// and the front page.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lazyPage<M extends Record<string, any>, K extends keyof M>(load: () => Promise<M>, name: K): M[K] {
  return lazy(() => load().then((m) => ({ default: m[name] }))) as unknown as M[K]
}
const DashboardPage = lazyPage(() => import('./app/DashboardPage'), 'DashboardPage')
const ModulePage = lazyPage(() => import('./app/ModulePage'), 'ModulePage')
const DemoStartPage = lazyPage(() => import('./features/demo/demo'), 'DemoStartPage')
const CrmLayout = lazyPage(() => import('./features/crm/CrmPages'), 'CrmLayout')
const CrmOverviewPage = lazyPage(() => import('./features/crm/CrmPages'), 'CrmOverviewPage')
const CustomerPage = lazyPage(() => import('./features/crm/CrmPages'), 'CustomerPage')
const CustomersPage = lazyPage(() => import('./features/crm/CrmPages'), 'CustomersPage')
const LeadPage = lazyPage(() => import('./features/crm/CrmPages'), 'LeadPage')
const PipelinePage = lazyPage(() => import('./features/crm/CrmPages'), 'PipelinePage')
const PriceListsPage = lazyPage(() => import('./features/crm/CrmPages'), 'PriceListsPage')
const DeliveriesPage = lazyPage(() => import('./features/crm/SalesPages'), 'DeliveriesPage')
const DeliveryPage = lazyPage(() => import('./features/crm/SalesPages'), 'DeliveryPage')
const OrderPage = lazyPage(() => import('./features/crm/SalesPages'), 'OrderPage')
const OrdersPage = lazyPage(() => import('./features/crm/SalesPages'), 'OrdersPage')
const QuotePage = lazyPage(() => import('./features/crm/SalesPages'), 'QuotePage')
const QuotesPage = lazyPage(() => import('./features/crm/SalesPages'), 'QuotesPage')
const SalesFormPage = lazyPage(() => import('./features/crm/SalesPages'), 'SalesFormPage')
const AccountsPage = lazyPage(() => import('./features/finance/AccountsPage'), 'AccountsPage')
const AttendancePage = lazyPage(() => import('./features/hr/HrPages'), 'AttendancePage')
const EmployeePage = lazyPage(() => import('./features/hr/HrPages'), 'EmployeePage')
const EmployeesPage = lazyPage(() => import('./features/hr/HrPages'), 'EmployeesPage')
const HrLayout = lazyPage(() => import('./features/hr/HrPages'), 'HrLayout')
const HrOverviewPage = lazyPage(() => import('./features/hr/HrPages'), 'HrOverviewPage')
const HrSettingsPage = lazyPage(() => import('./features/hr/HrPages'), 'HrSettingsPage')
const LeavePage = lazyPage(() => import('./features/hr/HrPages'), 'LeavePage')
const MePage = lazyPage(() => import('./features/hr/MePage'), 'MePage')
const BomFormPage = lazyPage(() => import('./features/manufacturing/ManufacturingPages'), 'BomFormPage')
const BomPage = lazyPage(() => import('./features/manufacturing/ManufacturingPages'), 'BomPage')
const BomsPage = lazyPage(() => import('./features/manufacturing/ManufacturingPages'), 'BomsPage')
const ManufacturingLayout = lazyPage(() => import('./features/manufacturing/ManufacturingPages'), 'ManufacturingLayout')
const ManufacturingOverviewPage = lazyPage(() => import('./features/manufacturing/ManufacturingPages'), 'ManufacturingOverviewPage')
const PlanningPage = lazyPage(() => import('./features/manufacturing/ManufacturingPages'), 'PlanningPage')
const WorkCentersPage = lazyPage(() => import('./features/manufacturing/ManufacturingPages'), 'WorkCentersPage')
const WorkOrderFormPage = lazyPage(() => import('./features/manufacturing/ManufacturingPages'), 'WorkOrderFormPage')
const WorkOrderPage = lazyPage(() => import('./features/manufacturing/ManufacturingPages'), 'WorkOrderPage')
const WorkOrdersPage = lazyPage(() => import('./features/manufacturing/ManufacturingPages'), 'WorkOrdersPage')
const ProjectFormPage = lazyPage(() => import('./features/projects/ProjectsPages'), 'ProjectFormPage')
const ProjectPage = lazyPage(() => import('./features/projects/ProjectsPages'), 'ProjectPage')
const ProjectsLayout = lazyPage(() => import('./features/projects/ProjectsPages'), 'ProjectsLayout')
const ProjectsOverviewPage = lazyPage(() => import('./features/projects/ProjectsPages'), 'ProjectsOverviewPage')
const ProjectsPage = lazyPage(() => import('./features/projects/ProjectsPages'), 'ProjectsPage')
const TimesheetsPage = lazyPage(() => import('./features/projects/ProjectsPages'), 'TimesheetsPage')
const PayrollReportsPage = lazyPage(() => import('./features/hr/PayrollPages'), 'PayrollReportsPage')
const PayrollRunPage = lazyPage(() => import('./features/hr/PayrollPages'), 'PayrollRunPage')
const PayrollRunsPage = lazyPage(() => import('./features/hr/PayrollPages'), 'PayrollRunsPage')
const PayslipPage = lazyPage(() => import('./features/hr/PayrollPages'), 'PayslipPage')
const ContactsPage = lazyPage(() => import('./features/finance/ContactsPage'), 'ContactsPage')
const DocumentFormPage = lazyPage(() => import('./features/finance/DocumentFormPage'), 'DocumentFormPage')
const DocumentListPage = lazyPage(() => import('./features/finance/DocumentListPage'), 'DocumentListPage')
const DocumentViewPage = lazyPage(() => import('./features/finance/DocumentViewPage'), 'DocumentViewPage')
const JournalFormPage = lazyPage(() => import('./features/finance/JournalPages'), 'JournalFormPage')
const JournalListPage = lazyPage(() => import('./features/finance/JournalPages'), 'JournalListPage')
const JournalViewPage = lazyPage(() => import('./features/finance/JournalPages'), 'JournalViewPage')
const FinanceLayout = lazyPage(() => import('./features/finance/OverviewPage'), 'FinanceLayout')
const OverviewPage = lazyPage(() => import('./features/finance/OverviewPage'), 'OverviewPage')
const ReportPage = lazyPage(() => import('./features/finance/ReportPages'), 'ReportPage')
const ReportsIndexPage = lazyPage(() => import('./features/finance/ReportPages'), 'ReportsIndexPage')
const InventoryLayout = lazyPage(() => import('./features/inventory/InventoryPages'), 'InventoryLayout')
const InventoryOverviewPage = lazyPage(() => import('./features/inventory/InventoryPages'), 'InventoryOverviewPage')
const ItemDetailPage = lazyPage(() => import('./features/inventory/InventoryPages'), 'ItemDetailPage')
const ItemsPage = lazyPage(() => import('./features/inventory/InventoryPages'), 'ItemsPage')
const QualityPage = lazyPage(() => import('./features/inventory/InventoryPages'), 'QualityPage')
const ValuationPage = lazyPage(() => import('./features/inventory/InventoryPages'), 'ValuationPage')
const WarehousesPage = lazyPage(() => import('./features/inventory/InventoryPages'), 'WarehousesPage')
const PurchaseOrderFormPage = lazyPage(() => import('./features/inventory/PurchasePages'), 'PurchaseOrderFormPage')
const PurchaseOrderPage = lazyPage(() => import('./features/inventory/PurchasePages'), 'PurchaseOrderPage')
const PurchaseOrdersPage = lazyPage(() => import('./features/inventory/PurchasePages'), 'PurchaseOrdersPage')
const AdjustmentPage = lazyPage(() => import('./features/inventory/StockPages'), 'AdjustmentPage')
const StockDocumentPage = lazyPage(() => import('./features/inventory/StockPages'), 'StockDocumentPage')
const StockDocumentsPage = lazyPage(() => import('./features/inventory/StockPages'), 'StockDocumentsPage')
const TransferPage = lazyPage(() => import('./features/inventory/StockPages'), 'TransferPage')
const AuditLogPage = lazyPage(() => import('./features/settings/SettingsPages'), 'AuditLogPage')
const JoinCodesPage = lazyPage(() => import('./features/settings/SettingsPages'), 'JoinCodesPage')
const MembersPage = lazyPage(() => import('./features/settings/SettingsPages'), 'MembersPage')
const RolesPage = lazyPage(() => import('./features/settings/SettingsPages'), 'RolesPage')
const SettingsLayout = lazyPage(() => import('./features/settings/SettingsPages'), 'SettingsLayout')
const WorkspaceSettingsPage = lazyPage(() => import('./features/settings/SettingsPages'), 'WorkspaceSettingsPage')
const ImportPage = lazyPage(() => import('./features/settings/ImportPage'), 'ImportPage')
const CreateWorkspacePage = lazyPage(() => import('./features/workspaces/CreateWorkspacePage'), 'CreateWorkspacePage')
const JoinWorkspacePage = lazyPage(() => import('./features/workspaces/JoinWorkspacePage'), 'JoinWorkspacePage')
const WelcomePage = lazyPage(() => import('./features/workspaces/WelcomePage'), 'WelcomePage')

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

/** /demo opens the demo straight away: the link to share. Not guest-only: someone already in their demo goes back to it. */
const demoRoute = createRoute({ getParentRoute: () => authLayout, path: 'demo', component: DemoStartPage })

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

/**
 * "/" is the public front page for visitors; someone signed in goes on to their workspace (the last
 * one used, or the first, or the setup page if there's none).
 */
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: LandingPage,
  beforeLoad: async ({ context }) => {
    if (!(await context.queryClient.ensureQueryData(sessionQuery))) return
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
const financeRoute = <P extends string>(path: P, component: RouteComponent) => createRoute({ getParentRoute: () => financeLayout, path, component })

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

/* ---------- inventory ---------- */

const inventoryLayout = createRoute({ getParentRoute: () => workspaceLayout, path: 'inventory', component: InventoryLayout })
const invRoute = <P extends string>(path: P, component: RouteComponent) => createRoute({ getParentRoute: () => inventoryLayout, path, component })
const invOverviewRoute = invRoute('/', InventoryOverviewPage)
const itemsRoute = invRoute('items', ItemsPage)
const itemRoute = createRoute({
  getParentRoute: () => inventoryLayout,
  path: 'items/$id',
  component: function ItemView() {
    return <ItemDetailPage id={itemRoute.useParams().id} />
  },
})
const warehousesRoute = invRoute('warehouses', WarehousesPage)
const valuationRoute = invRoute('valuation', ValuationPage)
const qualityRoute = invRoute('quality', QualityPage)
const stockRoute = invRoute('stock', StockDocumentsPage)
const adjustRoute = invRoute('stock/adjust', AdjustmentPage)
const transferRoute = invRoute('stock/transfer', TransferPage)
const stockDocRoute = createRoute({
  getParentRoute: () => inventoryLayout,
  path: 'stock/$id',
  component: function StockDocView() {
    return <StockDocumentPage id={stockDocRoute.useParams().id} />
  },
})
const posRoute = invRoute('purchase-orders', PurchaseOrdersPage)
const newPoRoute = invRoute('purchase-orders/new', () => <PurchaseOrderFormPage />)
const poRoute = createRoute({
  getParentRoute: () => inventoryLayout,
  path: 'purchase-orders/$id',
  component: function PoView() {
    return <PurchaseOrderPage id={poRoute.useParams().id} />
  },
})
const editPoRoute = createRoute({
  getParentRoute: () => inventoryLayout,
  path: 'purchase-orders/$id/edit',
  component: function PoEdit() {
    return <PurchaseOrderFormPage id={editPoRoute.useParams().id} />
  },
})

/* ---------- sales & CRM ---------- */

type NewSalesSearch = { customerId?: string; leadId?: string }
const newSalesSearch = (s: Record<string, unknown>): NewSalesSearch => ({ customerId: str(s.customerId), leadId: str(s.leadId) })

const crmLayout = createRoute({ getParentRoute: () => workspaceLayout, path: 'crm', component: CrmLayout })
const crmRoute = <P extends string>(path: P, component: RouteComponent) => createRoute({ getParentRoute: () => crmLayout, path, component })
const priceListsRoute = crmRoute('price-lists', PriceListsPage)
const crmOverviewRoute = crmRoute('/', CrmOverviewPage)
const pipelineRoute = crmRoute('pipeline', PipelinePage)
const leadRoute = createRoute({
  getParentRoute: () => crmLayout,
  path: 'leads/$id',
  component: function LeadView() {
    return <LeadPage id={leadRoute.useParams().id} />
  },
})
const customersRoute = crmRoute('customers', CustomersPage)
const customerRoute = createRoute({
  getParentRoute: () => crmLayout,
  path: 'customers/$id',
  component: function CustomerView() {
    return <CustomerPage id={customerRoute.useParams().id} />
  },
})
const quotesRoute = crmRoute('quotes', QuotesPage)
const newQuoteRoute = createRoute({
  getParentRoute: () => crmLayout,
  path: 'quotes/new',
  validateSearch: newSalesSearch,
  component: function NewQuote() {
    const search = newQuoteRoute.useSearch()
    return <SalesFormPage kind="quote" customerId={search.customerId} leadId={search.leadId} />
  },
})
const quoteRoute = createRoute({
  getParentRoute: () => crmLayout,
  path: 'quotes/$id',
  component: function QuoteView() {
    return <QuotePage id={quoteRoute.useParams().id} />
  },
})
const editQuoteRoute = createRoute({
  getParentRoute: () => crmLayout,
  path: 'quotes/$id/edit',
  component: function QuoteEdit() {
    return <SalesFormPage kind="quote" id={editQuoteRoute.useParams().id} />
  },
})
const ordersRoute = crmRoute('orders', OrdersPage)
const newOrderRoute = createRoute({
  getParentRoute: () => crmLayout,
  path: 'orders/new',
  validateSearch: newSalesSearch,
  component: function NewOrder() {
    return <SalesFormPage kind="order" customerId={newOrderRoute.useSearch().customerId} />
  },
})
const orderRoute = createRoute({
  getParentRoute: () => crmLayout,
  path: 'orders/$id',
  component: function OrderView() {
    return <OrderPage id={orderRoute.useParams().id} />
  },
})
const editOrderRoute = createRoute({
  getParentRoute: () => crmLayout,
  path: 'orders/$id/edit',
  component: function OrderEdit() {
    return <SalesFormPage kind="order" id={editOrderRoute.useParams().id} />
  },
})
const deliveriesRoute = crmRoute('deliveries', DeliveriesPage)
const deliveryRoute = createRoute({
  getParentRoute: () => crmLayout,
  path: 'deliveries/$id',
  component: function DeliveryView() {
    return <DeliveryPage id={deliveryRoute.useParams().id} />
  },
})

/* ---------- HR & payroll ---------- */

/* ---------- projects ---------- */

const prjLayout = createRoute({ getParentRoute: () => workspaceLayout, path: 'projects', component: ProjectsLayout })
const prjRoute = <P extends string>(path: P, component: RouteComponent) => createRoute({ getParentRoute: () => prjLayout, path, component })
const prjOverviewRoute = prjRoute('/', ProjectsOverviewPage)
const prjListRoute = prjRoute('all', ProjectsPage)
const prjNewRoute = prjRoute('new', () => <ProjectFormPage />)
const timesheetsRoute = prjRoute('timesheets', TimesheetsPage)
const prjRouteOne = createRoute({
  getParentRoute: () => prjLayout,
  path: '$id',
  component: function ProjectView() {
    return <ProjectPage id={prjRouteOne.useParams().id} />
  },
})
const prjEditRoute = createRoute({
  getParentRoute: () => prjLayout,
  path: '$id/edit',
  component: function ProjectEdit() {
    return <ProjectFormPage id={prjEditRoute.useParams().id} />
  },
})

/* ---------- manufacturing ---------- */

const mfgLayout = createRoute({ getParentRoute: () => workspaceLayout, path: 'manufacturing', component: ManufacturingLayout })
const mfgRoute = <P extends string>(path: P, component: RouteComponent) => createRoute({ getParentRoute: () => mfgLayout, path, component })
const mfgOverviewRoute = mfgRoute('/', ManufacturingOverviewPage)
const workOrdersRoute = mfgRoute('work-orders', WorkOrdersPage)
const newWoRoute = createRoute({
  getParentRoute: () => mfgLayout,
  path: 'work-orders/new',
  validateSearch: (s: Record<string, unknown>): WoFormSearch => ({ itemId: str(s.itemId), quantity: s.quantity === undefined ? undefined : String(s.quantity), salesOrderId: str(s.salesOrderId) }),
  component: function NewWo() {
    return <WorkOrderFormPage search={newWoRoute.useSearch()} />
  },
})
const woRoute = createRoute({
  getParentRoute: () => mfgLayout,
  path: 'work-orders/$id',
  component: function WoView() {
    return <WorkOrderPage id={woRoute.useParams().id} />
  },
})
const editWoRoute = createRoute({
  getParentRoute: () => mfgLayout,
  path: 'work-orders/$id/edit',
  component: function WoEdit() {
    return <WorkOrderFormPage id={editWoRoute.useParams().id} />
  },
})
const bomsRoute = mfgRoute('boms', BomsPage)
const newBomRoute = createRoute({
  getParentRoute: () => mfgLayout,
  path: 'boms/new',
  validateSearch: (s: Record<string, unknown>): { copy?: string } => ({ copy: str(s.copy) }),
  component: function NewBom() {
    const { copy } = newBomRoute.useSearch()
    return <BomFormPage key={copy ?? 'new'} copy={copy} />
  },
})
const bomRoute = createRoute({
  getParentRoute: () => mfgLayout,
  path: 'boms/$id',
  component: function BomView() {
    return <BomPage id={bomRoute.useParams().id} />
  },
})
const editBomRoute = createRoute({
  getParentRoute: () => mfgLayout,
  path: 'boms/$id/edit',
  component: function BomEdit() {
    return <BomFormPage id={editBomRoute.useParams().id} />
  },
})
const planningRoute = mfgRoute('planning', PlanningPage)
const workCentersRoute = mfgRoute('work-centers', WorkCentersPage)

const hrLayout = createRoute({ getParentRoute: () => workspaceLayout, path: 'hr', component: HrLayout })
const hrRoute = <P extends string>(path: P, component: RouteComponent) => createRoute({ getParentRoute: () => hrLayout, path, component })
const hrOverviewRoute = hrRoute('/', HrOverviewPage)
const employeesRoute = hrRoute('employees', EmployeesPage)
const employeeRoute = createRoute({
  getParentRoute: () => hrLayout,
  path: 'employees/$id',
  component: function EmployeeView() {
    return <EmployeePage id={employeeRoute.useParams().id} />
  },
})
const attendanceRoute = hrRoute('attendance', AttendancePage)
const leaveRoute = hrRoute('leave', LeavePage)
const payrollRoute = hrRoute('payroll', PayrollRunsPage)
const payrollRunRoute = createRoute({
  getParentRoute: () => hrLayout,
  path: 'payroll/$id',
  component: function RunView() {
    return <PayrollRunPage id={payrollRunRoute.useParams().id} />
  },
})
const payslipRoute = createRoute({
  getParentRoute: () => hrLayout,
  path: 'payslips/$id',
  component: function SlipView() {
    return <PayslipPage id={payslipRoute.useParams().id} />
  },
})
const hrReportsRoute = hrRoute('reports', PayrollReportsPage)
const hrSettingsRoute = hrRoute('settings', HrSettingsPage)
/** Self-service: open to every member, outside the HR tabs. */
const meRoute = createRoute({ getParentRoute: () => workspaceLayout, path: 'me', component: MePage })
const myPayslipRoute = createRoute({
  getParentRoute: () => workspaceLayout,
  path: 'me/payslips/$id',
  component: function MySlip() {
    return <PayslipPage id={myPayslipRoute.useParams().id} mine />
  },
})

/* ---------- settings ---------- */

const settingsLayout = createRoute({ getParentRoute: () => workspaceLayout, path: 'settings', component: SettingsLayout })
const settingsRoute = <P extends string>(path: P, component: RouteComponent) => createRoute({ getParentRoute: () => settingsLayout, path, component })
const workspaceSettingsRoute = settingsRoute('/', WorkspaceSettingsPage)
const membersRoute = settingsRoute('members', MembersPage)
const importRoute = settingsRoute('import', ImportPage)
const joinCodesRoute = settingsRoute('join-codes', JoinCodesPage)
const rolesRoute = settingsRoute('roles', RolesPage)
const auditRoute = settingsRoute('audit', AuditLogPage)

const routeTree = rootRoute.addChildren([
  authLayout.addChildren([signInRoute, signUpRoute, forgotRoute, resetRoute, demoRoute]),
  homeRoute,
  signedIn.addChildren([
    welcomeRoute,
    newWorkspaceRoute,
    joinRoute,
    workspaceLayout.addChildren([
      dashboardRoute,
      moduleRoute,
      settingsLayout.addChildren([workspaceSettingsRoute, membersRoute, joinCodesRoute, rolesRoute, auditRoute, importRoute]),
      meRoute,
      myPayslipRoute,
      prjLayout.addChildren([prjOverviewRoute, prjListRoute, prjNewRoute, timesheetsRoute, prjRouteOne, prjEditRoute]),
      mfgLayout.addChildren([mfgOverviewRoute, workOrdersRoute, newWoRoute, woRoute, editWoRoute, bomsRoute, newBomRoute, bomRoute, editBomRoute, planningRoute, workCentersRoute]),
      hrLayout.addChildren([hrOverviewRoute, employeesRoute, employeeRoute, attendanceRoute, leaveRoute, payrollRoute, payrollRunRoute, payslipRoute, hrReportsRoute, hrSettingsRoute]),
      crmLayout.addChildren([
        priceListsRoute,
        crmOverviewRoute,
        pipelineRoute,
        leadRoute,
        customersRoute,
        customerRoute,
        quotesRoute,
        newQuoteRoute,
        quoteRoute,
        editQuoteRoute,
        ordersRoute,
        newOrderRoute,
        orderRoute,
        editOrderRoute,
        deliveriesRoute,
        deliveryRoute,
      ]),
      inventoryLayout.addChildren([
        qualityRoute,
        invOverviewRoute,
        itemsRoute,
        itemRoute,
        warehousesRoute,
        valuationRoute,
        stockRoute,
        adjustRoute,
        transferRoute,
        stockDocRoute,
        posRoute,
        newPoRoute,
        poRoute,
        editPoRoute,
      ]),
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
