import { TEMPLATES } from '@erp/shared'
import { Link } from '@tanstack/react-router'
import {
  ArrowRight,
  BadgeCheck,
  Boxes,
  ClipboardList,
  Clock,
  Factory,
  FolderKanban,
  Handshake,
  Landmark,
  Lock,
  MapPin,
  ScanBarcode,
  ShieldCheck,
  Smartphone,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { Brand } from '@/components/brand'
import { Button } from '@/components/ui/button'

/**
 * The public front page (Phase 9): what the product is, for a business owner or an investor, with
 * "Try the demo" one click away. Signed-in people never see it: "/" sends them to their workspace.
 */

const MODULES: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: Landmark, title: 'Finance', text: 'General ledger, EOPT invoices, bills and payments, VAT and percentage tax, Form 2307, books of accounts and the BIR summaries.' },
  { icon: Boxes, title: 'Inventory & purchasing', text: 'Stock by warehouse and lot, moving average cost, purchase orders to receipts to bills, reorder alerts, expiry first-out.' },
  { icon: Handshake, title: 'Sales & CRM', text: 'Leads on a pipeline, quotes, sales orders, delivery receipts and invoices, credit limits and price lists.' },
  { icon: Users, title: 'HR & payroll', text: 'Employees, GPS clock-in, leave, and payroll with SSS, PhilHealth, Pag-IBIG, TRAIN tax, 13th month and the government reports.' },
  { icon: Factory, title: 'Manufacturing', text: 'Bills of materials and routings, work orders with quality checks, production costing and material planning.' },
  { icon: FolderKanban, title: 'Projects', text: 'Tasks on a Gantt chart, timesheets, job costing, milestone billing with retention, and field work from the phone.' },
]

const COMPLIANCE = [
  'Invoices under the EOPT Act, with VAT shown separately and numbers that never skip',
  'VAT, percentage tax and expanded withholding, with Form 2307 and the summary lists',
  'Books of accounts, trial balance, profit and loss, balance sheet',
  'Payroll on the current SSS, PhilHealth and Pag-IBIG tables and TRAIN withholding tax',
  '1601-C, 2316, R-3, RF-1 and the Pag-IBIG list, ready each month',
  'Holidays and premium pay under the Labor Code; regional minimum wage checks',
  'FDA License to Operate and product registration; PCAB licence and category',
  'Data Privacy Act: encrypted ID numbers, a data protection officer, an audit log',
]

const PHONE: { icon: LucideIcon; text: string }[] = [
  { icon: MapPin, text: 'Clock in and out, with where you were' },
  { icon: Wallet, text: 'Payslips the moment payroll is posted' },
  { icon: ClipboardList, text: 'Ask for leave; managers approve it on the spot' },
  { icon: ScanBarcode, text: 'Scan a barcode to look up and count stock' },
  { icon: Clock, text: 'Field tasks: start, update, log hours, mark done on site' },
]

const TRUST: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: Lock, title: 'Posted means final', text: 'Posted invoices, entries, payroll and stock moves can’t be changed, even in the database. Mistakes are voided or reversed, and the original stays.' },
  { icon: ShieldCheck, title: 'Roles and an audit log', text: 'Every screen and every API call checks what the person’s role allows. Every change is logged with who, when, and what it was before.' },
  { icon: BadgeCheck, title: 'The books always agree', text: 'Stock, production, payroll and projects each post their own entries, so the stock valuation equals the Inventory account to the centavo.' },
]

function Section({ id, eyebrow, title, children, className }: { id?: string; eyebrow: string; title: string; children: React.ReactNode; className?: string }) {
  return (
    <section id={id} className={`mx-auto w-full max-w-6xl px-4 py-16 md:px-8 md:py-24 ${className ?? ''}`}>
      <p className="text-muted-foreground mb-2 text-sm font-medium tracking-wide uppercase">{eyebrow}</p>
      <h2 className="mb-10 max-w-3xl text-3xl font-semibold tracking-tight text-balance md:text-4xl">{title}</h2>
      {children}
    </section>
  )
}

