import type { InventoryOverview, Item, ItemDetail, PoStatus, PurchaseOrder, PurchaseOrderSummary, StockDocument, Unit, ValuationRow, Warehouse } from '@erp/shared'
import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'

// Same rule as Finance: every key starts with ['w', workspaceId], so one change refreshes the
// whole workspace (receiving goods moves stock, the ledger and the purchase order at once).

export const inventoryQueries = {
  overview: (w: string) => queryOptions({ queryKey: ['w', w, 'inventory-overview'], queryFn: async () => (await api<{ overview: InventoryOverview }>(`/w/${w}/inventory/overview`)).overview }),
  units: (w: string) => queryOptions({ queryKey: ['w', w, 'units'], queryFn: async () => (await api<{ units: Unit[] }>(`/w/${w}/units`)).units, staleTime: 5 * 60_000 }),
  warehouses: (w: string) => queryOptions({ queryKey: ['w', w, 'warehouses'], queryFn: async () => (await api<{ warehouses: Warehouse[] }>(`/w/${w}/warehouses`)).warehouses, staleTime: 60_000 }),
  items: (w: string) => queryOptions({ queryKey: ['w', w, 'items'], queryFn: async () => (await api<{ items: Item[] }>(`/w/${w}/items`)).items, staleTime: 30_000 }),
  item: (w: string, id: string) => queryOptions({ queryKey: ['w', w, 'item', id], queryFn: async () => (await api<{ item: ItemDetail }>(`/w/${w}/items/${id}`)).item }),
  documents: (w: string, kind?: string) =>
    queryOptions({ queryKey: ['w', w, 'stock-documents', kind ?? 'all'], queryFn: async () => (await api<{ documents: StockDocument[] }>(`/w/${w}/stock/documents${kind ? `?kind=${kind}` : ''}`)).documents }),
  document: (w: string, id: string) => queryOptions({ queryKey: ['w', w, 'stock-document', id], queryFn: async () => (await api<{ document: StockDocument }>(`/w/${w}/stock/documents/${id}`)).document }),
  purchaseOrders: (w: string, status?: PoStatus) =>
    queryOptions({
      queryKey: ['w', w, 'purchase-orders', status ?? 'all'],
      queryFn: async () => (await api<{ purchaseOrders: PurchaseOrderSummary[] }>(`/w/${w}/purchase-orders${status ? `?status=${status}` : ''}`)).purchaseOrders,
    }),
  purchaseOrder: (w: string, id: string) => queryOptions({ queryKey: ['w', w, 'purchase-order', id], queryFn: async () => (await api<{ purchaseOrder: PurchaseOrder }>(`/w/${w}/purchase-orders/${id}`)).purchaseOrder }),
  valuation: (w: string, asOf: string) =>
    queryOptions({ queryKey: ['w', w, 'valuation', asOf], queryFn: () => api<{ asOf: string; rows: ValuationRow[]; total: number }>(`/w/${w}/inventory/valuation?asOf=${asOf}`) }),
}

const qtyFormat = new Intl.NumberFormat('en-PH', { maximumFractionDigits: 4 })
/** 1250.5 → "1,250.5". */
export const formatQty = (n: number) => qtyFormat.format(n)
