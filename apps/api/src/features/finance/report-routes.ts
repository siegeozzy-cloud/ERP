import {
  applyRate,
  BOOKS,
  CASH_SUBTYPES,
  isDebitNormal,
  quarterRange,
  quarterSchema,
  type AccountBalance,
  type BalanceSheet,
  type BookEntry,
  type FinanceOverview,
  type Form2307,
  type GeneralLedger,
  type PercentageTaxReturn,
  type ProfitAndLoss,
  type Slsp,
  type SlspRow,
  type StatementSection,
  type TrialBalance,
  type VatReturn,
  type WithholdingReturn,
  type WithholdingRow,
} from '@erp/shared'
import { and, asc, eq, gt, gte, inArray, lt, lte, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client.ts'
import { accounts, bills, contacts, documentLines, journalEntries, journalLines, payments, salesInvoices, taxCodes, type WorkspaceRow } from '../../db/schema.ts'
import { HttpError, parse } from '../../lib/errors.ts'
import { needs, workspaceOf } from '../../lib/workspace.ts'
import { settledSql } from './documents.ts'
import { entriesWithLines } from './journal-routes.ts'
import { PERCENTAGE_TAX_CODE, taxRateOn, todayInManila } from './ledger.ts'

// Every report reads posted journal entries (or posted documents, for the BIR summaries) only.
// Drafts and void documents never count.

const isoDate = z.iso.date()
const sum = (col: unknown) => sql<number>`coalesce(sum(${col}), 0)::bigint`.mapWith(Number)

/** The first day of the fiscal year `date` falls in. */
function fiscalYearStart(ws: WorkspaceRow, date: string) {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const startYear = month >= ws.fiscalYearStartMonth ? year : year - 1
  return `${startYear}-${String(ws.fiscalYearStartMonth).padStart(2, '0')}-01`
}

/** Debits and credits per account from posted entries, between two dates (`from` left out: since the start). */
async function balances(workspaceId: string, to: string, from?: string) {
  const rows = await db
    .select({ accountId: journalLines.accountId, debit: sum(journalLines.debit), credit: sum(journalLines.credit) })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(eq(journalLines.workspaceId, workspaceId), eq(journalEntries.status, 'posted'), from ? gte(journalEntries.date, from) : undefined, lte(journalEntries.date, to)))
    .groupBy(journalLines.accountId)
  return new Map(rows.map((r) => [r.accountId, r]))
}

async function accountBalances(workspaceId: string, to: string, from?: string): Promise<AccountBalance[]> {
  const [all, sums] = await Promise.all([db.select().from(accounts).where(eq(accounts.workspaceId, workspaceId)).orderBy(asc(accounts.code)), balances(workspaceId, to, from)])
  return all.map((a) => {
    const s = sums.get(a.id)
    const debit = s?.debit ?? 0
    const credit = s?.credit ?? 0
    return { id: a.id, code: a.code, name: a.name, type: a.type, debit, credit, balance: debit - credit }
  })
}

/** A statement section: accounts of some types, each shown with the sign its type normally has. */
function section(title: string, rows: AccountBalance[], types: AccountBalance['type'][]): StatementSection {
  const picked = rows
    .filter((r) => types.includes(r.type) && (r.debit !== 0 || r.credit !== 0))
    .map((r) => ({ id: r.id, code: r.code, name: r.name, amount: isDebitNormal(r.type) ? r.balance : -r.balance }))
  return { title, rows: picked, total: picked.reduce((s, r) => s + r.amount, 0) }
}

function quarterOf(query: unknown) {
  const q = parse(z.object({ quarter: quarterSchema }), query)
  return { quarter: q.quarter, ...quarterRange(q.quarter) }
}

const monthSql = (col: unknown) => sql<string>`to_char(${col}, 'YYYY-MM')`