export function LandingPage() {
  return (
    <div className="bg-background min-h-svh">
      <header className="bg-background/90 supports-[backdrop-filter]:bg-background/70 sticky top-0 z-30 border-b backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 md:px-8">
          <Brand />
          <nav className="text-muted-foreground hidden gap-5 text-sm md:flex" aria-label="On this page">
            <a href="#modules" className="hover:text-foreground">
              Modules
            </a>
            <a href="#philippines" className="hover:text-foreground">
              Philippine rules
            </a>
            <a href="#industries" className="hover:text-foreground">
              Industries
            </a>
            <a href="#phone" className="hover:text-foreground">
              Phone app
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" asChild>
              <Link to="/sign-in">Sign in</Link>
            </Button>
            <Button asChild>
              <Link to="/demo">Try the demo</Link>
            </Button>
          </div>
        </div>
      </header>

      <main>
        <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 pt-16 pb-12 md:px-8 md:pt-24 lg:grid-cols-[1.05fr_1fr]">
          <div className="space-y-6">
            <p className="text-muted-foreground inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs">
              <span className="bg-success size-1.5 rounded-full" />
              Made for Philippine businesses, on the web and the phone
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-balance md:text-6xl">One system for running a Philippine business.</h1>
            <p className="text-muted-foreground max-w-xl text-lg text-pretty">
              Books that follow BIR rules, payroll with SSS, PhilHealth and Pag-IBIG built in, stock by lot and expiry, sales, production and projects. Set up for your industry
              in a minute.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button size="lg" asChild>
                <Link to="/demo">
                  Try the demo
                  <ArrowRight />
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link to="/sign-up">Create an account</Link>
              </Button>
            </div>
            <p className="text-muted-foreground text-sm">The demo is a food distributor three months into the year: its own copy, yours until 3 a.m. No sign-up.</p>
          </div>
          <figure className="bg-muted/40 overflow-hidden rounded-xl border shadow-sm">
            <img src="/landing/dashboard.jpg" alt="The dashboard of the demo business: cash, receivables, what needs attention, and income and expenses by month" className="block w-full" width={1280} height={860} />
          </figure>
        </section>

        <Section id="modules" eyebrow="Everything in one place" title="Six modules that share one set of books.">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {MODULES.map(({ icon: Icon, title, text }) => (
              <div key={title} className="rounded-xl border p-5">
                <span className="bg-secondary mb-4 grid size-10 place-items-center rounded-lg">
                  <Icon className="size-5" />
                </span>
                <h3 className="mb-1.5 font-semibold">{title}</h3>
                <p className="text-muted-foreground text-sm">{text}</p>
              </div>
            ))}
          </div>
        </Section>

        <div className="bg-sidebar border-y">
          <Section id="philippines" eyebrow="Built for the Philippines" title="The rules are in the software, not in a spreadsheet beside it.">
            <div className="grid gap-10 lg:grid-cols-[1fr_1fr]">
              <ul className="grid gap-3">
                {COMPLIANCE.map((c) => (
                  <li key={c} className="flex gap-3 text-sm">
                    <BadgeCheck className="text-success mt-0.5 size-4 shrink-0" />
                    {c}
                  </li>
                ))}
              </ul>
              <figure className="bg-background self-start overflow-hidden rounded-xl border shadow-sm">
                <img src="/landing/payroll.jpg" alt="A payroll run with SSS, PhilHealth, Pag-IBIG and withholding tax for each employee" className="block w-full" width={1280} height={860} loading="lazy" />
              </figure>
            </div>
            <p className="text-muted-foreground mt-8 text-xs">Government rates are kept as data with the date each applies from, so a new circular is an update, not a rewrite.</p>
          </Section>
        </div>

        <Section id="industries" eyebrow="Set up for your industry" title="Pick your kind of business. The accounts, units, fields and rules come with it.">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {TEMPLATES.filter((t) => t.key !== 'general').map((t) => (
              <div key={t.key} className="rounded-xl border p-5">
                <h3 className="mb-2 font-semibold">{t.name}</h3>
                <ul className="text-muted-foreground grid gap-1.5 text-sm">
                  {t.highlights.slice(0, 3).map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>

        <div className="bg-sidebar border-y">
          <Section id="phone" eyebrow="The phone app" title="The warehouse, the field and the payslip, in everyone’s pocket.">
            <div className="grid items-center gap-10 lg:grid-cols-[1fr_1fr]">
              <ul className="grid gap-4">
                {PHONE.map(({ icon: Icon, text }) => (
                  <li key={text} className="flex items-center gap-3">
                    <span className="bg-background grid size-9 shrink-0 place-items-center rounded-lg border">
                      <Icon className="size-4" />
                    </span>
                    {text}
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-4 rounded-xl border p-6">
                <Smartphone className="text-muted-foreground size-10 shrink-0" />
                <p className="text-muted-foreground text-sm">
                  Android, with push notifications for payslips, leave decisions and new tasks. The demo’s yellow bar shows the email and password that open the same demo business on the
                  phone: clock in there, and watch it appear on the web.
                </p>
              </div>
            </div>
          </Section>
        </div>

        <Section eyebrow="Built to be trusted" title="Accounting you can show an auditor.">
          <div className="grid gap-4 md:grid-cols-3">
            {TRUST.map(({ icon: Icon, title, text }) => (
              <div key={title} className="rounded-xl border p-5">
                <Icon className="mb-3 size-5" />
                <h3 className="mb-1.5 font-semibold">{title}</h3>
                <p className="text-muted-foreground text-sm">{text}</p>
              </div>
            ))}
          </div>
        </Section>

        <section className="mx-auto w-full max-w-6xl px-4 pb-20 md:px-8">
          <div className="bg-primary text-primary-foreground flex flex-col items-start gap-5 rounded-2xl px-6 py-10 md:flex-row md:items-center md:justify-between md:px-10">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">See it with real numbers.</h2>
              <p className="text-primary-foreground/75 mt-1">Three months of a food distributor’s business: sales, stock, production, payroll and projects.</p>
            </div>
            <Button size="lg" variant="secondary" asChild>
              <Link to="/demo">
                Try the demo
                <ArrowRight />
              </Link>
            </Button>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="text-muted-foreground mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-sm md:px-8">
          <Brand />
          <p>Demo – not registered with the BIR. A showcase, not yet a commercial product.</p>
          <div className="flex gap-4">
            <Link to="/sign-in" className="hover:text-foreground">
              Sign in
            </Link>
            <Link to="/sign-up" className="hover:text-foreground">
              Create an account
            </Link>
          </div>
        </div>
      </footer>
    </div>
  )
}
