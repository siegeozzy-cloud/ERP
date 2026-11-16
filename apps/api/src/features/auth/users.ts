import type { Session } from '@erp/shared'
import { eq } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { demoAccounts, type UserRow } from '../../db/schema.ts'
import { decrypt } from '../../lib/crypto.ts'

// What the apps get to see of a user. Never the password hash or internal timestamps.

/** The user, and for a "Try the demo" account when it ends and how to sign it in on the phone. */
export async function sessionOf(u: UserRow): Promise<Session> {
  const [demo] = await db.select().from(demoAccounts).where(eq(demoAccounts.userId, u.id))
  return {
    user: { id: u.id, name: u.name, email: u.email },
    demo:
      demo?.expiresAt && demo.passwordEnc
        ? { workspaceId: demo.workspaceId, expiresAt: demo.expiresAt.toISOString(), email: u.email, password: decrypt(demo.passwordEnc) }
        : null,
  }
}
