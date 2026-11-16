import { computeLine, computeTotals, DocumentLineInput, VAT_TREATMENT_LABELS, type DocumentLine, type DocumentTotals, type Payment } from '@erp/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { accounts, contacts, documentLines, items, payments, purchaseOrderLines, purchaseOrders, salesLines, salesOrders, taxCodes, type WorkspaceRow } from '../../db/schema.ts'
import type { Executor } from '../../db/types.ts'
import { HttpError } from '../../lib/errors.ts'
import { taxRateOn, VAT_CODE, type PostingLine } from './ledger.ts'

/**
 * What sales invoices and bills have in common: checking the lines, working out their amounts with
 * the rates in force on the document's date, and the journal entry posting makes.
 */

export type DocKind = 'invoice' | 'bill'

type LineInput = z.output<typeof DocumentLineInput>

export type PreparedLine = {
  position: number
  description: string
  quantity: number
  unitPrice: number
  vat: LineInput['vat']
  vatRateBp: number
  accountId: string
  ewtCodeId: string | null
  ewtRateBp: number | null
  atc: string | null
  itemId: string | null
  poLineId: string | null
  soLineId: string | null
  gross: number
  net: number
  vatAmount: number
  ewtAmount: number
}

const lineError = (i: number, message: string) => new HttpError(400, 'invalid', `Line ${i + 1}: ${message}`, 'lines')

