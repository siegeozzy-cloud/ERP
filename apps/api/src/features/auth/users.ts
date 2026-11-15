import type { Session } from '@erp/shared'
import type { UserRow } from '../../db/schema.ts'

// What the apps get to see of a user. Never the password hash or internal timestamps.

export const sessionOf = (u: UserRow): Session => ({ user: { id: u.id, name: u.name, email: u.email } })
