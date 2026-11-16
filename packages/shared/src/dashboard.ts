// The workspace dashboard (Phase 9): money over the last six months and what needs doing, each
// part only for the roles that may see it (null otherwise).

export const AGING_BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'] as const
export type AgingBucket = (typeof AGING_BUCKETS)[number]

export type DashboardMonth = { month: string; income: number; expenses: number }

export type Dashboard = {
  money: {
    /** Up to the last six months, oldest first (from the first with any activity): income and expenses from posted entries. */
    months: DashboardMonth[]
    /** Cash and bank at each month's end, same months. */
    cash: { month: string; balance: number }[]
    /** Unpaid invoices by how late they are. */
    aging: { bucket: AgingBucket; amount: number; count: number }[]
    /** The last 90 days, before VAT. */
    topCustomers: { id: string; name: string; sales: number }[]
  } | null
  /** Things waiting on someone, by module, with where to go. */
  todo: { key: string; label: string; count: number; to: string }[]
}

export const AGING_LABELS: Record<AgingBucket, string> = {
  current: 'Not yet due',
  '1-30': '1–30 days late',
  '31-60': '31–60 days late',
  '61-90': '61–90 days late',
  '90+': 'Over 90 days late',
}