/** Checks a draft against the workspace and works out every amount. Throws a message for people. */
export async function prepareDocument(
  db: Executor,
  ws: WorkspaceRow,
  kind: DocKind,
  input: { contactId: string; date: string; pricesIncludeVat: boolean; lines: LineInput[]; warehouseId?: string | null },
): Promise<{ contact: typeof contacts.$inferSelect; lines: PreparedLine[]; totals: DocumentTotals; items: Map<string, typeof items.$inferSelect> }> {
  const contactField = kind === 'invoice' ? 'customerId' : 'supplierId'
  const [contact] = await db.select().from(contacts).where(and(eq(contacts.id, input.contactId), eq(contacts.workspaceId, ws.id)))
  if (!contact || !(kind === 'invoice' ? contact.isCustomer : contact.isSupplier)) {
    throw new HttpError(400, 'invalid', kind === 'invoice' ? 'Choose a customer.' : 'Choose a supplier.', contactField)
  }

  const accountIds = [...new Set(input.lines.map((l) => l.accountId))]
  const accountRows = await db
    .select({ id: accounts.id, type: accounts.type, active: accounts.active })
    .from(accounts)
    .where(and(eq(accounts.workspaceId, ws.id), inArray(accounts.id, accountIds)))
  const accountById = new Map(accountRows.map((a) => [a.id, a]))

  const ewtIds = [...new Set(input.lines.flatMap((l) => (l.ewtCodeId ? [l.ewtCodeId] : [])))]
  const ewtRows = ewtIds.length
    ? await db.select({ id: taxCodes.id, code: taxCodes.code, kind: taxCodes.kind }).from(taxCodes).where(and(eq(taxCodes.workspaceId, ws.id), inArray(taxCodes.id, ewtIds)))
    : []
  const ewtById = new Map(ewtRows.map((t) => [t.id, t]))

  // items on lines (Phase 3)
  const itemIds = [...new Set(input.lines.flatMap((l) => (l.itemId ? [l.itemId] : [])))]
  const itemRows = itemIds.length ? await db.select().from(items).where(and(eq(items.workspaceId, ws.id), inArray(items.id, itemIds))) : []
  const itemById = new Map(itemRows.map((i) => [i.id, i]))
  const poLineIds = [...new Set(input.lines.flatMap((l) => (l.poLineId ? [l.poLineId] : [])))]
  const poLineRows = poLineIds.length
    ? await db
        .select({ line: purchaseOrderLines, supplierId: purchaseOrders.supplierId })
        .from(purchaseOrderLines)
        .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.poId))
        .where(and(eq(purchaseOrderLines.workspaceId, ws.id), inArray(purchaseOrderLines.id, poLineIds)))
    : []
  const poLineById = new Map(poLineRows.map((r) => [r.line.id, r]))
  // sales order lines (Phase 4): their goods already left on a delivery
  const soLineIds = [...new Set(input.lines.flatMap((l) => (l.soLineId ? [l.soLineId] : [])))]
  const soLineRows = soLineIds.length
    ? await db
        .select({ line: salesLines, customerId: salesOrders.customerId })
        .from(salesLines)
        .innerJoin(salesOrders, eq(salesOrders.id, salesLines.orderId))
        .where(and(eq(salesLines.workspaceId, ws.id), inArray(salesLines.id, soLineIds)))
    : []
  const soLineById = new Map(soLineRows.map((r) => [r.line.id, r]))
  const grniId = poLineIds.length ? (await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.workspaceId, ws.id), eq(accounts.systemKey, 'grni'))))[0]?.id : undefined
  const hasStock = input.lines.some((l) => l.itemId && !l.soLineId && itemById.get(l.itemId)?.kind === 'stock')
  if (kind === 'invoice' && hasStock && !input.warehouseId) throw new HttpError(400, 'invalid', 'Choose the warehouse the goods leave from.', 'warehouseId')

  const needsVat = input.lines.some((l) => l.vat === 'vatable')
  const vatRateBp = needsVat ? (await taxRateOn(db, ws.id, VAT_CODE, input.date)).rateBp : 0

  const lines: PreparedLine[] = []
  for (const [i, l] of input.lines.entries()) {
    const item = l.itemId ? itemById.get(l.itemId) : undefined
    if (l.itemId && !item) throw lineError(i, 'that item isn’t in this workspace.')
    if (item && !item.active) throw lineError(i, `${item.name} is turned off.`)
    let accountId = l.accountId
    const poLine = l.poLineId ? poLineById.get(l.poLineId) : undefined
    if (l.poLineId) {
      if (kind !== 'bill' || !poLine) throw lineError(i, 'that purchase order line isn’t in this workspace.')
      if (poLine.supplierId !== input.contactId) throw lineError(i, 'that purchase order is from a different supplier.')
      if (poLine.line.itemId !== l.itemId) throw lineError(i, 'the item doesn’t match the purchase order line.')
      // stock that came in through a PO was put on the books against GRNI; the bill clears it
      if (item?.kind === 'stock') accountId = grniId!
    } else if (kind === 'bill' && item?.kind === 'stock') {
      throw lineError(i, `${item.name} is a stock item: order it on a purchase order and receive it into a warehouse, then bill from the order.`)
    }
    if (l.soLineId) {
      const soLine = soLineById.get(l.soLineId)
      if (kind !== 'invoice' || !soLine) throw lineError(i, 'that sales order line isn’t in this workspace.')
      if (soLine.customerId !== input.contactId) throw lineError(i, 'that sales order is for a different customer.')
      if (soLine.line.itemId !== l.itemId) throw lineError(i, 'the item doesn’t match the sales order line.')
    }
    const account = accountId === grniId && poLine ? { id: accountId, type: 'expense' as const, active: true } : accountById.get(accountId)
    if (!account) throw lineError(i, 'choose an account.')
    if (!account.active) throw lineError(i, 'that account is turned off.')
    if (kind === 'invoice' && account.type !== 'income') throw lineError(i, 'sales go to an income account.')
    if (kind === 'bill' && account.type !== 'expense' && account.type !== 'asset') throw lineError(i, 'purchases go to an expense or asset account.')

    if (kind === 'invoice' && ws.vatStatus === 'vat' && l.vat === 'none') {
      throw lineError(i, 'a VAT-registered business charges VAT. Choose VATable, zero-rated or VAT-exempt.')
    }
    if (kind === 'invoice' && ws.vatStatus === 'non_vat' && l.vat !== 'none') {
      throw lineError(i, `a non-VAT business doesn’t issue ${VAT_TREATMENT_LABELS[l.vat]} sales. Choose Non-VAT.`)
    }

    let ewt: { id: string; rateBp: number; atc: string | null } | null = null
    if (l.ewtCodeId) {
      if (kind === 'invoice') throw lineError(i, 'tax is withheld by the customer when they pay, not on the invoice.')
      const code = ewtById.get(l.ewtCodeId)
      if (!code || code.kind !== 'ewt') throw lineError(i, 'choose a withholding tax code.')
      const inForce = await taxRateOn(db, ws.id, code.code, input.date)
      ewt = { id: code.id, rateBp: inForce.rateBp, atc: inForce.atc }
    }

    const amounts = computeLine({ quantity: l.quantity, unitPrice: l.unitPrice, vat: l.vat, vatRateBp, ewtRateBp: ewt?.rateBp }, input.pricesIncludeVat)
    lines.push({
      position: i,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      vat: l.vat,
      vatRateBp: l.vat === 'vatable' ? vatRateBp : 0,
      accountId,
      ewtCodeId: ewt?.id ?? null,
      ewtRateBp: ewt?.rateBp ?? null,
      atc: ewt?.atc ?? null,
      itemId: l.itemId ?? null,
      poLineId: l.poLineId ?? null,
      soLineId: l.soLineId ?? null,
      ...amounts,
    })
  }
  return { contact, lines, totals: computeTotals(lines), items: itemById }
}

