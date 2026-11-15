import type { ApiErrorBody } from '@erp/shared'

/**
 * Where the API is. Empty in development: the Vite dev server proxies /api, so the app and the API
 * share an origin and the httpOnly cookie carries the session. Set VITE_API_URL when the API is
 * deployed on a different site (e.g. Render while the app is on Vercel). The browser won't send the
 * cookie across sites, so the token from sign-in is kept here and sent as a header instead.
 */
const API_URL = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/$/, '')
const crossSite = API_URL !== ''

const TOKEN_KEY = 'erp.session'

/** The session token, only kept when the cookie can't do the job. Storage can be blocked, so every access is guarded. */
export const tokenStore = {
  get() {
    try {
      return localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY)
    } catch {
      return null
    }
  },
  /** "Keep me signed in" survives closing the browser; otherwise the token ends with the tab. */
  set(token: string, remember: boolean) {
    if (!crossSite) return
    try {
      ;(remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token)
    } catch {
      // blocked storage: the person stays signed in until the page reloads
    }
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY)
      sessionStorage.removeItem(TOKEN_KEY)
    } catch {
      // nothing stored
    }
  },
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly field?: string

  constructor(status: number, code: string, message: string, field?: string) {
    super(message)
    this.status = status
    this.code = code
    this.field = field
  }
}

/** In development the usual cause is that the API simply isn't running, so say how to start it. */
const UNREACHABLE = import.meta.env.DEV
  ? 'Can’t reach the API. Is it running? Start everything with “npm run dev” in the project folder, or “npm run dev:api” alongside the web app.'
  : 'Can’t reach the server. Check your connection, or try again in a minute (the free server takes a moment to wake up).'

type Options = { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown }

/** Calls the API. Errors arrive as ApiError, with a message written for people. */
export async function api<T>(path: string, { method = 'GET', body }: Options = {}): Promise<T> {
  const token = crossSite ? tokenStore.get() : null
  let res: Response
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      method,
      credentials: 'include',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'offline', UNREACHABLE)
  }
  if (res.status === 204) return undefined as T
  const data = (await res.json().catch(() => null)) as unknown
  if (res.ok) return data as T
  const error = (data as ApiErrorBody | null)?.error
  // no JSON error body: the dev proxy or the host answered because the API itself didn't
  if (!error) throw new ApiError(res.status, 'offline', UNREACHABLE)
  throw new ApiError(res.status, error.code, error.message, error.field)
}
