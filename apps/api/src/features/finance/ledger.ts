import type { JournalSource } from '@erp/shared'
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm'
import { accounts, journalEntries, journalLines, sequences, taxCodes } from '../../db/schema.ts'
import type { Executor, Tx } from '../../db/types.ts'
import { HttpError } from '../../lib/errors.ts'
import type { SequenceKind } from './seed.ts'

/**
 * The next number for a kind of document, e.g. SI-000042. Must run inside the transaction that
 * posts the document: the row stays locked until it commits, and a rollback gives the number back,
 * so the series never has gaps.
 */
export async function nextNumber(tx: Tx, workspaceId: string, kind: SequenceKind) {
  const [row] = await tx
    .update(sequences)
    .set({ next: sql`${sequences.next} + 1` })
    .where(and(eq(sequences.workspaceId, workspaceId), eq(sequences.kind, kind)))
    .returning({ prefix: sequences.prefix, next: sequences.next })
  if (!row) throw new Error(`No ${kind} sequence for workspace ${workspaceId}`)
  return `${row.prefix}${String(row.next - 1).padStart(6, '0')}`
}

/** An account the system posts to by itself (see seed.ts `key`). */
export async function systemAccount(db: Executor, workspaceId: string, key: string) {
  const [row] = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.systemKey, key)))
  if (!row) throw new HttpError(409, 'missing-account', `This workspace has no ${key.replace(/_/g, ' ')} account. Add it to the chart of accounts.`)
  return row.id
}

/** An account only some templates have (e.g. `spoilage`), or null. */
export async function systemAccountIfAny(db: Executor, workspaceId: string, key: string) {
  const [row] = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.systemKey, key), eq(accounts.active, true)))
  return row?.id ?? null
}

/** The rate in force on `date` for a tax code: the newest row that started on or before it. */
export async function taxRateOn(db: Executor, workspaceId: string, code: string, date: string) {
  const [row] = await db
    .select()
    .from(taxCodes)
    .where(and(eq(taxCodes.workspaceId, workspaceId), eq(taxCodes.code, code), eq(taxCodes.active, true), lte(taxCodes.effectiveFrom, date)))
    .orderBy(desc(taxCodes.effectiveFrom))
    .limit(1)
  if (!row) throw new HttpError(409, 'missing-tax-code', `No ${code} tax rate is in force on ${date}.`)
  return row
}

export const VAT_CODE = 'VAT12'
export const PERCENTAGE_TAX_CODE = 'PT3'

export type PostingLine = { accountId: string; debit?: number; credit?: number; description?: string | null; contactId?: string | null }

/**
 * Posts a balanced journal entry and returns it. Lines of zero are dropped; lines on the same
 * account and side with no description of their own are kept apart (they read better that way in
 * the books). The database checks the balance again as the entry is posted.
 */
export async function postEntry(
  tx: Tx,
  entry: { workspaceId: string; date: string; memo: string; source: JournalSource; sourceId?: string | null; createdBy: string; reversesId?: string | null },
  lines: PostingLine[],
) {
  const kept = lines.filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0)
  const debits = kept.reduce((s, l) => s + (l.debit ?? 0), 0)
  const credits = kept.reduce((s, l) => s + (l.credit ?? 0), 0)
  if (debits !== credits || debits === 0) throw new HttpError(400, 'unbalanced', 'Debits and credits must be equal, and more than zero.')
  await assertAccountsUsable(tx, entry.workspaceId, kept.map((l) => l.accountId))

  const [draft] = await tx
    .insert(journalEntries)
    .values({ workspaceId: entry.workspaceId, date: entry.date, memo: entry.memo, source: entry.source, sourceId: entry.sourceId ?? null, reversesId: entry.reversesId ?? null, createdBy: entry.createdBy })
    .returning({ id: journalEntries.id })
  await tx.insert(journalLines).values(
    kept.map((l, position) => ({
      entryId: draft!.id,
      workspaceId: entry.workspaceId,
      accountId: l.accountId,
      debit: l.debit ?? 0,
      credit: l.credit ?? 0,
      description: l.description ?? null,
      contactId: l.contactId ?? null,
      position,
    })),
  )
  const number = await nextNumber(tx, entry.workspaceId, 'journal')
  await tx.update(journalEntries).set({ status: 'posted', number, postedAt: new Date() }).where(eq(journalEntries.id, draft!.id))
  return { id: draft!.id, number }
}

/** Accounts must belong to this workspace and be active. */
export async function assertAccountsUsable(db: Executor, workspaceId: string, accountIds: string[]) {
  const ids = [...new Set(accountIds)]
  if (ids.length === 0) return
  const found = await db.select({ id: accounts.id, active: accounts.active }).from(accounts).where(and(eq(accounts.workspaceId, workspaceId), inArray(accounts.id, ids)))
  if (found.length !== ids.length) throw new HttpError(400, 'invalid', 'One of the accounts doesn’t exist in this workspace.', 'accountId')
  if (found.some((a) => !a.active)) throw new HttpError(400, 'invalid', 'One of the accounts is inactive. Turn it back on or choose another.', 'accountId')
}

/**
 * Reverses a posted entry: a new posted entry with every debit and credit swapped, dated `date`,
 * and the original marked as reversed. The original stays exactly as it was.
 */
export async function reverseEntry(tx: Tx, workspaceId: string, entryId: string, date: string, createdBy: string, memo?: string) {
  const [original] = await tx
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.id, entryId), eq(journalEntries.workspaceId, workspaceId)))
    .for('update')
  if (!original) throw new HttpError(404, 'not-found', 'That journal entry doesn’t exist.')
  if (original.status !== 'posted') throw new HttpError(409, 'not-posted', 'Only posted entries can be reversed. Delete the draft instead.')
  if (original.reversedById) throw new HttpError(409, 'already-reversed', 'That entry has already been reversed.')
  if (date < original.date) throw new HttpError(400, 'invalid', 'A reversal can’t be dated before the entry it reverses.', 'date')
  const lines = await tx.select().from(journalLines).where(eq(journalLines.entryId, entryId))
  const reversal = await postEntry(
    tx,
    { workspaceId, date, memo: memo ?? `Reversal of ${original.number}: ${original.memo}`, source: 'reversal', sourceId: original.sourceId, createdBy, reversesId: original.id },
    lines.map((l) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit, description: l.description, contactId: l.contactId })),
  )
  await tx.update(journalEntries).set({ reversedById: reversal.id }).where(eq(journalEntries.id, original.id))
  return reversal
}

/** The date in the Philippines right now, as YYYY-MM-DD. Documents are dated in local time. */
export const todayInManila = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())
