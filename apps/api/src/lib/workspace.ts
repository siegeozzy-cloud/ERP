import type { Permission } from '@erp/shared'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db } from '../db/client.ts'
import { memberships, roles, workspaces, type RoleRow, type WorkspaceRow } from '../db/schema.ts'
import { HttpError } from './errors.ts'
import { requireAuth } from './session.ts'

/**
 * Everything that belongs to a workspace lives under /api/w/:workspaceId/…, and every such request
 * passes through here first:
 *
 * 1. the person must be signed in and a member of that workspace, and
 * 2. their role must have the permission the route names in `config.permission`.
 *
 * A route that names no permission isn't allowed to exist: the server refuses to start (see the
 * onRoute hook below), so a new route can't be left unguarded by accident. `'member'` means any
 * member may use it.
 *
 * Someone who isn't a member gets the same 404 as for a workspace that doesn't exist, so ids
 * can't be probed. Inside, `req.workspace` is the workspace and every query must also filter by
 * its id.
 */

export type RoutePermission = Permission | 'member'

declare module 'fastify' {
  interface FastifyRequest {
    workspace: (WorkspaceRow & { role: RoleRow; permissions: Set<Permission> }) | null
  }
  interface FastifyContextConfig {
    permission?: RoutePermission
  }
}

const Params = z.object({ workspaceId: z.uuid() })
const notFound = () => new HttpError(404, 'not-found', 'That workspace doesn’t exist, or you’re not a member of it.')

async function loadWorkspace(req: FastifyRequest) {
  await requireAuth(req)
  const params = Params.safeParse(req.params)
  if (!params.success) throw notFound()
  const [row] = await db
    .select({ workspace: workspaces, role: roles })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(and(eq(memberships.workspaceId, params.data.workspaceId), eq(memberships.userId, req.auth!.user.id)))
  if (!row) throw notFound()
  req.workspace = { ...row.workspace, role: row.role, permissions: new Set(row.role.permissions as Permission[]) }

  const needed = req.routeOptions.config.permission
  if (needed && needed !== 'member' && !req.workspace.permissions.has(needed)) {
    throw new HttpError(403, 'forbidden', `Your role (${row.role.name}) can’t do that here. Ask an owner or admin.`)
  }
}

/** Registers `routes` under /api/w/:workspaceId, behind the membership and permission checks. */
export async function workspaceScope(app: FastifyInstance, routes: (app: FastifyInstance) => Promise<void>) {
  app.decorateRequest('workspace', null)
  await app.register(
    async (scoped) => {
      scoped.addHook('onRoute', (route) => {
        if (!route.config?.permission) throw new Error(`${route.method} ${route.url} must say which permission it needs (config.permission).`)
      })
      scoped.addHook('preHandler', loadWorkspace)
      await routes(scoped)
    },
    { prefix: '/api/w/:workspaceId' },
  )
}

/** Route options naming the permission a route needs. */
export const needs = (permission: RoutePermission) => ({ config: { permission } })

/** The current workspace (inside workspaceScope). */
export const workspaceOf = (req: FastifyRequest) => req.workspace!

/** Whether the signed-in member may do something, for routes whose rules depend on the request. */
export const can = (req: FastifyRequest, permission: Permission) => req.workspace!.permissions.has(permission)
