import { AlertCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import type { FieldValues, Path, UseFormReturn } from 'react-hook-form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Label } from '@/components/ui/label'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'

/** A label, the input passed as children, and the field's error under it. */
export function Field({ id, label, error, hint, children, className }: { id: string; label: ReactNode; error?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid gap-2', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-destructive text-sm">
          {error}
        </p>
      ) : hint ? (
        <p className="text-muted-foreground text-sm">{hint}</p>
      ) : null}
    </div>
  )
}

/** The error for the form as a whole (not tied to one field). */
export function FormError({ message }: { message?: string }) {
  if (!message) return null
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

/**
 * Shows an API error where it belongs: under the field it names, or above the form. The API's
 * messages are written for people, so they're shown as they are.
 */
export function showServerError<T extends FieldValues>(form: UseFormReturn<T>, error: unknown) {
  const message = error instanceof Error ? error.message : 'Something went wrong. Try again.'
  const field = error instanceof ApiError ? error.field : undefined
  if (field && field in form.getValues()) form.setError(field as Path<T>, { message }, { shouldFocus: true })
  else form.setError('root', { message })
}
