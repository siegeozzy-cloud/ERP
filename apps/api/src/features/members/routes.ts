import { randomInt } from 'node:crypto'
import {
  JOIN_CODE_ALPHABET,
  JoinCodeInput,
  MemberUpdate,
  PERMISSIONS,
  RoleInput,
  type AuditEntry,
  type JoinCode,
  type Member,
  type NewJoinCode,
  type Permission,
  type Role,
} from '@erp/shared'
import { and, asc, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db, isUniqueViolation } from '../../db/client.ts'
import { auditLog, joinCodes, memberships, roles, users, type RoleRow } from '../../db/schema.ts'
import type { Executor, Tx } from '../../db/types.ts'
import { audit } from '../../lib/audit.ts'
import { hashToken } from '../../lib/crypto.ts'
import { HttpError, parse } from '../../lib/errors.ts'
import { userOf } from '../../lib/session.ts'
import { can, needs, workspaceOf } from '../../lib/workspace.ts'

/**
 * Members, join codes, roles and the audit log: the Settings pages.
 *
 * The rules that keep a workspace from locking itself out:
 * - only an owner can make someone an owner, or change or remove an owner;
 * - there is always at least one owner;
 * - nobody can give a role permissions they don't have themselves.
 */

const UserParam = z.object({ userId: z.uuid() })
const IdParam = z.object({ id: z.uuid() })
const isOwner = (req: FastifyRequest) => workspaceOf(req).role.key === 'owner'

const LIFETIME_MS = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000 } as const

/** e.g. 7K3Q9XPA, shown as 7K3Q-9XPA. 31 letters and digits, 8 places: about 850 billion codes. */
function newCode() {
  return Array.from({ length: 8 }, () => JOIN_CODE_ALPHABET[randomInt(JOIN_CODE_ALPHABET.length)]).join('')
}
const manilaTime = (d: Date) => new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }).format(d)

