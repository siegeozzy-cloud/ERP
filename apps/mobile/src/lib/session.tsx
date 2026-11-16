import type { DemoStartResponse, Session, SignInResponse } from '@erp/shared'
import { useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, setApiToken, whenSignedOut } from './api'
import { disablePush } from './push'
import { KEYS, storage } from './storage'

type State = { status: 'loading' } | { status: 'signed-out' } | { status: 'signed-in'; session: Session; workspaceId: string | null }

type SessionApi = {
  state: State
  signIn: (email: string, password: string) => Promise<void>
  /** Opens a demo business of its own and signs in as its owner (the server's "Try the demo"). */
  startDemo: () => Promise<void>
  signOut: () => Promise<void>
  /** The workspace the app is showing; remembered for next time. */
  chooseWorkspace: (id: string | null) => Promise<void>
}

const Ctx = createContext<SessionApi | null>(null)

/** Who is signed in on this phone. Starts by checking the saved token is still good. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const queryClient = useQueryClient()

  const forget = useCallback(async () => {
    setApiToken(null)
    await storage.remove(KEYS.token)
    queryClient.clear()
    setState({ status: 'signed-out' })
  }, [queryClient])

  useEffect(() => {
    whenSignedOut(() => void forget())
    void (async () => {
      const token = await storage.get(KEYS.token)
      if (!token) return setState({ status: 'signed-out' })
      setApiToken(token)
      try {
        const { session } = await api<{ session: Session | null }>('/auth/session')
        if (!session) return void (await forget())
        setState({ status: 'signed-in', session, workspaceId: await storage.get(KEYS.workspace) })
      } catch {
        // offline: keep the token and let the person try again from the sign-in screen
        setApiToken(null)
        setState({ status: 'signed-out' })
      }
    })()
  }, [forget])

  const value = useMemo<SessionApi>(
    () => ({
      state,
      async signIn(email, password) {
        // phones stay signed in for 30 days, like "keep me signed in" on the web
        const { token, ...session } = await api<SignInResponse>('/auth/signin', { method: 'POST', body: { email, password, remember: true } })
        setApiToken(token)
        await storage.set(KEYS.token, token)
        setState({ status: 'signed-in', session, workspaceId: await storage.get(KEYS.workspace) })
      },
      async startDemo() {
        const { token, ...session } = await api<DemoStartResponse>('/demo', { method: 'POST' })
        if (token) {
          setApiToken(token)
          await storage.set(KEYS.token, token)
        }
        // straight into the demo's workspace
        await storage.set(KEYS.workspace, session.demo!.workspaceId)
        setState({ status: 'signed-in', session, workspaceId: session.demo!.workspaceId })
      },
      async signOut() {
        await disablePush()
        await api('/auth/signout', { method: 'POST' }).catch(() => undefined)
        await forget()
      },
      async chooseWorkspace(id) {
        if (id) await storage.set(KEYS.workspace, id)
        else await storage.remove(KEYS.workspace)
        setState((s) => (s.status === 'signed-in' ? { ...s, workspaceId: id } : s))
      },
    }),
    [state, forget],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSession() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useSession() needs a SessionProvider')
  return v
}
