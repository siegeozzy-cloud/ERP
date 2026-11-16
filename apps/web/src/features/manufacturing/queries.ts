import type { Bom, BomSummary, ManufacturingOverview, MrpPlan, WorkCenter, WorkOrder, WorkOrderSummary } from '@erp/shared'
import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'

// Keys start with ['w', workspaceId] like every module, so finishing a work order (stock, books,
// plan) refreshes everything at once.

export const mfgQueries = {
  overview: (w: string) => queryOptions({ queryKey: ['w', w, 'mfg-overview'], queryFn: async () => (await api<{ overview: ManufacturingOverview }>(`/w/${w}/manufacturing/overview`)).overview }),
  workCenters: (w: string) => queryOptions({ queryKey: ['w', w, 'work-centers'], queryFn: async () => (await api<{ workCenters: WorkCenter[] }>(`/w/${w}/work-centers`)).workCenters, staleTime: 60_000 }),
  boms: (w: string) => queryOptions({ queryKey: ['w', w, 'boms'], queryFn: async () => (await api<{ boms: BomSummary[] }>(`/w/${w}/boms`)).boms }),
  bom: (w: string, id: string) => queryOptions({ queryKey: ['w', w, 'bom', id], queryFn: async () => (await api<{ bom: Bom }>(`/w/${w}/boms/${id}`)).bom }),
  workOrders: (w: string, status: string) =>
    queryOptions({ queryKey: ['w', w, 'work-orders', status], queryFn: async () => (await api<{ workOrders: WorkOrderSummary[] }>(`/w/${w}/work-orders${status === 'all' ? '' : `?status=${status}`}`)).workOrders }),
  workOrder: (w: string, id: string) => queryOptions({ queryKey: ['w', w, 'work-order', id], queryFn: async () => (await api<{ workOrder: WorkOrder }>(`/w/${w}/work-orders/${id}`)).workOrder }),
  mrp: (w: string) => queryOptions({ queryKey: ['w', w, 'mrp'], queryFn: async () => (await api<{ plan: MrpPlan }>(`/w/${w}/mrp`)).plan }),
}

/** 95 → "1 h 35 min". */
export function formatMinutes(m: number) {
  const h = Math.floor(m / 60)
  const min = Math.round(m % 60)
  return h ? `${h} h${min ? ` ${min} min` : ''}` : `${min} min`
}
