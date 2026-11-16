import { holidays, leaveTypes } from '../../db/schema.ts'
import type { Tx } from '../../db/types.ts'

/**
 * What every new workspace starts with for HR: the leave the law gives (and a few a company
 * usually adds), and this year's holidays. Both can be edited in HR → Settings, since special days
 * get announced at short notice. Migration 0013 gave the same to workspaces made before Phase 5.
 */

export const DEFAULT_LEAVE_TYPES: { code: string; name: string; paid: boolean; daysPerYear: number | null }[] = [
  { code: 'SIL', name: 'Service incentive leave', paid: true, daysPerYear: 5 }, // Labor Code art. 95, after a year of service
  { code: 'VL', name: 'Vacation leave', paid: true, daysPerYear: 5 },
  { code: 'SL', name: 'Sick leave', paid: true, daysPerYear: 5 },
  { code: 'ML', name: 'Maternity leave', paid: true, daysPerYear: 105 }, // RA 11210
  { code: 'PL', name: 'Paternity leave', paid: true, daysPerYear: 7 }, // RA 8187
  { code: 'SPL', name: 'Solo parent leave', paid: true, daysPerYear: 7 }, // RA 11861
  { code: 'VAWC', name: 'VAWC leave', paid: true, daysPerYear: 10 }, // RA 9262
  { code: 'SLW', name: 'Special leave for women', paid: true, daysPerYear: 60 }, // RA 9710
  { code: 'LWOP', name: 'Leave without pay', paid: false, daysPerYear: null },
]

/** Proclamation No. 1006 (2025). Eid'l Fitr and Eid'l Adha are proclaimed separately each year: add them when announced. */
export const HOLIDAYS_2026: { date: string; name: string; kind: 'regular' | 'special' }[] = [
  { date: '2026-01-01', name: 'New Year’s Day', kind: 'regular' },
  { date: '2026-02-17', name: 'Chinese New Year', kind: 'special' },
  { date: '2026-04-02', name: 'Maundy Thursday', kind: 'regular' },
  { date: '2026-04-03', name: 'Good Friday', kind: 'regular' },
  { date: '2026-04-04', name: 'Black Saturday', kind: 'special' },
  { date: '2026-04-09', name: 'Araw ng Kagitingan', kind: 'regular' },
  { date: '2026-05-01', name: 'Labor Day', kind: 'regular' },
  { date: '2026-06-12', name: 'Independence Day', kind: 'regular' },
  { date: '2026-08-21', name: 'Ninoy Aquino Day', kind: 'special' },
  { date: '2026-08-31', name: 'National Heroes Day', kind: 'regular' },
  { date: '2026-11-01', name: 'All Saints’ Day', kind: 'special' },
  { date: '2026-11-02', name: 'All Souls’ Day', kind: 'special' },
  { date: '2026-11-30', name: 'Bonifacio Day', kind: 'regular' },
  { date: '2026-12-08', name: 'Feast of the Immaculate Conception', kind: 'special' },
  { date: '2026-12-24', name: 'Christmas Eve', kind: 'special' },
  { date: '2026-12-25', name: 'Christmas Day', kind: 'regular' },
  { date: '2026-12-30', name: 'Rizal Day', kind: 'regular' },
  { date: '2026-12-31', name: 'Last Day of the Year', kind: 'special' },
]

export async function seedHr(tx: Tx, workspaceId: string) {
  await tx.insert(leaveTypes).values(DEFAULT_LEAVE_TYPES.map((t) => ({ ...t, workspaceId })))
  await tx.insert(holidays).values(HOLIDAYS_2026.map((h) => ({ ...h, workspaceId })))
}