export default async function reportRoutes(app: FastifyInstance) {
  app.get('/reports/overview', needs('finance.view'), async (req): Promise<{ overview: FinanceOverview }> => {
    const ws = workspaceOf(req)
    const today = todayInManila()
    const [all, month] = await Promise.all([accountBalances(ws.id, today), accountBalances(ws.id, today, `${today.slice(0, 7)}-01`)])
    const keyed = await db.select({ id: accounts.id, systemKey: accounts.systemKey, subtype: accounts.subtype }).from(accounts).where(eq(accounts.workspaceId, ws.id))
    const balanceOf = (pred: (a: (typeof keyed)[number]) => boolean) => {
      const ids = new Set(keyed.filter(pred).map((a) => a.id))
      return all.filter((a) => ids.has(a.id)).reduce((s, a) => s + a.balance, 0)
    }
    const overdue = async (kind: 'invoice' | 'bill') => {
      const t = kind === 'invoice' ? salesInvoices : bills
      const settled = settledSql(kind === 'invoice' ? payments.invoiceId : payments.billId, t.id)
      const [row] = await db
        .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
        .from(t)
        .where(and(eq(t.workspaceId, ws.id), eq(t.status, 'posted'), lt(t.dueDate, today), gt(sql`${t.amountDue} - ${settled}`, 0)))
      return row?.n ?? 0
    }
    return {
      overview: {
        cash: balanceOf((a) => (CASH_SUBTYPES as readonly string[]).includes(a.subtype)),
        receivables: balanceOf((a) => a.systemKey === 'ar'),
        payables: -balanceOf((a) => a.systemKey === 'ap'),
        monthToDate: {
          income: month.filter((a) => a.type === 'income').reduce((s, a) => s - a.balance, 0),
          expenses: month.filter((a) => a.type === 'expense').reduce((s, a) => s + a.balance, 0),
        },
        overdueInvoices: await overdue('invoice'),
        overdueBills: await overdue('bill'),
      },
    }
  })

  app.get('/reports/trial-balance', needs('finance.view'), async (req): Promise<{ report: TrialBalance }> => {
    const asOf = parse(z.object({ asOf: isoDate.default(todayInManila()) }), req.query).asOf
    const rows = (await accountBalances(workspaceOf(req).id, asOf)).filter((r) => r.balance !== 0)
    return {
      report: {
        asOf,
        rows,
        totalDebit: rows.reduce((s, r) => s + Math.max(r.balance, 0), 0),
        totalCredit: rows.reduce((s, r) => s + Math.max(-r.balance, 0), 0),
      },
    }
  })

  app.get('/reports/profit-and-loss', needs('finance.view'), async (req): Promise<{ report: ProfitAndLoss }> => {
    const ws = workspaceOf(req)
    const today = todayInManila()
    const q = parse(z.object({ from: isoDate.optional(), to: isoDate.default(today) }), req.query)
    const from = q.from ?? fiscalYearStart(ws, q.to)
    if (from > q.to) throw new HttpError(400, 'invalid', 'The start date is after the end date.', 'from')
    const rows = await accountBalances(ws.id, q.to, from)
    const income = section('Income', rows, ['income'])
    const expenses = section('Expenses', rows, ['expense'])
    return { report: { from, to: q.to, income, expenses, netIncome: income.total - expenses.total } }
  })

  /**
   * There are no year-end closing entries yet, so income less expenses to date is shown inside
   * equity as earnings not yet closed. That's what keeps assets = liabilities + equity.
   */
  app.get('/reports/balance-sheet', needs('finance.view'), async (req): Promise<{ report: BalanceSheet }> => {
    const asOf = parse(z.object({ asOf: isoDate.default(todayInManila()) }), req.query).asOf
    const rows = await accountBalances(workspaceOf(req).id, asOf)
    const assets = section('Assets', rows, ['asset'])
    const liabilities = section('Liabilities', rows, ['liability'])
    const equity = section('Equity', rows, ['equity'])
    const unclosedEarnings = rows.filter((r) => r.type === 'income' || r.type === 'expense').reduce((s, r) => s - r.balance, 0)
    if (unclosedEarnings !== 0) equity.rows.push({ id: 'unclosed', code: '', name: 'Earnings to date, not yet closed', amount: unclosedEarnings })
    equity.total += unclosedEarnings
    return { report: { asOf, assets, liabilities, equity, unclosedEarnings, balanced: assets.total === liabilities.total + equity.total } }
  })

  app.get('/reports/general-ledger', needs('finance.view'), async (req): Promise<{ report: GeneralLedger }> => {
    const ws = workspaceOf(req)
    const today = todayInManila()
    const q = parse(z.object({ accountId: z.uuid('Choose an account.'), from: isoDate.optional(), to: isoDate.default(today) }), req.query)
    const from = q.from ?? fiscalYearStart(ws, q.to)
    const [account] = await db.select().from(accounts).where(and(eq(accounts.id, q.accountId), eq(accounts.workspaceId, ws.id)))
    if (!account) throw new HttpError(404, 'not-found', 'That account doesn’t exist.')
    const sign = isDebitNormal(account.type) ? 1 : -1
    const [before] = await db
      .select({ debit: sum(journalLines.debit), credit: sum(journalLines.credit) })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(and(eq(journalLines.accountId, account.id), eq(journalEntries.status, 'posted'), lt(journalEntries.date, from)))
    const opening = sign * ((before?.debit ?? 0) - (before?.credit ?? 0))
    const lines = await db
      .select({ e: journalEntries, debit: journalLines.debit, credit: journalLines.credit })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(and(eq(journalLines.accountId, account.id), eq(journalEntries.status, 'posted'), gte(journalEntries.date, from), lte(journalEntries.date, q.to)))
      .orderBy(asc(journalEntries.date), asc(journalEntries.number), asc(journalLines.position))
    let running = opening
    const rows = lines.map(({ e, debit, credit }) => {
      running += sign * (debit - credit)
      return { entryId: e.id, number: e.number, date: e.date, memo: e.memo, source: e.source, debit, credit, balance: running }
    })
    return {
      report: {
        account: { id: account.id, code: account.code, name: account.name, type: account.type, subtype: account.subtype, systemKey: account.systemKey, active: account.active },
        from,
        to: q.to,
        opening,
        rows,
        closing: running,
      },
    }
  })

  /**
   * Books of accounts. The general journal is every posted entry; the cash receipts book is entries
   * that put money into a cash or bank account, and the disbursements book those that took it out.
   */
  app.get('/reports/books/:book', needs('finance.view'), async (req): Promise<{ book: string; from: string; to: string; entries: BookEntry[] }> => {
    const { book } = parse(z.object({ book: z.enum(BOOKS) }), req.params)
    const ws = workspaceOf(req)
    const today = todayInManila()
    const q = parse(z.object({ from: isoDate.default(`${today.slice(0, 7)}-01`), to: isoDate.default(today) }), req.query)
    let entryFilter
    if (book !== 'general-journal') {
      const side = book === 'cash-receipts' ? journalLines.debit : journalLines.credit
      entryFilter = inArray(
        journalEntries.id,
        db
          .select({ id: journalLines.entryId })
          .from(journalLines)
          .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
          .where(and(eq(journalLines.workspaceId, ws.id), inArray(accounts.subtype, [...CASH_SUBTYPES]), gt(side, 0))),
      )
    }
    const entries = await db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.workspaceId, ws.id), eq(journalEntries.status, 'posted'), gte(journalEntries.date, q.from), lte(journalEntries.date, q.to), entryFilter))
      .orderBy(asc(journalEntries.date), asc(journalEntries.number))
      .limit(2000)
    const lines = await entriesWithLines(db, ws.id, entries.map((e) => e.id))
    return { book, from: q.from, to: q.to, entries: entries.map((e) => ({ id: e.id, number: e.number, date: e.date, memo: e.memo, source: e.source, lines: lines.get(e.id) ?? [] })) }
  })

  /** BIR Form 2550Q figures: output VAT on sales less input VAT on purchases, by month. */
  app.get('/reports/vat', needs('finance.view'), async (req): Promise<{ report: VatReturn }> => {
    const ws = workspaceOf(req)
    const { quarter, from, to, months } = quarterOf(req.query)
    const sales = await db
      .select({
        month: monthSql(salesInvoices.date),
        vatableSales: sum(salesInvoices.vatableAmount),
        zeroRatedSales: sum(salesInvoices.zeroRatedAmount),
        exemptSales: sum(salesInvoices.exemptAmount),
        outputVat: sum(salesInvoices.vatAmount),
      })
      .from(salesInvoices)
      .where(and(eq(salesInvoices.workspaceId, ws.id), eq(salesInvoices.status, 'posted'), gte(salesInvoices.date, from), lte(salesInvoices.date, to)))
      .groupBy(monthSql(salesInvoices.date))
    const purchases = await db
      .select({ month: monthSql(bills.date), vatablePurchases: sum(bills.vatableAmount), inputVat: sum(bills.vatAmount) })
      .from(bills)
      .where(and(eq(bills.workspaceId, ws.id), eq(bills.status, 'posted'), gte(bills.date, from), lte(bills.date, to)))
      .groupBy(monthSql(bills.date))
    const claims = ws.vatStatus === 'vat'
    const rows = months.map((month) => {
      const s = sales.find((r) => r.month === month)
      const p = purchases.find((r) => r.month === month)
      return {
        month,
        vatableSales: s?.vatableSales ?? 0,
        zeroRatedSales: s?.zeroRatedSales ?? 0,
        exemptSales: s?.exemptSales ?? 0,
        outputVat: s?.outputVat ?? 0,
        vatablePurchases: claims ? (p?.vatablePurchases ?? 0) : 0,
        inputVat: claims ? (p?.inputVat ?? 0) : 0,
      }
    })
    const totals = rows.reduce(
      (t, r) => ({
        vatableSales: t.vatableSales + r.vatableSales,
        zeroRatedSales: t.zeroRatedSales + r.zeroRatedSales,
        exemptSales: t.exemptSales + r.exemptSales,
        outputVat: t.outputVat + r.outputVat,
        vatablePurchases: t.vatablePurchases + r.vatablePurchases,
        inputVat: t.inputVat + r.inputVat,
      }),
      { vatableSales: 0, zeroRatedSales: 0, exemptSales: 0, outputVat: 0, vatablePurchases: 0, inputVat: 0 },
    )
    return { report: { quarter, months: rows, totals, vatPayable: totals.outputVat - totals.inputVat } }
  })

  /** BIR Form 2551Q figures for a non-VAT business: percentage tax on gross sales, by month. */
  app.get('/reports/percentage-tax', needs('finance.view'), async (req): Promise<{ report: PercentageTaxReturn }> => {
    const ws = workspaceOf(req)
    const { quarter, from, to, months } = quarterOf(req.query)
    const rate = (await taxRateOn(db, ws.id, PERCENTAGE_TAX_CODE, to)).rateBp
    const sales = await db
      .select({ month: monthSql(salesInvoices.date), gross: sum(salesInvoices.total) })
      .from(salesInvoices)
      .where(and(eq(salesInvoices.workspaceId, ws.id), eq(salesInvoices.status, 'posted'), gte(salesInvoices.date, from), lte(salesInvoices.date, to)))
      .groupBy(monthSql(salesInvoices.date))
    const rows = months.map((month) => {
      const grossSales = sales.find((r) => r.month === month)?.gross ?? 0
      return { month, grossSales, tax: applyRate(grossSales, rate) }
    })
    const grossSales = rows.reduce((s, r) => s + r.grossSales, 0)
    return { report: { quarter, rateBp: rate, months: rows, grossSales, tax: applyRate(grossSales, rate) } }
  })

  /** BIR Form 1601-EQ figures and the QAP: tax withheld from suppliers, by ATC and by payee. */
  app.get('/reports/withholding', needs('finance.view'), async (req): Promise<{ report: WithholdingReturn }> => {
    const ws = workspaceOf(req)
    const { quarter, from, to } = quarterOf(req.query)
    const rows = await withholdingRows(ws.id, from, to)
    const byAtc = new Map<string, WithholdingRow>()
    const byPayee = new Map<string, WithholdingReturn['payees'][number]>()
    for (const r of rows) {
      const key = `${r.atc}|${r.rateBp}`
      const atc = byAtc.get(key) ?? { atc: r.atc, description: r.description, rateBp: r.rateBp, incomePayment: 0, taxWithheld: 0 }
      atc.incomePayment += r.incomePayment
      atc.taxWithheld += r.taxWithheld
      byAtc.set(key, atc)
      const payee = byPayee.get(r.supplierId) ?? { supplierId: r.supplierId, tin: r.tin, name: r.name, rows: [] }
      const existing = payee.rows.find((x) => x.atc === r.atc && x.rateBp === r.rateBp)
      if (existing) {
        existing.incomePayment += r.incomePayment
        existing.taxWithheld += r.taxWithheld
      } else payee.rows.push({ atc: r.atc, description: r.description, rateBp: r.rateBp, incomePayment: r.incomePayment, taxWithheld: r.taxWithheld })
      byPayee.set(r.supplierId, payee)
    }
    const atcs = [...byAtc.values()].sort((a, b) => a.atc.localeCompare(b.atc))
    return {
      report: {
        quarter,
        byAtc: atcs,
        payees: [...byPayee.values()].sort((a, b) => a.name.localeCompare(b.name)),
        totalWithheld: atcs.reduce((s, r) => s + r.taxWithheld, 0),
      },
    }
  })

  /** Form 2307 for one supplier and quarter: what was paid them and withheld, month by month. */
  app.get('/reports/form-2307', needs('finance.view'), async (req): Promise<{ report: Form2307 }> => {
    const ws = workspaceOf(req)
    const { quarter, from, to, months } = quarterOf(req.query)
    const { supplierId } = parse(z.object({ supplierId: z.uuid('Choose a supplier.') }), req.query)
    const [supplier] = await db.select().from(contacts).where(and(eq(contacts.id, supplierId), eq(contacts.workspaceId, ws.id)))
    if (!supplier) throw new HttpError(404, 'not-found', 'That supplier doesn’t exist.')
    const rows = (await withholdingRows(ws.id, from, to)).filter((r) => r.supplierId === supplierId)
    const grouped = new Map<string, Form2307['rows'][number]>()
    for (const r of rows) {
      const key = `${r.atc}|${r.rateBp}`
      const row = grouped.get(key) ?? { atc: r.atc, description: r.description, rateBp: r.rateBp, incomePayment: 0, taxWithheld: 0, months: [0, 0, 0] }
      row.months[months.indexOf(r.month as (typeof months)[number])]! += r.incomePayment
      row.incomePayment += r.incomePayment
      row.taxWithheld += r.taxWithheld
      grouped.set(key, row)
    }
    const list = [...grouped.values()].sort((a, b) => a.atc.localeCompare(b.atc))
    return {
      report: {
        quarter,
        periodFrom: from,
        periodTo: to,
        payee: { name: supplier.name, tin: supplier.tin, address: supplier.address },
        payor: { name: ws.name, tin: ws.tin, address: ws.registeredAddress },
        rows: list,
        totalIncome: list.reduce((s, r) => s + r.incomePayment, 0),
        totalWithheld: list.reduce((s, r) => s + r.taxWithheld, 0),
      },
    }
  })

  /** Summary List of Sales or Purchases: one row per customer or supplier for the quarter. */
  app.get('/reports/slsp', needs('finance.view'), async (req): Promise<{ report: Slsp }> => {
    const ws = workspaceOf(req)
    const { quarter, from, to } = quarterOf(req.query)
    const { kind } = parse(z.object({ kind: z.enum(['sales', 'purchases']) }), req.query)
    const t = kind === 'sales' ? salesInvoices : bills
    const contactCol = kind === 'sales' ? salesInvoices.customerId : bills.supplierId
    const rows = await db
      .select({
        contactId: contacts.id,
        tin: contacts.tin,
        name: contacts.name,
        exempt: sum(t.exemptAmount),
        zeroRated: sum(t.zeroRatedAmount),
        vatable: sum(t.vatableAmount),
        nonVat: sum(t.nonVatAmount),
        vat: sum(t.vatAmount),
        gross: sum(t.total),
      })
      .from(t)
      .innerJoin(contacts, eq(contacts.id, contactCol))
      .where(and(eq(t.workspaceId, ws.id), eq(t.status, 'posted'), gte(t.date, from), lte(t.date, to)))
      .groupBy(contacts.id)
      .orderBy(asc(contacts.name))
    const totals = rows.reduce(
      (s, r) => ({ exempt: s.exempt + r.exempt, zeroRated: s.zeroRated + r.zeroRated, vatable: s.vatable + r.vatable, nonVat: s.nonVat + r.nonVat, vat: s.vat + r.vat, gross: s.gross + r.gross }),
      { exempt: 0, zeroRated: 0, vatable: 0, nonVat: 0, vat: 0, gross: 0 } satisfies Slsp['totals'],
    )
    return { report: { quarter, kind, rows: rows satisfies SlspRow[], totals } }
  })
}

/** Withholding on posted bills' lines in a period: one row per bill line with tax withheld. */
async function withholdingRows(workspaceId: string, from: string, to: string) {
  return db
    .select({
      supplierId: contacts.id,
      tin: contacts.tin,
      name: contacts.name,
      month: monthSql(bills.date),
      atc: sql<string>`coalesce(${documentLines.atc}, '')`,
      description: sql<string>`coalesce(${taxCodes.name}, '')`,
      rateBp: sql<number>`coalesce(${documentLines.ewtRateBp}, 0)`.mapWith(Number),
      incomePayment: documentLines.net,
      taxWithheld: documentLines.ewtAmount,
    })
    .from(documentLines)
    .innerJoin(bills, eq(bills.id, documentLines.billId))
    .innerJoin(contacts, eq(contacts.id, bills.supplierId))
    .leftJoin(taxCodes, eq(taxCodes.id, documentLines.ewtCodeId))
    .where(and(eq(documentLines.workspaceId, workspaceId), eq(bills.status, 'posted'), gt(documentLines.ewtAmount, 0), gte(bills.date, from), lte(bills.date, to)))
}
