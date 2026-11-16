import type { DemoStartResponse } from '@erp/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Check, CircleAlert, Copy, LogOut, Smartphone, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { sessionQuery, useSignOut } from '@/features/auth/session'
import { api, tokenStore } from '@/lib/api'

/**
 * "Try the demo": the API hands this browser its own copy of the demo business (a food distributor,
 * three months in) and signs it in as the owner. Nothing to sign up for.
 */
function useStartDemo() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function start() {
    setBusy(true)
    setError(null)
    try {
      const { token, ...session } = await api<DemoStartResponse>('/demo', { method: 'POST' })
      if (token) tokenStore.set(token, true)
      // whatever this browser had cached belonged to someone else
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' })
      queryClient.setQueryData(sessionQuery.queryKey, session)
      await navigate({ to: '/w/$workspaceId', params: { workspaceId: session.demo!.workspaceId } })
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return { start, busy, error }
}

const WAITING = 'Setting up your demo business… This can take up to a minute when the server has been asleep.'

/** Under the sign-in form. Hidden when the server has the demo turned off. */
export function TryDemoCard() {
  const enabled = useQuery({ queryKey: ['demo-enabled'], queryFn: () => api<{ enabled: boolean }>('/demo'), staleTime: Infinity, retry: false })
  const { start, busy, error } = useStartDemo()
  if (!enabled.data?.enabled) return null
  return (
    <div className="bg-muted/40 mt-8 rounded-lg border p-4">
      <p className="flex items-center gap-2 text-sm font-medium">
        <Sparkles className="size-4" />
        Just looking?
      </p>
      <p className="text-muted-foreground mt-1 text-sm">
        Open a ready-made food distributor with three months of invoices, stock, payroll and leads. Nothing to sign up for; it’s yours until 3 a.m.
      </p>
      {error && (
        <Alert variant="destructive" className="mt-3">
          <CircleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button variant="outline" className="mt-3 w-full" onClick={() => void start()} disabled={busy}>
        {busy ? 'Setting it up…' : 'Try the demo'}
      </Button>
      {busy && <p className="text-muted-foreground mt-2 text-xs">{WAITING}</p>}
    </div>
  )
}

/** /demo: a link to put in a pitch deck or a message. Starts the demo straight away. */
export function DemoStartPage() {
  const { start, busy, error } = useStartDemo()
  const once = useRef(false)
  useEffect(() => {
    if (once.current) return
    once.current = true
    void start()
  }, [start])
  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight">Opening the demo</h2>
      {error ? (
        <>
          <Alert variant="destructive" className="mt-6">
            <CircleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
          <div className="mt-4 flex gap-2">
            <Button onClick={() => void start()} disabled={busy}>
              Try again
            </Button>
            <Button variant="outline" asChild>
              <Link to="/sign-in">Sign in instead</Link>
            </Button>
          </div>
        </>
      ) : (
        <p className="text-muted-foreground mt-2 text-sm">{WAITING}</p>
      )}
    </div>
  )
}

const manilaTime = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="hover:bg-background/60 inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono"
      aria-label={`Copy the ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {text}
      {copied ? <Check className="size-3" /> : <Copy className="size-3 opacity-60" />}
    </button>
  )
}

/**
 * Across the top of every page in a demo: that it's a demo, when it's wiped, and how to open the same
 * business on the phone app (clock in there, and watch it appear here).
 */
export function DemoBanner() {
  const { data: session } = useQuery(sessionQuery)
  const signOut = useSignOut()
  const [phone, setPhone] = useState(false)
  const demo = session?.demo
  if (!demo) return null
  return (
    <div className="border-b bg-amber-50 px-4 py-2 text-sm text-amber-950 md:px-8 dark:bg-amber-950/40 dark:text-amber-100 print:hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span>
          <strong className="font-semibold">Demo.</strong> Change anything you like: this business is yours alone, and it’s wiped at {manilaTime.format(new Date(demo.expiresAt))}.
        </span>
        <button type="button" className="inline-flex items-center gap-1 underline underline-offset-2" onClick={() => setPhone((v) => !v)} aria-expanded={phone}>
          <Smartphone className="size-3.5" />
          Open it on your phone
        </button>
        <button type="button" className="ml-auto inline-flex items-center gap-1 underline underline-offset-2" onClick={() => void signOut()}>
          <LogOut className="size-3.5" />
          Leave the demo
        </button>
      </div>
      {phone && (
        <p className="mt-1.5">
          In the phone app, sign in with <CopyButton text={demo.email} label="email" /> and <CopyButton text={demo.password} label="password" />. You’re Carmela, the owner: clock in, see your payslips, and
          approve the leave waiting for you.
        </p>
      )}
    </div>
  )
}
