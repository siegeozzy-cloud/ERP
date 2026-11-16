import { z } from 'zod'
import { q4 } from './inventory.ts'
import { textField } from './workspace.ts'

// Manufacturing (Phase 6): bills of materials with routings, work orders, quality control and
// material requirements planning.
//
// A bill of materials (BOM) says what one batch of a product takes: its components (which may
// themselves be made: multi-level), the steps at each work centre, and the quality checks. A work
// order makes a number of units from it. Costing follows the stock engine: materials leave stock at
// moving average cost into Work in Process, labour and overhead are applied at each work centre's
// hourly rate, and the good units go back into stock at what they cost; rejects go to Spoilage.

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
    .refine((v) => Math.abs(Math.round(v * 10_000) - v * 10_000) < 1e-6, 'Use at most four decimal places.')
    .transform(q4)

const centavos = (label: string) => z.number(`Enter the ${label}.`).int(`Enter the ${label} to the centavo.`).min(0, `The ${label} can’t be negative.`).max(1_000_000_000_000)
const minutes = (label: string) => z.coerce.number(`Enter the ${label}.`).min(0, `The ${label} can’t be negative.`).max(100_000, 'That’s more than two months.')
const dateSchema = z.iso.date('Enter a date.')

/* ---------------------------------------------------------------------------------------------
 * Work centres
 * ------------------------------------------------------------------------------------------- */

export const WorkCenterInput = z.object({
  code: z
    .string('Enter a code.')
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{0,19}$/, 'Use up to 20 letters, digits and dashes, like MIXING.'),
  name: textField('name', 80),
  /** Labour and overhead per hour, in centavos: what an hour here adds to a product's cost. */
  costPerHour: centavos('cost per hour'),
  active: z.boolean().default(true),
})
export type WorkCenterInput = z.input<typeof WorkCenterInput>
export type WorkCenter = { id: string; code: string; name: string; costPerHour: number; active: boolean }

/* ---------------------------------------------------------------------------------------------
 * Bills of materials
 * ------------------------------------------------------------------------------------------- */

export const BomInput = z
  .object({
    /** The product it makes. */
    itemId: z.uuid('Choose the product.'),
    /** How much one batch makes, in the product's unit. */
    outputQty: qty('batch size'),
    /** The one used by work orders and planning. Only one per product. */
    active: z.boolean().default(true),
    notes: optionalText(1000),
    lines: z
      .array(z.object({ itemId: z.uuid('Choose a component.'), quantity: qty('quantity'), notes: optionalText(200) }))
      .min(1, 'Add at least one component.')
      .max(200, 'Use 200 components or fewer.'),
    /** The routing: steps in order, each at a work centre, with minutes per batch. */
    operations: z
      .array(z.object({ workCenterId: z.uuid('Choose the work centre.'), description: textField('step', 160), minutes: minutes('minutes per batch') }))
      .max(50)
      .default([]),
    /** Quality checks a work order must record before it's completed, e.g. "Weight 25 kg ± 100 g". */
    qcChecks: z.array(textField('check', 200)).max(30).default([]),
  })
  .refine((b) => new Set(b.lines.map((l) => l.itemId)).size === b.lines.length, { message: 'Each component once, please: add the quantities together.', path: ['lines'] })
export type BomInput = z.input<typeof BomInput>

export type BomLine = { id: string; item: { id: string; sku: string; name: string; unit: string; trackLots: boolean; made: boolean }; quantity: number; notes: string | null; averageCost: number }
export type BomOperation = { id: string; workCenter: { id: string; code: string; name: string; costPerHour: number }; description: string; minutes: number; cost: number }

export type BomSummary = {
  id: string
  /** BOM-PANDESAL-1: the product's SKU and a version number. */
  code: string
  version: number
  active: boolean
  item: { id: string; sku: string; name: string; unit: string }
  outputQty: number
  componentCount: number
  /** What a unit costs to make now: materials at average cost, plus labour and overhead. */
  unitCost: number
}

export type Bom = BomSummary & {
  notes: string | null
  lines: BomLine[]
  operations: BomOperation[]
  qcChecks: string[]
  /** Per batch. */
  materialCost: number
  conversionCost: number
  /** Products whose BOMs use this BOM's product. */
  usedIn: { id: string; code: string; item: { id: string; name: string } }[]
}

/* ---------------------------------------------------------------------------------------------
 * Work orders
 * ------------------------------------------------------------------------------------------- */

