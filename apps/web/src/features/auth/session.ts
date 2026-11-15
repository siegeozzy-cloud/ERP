import type { Session } from '@erp/shared'
import { queryOptions, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { api, tokenStore } from '@/lib/api'

/** Who is signed in, or null. Loaded before any signed-in page renders (see router.tsx). */
export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: async () => (await api<{ session: Session | null }>('/auth/session')).session,
  staleTime: 5 * 60_000,
})

/** The signed-in user. Only use inside the signed-in part of the app, where the router guarantees one. */
export function useUser() {
  const { data } = useSuspenseQuery(sessionQuery)
  if (!data) throw new Error('useUser() was called outside the signed-in part of the app')
  return data.user
}

export function useSignOut() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return async () => {
    // even if the server can't be reached, this browser forgets the session
    await api('/auth/signout', { method: 'POST' }).catch(() => undefined)
    tokenStore.clear()
    queryClient.setQueryData(sessionQuery.queryKey, null)
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' })
    await navigate({ to: '/sign-in' })
  }
}

/** Only follows a redirect back into this app, never to another site. */
export const safeRedirect = (to: string | undefined) => (to && to.startsWith('/') && !to.startsWith('//') ? to : '/')
