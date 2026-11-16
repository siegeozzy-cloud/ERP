import { z } from 'zod'
import type { AccountType } from './finance.ts'

// Niche templates (docs/plan.md §6). A template is configuration, not code: which modules are on,
// the accounts that business needs on top of the standard chart (and which of them the system posts
// to by itself), its units of measure, the extra fields its items and licences carry, how new items
// start out, and which industry rules are on. The rules themselves live in the engines (stock,
// sales, projects) and work for any template that switches them on.
//
// See docs/niche-templates.md for how a niche is finished.

export const MODULE_SLUGS = ['finance', 'inventory', 'crm', 'hr', 'manufacturing', 'projects'] as const
export type ModuleSlug = (typeof MODULE_SLUGS)[number]

/**
 * `key` marks an account the system posts to by itself (like the standard chart's `cogs`). Known keys:
 * `spoilage`: stock written off as damaged, expired or rejected goes here instead of Inventory Gains and Losses.
 * `contract_revenue`: project milestones and hours are billed here instead of Service Revenue.
 */
export type TemplateAccount = { code: string; name: string; type: AccountType; key?: 'spoilage' | 'contract_revenue' }

/**
 * An extra field on items. Kept as text; `number`, `url` and `date` are checked as such, `select`
 * against its options. `requiredForSale`: an item without it can't be sold or delivered (e.g. a
 * medicine without its FDA registration number).
 */
export type TemplateField = {
  key: string
  label: string
  hint?: string
  kind?: 'text' | 'number' | 'url' | 'date' | 'select'
  options?: string[]
  requiredForSale?: boolean
  /** Printed under the item on delivery receipts and invoices (hazard details). */
  printed?: boolean
}

/** A licence or permit the business holds: its number, and when it expires (warned 60 days ahead). */
export type TemplateLicence = { key: string; label: string; hint?: string; expires?: boolean; options?: string[] }

/**
 * Industry rules a template switches on:
 * - `qcRelease`: lots received or made start in quarantine and can't be sold or used until released;
 * - `variants`: an item can have size × colour variants;
 * - `hazard`: hazard details are printed on deliveries and invoices;
 * - `makeToOrder`: work orders are made from sales orders, and an order shows its production cost.
 */
export const TEMPLATE_FEATURES = ['qcRelease', 'variants', 'hazard', 'makeToOrder'] as const
export type TemplateFeature = (typeof TEMPLATE_FEATURES)[number]

export type Template = {
  key: string
  name: string
  description: string
  modules: ModuleSlug[]
  /** What the template sets up for this kind of business, in plain words. */
  highlights: string[]
  accounts: TemplateAccount[]
  /** Units added to the standard list, as [code, name]. */
  units?: [string, string][]
  /** How the item form starts for a new stock item. */
  itemDefaults?: { trackLots: boolean; trackExpiry: boolean }
  itemFields?: TemplateField[]
  licences?: TemplateLicence[]
  features?: TemplateFeature[]
  /** Projects: share of each milestone the customer holds back until turnover, in basis points. */
  retentionBp?: number
}

const FDA_LTO: TemplateLicence = { key: 'fda_lto', label: 'FDA License to Operate (LTO) no.', hint: 'Printed on invoices.', expires: true }

