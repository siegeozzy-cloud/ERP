import { formatPeso, JOURNAL_SOURCES, JournalInput, ReverseInput, type JournalEntry, type JournalEntrySummary } from '@erp/shared'
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client.ts'
import { accounts, journalEntries, journalLines } from '../../db/schema.ts'
import type { Executor } from '../../db/types.ts'
import { audit } from '../../lib/audit.ts'
import { HttpError, parse } from '../../lib/errors.ts'
import { userOf } from '../../lib/session.ts'
import { needs, workspaceOf } from '../../lib/workspace.ts'
import { assertAccountsUsable, nextNumber, reverseEntry } from './ledger.ts'

const IdParam = z.object({ id: z.uuid() })
const ListQuery = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  source: z.enum(JOURNAL_SOURCES).optional(),
  status: z.enum(['draft', 'posted']).optional(),
})
const notFound = () => new HttpError(404, 'not-found', 'That journal entry doesn’t exist.')
const idOf = (params: unknown) => {
  const r = IdParam.safeParse(params)
  if (!r.success) throw notFound()
  return r.data.id
}

const totalSql = sql<number>`(select coalesce(sum(${journalLines.debit}), 0)::bigint from ${journalLines} where ${journalLines.entryId} = ${journalEntries.id})`.mapWith(Number)

const summaryOut = (e: typeof journalEntries.$inferSelect, total: number): JournalEntrySummary => ({
  id: e.id,
  number: e.number,
  status: e.status,
  date: e.date,
  memo: e.memo,
  source: e.source,
  sourceId: e.sourceId,
  total,
  reversesId: e.reversesId,
  reversedById: e.reversedById,
})

/** Entries with their lines, for the entry page and the books of accounts. */
export async function entriesWithLines(db: Executor, workspaceId: string, entryIds: string[]) {
  if (entryIds.length === 0) return new Map<string, JournalEntry['lines']>()
  const rows = await db
    .select({ line: journalLines, account: { id: accounts.id, code: accounts.code, name: accounts.name } })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(eq(journalLines.workspaceId, workspaceId), inArray(journalLines.entryId, entryIds)))
    .orderBy(asc(journalLines.position))
  const byEntry = new Map<string, JournalEntry['lines']>()
  for (const { line, account } of rows) {
    const list = byEntry.get(line.entryId) ?? []
    list.push({ id: line.id, account, debit: line.debit, credit: line.credit, description: line.description })
    byEntry.set(line.entryId, list)
  }
  return byEntry
}

async function entryDetail(db: Executor, workspaceId: string, id: string): Promise<JournalEntry> {
  const [row] = await db
    .select({ e: journalEntries, total: totalSql })
    .from(journalEntries)
    .where(and(eq(journalEntries.id, id), eq(journalEntries.workspaceId, workspaceId)))
  if (!row) throw notFound()
  return { ...summaryOut(row.e, row.total), lines: (await entriesWithLines(db, workspaceId, [id])).get(id) ?? [] }
}

