import type { ApiErrorBody } from '@erp/shared'
import { API_URL } from '../config'

/**
 * Calls the API with the session token as a bearer header. The phone can't use the web app's
 * cookie, so the token from sign-in is kept in secure storage and sent with every request.
 */

let token: string | null = null
export const setApiToken = (t: string | null) => {
  token = t
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

const UNREACHABLE = `Can’t reach the server at ${API_URL}. Check your connection, or that the API is running.`

/** Fired when the server says the session is over, so the app can go back to sign-in. */
let onSignedOut: (() => void) | null = null
export const whenSignedOut = (fn: () => void) => {
  onSignedOut = fn
}

export async function api<T>(path: string, { method = 'GET', body }: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new ApiError(0, 'offline', UNREACHABLE)
  }
  if (res.status === 204) return undefined as T
  const data = (await res.json().catch(() => null)) as unknown
  if (res.ok) return data as T
  const error = (data as ApiErrorBody | null)?.error
  if (!error) throw new ApiError(res.status, 'offline', UNREACHABLE)
  if (res.status === 401 && error.code === 'signed-out') onSignedOut?.()
  throw new ApiError(res.status, error.code, error.message, error.field)
}
