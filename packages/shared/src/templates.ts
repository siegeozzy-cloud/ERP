import type { AccountType } from './finance.ts'

// Niche templates (docs/plan.md §6). A template is configuration: which modules are on, and the
// accounts that business needs on top of the standard chart. The deeper parts of each niche (lot
// tracking, formulas, progress billing…) arrive with the modules they belong to.

export const MODULE_SLUGS = ['finance', 'inventory', 'crm', 'hr', 'manufacturing', 'projects'] as const
export type ModuleSlug = (typeof MODULE_SLUGS)[number]

export type TemplateAccount = { code: string; name: string; type: AccountType }

export type Template = {
  key: string
  name: string
  description: string
  modules: ModuleSlug[]
  /** What the template sets up for this kind of business, in plain words. */
  highlights: string[]
  accounts: TemplateAccount[]
}

export const TEMPLATES: Template[] = [
  {
    key: 'food',
    name: 'Food, Beverage & Perishables',
    description: 'Restaurants’ suppliers, bakeries, food processors, beverage makers.',
    modules: ['finance', 'inventory', 'crm', 'hr', 'manufacturing'],
    highlights: ['Lot and expiry tracking (Phase 3)', 'Recipes and production', 'Spoilage tracked as its own expense'],
    accounts: [
      { code: '1210', name: 'Raw Materials Inventory', type: 'asset' },
      { code: '1220', name: 'Finished Goods Inventory', type: 'asset' },
      { code: '5200', name: 'Spoilage and Shrinkage', type: 'expense' },
      { code: '6210', name: 'FDA Licenses and Registration Fees', type: 'expense' },
    ],
  },
  {
    key: 'pharma',
    name: 'Pharmaceuticals, Nutraceuticals & Cosmetics',
    description: 'Drug and supplement makers, distributors, cosmetics brands.',
    modules: ['finance', 'inventory', 'crm', 'hr', 'manufacturing'],
    highlights: ['Batch records and quality release (Phase 6)', 'FDA License to Operate and product registration fields', 'Strict audit trail'],
    accounts: [
      { code: '1210', name: 'Raw Materials Inventory', type: 'asset' },
      { code: '1220', name: 'Finished Goods Inventory', type: 'asset' },
      { code: '1230', name: 'Quarantined Inventory', type: 'asset' },
      { code: '6210', name: 'FDA Licenses and Registration Fees', type: 'expense' },
      { code: '6220', name: 'Laboratory Testing', type: 'expense' },
    ],
  },
  {
    key: 'discrete',
    name: 'Discrete & Custom Manufacturing',
    description: 'Make-to-order and engineer-to-order: fabrication, machinery, furniture.',
    modules: ['finance', 'inventory', 'crm', 'hr', 'manufacturing', 'projects'],
    highlights: ['Multi-level bills of materials (Phase 6)', 'Job costing per order', 'Work in process tracked in the books'],
    accounts: [
      { code: '1210', name: 'Raw Materials Inventory', type: 'asset' },
      { code: '1215', name: 'Work in Process', type: 'asset' },
      { code: '1220', name: 'Finished Goods Inventory', type: 'asset' },
      { code: '5300', name: 'Direct Labor', type: 'expense' },
      { code: '5400', name: 'Factory Overhead', type: 'expense' },
    ],
  },
  {
    key: 'chemical',
    name: 'Chemical, Paint & Coatings',
    description: 'Paint, coatings, adhesives and specialty chemical makers.',
    modules: ['finance', 'inventory', 'crm', 'hr', 'manufacturing'],
    highlights: ['Formulas with batch scaling (Phase 6)', 'Litres ↔ kilograms by density', 'Safety data sheets and hazard classes'],
    accounts: [
      { code: '1210', name: 'Raw Materials Inventory', type: 'asset' },
      { code: '1215', name: 'Work in Process', type: 'asset' },
      { code: '1220', name: 'Finished Goods Inventory', type: 'asset' },
      { code: '5400', name: 'Factory Overhead', type: 'expense' },
      { code: '6230', name: 'Hazardous Waste Disposal', type: 'expense' },
    ],
  },
  {
    key: 'apparel',
    name: 'Apparel, Footwear & Fashion',
    description: 'Clothing and shoe brands, garment makers, fashion retailers.',
    modules: ['finance', 'inventory', 'crm', 'hr', 'manufacturing'],
    highlights: ['Style × size × colour variants (Phase 3)', 'Seasons and collections', 'Sample development costs kept apart'],
    accounts: [
      { code: '1210', name: 'Fabric and Trims Inventory', type: 'asset' },
      { code: '1220', name: 'Finished Goods Inventory', type: 'asset' },
      { code: '6240', name: 'Sample Development', type: 'expense' },
      { code: '6250', name: 'Advertising and Promotions', type: 'expense' },
    ],
  },
  {
    key: 'construction',
    name: 'Construction, Engineering & Field Services',
    description: 'Contractors, engineering firms, installation and maintenance crews.',
    modules: ['finance', 'inventory', 'crm', 'hr', 'projects'],
    highlights: ['Projects at the centre (Phase 7)', 'Progress billing with 10% retention', 'Subcontractors and equipment costs'],
    accounts: [
      { code: '1110', name: 'Retention Receivable', type: 'asset' },
      { code: '1240', name: 'Construction Materials', type: 'asset' },
      { code: '2210', name: 'Retention Payable', type: 'liability' },
      { code: '2220', name: 'Billings in Excess of Costs', type: 'liability' },
      { code: '4020', name: 'Contract Revenue', type: 'income' },
      { code: '5500', name: 'Subcontractor Costs', type: 'expense' },
      { code: '5510', name: 'Equipment Rental', type: 'expense' },
    ],
  },
  {
    key: 'wholesale',
    name: 'Wholesale Distribution',
    description: 'Distributors and wholesalers moving high volumes of stock.',
    modules: ['finance', 'inventory', 'crm', 'hr'],
    highlights: ['Many warehouses and bins (Phase 3)', 'Barcode scanning from the phone', 'Freight, rebates and landed cost'],
    accounts: [
      { code: '1205', name: 'Merchandise Inventory', type: 'asset' },
      { code: '4110', name: 'Sales Rebates', type: 'income' },
      { code: '5110', name: 'Freight In', type: 'expense' },
      { code: '6260', name: 'Delivery Expense', type: 'expense' },
      { code: '6270', name: 'Warehouse Rent', type: 'expense' },
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
