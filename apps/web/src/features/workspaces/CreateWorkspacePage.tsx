import { TEMPLATES, VAT_STATUS_LABELS, VAT_STATUSES, WorkspaceInput, type Template, type Workspace } from '@erp/shared'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ArrowLeft, Check } from 'lucide-react'
import { useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import type { z } from 'zod'
import { Field, FormError, showServerError } from '@/components/form'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { MODULES } from '@/app/modules'
import { api } from '@/lib/api'
import { MONTH_NAMES } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { AddressPicker } from './AddressPicker'
import { OnboardingLayout } from './OnboardingLayout'
import { workspacesQuery } from './queries'

/** Step 1: what kind of business. Step 2: its details. */
export function CreateWorkspacePage() {
  const [template, setTemplate] = useState<Template | null>(null)
  return template ? <DetailsStep template={template} onBack={() => setTemplate(null)} /> : <TemplateStep onPick={setTemplate} />
}

function TemplateStep({ onPick }: { onPick: (t: Template) => void }) {
  const moduleLabel = (slug: string) => MODULES.find((m) => m.slug === slug)?.label ?? slug
  return (
    <OnboardingLayout wide>
      <div className="mb-8 space-y-1">
        <p className="text-muted-foreground text-sm">Step 1 of 2</p>
        <h1 className="text-2xl font-semibold tracking-tight">What kind of business is it?</h1>
        <p className="text-muted-foreground">This sets up the modules and accounts it needs. You can turn modules on or off later.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {TEMPLATES.map((t) => (
          <button key={t.key} type="button" onClick={() => onPick(t)} className="group focus-visible:ring-ring/50 rounded-xl text-left outline-none focus-visible:ring-[3px]">
            <Card className="group-hover:border-foreground/30 h-full gap-3 transition-colors">
              <CardHeader>
                <CardTitle>{t.name}</CardTitle>
                <CardDescription>{t.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <ul className="grid gap-1.5 text-sm">
                  {t.highlights.map((h) => (
                    <li key={h} className="flex gap-2">
                      <Check className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                      {h}
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-1">
                  {t.modules.map((m) => (
                    <Badge key={m} variant="secondary">
                      {moduleLabel(m)}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          </button>
        ))}
      </div>
    </OnboardingLayout>
  )
}

function DetailsStep({ template, onBack }: { template: Template; onBack: () => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const form = useForm<z.input<typeof WorkspaceInput>, unknown, z.output<typeof WorkspaceInput>>({
    resolver: zodResolver(WorkspaceInput),
    defaultValues: { template: template.key, name: '', tin: '', vatStatus: 'vat', street: '', barangayCode: null, fiscalYearStartMonth: 1 },
  })
  const { errors, isSubmitting } = form.formState

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const { workspace } = await api<{ workspace: Workspace }>('/workspaces', { method: 'POST', body: values })
      await queryClient.invalidateQueries({ queryKey: workspacesQuery.queryKey })
      await navigate({ to: '/w/$workspaceId', params: { workspaceId: workspace.id } })
    } catch (e) {
      showServerError(form, e)
    }
  })

  return (
    <OnboardingLayout>
      <Button variant="ghost" size="sm" className="mb-4 -ml-2" onClick={onBack}>
        <ArrowLeft />
        Choose another kind of business
      </Button>
      <Card>
        <CardHeader>
          <p className="text-muted-foreground text-sm">Step 2 of 2 · {template.name}</p>
          <CardTitle className="text-xl">Your business details</CardTitle>
          <CardDescription>These print on your invoices and BIR forms.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} noValidate className="grid gap-5">
            <FormError message={errors.root?.message} />
            <Field id="name" label="Registered business name" error={errors.name?.message} hint="As it appears on your BIR Certificate of Registration.">
              <Input id="name" aria-invalid={!!errors.name} {...form.register('name')} />
            </Field>
            <Field id="tin" label="TIN" error={errors.tin?.message} hint="With the branch code: 000-000-000-00000 (head office is 00000 or 000).">
              <Input id="tin" inputMode="numeric" placeholder="000-000-000-00000" aria-invalid={!!errors.tin} {...form.register('tin')} />
            </Field>
            <Field id="vatStatus" label="Tax type" error={errors.vatStatus?.message} hint="Non-VAT businesses pay 3% percentage tax on sales instead. This can’t change once you’ve posted invoices.">
              <NativeSelect id="vatStatus" {...form.register('vatStatus')}>
                {VAT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {VAT_STATUS_LABELS[s]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Controller
              control={form.control}
              name="street"
              render={({ field }) => (
                <AddressPicker
                  street={field.value}
                  barangayCode={(form.watch('barangayCode') as string | null | undefined) ?? null}
                  error={errors.street?.message ?? errors.barangayCode?.message}
                  onChange={(v) => {
                    field.onChange(v.street)
                    form.setValue('barangayCode', v.barangayCode)
                  }}
                />
              )}
            />
            <Field id="fiscalYearStartMonth" label="Fiscal year starts in" error={errors.fiscalYearStartMonth?.message}>
              <NativeSelect id="fiscalYearStartMonth" {...form.register('fiscalYearStartMonth')}>
                {MONTH_NAMES.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Button type="submit" disabled={isSubmitting} className={cn(isSubmitting && 'cursor-wait')}>
              {isSubmitting ? 'Setting it up…' : 'Create workspace'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </OnboardingLayout>
  )
}