export const WO_STATUSES = ['draft', 'released', 'in_progress', 'completed', 'cancelled'] as const
export type WoStatus = (typeof WO_STATUSES)[number]
export const WO_STATUS_LABELS: Record<WoStatus, string> = { draft: 'Draft', released: 'Released', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' }
export const OPEN_WO_STATUSES = ['draft', 'released', 'in_progress'] as const satisfies readonly WoStatus[]

export const WorkOrderInput = z
  .object({
    itemId: z.uuid('Choose the product.'),
    /** Units to make. */
    quantity: qty('quantity to make'),
    /** Where materials come from and the product goes to. */
    warehouseId: z.uuid('Choose the warehouse.'),
    startDate: dateSchema,
    dueDate: dateSchema,
    /** Made for a customer's order. */
    salesOrderId: z.uuid().nullish(),
    notes: optionalText(1000),
  })
  .refine((w) => w.dueDate >= w.startDate, { message: 'It can’t be due before it starts.', path: ['dueDate'] })
export type WorkOrderInput = z.input<typeof WorkOrderInput>

/** Starting: the materials leave stock. Quantities default to the BOM's; change them if more or less was used. */
export const WoStartInput = z.object({
  date: dateSchema,
  materials: z.array(z.object({ materialId: z.uuid(), quantity: nonNegativeQty('quantity used'), lotNo: optionalText(40) })).max(200),
})
export type WoStartInput = z.input<typeof WoStartInput>

export const WoCompleteInput = z
  .object({
    date: dateSchema,
    /** Units that passed, into stock. */
    goodQty: nonNegativeQty('good quantity'),
    /** Units that failed, written off. */
    rejectedQty: nonNegativeQty('rejected quantity').default(0),
    /** Lot-tracked products: the batch number and expiry printed on them. */
    lotNo: optionalText(40),
    expiryDate: dateSchema.nullish(),
    /** Minutes actually spent at each step, defaulting to the routing's. */
    operations: z.array(z.object({ operationId: z.uuid(), minutes: minutes('minutes') })).max(50).default([]),
    /** One answer per QC check, in the BOM's order. */
    qc: z.array(z.object({ passed: z.boolean(), note: optionalText(300) })).max(30).default([]),
    notes: optionalText(1000),
  })
  .refine((c) => c.goodQty + c.rejectedQty > 0, { message: 'Enter what was made.', path: ['goodQty'] })
export type WoCompleteInput = z.input<typeof WoCompleteInput>

export type WoMaterial = {
  id: string
  item: { id: string; sku: string; name: string; unit: string; trackLots: boolean }
  plannedQty: number
  issuedQty: number
  /** Centavos taken into Work in Process. */
  issuedValue: number
  /** On hand now, everywhere: for the "short" warning before starting. */
  onHand: number
}
export type WoOperation = { id: string; workCenter: { id: string; code: string; name: string }; description: string; plannedMinutes: number; actualMinutes: number | null; cost: number }
export type QcResult = { check: string; passed: boolean; note: string | null }

export type WorkOrderSummary = {
  id: string
  /** WO-000001, given when released. */
  number: string | null
  status: WoStatus
  item: { id: string; sku: string; name: string; unit: string }
  quantity: number
  goodQty: number
  rejectedQty: number
  startDate: string
  dueDate: string
  warehouse: { id: string; name: string }
  salesOrder: { id: string; number: string | null; customer: string } | null
  /** Past its due date and not finished. */
  late: boolean
}

export type WorkOrder = WorkOrderSummary & {
  bom: { id: string; code: string; outputQty: number }
  notes: string | null
  materials: WoMaterial[]
  operations: WoOperation[]
  qcChecks: string[]
  qc: QcResult[]
  lot: { lotNo: string; expiryDate: string | null } | null
  materialCost: number
  conversionCost: number
  /** What each good unit went into stock at. */
  unitCost: number | null
  startedAt: string | null
  completedAt: string | null
  /** The journal entries it made: materials issued, and completion. */
  entries: { id: string; number: string | null; memo: string }[]
}

/* ---------------------------------------------------------------------------------------------
 * Planning (MRP)
 * ------------------------------------------------------------------------------------------- */

/**
 * One item's plan. Needed = open sales orders not yet delivered + materials for open work orders not
 * yet issued (including the suggestions above it in the BOM). Available = on hand (not expired) +
 * on order from suppliers + to come out of open work orders. When available − needed falls below
 * the reorder point, the shortfall (at least the reorder quantity) is suggested: made, if the item
 * has an active BOM, else bought.
 */
export type MrpRow = {
  item: { id: string; sku: string; name: string; unit: string }
  action: 'make' | 'buy'
  /** How deep in the BOMs it sits: 0 for finished products. */
  level: number
  demand: { salesOrders: number; workOrders: number; planned: number }
  onHand: number
  incoming: { purchaseOrders: number; workOrders: number }
  reorderPoint: number
  /** Suggested quantity, 0 when nothing is needed. */
  suggested: number
  /** Buy: the supplier last ordered from, and their last price. */
  supplier: { id: string; name: string } | null
  unitCost: number
}
export type MrpPlan = { asOf: string; rows: MrpRow[] }

/** Turning buy suggestions into draft purchase orders (one per supplier). */
export const MrpBuyInput = z.object({
  warehouseId: z.uuid('Choose where the goods go.'),
  lines: z
    .array(z.object({ itemId: z.uuid(), supplierId: z.uuid('Choose a supplier.'), quantity: qty(), unitCost: centavos('unit cost') }))
    .min(1, 'Choose something to buy.')
    .max(200),
})
export type MrpBuyInput = z.input<typeof MrpBuyInput>

export type ManufacturingOverview = {
  open: number
  inProgress: number
  late: number
  /** This month: units made and rejected. */
  madeThisMonth: number
  rejectedThisMonth: number
  /** Next 14 days: minutes booked at each work centre by open work orders. */
  load: { workCenter: { id: string; code: string; name: string }; minutes: number }[]
  dueSoon: WorkOrderSummary[]
  toMake: number
  toBuy: number
}
