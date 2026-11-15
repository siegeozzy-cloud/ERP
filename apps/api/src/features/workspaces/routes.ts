import { DEFAULT_ROLES, JoinInput, templateByKey, WorkspaceInput, WorkspaceUpdate, type ModuleSlug, type Permission, type Workspace, type WorkspaceSummary } from '@erp/shared'
import { and, asc, eq, gt, isNull, ne, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../../db/client.ts'
import { accounts, bills, joinCodes, memberships, roles, salesInvoices, workspaces, type RoleRow, type WorkspaceRow } from '../../db/schema.ts'
import type { Tx } from '../../db/types.ts'
import { audit } from '../../lib/audit.ts'
import { hashToken } from '../../lib/crypto.ts'
import { HttpError, parse } from '../../lib/errors.ts'
import { requireAuth, userOf } from '../../lib/session.ts'
import { clearFailures, describeWait, lockedFor, recordFailure } from '../../lib/throttle.ts'
import { needs, workspaceOf } from '../../lib/workspace.ts'
import { seedFinance } from '../finance/seed.ts'
import { composeAddress } from '../psgc/psgc.ts'

export const workspaceOut = (w: WorkspaceRow, role: RoleRow): Workspace => ({
  id: w.id,
  name: w.name,
  tin: w.tin,
  vatStatus: w.vatStatus,
  registeredAddress: w.registeredAddress,
  street: w.street,
  barangayCode: w.barangayCode,
  fiscalYearStartMonth: w.fiscalYearStartMonth,
  template: w.template,
  modules: w.modules as ModuleSlug[],
  dpoName: w.dpoName,
  dpoEmail: w.dpoEmail,
  role: { id: role.id, key: role.key, name: role.name },
  permissions: role.permissions as Permission[],
})

/** The default roles (shared/permissions.ts). Returns the Owner role. */
async function seedRoles(tx: Tx, workspaceId: string) {
  const rows = await tx
    .insert(roles)
    .values(DEFAULT_ROLES.map((r) => ({ workspaceId, key: r.key, name: r.name, description: r.description, permissions: r.permissions })))
    .returning()
  return rows.find((r) => r.key === 'owner')!
}

/** /api/workspaces: the signed-in person's workspaces, making a new one, and joining one. */
export default async function workspaceRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  app.get('/', async (req) => {
    const rows = await db
      .select({ id: workspaces.id, name: workspaces.name, roleName: roles.name })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(eq(memberships.userId, userOf(req).id))
      .orderBy(asc(workspaces.name))
    return { workspaces: rows satisfies WorkspaceSummary[] }
  })

  /**
   * Creates the workspace from a niche template: its modules, the standard chart of accounts plus
   * the template's own accounts, the tax codes and the default roles. The creator is its Owner.
   */
  app.post('/', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const input = parse(WorkspaceInput, req.body)
    const template = templateByKey(input.template)!
    const user = userOf(req)
    const { workspace, owner } = await db.transaction(async (tx) => {
      const address = await composeAddress(tx, input.street, input.barangayCode)
      const [w] = await tx
        .insert(workspaces)
        .values({
          name: input.name,
          tin: input.tin,
          vatStatus: input.vatStatus,
          street: input.street,
          ...address,
          fiscalYearStartMonth: input.fiscalYearStartMonth,
          template: template.key,
          modules: template.modules,
          createdBy: user.id,
        })
        .returning()
      const owner = await seedRoles(tx, w!.id)
      await tx.insert(memberships).values({ workspaceId: w!.id, userId: user.id, roleId: owner.id })
      await seedFinance(tx, w!.id)
      if (template.accounts.length) await tx.insert(accounts).values(template.accounts.map((a) => ({ ...a, workspaceId: w!.id })))
      await audit(tx, req, { workspaceId: w!.id, action: 'workspace.created', entity: 'workspace', entityId: w!.id, summary: `Created the workspace from the ${template.name} template` })
      return { workspace: w!, owner }
    })
    return reply.code(201).send({ workspace: workspaceOut(workspace, owner) })
  })

  /**
   * Joining with a one-time code. Wrong codes are counted against the person trying, as well as
   * the per-address limit, so codes can't be guessed by trying many (lib/throttle.ts).
   */
  app.post('/join', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const user = userOf(req)
    const key = `join:${user.id}`
    const wait = lockedFor(key)
    if (wait) throw new HttpError(429, 'too-many-attempts', `Too many wrong codes. Try again in ${describeWait(wait)}.`)
    const { code } = parse(JoinInput, req.body)

    const wrong = () => {
      const locked = recordFailure(key)
      return locked
        ? new HttpError(429, 'too-many-attempts', `Too many wrong codes. Try again in ${describeWait(locked)}.`)
        : new HttpError(400, 'bad-code', 'That code doesn’t work. It may have expired or been used already. Ask for a new one.', 'code')
    }

    const joined = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ code: joinCodes, workspace: workspaces, role: roles })
        .from(joinCodes)
        .innerJoin(workspaces, eq(workspaces.id, joinCodes.workspaceId))
        .innerJoin(roles, eq(roles.id, joinCodes.roleId))
        .where(and(eq(joinCodes.codeHash, hashToken(code)), isNull(joinCodes.usedAt), isNull(joinCodes.revokedAt), gt(joinCodes.expiresAt, new Date())))
        .for('update', { of: joinCodes })
      if (!row) throw wrong()
      clearFailures(key)
      const [already] = await tx.select().from(memberships).where(and(eq(memberships.workspaceId, row.workspace.id), eq(memberships.userId, user.id)))
      if (already) throw new HttpError(409, 'already-member', `You’re already in ${row.workspace.name}. The code is still unused.`, 'code')
      await tx.insert(memberships).values({ workspaceId: row.workspace.id, userId: user.id, roleId: row.role.id })
      await tx.update(joinCodes).set({ usedAt: new Date(), usedBy: user.id }).where(eq(joinCodes.id, row.code.id))
      await audit(tx, req, {
        workspaceId: row.workspace.id,
        action: 'member.joined',
        entity: 'member',
        entityId: user.id,
        summary: `${user.name} joined as ${row.role.name} with a join code`,
      })
      return { workspace: row.workspace, role: row.role }
    })
    return { workspace: workspaceOut(joined.workspace, joined.role) }
  })
}

