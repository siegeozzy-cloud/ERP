import { z } from 'zod'
import { VAT_TREATMENTS, type Contact, type DocumentStatus, type DocumentTotals, type LineAmounts, type VatTreatment } from './finance.ts'
import type { ItemKind } from './inventory.ts'
import { optionalTinSchema, textField } from './workspace.ts'

// Sales & CRM (Phase 4).
//
// A lead is a possible sale. It becomes a customer, gets a quote (QT-), the accepted quote becomes a
// sales order (SO-), the order is delivered (DR-, which takes the stock out and books its cost), and
// what was delivered is invoiced (SI-, which books the sale).

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use ${max} characters or fewer.`)
    .transform((v) => (v === '' ? undefined : v))
    .optional()

const dateSchema = z.iso.date('Enter a date.')

const centavos = (label: string) => z.number(`Enter the ${label}.`).int(`Enter the ${label} to the centavo.`).min(0, `The ${label} can’t be negative.`).max(1_000_000_000_000, `That ${label} is too large.`)

const qty = (label = 'quantity') =>
  z.coerce
    .number(`Enter the ${label}.`)
    .positive(`The ${label} must be more than zero.`)
    .max(1_000_000_000, `That ${label} is too large.`)
    .refine((v) => Math.abs(Math.round(v * 10_000) - v * 10_000) < 1e-6, 'Use at most four decimal places.')
    .transform((v) => Math.round(v * 10_000) / 10_000)

const email = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v.toLowerCase()))
  .pipe(z.email('Enter a valid email address.').optional())
  .optional()

/* ---------------------------------------------------------------------------------------------
 * Customers
 * ------------------------------------------------------------------------------------------- */

export const CustomerInput = z.object({
  name: textField('registered name', 160),
  tin: optionalTinSchema.optional(),
  address: optionalText(300),
  email,
  phone: optionalText(40),
  /** Days the customer has to pay. Invoices made from their orders fall due this many days later. */
  paymentTermsDays: z.number().int('Enter whole days.').min(0, 'Days can’t be negative.').max(365, 'Use 365 days or fewer.').nullish(),
  /** The most they may owe, in centavos, counting orders not yet invoiced. Null: no limit. */
  creditLimit: centavos('credit limit').nullish(),
  /** The price list their prices come from; null: none. */
  priceListId: z.uuid().nullish(),
})
export type CustomerInput = z.input<typeof CustomerInput>

/** A customer with what they owe and have on order. */
export type CustomerSummary = Contact & {
  /** Posted invoices not yet paid. */
  owed: number
  overdue: number
  /** Confirmed orders not yet invoiced. */
  onOrder: number
  openLeads: number
}

export type CustomerDetail = CustomerSummary & {
  quotes: QuoteSummary[]
  orders: SalesOrderSummary[]
  invoices: { id: string; number: string | null; status: DocumentStatus; date: string; dueDate: string | null; total: number; balance: number }[]
  leads: Lead[]
  activities: Activity[]
}

/* ---------------------------------------------------------------------------------------------
 * Leads and the pipeline
 * ------------------------------------------------------------------------------------------- */

export const LEAD_STAGES = ['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const
export type LeadStage = (typeof LEAD_STAGES)[number]
export const OPEN_LEAD_STAGES = ['new', 'qualified', 'proposal', 'negotiation'] as const satisfies readonly LeadStage[]
export const LEAD_STAGE_LABELS: Record<LeadStage, string> = {
  new: 'New',
  qualified: 'Qualified',
  proposal: 'Quote sent',
  negotiation: 'Negotiating',
  won: 'Won',
  lost: 'Lost',
}
/** How likely a lead at each stage is to close, for the weighted pipeline. Percent. */
export const LEAD_STAGE_ODDS: Record<LeadStage, number> = { new: 10, qualified: 25, proposal: 50, negotiation: 75, won: 100, lost: 0 }

export const LEAD_SOURCES = ['referral', 'walk_in', 'website', 'social', 'event', 'cold_call', 'other'] as const
export type LeadSource = (typeof LEAD_SOURCES)[number]
export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  referral: 'Referral',
  walk_in: 'Walk-in',
  website: 'Website',
  social: 'Facebook or social media',
  event: 'Trade fair or event',
  cold_call: 'Cold call',
  other: 'Other',
}

export const LeadInput = z
  .object({
    /** What they might buy: "Weekly rice supply for 3 branches". */
    title: textField('what they want', 160),
    companyName: optionalText(160),
    personName: optionalText(120),
    email,
    phone: optionalText(40),
    source: z.enum(LEAD_SOURCES).default('other'),
    /** What the deal could be worth, in centavos. */
    value: centavos('expected value').default(0),
    expectedClose: dateSchema.nullish(),
    /** The member working the lead. */
    ownerId: z.uuid().nullish(),
    /** When the lead is an existing customer. */
    customerId: z.uuid().nullish(),
    notes: optionalText(2000),
  })
  .refine((l) => l.companyName || l.personName || l.customerId, { message: 'Enter the company or the person’s name.', path: ['companyName'] })
export type LeadInput = z.input<typeof LeadInput>

export const LeadStageInput = z
  .object({ stage: z.enum(LEAD_STAGES), lostReason: optionalText(300) })
  .refine((s) => s.stage !== 'lost' || s.lostReason, { message: 'Say why it was lost, so the team can learn from it.', path: ['lostReason'] })
export type LeadStageInput = z.input<typeof LeadStageInput>

export type Lead = {
  id: string
  title: string
  companyName: string | null
  personName: string | null
  email: string | null
  phone: string | null
  source: LeadSource
  stage: LeadStage
  value: number
  expectedClose: string | null
  owner: { id: string; name: string } | null
  customer: { id: string; name: string } | null
  notes: string | null
  lostReason: string | null
  closedAt: string | null
  lastActivityAt: string | null
  createdAt: string
}

export type LeadDetail = Lead & { activities: Activity[]; quotes: QuoteSummary[] }

/** What a lead is called on a card: the company, else the person, else the customer. */
export const leadName = (l: Pick<Lead, 'companyName' | 'personName' | 'customer'>) => l.companyName ?? l.customer?.name ?? l.personName ?? ''

/* ---------------------------------------------------------------------------------------------
 * Activities: calls, meetings, emails and notes, on a lead or a customer
 * ------------------------------------------------------------------------------------------- */

export const ACTIVITY_KINDS = ['note', 'call', 'meeting', 'email'] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]
export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = { note: 'Note', call: 'Call', meeting: 'Meeting', email: 'Email' }

export const ActivityInput = z.object({
  kind: z.enum(ACTIVITY_KINDS).default('note'),
  body: textField('what happened', 2000),
  date: dateSchema,
})
export type ActivityInput = z.input<typeof ActivityInput>

export type Activity = {
  id: string
  kind: ActivityKind
  body: string
  date: string
  author: { id: string; name: string } | null
  lead: { id: string; title: string } | null
  createdAt: string
}

/* ---------------------------------------------------------------------------------------------
 * Quotes and sales orders share their lines
 * ------------------------------------------------------------------------------------------- */

export const SalesLineInput = z.object({
  itemId: z.uuid('Choose an item.'),
  description: optionalText(300),
  quantity: qty(),
  unitPrice: centavos('price'),
  vat: z.enum(VAT_TREATMENTS),
})

const salesLines = z.array(SalesLineInput).min(1, 'Add at least one item.').max(200, 'Use 200 lines or fewer.')

export type SalesLine = LineAmounts & {
  id: string
  item: { id: string; sku: string; name: string; kind: ItemKind; trackLots: boolean; unit: string }
  description: string
  quantity: number
  unitPrice: number
  vat: VatTreatment
  /** Sales order lines: how much has gone out, and been invoiced. */
  deliveredQty: number
  invoicedQty: number
}

/** An item as the sales side sees it: what it sells for and how many are on hand. */
export type SalesItem = { id: string; sku: string; name: string; kind: ItemKind; unit: string; salesPrice: number; salesVat: VatTreatment; onHand: number }

/* ---------------------------------------------------------------------------------------------
 * Quotes
 * ------------------------------------------------------------------------------------------- */

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined'] as const
export type QuoteStatus = (typeof QUOTE_STATUSES)[number]
export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = { draft: 'Draft', sent: 'Sent', accepted: 'Accepted', declined: 'Declined' }

export const QuoteInput = z
  .object({
    customerId: z.uuid('Choose a customer.'),
    leadId: z.uuid().nullish(),
    date: dateSchema,
    validUntil: dateSchema.nullish(),
    pricesIncludeVat: z.boolean().default(false),
    notes: optionalText(1000),
    lines: salesLines,
  })
  .refine((q) => !q.validUntil || q.validUntil >= q.date, { message: 'A quote can’t expire before its date.', path: ['validUntil'] })
export type QuoteInput = z.input<typeof QuoteInput>

export type QuoteSummary = DocumentTotals & {
  id: string
  /** QT-000001, given when it's sent. */
  number: string | null
  status: QuoteStatus
  date: string
  validUntil: string | null
  /** Sent, and past its valid-until date. */
  expired: boolean
  customer: { id: string; name: string }
  lead: { id: string; title: string } | null
  salesOrder: { id: string; number: string | null } | null
}

export type Quote = QuoteSummary & { pricesIncludeVat: boolean; notes: string | null; lines: SalesLine[] }

/* ---------------------------------------------------------------------------------------------
 * Sales orders and deliveries
 * ------------------------------------------------------------------------------------------- */

export const SO_STATUSES = ['draft', 'confirmed', 'partly_delivered', 'delivered', 'closed', 'cancelled'] as const
export type SoStatus = (typeof SO_STATUSES)[number]
export const SO_STATUS_LABELS: Record<SoStatus, string> = {
  draft: 'Draft',
  confirmed: 'Confirmed',
  partly_delivered: 'Partly delivered',
  delivered: 'Delivered',
  closed: 'Closed',
  cancelled: 'Cancelled',
}

export const SalesOrderInput = z
  .object({
    customerId: z.uuid('Choose a customer.'),
    date: dateSchema,
    deliveryDate: dateSchema.nullish(),
    /** Where the goods ship from. Needed when any line is a stock item. */
    warehouseId: z.uuid().nullish(),
    /** The customer's own purchase order number, printed on the delivery receipt and invoice. */
    customerPoNo: optionalText(60),
    pricesIncludeVat: z.boolean().default(false),
    notes: optionalText(1000),
    lines: salesLines,
  })
  .refine((o) => !o.deliveryDate || o.deliveryDate >= o.date, { message: 'Delivery can’t be before the order.', path: ['deliveryDate'] })
export type SalesOrderInput = z.input<typeof SalesOrderInput>

export type SalesOrderSummary = DocumentTotals & {
  id: string
  /** SO-000001, given when it's confirmed. */
  number: string | null
  status: SoStatus
  date: string
  deliveryDate: string | null
  customerPoNo: string | null
  customer: { id: string; name: string }
  warehouse: { id: string; name: string } | null
  quote: { id: string; number: string | null } | null
}

export type SalesOrder = SalesOrderSummary & {
  pricesIncludeVat: boolean
  notes: string | null
  lines: SalesLine[]
  deliveries: { id: string; number: string; date: string; value: number }[]
  invoices: { id: string; number: string | null; status: DocumentStatus; total: number }[]
  /** Make to order: work orders made for it, and what they cost against the order before VAT. */
  workOrders: { id: string; number: string | null; status: string; item: string; quantity: number; cost: number }[]
  productionCost: number
}

/* ---------------------------------------------------------------------------------------------
 * Price lists (Phase 8, the Wholesale pack; any workspace can use them)
 * ------------------------------------------------------------------------------------------- */

/**
 * A price list gives some customers their own prices, with quantity breaks: the price for an item is
 * the line with the highest minimum quantity the order reaches. Items not on the list sell at their
 * own price.
 */
export const PriceListInput = z.object({
  name: textField('name', 80),
  notes: optionalText(300),
  active: z.boolean().default(true),
  lines: z
    .array(z.object({ itemId: z.uuid('Choose an item.'), minQty: z.coerce.number().min(0).max(1_000_000_000).default(0), price: centavos('price') }))
    .max(2000),
})
export type PriceListInput = z.input<typeof PriceListInput>
export type PriceList = {
  id: string
  name: string
  notes: string | null
  active: boolean
  customerCount: number
  lines: { id: string; item: { id: string; sku: string; name: string; unit: string; salesPrice: number }; minQty: number; price: number }[]
}
/** GET /sales/price: what an item sells for to a customer at a quantity. */
export type QuotedPrice = { price: number; source: 'list' | 'item'; priceList: string | null }

export const DeliveryInput = z.object({
  date: dateSchema,
  warehouseId: z.uuid('Choose the warehouse it leaves from.'),
  notes: optionalText(500),
  lines: z
    .array(
      z.object({
        soLineId: z.uuid(),
        quantity: qty('quantity delivered'),
        /** Lot-tracked items: the lot that went. Blank takes the earliest-expiring first. */
        lotNo: optionalText(40),
      }),
    )
    .min(1, 'Enter what went out.')
    .max(200),
})
export type DeliveryInput = z.input<typeof DeliveryInput>

/** "Create invoice" on an order. Dated today unless another date is given (e.g. the delivery's). */
export const InvoiceFromOrderInput = z.object({ date: dateSchema.optional() })

/** A delivery receipt (DR-): what left, for whom, on which order. */
export type Delivery = {
  id: string
  number: string
  date: string
  warehouse: { id: string; name: string; address: string | null }
  notes: string | null
  customer: { id: string; name: string; tin: string | null; address: string | null }
  salesOrder: { id: string; number: string | null; customerPoNo: string | null }
  /** Cost of the goods, at average cost. */
  value: number
  lines: { item: { id: string; sku: string; name: string; unit: string }; quantity: number; lotNo: string | null; expiryDate: string | null }[]
}

/* ---------------------------------------------------------------------------------------------
 * Overview
 * ------------------------------------------------------------------------------------------- */

export type CrmOverview = {
  pipeline: { stage: LeadStage; count: number; value: number }[]
  /** Open leads' value × the odds at their stage. */
  weighted: number
  openQuotes: { count: number; value: number }
  toDeliver: number
  toInvoice: number
  wonThisMonth: { count: number; value: number }
  /** Posted invoices this month, before VAT. */
  salesThisMonth: number
  /** Open leads expected to close in the next 14 days, or overdue. */
  closingSoon: Lead[]
}
