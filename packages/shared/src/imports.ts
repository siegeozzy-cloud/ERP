import { z } from 'zod'

// Excel import (Phase 9): what a new business brings on day one. The web app reads the sheet
// (ExcelJS, in the browser), matches its header row to these columns, and sends the rows as text;
// the API turns them into the usual inputs, checks every row with the same rules as the forms, and
// saves all of them or none.

export const IMPORT_KINDS = ['items', 'contacts', 'opening-stock'] as const
export type ImportKind = (typeof IMPORT_KINDS)[number]

export type ImportColumn = { key: string; header: string; required?: boolean; example: string; hint?: string }

export const IMPORT_COLUMNS: Record<ImportKind, ImportColumn[]> = {
  items: [
    { key: 'sku', header: 'SKU', required: true, example: 'RICE-25KG' },
    { key: 'name', header: 'Name', required: true, example: 'Dinorado rice, 25 kg' },
    { key: 'kind', header: 'Type', example: 'stock', hint: 'stock or service' },
    { key: 'unit', header: 'Unit', required: true, example: 'sack', hint: 'A unit code, like pc, kg, sack, box' },
    { key: 'salesPrice', header: 'Selling price', example: '1500.00' },
    { key: 'purchaseCost', header: 'Cost', example: '1100.00' },
    { key: 'barcode', header: 'Barcode', example: '4800000000017' },
    { key: 'reorderPoint', header: 'Reorder point', example: '20' },
    { key: 'reorderQty', header: 'Reorder quantity', example: '100' },
    { key: 'trackLots', header: 'Track lots', example: 'yes', hint: 'yes or no' },
    { key: 'trackExpiry', header: 'Track expiry', example: 'yes', hint: 'yes or no' },
  ],
  contacts: [
    { key: 'name', header: 'Name', required: true, example: 'Café Uno Inc.' },
    { key: 'type', header: 'Type', required: true, example: 'customer', hint: 'customer, supplier or both' },
    { key: 'tin', header: 'TIN', example: '123-456-789-00000' },
    { key: 'address', header: 'Address', example: 'Legazpi Village, Makati' },
    { key: 'email', header: 'Email', example: 'ap@cafeuno.example' },
    { key: 'phone', header: 'Phone', example: '0917 555 1234' },
    { key: 'paymentTermsDays', header: 'Days to pay', example: '30' },
    { key: 'creditLimit', header: 'Credit limit', example: '100000' },
  ],
  'opening-stock': [
    { key: 'sku', header: 'SKU', required: true, example: 'RICE-25KG' },
    { key: 'warehouse', header: 'Warehouse', example: 'MAIN', hint: 'A warehouse code; blank: the first warehouse' },
    { key: 'quantity', header: 'Quantity', required: true, example: '120' },
    { key: 'unitCost', header: 'Unit cost', required: true, example: '1050.00' },
    { key: 'lotNo', header: 'Lot', example: 'L-2611', hint: 'Lot-tracked items' },
    { key: 'expiryDate', header: 'Expiry', example: '2027-06-30', hint: 'YYYY-MM-DD, for items that track expiry' },
  ],
}

export const IMPORT_LABELS: Record<ImportKind, string> = { items: 'Items', contacts: 'Customers and suppliers', 'opening-stock': 'Opening stock' }

/** At most this many rows at once. */
export const IMPORT_MAX_ROWS = 5000

export const ImportInput = z.object({
  /** One object per spreadsheet row: column key → cell text. */
  rows: z.array(z.record(z.string(), z.string().max(2000))).min(1, 'The sheet has no rows.').max(IMPORT_MAX_ROWS, `Import at most ${IMPORT_MAX_ROWS} rows at a time.`),
  /** Check only: nothing is saved. */
  dryRun: z.boolean().default(false),
  /** Opening stock: the date it's counted as of. */
  date: z.iso.date().optional(),
})
export type ImportInput = z.input<typeof ImportInput>

/** What an import did, or would do. Errors name the sheet row (header = row 1). */
export type ImportResult = { created: number; updated: number; errors: { row: number; message: string }[]; saved: boolean }
