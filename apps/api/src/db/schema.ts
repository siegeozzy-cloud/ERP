import { boolean, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

// Column names are snake_case in the database (drizzle `casing`), camelCase here.
// Phase 0 holds accounts only. Workspaces, roles and the audit log arrive in Phase 1.

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp({ withTimezone: true }).notNull().defaultNow()
const id = () => uuid().primaryKey().defaultRandom()

export const users = pgTable(
  'users',
  {
    id: id(),
    /** Always stored lowercased. */
    email: text().notNull(),
    passwordHash: text().notNull(),
    name: text().notNull(),
    /** Sign-in is refused until the confirmation link has been opened. */
    emailVerifiedAt: timestamp({ withTimezone: true }),
    /** When the person agreed to the Terms and Privacy Notice (Data Privacy Act consent). */
    termsAcceptedAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
)

export type UserRow = typeof users.$inferSelect

/** Signed-in browsers and phones. The client holds a random token; only its SHA-256 is stored. */
export const sessions = pgTable(
  'sessions',
  {
    id: text().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    remember: boolean().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
)

export const emailTokenPurpose = pgEnum('email_token_purpose', ['verify', 'reset'])

/** Links sent by email (confirm address, reset password). Only the token's SHA-256 is stored. */
export const emailTokens = pgTable(
  'email_tokens',
  {
    id: text().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: emailTokenPurpose().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('email_tokens_user_idx').on(t.userId)],
)
