import { JoinInput, type Workspace } from '@erp/shared'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useForm } from 'react-hook-form'
import type { z } from 'zod'
import { Field, FormError, showServerError } from '@/components/form'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { OnboardingLayout } from './OnboardingLayout'
import { workspacesQuery } from './queries'

export function JoinWorkspacePage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const form = useForm<z.input<typeof JoinInput>, unknown, z.output<typeof JoinInput>>({ resolver: zodResolver(JoinInput), defaultValues: { code: '' } })
  const { errors, isSubmitting } = form.formState

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const { workspace } = await api<{ workspace: Workspace }>('/workspaces/join', { method: 'POST', body: values })
      await queryClient.invalidateQueries({ queryKey: workspacesQuery.queryKey })
      await navigate({ to: '/w/$workspaceId', params: { workspaceId: workspace.id } })
    } catch (e) {
      showServerError(form, e)
    }
  })

  return (
    <OnboardingLayout>
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Join a workspace</CardTitle>
          <CardDescription>Enter the code an owner or admin gave you. Each code works once, for one person, and expires.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} noValidate className="grid gap-5">
            <FormError message={errors.root?.message} />
            <Field id="code" label="Join code" error={errors.code?.message}>
              <Input
                id="code"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="7K3Q-9XPA"
                className="h-12 text-center font-mono text-xl tracking-[0.3em] uppercase"
                aria-invalid={!!errors.code}
                {...form.register('code')}
              />
            </Field>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Joining…' : 'Join'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </OnboardingLayout>
  )
}
