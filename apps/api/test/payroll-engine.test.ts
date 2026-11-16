import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computePay, computeThirteenth, emptyInputs, pagibigContribution, philhealthContribution, PayInputs, sssContribution, taxFromTable, type PayrollRates } from '@erp/shared'

// The payroll engine on its own, against figures worked out by hand from the published tables.
// The rates are the ones migration 0013 seeds.

const rates: PayrollRates = {
  sss: { minMsc: 500000, maxMsc: 3500000, step: 50000, eeBp: 500, erBp: 1000, ecThreshold: 1500000, ecLow: 1000, ecHigh: 3000 },
  philhealth: { rateBp: 500, floor: 1000000, ceiling: 10000000 },
  pagibig: { lowThreshold: 150000, eeLowBp: 100, eeBp: 200, erBp: 200, maxBase: 1000000 },
  wtax: {
    semi_monthly: [
      { over: 1041700, base: 0, rateBp: 1500 },
      { over: 1666700, base: 93750, rateBp: 2000 },
      { over: 3333300, base: 427070, rateBp: 2500 },
      { over: 8333300, base: 1677070, rateBp: 3000 },
      { over: 33333300, base: 9177070, rateBp: 3500 },
    ],
    monthly: [
      { over: 2083300, base: 0, rateBp: 1500 },
      { over: 3333300, base: 187500, rateBp: 2000 },
      { over: 6666700, base: 854180, rateBp: 2500 },
      { over: 16666700, base: 3354180, rateBp: 3000 },
      { over: 66666700, base: 18354180, rateBp: 3500 },
    ],
    annual: [
      { over: 25000000, base: 0, rateBp: 1500 },
      { over: 40000000, base: 2250000, rateBp: 2000 },
      { over: 80000000, base: 10250000, rateBp: 2500 },
      { over: 200000000, base: 40250000, rateBp: 3000 },
      { over: 800000000, base: 220250000, rateBp: 3500 },
    ],
  },
  premiums: { regularOvertime: 125, dayOvertime: 130, nightBp: 1000, days: { rest: 130, special: 130, special_rest: 150, holiday: 200, holiday_rest: 260 } },
  thirteenthExempt: 9000000,
}

test('SSS: the salary credit bracket, 5% and 10% shares, and EC', () => {
  assert.deepEqual(sssContribution(rates.sss, 25_000_00), { msc: 25_000_00, ee: 1_250_00, er: 2_500_00, ec: 30_00 })
  assert.deepEqual(sssContribution(rates.sss, 4_000_00), { msc: 5_000_00, ee: 250_00, er: 500_00, ec: 10_00 }) // the floor
  assert.deepEqual(sssContribution(rates.sss, 80_000_00), { msc: 35_000_00, ee: 1_750_00, er: 3_500_00, ec: 30_00 }) // the ceiling
  assert.equal(sssContribution(rates.sss, 5_249_99).msc, 5_000_00)
  assert.equal(sssContribution(rates.sss, 5_250_00).msc, 5_500_00)
  assert.equal(sssContribution(rates.sss, 14_749_99).ec, 10_00)
  assert.equal(sssContribution(rates.sss, 14_750_00).ec, 30_00)
})

test('PhilHealth: 5% shared equally, between the floor and ceiling; Pag-IBIG: 2% each up to ₱10,000', () => {
  assert.deepEqual(philhealthContribution(rates.philhealth, 25_000_00), { base: 25_000_00, ee: 625_00, er: 625_00 })
  assert.deepEqual(philhealthContribution(rates.philhealth, 8_000_00), { base: 10_000_00, ee: 250_00, er: 250_00 })
  assert.deepEqual(philhealthContribution(rates.philhealth, 150_000_00), { base: 100_000_00, ee: 2_500_00, er: 2_500_00 })
  assert.deepEqual(pagibigContribution(rates.pagibig, 25_000_00), { base: 10_000_00, ee: 200_00, er: 200_00 })
  assert.deepEqual(pagibigContribution(rates.pagibig, 1_500_00), { base: 1_500_00, ee: 15_00, er: 30_00 })
})

test('withholding tax tables (TRAIN, 2023 onwards)', () => {
  assert.equal(taxFromTable(rates.wtax.monthly, 20_833_00), 0)
  assert.equal(taxFromTable(rates.wtax.monthly, 30_000_00), 1_375_05) // 15% of 9,167
  assert.equal(taxFromTable(rates.wtax.monthly, 50_000_00), 1_875_00 + 3_333_40) // + 20% of 16,667
  assert.equal(taxFromTable(rates.wtax.semi_monthly, 15_000_00), 687_45)
  assert.equal(taxFromTable(rates.wtax.annual, 1_000_000_00), 152_500_00)
})

