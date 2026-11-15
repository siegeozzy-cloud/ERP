import { EmailInput, type CheckInboxResponse } from '@erp/shared'
import { zodResolver } from '@hookform/resolvers/zod'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import type { z } from 'zod'
import { Field, FormError, showServerError } from '@/components/form'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { AuthHeading } from './AuthLayout'
import { CheckInbox } from './CheckInbox'

export function ForgotPasswordPage() {
  const [sent, setSent] = useState<CheckInboxResponse | null>(null)
  const form = useForm<z.input<typeof EmailInput>, unknown, z.output<typeof EmailInput>>({
    resolver: zodResolver(EmailInput),
    defaultValues: { email: '' },
  })
  const { errors, isSubmitting } = form.formState

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      setSent(await api<CheckInboxResponse>('/auth/forgot-password', { method: 'POST', body: values }))
    } catch (e) {
      showServerError(form, e)
    }
  })

  if (sent) return <CheckInbox sent={sent} />

  return (
    <div>
      <AuthHeading title="Forgot your password?">Enter your email and we’ll send you a link to choose a new one.</AuthHeading>
      <form onSubmit={onSubmit} noValidate className="grid gap-5">
        <FormError message={errors.root?.message} />
        <Field id="email" label="Email" error={errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" aria-invalid={!!errors.email} {...form.register('email')} />
        </Field>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
      <p className="text-muted-foreground mt-6 text-center text-sm">
        <Link to="/sign-in" className="text-foreground underline underline-offset-4">
          Back to sign in
        </Link>
      </p>
    </div>
  )
}
