import { z } from 'zod'
import { VAT_TREATMENTS, type DocumentTotals, type LineAmounts, type VatTreatment } from './finance.ts'
import { AttributesInput } from './templates.ts'
import { textField } from './workspace.ts'

// Inventory and purchasing (Phase 3).
//
// Quantities may have up to four decimals (2.5 kg). Costs are centavos. Stock is valued at moving
// average cost: each receipt blends into the item's average, and each issue takes stock out at it.

/** Rounds a quantity to the four decimals the database keeps. */
export const q4 = (n: number) => Math.round(n * 10_000) / 10_000

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use ${max} characters or fewer.`)
    .transform((v) => (v === '' ? undefined : v))
    .optional()

const qty = (label = 'quantity') =>
  z.coerce
    .number(`Enter the ${label}.`)
    .positive(`The ${label} must be more than zero.`)
    .max(1_000_000_000, `That ${label} is too large.`)
    .refine((v) => Math.abs(Math.round(v * 10_000) - v * 10_000) < 1e-6, 'Use at most four decimal places.')
    .transform(q4)

const nonNegativeQty = (label: string) =>
  z.coerce
    .number(`Enter the ${label}.`)
    .min(0, `The ${label} can’t be negative.`)
    .max(1_000_000_000)
    .transform(q4)

const centavos = (label: string) => z.number(`Enter the ${label}.`).int(`Enter the ${label} to the centavo.`).min(0, `The ${label} can’t be negative.`).max(1_000_000_000_000)

const dateSchema = z.iso.date('Enter a date.')

/* ---------------------------------------------------------------------------------------------
 * Units, warehouses, items
 * ------------------------------------------------------------------------------------------- */

export type Unit = { id: string; code: string; name: string }

export const UnitInput = z.object({
  code: z.string().trim().min(1, 'Enter a short code, like kg.').max(12, 'Use 12 characters or fewer.'),
  name: textField('unit name', 40),
})

export type Warehouse = { id: string; code: string; name: string; address: string | null; active: boolean }

export const WarehouseInput = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{1,12}$/, 'Use up to 12 letters, digits or dashes, like MNL-1.'),
  name: textField('warehouse name', 80),
  address: optionalText(300),
  active: z.boolean().default(true),
})
export type WarehouseInput = z.input<typeof WarehouseInput>

export const ITEM_KINDS = ['stock', 'service'] as const
export type ItemKind = (typeof ITEM_KINDS)[number]
export const ITEM_KIND_LABELS: Record<ItemKind, string> = { stock: 'Stock item (counted)', service: 'Service or non-stock' }

export const ItemInput = z
  .object({
    sku: z
      .string('Enter the SKU.')
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9._/-]{0,39}$/, 'Use up to 40 letters, digits and . _ / -, like RICE-25KG.'),
    name: textField('item name', 160),
    description: optionalText(500),
    kind: z.enum(ITEM_KINDS).default('stock'),
    barcode: z
      .string()
      .trim()
      .transform((v) => (v === '' ? undefined : v))
      .pipe(z.string().regex(/^[0-9A-Za-z-]{4,48}$/, 'A barcode is 4 to 48 letters and digits.').optional())
      .optional(),
    unitId: z.uuid('Choose the unit.'),
    salesPrice: centavos('selling price').default(0),
    purchaseCost: centavos('purchase cost').default(0),
    salesVat: z.enum(VAT_TREATMENTS).default('vatable'),
    trackLots: z.boolean().default(false),
    trackExpiry: z.boolean().default(false),
    reorderPoint: nonNegativeQty('reorder point').default(0),
    reorderQty: nonNegativeQty('reorder quantity').default(0),
    salesAccountId: z.uuid().nullish(),
    expenseAccountId: z.uuid().nullish(),
    active: z.boolean().default(true),
    /** The template's extra fields (FDA registration, hazard class, brand…): see shared/templates.ts. */
    attributes: AttributesInput,
  })
  .refine((i) => !i.trackExpiry || i.trackLots, { message: 'Expiry dates are kept per lot, so tracking expiry needs lot tracking too.', path: ['trackExpiry'] })
  .refine((i) => i.kind === 'stock' || (!i.trackLots && i.reorderPoint === 0), { message: 'Only stock items have lots and reorder points.', path: ['kind'] })
export type ItemInput = z.input<typeof ItemInput>

export type Item = {
  id: string
  sku: string
  name: string
  description: string | null
  kind: ItemKind
  barcode: string | null
  unit: Unit
  salesPrice: number
  purchaseCost: number
  salesVat: VatTreatment
  trackLots: boolean
  trackExpiry: boolean
  reorderPoint: number
  reorderQty: number
  salesAccountId: string | null
  expenseAccountId: string | null
  active: boolean
  /** Stock items: on hand across all warehouses, and its value at average cost. */
  onHand: number
  value: number
  /** Centavos per unit, with decimals. */
  averageCost: number
  low: boolean
  /** The template's extra fields, by key. */
  attributes: Record<string, string>
  /** A size or colour variant: the style it belongs to. */
  parentId: string | null
}

/** Lots held for quality control (templates with `qcRelease`) aren't sold or used until released. */
export const LOT_STATUSES = ['released', 'quarantine', 'rejected'] as const
export type LotStatus = (typeof LOT_STATUSES)[number]

export type StockLevel = { warehouse: { id: string; code: string; name: string }; lot: { id: string; lotNo: string; expiryDate: string | null; status: LotStatus } | null; quantity: number }

export const MOVE_KINDS = ['receipt', 'issue', 'adjustment', 'transfer', 'return', 'consume', 'produce'] as const
export type MoveKind = (typeof MOVE_KINDS)[number]
export const MOVE_KIND_LABELS: Record<MoveKind, string> = {
  receipt: 'Received',
  issue: 'Sold',
  adjustment: 'Adjusted',
  transfer: 'Moved',
  return: 'Returned',
  consume: 'Used in production',
  produce: 'Produced',
}

export type StockMove = {
  id: string
  date: string
  kind: MoveKind
  warehouse: { id: string; code: string; name: string }
  lot: { lotNo: string; expiryDate: string | null } | null
  quantity: number
  value: number
  reference: string | null
  sourceType: string | null
  sourceId: string | null
}

export type ItemDetail = Item & {
  levels: StockLevel[]
  moves: StockMove[]
  /** Apparel: the style's size × colour variants. */
  variants: { id: string; sku: string; name: string; colour: string; size: string; onHand: number }[]
  parent: { id: string; sku: string; name: string } | null
}

/** Making a style's variants: one item for each colour × size not already made. */
export const VariantsInput = z.object({
  colours: z.array(z.string().trim().min(1).max(30)).min(1, 'Enter at least one colour.').max(20),
  sizes: z.array(z.string().trim().min(1).max(12)).min(1, 'Enter at least one size.').max(20),
})
export type VariantsInput = z.input<typeof VariantsInput>

/** A lot waiting for quality control. */
export type QuarantineLot = { lotId: string; lotNo: string; expiryDate: string | null; item: { id: string; sku: string; name: string; unit: string }; quantity: number; value: number; receivedOn: string }

/* ---------------------------------------------------------------------------------------------
 * Adjustments and transfers
 * ------------------------------------------------------------------------------------------- */

export const ADJUSTMENT_REASONS = ['count', 'damage', 'expired', 'rejected', 'opening', 'other'] as const
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number]
export const ADJUSTMENT_REASON_LABELS: Record<AdjustmentReason, string> = {
  count: 'Stock count',
  damage: 'Damaged or lost',
  expired: 'Expired',
  rejected: 'Rejected in quality control',
  opening: 'Opening stock',
  other: 'Other',
}

const lotFields = {
  /** For lot-tracked items: the lot coming in, or the one going out (blank: earliest expiry first). */
  lotNo: optionalText(40),
  expiryDate: dateSchema.nullish(),
}

/**
 * One line of an adjustment: `change` is the difference (+ found, − lost). Or, after a count,
 * `counted` is what's on the shelf and the API works out the difference.
 */
export const AdjustmentLineInput = z
  .object({
    itemId: z.uuid('Choose an item.'),
    change: z.coerce.number().refine((v) => Math.abs(Math.round(v * 10_000) - v * 10_000) < 1e-6, 'Use at most four decimal places.').transform(q4).optional(),
    counted: nonNegativeQty('counted quantity').optional(),
    /** Centavos per unit for stock coming in; defaults to the average cost (or the purchase cost). */
    unitCost: centavos('unit cost').optional(),
    ...lotFields,
  })
  .refine((l) => (l.change === undefined) !== (l.counted === undefined), { message: 'Enter either the change or the counted quantity.', path: ['change'] })

export const AdjustmentInput = z.object({
  date: dateSchema,
  warehouseId: z.uuid('Choose the warehouse.'),
  reason: z.enum(ADJUSTMENT_REASONS),
  notes: optionalText(500),
  lines: z.array(AdjustmentLineInput).min(1, 'Add at least one item.').max(500),
})
export type AdjustmentInput = z.input<typeof AdjustmentInput>

export const TransferInput = z
  .object({
    date: dateSchema,
    fromWarehouseId: z.uuid('Choose where it comes from.'),
    toWarehouseId: z.uuid('Choose where it goes.'),
    notes: optionalText(500),
    lines: z
      .array(z.object({ itemId: z.uuid('Choose an item.'), quantity: qty(), lotNo: optionalText(40) }))
      .min(1, 'Add at least one item.')
      .max(500),
  })
  .refine((t) => t.fromWarehouseId !== t.toWarehouseId, { message: 'Choose two different warehouses.', path: ['toWarehouseId'] })
export type TransferInput = z.input<typeof TransferInput>

export type StockDocument = {
  id: string
  number: string
  kind: 'adjustment' | 'transfer' | 'receipt' | 'delivery'
  date: string
  reason: AdjustmentReason | null
  warehouse: { id: string; name: string }
  toWarehouse: { id: string; name: string } | null
  notes: string | null
  value: number
  journalEntryId: string | null
  lines: { item: { id: string; sku: string; name: string }; quantity: number; lotNo: string | null; value: number }[]
}

/* ---------------------------------------------------------------------------------------------
 * Purchase orders and receiving
 * ------------------------------------------------------------------------------------------- */

export const PO_STATUSES = ['draft', 'issued', 'partly_received', 'received', 'closed', 'cancelled'] as const
export type PoStatus = (typeof PO_STATUSES)[number]
export const PO_STATUS_LABELS: Record<PoStatus, string> = {
  draft: 'Draft',
  issued: 'Issued',
  partly_received: 'Partly received',
  received: 'Received',
  closed: 'Closed',
  cancelled: 'Cancelled',
}

export const PoLineInput = z.object({
  itemId: z.uuid('Choose an item.'),
  description: optionalText(300),
  quantity: qty(),
  unitCost: centavos('unit cost'),
  vat: z.enum(VAT_TREATMENTS),
  ewtCodeId: z.uuid().nullish(),
})

export const PurchaseOrderInput = z.object({
  supplierId: z.uuid('Choose a supplier.'),
  date: dateSchema,
  expectedDate: dateSchema.nullish(),
  warehouseId: z.uuid('Choose where it will be delivered.'),
  pricesIncludeVat: z.boolean().default(false),
  notes: optionalText(1000),
  lines: z.array(PoLineInput).min(1, 'Add at least one item.').max(200),
})
export type PurchaseOrderInput = z.input<typeof PurchaseOrderInput>

export type PoLine = LineAmounts & {
  id: string
  item: { id: string; sku: string; name: string; kind: ItemKind; trackLots: boolean; trackExpiry: boolean; unit: string }
  description: string
  quantity: number
  unitCost: number
  vat: VatTreatment
  ewtCodeId: string | null
  receivedQty: number
  billedQty: number
}

export type PurchaseOrderSummary = DocumentTotals & {
  id: string
  number: string | null
  status: PoStatus
  date: string
  expectedDate: string | null
  supplier: { id: string; name: string }
  warehouse: { id: string; name: string }
}

export type PurchaseOrder = PurchaseOrderSummary & {
  pricesIncludeVat: boolean
  notes: string | null
  lines: PoLine[]
  receipts: { id: string; number: string; date: string; status: 'posted' | 'void'; value: number }[]
  bills: { id: string; number: string | null; status: string; total: number }[]
}

export const ReceiptInput = z.object({
  date: dateSchema,
  warehouseId: z.uuid('Choose the warehouse.'),
  notes: optionalText(500),
  lines: z
    .array(z.object({ poLineId: z.uuid(), quantity: qty('quantity received'), ...lotFields }))
    .min(1, 'Enter what arrived.')
    .max(200),
})
export type ReceiptInput = z.input<typeof ReceiptInput>

/* ---------------------------------------------------------------------------------------------
 * Overview
 * ------------------------------------------------------------------------------------------- */

export type InventoryOverview = {
  stockValue: number
  itemCount: number
  low: { id: string; sku: string; name: string; onHand: number; reorderPoint: number; reorderQty: number; unit: string }[]
  expiring: { itemId: string; sku: string; name: string; lotNo: string; expiryDate: string; quantity: number; warehouse: string; warehouseId: string }[]
  openPurchaseOrders: number
}

export type ValuationRow = { itemId: string; sku: string; name: string; unit: string; quantity: number; averageCost: number; value: number }
