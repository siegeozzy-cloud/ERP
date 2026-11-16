import { SignInInput, type SignInResponse } from '@erp/shared'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useRouter } from '@tanstack/react-router'
import { CircleCheck, CircleAlert } from 'lucide-react'
import { Controller, useForm } from 'react-hook-form'
import type { z } from 'zod'
import { Field, FormError, showServerError } from '@/components/form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { TryDemoCard } from '@/features/demo/demo'
import { api, tokenStore } from '@/lib/api'
import { AuthHeading } from './AuthLayout'
import { safeRedirect, sessionQuery } from './session'

export type SignInSearch = { redirect?: string; verified?: string; reset?: string }

/** What the email links and the reset form came back with. */
function Notice({ search }: { search: SignInSearch }) {
  const notice =
    search.verified === '1'
      ? { ok: true, text: 'Your email is confirmed. Sign in to continue.' }
      : search.verified === 'expired'
        ? { ok: false, text: 'That confirmation link has expired. Sign in and we’ll send a new one.' }
        : search.verified === 'invalid'
          ? { ok: false, text: 'That confirmation link doesn’t work anymore. It may have been used already.' }
          : search.reset === 'done'
            ? { ok: true, text: 'Your password is changed. Sign in with the new one.' }
            : null
  if (!notice) return null
  return (
    <Alert variant={notice.ok ? 'success' : 'destructive'} className="mb-6">
      {notice.ok ? <CircleCheck /> : <CircleAlert />}
      <AlertDescription>{notice.text}</AlertDescription>
    </Alert>
  )
}

export function SignInPage({ search }: { search: SignInSearch }) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const form = useForm<z.input<typeof SignInInput>, unknown, z.output<typeof SignInInput>>({
    resolver: zodResolver(SignInInput),
    defaultValues: { email: '', password: '', remember: false },
  })
  const { errors, isSubmitting } = form.formState

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const { token, ...session } = await api<SignInResponse>('/auth/signin', { method: 'POST', body: values })
      tokenStore.set(token, values.remember)
      queryClient.setQueryData(sessionQuery.queryKey, session)
      router.history.push(safeRedirect(search.redirect))
    } catch (e) {
      showServerError(form, e)
    }
  })

  return (
    <div>
      <AuthHeading title="Sign in">Welcome back. Enter your email and password.</AuthHeading>
      <Notice search={search} />
      <form onSubmit={onSubmit} noValidate className="grid gap-5">
        <FormError message={errors.root?.message} />
        <Field id="email" label="Email" error={errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" aria-invalid={!!errors.email} {...form.register('email')} />
        </Field>
        <Field
          id="password"
          label={
            <span className="flex w-full items-center justify-between">
              Password
              <Link to="/forgot-password" className="text-muted-foreground text-sm font-normal underline-offset-4 hover:underline">
                Forgot password?
              </Link>
            </span>
          }
          error={errors.password?.message}
        >
          <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!errors.password} {...form.register('password')} />
        </Field>
        <div className="flex items-center gap-2">
          <Controller
            control={form.control}
            name="remember"
            render={({ field }) => <Checkbox id="remember" checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} />}
          />
          <Label htmlFor="remember" className="font-normal">
            Keep me signed in for 30 days
          </Label>
        </div>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <p className="text-muted-foreground mt-6 text-center text-sm">
        New here?{' '}
        <Link to="/sign-up" className="text-foreground underline underline-offset-4">
          Create an account
        </Link>
      </p>
      <TryDemoCard />
    </div>
  )
}
