import type { CheckInboxResponse } from '@erp/shared'
import { Link } from '@tanstack/react-router'
import { MailCheck, Terminal } from 'lucide-react'
import { useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { AuthHeading } from './AuthLayout'

/** After sign-up or "forgot password": where the link went, and a way to ask for it again. */
export function CheckInbox({ sent }: { sent: CheckInboxResponse }) {
  const [resent, setResent] = useState<'idle' | 'sending' | 'done' | string>('idle')
  const verify = sent.status === 'verify-email'

  async function resend() {
    setResent('sending')
    try {
      await api(verify ? '/auth/resend-verification' : '/auth/forgot-password', { method: 'POST', body: { email: sent.email } })
      setResent('done')
    } catch (e) {
      setResent((e as Error).message)
    }
  }

  return (
    <div>
      <MailCheck className="text-muted-foreground mb-4 size-10" />
      <AuthHeading title="Check your email">
        {verify ? 'We sent a link to confirm your address to ' : 'If there’s an account for '}
        <span className="text-foreground font-medium">{sent.email}</span>
        {verify ? '. Open it to finish signing up.' : ', we sent it a link to choose a new password.'}
      </AuthHeading>
      {sent.delivery === 'console' && (
        <Alert className="mb-6">
          <Terminal />
          <AlertDescription>No mail server is set up, so the link is printed in the API’s terminal instead.</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-3">
        <Button variant="outline" onClick={resend} disabled={resent === 'sending' || resent === 'done'}>
          {resent === 'done' ? 'Sent again' : resent === 'sending' ? 'Sending…' : 'Send the link again'}
        </Button>
        {resent !== 'idle' && resent !== 'sending' && resent !== 'done' && <p className="text-destructive text-sm">{resent}</p>}
        <Button variant="link" asChild>
          <Link to="/sign-in">Back to sign in</Link>
        </Button>
      </div>
    </div>
  )
}
