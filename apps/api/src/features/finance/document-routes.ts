import { randomUUID } from 'node:crypto'
import {
  BillInput,
  DOCUMENT_STATUSES,
  formatPeso,
  InvoiceInput,
  PaymentInput,
  q4,
  ReverseInput,
  type Bill,
  type BillSummary,
  type DocumentTotals,
  type Invoice,
  type InvoiceSummary,
} from '@erp/shared'
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client.ts'
import { accounts, bills, contacts, documentLines, items, payments, projectMilestones, projects, purchaseOrderLines, salesInvoices, stockMoves, timesheets, type WorkspaceRow } from '../../db/schema.ts'
import { invoiceSoLines, uninvoiceSoLines } from '../crm/order-lines.ts'
import { refreshPoStatus, unitBasis } from '../inventory/purchasing.ts'
import { warnLow } from '../inventory/routes.ts'
import { activeWarehouse, itemTotals, lockStockItem, stockIn, stockOut } from '../inventory/stock.ts'
import { iso, type Executor, type Tx } from '../../db/types.ts'
import { audit } from '../../lib/audit.ts'
import { HttpError, parse } from '../../lib/errors.ts'
import { userOf } from '../../lib/session.ts'
import { needs, workspaceOf } from '../../lib/workspace.ts'
import { contactOut } from './setup-routes.ts'
import { lineOut, paymentsOf, postingLines, prepareDocument, settledSql, totalsOf, type DocKind, type PreparedLine } from './documents.ts'
import { nextNumber, postEntry, reverseEntry, todayInManila } from './ledger.ts'

const IdParam = z.object({ id: z.uuid() })
const ListQuery = z.object({ status: z.enum(DOCUMENT_STATUSES).optional(), contactId: z.uuid().optional() })
const VoidInput = ReverseInput.partial()

const WORD: Record<DocKind, string> = { invoice: 'invoice', bill: 'bill' }
const notFound = (kind: DocKind) => new HttpError(404, 'not-found', `That ${WORD[kind]} doesn’t exist.`)
const idOf = (kind: DocKind, params: unknown) => {
  const r = IdParam.safeParse(params)
  if (!r.success) throw notFound(kind)
  return r.data.id
}

type DocRow = typeof salesInvoices.$inferSelect | typeof bills.$inferSelect

/** Fields both kinds send. Balance counts only what a posted document still has owing. */
function baseOut(row: DocRow, settled: number) {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    date: row.date,
    dueDate: row.dueDate,
    pricesIncludeVat: row.pricesIncludeVat,
    notes: row.notes,
    ...totalsOf(row),
    balance: row.status === 'posted' ? row.amountDue - settled : row.status === 'draft' ? row.amountDue : 0,
    postedAt: iso(row.postedAt),
    journalEntryId: row.journalEntryId,
    projectId: row.projectId,
  }
}

/** A project named on an invoice or bill must be this workspace's. */
async function projectIdOf(db: Executor, workspaceId: string, id: string | null | undefined) {
  if (!id) return null
  const [p] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, id), eq(projects.workspaceId, workspaceId)))
  if (!p) throw new HttpError(400, 'invalid', 'Choose a project in this workspace.', 'projectId')
  return p.id
}

/** A voided invoice no longer bills its project's milestones or hours: they can be billed again. */
async function freeProjectBilling(tx: Tx, invoiceId: string) {
  await tx.update(projectMilestones).set({ invoiceId: null, retention: 0 }).where(eq(projectMilestones.invoiceId, invoiceId))
  await tx.update(projects).set({ retentionInvoiceId: null }).where(eq(projects.retentionInvoiceId, invoiceId))
  await tx.update(timesheets).set({ invoiceId: null }).where(eq(timesheets.invoiceId, invoiceId))
}

const lineValues = (workspaceId: string, kind: DocKind, docId: string, lines: PreparedLine[]) =>
  lines.map((l) => ({ ...l, workspaceId, invoiceId: kind === 'invoice' ? docId : null, billId: kind === 'bill' ? docId : null }))

