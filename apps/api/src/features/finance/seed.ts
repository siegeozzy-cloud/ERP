import type { AccountType, TaxKind } from '@erp/shared'
import type { Tx } from '../../db/types.ts'
import { accounts, sequences, taxCodes } from '../../db/schema.ts'

/**
 * What every new workspace starts with: a chart of accounts for a Philippine business, the tax
 * codes, and its document number counters. Phase 1's niche templates will add to the accounts.
 *
 * `key` marks the accounts the system posts to by itself. They can be renamed but not removed.
 */
type SeedAccount = { code: string; name: string; type: AccountType; subtype?: 'cash' | 'bank'; key?: string }

export const DEFAULT_ACCOUNTS: SeedAccount[] = [
  // Assets
  { code: '1000', name: 'Cash on Hand', type: 'asset', subtype: 'cash', key: 'cash' },
  { code: '1010', name: 'Cash in Bank', type: 'asset', subtype: 'bank', key: 'bank' },
  { code: '1100', name: 'Accounts Receivable', type: 'asset', key: 'ar' },
  { code: '1150', name: 'Creditable Withholding Tax', type: 'asset', key: 'cwt' },
  { code: '1160', name: 'Input VAT', type: 'asset', key: 'input_vat' },
  { code: '1170', name: 'Prepaid Expenses', type: 'asset' },
  { code: '1200', name: 'Inventory', type: 'asset', key: 'inventory' },
  { code: '1500', name: 'Property and Equipment', type: 'asset' },
  { code: '1510', name: 'Accumulated Depreciation', type: 'asset' },
  // Liabilities
  { code: '2000', name: 'Accounts Payable', type: 'liability', key: 'ap' },
  { code: '2100', name: 'Output VAT', type: 'liability', key: 'output_vat' },
  { code: '2110', name: 'VAT Payable', type: 'liability' },
  { code: '2120', name: 'Expanded Withholding Tax Payable', type: 'liability', key: 'ewt_payable' },
  { code: '2130', name: 'Withholding Tax on Compensation Payable', type: 'liability' },
  { code: '2140', name: 'SSS Contributions Payable', type: 'liability' },
  { code: '2150', name: 'PhilHealth Contributions Payable', type: 'liability' },
  { code: '2160', name: 'Pag-IBIG Contributions Payable', type: 'liability' },
  { code: '2170', name: 'Percentage Tax Payable', type: 'liability', key: 'percentage_tax_payable' },
  { code: '2200', name: 'Accrued Expenses', type: 'liability' },
  { code: '2300', name: 'Loans Payable', type: 'liability' },
  // Equity
  { code: '3000', name: 'Owner’s Capital', type: 'equity' },
  { code: '3100', name: 'Retained Earnings', type: 'equity', key: 'retained_earnings' },
  { code: '3200', name: 'Owner’s Drawings', type: 'equity' },
  // Income
  { code: '4000', name: 'Sales', type: 'income', key: 'sales' },
  { code: '4010', name: 'Service Revenue', type: 'income' },
  { code: '4100', name: 'Sales Returns and Discounts', type: 'income' },
  { code: '4200', name: 'Other Income', type: 'income' },
  // Expenses
  { code: '5000', name: 'Cost of Sales', type: 'expense', key: 'cogs' },
  { code: '5100', name: 'Purchases', type: 'expense', key: 'purchases' },
  { code: '6000', name: 'Salaries and Wages', type: 'expense' },
  { code: '6010', name: 'SSS, PhilHealth and Pag-IBIG Contributions', type: 'expense' },
  { code: '6100', name: 'Rent', type: 'expense' },
  { code: '6110', name: 'Utilities', type: 'expense' },
  { code: '6120', name: 'Communication', type: 'expense' },
  { code: '6130', name: 'Transportation and Travel', type: 'expense' },
  { code: '6140', name: 'Office Supplies', type: 'expense' },
  { code: '6150', name: 'Repairs and Maintenance', type: 'expense' },
  { code: '6160', name: 'Professional Fees', type: 'expense' },
  { code: '6170', name: 'Taxes and Licenses', type: 'expense', key: 'taxes_and_licenses' },
  { code: '6180', name: 'Depreciation', type: 'expense' },
  { code: '6190', name: 'Bank Charges', type: 'expense' },
  { code: '6200', name: 'Representation and Entertainment', type: 'expense' },
  { code: '6900', name: 'Miscellaneous Expense', type: 'expense' },
]

