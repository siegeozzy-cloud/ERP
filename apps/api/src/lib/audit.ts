import type { FastifyRequest } from 'fastify'
import { auditLog } from '../db/schema.ts'
import type { Executor } from '../db/types.ts'

/**
 * Records a change in the workspace's audit log. Pass the transaction the change ran in, so the
 * entry and the change are saved together or not at all.
 *
 * `summary` is one sentence for people. `before` and `after` hold the values that changed, for
 * edits to settings, roles and members; documents are immutable once posted, so their entries
 * mostly carry the summary.
 */
export async function audit(
  db: Executor,
  req: FastifyRequest,
  entry: { action: string; entity: string; entityId?: string | null; summary: string; before?: unknown; after?: unknown; workspaceId?: string },
) {
  await db.insert(auditLog).values({
    workspaceId: entry.workspaceId ?? req.workspace!.id,
    actorId: req.auth?.user.id ?? null,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    summary: entry.summary,
    before: entry.before ?? null,
    after: entry.after ?? null,
    ip: req.ip,
  })
}
