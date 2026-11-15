// Dates travel as YYYY-MM-DD strings and are shown in Philippine style. They're never turned into
// Date objects for arithmetic, so a time zone can't shift a document to the day before.

/** Today in the Philippines, as YYYY-MM-DD. */
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "2026-08-05" → "Aug 5, 2026". */
export function formatDate(date: string | null | undefined) {
  if (!date) return '—'
  const [y, m, d] = date.split('-').map(Number)
  return `${MONTHS[m! - 1]} ${d}, ${y}`
}

/** "2026-08" → "August 2026". */
export function formatMonth(month: string) {
  const [y, m] = month.split('-').map(Number)
  return `${MONTH_NAMES[m! - 1]} ${y}`
}

/** The quarter today falls in, and the few before it, for quarter pickers: ["2026-Q4", "2026-Q3", …]. */
export function recentQuarters(count = 8) {
  const t = today()
  let y = Number(t.slice(0, 4))
  let q = Math.floor((Number(t.slice(5, 7)) - 1) / 3) + 1
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    out.push(`${y}-Q${q}`)
    q -= 1
    if (q === 0) {
      q = 4
      y -= 1
    }
  }
  return out
}

/** "2026-Q3" → "Q3 2026 (Jul–Sep)". */
export function formatQuarter(quarter: string) {
  const [y, q] = quarter.split('-Q').map(Number)
  const start = (q! - 1) * 3
  return `Q${q} ${y} (${MONTHS[start]}–${MONTHS[start + 2]})`
}

/** The first day of the month `date` is in. */
export const monthStart = (date: string) => `${date.slice(0, 7)}-01`

/** The first day of the year `date` is in. */
export const yearStart = (date: string) => `${date.slice(0, 4)}-01-01`
