import { useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { CircleAlert, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Brand } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { ApiError } from '@/lib/api'

/** Shown while a page is still loading (after a short delay, so fast loads don't flash it). */
export function PendingPage() {
  return (
    <div className="bg-background grid min-h-svh place-items-center px-4">
      <div className="flex flex-col items-center gap-4">
        <Brand />
        <RefreshCw className="text-muted-foreground size-5 animate-spin" aria-label="Loading" />
      </div>
    </div>
  )
}

/**
 * Shown instead of a page that couldn't load, most often because the API can't be reached.
 * "Try again" reruns the page's loading, so once the server is back the page simply appears.
 */
export function ErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter()
  const [retrying, setRetrying] = useState(false)
  const offline = error instanceof ApiError && error.code === 'offline'

  async function retry() {
    setRetrying(true)
    try {
      reset()
      await router.invalidate()
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className="bg-background grid min-h-svh place-items-center px-4">
      <div className="w-full max-w-md space-y-6 text-center">
        <Brand className="justify-center" />
        <CircleAlert className="text-destructive mx-auto size-10" />
        <div className="space-y-2">
          <h1 className="text-xl font-semibold tracking-tight">{offline ? 'The server isn’t answering' : 'Something went wrong'}</h1>
          <p className="text-muted-foreground text-sm">{(error instanceof Error && error.message) || 'An unexpected error stopped this page from loading.'}</p>
        </div>
        <Button onClick={() => void retry()} disabled={retrying}>
          <RefreshCw className={retrying ? 'animate-spin' : ''} />
          {retrying ? 'Trying…' : 'Try again'}
        </Button>
      </div>
    </div>
  )
}