test('a monthly salary: the first cutoff has tax only; the second takes the month’s contributions', () => {
  const employee = { payBasis: 'monthly' as const, rate: 30_000_00, workDaysPerYear: 261, minimumWageEarner: false }
  const first = computePay({ employee, frequency: 'semi_monthly', inputs: emptyInputs(), rates, takesContributions: false, monthToDate: { grossTaxable: 0 } })
  assert.equal(first.gross, 15_000_00)
  assert.equal(first.tax, 687_45)
  assert.equal(first.net, 15_000_00 - 687_45)

  const second = computePay({ employee, frequency: 'semi_monthly', inputs: emptyInputs(), rates, takesContributions: true, monthToDate: { grossTaxable: 15_000_00 } })
  assert.deepEqual([second.sss.msc, second.sss.ee, second.philhealth.ee, second.pagibig.ee], [30_000_00, 1_500_00, 750_00, 200_00])
  assert.equal(second.taxable, 15_000_00 - 2_450_00)
  assert.equal(second.tax, 319_95) // 15% of 12,550 − 10,417
  assert.equal(second.net, 15_000_00 - 2_450_00 - 319_95)

  // two days absent and an hour late, at ₱30,000 × 12 ÷ 261 a day
  const docked = computePay({ employee, frequency: 'semi_monthly', inputs: PayInputs.parse({ absentDays: 2, lateMinutes: 60 }), rates, takesContributions: false, monthToDate: { grossTaxable: 0 } })
  const daily = Math.round((30_000_00 * 12) / 261)
  assert.equal(docked.basic, 15_000_00 - 2 * daily - Math.round(daily / 8))
})

test('premium pay: overtime, a worked regular holiday, a rest day, and night differential', () => {
  const employee = { payBasis: 'daily' as const, rate: 695_00, workDaysPerYear: 313, minimumWageEarner: true }
  const inputs = PayInputs.parse({ daysWorked: 10, dayHours: { holiday: 8, rest: 4 }, overtime: { regular: 2, holiday: 1 }, nightHours: 2 })
  const r = computePay({ employee, frequency: 'semi_monthly', inputs, rates, takesContributions: false, monthToDate: { grossTaxable: 0 } })
  const hourly = 695_00 / 8
  const amount = (code: string) => r.earnings.find((l) => l.code === code)?.amount
  assert.equal(amount('basic'), 6_950_00)
  assert.equal(amount('day_holiday'), Math.round(8 * hourly * 2)) // 200%
  assert.equal(amount('day_rest'), Math.round(4 * hourly * 1.3)) // 130%
  assert.equal(amount('ot_regular'), Math.round(2 * hourly * 1.25)) // +25%
  assert.equal(amount('ot_holiday'), Math.round(1 * hourly * 2.6)) // 200% × 130%
  assert.equal(amount('night'), Math.round(2 * hourly * 0.1))
  assert.equal(r.tax, 0) // minimum wage earner

  // a monthly salary already pays the holiday: working it earns the extra 100%
  const monthly = computePay({ employee: { payBasis: 'monthly', rate: 26_000_00, workDaysPerYear: 261, minimumWageEarner: false }, frequency: 'monthly', inputs: PayInputs.parse({ dayHours: { holiday: 8 } }), rates, takesContributions: false, monthToDate: { grossTaxable: 0 } })
  const daily = Math.round((26_000_00 * 12) / 261)
  assert.equal(monthly.earnings.find((l) => l.code === 'day_holiday')?.amount, Math.round(8 * (daily / 8)))
})

test('13th month: a twelfth of the year’s basic pay, tax only on what’s over ₱90,000', () => {
  const small = computeThirteenth({ basicThisYear: 360_000_00, alreadyPaid: 0, taxableThisYear: 300_000_00, minimumWageEarner: false, rates })
  assert.equal(small.gross, 30_000_00)
  assert.equal(small.tax, 0)
  const big = computeThirteenth({ basicThisYear: 1_200_000_00, alreadyPaid: 0, taxableThisYear: 1_000_000_00, minimumWageEarner: false, rates })
  assert.equal(big.gross, 100_000_00)
  assert.equal(big.nonTaxable, 90_000_00)
  assert.equal(big.tax, 2_500_00) // 25% of the ₱10,000 over the exemption, at that income
})
