import { formatAmount, formatPeso, type DocumentStatus } from '@erp/shared'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { useWorkspaceId } from '@/features/workspaces/queries'
import { cn } from '@/lib/utils'

/** An amount in a table: right-aligned, digits lined up, negatives in red. */
export function Money({ value, peso = false, className }: { value: number; peso?: boolean; className?: string }) {
  return <span className={cn('tabular-nums', value < 0 && 'text-destructive', className)}>{peso ? formatPeso(value) : formatAmount(value)}</span>
}

const STATUS: Record<DocumentStatus | 'paid' | 'overdue', { label: string; variant: 'secondary' | 'outline' | 'success' | 'default' }> = {
  draft: { label: 'Draft', variant: 'outline' },
  posted: { label: 'Unpaid', variant: 'default' },
  paid: { label: 'Paid', variant: 'success' },
  overdue: { label: 'Overdue', variant: 'default' },
  void: { label: 'Void', variant: 'secondary' },
}

/** A document's state as people think of it: draft, unpaid, overdue, paid or void. */
export function DocumentStatusBadge({ status, balance, dueDate, today }: { status: DocumentStatus; balance: number; dueDate: string | null; today: string }) {
  const key = status !== 'posted' ? status : balance === 0 ? 'paid' : dueDate && dueDate < today ? 'overdue' : 'posted'
  const s = STATUS[key]
  return (
    <Badge variant={s.variant} className={cn(key === 'overdue' && 'bg-destructive text-white')}>
      {s.label}
    </Badge>
  )
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4 print:hidden">
      <div className="min-w-0 space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center">
      <p className="font-medium">{title}</p>
      {children && <p className="text-muted-foreground max-w-sm text-sm">{children}</p>}
      {action}
    </div>
  )
}

export function Loading() {
  return <p className="text-muted-foreground py-10 text-center text-sm">Loading…</p>
}

export function LoadError({ error }: { error: Error }) {
  return <p className="text-destructive py-10 text-center text-sm">{error.message}</p>
}

const TABS = [
  { to: '/w/$workspaceId/finance', label: 'Overview', exact: true },
  { to: '/w/$workspaceId/finance/invoices', label: 'Invoices' },
  { to: '/w/$workspaceId/finance/bills', label: 'Bills' },
  { to: '/w/$workspaceId/finance/journal', label: 'Journal' },
  { to: '/w/$workspaceId/finance/reports', label: 'Reports' },
  { to: '/w/$workspaceId/finance/contacts', label: 'Contacts' },
  { to: '/w/$workspaceId/finance/accounts', label: 'Accounts' },
] as const

/** Finance's own sections, as tabs under the top bar. Scrolls sideways on a phone. */
export function FinanceTabs() {
  const workspaceId = useWorkspaceId()
  return (
    <nav aria-label="Finance" className="-mx-4 mb-6 overflow-x-auto border-b px-4 md:mx-0 md:px-0 print:hidden">
      <div className="flex min-w-max gap-1">
        {TABS.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            params={{ workspaceId }}
            activeOptions={{ exact: 'exact' in t && t.exact }}
            className="text-muted-foreground hover:text-foreground -mb-px border-b-2 border-transparent px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors"
            activeProps={{ className: 'border-foreground! text-foreground!', 'aria-current': 'page' }}
          >
            {t.label}
          </Link>
        ))}
      </div>
    </nav>
  )
}

/** Downloads rows as a CSV file, for opening in a spreadsheet (and for BIR's own tools). */
export function downloadCsv(filename: string, header: string[], rows: (string | number | null)[][]) {
  const cell = (v: string | number | null) => {
    const s = v === null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  a.click()
  URL.revokeObjectURL(url)
}

/** Centavos as a plain number for CSV: 123450 → "1234.50". */
export const csvAmount = (centavos: number) => (centavos / 100).toFixed(2)
