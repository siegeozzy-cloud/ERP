import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { config } from '../config.ts'
import * as schema from './schema.ts'

/**
 * Hosted databases (Neon, Supabase) require TLS and say so in the connection string.
 * `sslmode=no-verify` is the escape hatch for a server with a self-signed certificate.
 */
const sslMode = /[?&]sslmode=([^&]+)/.exec(config.DATABASE_URL)?.[1]
const ssl = !sslMode || sslMode === 'disable' ? false : { rejectUnauthorized: sslMode !== 'no-verify' }

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10, ssl })
export const db = drizzle(pool, { schema, casing: 'snake_case' })

/** Any number: it only has to be the same in every process that migrates this database. */
const MIGRATION_LOCK = 4_100_2026

/**
 * Applies any SQL migrations in src/db/migrations that haven't run yet. One process at a time: the
 * test files run in parallel, and two servers can start together, so the others wait on a Postgres
 * advisory lock and then find nothing left to do.
 */
export async function runMigrations() {
  const lock = await pool.connect()
  try {
    await lock.query('select pg_advisory_lock($1)', [MIGRATION_LOCK])
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('./migrations', import.meta.url)) })
  } finally {
    await lock.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined)
    lock.release()
  }
}

/** Postgres "unique_violation", e.g. an email that's already registered. */
export const isUniqueViolation = (e: unknown, constraint?: string) => {
  const err = (e as { cause?: unknown })?.cause ?? e
  const pgErr = err as { code?: string; constraint?: string }
  return pgErr?.code === '23505' && (!constraint || pgErr.constraint === constraint)
}