/** The stored lines of a draft, as input again, so posting can recompute them with the rates on its date. */
async function storedLines(db: Executor, kind: DocKind, docId: string) {
  const rows = await db
    .select()
    .from(documentLines)
    .where(kind === 'invoice' ? eq(documentLines.invoiceId, docId) : eq(documentLines.billId, docId))
    .orderBy(asc(documentLines.position))
  return rows.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, vat: l.vat, accountId: l.accountId, ewtCodeId: l.ewtCodeId, itemId: l.itemId, poLineId: l.poLineId, soLineId: l.soLineId }))
}

/** The accounts posting needs, in one query (a transaction has one connection, so no parallel queries). */
async function systemAccounts(db: Executor, workspaceId: string) {
  const keys = ['ar', 'ap', 'output_vat', 'input_vat', 'ewt_payable', 'cwt', 'inventory', 'cogs', 'price_variance'] as const
  const rows = await db.select({ id: accounts.id, key: accounts.systemKey }).from(accounts).where(and(eq(accounts.workspaceId, workspaceId), inArray(accounts.systemKey, [...keys])))
  const id = (key: (typeof keys)[number]) => {
    const row = rows.find((r) => r.key === key)
    if (!row) throw new HttpError(409, 'missing-account', `This workspace has no ${key.replace(/_/g, ' ')} account. Add it to the chart of accounts.`)
    return row.id
  }
  return {
    ar: id('ar'),
    ap: id('ap'),
    outputVat: id('output_vat'),
    inputVat: id('input_vat'),
    ewtPayable: id('ewt_payable'),
    cwt: id('cwt'),
    inventory: id('inventory'),
    cogs: id('cogs'),
    priceVariance: id('price_variance'),
  }
}

/** A cash or bank account of this workspace, for a payment. */
async function cashAccount(db: Executor, workspaceId: string, id: string) {
  const [row] = await db.select().from(accounts).where(and(eq(accounts.id, id), eq(accounts.workspaceId, workspaceId)))
  if (!row || row.type !== 'asset' || (row.subtype !== 'cash' && row.subtype !== 'bank')) throw new HttpError(400, 'invalid', 'Choose a cash or bank account.', 'accountId')
  if (!row.active) throw new HttpError(400, 'invalid', 'That account is turned off.', 'accountId')
  return row
}

function assertTotal(totals: DocumentTotals, kind: DocKind) {
  if (totals.total <= 0) throw new HttpError(400, 'invalid', `A ${WORD[kind]} for ${formatPeso(0)} can’t be posted.`, 'lines')
}

/* =============================================================================================
 * Sales invoices
 * =========================================================================================== */

async function invoiceDetail(db: Executor, workspaceId: string, id: string): Promise<Invoice> {
  const [row] = await db
    .select({ inv: salesInvoices, customer: contacts, settled: settledSql(payments.invoiceId, salesInvoices.id) })
    .from(salesInvoices)
    .innerJoin(contacts, eq(contacts.id, salesInvoices.customerId))
    .where(and(eq(salesInvoices.id, id), eq(salesInvoices.workspaceId, workspaceId)))
  if (!row) throw notFound('invoice')
  const lines = await db.select().from(documentLines).where(eq(documentLines.invoiceId, id)).orderBy(asc(documentLines.position))
  return { ...baseOut(row.inv, row.settled), customer: contactOut(row.customer), warehouseId: row.inv.warehouseId, lines: lines.map(lineOut), payments: await paymentsOf(db, 'invoice', id) }
}

async function lockInvoice(tx: Tx, workspaceId: string, id: string) {
  const [row] = await tx.select().from(salesInvoices).where(and(eq(salesInvoices.id, id), eq(salesInvoices.workspaceId, workspaceId))).for('update')
  if (!row) throw notFound('invoice')
  return row
}

