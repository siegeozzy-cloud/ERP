import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPES, AccountInput, formatRate, type Account } from '@erp/shared'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { Lock, Plus } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import type { z } from 'zod'
import { Field, FormError, showServerError } from '@/components/form'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useCan, useWorkspaceId } from '@/features/workspaces/queries'
import { api } from '@/lib/api'
import { formatDate } from '@/lib/dates'
import { LoadError, Loading, PageHeader } from './components'
import { financeQueries, useWorkspaceMutation } from './queries'

function NewAccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const form = useForm<z.input<typeof AccountInput>, unknown, z.output<typeof AccountInput>>({
    resolver: zodResolver(AccountInput),
    defaultValues: { code: '', name: '', type: 'expense', subtype: 'other' },
  })
  const { errors, isSubmitting } = form.formState
  const create = useWorkspaceMutation((w, values: z.output<typeof AccountInput>) => api(`/w/${w}/accounts`, { method: 'POST', body: values }))
  const type = form.watch('type')

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await create.mutateAsync(values)
      form.reset()
      onOpenChange(false)
    } catch (e) {
      showServerError(form, e)
    }
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New account</DialogTitle>
          <DialogDescription>The code decides where it sorts: 1 assets, 2 liabilities, 3 equity, 4 income, 5–9 expenses.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          <FormError message={errors.root?.message} />
          <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
            <Field id="a-code" label="Code" error={errors.code?.message}>
              <Input id="a-code" inputMode="numeric" aria-invalid={!!errors.code} {...form.register('code')} />
            </Field>
            <Field id="a-name" label="Name" error={errors.name?.message}>
              <Input id="a-name" aria-invalid={!!errors.name} {...form.register('name')} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="a-type" label="Type" error={errors.type?.message}>
              <NativeSelect id="a-type" {...form.register('type')}>
                {ACCOUNT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ACCOUNT_TYPE_LABELS[t]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {type === 'asset' && (
              <Field id="a-subtype" label="Holds money?" error={errors.subtype?.message} hint="Cash and bank accounts can receive and make payments.">
                <NativeSelect id="a-subtype" {...form.register('subtype')}>
                  <option value="other">No</option>
                  <option value="cash">Yes, cash</option>
                  <option value="bank">Yes, a bank account</option>
                </NativeSelect>
              </Field>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Adding…' : 'Add account'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function AccountsPage() {
  const workspaceId = useWorkspaceId()
  const accounts = useQuery(financeQueries.accounts(workspaceId))
  const taxCodes = useQuery(financeQueries.taxCodes(workspaceId))
  const [adding, setAdding] = useState(false)
  const canEdit = useCan()('finance.edit')
  const toggle = useWorkspaceMutation((w, a: Account) => api(`/w/${w}/accounts/${a.id}`, { method: 'PATCH', body: { name: a.name, active: !a.active } }))

  if (accounts.error) return <LoadError error={accounts.error} />
  if (!accounts.data) return <Loading />

  return (
    <div className="space-y-8">
      <PageHeader
        title="Chart of accounts"
        description="Every amount in the books lands in one of these. Accounts marked with a lock are posted to automatically."
        actions={
          canEdit ? (
            <Button onClick={() => setAdding(true)}>
              <Plus />
              New account
            </Button>
          ) : undefined
        }
      />
      {toggle.error && <p className="text-destructive text-sm">{toggle.error.message}</p>}
      {ACCOUNT_TYPES.map((type) => {
        const rows = accounts.data.filter((a) => a.type === type)
        if (!rows.length) return null
        return (
          <section key={type} className="space-y-2">
            <h3 className="text-muted-foreground text-sm font-medium">{ACCOUNT_TYPE_LABELS[type]}</h3>
            <div className="rounded-xl border">
              <Table>
                <TableBody>
                  {rows.map((a) => (
                    <TableRow key={a.id} className={a.active ? '' : 'opacity-60'}>
                      <TableCell className="w-20 tabular-nums">{a.code}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          {a.name}
                          {a.systemKey && <Lock className="text-muted-foreground size-3.5" aria-label="Posted to automatically" />}
                          {a.subtype !== 'other' && <Badge variant="secondary">{a.subtype === 'cash' ? 'Cash' : 'Bank'}</Badge>}
                          {!a.active && <Badge variant="outline">Off</Badge>}
                        </span>
                      </TableCell>
                      <TableCell className="w-28 text-right">
                        {!a.systemKey && canEdit && (
                          <Button variant="ghost" size="sm" onClick={() => toggle.mutate(a)} disabled={toggle.isPending}>
                            {a.active ? 'Turn off' : 'Turn on'}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        )
      })}

      <Card>
        <CardHeader>
          <CardTitle>Tax codes</CardTitle>
          <CardDescription>
            Rates are kept with the date they apply from, so a document always uses the rate in force on its date. Check them against the latest BIR issuances.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Code</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="pr-6">From</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {taxCodes.data?.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="pl-6 font-medium whitespace-nowrap">{t.atc ?? t.code}</TableCell>
                  <TableCell className="min-w-56">{t.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatRate(t.rateBp)}</TableCell>
                  <TableCell className="pr-6 whitespace-nowrap">{formatDate(t.effectiveFrom)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <NewAccountDialog open={adding} onOpenChange={setAdding} />
    </div>
  )
}
