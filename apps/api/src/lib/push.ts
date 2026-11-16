import type { Permission, PushData } from '@erp/shared'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { config } from '../config.ts'
import { db } from '../db/client.ts'
import { memberships, pushTokens, roles } from '../db/schema.ts'

/**
 * Push notifications to the phone app, through Expo's push service (free, no key needed).
 *
 * Sending never holds up or fails the request that caused it: it runs after the change has been
 * saved, and a failure is only logged. A notification is a courtesy; the change itself is what counts.
 */

export type Push = { title: string; body: string; data?: PushData }

/** Notifications "sent" while testing, newest last (only when NODE_ENV=test). */
export const testPushOutbox: (Push & { userIds: string[] })[] = []

const EXPO_PUSH = 'https://exp.host/--/api/v2/push/send'

export async function sendPush(userIds: string[], push: Push) {
  if (userIds.length === 0) return
  if (config.NODE_ENV === 'test') {
    testPushOutbox.push({ ...push, userIds })
    return
  }
  try {
    const tokens = (await db.select({ token: pushTokens.token }).from(pushTokens).where(inArray(pushTokens.userId, userIds))).map((t) => t.token)
    // Expo takes up to 100 messages per request
    for (let i = 0; i < tokens.length; i += 100) {
      const batch = tokens.slice(i, i + 100)
      const res = await fetch(EXPO_PUSH, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(batch.map((to) => ({ to, title: push.title, body: push.body, data: push.data ?? {}, sound: 'default' }))),
        signal: AbortSignal.timeout(15_000),
      })
      const result = (await res.json().catch(() => null)) as { data?: { status: string; details?: { error?: string } }[] } | null
      // an uninstalled app: forget its token, so we stop sending to it
      const gone = batch.filter((_, j) => result?.data?.[j]?.details?.error === 'DeviceNotRegistered')
      if (gone.length) await db.delete(pushTokens).where(inArray(pushTokens.token, gone))
    }
  } catch (e) {
    console.error('Couldn’t send a push notification:', (e as Error).message)
  }
}

/**
 * Works out who to tell and tells them, after the response has gone. Tests wait for it, so they
 * can check what was sent; everywhere else nobody waits.
 */
export async function notifyLater(work: () => Promise<void>) {
  const running = work().catch((e: Error) => console.error('Couldn’t send a push notification:', e.message))
  if (config.NODE_ENV === 'test') await running
}

/** Everyone in a workspace whose role has `permission`, except `except`. */
export async function membersWith(workspaceId: string, permission: Permission, except?: string) {
  const rows = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(and(eq(memberships.workspaceId, workspaceId), sql`${permission} = any(${roles.permissions})`, except ? ne(memberships.userId, except) : undefined))
  return rows.map((r) => r.userId)
}