export async function invoiceRoutes(app: FastifyInstance) {
  app.get('/invoices', needs('finance.view'), async (req) => {
    const q = parse(ListQuery, req.query)
    const ws = workspaceOf(req)
    const rows = await db
      .select({ inv: salesInvoices, customer: { id: contacts.id, name: contacts.name }, settled: settledSql(payments.invoiceId, salesInvoices.id) })
      .from(salesInvoices)
      .innerJoin(contacts, eq(contacts.id, salesInvoices.customerId))
      .where(and(eq(salesInvoices.workspaceId, ws.id), q.status ? eq(salesInvoices.status, q.status) : undefined, q.contactId ? eq(salesInvoices.customerId, q.contactId) : undefined))
      .orderBy(desc(salesInvoices.date), desc(salesInvoices.createdAt))
      .limit(500)
    return { invoices: rows.map((r): InvoiceSummary => ({ ...baseOut(r.inv, r.settled), customer: r.customer, warehouseId: r.inv.warehouseId })) }
  })

  app.get('/invoices/:id', needs('finance.view'), async (req) => ({ invoice: await invoiceDetail(db, workspaceOf(req).id, idOf('invoice', req.params)) }))

  app.post('/invoices', needs('finance.edit'), async (req, reply) => {
    const input = parse(InvoiceInput, req.body)
    const ws = workspaceOf(req)
    const prepared = await prepareDocument(db, ws, 'invoice', { ...input, contactId: input.customerId })
    const id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(salesInvoices)
        .values({ workspaceId: ws.id, customerId: input.customerId, projectId: await projectIdOf(tx, ws.id, input.projectId), warehouseId: input.warehouseId ?? null, date: input.date, dueDate: input.dueDate ?? null, pricesIncludeVat: input.pricesIncludeVat, notes: input.notes ?? null, ...prepared.totals, createdBy: userOf(req).id })
        .returning({ id: salesInvoices.id })
      await tx.insert(documentLines).values(lineValues(ws.id, 'invoice', row!.id, prepared.lines))
      await audit(tx, req, { action: 'invoice.drafted', entity: 'invoice', entityId: row!.id, summary: `Drafted a sales invoice for ${prepared.contact.name} (${formatPeso(prepared.totals.total)})` })
      return row!.id
    })
    return reply.code(201).send({ invoice: await invoiceDetail(db, ws.id, id) })
  })

  app.put('/invoices/:id', needs('finance.edit'), async (req) => {
    const id = idOf('invoice', req.params)
    const input = parse(InvoiceInput, req.body)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const current = await lockInvoice(tx, ws.id, id)
      if (current.status !== 'draft') throw new HttpError(409, 'locked', 'A posted invoice can’t be edited. Void it and issue a new one.')
      const prepared = await prepareDocument(tx, ws, 'invoice', { ...input, contactId: input.customerId })
      await tx.delete(documentLines).where(eq(documentLines.invoiceId, id))
      await tx.insert(documentLines).values(lineValues(ws.id, 'invoice', id, prepared.lines))
      await tx
        .update(salesInvoices)
        .set({ customerId: input.customerId, projectId: await projectIdOf(tx, ws.id, input.projectId), warehouseId: input.warehouseId ?? null, date: input.date, dueDate: input.dueDate ?? null, pricesIncludeVat: input.pricesIncludeVat, notes: input.notes ?? null, ...prepared.totals, updatedAt: new Date() })
        .where(eq(salesInvoices.id, id))
      await audit(tx, req, { action: 'invoice.edited', entity: 'invoice', entityId: id, summary: `Edited a draft sales invoice for ${prepared.contact.name} (${formatPeso(prepared.totals.total)})` })
    })
    return { invoice: await invoiceDetail(db, ws.id, id) }
  })

  app.delete('/invoices/:id', needs('finance.edit'), async (req, reply) => {
    const id = idOf('invoice', req.params)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const current = await lockInvoice(tx, ws.id, id)
      if (current.status !== 'draft') throw new HttpError(409, 'locked', 'Only drafts can be deleted. Void a posted invoice instead.')
      await tx.delete(salesInvoices).where(eq(salesInvoices.id, id))
      await audit(tx, req, { action: 'invoice.deleted', entity: 'invoice', entityId: id, summary: `Deleted a draft sales invoice (${formatPeso(current.total)})` })
    })
    return reply.code(204).send()
  })

  /** Posting: takes the next invoice number, freezes the amounts, and makes the journal entry. */
  app.post('/invoices/:id/post', needs('finance.post'), async (req) => {
    const id = idOf('invoice', req.params)
    const ws = workspaceOf(req)
    const user = userOf(req)
    const stockBefore = new Map<string, number>()
    await db.transaction(async (tx) => {
      const current = await lockInvoice(tx, ws.id, id)
      if (current.status !== 'draft') throw new HttpError(409, 'locked', 'That invoice has already been posted.')
      const prepared = await prepareDocument(tx, ws, 'invoice', {
        contactId: current.customerId,
        date: current.date,
        pricesIncludeVat: current.pricesIncludeVat,
        warehouseId: current.warehouseId,
        lines: await storedLines(tx, 'invoice', id),
      })
      assertTotal(prepared.totals, 'invoice')
      // lines from a sales order: their stock went out on the delivery, so only the sale is booked here
      await invoiceSoLines(tx, prepared.lines, prepared.items)
      await tx.delete(documentLines).where(eq(documentLines.invoiceId, id))
      await tx.insert(documentLines).values(lineValues(ws.id, 'invoice', id, prepared.lines))
      const number = await nextNumber(tx, ws.id, 'sales_invoice')
      const system = await systemAccounts(tx, ws.id)
      // stock items leave the warehouse at average cost: cost of sales, in the same entry
      let cogs = 0
      for (const [i, line] of prepared.lines.entries()) {
        const item = line.itemId ? prepared.items.get(line.itemId) : undefined
        if (item?.kind !== 'stock' || line.soLineId) continue
        stockBefore.set(item.id, stockBefore.get(item.id) ?? (await itemTotals(tx, item.id)).qty)
        await activeWarehouse(tx, ws.id, current.warehouseId!)
        const locked = await lockStockItem(tx, ws.id, item.id)
        cogs += await stockOut(tx, ws, { item: locked, warehouseId: current.warehouseId!, quantity: line.quantity, kind: 'issue', date: current.date, invoiceId: id, line: `Line ${i + 1}` })
      }
      const entry = await postEntry(
        tx,
        { workspaceId: ws.id, date: current.date, memo: `Sales invoice ${number} — ${prepared.contact.name}`, source: 'sales_invoice', sourceId: id, createdBy: user.id },
        [
          ...postingLines('invoice', ws, current.customerId, prepared.lines, prepared.totals, system),
          { accountId: system.cogs, debit: cogs },
          { accountId: system.inventory, credit: cogs },
        ],
      )
      await tx
        .update(salesInvoices)
        .set({ status: 'posted', number, ...prepared.totals, journalEntryId: entry.id, postedAt: new Date(), updatedAt: new Date() })
        .where(eq(salesInvoices.id, id))
      await audit(tx, req, { action: 'invoice.posted', entity: 'invoice', entityId: id, summary: `Posted sales invoice ${number} to ${prepared.contact.name} for ${formatPeso(prepared.totals.total)}` })
    })
    if (stockBefore.size) await warnLow(ws, stockBefore)
    return { invoice: await invoiceDetail(db, ws.id, id) }
  })

  /** Voiding keeps the number used and reverses the entry. Payments have to be voided first. */
  app.post('/invoices/:id/void', needs('finance.post'), async (req) => {
    const id = idOf('invoice', req.params)
    const input = parse(VoidInput, req.body)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const current = await lockInvoice(tx, ws.id, id)
      await voidDocument(tx, ws, 'invoice', current, input.date, userOf(req).id)
      await tx.update(salesInvoices).set({ status: 'void', updatedAt: new Date() }).where(eq(salesInvoices.id, id))
      await freeProjectBilling(tx, id)
      await audit(tx, req, { action: 'invoice.voided', entity: 'invoice', entityId: id, summary: `Voided sales invoice ${current.number} (${formatPeso(current.total)})` })
    })
    return { invoice: await invoiceDetail(db, ws.id, id) }
  })

  app.post('/invoices/:id/payments', needs('finance.post'), async (req, reply) => {
    const id = idOf('invoice', req.params)
    const input = parse(PaymentInput, req.body)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const doc = await lockInvoice(tx, ws.id, id)
      await recordPayment(tx, req, ws, 'invoice', doc, doc.customerId, input, userOf(req).id)
    })
    return reply.code(201).send({ invoice: await invoiceDetail(db, ws.id, id) })
  })
}

