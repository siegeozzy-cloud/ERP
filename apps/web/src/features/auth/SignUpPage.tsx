import { SignUpInput, type CheckInboxResponse } from '@erp/shared'
import { zodResolver } from '@hookform/resolvers/zod'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import type { z } from 'zod'
import { Field, FormError, showServerError } from '@/components/form'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { AuthHeading } from './AuthLayout'
import { CheckInbox } from './CheckInbox'

export function SignUpPage() {
  const [sent, setSent] = useState<CheckInboxResponse | null>(null)
  const form = useForm<z.input<typeof SignUpInput>, unknown, z.output<typeof SignUpInput>>({
    resolver: zodResolver(SignUpInput),
    defaultValues: { name: '', email: '', password: '', acceptedTerms: false },
  })
  const { errors, isSubmitting } = form.formState

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      setSent(await api<CheckInboxResponse>('/auth/signup', { method: 'POST', body: values }))
    } catch (e) {
      showServerError(form, e)
    }
  })

  if (sent) return <CheckInbox sent={sent} />

  return (
    <div>
      <AuthHeading title="Create your account">After this you’ll create a workspace for your business, or join one with a code.</AuthHeading>
      <form onSubmit={onSubmit} noValidate className="grid gap-5">
        <FormError message={errors.root?.message} />
        <Field id="name" label="Full name" error={errors.name?.message}>
          <Input id="name" autoComplete="name" aria-invalid={!!errors.name} {...form.register('name')} />
        </Field>
        <Field id="email" label="Email" error={errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" aria-invalid={!!errors.email} {...form.register('email')} />
        </Field>
        <Field id="password" label="Password" error={errors.password?.message} hint="At least 8 characters. A short phrase is easier to remember.">
          <Input id="password" type="password" autoComplete="new-password" aria-invalid={!!errors.password} {...form.register('password')} />
        </Field>
        <div className="grid gap-2">
          <div className="flex items-start gap-2">
            <Controller
              control={form.control}
              name="acceptedTerms"
              render={({ field }) => (
                <Checkbox id="acceptedTerms" className="mt-0.5" aria-invalid={!!errors.acceptedTerms} checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} />
              )}
            />
            <Label htmlFor="acceptedTerms" className="leading-snug font-normal">
              I agree to the Terms and the Privacy Notice, and consent to my personal data being processed under the Data Privacy Act of 2012.
            </Label>
          </div>
          {errors.acceptedTerms && <p className="text-destructive text-sm">{errors.acceptedTerms.message}</p>}
        </div>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
      <p className="text-muted-foreground mt-6 text-center text-sm">
        Already have an account?{' '}
        <Link to="/sign-in" className="text-foreground underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </div>
  )
}