export const TEMPLATES: Template[] = [
  {
    key: 'food',
    name: 'Food, Beverage & Perishables',
    description: 'Restaurants’ suppliers, bakeries, food processors, beverage makers.',
    modules: ['finance', 'inventory', 'crm', 'hr', 'manufacturing'],
    highlights: [
      'Every item tracked by lot and expiry date',
      'Sales and deliveries take the lot that expires first, and never an expired one',
      'Spoilage and expired stock written off to their own expense account',
      'Recipes with batch sizes, production runs with quality checks',
      'FDA License to Operate and product registration numbers',
    ],
    accounts: [
      { code: '1210', name: 'Raw Materials Inventory', type: 'asset' },
      { code: '1220', name: 'Finished Goods Inventory', type: 'asset' },
      { code: '5200', name: 'Spoilage and Shrinkage', type: 'expense', key: 'spoilage' },
      { code: '6210', name: 'FDA Licenses and Registration Fees', type: 'expense' },
    ],
    units: [
      ['tray', 'Tray'],
      ['crate', 'Crate'],
      ['case', 'Case'],
      ['pail', 'Pail'],
    ],
    itemDefaults: { trackLots: true, trackExpiry: true },
    itemFields: [
      { key: 'fda_cpr', label: 'FDA product registration (CPR) no.', hint: 'For processed food sold under your own brand.' },
      { key: 'allergens', label: 'Allergens', hint: 'e.g. wheat (gluten), milk, egg' },
      { key: 'storage', label: 'Storage', kind: 'select', options: ['Dry, room temperature', 'Chilled (2–8 °C)', 'Frozen (−18 °C)'] },
    ],
    licences: [FDA_LTO],
  },
  {
    key: 'pharma',
    name: 'Pharmaceuticals, Nutraceuticals & Cosmetics',
    description: 'Drug and supplement makers, distributors, cosmetics brands.',
    modules: ['finance', 'inventory', 'crm', 'hr', 'manufacturing'],
    highlights: [
      'Lots received or made wait in quarantine until quality control releases them',
      'Nothing is sold without its FDA product registration number',
      'Lot and expiry on every item; the lot that expires first goes first',
      'Batch records with quality checks; strict audit trail',
    ],
    accounts: [
      { code: '1210', name: 'Raw Materials Inventory', type: 'asset' },
      { code: '1220', name: 'Finished Goods Inventory', type: 'asset' },
      { code: '1230', name: 'Quarantined Inventory', type: 'asset' },
      { code: '5200', name: 'Rejected and Expired Stock', type: 'expense', key: 'spoilage' },
      { code: '6210', name: 'FDA Licenses and Registration Fees', type: 'expense' },
      { code: '6220', name: 'Laboratory Testing', type: 'expense' },
    ],
    units: [
      ['vial', 'Vial'],
      ['blister', 'Blister pack'],
      ['tube', 'Tube'],
      ['sachet', 'Sachet'],
    ],
    itemDefaults: { trackLots: true, trackExpiry: true },
    itemFields: [
      { key: 'fda_cpr', label: 'FDA product registration (CPR) no.', hint: 'e.g. DR-XY12345. Needed before it can be sold.', requiredForSale: true },
      { key: 'generic_name', label: 'Generic name' },
      { key: 'dosage_form', label: 'Dosage form', kind: 'select', options: ['Tablet', 'Capsule', 'Syrup or suspension', 'Injection', 'Cream or ointment', 'Food supplement', 'Cosmetic', 'Other'] },
      { key: 'strength', label: 'Strength', hint: 'e.g. 500 mg' },
      { key: 'classification', label: 'Classification', kind: 'select', options: ['Prescription (Rx)', 'Over the counter (OTC)', 'Not a drug'] },
    ],
    licences: [FDA_LTO],
    features: ['qcRelease'],
  },
  {
    key: 'discrete',
    name: 'Discrete & Custom Manufacturing',
    description: 'Make-to-order and engineer-to-order: fabrication, machinery, furniture.',
    modules: ['finance', 'inventory', 'crm', 'hr', 'manufacturing', 'projects'],
    highlights: ['Multi-level bills of materials', 'Work orders made from sales orders, and each order’s production cost against its price', 'Work in process tracked in the books'],
    accounts: [
      { code: '1210', name: 'Raw Materials Inventory', type: 'asset' },
      { code: '1220', name: 'Finished Goods Inventory', type: 'asset' },
      { code: '5300', name: 'Direct Labor', type: 'expense' },
      { code: '5400', name: 'Factory Overhead', type: 'expense' },
    ],
    units: [
      ['sheet', 'Sheet'],
      ['length', 'Length (6 m)'],
    ],
    itemFields: [
      { key: 'drawing_no', label: 'Drawing / part no.' },
      { key: 'material', label: 'Material', hint: 'e.g. SS304, 2 mm' },
    ],
    features: ['makeToOrder'],
  },
  {
    key: 'chemical',
    name: 'Chemical, Paint & Coatings',
    description: 'Paint, coatings, adhesives and specialty chemical makers.',
    modules: ['finance', 'inventory', 'crm', 'hr', 'manufacturing'],
    highlights: ['Formulas with batch scaling', 'UN number, hazard class and safety data sheet on every item, printed on deliveries and invoices', 'DENR hazardous waste ID kept with the business'],
    accounts: [
      { code: '1210', name: 'Raw Materials Inventory', type: 'asset' },
      { code: '1220', name: 'Finished Goods Inventory', type: 'asset' },
      { code: '5400', name: 'Factory Overhead', type: 'expense' },
      { code: '6230', name: 'Hazardous Waste Disposal', type: 'expense' },
    ],
    units: [
      ['drum', 'Drum (200 L)'],
      ['pail', 'Pail (20 L)'],
      ['gal', 'Gallon'],
    ],
    itemDefaults: { trackLots: true, trackExpiry: false },
    itemFields: [
      { key: 'un_number', label: 'UN number', hint: 'e.g. UN1263', printed: true },
      {
        key: 'hazard_class',
        label: 'Hazard class',
        kind: 'select',
        options: ['Not dangerous goods', 'Class 2: Gases', 'Class 3: Flammable liquid', 'Class 4: Flammable solid', 'Class 5: Oxidizer', 'Class 6: Toxic', 'Class 8: Corrosive', 'Class 9: Miscellaneous'],
        printed: true,
      },
      { key: 'sds_url', label: 'Safety data sheet (link)', kind: 'url' },
      { key: 'density', label: 'Density (kg per litre)', kind: 'number', hint: 'For converting litres to kilograms' },
    ],
    licences: [{ key: 'denr_hw_id', label: 'DENR-EMB hazardous waste generator ID' }],
    features: ['hazard'],
  },
  {
    key: 'apparel',
    name: 'Apparel, Footwear & Fashion',
    description: 'Clothing and shoe brands, garment makers, fashion retailers.',
    modules: ['finance', 'inventory', 'crm', 'hr', 'manufacturing'],
    highlights: ['Size × colour variants made from one style, with a stock grid', 'Seasons and collections', 'Sample development costs kept apart'],
    accounts: [
      { code: '1210', name: 'Fabric and Trims Inventory', type: 'asset' },
      { code: '1220', name: 'Finished Goods Inventory', type: 'asset' },
      { code: '6240', name: 'Sample Development', type: 'expense' },
      { code: '6250', name: 'Advertising and Promotions', type: 'expense' },
    ],
    units: [
      ['pair', 'Pair'],
      ['bundle', 'Bundle'],
      ['yd', 'Yard'],
    ],
    itemFields: [
      { key: 'season', label: 'Season / collection', hint: 'e.g. Holiday 2026' },
      { key: 'colour', label: 'Colour' },
      { key: 'size', label: 'Size' },
    ],
    features: ['variants'],
  },
  {
    key: 'construction',
    name: 'Construction, Engineering & Field Services',
    description: 'Contractors, engineering firms, installation and maintenance crews.',
    modules: ['finance', 'inventory', 'crm', 'hr', 'projects'],
    highlights: ['Projects at the centre: tasks on a Gantt chart, timesheets, job costing', 'Milestone billing with 10% retention, released at turnover', 'PCAB licence and category on the business', 'Field work from the phone'],
    accounts: [
      { code: '1110', name: 'Retention Receivable', type: 'asset' },
      { code: '1240', name: 'Construction Materials', type: 'asset' },
      { code: '2250', name: 'Retention Payable', type: 'liability' },
      { code: '2260', name: 'Billings in Excess of Costs', type: 'liability' },
      { code: '4020', name: 'Contract Revenue', type: 'income', key: 'contract_revenue' },
      { code: '5500', name: 'Subcontractor Costs', type: 'expense' },
      { code: '5510', name: 'Equipment Rental', type: 'expense' },
    ],
    units: [
      ['bag', 'Bag'],
      ['cu.m', 'Cubic meter'],
      ['sq.m', 'Square meter'],
      ['lot', 'Lot'],
    ],
    licences: [
      { key: 'pcab_licence', label: 'PCAB contractor’s licence no.', hint: 'Printed on invoices.', expires: true },
      { key: 'pcab_category', label: 'PCAB category', options: ['AAAA', 'AAA', 'AA', 'A', 'B', 'C', 'D', 'Trade/E'] },
    ],
    retentionBp: 1000,
  },
  {
    key: 'wholesale',
    name: 'Wholesale Distribution',
    description: 'Distributors and wholesalers moving high volumes of stock.',
    modules: ['finance', 'inventory', 'crm', 'hr'],
    highlights: ['Price lists with quantity breaks for each kind of customer', 'Many warehouses; barcode scanning from the phone', 'Brands and case packs on items'],
    accounts: [
      { code: '1205', name: 'Merchandise Inventory', type: 'asset' },
      { code: '4110', name: 'Sales Rebates', type: 'income' },
      { code: '5110', name: 'Freight In', type: 'expense' },
      { code: '6260', name: 'Delivery Expense', type: 'expense' },
      { code: '6270', name: 'Warehouse Rent', type: 'expense' },
    ],
    units: [
      ['case', 'Case'],
      ['carton', 'Carton'],
      ['pallet', 'Pallet'],
    ],
    itemFields: [
      { key: 'brand', label: 'Brand' },
      { key: 'case_pack', label: 'Pieces per case', kind: 'number' },
    ],
  },
  {
    key: 'general',
    name: 'General business',
    description: 'None of the above, or you’d rather start plain.',
    modules: ['finance', 'inventory', 'crm', 'hr'],
    highlights: ['The standard Philippine chart of accounts', 'Turn modules on or off later in Settings'],
    accounts: [],
  },
]