const FIELD_WORDS: Record<string, string> = {
  name: 'name',
  tin: 'TIN',
  vatStatus: 'tax type',
  street: 'address',
  registeredAddress: 'address',
  regionCode: 'address',
  provinceCode: 'address',
  cityCode: 'address',
  barangayCode: 'address',
  fiscalYearStartMonth: 'fiscal year',
  dpoName: 'data protection officer',
  dpoEmail: 'data protection officer',
  modules: 'modules',
}

/** Changing a field: what it was and what it became, for the audit log. */
function changes(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b: Record<string, unknown> = {}
  const a: Record<string, unknown> = {}
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      b[k] = before[k]
      a[k] = after[k]
    }
  }
  return { before: b, after: a, changed: Object.keys(a) }
}

/** /api/w/:workspaceId: the workspace itself. */
export async function workspaceDetailRoutes(app: FastifyInstance) {
  app.get('/', needs('member'), async (req) => {
    const ws = workspaceOf(req)
    return { workspace: workspaceOut(ws, ws.role) }
  })

  app.patch('/', needs('workspace.manage'), async (req: FastifyRequest) => {
    const input = parse(WorkspaceUpdate, req.body)
    const ws = workspaceOf(req)
    const updated = await db.transaction(async (tx) => {
      if (input.vatStatus !== ws.vatStatus) {
        const [posted] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(salesInvoices)
          .where(and(eq(salesInvoices.workspaceId, ws.id), ne(salesInvoices.status, 'draft')))
        const [postedBills] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(bills)
          .where(and(eq(bills.workspaceId, ws.id), ne(bills.status, 'draft')))
        if ((posted?.n ?? 0) + (postedBills?.n ?? 0) > 0) {
          throw new HttpError(409, 'has-documents', 'The tax type can’t change once invoices or bills are posted: they were taxed under the old one.', 'vatStatus')
        }
      }
      const address = await composeAddress(tx, input.street, input.barangayCode)
      const next = { ...input, ...address }
      const diff = changes(ws as unknown as Record<string, unknown>, next)
      const [row] = await tx
        .update(workspaces)
        .set({ ...next, updatedAt: new Date() })
        .where(eq(workspaces.id, ws.id))
        .returning()
      if (diff.changed.length) {
        const words = [...new Set(diff.changed.map((k) => FIELD_WORDS[k] ?? k))]
        await audit(tx, req, { action: 'workspace.updated', entity: 'workspace', entityId: ws.id, summary: `Changed the workspace’s ${words.join(', ')}`, before: diff.before, after: diff.after })
      }
      return row!
    })
    return { workspace: workspaceOut(updated, ws.role) }
  })
}
