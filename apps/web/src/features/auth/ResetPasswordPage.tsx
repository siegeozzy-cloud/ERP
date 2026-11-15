import { passwordSchema } from '@erp/shared'
import { zodResolver } from '@hookform/resolvers/zod'
import { Link, useNavigate } from '@tanstack/react-router'
import { CircleAlert } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { Field, FormError, showServerError } from '@/components/form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { AuthHeading } from './AuthLayout'

export type ResetSearch = { token?: string; error?: string }

/** The new password, typed twice. Only the first goes to the API, which checks it again. */
const NewPassword = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { message: 'The two passwords don’t match.', path: ['confirm'] })

export function ResetPasswordPage({ search }: { search: ResetSearch }) {
  const navigate = useNavigate()
  const form = useForm<z.infer<typeof NewPassword>>({ resolver: zodResolver(NewPassword), defaultValues: { password: '', confirm: '' } })
  const { errors, isSubmitting } = form.formState

  const onSubmit = form.handleSubmit(async ({ password }) => {
    try {
      await api('/auth/reset-password', { method: 'POST', body: { token: search.token, password } })
      await navigate({ to: '/sign-in', search: { reset: 'done' } })
    } catch (e) {
      showServerError(form, e)
    }
  })

  if (!search.token) {
    return (
      <div>
        <AuthHeading title="That link doesn’t work" />
        <Alert variant="destructive" className="mb-6">
          <CircleAlert />
          <AlertDescription>
            {search.error === 'expired' ? 'The reset link has expired. Links work for one hour.' : 'The reset link has already been used, or it isn’t complete.'}
          </AlertDescription>
        </Alert>
        <Button asChild className="w-full">
          <Link to="/forgot-password">Ask for a new link</Link>
        </Button>
      </div>
    )
  }

  return (
    <div>
      <AuthHeading title="Choose a new password">You’ll be signed out everywhere else once it’s changed.</AuthHeading>
      <form onSubmit={onSubmit} noValidate className="grid gap-5">
        <FormError message={errors.root?.message} />
        <Field id="password" label="New password" error={errors.password?.message} hint="At least 8 characters.">
          <Input id="password" type="password" autoComplete="new-password" aria-invalid={!!errors.password} {...form.register('password')} />
        </Field>
        <Field id="confirm" label="Type it again" error={errors.confirm?.message}>
          <Input id="confirm" type="password" autoComplete="new-password" aria-invalid={!!errors.confirm} {...form.register('confirm')} />
        </Field>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Change password'}
        </Button>
      </form>
    </div>
  )
}