/* =============================================================================================
 * Bills
 * =========================================================================================== */

async function billDetail(db: Executor, workspaceId: string, id: string): Promise<Bill> {
  const [row] = await db
    .select({ bill: bills, supplier: contacts, settled: settledSql(payments.billId, bills.id) })
    .from(bills)
    .innerJoin(contacts, eq(contacts.id, bills.supplierId))
    .where(and(eq(bills.id, id), eq(bills.workspaceId, workspaceId)))
  if (!row) throw notFound('bill')
  const lines = await db.select().from(documentLines).where(eq(documentLines.billId, id)).orderBy(asc(documentLines.position))
  return {
    ...baseOut(row.bill, row.settled),
    supplierInvoiceNo: row.bill.supplierInvoiceNo,
    supplier: contactOut(row.supplier),
    lines: lines.map(lineOut),
    payments: await paymentsOf(db, 'bill', id),
  }
}

async function lockBill(tx: Tx, workspaceId: string, id: string) {
  const [row] = await tx.select().from(bills).where(and(eq(bills.id, id), eq(bills.workspaceId, workspaceId))).for('update')
  if (!row) throw notFound('bill')
  return row
}

export async function billRoutes(app: FastifyInstance) {
  app.get('/bills', needs('finance.view'), async (req) => {
    const q = parse(ListQuery, req.query)
    const ws = workspaceOf(req)
    const rows = await db
      .select({ bill: bills, supplier: { id: contacts.id, name: contacts.name }, settled: settledSql(payments.billId, bills.id) })
      .from(bills)
      .innerJoin(contacts, eq(contacts.id, bills.supplierId))
      .where(and(eq(bills.workspaceId, ws.id), q.status ? eq(bills.status, q.status) : undefined, q.contactId ? eq(bills.supplierId, q.contactId) : undefined))
      .orderBy(desc(bills.date), desc(bills.createdAt))
      .limit(500)
    return { bills: rows.map((r): BillSummary => ({ ...baseOut(r.bill, r.settled), supplierInvoiceNo: r.bill.supplierInvoiceNo, supplier: r.supplier })) }
  })

  app.get('/bills/:id', needs('finance.view'), async (req) => ({ bill: await billDetail(db, workspaceOf(req).id, idOf('bill', req.params)) }))

  app.post('/bills', needs('finance.edit'), async (req, reply) => {
    const input = parse(BillInput, req.body)
    const ws = workspaceOf(req)
    const prepared = await prepareDocument(db, ws, 'bill', { ...input, contactId: input.supplierId })
    const id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(bills)
        .values({
          workspaceId: ws.id,
          supplierId: input.supplierId,
          projectId: await projectIdOf(tx, ws.id, input.projectId),
          supplierInvoiceNo: input.supplierInvoiceNo ?? null,
          date: input.date,
          dueDate: input.dueDate ?? null,
          pricesIncludeVat: input.pricesIncludeVat,
          notes: input.notes ?? null,
          ...prepared.totals,
          createdBy: userOf(req).id,
        })
        .returning({ id: bills.id })
      await tx.insert(documentLines).values(lineValues(ws.id, 'bill', row!.id, prepared.lines))
      await audit(tx, req, { action: 'bill.drafted', entity: 'bill', entityId: row!.id, summary: `Drafted a bill for ${prepared.contact.name} (${formatPeso(prepared.totals.total)})` })
      return row!.id
    })
    return reply.code(201).send({ bill: await billDetail(db, ws.id, id) })
  })

  app.put('/bills/:id', needs('finance.edit'), async (req) => {
    const id = idOf('bill', req.params)
    const input = parse(BillInput, req.body)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const current = await lockBill(tx, ws.id, id)
      if (current.status !== 'draft') throw new HttpError(409, 'locked', 'A posted bill can’t be edited. Void it and enter it again.')
      const prepared = await prepareDocument(tx, ws, 'bill', { ...input, contactId: input.supplierId })
      await tx.delete(documentLines).where(eq(documentLines.billId, id))
      await tx.insert(documentLines).values(lineValues(ws.id, 'bill', id, prepared.lines))
      await tx
        .update(bills)
        .set({
          supplierId: input.supplierId,
          projectId: await projectIdOf(tx, ws.id, input.projectId),
          supplierInvoiceNo: input.supplierInvoiceNo ?? null,
          date: input.date,
          dueDate: input.dueDate ?? null,
          pricesIncludeVat: input.pricesIncludeVat,
          notes: input.notes ?? null,
          ...prepared.totals,
          updatedAt: new Date(),
        })
        .where(eq(bills.id, id))
      await audit(tx, req, { action: 'bill.edited', entity: 'bill', entityId: id, summary: `Edited a draft bill from ${prepared.contact.name} (${formatPeso(prepared.totals.total)})` })
    })
    return { bill: await billDetail(db, ws.id, id) }
  })

  app.delete('/bills/:id', needs('finance.edit'), async (req, reply) => {
    const id = idOf('bill', req.params)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const current = await lockBill(tx, ws.id, id)
      if (current.status !== 'draft') throw new HttpError(409, 'locked', 'Only drafts can be deleted. Void a posted bill instead.')
      await tx.delete(bills).where(eq(bills.id, id))
      await audit(tx, req, { action: 'bill.deleted', entity: 'bill', entityId: id, summary: `Deleted a draft bill (${formatPeso(current.total)})` })
    })
    return reply.code(204).send()
  })

  app.post('/bills/:id/post', needs('finance.post'), async (req) => {
    const id = idOf('bill', req.params)
    const ws = workspaceOf(req)
    const user = userOf(req)
    await db.transaction(async (tx) => {
      const current = await lockBill(tx, ws.id, id)
      if (current.status !== 'draft') throw new HttpError(409, 'locked', 'That bill has already been posted.')
      const prepared = await prepareDocument(tx, ws, 'bill', { contactId: current.supplierId, date: current.date, pricesIncludeVat: current.pricesIncludeVat, lines: await storedLines(tx, 'bill', id) })
      // lines billing a purchase order: no more than was received (or ordered, for services)
      const billing = await billPoLines(tx, ws, prepared.lines, prepared.items)
      assertTotal(prepared.totals, 'bill')
      await tx.delete(documentLines).where(eq(documentLines.billId, id))
      await tx.insert(documentLines).values(lineValues(ws.id, 'bill', id, prepared.lines))
      const number = await nextNumber(tx, ws.id, 'bill')
      const ref = current.supplierInvoiceNo ? ` (their no. ${current.supplierInvoiceNo})` : ''
      const entry = await postEntry(
        tx,
        { workspaceId: ws.id, date: current.date, memo: `Bill ${number} — ${prepared.contact.name}${ref}`, source: 'bill', sourceId: id, createdBy: user.id },
        postingLines('bill', ws, current.supplierId, billing, prepared.totals, await systemAccounts(tx, ws.id)),
      )
      await tx.update(bills).set({ status: 'posted', number, ...prepared.totals, journalEntryId: entry.id, postedAt: new Date(), updatedAt: new Date() }).where(eq(bills.id, id))
      await audit(tx, req, { action: 'bill.posted', entity: 'bill', entityId: id, summary: `Posted bill ${number} from ${prepared.contact.name} for ${formatPeso(prepared.totals.total)}` })
    })
    return { bill: await billDetail(db, ws.id, id) }
  })

  app.post('/bills/:id/void', needs('finance.post'), async (req) => {
    const id = idOf('bill', req.params)
    const input = parse(VoidInput, req.body)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const current = await lockBill(tx, ws.id, id)
      await voidDocument(tx, ws, 'bill', current, input.date, userOf(req).id)
      await tx.update(bills).set({ status: 'void', updatedAt: new Date() }).where(eq(bills.id, id))
      await audit(tx, req, { action: 'bill.voided', entity: 'bill', entityId: id, summary: `Voided bill ${current.number} (${formatPeso(current.total)})` })
    })
    return { bill: await billDetail(db, ws.id, id) }
  })

  app.post('/bills/:id/payments', needs('finance.post'), async (req, reply) => {
    const id = idOf('bill', req.params)
    const input = parse(PaymentInput, req.body)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const doc = await lockBill(tx, ws.id, id)
      await recordPayment(tx, req, ws, 'bill', doc, doc.supplierId, input, userOf(req).id)
    })
    return reply.code(201).send({ bill: await billDetail(db, ws.id, id) })
  })
}

