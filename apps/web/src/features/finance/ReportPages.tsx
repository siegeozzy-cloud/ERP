import { BOOK_LABELS, formatPeso, formatRate, JOURNAL_SOURCE_LABELS, type BookName, type StatementSection } from '@erp/shared'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronRight, Download, Printer } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useWorkspace } from '@/features/workspaces/queries'
import { formatDate, formatMonth, formatQuarter, monthStart, recentQuarters, today, yearStart } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { csvAmount, downloadCsv, LoadError, Loading, Money } from './components'
import { financeQueries, reportQueries } from './queries'

/* =============================================================================================
 * The list of reports
 * =========================================================================================== */

type ReportInfo = { slug: string; title: string; description: string; vatOnly?: boolean; nonVatOnly?: boolean }

const GROUPS: { title: string; reports: ReportInfo[] }[] = [
  {
    title: 'Financial statements',
    reports: [
      { slug: 'profit-and-loss', title: 'Profit and loss', description: 'Income less expenses for a period.' },
      { slug: 'balance-sheet', title: 'Balance sheet', description: 'What the business owns and owes on a date.' },
      { slug: 'trial-balance', title: 'Trial balance', description: 'Every account’s balance; debits equal credits.' },
      { slug: 'general-ledger', title: 'General ledger', description: 'One account’s entries with a running balance.' },
    ],
  },
  {
    title: 'Books of accounts',
    reports: [
      { slug: 'general-journal', title: 'General journal', description: 'Every posted entry, in date order.' },
      { slug: 'cash-receipts', title: 'Cash receipts book', description: 'Money that came into cash and bank accounts.' },
      { slug: 'cash-disbursements', title: 'Cash disbursements book', description: 'Money that went out of them.' },
    ],
  },
  {
    title: 'BIR',
    reports: [
      { slug: 'vat', title: 'VAT (2550Q)', description: 'Output VAT on sales less input VAT on purchases.', vatOnly: true },
      { slug: 'percentage-tax', title: 'Percentage tax (2551Q)', description: '3% of gross sales, for non-VAT businesses.', nonVatOnly: true },
      { slug: 'withholding', title: 'Expanded withholding (1601-EQ, QAP)', description: 'Tax withheld from suppliers, by ATC and by payee.' },
      { slug: 'form-2307', title: 'Form 2307', description: 'Certificate of tax withheld, for each supplier.' },
      { slug: 'slsp-sales', title: 'Summary list of sales', description: 'Sales by customer for the quarter.' },
      { slug: 'slsp-purchases', title: 'Summary list of purchases', description: 'Purchases by supplier for the quarter.' },
    ],
  },
]

export const REPORT_SLUGS = GROUPS.flatMap((g) => g.reports.map((r) => r.slug))
const infoOf = (slug: string) => GROUPS.flatMap((g) => g.reports).find((r) => r.slug === slug)

export function ReportsIndexPage() {
  const workspace = useWorkspace()
  return (
    <div className="space-y-8">
      {GROUPS.map((g) => (
        <section key={g.title} className="space-y-3">
          <h2 className="text-lg font-semibold">{g.title}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {g.reports
              .filter((r) => !(r.vatOnly && workspace.vatStatus !== 'vat') && !(r.nonVatOnly && workspace.vatStatus !== 'non_vat'))
              .map((r) => (
                <Link
                  key={r.slug}
                  to="/w/$workspaceId/finance/reports/$report"
                  params={{ workspaceId: workspace.id, report: r.slug }}
                  className="group focus-visible:ring-ring/50 rounded-xl outline-none focus-visible:ring-[3px]"
                >
                  <Card className="group-hover:border-foreground/20 h-full gap-1 py-4 transition-colors">
                    <CardHeader className="px-4">
                      <CardTitle className="flex items-center justify-between text-base">
                        {r.title}
                        <ChevronRight className="text-muted-foreground size-4" />
                      </CardTitle>
                      <CardDescription>{r.description}</CardDescription>
                    </CardHeader>
                  </Card>
                </Link>
              ))}
          </div>
        </section>
      ))}
    </div>
  )
}