export const formatJoinCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`

async function roleIn(db: Executor, workspaceId: string, roleId: string) {
  const [role] = await db.select().from(roles).where(and(eq(roles.id, roleId), eq(roles.workspaceId, workspaceId)))
  if (!role) throw new HttpError(400, 'invalid', 'Choose a role from this workspace.', 'roleId')
  return role
}

async function ownerCount(tx: Tx, workspaceId: string) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(and(eq(memberships.workspaceId, workspaceId), eq(roles.key, 'owner')))
  return row?.n ?? 0
}

/** A non-owner can only hand out what their own role already has. */
function assertCanGrant(req: FastifyRequest, permissions: string[]) {
  if (isOwner(req)) return
  const missing = permissions.filter((p) => !can(req, p as Permission))
  if (missing.length) throw new HttpError(403, 'forbidden', `You can’t give permissions your own role doesn’t have: ${missing.map((p) => PERMISSIONS[p as Permission]?.label ?? p).join('; ')}.`, 'permissions')
}

function codeStatus(c: typeof joinCodes.$inferSelect): JoinCode['status'] {
  if (c.revokedAt) return 'revoked'
  if (c.usedAt) return 'used'
  if (c.expiresAt <= new Date()) return 'expired'
  return 'active'
}

export default async function memberRoutes(app: FastifyInstance) {
  /* ---------- members ---------- */

  app.get('/members', needs('members.view'), async (req) => {
    const ws = workspaceOf(req)
    const rows = await db
      .select({ m: memberships, user: { id: users.id, name: users.name, email: users.email }, role: { id: roles.id, key: roles.key, name: roles.name } })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(eq(memberships.workspaceId, ws.id))
      .orderBy(asc(users.name))
    const me = userOf(req).id
    return {
      members: rows.map(
        (r): Member => ({ userId: r.user.id, name: r.user.name, email: r.user.email, role: r.role, joinedAt: r.m.createdAt.toISOString(), isYou: r.user.id === me }),
      ),
    }
  })

  app.patch('/members/:userId', needs('members.manage'), async (req) => {
    const { userId } = parse(UserParam, req.params)
    const { roleId } = parse(MemberUpdate, req.body)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ m: memberships, role: roles, name: users.name })
        .from(memberships)
        .innerJoin(roles, eq(roles.id, memberships.roleId))
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.workspaceId, ws.id), eq(memberships.userId, userId)))
        .for('update', { of: memberships })
      if (!current) throw new HttpError(404, 'not-found', 'That person isn’t in this workspace.')
      const next = await roleIn(tx, ws.id, roleId)
      if (current.role.id === next.id) return
      if ((current.role.key === 'owner' || next.key === 'owner') && !isOwner(req)) throw new HttpError(403, 'forbidden', 'Only an owner can make someone an owner, or change an owner’s role.', 'roleId')
      assertCanGrant(req, next.permissions)
      await tx.update(memberships).set({ roleId: next.id }).where(and(eq(memberships.workspaceId, ws.id), eq(memberships.userId, userId)))
      if (current.role.key === 'owner' && (await ownerCount(tx, ws.id)) === 0) throw new HttpError(409, 'last-owner', 'A workspace needs at least one owner. Make someone else an owner first.', 'roleId')
      await audit(tx, req, {
        action: 'member.role_changed',
        entity: 'member',
        entityId: userId,
        summary: `Changed ${current.name}’s role from ${current.role.name} to ${next.name}`,
        before: { role: current.role.name },
        after: { role: next.name },
      })
    })
    return { ok: true }
  })

  /** Removing someone, or leaving yourself (anyone may leave). */
  app.delete('/members/:userId', needs('member'), async (req, reply) => {
    const { userId } = parse(UserParam, req.params)
    const ws = workspaceOf(req)
    const self = userId === userOf(req).id
    if (!self && !can(req, 'members.manage')) throw new HttpError(403, 'forbidden', `Your role (${ws.role.name}) can’t remove members.`)
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ role: roles, name: users.name })
        .from(memberships)
        .innerJoin(roles, eq(roles.id, memberships.roleId))
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.workspaceId, ws.id), eq(memberships.userId, userId)))
        .for('update', { of: memberships })
      if (!current) throw new HttpError(404, 'not-found', 'That person isn’t in this workspace.')
      if (current.role.key === 'owner' && !self && !isOwner(req)) throw new HttpError(403, 'forbidden', 'Only an owner can remove an owner.')
      await tx.delete(memberships).where(and(eq(memberships.workspaceId, ws.id), eq(memberships.userId, userId)))
      if (current.role.key === 'owner' && (await ownerCount(tx, ws.id)) === 0) {
        throw new HttpError(409, 'last-owner', self ? 'You’re the only owner. Make someone else an owner before you leave.' : 'A workspace needs at least one owner.')
      }
      await audit(tx, req, { action: self ? 'member.left' : 'member.removed', entity: 'member', entityId: userId, summary: self ? `${current.name} left the workspace` : `Removed ${current.name} (${current.role.name})` })
    })
    return reply.code(204).send()
  })

  /* ---------- join codes ---------- */

  app.get('/join-codes', needs('members.invite'), async (req) => {
    const ws = workspaceOf(req)
    const rows = await db
      .select({ c: joinCodes, role: { id: roles.id, name: roles.name }, createdByName: sql<string | null>`(select name from users where id = ${joinCodes.createdBy})`, usedByName: sql<string | null>`(select name from users where id = ${joinCodes.usedBy})` })
      .from(joinCodes)
      .innerJoin(roles, eq(roles.id, joinCodes.roleId))
      .where(eq(joinCodes.workspaceId, ws.id))
      .orderBy(desc(joinCodes.createdAt))
      .limit(50)
    return {
      codes: rows.map(
        (r): JoinCode => ({
          id: r.c.id,
          role: r.role,
          createdBy: r.createdByName,
          createdAt: r.c.createdAt.toISOString(),
          expiresAt: r.c.expiresAt.toISOString(),
          status: codeStatus(r.c),
          usedBy: r.usedByName,
          usedAt: r.c.usedAt?.toISOString() ?? null,
        }),
      ),
    }
  })

  /** The code is in this answer and nowhere else: only its hash is kept. */
  app.post('/join-codes', { config: { permission: 'members.invite', rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const input = parse(JoinCodeInput, req.body)
    const ws = workspaceOf(req)
    const role = await roleIn(db, ws.id, input.roleId)
    if (role.key === 'owner' && !isOwner(req)) throw new HttpError(403, 'forbidden', 'Only an owner can make a code that gives the Owner role.', 'roleId')
    assertCanGrant(req, role.permissions)
    const result = await db.transaction(async (tx) => {
      for (let attempt = 0; ; attempt++) {
        const code = newCode()
        try {
          const [row] = await tx
            .insert(joinCodes)
            .values({ workspaceId: ws.id, codeHash: hashToken(code), roleId: role.id, createdBy: userOf(req).id, expiresAt: new Date(Date.now() + LIFETIME_MS[input.expiresIn]) })
            .returning()
          await audit(tx, req, { action: 'join_code.created', entity: 'join_code', entityId: row!.id, summary: `Made a join code for the ${role.name} role, good until ${manilaTime(row!.expiresAt)}` })
          return { row: row!, code }
        } catch (e) {
          // ~850 billion codes, so a clash is very unlikely; try another
          if (attempt < 3 && isUniqueViolation(e, 'join_codes_hash_key')) continue
          throw e
        }
      }
    })
    const out: NewJoinCode = {
      id: result.row.id,
      code: formatJoinCode(result.code),
      role: { id: role.id, name: role.name },
      createdBy: userOf(req).name,
      createdAt: result.row.createdAt.toISOString(),
      expiresAt: result.row.expiresAt.toISOString(),
      status: 'active',
      usedBy: null,
      usedAt: null,
    }
    return reply.code(201).send({ code: out })
  })

  app.post('/join-codes/:id/revoke', needs('members.invite'), async (req) => {
    const { id } = parse(IdParam, req.params)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const [row] = await tx
        .update(joinCodes)
        .set({ revokedAt: new Date() })
        .where(and(eq(joinCodes.id, id), eq(joinCodes.workspaceId, ws.id), isNull(joinCodes.usedAt), isNull(joinCodes.revokedAt), gt(joinCodes.expiresAt, new Date())))
        .returning()
      if (!row) throw new HttpError(409, 'not-active', 'That code has already been used, revoked or has expired.')
      await audit(tx, req, { action: 'join_code.revoked', entity: 'join_code', entityId: id, summary: 'Revoked a join code' })
    })
    return { ok: true }
  })

  /* ---------- roles ---------- */

  const roleOut = (r: RoleRow, memberCount: number): Role => ({
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    permissions: r.permissions as Permission[],
    memberCount,
  })

  app.get('/roles', needs('members.view'), async (req) => {
    const ws = workspaceOf(req)
    const rows = await db
      .select({ r: roles, members: sql<number>`(select count(*)::int from ${memberships} where ${memberships.roleId} = ${roles.id})`.mapWith(Number) })
      .from(roles)
      .where(eq(roles.workspaceId, ws.id))
      .orderBy(sql`case ${roles.key} when 'owner' then 0 when 'admin' then 1 else 2 end`, asc(roles.name))
    return { roles: rows.map((r) => roleOut(r.r, r.members)) }
  })

  app.post('/roles', needs('roles.manage'), async (req, reply) => {
    const input = parse(RoleInput, req.body)
    assertCanGrant(req, input.permissions)
    const ws = workspaceOf(req)
    try {
      const row = await db.transaction(async (tx) => {
        const [r] = await tx.insert(roles).values({ workspaceId: ws.id, name: input.name, description: input.description, permissions: input.permissions }).returning()
        await audit(tx, req, { action: 'role.created', entity: 'role', entityId: r!.id, summary: `Created the ${r!.name} role`, after: { permissions: r!.permissions } })
        return r!
      })
      return reply.code(201).send({ role: roleOut(row, 0) })
    } catch (e) {
      if (isUniqueViolation(e, 'roles_name_key')) throw new HttpError(409, 'taken', `There’s already a role called ${input.name}.`, 'name')
      throw e
    }
  })

  app.put('/roles/:id', needs('roles.manage'), async (req) => {
    const { id } = parse(IdParam, req.params)
    const input = parse(RoleInput, req.body)
    const ws = workspaceOf(req)
    try {
      await db.transaction(async (tx) => {
        const current = await roleIn(tx, ws.id, id)
        if (current.key === 'owner') throw new HttpError(409, 'fixed-role', 'The Owner role can’t be changed: it always has everything.')
        assertCanGrant(req, input.permissions)
        // taking permissions away from your own role could lock you out of this very page
        if (current.id === ws.role.id && !input.permissions.includes('roles.manage')) {
          throw new HttpError(409, 'own-role', 'You can’t take “Create and edit roles” away from your own role.', 'permissions')
        }
        await tx.update(roles).set(input).where(eq(roles.id, id))
        await audit(tx, req, {
          action: 'role.updated',
          entity: 'role',
          entityId: id,
          summary: `Changed the ${current.name} role${current.name !== input.name ? ` (now ${input.name})` : ''}`,
          before: { name: current.name, permissions: current.permissions },
          after: { name: input.name, permissions: input.permissions },
        })
      })
    } catch (e) {
      if (isUniqueViolation(e, 'roles_name_key')) throw new HttpError(409, 'taken', `There’s already a role called ${input.name}.`, 'name')
      throw e
    }
    return { ok: true }
  })

  app.delete('/roles/:id', needs('roles.manage'), async (req, reply) => {
    const { id } = parse(IdParam, req.params)
    const ws = workspaceOf(req)
    await db.transaction(async (tx) => {
      const current = await roleIn(tx, ws.id, id)
      if (current.key) throw new HttpError(409, 'fixed-role', `The ${current.name} role is built in and can’t be deleted.`)
      const [used] = await tx.select({ n: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.roleId, id))
      if ((used?.n ?? 0) > 0) throw new HttpError(409, 'in-use', `${used!.n} member${used!.n === 1 ? ' has' : 's have'} this role. Give them another role first.`)
      await tx.delete(roles).where(eq(roles.id, id))
      await audit(tx, req, { action: 'role.deleted', entity: 'role', entityId: id, summary: `Deleted the ${current.name} role` })
    })
    return reply.code(204).send()
  })

  /* ---------- audit log ---------- */

  app.get('/audit', needs('audit.view'), async (req) => {
    const q = parse(z.object({ before: z.iso.datetime().optional(), entity: z.string().max(40).optional() }), req.query)
    const ws = workspaceOf(req)
    const rows = await db
      .select({ a: auditLog, actor: { id: users.id, name: users.name } })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorId))
      .where(and(eq(auditLog.workspaceId, ws.id), q.before ? lt(auditLog.createdAt, new Date(q.before)) : undefined, q.entity ? eq(auditLog.entity, q.entity) : undefined))
      .orderBy(desc(auditLog.createdAt))
      .limit(100)
    return {
      entries: rows.map(
        ({ a, actor }): AuditEntry => ({
          id: a.id,
          at: a.createdAt.toISOString(),
          actor: actor?.id ? actor : null,
          action: a.action,
          entity: a.entity,
          entityId: a.entityId,
          summary: a.summary,
          before: a.before,
          after: a.after,
        }),
      ),
    }
  })
}
