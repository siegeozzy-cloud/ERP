import { Boxes, Factory, FolderKanban, Handshake, Landmark, Settings, Users, type LucideIcon } from 'lucide-react'

/**
 * The ERP's modules, in the order the sidebar shows them. Each one is a placeholder page until its
 * phase of docs/roadmap.md is built; `planned` lists what that phase delivers.
 */
export type Module = {
  path: `/${string}`
  label: string
  icon: LucideIcon
  phase: number
  summary: string
  planned: string[]
}

export const MODULES = [
  {
    path: '/finance',
    label: 'Finance',
    icon: Landmark,
    phase: 2,
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
    path: '/inventory',
    label: 'Inventory',
    icon: Boxes,
    phase: 3,
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
    path: '/crm',
    label: 'Sales & CRM',
    icon: Handshake,
    phase: 4,
    summary: 'Customers, leads, pipeline and sales orders.',
    planned: ['Customers and contacts', 'Leads and a sales pipeline', 'Quote → sales order → delivery → invoice', 'Service tickets'],
  },
  {
    path: '/hr',
    label: 'HR & Payroll',
    icon: Users,
    phase: 5,
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
    path: '/manufacturing',
    label: 'Manufacturing',
    icon: Factory,
    phase: 6,
    summary: 'Bills of materials, work orders and quality control.',
    planned: ['Multi-level bills of materials', 'Routings and work centres', 'Work orders and production scheduling', 'Quality control checks', 'Material requirements planning'],
  },
  {
    path: '/projects',
    label: 'Projects',
    icon: FolderKanban,
    phase: 7,
    summary: 'Milestones, timesheets and job costing.',
    planned: ['Projects, milestones and tasks', 'Resource allocation and timesheets', 'Job costing', 'Gantt chart', 'Field work orders from the phone app'],
  },
  {
    path: '/settings',
    label: 'Settings',
    icon: Settings,
    phase: 1,
    summary: 'Your workspace, members, roles and join codes.',
    planned: ['Workspace details: business name, TIN, VAT registration', 'Members, roles and permissions', 'One-time join codes for new members', 'Audit log of every change'],
  },
] as const satisfies readonly Module[]