/* =============================================================================================
 * Shared by both: voiding and payments
 * =========================================================================================== */

async function voidDocument(tx: Tx, ws: WorkspaceRow, kind: DocKind, doc: DocRow, date: string | undefined, userId: string) {
  if (doc.status === 'draft') throw new HttpError(409, 'not-posted', `A draft ${WORD[kind]} can be deleted instead.`)
  if (doc.status === 'void') throw new HttpError(409, 'already-void', `That ${WORD[kind]} is already void.`)
  const [live] = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(and(kind === 'invoice' ? eq(payments.invoiceId, doc.id) : eq(payments.billId, doc.id), eq(payments.status, 'posted')))
    .limit(1)
  if (live) throw new HttpError(409, 'has-payments', `Void the payments on this ${WORD[kind]} first.`)
  const on = date ?? maxDate(todayInManila(), doc.date)
  await reverseEntry(tx, ws.id, doc.journalEntryId!, on, userId, `Void of ${kind === 'invoice' ? 'sales invoice' : 'bill'} ${doc.number}`)
  if (kind === 'invoice') {
    // the stock it took comes back, lot by lot, at the value it left at (the reversal undid the cost of sales)
    const issued = await tx.select().from(stockMoves).where(and(eq(stockMoves.invoiceId, doc.id), eq(stockMoves.kind, 'issue')))
    for (const m of issued) {
      const item = await lockStockItem(tx, ws.id, m.itemId)
      await stockIn(tx, ws, { item, warehouseId: m.warehouseId, lotId: m.lotId, quantity: -m.quantity, value: -m.value, kind: 'return', date: on, invoiceId: doc.id })
    }
    // what it billed on sales orders can be invoiced again (the goods stay delivered)
    await uninvoiceSoLines(tx, doc.id)
  } else {
    // what it billed on purchase orders can be billed again
    const lines = await tx.select().from(documentLines).where(and(eq(documentLines.billId, doc.id), isNotNull(documentLines.poLineId)))
    const pos = new Set<string>()
    for (const l of lines) {
      const [pl] = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.id, l.poLineId!)).for('update')
      await tx.update(purchaseOrderLines).set({ billedQty: q4(pl!.billedQty - l.quantity) }).where(eq(purchaseOrderLines.id, pl!.id))
      pos.add(pl!.poId)
    }
    for (const po of pos) await refreshPoStatus(tx, po)
  }
}

