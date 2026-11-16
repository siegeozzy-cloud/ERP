import type { PriceList, CrmOverview, CustomerDetail, CustomerSummary, Delivery, LeadDetail, Lead, Quote, QuoteStatus, QuoteSummary, SalesItem, SalesOrder, SalesOrderSummary, SoStatus } from '@erp/shared'
import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'

// Same rule as the other modules: every key starts with ['w', workspaceId], so one change refreshes
// the whole workspace (a delivery moves stock, the ledger and the order at once).

const qs = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString()
  return s ? `?${s}` : ''
}

export const crmQueries = {
  overview: (w: string) => queryOptions({ queryKey: ['w', w, 'crm-overview'], queryFn: async () => (await api<{ overview: CrmOverview }>(`/w/${w}/crm/overview`)).overview }),
  items: (w: string) => queryOptions({ queryKey: ['w', w, 'sales-items'], queryFn: async () => (await api<{ items: SalesItem[] }>(`/w/${w}/sales/items`)).items, staleTime: 30_000 }),
  warehouses: (w: string) =>
    queryOptions({ queryKey: ['w', w, 'sales-warehouses'], queryFn: async () => (await api<{ warehouses: { id: string; code: string; name: string }[] }>(`/w/${w}/sales/warehouses`)).warehouses, staleTime: 60_000 }),
  customers: (w: string, q?: string) =>
    queryOptions({ queryKey: ['w', w, 'crm-customers', q ?? ''], queryFn: async () => (await api<{ customers: CustomerSummary[] }>(`/w/${w}/crm/customers${qs({ q })}`)).customers }),
  customer: (w: string, id: string) => queryOptions({ queryKey: ['w', w, 'crm-customer', id], queryFn: async () => (await api<{ customer: CustomerDetail }>(`/w/${w}/crm/customers/${id}`)).customer }),
  leads: (w: string) => queryOptions({ queryKey: ['w', w, 'leads'], queryFn: async () => (await api<{ leads: Lead[] }>(`/w/${w}/leads`)).leads }),
  lead: (w: string, id: string) => queryOptions({ queryKey: ['w', w, 'lead', id], queryFn: async () => (await api<{ lead: LeadDetail }>(`/w/${w}/leads/${id}`)).lead }),
  quotes: (w: string, status?: QuoteStatus) =>
    queryOptions({ queryKey: ['w', w, 'quotes', status ?? 'all'], queryFn: async () => (await api<{ quotes: QuoteSummary[] }>(`/w/${w}/quotes${qs({ status })}`)).quotes }),
  quote: (w: string, id: string) => queryOptions({ queryKey: ['w', w, 'quote', id], queryFn: async () => (await api<{ quote: Quote }>(`/w/${w}/quotes/${id}`)).quote }),
  orders: (w: string, status?: SoStatus) =>
    queryOptions({ queryKey: ['w', w, 'sales-orders', status ?? 'all'], queryFn: async () => (await api<{ salesOrders: SalesOrderSummary[] }>(`/w/${w}/sales-orders${qs({ status })}`)).salesOrders }),
  order: (w: string, id: string) => queryOptions({ queryKey: ['w', w, 'sales-order', id], queryFn: async () => (await api<{ salesOrder: SalesOrder }>(`/w/${w}/sales-orders/${id}`)).salesOrder }),
  deliveries: (w: string) => queryOptions({ queryKey: ['w', w, 'deliveries'], queryFn: async () => (await api<{ deliveries: Delivery[] }>(`/w/${w}/deliveries`)).deliveries }),
  priceLists: (w: string) => queryOptions({ queryKey: ['w', w, 'price-lists'], queryFn: async () => (await api<{ priceLists: PriceList[] }>(`/w/${w}/price-lists`)).priceLists }),
  delivery: (w: string, id: string) => queryOptions({ queryKey: ['w', w, 'delivery', id], queryFn: async () => (await api<{ delivery: Delivery }>(`/w/${w}/deliveries/${id}`)).delivery }),
}