/* =============================================================================================
 * Shared pieces
 * =========================================================================================== */

/** Title, the period controls, and print. The header prints too, so a printout says what it is. */
function ReportFrame({ slug, subtitle, controls, actions, children }: { slug: string; subtitle: string; controls: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const workspace = useWorkspace()
  const info = infoOf(slug)
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        {controls}
        <div className="ml-auto flex gap-2">
          {actions}
          <Button variant="outline" onClick={() => window.print()}>
            <Printer />
            Print
          </Button>
        </div>
      </div>
      <div className="space-y-0.5">
        <p className="text-muted-foreground text-sm">
          {workspace.name} · TIN {workspace.tin}
        </p>
        <h2 className="text-2xl font-semibold tracking-tight">{info?.title}</h2>
        <p className="text-muted-foreground text-sm">{subtitle}</p>
      </div>
      {children}
      <p className="text-muted-foreground hidden text-xs print:block">Demo – not registered with the BIR. Printed {formatDate(today())}.</p>
    </div>
  )
}

function DateField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-muted-foreground text-xs">
        {label}
      </Label>
      <Input id={id} type="date" className="w-40" value={value} onChange={(e) => e.target.value && onChange(e.target.value)} />
    </div>
  )
}

function QuarterField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor="quarter" className="text-muted-foreground text-xs">
        Quarter
      </Label>
      <NativeSelect id="quarter" className="w-52" value={value} onChange={(e) => onChange(e.target.value)}>
        {recentQuarters().map((q) => (
          <option key={q} value={q}>
            {formatQuarter(q)}
          </option>
        ))}
      </NativeSelect>
    </div>
  )
}

/** Shows the report, or why it isn't there. */
function Body<T>({ query, children }: { query: { data?: T; error: Error | null }; children: (data: T) => ReactNode }) {
  if (query.error) return <LoadError error={query.error} />
  if (query.data === undefined) return <Loading />
  return <>{children(query.data)}</>
}

function Section({ section, sign = 1 }: { section: StatementSection; sign?: 1 | -1 }) {
  return (
    <>
      <TableRow className="hover:bg-transparent">
        <TableCell colSpan={2} className="pt-5 font-semibold">
          {section.title}
        </TableCell>
      </TableRow>
      {section.rows.length === 0 && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={2} className="text-muted-foreground pl-6">
            Nothing yet
          </TableCell>
        </TableRow>
      )}
      {section.rows.map((r) => (
        <TableRow key={r.id}>
          <TableCell className="pl-6">
            {r.code && <span className="text-muted-foreground mr-2 tabular-nums">{r.code}</span>}
            {r.name}
          </TableCell>
          <TableCell className="text-right">
            <Money value={sign * r.amount} />
          </TableCell>
        </TableRow>
      ))}
      <TableRow className="hover:bg-transparent">
        <TableCell className="font-medium">Total {section.title.toLowerCase()}</TableCell>
        <TableCell className="border-t text-right font-medium">
          <Money value={sign * section.total} />
        </TableCell>
      </TableRow>
    </>
  )
}