/** Adds up amounts per account, so a 40-line invoice doesn't make 40 ledger lines. */
function byAccount<L extends PreparedLine>(lines: L[], amount: (l: L) => number) {
  const sums = new Map<string, number>()
  for (const l of lines) sums.set(l.accountId, (sums.get(l.accountId) ?? 0) + amount(l))
  return [...sums.entries()]
}

/**
 * The entry a posted document makes.
 *
 * Sales invoice: Dr Accounts Receivable (total) / Cr each income account (net) / Cr Output VAT.
 * Bill: Dr each expense or asset account (net) / Dr Input VAT / Cr Expanded Withholding Tax Payable /
 * Cr Accounts Payable (what's owed after withholding). A non-VAT business can't claim input VAT,
 * so for it the VAT is part of the cost.
 */
export function postingLines(
  kind: DocKind,
  ws: WorkspaceRow,
  contactId: string,
  lines: (PreparedLine & { grniValue?: number })[],
  totals: DocumentTotals,
  system: { ar: string; ap: string; outputVat: string; inputVat: string; ewtPayable: string; priceVariance?: string },
): PostingLine[] {
  if (kind === 'invoice') {
    return [
      { accountId: system.ar, debit: totals.total, contactId },
      ...byAccount(lines, (l) => l.net).map(([accountId, credit]) => ({ accountId, credit, contactId })),
      { accountId: system.outputVat, credit: totals.vatAmount },
    ]
  }
  const claimsInputVat = ws.vatStatus === 'vat'
  const cost = (l: PreparedLine) => (claimsInputVat ? l.net : l.gross)
  // lines for goods received on a PO clear GRNI at the value they came in at; a different price
  // on the bill is purchase price variance
  const viaGrni = lines.filter((l) => l.grniValue !== undefined)
  const variance = viaGrni.reduce((s, l) => s + cost(l) - l.grniValue!, 0)
  return [
    ...byAccount(lines, (l) => (l.grniValue !== undefined ? l.grniValue : cost(l))).map(([accountId, debit]) => ({ accountId, debit, contactId })),
    ...(variance > 0 ? [{ accountId: system.priceVariance!, debit: variance }] : variance < 0 ? [{ accountId: system.priceVariance!, credit: -variance }] : []),
    ...(claimsInputVat ? [{ accountId: system.inputVat, debit: totals.vatAmount }] : []),
    { accountId: system.ewtPayable, credit: totals.ewtAmount, contactId },
    { accountId: system.ap, credit: totals.amountDue, contactId },
  ]
}

export const lineOut = (l: typeof documentLines.$inferSelect): DocumentLine => ({
  id: l.id,
  description: l.description,
  quantity: l.quantity,
  unitPrice: l.unitPrice,
  vat: l.vat,
  vatRateBp: l.vatRateBp,
  accountId: l.accountId,
  ewtCodeId: l.ewtCodeId,
  ewtRateBp: l.ewtRateBp,
  atc: l.atc,
  itemId: l.itemId,
  poLineId: l.poLineId,
  soLineId: l.soLineId,
  gross: l.gross,
  net: l.net,
  vatAmount: l.vatAmount,
  ewtAmount: l.ewtAmount,
})

/** What's been settled on a document so far: payments plus tax withheld, from posted payments only. */
export const settledSql = (column: typeof payments.invoiceId | typeof payments.billId, docId: unknown) =>
  sql<number>`(select coalesce(sum(${payments.amount} + ${payments.withheld}), 0)::bigint from ${payments} where ${column} = ${docId} and ${payments.status} = 'posted')`.mapWith(Number)

export async function paymentsOf(db: Executor, kind: DocKind, docId: string): Promise<Payment[]> {
  const rows = await db
    .select({ p: payments, account: { id: accounts.id, code: accounts.code, name: accounts.name } })
    .from(payments)
    .innerJoin(accounts, eq(accounts.id, payments.accountId))
    .where(kind === 'invoice' ? eq(payments.invoiceId, docId) : eq(payments.billId, docId))
    .orderBy(payments.date, payments.number)
  return rows.map(({ p, account }) => ({
    id: p.id,
    number: p.number,
    kind: p.kind,
    status: p.status,
    date: p.date,
    amount: p.amount,
    withheld: p.withheld,
    reference: p.reference,
    account,
    journalEntryId: p.journalEntryId,
  }))
}

export const totalsOf = (row: DocumentTotals): DocumentTotals => ({
  vatableAmount: row.vatableAmount,
  zeroRatedAmount: row.zeroRatedAmount,
  exemptAmount: row.exemptAmount,
  nonVatAmount: row.nonVatAmount,
  vatAmount: row.vatAmount,
  total: row.total,
  ewtAmount: row.ewtAmount,
  amountDue: row.amountDue,
})