export const TEMPLATE_KEYS = TEMPLATES.map((t) => t.key) as [string, ...string[]]
export const templateByKey = (key: string) => TEMPLATES.find((t) => t.key === key)
export const hasFeature = (templateKey: string, feature: TemplateFeature) => !!templateByKey(templateKey)?.features?.includes(feature)

/** The niche "Try the demo" opens: the one that's finished first. */
export const DEMO_TEMPLATE = 'food'

/** Extra values an item or a business keeps: field key → text. */
export const AttributesInput = z.record(z.string().max(40), z.string().trim().max(300)).default({})

type AnyField = { key: string; label: string; kind?: TemplateField['kind']; options?: string[] }

/** The fields a business's licences take: each licence, and its expiry date when it has one. */
export const licenceFields = (licences: TemplateLicence[]): AnyField[] =>
  licences.flatMap((l) => [{ key: l.key, label: l.label, options: l.options }, ...(l.expires ? [{ key: `${l.key}_expires`, label: `${l.label}: expiry`, kind: 'date' as const }] : [])])

/** Checks values against fields; returns the first problem, or the cleaned values (empties dropped). */
export function checkAttributes(fields: AnyField[], values: Record<string, string>): { key: string; message: string } | { ok: Record<string, string> } {
  const out: Record<string, string> = {}
  const known = new Map(fields.map((f) => [f.key, f]))
  for (const [key, raw] of Object.entries(values)) {
    const v = raw.trim()
    if (!v) continue
    const f = known.get(key)
    if (!f) return { key, message: `${key} isn’t a field here.` }
    if (f.kind === 'number' && !(Number(v) >= 0)) return { key, message: `${f.label}: enter a number.` }
    if (f.kind === 'url' && !/^https?:\/\/\S+$/.test(v)) return { key, message: `${f.label}: enter a link starting with https://.` }
    if (f.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { key, message: `${f.label}: enter a date.` }
    if (f.options && !f.options.includes(v)) return { key, message: `${f.label}: choose one of the options.` }
    out[key] = v
  }
  return { ok: out }
}