export default async function journalRoutes(app: FastifyInstance) {
  app.get('/journal', needs('finance.view'), async (req) => {
    const q = parse(ListQuery, req.query)
    const ws = workspaceOf(req)
    const rows = await db
      .select({ e: journalEntries, total: totalSql })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.workspaceId, ws.id),
          q.from ? gte(journalEntries.date, q.from) : undefined,
          q.to ? lte(journalEntries.date, q.to) : undefined,
          q.source ? eq(journalEntries.source, q.source) : undefined,
          q.status ? eq(journalEntries.status, q.status) : undefined,
        ),
      )
      .orderBy(desc(journalEntries.date), desc(journalEntries.number), desc(journalEntries.createdAt))
      .limit(500)
    return { entries: rows.map((r) => summaryOut(r.e, r.total)) }
  })

  app.get('/journal/:id', needs('finance.view'), async (req) => ({ entry: await entryDetail(db, workspaceOf(req).id, idOf(req.params)) }))

  /** A manual entry starts as a draft, which can be changed until it's posted. */
  app.post('/journal', needs('finance.edit'), async (req, reply) => {
    const input = parse(JournalInput, req.body)
    const ws = workspaceOf(req)
    await assertAccountsUsable(db, ws.id, input.lines.map((l) => l.accountId))
    const id = await db.transaction(async (tx) => {
      const [entry] = await tx
        .insert(journalEntries)
        .values({ workspaceId: ws.id, date: input.date, memo: input.memo, source: 'manual', createdBy: userOf(req).id })
        .returning({ id: journalEntries.id })
      await tx.insert(journalLines).values(input.lines.map((l, position) => ({ ...l, description: l.description ?? null, entryId: entry!.id, workspaceId: ws.id, position })))
      await audit(tx, req, { action: 'journal.drafted', entity: 'journal_entry', entityId: entry!.id, summary: `Drafted a journal entry: ${input.memo} (${formatPeso(input.lines.reduce((t, l) => t + l.debit, 0))})` })
      return entry!.id
    })
    return reply.code(201).send({ entry: await entryDetail(db, ws.id, id) })
  })

  app.put('/journal/:id', needs('finance.edit'), async (req) => {
    const id = idOf(req.params)
    const input = parse(JournalInput, req.body)
    const ws = workspaceOf(req)
    await assertAccountsUsable(db, ws.id, input.lines.map((l) => l.accountId))
    await db.transaction(async (tx) => {
      const [current] = await tx.select().from(journalEntries).where(and(eq(journalEntries.id, id), eq(journalEntries.workspaceId, ws.id))).for('update')
      if (!current) throw notFound()
      if (current.status !== 'draft') throw new HttpError(409, 'locked', 'A posted entry can’t be changed. Reverse it instead.')
      await tx.delete(journalLines).where(eq(journalLines.entryId, id))
      await tx.insert(journalLines).values(input.lines.map((l, position) => ({ ...l, description: l.description ?? null, entryId: id, workspaceId: ws.id, position })))
      await tx.update(journalEntries).set({ date: input.date, memo: input.memo }).where(eq(journalEntries.id, id))
      await audit(tx, req, { action: 'journal.edited', entity: 'journal_entry', entityId: id, summary: `Edited a draft journal entry: ${input.memo} (${formatPeso(input.lines.reduce((t, l) => t + l.debit, 0))})` })
    })
    return { entry: await entryDetail(db, ws.id, id) }
  })

  app.delete('/journal/:id', needs('finance.edit'), async (req, reply) => {
    const id = idOf(req.params)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const [current] = await tx.select().from(journalEntries).where(and(eq(journalEntries.id, id), eq(journalEntries.workspaceId, ws.id))).for('update')
      if (!current) throw notFound()
      if (current.status !== 'draft') throw new HttpError(409, 'locked', 'Only drafts can be deleted. Reverse a posted entry instead.')
      await tx.delete(journalEntries).where(eq(journalEntries.id, id))
      await audit(tx, req, { action: 'journal.deleted', entity: 'journal_entry', entityId: id, summary: `Deleted a draft journal entry: ${current.memo}` })
    })
    return reply.code(204).send()
  })

  app.post('/journal/:id/post', needs('finance.post'), async (req) => {
    const id = idOf(req.params)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const [current] = await tx.select().from(journalEntries).where(and(eq(journalEntries.id, id), eq(journalEntries.workspaceId, ws.id))).for('update')
      if (!current) throw notFound()
      if (current.status !== 'draft') throw new HttpError(409, 'locked', 'That entry has already been posted.')
      const lines = await tx.select({ accountId: journalLines.accountId }).from(journalLines).where(eq(journalLines.entryId, id))
      await assertAccountsUsable(tx, ws.id, lines.map((l) => l.accountId))
      const number = await nextNumber(tx, ws.id, 'journal')
      // the database checks the balance again as the status changes
      await tx.update(journalEntries).set({ status: 'posted', number, postedAt: new Date() }).where(eq(journalEntries.id, id))
      await audit(tx, req, { action: 'journal.posted', entity: 'journal_entry', entityId: id, summary: `Posted journal entry ${number}: ${current.memo}` })
    })
    return { entry: await entryDetail(db, ws.id, id) }
  })

  /**
   * Reverses a manual entry. Entries made by invoices, bills and payments are reversed by voiding
   * those, so the document and the books never disagree.
   */
  app.post('/journal/:id/reverse', needs('finance.post'), async (req) => {
    const id = idOf(req.params)
    const input = parse(ReverseInput, req.body)
    const ws = workspaceOf(req)
    const reversal = await db.transaction(async (tx) => {
      const [current] = await tx.select({ source: journalEntries.source, number: journalEntries.number }).from(journalEntries).where(and(eq(journalEntries.id, id), eq(journalEntries.workspaceId, ws.id)))
      if (!current) throw notFound()
      if (current.source !== 'manual') throw new HttpError(409, 'from-document', 'This entry was made by a document. Void the invoice, bill or payment instead.')
      const reversal = await reverseEntry(tx, ws.id, id, input.date, userOf(req).id)
      await audit(tx, req, { action: 'journal.reversed', entity: 'journal_entry', entityId: id, summary: `Reversed journal entry ${current.number} with ${reversal.number}` })
      return reversal
    })
    return { entry: await entryDetail(db, ws.id, reversal.id) }
  })
}
