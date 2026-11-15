import type { ModuleSlug } from '@erp/shared'
import { Boxes, Factory, FolderKanban, Handshake, Landmark, Users, type LucideIcon } from 'lucide-react'

/**
 * The ERP's modules, in the order the sidebar shows them. A module that isn't built yet shows a
 * placeholder page listing what its phase of docs/roadmap.md delivers.
 */
export type Module = {
  slug: ModuleSlug
  label: string
  icon: LucideIcon
  phase: number
  /** Built and usable. */
  ready: boolean
  summary: string
  planned: readonly string[]
}

export const MODULES = [
  {
    slug: 'finance',
    label: 'Finance',
    icon: Landmark,
    phase: 2,
    ready: true,
    summary: 'General ledger, invoices, bills and BIR tax reporting.',
    planned: [
      'Chart of accounts, journals and general ledger',
      'Invoices that follow the EOPT Act, with VAT shown separately',
      'Bills, payments, and expanded withholding with Form 2307',
      '12% VAT, zero-rated and exempt sales, and 3% percentage tax',
      'Books of accounts, trial balance, profit and loss, balance sheet',
    ],
  },
  {
    slug: 'inventory',
    label: 'Inventory',
    icon: Boxes,
    phase: 3,
    ready: false,
    summary: 'Stock levels, warehouses, purchasing and suppliers.',
    planned: [
      'Items, units of measure, warehouses and bins',
      'Stock movements with lot and expiry tracking',
      'Purchase orders → goods receipts → supplier bills',
      'Reorder alerts and supplier records',
      'Barcode scanning from the phone app',
    ],
  },
  {
    slug: 'crm',
    label: 'Sales & CRM',
    icon: Handshake,
    phase: 4,
    ready: false,
    summary: 'Customers, leads, pipeline and sales orders.',
    planned: ['Customers and contacts', 'Leads and a sales pipeline', 'Quote → sales order → delivery → invoice', 'Service tickets'],
  },
  {
    slug: 'hr',
    label: 'HR & Payroll',
    icon: Users,
    phase: 5,
    ready: false,
    summary: 'Employees, attendance, leave and Philippine payroll.',
    planned: [
      'Employee records with encrypted government ID numbers',
      'Attendance, with GPS clock-in from the phone app',
      'Leave: service incentive, maternity, paternity, solo parent',
      'Payroll with SSS, PhilHealth, Pag-IBIG and withholding tax',
      '13th month pay, payslips, and government reports',
    ],
  },
  {
    slug: 'manufacturing',
    label: 'Manufacturing',
    icon: Factory,
    phase: 6,
    ready: false,
    summary: 'Bills of materials, work orders and quality control.',
    planned: ['Multi-level bills of materials', 'Routings and work centres', 'Work orders and production scheduling', 'Quality control checks', 'Material requirements planning'],
  },
  {
    slug: 'projects',
    label: 'Projects',
    icon: FolderKanban,
    phase: 7,
    ready: false,
    summary: 'Milestones, timesheets and job costing.',
    planned: ['Projects, milestones and tasks', 'Resource allocation and timesheets', 'Job costing', 'Gantt chart', 'Field work orders from the phone app'],
  },
] as const satisfies readonly Module[]

export const moduleBySlug = (slug: string): Module | undefined => MODULES.find((m) => m.slug === slug)
