// Money is whole centavos everywhere — in the database, in the API and in the apps. ₱1,234.50 is
// 123450. Floats never hold money, so totals always add up to the centavo.

const amountFormat = new Intl.NumberFormat('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** 123450 → "₱1,234.50"; negatives as "-₱1,234.50". */
export function formatPeso(centavos: number) {
  return `${centavos < 0 ? '-' : ''}₱${amountFormat.format(Math.abs(centavos) / 100)}`
}

/** 123450 → "1,234.50", for tables where the column already says pesos. */
export function formatAmount(centavos: number) {
  return amountFormat.format(centavos / 100)
}

/** "1,234.5", "₱ 1234.50" → 123450. Null when it isn't an amount (at most two decimals). */
export function parsePeso(input: string): number | null {
  const cleaned = input.replace(/[₱,\s]/g, '')
  const m = /^(-)?(\d{1,13})(?:\.(\d{1,2}))?$/.exec(cleaned)
  if (!m) return null
  const centavos = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'))
  return m[1] ? -centavos : centavos
}

/** 123450 → "1234.50", for putting an amount back into an input box. */
export const centavosToInput = (centavos: number) => (centavos / 100).toFixed(2)

/** A rate in basis points (1200 = 12%) applied to an amount, rounded to the centavo. */
export const applyRate = (centavos: number, basisPoints: number) => Math.round((centavos * basisPoints) / 10_000)

/** 1200 → "12%", 150 → "1.5%". */
export const formatRate = (basisPoints: number) => `${basisPoints / 100}%`
