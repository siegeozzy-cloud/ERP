import type { AuditEntry, JoinCode, Member, Permission, PsgcAddress, PsgcPlace, Role, Workspace, WorkspaceSummary } from '@erp/shared'
import { queryOptions, useSuspenseQuery } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { api } from '@/lib/api'

export const workspacesQuery = queryOptions({
  queryKey: ['workspaces'],
  queryFn: async () => (await api<{ workspaces: WorkspaceSummary[] }>('/workspaces')).workspaces,
  staleTime: 60_000,
})

export const workspaceQuery = (id: string) =>
  queryOptions({
    queryKey: ['w', id, 'workspace'],
    queryFn: async () => (await api<{ workspace: Workspace }>(`/w/${id}`)).workspace,
    staleTime: 5 * 60_000,
  })

/** The workspace in the address (/w/$workspaceId/…). Only inside the workspace part of the app. */
export function useWorkspaceId() {
  const { workspaceId } = useParams({ strict: false })
  if (!workspaceId) throw new Error('useWorkspaceId() was called outside a workspace route')
  return workspaceId
}

/** The current workspace. The router has loaded it before any page inside renders. */
export function useWorkspace() {
  return useSuspenseQuery(workspaceQuery(useWorkspaceId())).data
}

/**
 * Whether the signed-in member's role allows something here. Used to hide what they can't use;
 * the API checks again on every request, so hiding is a courtesy, not the protection.
 */
export function useCan() {
  const { permissions } = useWorkspace()
  return (permission: Permission) => permissions.includes(permission)
}

const qs = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString()
  return s ? `?${s}` : ''
}

export const settingsQueries = {
  members: (w: string) => queryOptions({ queryKey: ['w', w, 'members'], queryFn: async () => (await api<{ members: Member[] }>(`/w/${w}/members`)).members }),
  roles: (w: string) => queryOptions({ queryKey: ['w', w, 'roles'], queryFn: async () => (await api<{ roles: Role[] }>(`/w/${w}/roles`)).roles }),
  joinCodes: (w: string) => queryOptions({ queryKey: ['w', w, 'join-codes'], queryFn: async () => (await api<{ codes: JoinCode[] }>(`/w/${w}/join-codes`)).codes }),
  audit: (w: string, entity?: string) =>
    queryOptions({ queryKey: ['w', w, 'audit', entity ?? 'all'], queryFn: async () => (await api<{ entries: AuditEntry[] }>(`/w/${w}/audit${qs({ entity })}`)).entries }),
}

/** The PSGC lists for the address picker. They never change between loads, so they're kept for good. */
export const psgcQueries = {
  regions: () => queryOptions({ queryKey: ['psgc', 'regions'], queryFn: async () => (await api<{ places: PsgcPlace[] }>('/psgc/regions')).places, staleTime: Infinity }),
  provinces: (region: string) =>
    queryOptions({
      queryKey: ['psgc', 'provinces', region],
      queryFn: () => api<{ places: PsgcPlace[]; independentCities: boolean }>(`/psgc/provinces?region=${region}`),
      staleTime: Infinity,
      enabled: !!region,
    }),
  cities: (region: string, province: string) =>
    queryOptions({
      queryKey: ['psgc', 'cities', region, province],
      queryFn: async () => (await api<{ places: PsgcPlace[] }>(`/psgc/cities?region=${region}&province=${province}`)).places,
      staleTime: Infinity,
      enabled: !!region && !!province,
    }),
  barangays: (city: string) =>
    queryOptions({ queryKey: ['psgc', 'barangays', city], queryFn: async () => (await api<{ places: PsgcPlace[] }>(`/psgc/barangays?city=${city}`)).places, staleTime: Infinity, enabled: !!city }),
  address: (barangay: string | null) =>
    queryOptions({ queryKey: ['psgc', 'address', barangay], queryFn: async () => (await api<{ address: PsgcAddress }>(`/psgc/address/${barangay}`)).address, staleTime: Infinity, enabled: !!barangay }),
}
