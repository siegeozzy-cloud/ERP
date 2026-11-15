import type { db } from './client.ts'

/** A transaction, as handed to `db.transaction(async (tx) => …)`. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Either the pool or a transaction: functions that take this work inside or outside one. */
export type Executor = typeof db | Tx

/** Dates in timestamp columns come back as Date; the apps get ISO strings. */
export const iso = (d: Date | null) => (d ? d.toISOString() : null)
