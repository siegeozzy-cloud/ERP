import { centavosToInput, formatPeso, JOURNAL_SOURCE_LABELS, parsePeso, type Account, type JournalEntry } from '@erp/shared'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Plus, Send, Trash2, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { useFieldArray, useForm } from 'react-hook-form'
import { FormError } from '@/components/form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useCan, useWorkspaceId } from '@/features/workspaces/queries'
import { api } from '@/lib/api'
import { formatDate, today } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { EmptyState, LoadError, Loading, Money, PageHeader } from './components'
import { financeQueries, useWorkspaceMutation } from './queries'

export function JournalListPage() {
  const workspaceId = useWorkspaceId()
  const navigate = useNavigate()
  const entries = useQuery(financeQueries.journal(workspaceId))
  const canEdit = useCan()('finance.edit')
  const open = (id: string) => navigate({ to: '/w/$workspaceId/finance/journal/$id', params: { workspaceId, id } })
  const newButton = (
    <Button asChild>
      <Link to="/w/$workspaceId/finance/journal/new" params={{ workspaceId }}>
        <Plus />
        New entry
      </Link>
    </Button>
  )
  return (
    <div>
      <PageHeader title="General journal" description="Every posted amount, in order. Invoices, bills and payments add their own entries." actions={canEdit ? newButton : undefined} />
      {entries.error ? (
        <LoadError error={entries.error} />
      ) : !entries.data ? (
        <Loading />
      ) : entries.data.length === 0 ? (
        <EmptyState title="Nothing in the journal yet" action={canEdit ? newButton : undefined}>
          Post an invoice or a bill, or make an entry by hand, e.g. the owner’s starting capital.
        </EmptyState>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="hidden md:table-cell">From</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.data.map((e) => (
                <TableRow key={e.id} className="cursor-pointer" onClick={() => void open(e.id)}>
                  <TableCell className="font-medium whitespace-nowrap">
                    <button type="button" className="hover:underline" onClick={() => void open(e.id)}>
                      {e.number ?? 'Draft'}
                    </button>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(e.date)}</TableCell>
                  <TableCell className="max-w-80 min-w-48">
                    <span className="line-clamp-2">{e.memo}</span>
                    {e.reversedById && (
                      <Badge variant="secondary" className="mt-1">
                        Reversed
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden whitespace-nowrap md:table-cell">{JOURNAL_SOURCE_LABELS[e.source]}</TableCell>
                  <TableCell className="text-right">
                    <Money value={e.total} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

type LineValues = { accountId: string; debit: string; credit: string; description: string }
type Values = { date: string; memo: string; lines: LineValues[] }

export function JournalFormPage({ id }: { id?: string }) {
  const workspaceId = useWorkspaceId()
  const entry = useQuery({ ...financeQueries.entry(workspaceId, id ?? ''), enabled: !!id })
  const accounts = useQuery(financeQueries.accounts(workspaceId))
  if (entry.error) return <LoadError error={entry.error} />
  if ((id && !entry.data) || !accounts.data) return <Loading />
  if (entry.data && entry.data.status !== 'draft') return <p className="text-muted-foreground py-10 text-center text-sm">This entry is posted, so it can’t be changed. Reverse it instead.</p>
  return <JournalForm key={id ?? 'new'} existing={entry.data} accounts={accounts.data} />
}

function JournalForm({ existing, accounts }: { existing?: JournalEntry; accounts: Account[] }) {
  const workspaceId = useWorkspaceId()
  const navigate = useNavigate()
  const blank: LineValues = { accountId: '', debit: '', credit: '', description: '' }
  const form = useForm<Values>({
    defaultValues: existing
      ? {
          date: existing.date,
          memo: existing.memo,
          lines: existing.lines.map((l) => ({ accountId: l.account.id, debit: l.debit ? centavosToInput(l.debit) : '', credit: l.credit ? centavosToInput(l.credit) : '', description: l.description ?? '' })),
        }
      : { date: today(), memo: '', lines: [blank, blank] },
  })
  const lines = useFieldArray({ control: form.control, name: 'lines' })
  const values = form.watch()
  const { errors, isSubmitting } = form.formState
  const amount = (s: string) => (s.trim() ? (parsePeso(s) ?? 0) : 0)
  const debits = values.lines.reduce((s, l) => s + amount(l.debit), 0)
  const credits = values.lines.reduce((s, l) => s + amount(l.credit), 0)
  const save = useWorkspaceMutation(async (w, { body, post }: { body: object; post: boolean }) => {
    const { entry } = existing
      ? await api<{ entry: JournalEntry }>(`/w/${w}/journal/${existing.id}`, { method: 'PUT', body })
      : await api<{ entry: JournalEntry }>(`/w/${w}/journal`, { method: 'POST', body })
    if (post) await api(`/w/${w}/journal/${entry.id}/post`, { method: 'POST' })
    return entry.id
  })

  const submit = (post: boolean) =>
    form.handleSubmit(async (v) => {
      const kept = v.lines.filter((l) => l.accountId || l.debit.trim() || l.credit.trim())
      for (const [i, l] of kept.entries()) {
        const d = l.debit.trim() ? parsePeso(l.debit) : 0
        const c = l.credit.trim() ? parsePeso(l.credit) : 0
        if (!l.accountId) return form.setError('root', { message: `Line ${i + 1}: choose an account.` })
        if (d === null || c === null) return form.setError('root', { message: `Line ${i + 1}: enter amounts like 1,250.00.` })
        if ((d > 0) === (c > 0)) return form.setError('root', { message: `Line ${i + 1}: enter either a debit or a credit.` })
      }
      if (!v.memo.trim()) return form.setError('memo', { message: 'Describe what this entry is for.' })
      if (debits !== credits) return form.setError('root', { message: `Debits and credits differ by ${formatPeso(Math.abs(debits - credits))}.` })
      const body = {
        date: v.date,
        memo: v.memo,
        lines: kept.map((l) => ({ accountId: l.accountId, debit: amount(l.debit), credit: amount(l.credit), description: l.description })),
      }
      try {
        const id = await save.mutateAsync({ body, post })
        await navigate({ to: '/w/$workspaceId/finance/journal/$id', params: { workspaceId, id } })
      } catch (e) {
        form.setError('root', { message: (e as Error).message })
      }
    })

  const active = accounts.filter((a) => a.active)

  return (
    <div>
      <PageHeader title={existing ? 'Edit draft entry' : 'New journal entry'} description="For what invoices and bills don’t cover: opening balances, capital, depreciation, corrections." />
      <form noValidate onSubmit={submit(false)} className="space-y-6">
        <FormError message={errors.root?.message} />
        <Card>
          <CardContent className="grid gap-4 sm:grid-cols-[12rem_1fr]">
            <div className="grid gap-2">
              <Label htmlFor="j-date">Date</Label>
              <Input id="j-date" type="date" {...form.register('date')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="j-memo">Description</Label>
              <Input id="j-memo" aria-invalid={!!errors.memo} {...form.register('memo')} />
              {errors.memo && <p className="text-destructive text-sm">{errors.memo.message}</p>}
            </div>
          </CardContent>
        </Card>
        <div className="space-y-3">
          {lines.fields.map((field, i) => (
            <Card key={field.id} className="py-4">
              <CardContent className="grid gap-3 px-4 md:grid-cols-12">
                <div className="grid gap-1.5 md:col-span-4">
                  <Label htmlFor={`j${i}-account`} className="text-muted-foreground text-xs">
                    Account
                  </Label>
                  <NativeSelect id={`j${i}-account`} {...form.register(`lines.${i}.accountId`)}>
                    <option value="">Choose…</option>
                    {active.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="grid grid-cols-2 gap-3 md:col-span-4">
                  <div className="grid gap-1.5">
                    <Label htmlFor={`j${i}-debit`} className="text-muted-foreground text-xs">
                      Debit (₱)
                    </Label>
                    <Input id={`j${i}-debit`} inputMode="decimal" className="text-right" {...form.register(`lines.${i}.debit`)} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor={`j${i}-credit`} className="text-muted-foreground text-xs">
                      Credit (₱)
                    </Label>
                    <Input id={`j${i}-credit`} inputMode="decimal" className="text-right" {...form.register(`lines.${i}.credit`)} />
                  </div>
                </div>
                <div className="grid gap-1.5 md:col-span-3">
                  <Label htmlFor={`j${i}-desc`} className="text-muted-foreground text-xs">
                    Note
                  </Label>
                  <Input id={`j${i}-desc`} {...form.register(`lines.${i}.description`)} />
                </div>
                <div className="flex items-end justify-end md:col-span-1">
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} disabled={lines.fields.length <= 2} onClick={() => lines.remove(i)}>
                    <Trash2 />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
          <Button type="button" variant="outline" onClick={() => lines.append(blank)}>
            <Plus />
            Add a line
          </Button>
        </div>
        <Card className="py-4">
          <CardContent className="flex flex-wrap justify-end gap-x-8 gap-y-2 px-4 text-sm">
            <span>
              Debits <strong className="tabular-nums">{formatPeso(debits)}</strong>
            </span>
            <span>
              Credits <strong className="tabular-nums">{formatPeso(credits)}</strong>
            </span>
            <span className={cn(debits === credits ? 'text-success' : 'text-destructive')}>
              {debits === credits ? 'Balanced' : `Off by ${formatPeso(Math.abs(debits - credits))}`}
            </span>
          </CardContent>
        </Card>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="submit" variant="outline" disabled={isSubmitting}>
            Save draft
          </Button>
          <Button type="button" disabled={isSubmitting} onClick={submit(true)}>
            {isSubmitting ? 'Saving…' : 'Save and post'}
          </Button>
        </div>
      </form>
    </div>
  )
}

export function JournalViewPage({ id }: { id: string }) {
  const workspaceId = useWorkspaceId()
  const navigate = useNavigate()
  const entry = useQuery(financeQueries.entry(workspaceId, id))
  const [reversing, setReversing] = useState(false)
  const can = useCan()
  const [date, setDate] = useState(today())
  const action = useWorkspaceMutation((w, a: 'post' | 'delete') => api(`/w/${w}/journal/${id}${a === 'post' ? '/post' : ''}`, { method: a === 'post' ? 'POST' : 'DELETE' }))
  const reverse = useWorkspaceMutation((w, body: { date: string }) => api<{ entry: JournalEntry }>(`/w/${w}/journal/${id}/reverse`, { method: 'POST', body }))

  if (entry.error) return <LoadError error={entry.error} />
  if (!entry.data) return <Loading />
  const e = entry.data
  const debits = e.lines.reduce((s, l) => s + l.debit, 0)
  const credits = e.lines.reduce((s, l) => s + l.credit, 0)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-semibold tracking-tight">{e.number ?? 'Draft entry'}</h2>
            <Badge variant={e.status === 'posted' ? 'success' : 'outline'}>{e.status === 'posted' ? 'Posted' : 'Draft'}</Badge>
          </div>
          <p className="text-muted-foreground text-sm">
            {formatDate(e.date)} · {JOURNAL_SOURCE_LABELS[e.source]}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {e.status === 'draft' && can('finance.edit') && (
            <>
              <Button
                variant="ghost"
                onClick={() => action.mutateAsync('delete').then(() => navigate({ to: '/w/$workspaceId/finance/journal', params: { workspaceId } }), () => undefined)}
              >
                <Trash2 />
                Delete
              </Button>
              <Button variant="outline" asChild>
                <Link to="/w/$workspaceId/finance/journal/$id/edit" params={{ workspaceId, id }}>
                  Edit
                </Link>
              </Button>
            </>
          )}
          {e.status === 'draft' && can('finance.post') && (
            <Button onClick={() => action.mutate('post')} disabled={action.isPending}>
              <Send />
              Post
            </Button>
          )}
          {e.status === 'posted' && e.source === 'manual' && !e.reversedById && can('finance.post') && (
            <Button variant="outline" onClick={() => setReversing(true)}>
              <Undo2 />
              Reverse
            </Button>
          )}
        </div>
      </div>
      {action.error && (
        <Alert variant="destructive">
          <AlertDescription>{action.error.message}</AlertDescription>
        </Alert>
      )}
      <p>{e.memo}</p>
      {(e.reversesId || e.reversedById) && (
        <p className="text-muted-foreground text-sm">
          {e.reversesId && (
            <Link to="/w/$workspaceId/finance/journal/$id" params={{ workspaceId, id: e.reversesId }} className="underline">
              See the entry this reverses
            </Link>
          )}
          {e.reversedById && (
            <Link to="/w/$workspaceId/finance/journal/$id" params={{ workspaceId, id: e.reversedById }} className="underline">
              See the reversing entry
            </Link>
          )}
        </p>
      )}
      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Account</TableHead>
              <TableHead className="hidden sm:table-cell">Note</TableHead>
              <TableHead className="text-right">Debit</TableHead>
              <TableHead className="text-right">Credit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {e.lines.map((l) => (
              <TableRow key={l.id}>
                <TableCell className={cn('min-w-48', l.credit > 0 && 'pl-8')}>
                  <span className="text-muted-foreground tabular-nums">{l.account.code}</span> {l.account.name}
                </TableCell>
                <TableCell className="text-muted-foreground hidden sm:table-cell">{l.description}</TableCell>
                <TableCell className="text-right">{l.debit > 0 && <Money value={l.debit} />}</TableCell>
                <TableCell className="text-right">{l.credit > 0 && <Money value={l.credit} />}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={2} className="hidden sm:table-cell">
                Total
              </TableCell>
              <TableCell className="sm:hidden">Total</TableCell>
              <TableCell className="text-right">
                <Money value={debits} />
              </TableCell>
              <TableCell className="text-right">
                <Money value={credits} />
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>

      <Dialog open={reversing} onOpenChange={setReversing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reverse {e.number}?</DialogTitle>
            <DialogDescription>A new entry swaps every debit and credit. This one stays as it is, marked reversed.</DialogDescription>
          </DialogHeader>
          {reverse.error && (
            <Alert variant="destructive">
              <AlertDescription>{reverse.error.message}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="r-date">Date of the reversal</Label>
            <Input id="r-date" type="date" value={date} onChange={(ev) => setDate(ev.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReversing(false)}>
              Cancel
            </Button>
            <Button
              disabled={reverse.isPending}
              onClick={() =>
                reverse.mutateAsync({ date }).then(
                  ({ entry: r }) => {
                    setReversing(false)
                    return navigate({ to: '/w/$workspaceId/finance/journal/$id', params: { workspaceId, id: r.id } })
                  },
                  () => undefined,
                )
              }
            >
              Reverse
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
