import { z } from 'zod'
import { applyRate } from './money.ts'
import { optionalTinSchema, textField } from './workspace.ts'

/* ---------------------------------------------------------------------------------------------
 * Accounts
 * ------------------------------------------------------------------------------------------- */

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]
export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  asset: 'Asset',
  liability: 'Liability',
  equity: 'Equity',
  income: 'Income',
  expense: 'Expense',
}

/** Assets and expenses grow with debits; the rest grow with credits. */
export const isDebitNormal = (type: AccountType) => type === 'asset' || type === 'expense'

/** Cash and bank accounts are the ones payments move money through, and what the cash books list. */
export const CASH_SUBTYPES = ['cash', 'bank'] as const

export const AccountInput = z.object({
  code: z
    .string('Enter an account code.')
    .trim()
    .regex(/^[0-9]{3,6}(-[0-9]{1,4})?$/, 'Use 3 to 6 digits, like 6150 (optionally with a suffix, like 6150-01).'),
  name: textField('account name', 120),
  type: z.enum(ACCOUNT_TYPES, 'Choose the account type.'),
  subtype: z.enum([...CASH_SUBTYPES, 'other']).default('other'),
})
export type AccountInput = z.input<typeof AccountInput>

export const AccountUpdate = z.object({ name: textField('account name', 120), active: z.boolean() })

export type Account = {
  id: string
  code: string
  name: string
  type: AccountType
  subtype: string
  /** Set on accounts the system posts to by itself (receivables, VAT, withholding…). */
  systemKey: string | null
  active: boolean
}

/* ---------------------------------------------------------------------------------------------
 * Tax codes: the rates live in the database, with the date they apply from (see docs/plan.md)
 * ------------------------------------------------------------------------------------------- */

export const TAX_KINDS = ['vat', 'percentage', 'ewt'] as const
export type TaxKind = (typeof TAX_KINDS)[number]

export type TaxCode = {
  id: string
  kind: TaxKind
  code: string
  name: string
  /** Basis points: 1200 = 12%. */
  rateBp: number
  /** BIR alphanumeric tax code, for withholding (e.g. WC158). */
  atc: string | null
  effectiveFrom: string
  active: boolean
}

