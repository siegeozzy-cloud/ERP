import { ContactInput, formatRate, type Contact } from '@erp/shared'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import type { z } from 'zod'
import { Field, FormError, showServerError } from '@/components/form'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { useCan, useWorkspaceId } from '@/features/workspaces/queries'
import { api } from '@/lib/api'
import { EmptyState, LoadError, Loading, PageHeader } from './components'
import { financeQueries, useWorkspaceMutation } from './queries'

type Values = z.input<typeof ContactInput>

/**
 * Adding or editing a customer or supplier. Also opened from an invoice or bill, to add the
 * contact without leaving the form: `onSaved` hands the new contact back.
 */
export function ContactDialog({
  open,
  onOpenChange,
  contact,
  role,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  contact?: Contact
  role?: 'customer' | 'supplier'
  onSaved?: (contact: Contact) => void
}) {
  // the form mounts with the dialog's content, so every opening starts from this contact (or blank)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <ContactForm contact={contact} role={role} onSaved={onSaved} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function ContactForm({ contact, role, onSaved, onClose }: { contact?: Contact; role?: 'customer' | 'supplier'; onSaved?: (contact: Contact) => void; onClose: () => void }) {
  const workspaceId = useWorkspaceId()
  const { data: taxCodes = [] } = useQuery(financeQueries.taxCodes(workspaceId))
  const ewtCodes = taxCodes.filter((t) => t.kind === 'ewt' && t.active)
  const form = useForm<Values, unknown, z.output<typeof ContactInput>>({
    resolver: zodResolver(ContactInput),
    defaultValues: {
      name: contact?.name ?? '',
      tin: contact?.tin ?? '',
      address: contact?.address ?? '',
      email: contact?.email ?? '',
      phone: contact?.phone ?? '',
      isCustomer: contact?.isCustomer ?? role !== 'supplier',
      isSupplier: contact?.isSupplier ?? role === 'supplier',
      defaultEwtCodeId: contact?.defaultEwtCodeId ?? null,
    },
  })
  const { errors, isSubmitting } = form.formState
  const save = useWorkspaceMutation((w, values: z.output<typeof ContactInput>) =>
    contact ? api<{ contact: Contact }>(`/w/${w}/contacts/${contact.id}`, { method: 'PUT', body: values }) : api<{ contact: Contact }>(`/w/${w}/contacts`, { method: 'POST', body: values }),
  )
  const isSupplier = form.watch('isSupplier')

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const { contact: saved } = await save.mutateAsync(values)
      onSaved?.(saved)
      onClose()
    } catch (e) {
      showServerError(form, e)
    }
  })

  return (
    <>
        <DialogHeader>
          <DialogTitle>{contact ? 'Edit contact' : role === 'supplier' ? 'New supplier' : role === 'customer' ? 'New customer' : 'New contact'}</DialogTitle>
          <DialogDescription>The registered name and TIN print on invoices and BIR forms.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          <FormError message={errors.root?.message} />
          <Field id="c-name" label="Registered name" error={errors.name?.message}>
            <Input id="c-name" aria-invalid={!!errors.name} {...form.register('name')} />
          </Field>
          <Field id="c-tin" label="TIN" error={errors.tin?.message} hint="Leave blank if you don’t have it.">
            <Input id="c-tin" inputMode="numeric" placeholder="000-000-000-00000" aria-invalid={!!errors.tin} {...form.register('tin')} />
          </Field>
          <Field id="c-address" label="Address" error={errors.address?.message}>
            <Textarea id="c-address" rows={2} {...form.register('address')} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="c-email" label="Email" error={errors.email?.message}>
              <Input id="c-email" type="email" {...form.register('email')} />
            </Field>
            <Field id="c-phone" label="Phone" error={errors.phone?.message}>
              <Input id="c-phone" type="tel" {...form.register('phone')} />
            </Field>
          </div>
          <div className="grid gap-2">
            <div className="flex flex-wrap gap-6">
              {(['isCustomer', 'isSupplier'] as const).map((name) => (
                <div key={name} className="flex items-center gap-2">
                  <Controller control={form.control} name={name} render={({ field }) => <Checkbox id={`c-${name}`} checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} />} />
                  <Label htmlFor={`c-${name}`} className="font-normal">
                    {name === 'isCustomer' ? 'Customer' : 'Supplier'}
                  </Label>
                </div>
              ))}
            </div>
            {errors.isCustomer && <p className="text-destructive text-sm">{errors.isCustomer.message}</p>}
          </div>
          {isSupplier && (
            <Field id="c-ewt" label="Usual withholding tax" hint="Filled in for you on this supplier’s bills.">
              <NativeSelect id="c-ewt" {...form.register('defaultEwtCodeId', { setValueAs: (v) => v || null })}>
                <option value="">None</option>
                {ewtCodes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.atc} · {formatRate(t.rateBp)} · {t.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
    </>
  )
}

export function ContactsPage() {
  const workspaceId = useWorkspaceId()
  const contacts = useQuery(financeQueries.contacts(workspaceId))
  const [editing, setEditing] = useState<Contact | 'new' | null>(null)
  const canEdit = useCan()('finance.edit')

  return (
    <div>
      <PageHeader
        title="Contacts"
        description="Customers you invoice and suppliers you pay."
        actions={
          canEdit ? (
            <Button onClick={() => setEditing('new')}>
              <Plus />
              New contact
            </Button>
          ) : undefined
        }
      />
      {contacts.error ? (
        <LoadError error={contacts.error} />
      ) : !contacts.data ? (
        <Loading />
      ) : contacts.data.length === 0 ? (
        <EmptyState title="No contacts yet" action={canEdit ? <Button onClick={() => setEditing('new')}>Add your first contact</Button> : undefined}>
          Add the customers you sell to and the suppliers you buy from.
        </EmptyState>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>TIN</TableHead>
                <TableHead className="hidden md:table-cell">Email</TableHead>
                <TableHead>Type</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contacts.data.map((c) => (
                <TableRow key={c.id} className={canEdit ? 'cursor-pointer' : ''} onClick={() => canEdit && setEditing(c)}>
                  <TableCell className="font-medium">
                    <button type="button" className="text-left hover:underline">
                      {c.name}
                    </button>
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{c.tin ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground hidden md:table-cell">{c.email ?? '—'}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {c.isCustomer && <Badge variant="secondary">Customer</Badge>}
                      {c.isSupplier && <Badge variant="secondary">Supplier</Badge>}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <ContactDialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} contact={editing === 'new' || editing === null ? undefined : editing} />
    </div>
  )
}