/**
 * Starting tax codes. Rates are data with an effective date: when BIR changes one, a new row with a
 * later `effectiveFrom` is added and documents dated after it use the new rate.
 *
 * Withholding codes follow the BIR ATC list (WI = paid to individuals, WC = to corporations).
 * Check them against the current revenue regulations before relying on them.
 */
type SeedTax = { kind: TaxKind; code: string; name: string; rateBp: number; atc?: string; effectiveFrom: string }

export const DEFAULT_TAX_CODES: SeedTax[] = [
  { kind: 'vat', code: 'VAT12', name: 'Value-added tax', rateBp: 1200, effectiveFrom: '2006-02-01' },
  { kind: 'percentage', code: 'PT3', name: 'Percentage tax (Sec. 116)', rateBp: 300, effectiveFrom: '2023-07-01' },
  { kind: 'ewt', code: 'WI010', atc: 'WI010', name: 'Professional fees — individual (gross income ₱3M or less)', rateBp: 500, effectiveFrom: '2018-01-01' },
  { kind: 'ewt', code: 'WC010', atc: 'WC010', name: 'Professional fees — corporation (gross income ₱720K or less)', rateBp: 1000, effectiveFrom: '2018-01-01' },
  { kind: 'ewt', code: 'WI100', atc: 'WI100', name: 'Rentals — individual', rateBp: 500, effectiveFrom: '2018-01-01' },
  { kind: 'ewt', code: 'WC100', atc: 'WC100', name: 'Rentals — corporation', rateBp: 500, effectiveFrom: '2018-01-01' },
  { kind: 'ewt', code: 'WI120', atc: 'WI120', name: 'Contractors — individual', rateBp: 200, effectiveFrom: '2018-01-01' },
  { kind: 'ewt', code: 'WC120', atc: 'WC120', name: 'Contractors — corporation', rateBp: 200, effectiveFrom: '2018-01-01' },
  { kind: 'ewt', code: 'WI158', atc: 'WI158', name: 'Purchase of goods by top withholding agent — individual', rateBp: 100, effectiveFrom: '2018-01-01' },
  { kind: 'ewt', code: 'WC158', atc: 'WC158', name: 'Purchase of goods by top withholding agent — corporation', rateBp: 100, effectiveFrom: '2018-01-01' },
  { kind: 'ewt', code: 'WI160', atc: 'WI160', name: 'Purchase of services by top withholding agent — individual', rateBp: 200, effectiveFrom: '2018-01-01' },
  { kind: 'ewt', code: 'WC160', atc: 'WC160', name: 'Purchase of services by top withholding agent — corporation', rateBp: 200, effectiveFrom: '2018-01-01' },
]

/** Document number counters: prefix and the sequence each kind of document draws from. */
export const SEQUENCES = [
  { kind: 'journal', prefix: 'JE-' },
  { kind: 'sales_invoice', prefix: 'SI-' },
  { kind: 'bill', prefix: 'BILL-' },
  { kind: 'payment_received', prefix: 'CR-' },
  { kind: 'payment_made', prefix: 'PV-' },
] as const

export type SequenceKind = (typeof SEQUENCES)[number]['kind']

export async function seedFinance(tx: Tx, workspaceId: string) {
  await tx.insert(accounts).values(DEFAULT_ACCOUNTS.map((a) => ({ workspaceId, code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? 'other', systemKey: a.key ?? null })))
  await tx.insert(taxCodes).values(DEFAULT_TAX_CODES.map((t) => ({ workspaceId, kind: t.kind, code: t.code, name: t.name, rateBp: t.rateBp, atc: t.atc ?? null, effectiveFrom: t.effectiveFrom })))
  await tx.insert(sequences).values(SEQUENCES.map((s) => ({ workspaceId, kind: s.kind, prefix: s.prefix })))
}
