import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { computeLine, parsePeso, quarterRange, type Account, type Bill, type Contact, type Invoice, type TaxCode } from '@erp/shared'
import { eq, sql } from 'drizzle-orm'
import { buildApp } from '../src/app.ts'
import { db, pool, runMigrations } from '../src/db/client.ts'
import { salesInvoices, sessions, users } from '../src/db/schema.ts'
import { hashToken, newToken } from '../src/lib/crypto.ts'

// Finance end to end, against the development database (npm run db:up). Each run makes fresh
// users and workspaces, so it never trips over an earlier run's data.
//
// Amounts are centavos: 100_000_00 is ₱100,000.00.

const app = await buildApp()
const ORIGIN = 'http://127.0.0.1:5180'
const run = Date.now()

/** A confirmed user with a session, made directly in the database (auth has its own tests). */
async function makeUser(name: string) {
  const [user] = await db
    .insert(users)
    .values({ email: `fin+${name.toLowerCase()}+${run}@example.com`, name, passwordHash: 'x', emailVerifiedAt: new Date(), termsAcceptedAt: new Date() })
    .returning()
  const token = newToken()
  await db.insert(sessions).values({ id: hashToken(token), userId: user!.id, remember: false, expiresAt: new Date(Date.now() + 3_600_000) })
  return token
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const as = (token: string) => async (method: Method, url: string, payload?: object) => {
  const r = await app.inject({ method, url, payload, headers: { origin: ORIGIN, authorization: `Bearer ${token}` }, remoteAddress: `10.9.${run % 200}.1` })
  return { status: r.statusCode, body: r.body ? r.json() : undefined }
}

let alice: ReturnType<typeof as>
let bob: ReturnType<typeof as>
let ws = ''
let w = (path: string) => `/api/w/${ws}${path}`
const accountId: Record<string, string> = {}
const tax: Record<string, TaxCode> = {}
let customer: Contact
let supplier: Contact

before(async () => {
  await runMigrations()
  alice = as(await makeUser('Alice'))
  bob = as(await makeUser('Bob'))
})
after(async () => {
  await app.close()
  await pool.end()
})

test('line amounts: VAT added on top, taken out of the price, and withholding on the net', () => {
  assert.deepEqual(computeLine({ quantity: 2, unitPrice: 50_000_00, vat: 'vatable', vatRateBp: 1200 }, false), { gross: 112_000_00, net: 100_000_00, vatAmount: 12_000_00, ewtAmount: 0 })
  assert.deepEqual(computeLine({ quantity: 1, unitPrice: 112_00, vat: 'vatable', vatRateBp: 1200 }, true), { gross: 112_00, net: 100_00, vatAmount: 12_00, ewtAmount: 0 })
  assert.deepEqual(computeLine({ quantity: 1, unitPrice: 50_000_00, vat: 'vatable', vatRateBp: 1200, ewtRateBp: 200 }, false), { gross: 56_000_00, net: 50_000_00, vatAmount: 6_000_00, ewtAmount: 1_000_00 })
  assert.deepEqual(computeLine({ quantity: 3, unitPrice: 999_99, vat: 'exempt', vatRateBp: 1200 }, false), { gross: 2_999_97, net: 2_999_97, vatAmount: 0, ewtAmount: 0 })
  assert.equal(parsePeso('₱1,234.5'), 1_234_50)
  assert.equal(parsePeso('12.345'), null)
  assert.deepEqual(quarterRange('2026-Q3'), { from: '2026-07-01', to: '2026-09-30', months: ['2026-07', '2026-08', '2026-09'] })
})

test('a workspace is created with its chart of accounts and tax codes', async () => {
  const bad = await alice('POST', '/api/workspaces', { template: 'general', name: 'Kape ni Alice', tin: '123', vatStatus: 'vat', street: 'Quezon City' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.field, 'tin')

  const r = await alice('POST', '/api/workspaces', { template: 'general', name: 'Kape ni Alice Corp.', tin: '123456789000', vatStatus: 'vat', street: '12 Mabini St., Brgy. Malate, Manila' })
  assert.equal(r.status, 201)
  assert.equal(r.body.workspace.tin, '123-456-789-000')
  assert.equal(r.body.workspace.role.key, 'owner')
  ws = r.body.workspace.id
  w = (path: string) => `/api/w/${ws}${path}`

  const mine = await alice('GET', '/api/workspaces')
  assert.ok(mine.body.workspaces.some((x: { id: string }) => x.id === ws))

  const accounts = (await alice('GET', w('/accounts'))).body.accounts as Account[]
  for (const a of accounts) if (a.systemKey) accountId[a.systemKey] = a.id
  accountId.services = accounts.find((a) => a.code === '4010')!.id
  accountId.professional = accounts.find((a) => a.code === '6160')!.id
  assert.ok(accountId.ar && accountId.output_vat && accountId.cwt && accountId.ewt_payable && accountId.bank)

  for (const t of (await alice('GET', w('/tax-codes'))).body.taxCodes as TaxCode[]) tax[t.code] = t
  assert.equal(tax.VAT12!.rateBp, 1200)
  assert.equal(tax.WC160!.rateBp, 200)
})

test('another person can’t see into the workspace, and can’t tell it exists', async () => {
  const r = await bob('GET', w('/accounts'))
  assert.equal(r.status, 404)
  const missing = await bob('GET', `/api/w/00000000-0000-4000-8000-000000000000/accounts`)
  assert.deepEqual(r.body, missing.body)
  const signedOut = await app.inject({ method: 'GET', url: w('/accounts') })
  assert.equal(signedOut.statusCode, 401)
})

test('customers and suppliers', async () => {
  const none = await alice('POST', w('/contacts'), { name: 'Nobody' })
  assert.equal(none.status, 400)
  customer = (await alice('POST', w('/contacts'), { name: 'Bayanihan Trading Inc.', tin: '987-654-321-00000', isCustomer: true })).body.contact
  supplier = (await alice('POST', w('/contacts'), { name: 'Reyes & Santos CPAs', tin: '111222333000', isSupplier: true, defaultEwtCodeId: tax.WC160!.id })).body.contact
  assert.equal(supplier.tin, '111-222-333-000')
  const suppliers = (await alice('GET', w('/contacts?role=supplier'))).body.contacts as Contact[]
  assert.deepEqual(suppliers.map((c) => c.id), [supplier.id])
})

let invoice: Invoice

test('a sales invoice is drafted, then posted with the next number and a balanced entry', async () => {
  const draft = await alice('POST', w('/invoices'), {
    customerId: customer.id,
    date: '2026-07-10',
    dueDate: '2026-08-09',
    lines: [{ description: 'Coffee beans, 50 kg', quantity: 2, unitPrice: 50_000_00, vat: 'vatable', accountId: accountId.sales }],
  })
  assert.equal(draft.status, 201)
  assert.equal(draft.body.invoice.number, null)
  assert.equal(draft.body.invoice.total, 112_000_00)

  const wrongAccount = await alice('PUT', w(`/invoices/${draft.body.invoice.id}`), {
    customerId: customer.id,
    date: '2026-07-10',
    lines: [{ description: 'x', quantity: 1, unitPrice: 100, vat: 'vatable', accountId: accountId.ar }],
  })
  assert.equal(wrongAccount.status, 400)
  assert.match(wrongAccount.body.error.message, /^Line 1: sales go to an income account/)

  const noVat = await alice('POST', w('/invoices'), { customerId: customer.id, date: '2026-07-10', lines: [{ description: 'x', quantity: 1, unitPrice: 100, vat: 'none', accountId: accountId.sales }] })
  assert.match(noVat.body.error.message, /VAT-registered business charges VAT/)

  const posted = await alice('POST', w(`/invoices/${draft.body.invoice.id}/post`))
  assert.equal(posted.status, 200)
  invoice = posted.body.invoice
  assert.equal(invoice.number, 'SI-000001')
  assert.equal(invoice.status, 'posted')
  assert.equal(invoice.balance, 112_000_00)

  const entry = (await alice('GET', w(`/journal/${invoice.journalEntryId}`))).body.entry
  assert.equal(entry.status, 'posted')
  assert.match(entry.number, /^JE-\d{6}$/)
  const side = (id: string, key: 'debit' | 'credit') => entry.lines.filter((l: { account: { id: string } }) => l.account.id === id).reduce((s: number, l: Record<string, number>) => s + l[key]!, 0)
  assert.equal(side(accountId.ar!, 'debit'), 112_000_00)
  assert.equal(side(accountId.sales!, 'credit'), 100_000_00)
  assert.equal(side(accountId.output_vat!, 'credit'), 12_000_00)
})

test('a posted invoice can’t be edited, deleted or posted again — not even straight in the database', async () => {
  const edit = await alice('PUT', w(`/invoices/${invoice.id}`), { customerId: customer.id, date: '2026-07-10', lines: [{ description: 'x', quantity: 1, unitPrice: 100, vat: 'vatable', accountId: accountId.sales }] })
  assert.equal(edit.status, 409)
  assert.equal((await alice('DELETE', w(`/invoices/${invoice.id}`))).status, 409)
  assert.equal((await alice('POST', w(`/invoices/${invoice.id}/post`))).status, 409)

  // drizzle wraps the database's own error; the refusal is in its cause
  const refusedWith = (pattern: RegExp) => (e: unknown) => pattern.test(String((e as { cause?: Error }).cause?.message))
  await assert.rejects(db.update(salesInvoices).set({ total: 1 }).where(eq(salesInvoices.id, invoice.id)), refusedWith(/can.t be changed/))
  await assert.rejects(db.execute(sql`update journal_lines set debit = debit + 1 where entry_id = ${invoice.journalEntryId}`), refusedWith(/posted journal entry/))
  await assert.rejects(db.execute(sql`delete from journal_entries where id = ${invoice.journalEntryId}`), refusedWith(/can.t be deleted/))
})

test('a failed posting doesn’t use up a number', async () => {
  const zero = await alice('POST', w('/invoices'), { customerId: customer.id, date: '2026-07-11', lines: [{ description: 'Free sample', quantity: 1, unitPrice: 0, vat: 'vatable', accountId: accountId.sales }] })
  const refused = await alice('POST', w(`/invoices/${zero.body.invoice.id}/post`))
  assert.equal(refused.status, 400)
  assert.equal((await alice('DELETE', w(`/invoices/${zero.body.invoice.id}`))).status, 204)

  const next = await alice('POST', w('/invoices'), {
    customerId: customer.id,
    date: '2026-08-05',
    pricesIncludeVat: true,
    lines: [{ description: 'Consulting', quantity: 1, unitPrice: 11_200_00, vat: 'vatable', accountId: accountId.services }],
  })
  const posted = (await alice('POST', w(`/invoices/${next.body.invoice.id}/post`))).body.invoice as Invoice
  assert.equal(posted.number, 'SI-000002')
  assert.equal(posted.vatAmount, 1_200_00)
  assert.equal(posted.total, 11_200_00)
})

test('a payment with tax withheld by the customer settles the invoice', async () => {
  const over = await alice('POST', w(`/invoices/${invoice.id}/payments`), { date: '2026-08-01', accountId: accountId.bank, amount: 112_000_01 })
  assert.equal(over.status, 400)
  assert.match(over.body.error.message, /more than the ₱112,000.00 still owed/)
  const notCash = await alice('POST', w(`/invoices/${invoice.id}/payments`), { date: '2026-08-01', accountId: accountId.sales, amount: 100 })
  assert.equal(notCash.body.error.field, 'accountId')

  // the customer withholds 2% of the ₱100,000 before VAT and hands over a Form 2307
  const paid = await alice('POST', w(`/invoices/${invoice.id}/payments`), { date: '2026-08-01', accountId: accountId.bank, amount: 110_000_00, withheld: 2_000_00, reference: 'BDO check 004512' })
  assert.equal(paid.status, 201)
  invoice = paid.body.invoice
  assert.equal(invoice.balance, 0)
  assert.equal(invoice.payments[0]!.number, 'CR-000001')
})

let bill: Bill

test('a supplier bill with 2% withholding: input VAT claimed, tax withheld owed to BIR', async () => {
  const draft = await alice('POST', w('/bills'), {
    supplierId: supplier.id,
    supplierInvoiceNo: 'RS-2026-118',
    date: '2026-08-15',
    lines: [{ description: 'Audit fee', quantity: 1, unitPrice: 50_000_00, vat: 'vatable', accountId: accountId.professional, ewtCodeId: tax.WC160!.id }],
  })
  assert.equal(draft.status, 201)
  const posted = await alice('POST', w(`/bills/${draft.body.bill.id}/post`))
  bill = posted.body.bill
  assert.equal(bill.number, 'BILL-000001')
  assert.equal(bill.total, 56_000_00)
  assert.equal(bill.ewtAmount, 1_000_00)
  assert.equal(bill.amountDue, 55_000_00)
  assert.equal(bill.lines[0]!.atc, 'WC160')

  const withheldOnPayment = await alice('POST', w(`/bills/${bill.id}/payments`), { date: '2026-08-20', accountId: accountId.bank, amount: 100, withheld: 100 })
  assert.equal(withheldOnPayment.body.error.field, 'withheld')
  const paid = await alice('POST', w(`/bills/${bill.id}/payments`), { date: '2026-08-20', accountId: accountId.bank, amount: 55_000_00 })
  assert.equal(paid.body.bill.balance, 0)
  assert.equal(paid.body.bill.payments[0].number, 'PV-000001')
})

test('the books balance, and the statements agree with them', async () => {
  const tb = (await alice('GET', w('/reports/trial-balance?asOf=2026-09-30'))).body.report
  assert.equal(tb.totalDebit, tb.totalCredit)

  const pl = (await alice('GET', w('/reports/profit-and-loss?from=2026-07-01&to=2026-09-30'))).body.report
  assert.equal(pl.income.total, 110_000_00) // 100,000 goods + 10,000 consulting
  assert.equal(pl.expenses.total, 50_000_00)
  assert.equal(pl.netIncome, 60_000_00)

  const bs = (await alice('GET', w('/reports/balance-sheet?asOf=2026-09-30'))).body.report
  assert.equal(bs.balanced, true)
  assert.equal(bs.unclosedEarnings, 60_000_00)

  const gl = (await alice('GET', w(`/reports/general-ledger?accountId=${accountId.ar}&from=2026-07-01&to=2026-09-30`))).body.report
  assert.equal(gl.opening, 0)
  assert.equal(gl.closing, 11_200_00) // the consulting invoice is still unpaid

  const receipts = (await alice('GET', w('/reports/books/cash-receipts?from=2026-07-01&to=2026-09-30'))).body
  assert.equal(receipts.entries.length, 1)
  const disbursements = (await alice('GET', w('/reports/books/cash-disbursements?from=2026-07-01&to=2026-09-30'))).body
  assert.equal(disbursements.entries.length, 1)
})

test('BIR summaries: VAT, withholding, Form 2307 and the sales list', async () => {
  const vat = (await alice('GET', w('/reports/vat?quarter=2026-Q3'))).body.report
  assert.equal(vat.totals.vatableSales, 110_000_00)
  assert.equal(vat.totals.outputVat, 13_200_00)
  assert.equal(vat.totals.inputVat, 6_000_00)
  assert.equal(vat.vatPayable, 7_200_00)
  assert.deepEqual(
    vat.months.map((m: { outputVat: number }) => m.outputVat),
    [12_000_00, 1_200_00, 0],
  )

  const ewt = (await alice('GET', w('/reports/withholding?quarter=2026-Q3'))).body.report
  assert.deepEqual(ewt.byAtc.map((r: { atc: string; incomePayment: number; taxWithheld: number }) => [r.atc, r.incomePayment, r.taxWithheld]), [['WC160', 50_000_00, 1_000_00]])
  assert.equal(ewt.payees[0].tin, '111-222-333-000')

  const f2307 = (await alice('GET', w(`/reports/form-2307?quarter=2026-Q3&supplierId=${supplier.id}`))).body.report
  assert.deepEqual(f2307.rows[0].months, [0, 50_000_00, 0])
  assert.equal(f2307.payor.tin, '123-456-789-000')

  const slsp = (await alice('GET', w('/reports/slsp?quarter=2026-Q3&kind=sales'))).body.report
  assert.equal(slsp.rows[0].name, 'Bayanihan Trading Inc.')
  assert.equal(slsp.totals.gross, 123_200_00)

  assert.equal((await alice('GET', w('/reports/vat?quarter=2026-Q5'))).status, 400)
})

test('voiding: payments first, then the invoice; the reversal keeps the books balanced', async () => {
  const blocked = await alice('POST', w(`/invoices/${invoice.id}/void`), { date: '2026-09-01' })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.body.error.code, 'has-payments')

  const voidedPayment = await alice('POST', w(`/payments/${invoice.payments[0]!.id}/void`), { date: '2026-09-01' })
  assert.equal(voidedPayment.body.invoice.balance, 112_000_00)
  const voided = await alice('POST', w(`/invoices/${invoice.id}/void`), { date: '2026-09-01' })
  assert.equal(voided.body.invoice.status, 'void')
  assert.equal(voided.body.invoice.number, 'SI-000001') // the number stays used

  const original = (await alice('GET', w(`/journal/${invoice.journalEntryId}`))).body.entry
  assert.ok(original.reversedById)
  const tb = (await alice('GET', w('/reports/trial-balance?asOf=2026-09-30'))).body.report
  assert.equal(tb.totalDebit, tb.totalCredit)
  const vat = (await alice('GET', w('/reports/vat?quarter=2026-Q3'))).body.report
  assert.equal(vat.totals.outputVat, 1_200_00)
})

test('manual journal entries: drafts change freely, posting checks the balance, reversal undoes', async () => {
  const unbalanced = await alice('POST', w('/journal'), {
    date: '2026-09-05',
    memo: 'Owner investment',
    lines: [
      { accountId: accountId.bank, debit: 500_000_00 },
      { accountId: accountId.retained_earnings, credit: 400_000_00 },
    ],
  })
  assert.equal(unbalanced.status, 400)
  assert.equal(unbalanced.body.error.field, 'lines')

  const draft = await alice('POST', w('/journal'), {
    date: '2026-09-05',
    memo: 'Owner investment',
    lines: [
      { accountId: accountId.bank, debit: 500_000_00 },
      { accountId: accountId.retained_earnings, credit: 500_000_00 },
    ],
  })
  assert.equal(draft.body.entry.status, 'draft')
  assert.equal(draft.body.entry.number, null)
  const posted = await alice('POST', w(`/journal/${draft.body.entry.id}/post`))
  assert.equal(posted.body.entry.status, 'posted')

  const reversal = await alice('POST', w(`/journal/${draft.body.entry.id}/reverse`), { date: '2026-09-06' })
  assert.equal(reversal.body.entry.source, 'reversal')
  assert.equal(reversal.body.entry.lines[0].credit, 500_000_00)
  assert.equal((await alice('POST', w(`/journal/${draft.body.entry.id}/reverse`), { date: '2026-09-06' })).body.error.code, 'already-reversed')

  const fromBill = await alice('POST', w(`/journal/${bill.journalEntryId}/reverse`), { date: '2026-09-06' })
  assert.equal(fromBill.body.error.code, 'from-document')
})

test('a non-VAT business: no VAT on sales, and percentage tax on gross sales', async () => {
  const r = await bob('POST', '/api/workspaces', { template: 'general', name: 'Sari-sari ni Bob', tin: '222-333-444-00000', vatStatus: 'non_vat', street: 'Brgy. Bagong Silang, Caloocan City' })
  const bobWs = r.body.workspace.id
  const bw = (p: string) => `/api/w/${bobWs}${p}`
  const accounts = (await bob('GET', bw('/accounts'))).body.accounts as Account[]
  const sales = accounts.find((a) => a.systemKey === 'sales')!.id
  const buyer = (await bob('POST', bw('/contacts'), { name: 'Walk-in customer', isCustomer: true })).body.contact as Contact

  const vatable = await bob('POST', bw('/invoices'), { customerId: buyer.id, date: '2026-07-03', lines: [{ description: 'Rice', quantity: 1, unitPrice: 100_00, vat: 'vatable', accountId: sales }] })
  assert.match(vatable.body.error.message, /non-VAT business/)

  const inv = await bob('POST', bw('/invoices'), { customerId: buyer.id, date: '2026-07-03', lines: [{ description: 'Rice, 25 kg', quantity: 4, unitPrice: 1_250_00, vat: 'none', accountId: sales }] })
  await bob('POST', bw(`/invoices/${inv.body.invoice.id}/post`))
  const pt = (await bob('GET', bw('/reports/percentage-tax?quarter=2026-Q3'))).body.report
  assert.equal(pt.grossSales, 5_000_00)
  assert.equal(pt.rateBp, 300)
  assert.equal(pt.tax, 150_00)

  // Alice's customer and accounts don't exist in Bob's workspace
  const foreign = await bob('POST', bw('/invoices'), { customerId: customer.id, date: '2026-07-03', lines: [{ description: 'x', quantity: 1, unitPrice: 100, vat: 'none', accountId: sales }] })
  assert.equal(foreign.body.error.field, 'customerId')
  const foreignAccount = await bob('POST', bw('/invoices'), { customerId: buyer.id, date: '2026-07-03', lines: [{ description: 'x', quantity: 1, unitPrice: 100, vat: 'none', accountId: accountId.sales }] })
  assert.match(foreignAccount.body.error.message, /choose an account/)
  assert.equal((await bob('GET', bw(`/invoices/${invoice.id}`))).status, 404)
})
