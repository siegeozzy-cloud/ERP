import { AccountInput, AccountUpdate, ContactInput, type Account, type Contact, type TaxCode } from '@erp/shared'
import { and, asc, eq, ilike, or } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db, isUniqueViolation } from '../../db/client.ts'
import { accounts, contacts, taxCodes } from '../../db/schema.ts'
import { audit } from '../../lib/audit.ts'
import { HttpError, parse } from '../../lib/errors.ts'
import { needs, workspaceOf } from '../../lib/workspace.ts'

const IdParam = z.object({ id: z.uuid() })
const idOf = (params: unknown, what: string) => {
  const r = IdParam.safeParse(params)
  if (!r.success) throw new HttpError(404, 'not-found', `That ${what} doesn’t exist.`)
  return r.data.id
}

const accountOut = (a: typeof accounts.$inferSelect): Account => ({ id: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype, systemKey: a.systemKey, active: a.active })

export const contactOut = (c: typeof contacts.$inferSelect): Contact => ({
  id: c.id,
  name: c.name,
  tin: c.tin,
  address: c.address,
  email: c.email,
  phone: c.phone,
  isCustomer: c.isCustomer,
  isSupplier: c.isSupplier,
  defaultEwtCodeId: c.defaultEwtCodeId,
})

const taxOut = (t: typeof taxCodes.$inferSelect): TaxCode => ({ id: t.id, kind: t.kind, code: t.code, name: t.name, rateBp: t.rateBp, atc: t.atc, effectiveFrom: t.effectiveFrom, active: t.active })

const ContactQuery = z.object({ role: z.enum(['customer', 'supplier']).optional(), q: z.string().trim().max(100).optional() })