function Bordered({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border print:border-0">{children}</div>
}

/* =============================================================================================
 * The reports
 * =========================================================================================== */

export function ReportPage({ report }: { report: string }) {
  switch (report) {
    case 'trial-balance':
      return <TrialBalanceReport />
    case 'profit-and-loss':
      return <ProfitAndLossReport />
    case 'balance-sheet':
      return <BalanceSheetReport />
    case 'general-ledger':
      return <GeneralLedgerReport />
    case 'general-journal':
    case 'cash-receipts':
    case 'cash-disbursements':
      return <BookReport book={report} />
    case 'vat':
      return <VatReport />
    case 'percentage-tax':
      return <PercentageTaxReport />
    case 'withholding':
      return <WithholdingReport />
    case 'form-2307':
      return <Form2307Report />
    case 'slsp-sales':
      return <SlspReport kind="sales" />
    case 'slsp-purchases':
      return <SlspReport kind="purchases" />
    default:
      return <p className="text-muted-foreground py-10 text-center text-sm">There’s no report by that name.</p>
  }
}

function TrialBalanceReport() {
  const { id } = useWorkspace()
  const [asOf, setAsOf] = useState(today())
  const q = useQuery(reportQueries.trialBalance(id, asOf))
  return (
    <ReportFrame slug="trial-balance" subtitle={`As of ${formatDate(asOf)}`} controls={<DateField id="asOf" label="As of" value={asOf} onChange={setAsOf} />}>
      <Body query={q}>
        {(r) => (
          <Bordered>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.rows.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="min-w-56">
                      <span className="text-muted-foreground mr-2 tabular-nums">{a.code}</span>
                      {a.name}
                    </TableCell>
                    <TableCell className="text-right">{a.balance > 0 && <Money value={a.balance} />}</TableCell>
                    <TableCell className="text-right">{a.balance < 0 && <Money value={-a.balance} />}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell>{r.totalDebit === r.totalCredit ? 'Total — balanced' : 'Total — does not balance'}</TableCell>
                  <TableCell className="text-right">
                    <Money value={r.totalDebit} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={r.totalCredit} />
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </Bordered>
        )}
      </Body>
    </ReportFrame>
  )
}

function ProfitAndLossReport() {
  const { id } = useWorkspace()
  const [from, setFrom] = useState(yearStart(today()))
  const [to, setTo] = useState(today())
  const q = useQuery(reportQueries.profitAndLoss(id, from, to))
  return (
    <ReportFrame
      slug="profit-and-loss"
      subtitle={`${formatDate(from)} to ${formatDate(to)}`}
      controls={
        <>
          <DateField id="from" label="From" value={from} onChange={setFrom} />
          <DateField id="to" label="To" value={to} onChange={setTo} />
        </>
      }
    >
      <Body query={q}>
        {(r) => (
          <Bordered>
            <Table>
              <TableBody>
                <Section section={r.income} />
                <Section section={r.expenses} />
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell>{r.netIncome >= 0 ? 'Net income' : 'Net loss'}</TableCell>
                  <TableCell className="text-right">
                    <Money value={r.netIncome} />
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </Bordered>
        )}
      </Body>
    </ReportFrame>
  )
}

function BalanceSheetReport() {
  const { id } = useWorkspace()
  const [asOf, setAsOf] = useState(today())
  const q = useQuery(reportQueries.balanceSheet(id, asOf))
  return (
    <ReportFrame slug="balance-sheet" subtitle={`As of ${formatDate(asOf)}`} controls={<DateField id="asOf" label="As of" value={asOf} onChange={setAsOf} />}>
      <Body query={q}>
        {(r) => (
          <>
            {!r.balanced && (
              <Alert variant="destructive">
                <AlertDescription>Assets don’t equal liabilities plus equity. Check the trial balance.</AlertDescription>
              </Alert>
            )}
            <Bordered>
              <Table>
                <TableBody>
                  <Section section={r.assets} />
                  <Section section={r.liabilities} />
                  <Section section={r.equity} />
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell>Total liabilities and equity</TableCell>
                    <TableCell className="text-right">
                      <Money value={r.liabilities.total + r.equity.total} />
                    </TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </Bordered>
          </>
        )}
      </Body>
    </ReportFrame>
  )
}

function GeneralLedgerReport() {
  const workspace = useWorkspace()
  const accounts = useQuery(financeQueries.accounts(workspace.id))
  const [accountId, setAccountId] = useState('')
  const [from, setFrom] = useState(yearStart(today()))
  const [to, setTo] = useState(today())
  const chosen = accountId || accounts.data?.find((a) => a.systemKey === 'bank')?.id || ''
  const q = useQuery(reportQueries.generalLedger(workspace.id, chosen, from, to))
  return (
    <ReportFrame
      slug="general-ledger"
      subtitle={q.data ? `${q.data.account.code} ${q.data.account.name} · ${formatDate(from)} to ${formatDate(to)}` : ''}
      controls={
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="gl-account" className="text-muted-foreground text-xs">
              Account
            </Label>
            <NativeSelect id="gl-account" className="w-64" value={chosen} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.data?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <DateField id="from" label="From" value={from} onChange={setFrom} />
          <DateField id="to" label="To" value={to} onChange={setTo} />
        </>
      }
    >
      <Body query={q}>
        {(r) => (
          <Bordered>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Entry</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground">
                    Opening balance
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={r.opening} />
                  </TableCell>
                </TableRow>
                {r.rows.map((row, i) => (
                  <TableRow key={`${row.entryId}-${i}`}>
                    <TableCell className="whitespace-nowrap">{formatDate(row.date)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Link to="/w/$workspaceId/finance/journal/$id" params={{ workspaceId: workspace.id, id: row.entryId }} className="hover:underline">
                        {row.number}
                      </Link>
                    </TableCell>
                    <TableCell className="min-w-56">{row.memo}</TableCell>
                    <TableCell className="text-right">{row.debit > 0 && <Money value={row.debit} />}</TableCell>
                    <TableCell className="text-right">{row.credit > 0 && <Money value={row.credit} />}</TableCell>
                    <TableCell className="text-right">
                      <Money value={row.balance} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={5}>Closing balance</TableCell>
                  <TableCell className="text-right">
                    <Money value={r.closing} />
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </Bordered>
        )}
      </Body>
    </ReportFrame>
  )
}

function BookReport({ book }: { book: BookName }) {
  const workspace = useWorkspace()
  const [from, setFrom] = useState(monthStart(today()))
  const [to, setTo] = useState(today())
  const q = useQuery(reportQueries.book(workspace.id, book, from, to))
  return (
    <ReportFrame
      slug={book}
      subtitle={`${BOOK_LABELS[book]} · ${formatDate(from)} to ${formatDate(to)}`}
      controls={
        <>
          <DateField id="from" label="From" value={from} onChange={setFrom} />
          <DateField id="to" label="To" value={to} onChange={setTo} />
        </>
      }
    >
      <Body query={q}>
        {(entries) =>
          entries.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-sm">No entries in this period.</p>
          ) : (
            <Bordered>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Entry</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead className="text-right">Debit</TableHead>
                    <TableHead className="text-right">Credit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((e) => (
                    <BookRows key={e.id} entry={e} workspaceId={workspace.id} />
                  ))}
                </TableBody>
              </Table>
            </Bordered>
          )
        }
      </Body>
    </ReportFrame>
  )
}

function BookRows({ entry: e, workspaceId }: { entry: import('@erp/shared').BookEntry; workspaceId: string }) {
  return (
    <>
      <TableRow className="bg-muted/30 hover:bg-muted/30">
        <TableCell className="whitespace-nowrap">{formatDate(e.date)}</TableCell>
        <TableCell className="whitespace-nowrap">
          <Link to="/w/$workspaceId/finance/journal/$id" params={{ workspaceId, id: e.id }} className="font-medium hover:underline">
            {e.number}
          </Link>
        </TableCell>
        <TableCell colSpan={3} className="text-muted-foreground min-w-56">
          {e.memo} <span className="text-xs">· {JOURNAL_SOURCE_LABELS[e.source]}</span>
        </TableCell>
      </TableRow>
      {e.lines.map((l) => (
        <TableRow key={l.id}>
          <TableCell colSpan={2} />
          <TableCell className={cn(l.credit > 0 && 'pl-8')}>
            <span className="text-muted-foreground mr-2 tabular-nums">{l.account.code}</span>
            {l.account.name}
          </TableCell>
          <TableCell className="text-right">{l.debit > 0 && <Money value={l.debit} />}</TableCell>
          <TableCell className="text-right">{l.credit > 0 && <Money value={l.credit} />}</TableCell>
        </TableRow>
      ))}
    </>
  )
}

function VatReport() {
  const { id } = useWorkspace()
  const [quarter, setQuarter] = useState(recentQuarters()[0]!)
  const q = useQuery(reportQueries.vat(id, quarter))
  const cols = [
    ['vatableSales', 'VATable sales'],
    ['zeroRatedSales', 'Zero-rated sales'],
    ['exemptSales', 'Exempt sales'],
    ['outputVat', 'Output VAT'],
    ['vatablePurchases', 'VATable purchases'],
    ['inputVat', 'Input VAT'],
  ] as const
  return (
    <ReportFrame slug="vat" subtitle={formatQuarter(quarter)} controls={<QuarterField value={quarter} onChange={setQuarter} />}>
      <Body query={q}>
        {(r) => (
          <>
            <Bordered>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead>
                    {cols.map(([, label]) => (
                      <TableHead key={label} className="text-right">
                        {label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.months.map((m) => (
                    <TableRow key={m.month}>
                      <TableCell className="whitespace-nowrap">{formatMonth(m.month)}</TableCell>
                      {cols.map(([key]) => (
                        <TableCell key={key} className="text-right">
                          <Money value={m[key]} />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell>Quarter</TableCell>
                    {cols.map(([key]) => (
                      <TableCell key={key} className="text-right">
                        <Money value={r.totals[key]} />
                      </TableCell>
                    ))}
                  </TableRow>
                </TableFooter>
              </Table>
            </Bordered>
            <Card className="max-w-md">
              <CardContent className="grid gap-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Output VAT</span>
                  <span className="tabular-nums">{formatPeso(r.totals.outputVat)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Less input VAT</span>
                  <span className="tabular-nums">{formatPeso(-r.totals.inputVat)}</span>
                </div>
                <div className="flex justify-between border-t pt-2 text-base font-semibold">
                  <span>{r.vatPayable >= 0 ? 'VAT payable' : 'Excess input VAT (carry over)'}</span>
                  <span className="tabular-nums">{formatPeso(Math.abs(r.vatPayable))}</span>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </Body>
    </ReportFrame>
  )
}

function PercentageTaxReport() {
  const { id } = useWorkspace()
  const [quarter, setQuarter] = useState(recentQuarters()[0]!)
  const q = useQuery(reportQueries.percentageTax(id, quarter))
  return (
    <ReportFrame slug="percentage-tax" subtitle={formatQuarter(quarter)} controls={<QuarterField value={quarter} onChange={setQuarter} />}>
      <Body query={q}>
        {(r) => (
          <Bordered>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead className="text-right">Gross sales</TableHead>
                  <TableHead className="text-right">Tax at {formatRate(r.rateBp)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.months.map((m) => (
                  <TableRow key={m.month}>
                    <TableCell>{formatMonth(m.month)}</TableCell>
                    <TableCell className="text-right">
                      <Money value={m.grossSales} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money value={m.tax} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell>Percentage tax due</TableCell>
                  <TableCell className="text-right">
                    <Money value={r.grossSales} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={r.tax} />
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </Bordered>
        )}
      </Body>
    </ReportFrame>
  )
}

function WithholdingReport() {
  const { id } = useWorkspace()
  const [quarter, setQuarter] = useState(recentQuarters()[0]!)
  const q = useQuery(reportQueries.withholding(id, quarter))
  const exportQap = () => {
    const r = q.data
    if (!r) return
    downloadCsv(
      `QAP-${quarter}.csv`,
      ['TIN', 'Payee', 'ATC', 'Rate', 'Income payment', 'Tax withheld'],
      r.payees.flatMap((p) => p.rows.map((row) => [p.tin, p.name, row.atc, row.rateBp / 100, csvAmount(row.incomePayment), csvAmount(row.taxWithheld)])),
    )
  }
  return (
    <ReportFrame
      slug="withholding"
      subtitle={formatQuarter(quarter)}
      controls={<QuarterField value={quarter} onChange={setQuarter} />}
      actions={
        <Button variant="outline" onClick={exportQap} disabled={!q.data?.payees.length}>
          <Download />
          QAP (CSV)
        </Button>
      }
    >
      <Body query={q}>
        {(r) => (
          <>
            <h3 className="font-semibold">By ATC (1601-EQ)</h3>
            <Bordered>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ATC</TableHead>
                    <TableHead>Nature of payment</TableHead>
                    <TableHead className="text-right">Rate</TableHead>
                    <TableHead className="text-right">Tax base</TableHead>
                    <TableHead className="text-right">Tax withheld</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.byAtc.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-muted-foreground text-center">
                        No tax withheld this quarter.
                      </TableCell>
                    </TableRow>
                  )}
                  {r.byAtc.map((row) => (
                    <TableRow key={`${row.atc}-${row.rateBp}`}>
                      <TableCell className="font-medium">{row.atc}</TableCell>
                      <TableCell className="min-w-56">{row.description}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatRate(row.rateBp)}</TableCell>
                      <TableCell className="text-right">
                        <Money value={row.incomePayment} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money value={row.taxWithheld} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={4}>Total tax withheld</TableCell>
                    <TableCell className="text-right">
                      <Money value={r.totalWithheld} />
                    </TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </Bordered>
            <h3 className="font-semibold">By payee (QAP)</h3>
            <Bordered>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>TIN</TableHead>
                    <TableHead>Payee</TableHead>
                    <TableHead>ATC</TableHead>
                    <TableHead className="text-right">Tax base</TableHead>
                    <TableHead className="text-right">Tax withheld</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.payees.flatMap((p) =>
                    p.rows.map((row) => (
                      <TableRow key={`${p.supplierId}-${row.atc}-${row.rateBp}`}>
                        <TableCell className="whitespace-nowrap tabular-nums">{p.tin ?? '—'}</TableCell>
                        <TableCell className="min-w-48">{p.name}</TableCell>
                        <TableCell>{row.atc}</TableCell>
                        <TableCell className="text-right">
                          <Money value={row.incomePayment} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Money value={row.taxWithheld} />
                        </TableCell>
                      </TableRow>
                    )),
                  )}
                </TableBody>
              </Table>
            </Bordered>
          </>
        )}
      </Body>
    </ReportFrame>
  )
}

function Form2307Report() {
  const workspace = useWorkspace()
  const suppliers = useQuery(financeQueries.contacts(workspace.id, 'supplier'))
  const [quarter, setQuarter] = useState(recentQuarters()[0]!)
  const [supplierId, setSupplierId] = useState('')
  const chosen = supplierId || suppliers.data?.[0]?.id || ''
  const q = useQuery(reportQueries.form2307(workspace.id, quarter, chosen))
  return (
    <ReportFrame
      slug="form-2307"
      subtitle={`Certificate of Creditable Tax Withheld at Source · ${formatQuarter(quarter)}`}
      controls={
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="supplier" className="text-muted-foreground text-xs">
              Supplier
            </Label>
            <NativeSelect id="supplier" className="w-64" value={chosen} onChange={(e) => setSupplierId(e.target.value)}>
              {suppliers.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <QuarterField value={quarter} onChange={setQuarter} />
        </>
      }
    >
      {!chosen ? (
        <p className="text-muted-foreground py-6 text-center text-sm">Add a supplier first.</p>
      ) : (
        <Body query={q}>
          {(r) => (
            <div className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <Party title="Payee (supplier)" party={r.payee} />
                <Party title="Payor (withholding agent)" party={r.payor} />
              </div>
              <p className="text-sm">
                Period: {formatDate(r.periodFrom)} to {formatDate(r.periodTo)}
              </p>
              <Bordered>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Income payment</TableHead>
                      <TableHead>ATC</TableHead>
                      <TableHead className="text-right">1st month</TableHead>
                      <TableHead className="text-right">2nd month</TableHead>
                      <TableHead className="text-right">3rd month</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Tax withheld</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {r.rows.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={7} className="text-muted-foreground text-center">
                          Nothing was withheld from this supplier this quarter.
                        </TableCell>
                      </TableRow>
                    )}
                    {r.rows.map((row) => (
                      <TableRow key={`${row.atc}-${row.rateBp}`}>
                        <TableCell className="min-w-48">{row.description}</TableCell>
                        <TableCell>{row.atc}</TableCell>
                        {row.months.map((m, i) => (
                          <TableCell key={i} className="text-right">
                            <Money value={m} />
                          </TableCell>
                        ))}
                        <TableCell className="text-right">
                          <Money value={row.incomePayment} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Money value={row.taxWithheld} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell colSpan={5}>Total</TableCell>
                      <TableCell className="text-right">
                        <Money value={r.totalIncome} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money value={r.totalWithheld} />
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </Bordered>
            </div>
          )}
        </Body>
      )}
    </ReportFrame>
  )
}

function Party({ title, party }: { title: string; party: { name: string; tin: string | null; address: string | null } }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4">
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-base">{party.name}</CardTitle>
        <p className="text-sm tabular-nums">TIN {party.tin ?? 'not on file'}</p>
        {party.address && <p className="text-muted-foreground text-sm whitespace-pre-line">{party.address}</p>}
      </CardHeader>
    </Card>
  )
}

function SlspReport({ kind }: { kind: 'sales' | 'purchases' }) {
  const { id } = useWorkspace()
  const [quarter, setQuarter] = useState(recentQuarters()[0]!)
  const q = useQuery(reportQueries.slsp(id, quarter, kind))
  const cols = [
    ['exempt', 'Exempt'],
    ['zeroRated', 'Zero-rated'],
    ['vatable', 'Taxable'],
    ['nonVat', 'Non-VAT'],
    ['vat', kind === 'sales' ? 'Output VAT' : 'Input VAT'],
    ['gross', 'Gross'],
  ] as const
  const exportCsv = () => {
    const r = q.data
    if (!r) return
    downloadCsv(
      `SLSP-${kind}-${quarter}.csv`,
      ['TIN', kind === 'sales' ? 'Customer' : 'Supplier', ...cols.map(([, l]) => l)],
      r.rows.map((row) => [row.tin, row.name, ...cols.map(([k]) => csvAmount(row[k]))]),
    )
  }
  return (
    <ReportFrame
      slug={`slsp-${kind}`}
      subtitle={formatQuarter(quarter)}
      controls={<QuarterField value={quarter} onChange={setQuarter} />}
      actions={
        <Button variant="outline" onClick={exportCsv} disabled={!q.data?.rows.length}>
          <Download />
          CSV
        </Button>
      }
    >
      <Body query={q}>
        {(r) => (
          <Bordered>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>TIN</TableHead>
                  <TableHead>{kind === 'sales' ? 'Customer' : 'Supplier'}</TableHead>
                  {cols.map(([, label]) => (
                    <TableHead key={label} className="text-right">
                      {label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-muted-foreground text-center">
                      Nothing posted this quarter.
                    </TableCell>
                  </TableRow>
                )}
                {r.rows.map((row) => (
                  <TableRow key={row.contactId}>
                    <TableCell className="whitespace-nowrap tabular-nums">{row.tin ?? '—'}</TableCell>
                    <TableCell className="min-w-48">{row.name}</TableCell>
                    {cols.map(([key]) => (
                      <TableCell key={key} className="text-right">
                        <Money value={row[key]} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={2}>Total</TableCell>
                  {cols.map(([key]) => (
                    <TableCell key={key} className="text-right">
                      <Money value={r.totals[key]} />
                    </TableCell>
                  ))}
                </TableRow>
              </TableFooter>
            </Table>
          </Bordered>
        )}
      </Body>
    </ReportFrame>
  )
}