/* ---------------------------------------------------------------------------------------------
 * Contacts: customers and suppliers
 * ------------------------------------------------------------------------------------------- */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use ${max} characters or fewer.`)
    .transform((v) => (v === '' ? undefined : v))
    .optional()

export const ContactInput = z
  .object({
    name: textField('registered name', 160),
    tin: optionalTinSchema.optional(),
    address: optionalText(300),
    email: z
      .string()
      .trim()
      .transform((v) => (v === '' ? undefined : v.toLowerCase()))
      .pipe(z.email('Enter a valid email address.').optional())
      .optional(),
    phone: optionalText(40),
    isCustomer: z.boolean().default(false),
    isSupplier: z.boolean().default(false),
    /** The withholding code usually applied to this supplier's bills. */
    defaultEwtCodeId: z.uuid().nullish(),
  })
  .refine((c) => c.isCustomer || c.isSupplier, { message: 'Mark this contact as a customer, a supplier, or both.', path: ['isCustomer'] })
export type ContactInput = z.input<typeof ContactInput>

export type Contact = {
  id: string
  name: string
  tin: string | null
  address: string | null
  email: string | null
  phone: string | null
  isCustomer: boolean
  isSupplier: boolean
  defaultEwtCodeId: string | null
}

/* ---------------------------------------------------------------------------------------------
 * Invoices and bills: the calculation both the form and the API use
 * ------------------------------------------------------------------------------------------- */

/**
 * How VAT applies to a line.
 * - vatable: 12% VAT (or whatever the VAT code's current rate is)
 * - zero_rated: VAT at 0%, e.g. export sales
 * - exempt: VAT-exempt sales or purchases
 * - none: not subject to VAT, i.e. the seller is a non-VAT business
 */
export const VAT_TREATMENTS = ['vatable', 'zero_rated', 'exempt', 'none'] as const
export type VatTreatment = (typeof VAT_TREATMENTS)[number]
export const VAT_TREATMENT_LABELS: Record<VatTreatment, string> = {
  vatable: 'VATable',
  zero_rated: 'Zero-rated',
  exempt: 'VAT-exempt',
  none: 'Non-VAT',
}

export type LineAmounts = { gross: number; net: number; vatAmount: number; ewtAmount: number }

/**
 * One line's amounts, in centavos. `unitPrice` is in centavos; `quantity` may have decimals.
 * With `pricesIncludeVat`, the VAT is taken out of the price (₱112 → ₱100 + ₱12 VAT);
 * otherwise it's added on top. Withholding is on the amount before VAT.
 */
export function computeLine(
  line: { quantity: number; unitPrice: number; vat: VatTreatment; vatRateBp: number; ewtRateBp?: number | null },
  pricesIncludeVat: boolean,
): LineAmounts {
  const extended = Math.round(line.quantity * line.unitPrice)
  let net = extended
  let vat = 0
  if (line.vat === 'vatable') {
    if (pricesIncludeVat) {
      net = Math.round((extended * 10_000) / (10_000 + line.vatRateBp))
      vat = extended - net
    } else {
      vat = applyRate(extended, line.vatRateBp)
    }
  }
  return { gross: net + vat, net, vatAmount: vat, ewtAmount: line.ewtRateBp ? applyRate(net, line.ewtRateBp) : 0 }
}

export type DocumentTotals = {
  /** Net of VAT, for VATable lines. */
  vatableAmount: number
  zeroRatedAmount: number
  exemptAmount: number
  /** Lines from or to a non-VAT business. */
  nonVatAmount: number
  vatAmount: number
  /** What the invoice or bill is for, VAT included. */
  total: number
  /** Expanded withholding tax deducted (bills only). */
  ewtAmount: number
  /** What's owed after withholding: total − ewtAmount. */
  amountDue: number
}

export function computeTotals(lines: (LineAmounts & { vat: VatTreatment })[]): DocumentTotals {
  const t = { vatableAmount: 0, zeroRatedAmount: 0, exemptAmount: 0, nonVatAmount: 0, vatAmount: 0, total: 0, ewtAmount: 0, amountDue: 0 }
  for (const l of lines) {
    if (l.vat === 'vatable') t.vatableAmount += l.net
    else if (l.vat === 'zero_rated') t.zeroRatedAmount += l.net
    else if (l.vat === 'exempt') t.exemptAmount += l.net
    else t.nonVatAmount += l.net
    t.vatAmount += l.vatAmount
    t.total += l.gross
    t.ewtAmount += l.ewtAmount
  }
  t.amountDue = t.total - t.ewtAmount
  return t
}

const dateSchema = z.iso.date('Enter a date.')

/** Up to four decimal places, like 2.5 kg or 0.125 hours. */
const quantitySchema = z.coerce
  .number('Enter a quantity.')
  .positive('The quantity must be more than zero.')
  .max(1_000_000_000, 'That quantity is too large.')
  .refine((v) => Math.abs(Math.round(v * 10_000) - v * 10_000) < 1e-6, 'Use at most four decimal places.')
  .transform((v) => Math.round(v * 10_000) / 10_000)

/** Centavos: whole, and up to ₱10 billion per line. */
const centavosSchema = (label: string) =>
  z.number(`Enter the ${label}.`).int(`Enter the ${label} to the centavo.`).min(0, `The ${label} can’t be negative.`).max(1_000_000_000_000, `That ${label} is too large.`)

export const DocumentLineInput = z.object({
  description: textField('description', 300),
  quantity: quantitySchema,
  unitPrice: centavosSchema('price'),
  vat: z.enum(VAT_TREATMENTS),
  accountId: z.uuid('Choose an account.'),
  /** Bills only: the withholding code for this line, if tax is withheld. */
  ewtCodeId: z.uuid().nullish(),
})
export type DocumentLineInput = z.input<typeof DocumentLineInput>

const notes = optionalText(1000)

export const InvoiceInput = z.object({
  customerId: z.uuid('Choose a customer.'),
  date: dateSchema,
  dueDate: dateSchema.nullish(),
  pricesIncludeVat: z.boolean().default(false),
  notes,
  lines: z.array(DocumentLineInput).min(1, 'Add at least one line.').max(200, 'Use 200 lines or fewer.'),
})
export type InvoiceInput = z.input<typeof InvoiceInput>

export const BillInput = z.object({
  supplierId: z.uuid('Choose a supplier.'),
  /** The supplier's own invoice number, as printed on what they sent. */
  supplierInvoiceNo: optionalText(60),
  date: dateSchema,
  dueDate: dateSchema.nullish(),
  pricesIncludeVat: z.boolean().default(false),
  notes,
  lines: z.array(DocumentLineInput).min(1, 'Add at least one line.').max(200, 'Use 200 lines or fewer.'),
})
export type BillInput = z.input<typeof BillInput>

export const DOCUMENT_STATUSES = ['draft', 'posted', 'void'] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

export type DocumentLine = {
  id: string
  description: string
  quantity: number
  unitPrice: number
  vat: VatTreatment
  vatRateBp: number
  accountId: string
  ewtCodeId: string | null
  ewtRateBp: number | null
  atc: string | null
} & LineAmounts

type DocumentBase = DocumentTotals & {
  id: string
  /** Assigned in sequence when posted, so drafts have none (EOPT: serial numbers without gaps). */
  number: string | null
  status: DocumentStatus
  date: string
  dueDate: string | null
  pricesIncludeVat: boolean
  notes: string | null
  /** amountDue less what has been paid or withheld so far. */
  balance: number
  postedAt: string | null
  journalEntryId: string | null
}

export type InvoiceSummary = DocumentBase & { customer: { id: string; name: string } }
export type Invoice = InvoiceSummary & { customer: Contact; lines: DocumentLine[]; payments: Payment[] }

export type BillSummary = DocumentBase & { supplierInvoiceNo: string | null; supplier: { id: string; name: string } }
export type Bill = BillSummary & { supplier: Contact; lines: DocumentLine[]; payments: Payment[] }

/* ---------------------------------------------------------------------------------------------
 * Payments
 * ------------------------------------------------------------------------------------------- */

export const PaymentInput = z.object({
  date: dateSchema,
  /** The cash or bank account the money went into or came out of. */
  accountId: z.uuid('Choose the cash or bank account.'),
  amount: centavosSchema('amount').min(1, 'Enter the amount.'),
  /** Received payments only: tax the customer withheld (they give you a Form 2307 for it). */
  withheld: centavosSchema('amount withheld').default(0),
  reference: optionalText(80),
})
export type PaymentInput = z.input<typeof PaymentInput>

export type Payment = {
  id: string
  number: string
  kind: 'received' | 'made'
  status: 'posted' | 'void'
  date: string
  amount: number
  withheld: number
  reference: string | null
  account: { id: string; code: string; name: string }
  journalEntryId: string
}

/* ---------------------------------------------------------------------------------------------
 * Journal entries
 * ------------------------------------------------------------------------------------------- */

export const JournalLineInput = z
  .object({
    accountId: z.uuid('Choose an account.'),
    debit: centavosSchema('debit').default(0),
    credit: centavosSchema('credit').default(0),
    description: optionalText(300),
  })
  .refine((l) => (l.debit > 0) !== (l.credit > 0), { message: 'Each line is either a debit or a credit.', path: ['debit'] })

export const JournalInput = z
  .object({
    date: dateSchema,
    memo: textField('description', 300),
    lines: z.array(JournalLineInput).min(2, 'An entry needs at least two lines.').max(200, 'Use 200 lines or fewer.'),
  })
  .refine((j) => j.lines.reduce((s, l) => s + l.debit, 0) === j.lines.reduce((s, l) => s + l.credit, 0), {
    message: 'Debits and credits must be equal.',
    path: ['lines'],
  })
export type JournalInput = z.input<typeof JournalInput>

export const ReverseInput = z.object({ date: dateSchema })

export const JOURNAL_SOURCES = ['manual', 'sales_invoice', 'bill', 'payment_received', 'payment_made', 'reversal'] as const
export type JournalSource = (typeof JOURNAL_SOURCES)[number]
export const JOURNAL_SOURCE_LABELS: Record<JournalSource, string> = {
  manual: 'Journal entry',
  sales_invoice: 'Sales invoice',
  bill: 'Bill',
  payment_received: 'Payment received',
  payment_made: 'Payment made',
  reversal: 'Reversal',
}

export type JournalLine = {
  id: string
  account: { id: string; code: string; name: string }
  debit: number
  credit: number
  description: string | null
}

export type JournalEntrySummary = {
  id: string
  number: string | null
  status: 'draft' | 'posted'
  date: string
  memo: string
  source: JournalSource
  sourceId: string | null
  total: number
  reversesId: string | null
  reversedById: string | null
}

export type JournalEntry = JournalEntrySummary & { lines: JournalLine[] }

/* ---------------------------------------------------------------------------------------------
 * Reports
 * ------------------------------------------------------------------------------------------- */

export type AccountBalance = { id: string; code: string; name: string; type: AccountType; debit: number; credit: number; balance: number }

export type TrialBalance = { asOf: string; rows: AccountBalance[]; totalDebit: number; totalCredit: number }

export type StatementSection = { title: string; rows: { id: string; code: string; name: string; amount: number }[]; total: number }

export type ProfitAndLoss = { from: string; to: string; income: StatementSection; expenses: StatementSection; netIncome: number }

export type BalanceSheet = {
  asOf: string
  assets: StatementSection
  liabilities: StatementSection
  equity: StatementSection
  /** Income less expenses to date not yet closed to retained earnings. Already inside `equity.total`. */
  unclosedEarnings: number
  balanced: boolean
}

export type LedgerRow = { entryId: string; number: string | null; date: string; memo: string; source: JournalSource; debit: number; credit: number; balance: number }
export type GeneralLedger = { account: Account; from: string; to: string; opening: number; rows: LedgerRow[]; closing: number }

export type BookEntry = { id: string; number: string | null; date: string; memo: string; source: JournalSource; lines: JournalLine[] }
export const BOOKS = ['general-journal', 'cash-receipts', 'cash-disbursements'] as const
export type BookName = (typeof BOOKS)[number]
export const BOOK_LABELS: Record<BookName, string> = {
  'general-journal': 'General Journal',
  'cash-receipts': 'Cash Receipts Book',
  'cash-disbursements': 'Cash Disbursements Book',
}

/** A calendar quarter, e.g. 2026-Q3. BIR quarterly returns follow calendar quarters here. */
export const quarterSchema = z.string().regex(/^\d{4}-Q[1-4]$/, 'Choose a quarter.')

export type VatReturn = {
  quarter: string
  months: { month: string; vatableSales: number; zeroRatedSales: number; exemptSales: number; outputVat: number; vatablePurchases: number; inputVat: number }[]
  totals: { vatableSales: number; zeroRatedSales: number; exemptSales: number; outputVat: number; vatablePurchases: number; inputVat: number }
  /** Output VAT less input VAT. Negative means excess input VAT to carry over. */
  vatPayable: number
}

export type PercentageTaxReturn = { quarter: string; rateBp: number; months: { month: string; grossSales: number; tax: number }[]; grossSales: number; tax: number }

export type WithholdingRow = { atc: string; description: string; rateBp: number; incomePayment: number; taxWithheld: number }
export type WithholdingReturn = {
  quarter: string
  /** 1601-EQ summary: by alphanumeric tax code. */
  byAtc: WithholdingRow[]
  /** QAP: by payee. */
  payees: { supplierId: string; tin: string | null; name: string; rows: WithholdingRow[] }[]
  totalWithheld: number
}

/** Form 2307: tax withheld from one supplier in one quarter, month by month. */
export type Form2307 = {
  quarter: string
  periodFrom: string
  periodTo: string
  payee: { name: string; tin: string | null; address: string | null }
  payor: { name: string; tin: string; address: string }
  rows: (WithholdingRow & { months: [number, number, number] })[]
  totalIncome: number
  totalWithheld: number
}

/** Summary List of Sales / Purchases, by customer or supplier. */
export type SlspRow = { contactId: string; tin: string | null; name: string; exempt: number; zeroRated: number; vatable: number; nonVat: number; vat: number; gross: number }
export type Slsp = { quarter: string; kind: 'sales' | 'purchases'; rows: SlspRow[]; totals: Omit<SlspRow, 'contactId' | 'tin' | 'name'> }

/** The Finance overview's figures. */
export type FinanceOverview = {
  cash: number
  receivables: number
  payables: number
  monthToDate: { income: number; expenses: number }
  overdueInvoices: number
  overdueBills: number
}

/* ---------------------------------------------------------------------------------------------
 * Periods
 * ------------------------------------------------------------------------------------------- */

/** "2026-Q3" → first and last day. */
export function quarterRange(quarter: string) {
  const [y, q] = quarter.split('-Q').map(Number) as [number, number]
  const startMonth = (q - 1) * 3 + 1
  const pad = (n: number) => String(n).padStart(2, '0')
  const lastDay = new Date(Date.UTC(y, startMonth + 2, 0)).getUTCDate()
  return { from: `${y}-${pad(startMonth)}-01`, to: `${y}-${pad(startMonth + 2)}-${pad(lastDay)}`, months: [0, 1, 2].map((i) => `${y}-${pad(startMonth + i)}`) as [string, string, string] }
}

/** The quarter a date falls in: "2026-08-14" → "2026-Q3". */
export const quarterOf = (date: string) => `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`
