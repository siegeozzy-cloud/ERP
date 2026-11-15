import type {
  Account,
  BalanceSheet,
  Bill,
  BillSummary,
  BookEntry,
  BookName,
  Contact,
  DocumentStatus,
  FinanceOverview,
  Form2307,
  GeneralLedger,
  Invoice,
  InvoiceSummary,
  JournalEntry,
  JournalEntrySummary,
  PercentageTaxReturn,
  ProfitAndLoss,
  Slsp,
  TaxCode,
  TrialBalance,
  VatReturn,
  WithholdingReturn,
} from '@erp/shared'
import { keepPreviousData, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useWorkspaceId } from '../workspaces/queries'

// Every query key starts with ['w', workspaceId], so one invalidation refreshes the whole workspace
// after a change. Posting an invoice moves the ledger, the reports and the overview at once, and
// tracking which of those each change touches isn't worth the risk of showing stale books.

const qs = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString()
  return s ? `?${s}` : ''
}

export const financeQueries = {
  overview: (w: string) => queryOptions({ queryKey: ['w', w, 'overview'], queryFn: async () => (await api<{ overview: FinanceOverview }>(`/w/${w}/reports/overview`)).overview }),
  accounts: (w: string) => queryOptions({ queryKey: ['w', w, 'accounts'], queryFn: async () => (await api<{ accounts: Account[] }>(`/w/${w}/accounts`)).accounts, staleTime: 60_000 }),
  taxCodes: (w: string) => queryOptions({ queryKey: ['w', w, 'tax-codes'], queryFn: async () => (await api<{ taxCodes: TaxCode[] }>(`/w/${w}/tax-codes`)).taxCodes, staleTime: 5 * 60_000 }),
  contacts: (w: string, role?: 'customer' | 'supplier') =>
    queryOptions({ queryKey: ['w', w, 'contacts', role ?? 'all'], queryFn: async () => (await api<{ contacts: Contact[] }>(`/w/${w}/contacts${qs({ role })}`)).contacts }),
  invoices: (w: string, status?: DocumentStatus) =>
    queryOptions({ queryKey: ['w', w, 'invoices', status ?? 'all'], queryFn: async () => (await api<{ invoices: InvoiceSummary[] }>(`/w/${w}/invoices${qs({ status })}`)).invoices }),
  invoice: (w: string, id: string) => queryOptions({ queryKey: ['w', w, 'invoice', id], queryFn: async () => (await api<{ invoice: Invoice }>(`/w/${w}/invoices/${id}`)).invoice }),
  bills: (w: string, status?: DocumentStatus) =>
    queryOptions({ queryKey: ['w', w, 'bills', status ?? 'all'], queryFn: async () => (await api<{ bills: BillSummary[] }>(`/w/${w}/bills${qs({ status })}`)).bills }),
  bill: (w: string, id: string) => queryOptions({ queryKey: ['w', w, 'bill', id], queryFn: async () => (await api<{ bill: Bill }>(`/w/${w}/bills/${id}`)).bill }),
  journal: (w: string) => queryOptions({ queryKey: ['w', w, 'journal'], queryFn: async () => (await api<{ entries: JournalEntrySummary[] }>(`/w/${w}/journal`)).entries }),
  entry: (w: string, id: string) => queryOptions({ queryKey: ['w', w, 'entry', id], queryFn: async () => (await api<{ entry: JournalEntry }>(`/w/${w}/journal/${id}`)).entry }),
}

/** Reports take parameters; the previous result stays on screen while a new period loads. */
const report = <T>(w: string, path: string, params: Record<string, string | undefined>, enabled = true) =>
  queryOptions({
    queryKey: ['w', w, 'report', path, params],
    queryFn: async () => (await api<{ report: T }>(`/w/${w}/reports/${path}${qs(params)}`)).report,
    placeholderData: keepPreviousData,
    enabled,
  })

export const reportQueries = {
  trialBalance: (w: string, asOf: string) => report<TrialBalance>(w, 'trial-balance', { asOf }),
  profitAndLoss: (w: string, from: string, to: string) => report<ProfitAndLoss>(w, 'profit-and-loss', { from, to }),
  balanceSheet: (w: string, asOf: string) => report<BalanceSheet>(w, 'balance-sheet', { asOf }),
  generalLedger: (w: string, accountId: string, from: string, to: string) => report<GeneralLedger>(w, 'general-ledger', { accountId, from, to }, !!accountId),
  vat: (w: string, quarter: string) => report<VatReturn>(w, 'vat', { quarter }),
  percentageTax: (w: string, quarter: string) => report<PercentageTaxReturn>(w, 'percentage-tax', { quarter }),
  withholding: (w: string, quarter: string) => report<WithholdingReturn>(w, 'withholding', { quarter }),
  form2307: (w: string, quarter: string, supplierId: string) => report<Form2307>(w, 'form-2307', { quarter, supplierId }, !!supplierId),
  slsp: (w: string, quarter: string, kind: 'sales' | 'purchases') => report<Slsp>(w, 'slsp', { quarter, kind }),
  book: (w: string, book: BookName, from: string, to: string) =>
    queryOptions({
      queryKey: ['w', w, 'report', 'books', book, from, to],
      queryFn: async () => (await api<{ entries: BookEntry[] }>(`/w/${w}/reports/books/${book}${qs({ from, to })}`)).entries,
      placeholderData: keepPreviousData,
    }),
}

/** A change inside the current workspace. Afterwards, everything in the workspace is refetched. */
export function useWorkspaceMutation<TInput, TResult>(fn: (workspaceId: string, input: TInput) => Promise<TResult>) {
  const workspaceId = useWorkspaceId()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: TInput) => fn(workspaceId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['w', workspaceId] }),
  })
}