const maxDate = (a: string, b: string) => (a > b ? a : b)

/**
 * Money received against an invoice or paid against a bill.
 *
 * Received: Dr Cash/Bank (amount) / Dr Creditable Withholding Tax (withheld) / Cr Accounts Receivable.
 * Made:     Dr Accounts Payable / Cr Cash/Bank. Tax withheld from suppliers is already on the bill.
 */
async function recordPayment(tx: Tx, req: FastifyRequest, ws: WorkspaceRow, kind: DocKind, doc: DocRow, contactId: string, input: z.output<typeof PaymentInput>, userId: string) {
  if (doc.status !== 'posted') throw new HttpError(409, 'not-posted', `Payments can only be recorded on a posted ${WORD[kind]}.`)
  if (kind === 'bill' && input.withheld > 0) throw new HttpError(400, 'invalid', 'Tax withheld from a supplier goes on the bill itself, not on the payment.', 'withheld')
  if (input.date < doc.date) throw new HttpError(400, 'invalid', `A payment can’t be dated before the ${WORD[kind]}.`, 'date')
  const [paid] = await tx
    .select({ settled: sql<number>`coalesce(sum(${payments.amount} + ${payments.withheld}), 0)::bigint`.mapWith(Number) })
    .from(payments)
    .where(and(kind === 'invoice' ? eq(payments.invoiceId, doc.id) : eq(payments.billId, doc.id), eq(payments.status, 'posted')))
  const balance = doc.amountDue - (paid?.settled ?? 0)
  const settling = input.amount + input.withheld
  if (settling > balance) throw new HttpError(400, 'invalid', `That’s more than the ${formatPeso(balance)} still owed.`, 'amount')

  const account = await cashAccount(tx, ws.id, input.accountId)
  const system = await systemAccounts(tx, ws.id)
  const paymentId = randomUUID()
  const number = await nextNumber(tx, ws.id, kind === 'invoice' ? 'payment_received' : 'payment_made')
  const [contact] = await tx.select({ name: contacts.name }).from(contacts).where(eq(contacts.id, contactId))
  const entry = await postEntry(
    tx,
    {
      workspaceId: ws.id,
      date: input.date,
      memo: kind === 'invoice' ? `${number} — payment from ${contact!.name} for ${doc.number}` : `${number} — payment to ${contact!.name} for ${doc.number}`,
      source: kind === 'invoice' ? 'payment_received' : 'payment_made',
      sourceId: paymentId,
      createdBy: userId,
    },
    kind === 'invoice'
      ? [
          { accountId: account.id, debit: input.amount, contactId },
          { accountId: system.cwt, debit: input.withheld, contactId },
          { accountId: system.ar, credit: settling, contactId },
        ]
      : [
          { accountId: system.ap, debit: input.amount, contactId },
          { accountId: account.id, credit: input.amount, contactId },
        ],
  )
  await tx.insert(payments).values({
    id: paymentId,
    workspaceId: ws.id,
    number,
    kind: kind === 'invoice' ? 'received' : 'made',
    invoiceId: kind === 'invoice' ? doc.id : null,
    billId: kind === 'bill' ? doc.id : null,
    date: input.date,
    accountId: account.id,
    amount: input.amount,
    withheld: input.withheld,
    reference: input.reference ?? null,
    journalEntryId: entry.id,
    createdBy: userId,
  })
  const withheld = input.withheld ? ` (${formatPeso(input.withheld)} withheld)` : ''
  await audit(tx, req, {
    action: kind === 'invoice' ? 'payment.received' : 'payment.made',
    entity: 'payment',
    entityId: paymentId,
    summary: kind === 'invoice' ? `Recorded ${number}: ${formatPeso(input.amount)}${withheld} from ${contact!.name} for ${doc.number}` : `Recorded ${number}: paid ${formatPeso(input.amount)} to ${contact!.name} for ${doc.number}`,
  })
}