/** Chart of accounts, tax codes and contacts: the lists the documents draw from. */
export default async function setupRoutes(app: FastifyInstance) {
  /* ---------- accounts ---------- */

  app.get('/accounts', needs('finance.view'), async (req) => {
    const rows = await db.select().from(accounts).where(eq(accounts.workspaceId, workspaceOf(req).id)).orderBy(asc(accounts.code))
    return { accounts: rows.map(accountOut) }
  })

  app.post('/accounts', needs('finance.edit'), async (req, reply) => {
    const input = parse(AccountInput, req.body)
    if (input.subtype !== 'other' && input.type !== 'asset') throw new HttpError(400, 'invalid', 'Only asset accounts can be cash or bank accounts.', 'subtype')
    try {
      const row = await db.transaction(async (tx) => {
        const [r] = await tx.insert(accounts).values({ ...input, workspaceId: workspaceOf(req).id }).returning()
        await audit(tx, req, { action: 'account.created', entity: 'account', entityId: r!.id, summary: `Added account ${r!.code} ${r!.name}` })
        return r!
      })
      return reply.code(201).send({ account: accountOut(row) })
    } catch (e) {
      if (isUniqueViolation(e, 'accounts_code_key')) throw new HttpError(409, 'taken', `Account code ${input.code} is already used.`, 'code')
      throw e
    }
  })

  /** Rename, or turn on and off. The code and type can't change once entries may point at them. */
  app.patch('/accounts/:id', needs('finance.edit'), async (req) => {
    const id = idOf(req.params, 'account')
    const input = parse(AccountUpdate, req.body)
    const ws = workspaceOf(req)
    const [current] = await db.select().from(accounts).where(and(eq(accounts.id, id), eq(accounts.workspaceId, ws.id)))
    if (!current) throw new HttpError(404, 'not-found', 'That account doesn’t exist.')
    if (current.systemKey && !input.active) throw new HttpError(409, 'system-account', 'The system posts to this account by itself, so it can’t be turned off.', 'active')
    const row = await db.transaction(async (tx) => {
      const [r] = await tx.update(accounts).set(input).where(eq(accounts.id, id)).returning()
      const what = current.active !== input.active ? (input.active ? 'Turned on' : 'Turned off') : 'Renamed'
      await audit(tx, req, {
        action: 'account.updated',
        entity: 'account',
        entityId: id,
        summary: `${what} account ${current.code} ${input.name}`,
        before: { name: current.name, active: current.active },
        after: { name: input.name, active: input.active },
      })
      return r!
    })
    return { account: accountOut(row) }
  })

  /* ---------- tax codes ---------- */

  app.get('/tax-codes', needs('finance.view'), async (req) => {
    const rows = await db.select().from(taxCodes).where(eq(taxCodes.workspaceId, workspaceOf(req).id)).orderBy(asc(taxCodes.kind), asc(taxCodes.code), asc(taxCodes.effectiveFrom))
    return { taxCodes: rows.map(taxOut) }
  })

  /* ---------- contacts ---------- */

  app.get('/contacts', needs('finance.view'), async (req) => {
    const query = parse(ContactQuery, req.query)
    const ws = workspaceOf(req)
    const rows = await db
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.workspaceId, ws.id),
          query.role === 'customer' ? eq(contacts.isCustomer, true) : query.role === 'supplier' ? eq(contacts.isSupplier, true) : undefined,
          query.q ? or(ilike(contacts.name, `%${query.q.replace(/[%_\\]/g, '\\$&')}%`), ilike(contacts.tin, `%${query.q.replace(/[%_\\]/g, '\\$&')}%`)) : undefined,
        ),
      )
      .orderBy(asc(contacts.name))
      .limit(500)
    return { contacts: rows.map(contactOut) }
  })

  app.get('/contacts/:id', needs('finance.view'), async (req) => {
    const id = idOf(req.params, 'contact')
    const [row] = await db.select().from(contacts).where(and(eq(contacts.id, id), eq(contacts.workspaceId, workspaceOf(req).id)))
    if (!row) throw new HttpError(404, 'not-found', 'That contact doesn’t exist.')
    return { contact: contactOut(row) }
  })

  async function checkEwtCode(workspaceId: string, id: string | null | undefined) {
    if (!id) return
    const [row] = await db.select({ kind: taxCodes.kind }).from(taxCodes).where(and(eq(taxCodes.id, id), eq(taxCodes.workspaceId, workspaceId)))
    if (row?.kind !== 'ewt') throw new HttpError(400, 'invalid', 'Choose a withholding tax code.', 'defaultEwtCodeId')
  }

  app.post('/contacts', needs('finance.edit'), async (req, reply) => {
    const input = parse(ContactInput, req.body)
    const ws = workspaceOf(req)
    await checkEwtCode(ws.id, input.defaultEwtCodeId)
    const row = await db.transaction(async (tx) => {
      const [r] = await tx.insert(contacts).values({ ...nullify(input), workspaceId: ws.id }).returning()
      await audit(tx, req, { action: 'contact.created', entity: 'contact', entityId: r!.id, summary: `Added ${r!.isCustomer && r!.isSupplier ? 'customer and supplier' : r!.isCustomer ? 'customer' : 'supplier'} ${r!.name}` })
      return r!
    })
    return reply.code(201).send({ contact: contactOut(row) })
  })

  app.put('/contacts/:id', needs('finance.edit'), async (req) => {
    const id = idOf(req.params, 'contact')
    const input = parse(ContactInput, req.body)
    const ws = workspaceOf(req)
    await checkEwtCode(ws.id, input.defaultEwtCodeId)
    const row = await db.transaction(async (tx) => {
      const [before] = await tx.select().from(contacts).where(and(eq(contacts.id, id), eq(contacts.workspaceId, ws.id))).for('update')
      if (!before) throw new HttpError(404, 'not-found', 'That contact doesn’t exist.')
      const [r] = await tx.update(contacts).set({ ...nullify(input), updatedAt: new Date() }).where(eq(contacts.id, id)).returning()
      const pick = (c: typeof contacts.$inferSelect) => ({ name: c.name, tin: c.tin, address: c.address, email: c.email, phone: c.phone, isCustomer: c.isCustomer, isSupplier: c.isSupplier })
      await audit(tx, req, { action: 'contact.updated', entity: 'contact', entityId: id, summary: `Edited contact ${r!.name}`, before: pick(before), after: pick(r!) })
      return r!
    })
    return { contact: contactOut(row) }
  })
}

/** Blank optional fields are stored as NULL, so an edit can clear them. */
function nullify(input: z.output<typeof ContactInput>) {
  return {
    ...input,
    tin: input.tin ?? null,
    address: input.address ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    defaultEwtCodeId: input.defaultEwtCodeId ?? null,
  }
}