export async function paymentRoutes(app: FastifyInstance) {
  app.post('/payments/:id/void', needs('finance.post'), async (req) => {
    const r = IdParam.safeParse(req.params)
    if (!r.success) throw new HttpError(404, 'not-found', 'That payment doesn’t exist.')
    const input = parse(VoidInput, req.body)
    const ws = workspaceOf(req)
    const result = await db.transaction(async (tx) => {
      const [p] = await tx.select().from(payments).where(and(eq(payments.id, r.data.id), eq(payments.workspaceId, ws.id))).for('update')
      if (!p) throw new HttpError(404, 'not-found', 'That payment doesn’t exist.')
      if (p.status === 'void') throw new HttpError(409, 'already-void', 'That payment is already void.')
      await reverseEntry(tx, ws.id, p.journalEntryId, input.date ?? maxDate(todayInManila(), p.date), userOf(req).id, `Void of payment ${p.number}`)
      await tx.update(payments).set({ status: 'void' }).where(eq(payments.id, p.id))
      await audit(tx, req, { action: 'payment.voided', entity: 'payment', entityId: p.id, summary: `Voided payment ${p.number} (${formatPeso(p.amount)})` })
      return p.invoiceId ? { kind: 'invoice' as const, id: p.invoiceId } : { kind: 'bill' as const, id: p.billId! }
    })
    return result.kind === 'invoice' ? { invoice: await invoiceDetail(db, ws.id, result.id) } : { bill: await billDetail(db, ws.id, result.id) }
  })
}

/**
 * Bill lines that pay for purchase-order lines: checks there's that much left to bill, records it
 * as billed, and works out the GRNI each clears (what the goods came in at). Returns the lines
 * ready for postingLines.
 */
async function billPoLines(tx: Tx, ws: WorkspaceRow, lines: PreparedLine[], itemsById: Map<string, typeof items.$inferSelect>) {
  const out: (PreparedLine & { grniValue?: number })[] = []
  const pos = new Set<string>()
  for (const [i, line] of lines.entries()) {
    if (!line.poLineId) {
      out.push(line)
      continue
    }
    const [pl] = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.id, line.poLineId)).for('update')
    const item = itemsById.get(line.itemId!)!
    const ceiling = item.kind === 'stock' ? pl!.receivedQty : pl!.quantity
    const left = q4(ceiling - pl!.billedQty)
    if (line.quantity > left) {
      throw new HttpError(409, 'over-billed', `Line ${i + 1}: only ${left} of ${item.name} ${item.kind === 'stock' ? 'has been received and not billed' : 'is left to bill'} on that purchase order.`, 'lines')
    }
    await tx.update(purchaseOrderLines).set({ billedQty: q4(pl!.billedQty + line.quantity) }).where(eq(purchaseOrderLines.id, pl!.id))
    pos.add(pl!.poId)
    out.push(item.kind === 'stock' ? { ...line, grniValue: Math.round(line.quantity * unitBasis(ws, pl!)) } : line)
  }
  for (const po of pos) await refreshPoStatus(tx, po)
  return out
}
