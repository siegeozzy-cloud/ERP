import {
  templateByKey,
  JOIN_CODE_LIFETIMES,
  MODULE_SLUGS,
  PERMISSIONS,
  VAT_STATUS_LABELS,
  VAT_STATUSES,
  WorkspaceUpdate,
  type JoinCodeLifetime,
  type NewJoinCode,
  type Permission,
  type Role,
  type Workspace,
} from '@erp/shared'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { Copy, KeyRound, Lock, Plus, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Controller, useForm } from 'react-hook-form'
import type { z } from 'zod'
import { Field, FormError, showServerError } from '@/components/form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { MODULES } from '@/app/modules'
import { EmptyState, LoadError, Loading, PageHeader } from '@/features/finance/components'
import { useWorkspaceMutation } from '@/features/finance/queries'
import { AddressPicker } from '@/features/workspaces/AddressPicker'
import { settingsQueries, useCan, useWorkspace, workspaceQuery, workspacesQuery } from '@/features/workspaces/queries'
import { api } from '@/lib/api'
import { MONTH_NAMES } from '@/lib/dates'

/* =============================================================================================
 * Frame
 * =========================================================================================== */

const TABS: { to: string; label: string; permission?: Permission }[] = [
  { to: '/w/$workspaceId/settings', label: 'Workspace' },
  { to: '/w/$workspaceId/settings/members', label: 'Members', permission: 'members.view' },
  { to: '/w/$workspaceId/settings/join-codes', label: 'Join codes', permission: 'members.invite' },
  { to: '/w/$workspaceId/settings/roles', label: 'Roles', permission: 'members.view' },
  { to: '/w/$workspaceId/settings/audit', label: 'Audit log', permission: 'audit.view' },
  { to: '/w/$workspaceId/settings/import', label: 'Import' },
]

export function SettingsLayout() {
  const workspace = useWorkspace()
  const can = useCan()
  return (
    <>
      <nav aria-label="Settings" className="-mx-4 mb-6 overflow-x-auto border-b px-4 md:mx-0 md:px-0">
        <div className="flex min-w-max gap-1">
          {TABS.filter((t) => !t.permission || can(t.permission)).map((t) => (
            <Link
              key={t.to}
              to={t.to as '/w/$workspaceId/settings'}
              params={{ workspaceId: workspace.id }}
              activeOptions={{ exact: true }}
              className="text-muted-foreground hover:text-foreground -mb-px border-b-2 border-transparent px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors"
              activeProps={{ className: 'border-foreground! text-foreground!', 'aria-current': 'page' }}
            >
              {t.label}
            </Link>
          ))}
        </div>
      </nav>
      <Outlet />
    </>
  )
}

/** For a settings page the member's role doesn't open. The API refuses too; this just says so kindly. */
function NoAccess({ what }: { what: string }) {
  const { role } = useWorkspace()
  return (
    <EmptyState title={`Your role can’t see ${what}`}>
      You’re here as {role.name}. An owner or admin can change that.
    </EmptyState>
  )
}

/* =============================================================================================
 * Workspace details
 * =========================================================================================== */

export function WorkspaceSettingsPage() {
  const workspace = useWorkspace()
  const can = useCan()
  const queryClient = useQueryClient()
  const editable = can('workspace.manage')
  const form = useForm<z.input<typeof WorkspaceUpdate>, unknown, z.output<typeof WorkspaceUpdate>>({
    resolver: zodResolver(WorkspaceUpdate),
    defaultValues: {
      name: workspace.name,
      tin: workspace.tin,
      vatStatus: workspace.vatStatus,
      street: workspace.street,
      barangayCode: workspace.barangayCode,
      fiscalYearStartMonth: workspace.fiscalYearStartMonth,
      dpoName: workspace.dpoName ?? '',
      dpoEmail: workspace.dpoEmail ?? '',
      modules: workspace.modules,
      licences: workspace.licences ?? {},
    },
  })
  const licences = templateByKey(workspace.template)?.licences ?? []
  const { errors, isSubmitting, isDirty } = form.formState
  const [saved, setSaved] = useState(false)

  const onSubmit = form.handleSubmit(async (values) => {
    setSaved(false)
    try {
      const { workspace: updated } = await api<{ workspace: Workspace }>(`/w/${workspace.id}`, { method: 'PATCH', body: values })
      queryClient.setQueryData(workspaceQuery(workspace.id).queryKey, updated)
      await queryClient.invalidateQueries({ queryKey: workspacesQuery.queryKey })
      await queryClient.invalidateQueries({ queryKey: ['w', workspace.id, 'audit'] })
      form.reset(values)
      setSaved(true)
    } catch (e) {
      showServerError(form, e)
    }
  })

  return (
    <div className="space-y-6">
      <PageHeader title="Workspace" description={editable ? 'The business behind this workspace. Changes are recorded in the audit log.' : 'Only owners and admins can change these.'} />
      <form onSubmit={onSubmit} noValidate>
        <fieldset disabled={!editable} className="grid gap-6">
          <FormError message={errors.root?.message} />
          {licences.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Licences and permits</CardTitle>
                <CardDescription>What your industry needs on file. They print on your invoices, and the dashboard warns you 60 days before one expires.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-5 sm:grid-cols-2">
                {licences.flatMap((l) => [
                  <Field key={l.key} id={`lic-${l.key}`} label={l.label} hint={l.hint} error={(errors.licences as unknown as { message?: string })?.message}>
                    {l.options ? (
                      <NativeSelect id={`lic-${l.key}`} {...form.register(`licences.${l.key}`)}>
                        <option value="">—</option>
                        {l.options.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </NativeSelect>
                    ) : (
                      <Input id={`lic-${l.key}`} {...form.register(`licences.${l.key}`)} />
                    )}
                  </Field>,
                  ...(l.expires
                    ? [
                        <Field key={`${l.key}_expires`} id={`lic-${l.key}-exp`} label="Valid until">
                          <Input id={`lic-${l.key}-exp`} type="date" {...form.register(`licences.${l.key}_expires`)} />
                        </Field>,
                      ]
                    : []),
                ])}
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>Business</CardTitle>
              <CardDescription>Printed on invoices and BIR forms.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              <Field id="name" label="Registered business name" error={errors.name?.message}>
                <Input id="name" {...form.register('name')} />
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field id="tin" label="TIN" error={errors.tin?.message}>
                  <Input id="tin" inputMode="numeric" {...form.register('tin')} />
                </Field>
                <Field id="vatStatus" label="Tax type" error={errors.vatStatus?.message}>
                  <NativeSelect id="vatStatus" {...form.register('vatStatus')}>
                    {VAT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {VAT_STATUS_LABELS[s]}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              </div>
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
                      form.setValue('barangayCode', v.barangayCode, { shouldDirty: true })
                    }}
                  />
                )}
              />
              <p className="text-muted-foreground -mt-2 text-sm">Prints as: {workspace.registeredAddress}</p>
              <Field id="fiscalYearStartMonth" label="Fiscal year starts in">
                <NativeSelect id="fiscalYearStartMonth" {...form.register('fiscalYearStartMonth')}>
                  {MONTH_NAMES.map((m, i) => (
                    <option key={m} value={i + 1}>
                      {m}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Modules</CardTitle>
              <CardDescription>Which parts of the ERP this business uses. Finance is always on.</CardDescription>
            </CardHeader>
            <CardContent>
              <Controller
                control={form.control}
                name="modules"
                render={({ field }) => (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {MODULE_SLUGS.map((slug) => {
                      const m = MODULES.find((x) => x.slug === slug)!
                      const on = field.value.includes(slug)
                      return (
                        <div key={slug} className="flex items-center gap-2">
                          <Checkbox
                            id={`mod-${slug}`}
                            checked={on}
                            disabled={slug === 'finance'}
                            onCheckedChange={(v) => field.onChange(v === true ? [...field.value, slug] : field.value.filter((s) => s !== slug))}
                          />
                          <Label htmlFor={`mod-${slug}`} className="font-normal">
                            {m.label}
                            {!m.ready && <span className="text-muted-foreground text-xs">(Phase {m.phase})</span>}
                          </Label>
                        </div>
                      )
                    })}
                  </div>
                )}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Data privacy</CardTitle>
              <CardDescription>Under the Data Privacy Act (RA 10173), name the person who answers for the personal data this business keeps.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5 sm:grid-cols-2">
              <Field id="dpoName" label="Data protection officer" error={errors.dpoName?.message}>
                <Input id="dpoName" {...form.register('dpoName')} />
              </Field>
              <Field id="dpoEmail" label="Their email" error={errors.dpoEmail?.message}>
                <Input id="dpoEmail" type="email" {...form.register('dpoEmail')} />
              </Field>
            </CardContent>
          </Card>

          {editable && (
            <div className="flex items-center justify-end gap-3">
              {saved && !isDirty && <span className="text-success text-sm">Saved</span>}
              <Button type="submit" disabled={isSubmitting || !isDirty}>
                {isSubmitting ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          )}
        </fieldset>
      </form>
    </div>
  )
}

/* =============================================================================================
 * Members
 * =========================================================================================== */

export function MembersPage() {
  const workspace = useWorkspace()
  const can = useCan()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const members = useQuery(settingsQueries.members(workspace.id))
  const roles = useQuery(settingsQueries.roles(workspace.id))
  const [removing, setRemoving] = useState<{ userId: string; name: string; self: boolean } | null>(null)
  const changeRole = useWorkspaceMutation((w, { userId, roleId }: { userId: string; roleId: string }) => api(`/w/${w}/members/${userId}`, { method: 'PATCH', body: { roleId } }))
  const remove = useWorkspaceMutation((w, userId: string) => api(`/w/${w}/members/${userId}`, { method: 'DELETE' }))
  const isOwner = workspace.role.key === 'owner'

  if (!can('members.view')) return <NoAccess what="the members" />
  if (members.error) return <LoadError error={members.error} />
  if (!members.data || !roles.data) return <Loading />

  async function confirmRemove() {
    if (!removing) return
    await remove.mutateAsync(removing.userId)
    setRemoving(null)
    if (removing.self) {
      await queryClient.invalidateQueries({ queryKey: workspacesQuery.queryKey })
      await navigate({ to: '/' })
    }
  }

  return (
    <div>
      <PageHeader
        title="Members"
        description="Everyone in this workspace and what their role lets them do."
        actions={
          can('members.invite') ? (
            <Button asChild>
              <Link to="/w/$workspaceId/settings/join-codes" params={{ workspaceId: workspace.id }}>
                <KeyRound />
                Invite with a code
              </Link>
            </Button>
          ) : undefined
        }
      />
      {changeRole.error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{changeRole.error.message}</AlertDescription>
        </Alert>
      )}
      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="hidden sm:table-cell">Joined</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.data.map((m) => {
              // only an owner may change an owner, or make one
              const mayChange = can('members.manage') && (isOwner || m.role.key !== 'owner')
              return (
                <TableRow key={m.userId}>
                  <TableCell className="min-w-48">
                    <span className="font-medium">{m.name}</span>
                    {m.isYou && <span className="text-muted-foreground"> (you)</span>}
                    <span className="text-muted-foreground block text-xs">{m.email}</span>
                  </TableCell>
                  <TableCell className="min-w-40">
                    {mayChange ? (
                      <NativeSelect
                        aria-label={`Role for ${m.name}`}
                        value={m.role.id}
                        disabled={changeRole.isPending}
                        onChange={(e) => changeRole.mutate({ userId: m.userId, roleId: e.target.value })}
                      >
                        {roles.data
                          .filter((r) => isOwner || r.key !== 'owner')
                          .map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                      </NativeSelect>
                    ) : (
                      m.role.name
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden whitespace-nowrap sm:table-cell">{new Date(m.joinedAt).toLocaleDateString('en-PH', { dateStyle: 'medium' })}</TableCell>
                  <TableCell className="text-right">
                    {m.isYou ? (
                      <Button variant="ghost" size="sm" onClick={() => setRemoving({ userId: m.userId, name: m.name, self: true })}>
                        Leave
                      </Button>
                    ) : (
                      mayChange && (
                        <Button variant="ghost" size="sm" onClick={() => setRemoving({ userId: m.userId, name: m.name, self: false })}>
                          Remove
                        </Button>
                      )
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <Dialog open={removing !== null} onOpenChange={(o) => !o && (setRemoving(null), remove.reset())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{removing?.self ? `Leave ${workspace.name}?` : `Remove ${removing?.name}?`}</DialogTitle>
            <DialogDescription>
              {removing?.self ? 'You’ll need a new join code to come back.' : 'They lose access straight away. Their past work stays in the books and the audit log.'}
            </DialogDescription>
          </DialogHeader>
          {remove.error && (
            <Alert variant="destructive">
              <AlertDescription>{remove.error.message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => void confirmRemove().catch(() => undefined)}>
              {removing?.self ? 'Leave' : 'Remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* =============================================================================================
 * Join codes
 * =========================================================================================== */

const CODE_STATUS: Record<string, { label: string; variant: 'success' | 'secondary' | 'outline' }> = {
  active: { label: 'Active', variant: 'success' },
  used: { label: 'Used', variant: 'secondary' },
  expired: { label: 'Expired', variant: 'outline' },
  revoked: { label: 'Revoked', variant: 'outline' },
}

const when = (iso: string) => new Date(iso).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })

export function JoinCodesPage() {
  const workspace = useWorkspace()
  const can = useCan()
  const codes = useQuery({ ...settingsQueries.joinCodes(workspace.id), enabled: can('members.invite') })
  const roles = useQuery(settingsQueries.roles(workspace.id))
  const [roleId, setRoleId] = useState('')
  const [expiresIn, setExpiresIn] = useState<JoinCodeLifetime>('24h')
  const [created, setCreated] = useState<NewJoinCode | null>(null)
  const [copied, setCopied] = useState(false)
  const create = useWorkspaceMutation((w, body: { roleId: string; expiresIn: JoinCodeLifetime }) => api<{ code: NewJoinCode }>(`/w/${w}/join-codes`, { method: 'POST', body }))
  const revoke = useWorkspaceMutation((w, id: string) => api(`/w/${w}/join-codes/${id}/revoke`, { method: 'POST' }))

  if (!can('members.invite')) return <NoAccess what="join codes" />
  if (codes.error) return <LoadError error={codes.error} />
  if (!codes.data || !roles.data) return <Loading />

  const offered = roles.data.filter((r) => workspace.role.key === 'owner' || r.key !== 'owner')
  const chosenRole = roleId || offered.find((r) => r.name === 'Viewer')?.id || offered.at(-1)?.id || ''

  async function make() {
    const { code } = await create.mutateAsync({ roleId: chosenRole, expiresIn })
    setCopied(false)
    setCreated(code)
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Join codes" description="A code lets one person join with the role you pick. It works once, then it’s used up." />
      <Card>
        <CardHeader>
          <CardTitle>Make a code</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="code-role" className="text-muted-foreground text-xs">
              They’ll join as
            </Label>
            <NativeSelect id="code-role" className="w-48" value={chosenRole} onChange={(e) => setRoleId(e.target.value)}>
              {offered.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="code-life" className="text-muted-foreground text-xs">
              Works
            </Label>
            <NativeSelect id="code-life" className="w-40" value={expiresIn} onChange={(e) => setExpiresIn(e.target.value as JoinCodeLifetime)}>
              {Object.entries(JOIN_CODE_LIFETIMES).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button onClick={() => void make().catch(() => undefined)} disabled={create.isPending || !chosenRole}>
            <Plus />
            Make code
          </Button>
          {create.error && <p className="text-destructive w-full text-sm">{create.error.message}</p>}
        </CardContent>
      </Card>

      {codes.data.length === 0 ? (
        <EmptyState title="No codes yet" />
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Made</TableHead>
                <TableHead>Expires / used</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {codes.data.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.role.name}</TableCell>
                  <TableCell>
                    <Badge variant={CODE_STATUS[c.status]!.variant}>{CODE_STATUS[c.status]!.label}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden md:table-cell">
                    {when(c.createdAt)}
                    {c.createdBy && ` by ${c.createdBy}`}
                  </TableCell>
                  <TableCell className="text-muted-foreground min-w-40">{c.status === 'used' ? `Used by ${c.usedBy ?? 'someone'} · ${when(c.usedAt!)}` : when(c.expiresAt)}</TableCell>
                  <TableCell className="text-right">
                    {c.status === 'active' && (
                      <Button variant="ghost" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate(c.id)}>
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={created !== null} onOpenChange={(o) => !o && setCreated(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Here’s the code</DialogTitle>
            <DialogDescription>
              Give it to the person joining as {created?.role.name}. It works once, until {created && when(created.expiresAt)}. Copy it now: it won’t be shown again.
            </DialogDescription>
          </DialogHeader>
          <p className="bg-muted rounded-lg py-5 text-center font-mono text-3xl font-semibold tracking-[0.2em]">{created?.code}</p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(created?.code ?? '').then(() => setCopied(true))
              }}
            >
              <Copy />
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button onClick={() => setCreated(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* =============================================================================================
 * Roles
 * =========================================================================================== */

const GROUPS = [...new Set(Object.values(PERMISSIONS).map((p) => p.group))]

export function RolesPage() {
  const workspace = useWorkspace()
  const can = useCan()
  const roles = useQuery(settingsQueries.roles(workspace.id))
  const [editing, setEditing] = useState<Role | 'new' | null>(null)
  const del = useWorkspaceMutation((w, id: string) => api(`/w/${w}/roles/${id}`, { method: 'DELETE' }))

  if (!can('members.view')) return <NoAccess what="the roles" />
  if (roles.error) return <LoadError error={roles.error} />
  if (!roles.data) return <Loading />
  const manage = can('roles.manage')

  return (
    <div>
      <PageHeader
        title="Roles"
        description="A role is a set of permissions. Every member has one."
        actions={
          manage ? (
            <Button onClick={() => setEditing('new')}>
              <Plus />
              New role
            </Button>
          ) : undefined
        }
      />
      {del.error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{del.error.message}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {roles.data.map((r) => (
          <Card key={r.id} className="gap-3">
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                  {r.name}
                  {r.key === 'owner' && <Lock className="text-muted-foreground size-3.5" aria-label="Fixed" />}
                </CardTitle>
                <Badge variant="secondary">
                  {r.memberCount} member{r.memberCount === 1 ? '' : 's'}
                </Badge>
              </div>
              {r.description && <CardDescription>{r.description}</CardDescription>}
            </CardHeader>
            <CardContent className="space-y-3">
              <ul className="text-muted-foreground grid gap-1 text-sm">
                {r.permissions.length === 0 && <li>No permissions</li>}
                {r.permissions.map((p) => (
                  <li key={p}>· {PERMISSIONS[p]?.label ?? p}</li>
                ))}
              </ul>
              {manage && r.key !== 'owner' && (
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEditing(r)}>
                    Edit
                  </Button>
                  {!r.key && (
                    <Button variant="ghost" size="sm" disabled={del.isPending} onClick={() => del.mutate(r.id)}>
                      <Trash2 />
                      Delete
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-xl">{editing !== null && <RoleForm role={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} />}</DialogContent>
      </Dialog>
    </div>
  )
}

function RoleForm({ role, onDone }: { role?: Role; onDone: () => void }) {
  const [name, setName] = useState(role?.name ?? '')
  const [description, setDescription] = useState(role?.description ?? '')
  const [permissions, setPermissions] = useState<Permission[]>(role?.permissions ?? ['finance.view'])
  const save = useWorkspaceMutation((w, body: object) => (role ? api(`/w/${w}/roles/${role.id}`, { method: 'PUT', body }) : api(`/w/${w}/roles`, { method: 'POST', body })))
  const toggle = (p: Permission, on: boolean) => setPermissions((list) => (on ? [...list, p] : list.filter((x) => x !== p)))

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutateAsync({ name, description, permissions }).then(onDone, () => undefined)
      }}
    >
      <DialogHeader>
        <DialogTitle>{role ? `Edit ${role.name}` : 'New role'}</DialogTitle>
        <DialogDescription>Members with this role can do exactly what’s ticked.</DialogDescription>
      </DialogHeader>
      {save.error && (
        <Alert variant="destructive">
          <AlertDescription>{save.error.message}</AlertDescription>
        </Alert>
      )}
      <Field id="r-name" label="Name">
        <Input id="r-name" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field id="r-desc" label="Description">
        <Input id="r-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      {GROUPS.map((group) => (
        <fieldset key={group} className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">{group}</legend>
          {(Object.entries(PERMISSIONS) as [Permission, (typeof PERMISSIONS)[Permission]][])
            .filter(([, p]) => p.group === group)
            .map(([key, p]) => (
              <div key={key} className="flex items-start gap-2">
                <Checkbox id={`p-${key}`} className="mt-0.5" checked={permissions.includes(key)} onCheckedChange={(v) => toggle(key, v === true)} />
                <Label htmlFor={`p-${key}`} className="leading-snug font-normal">
                  {p.label}
                </Label>
              </div>
            ))}
        </fieldset>
      ))}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save role'}
        </Button>
      </DialogFooter>
    </form>
  )
}

/* =============================================================================================
 * Audit log
 * =========================================================================================== */

const ENTITIES: [string, string][] = [
  ['', 'Everything'],
  ['workspace', 'Workspace'],
  ['member', 'Members'],
  ['role', 'Roles'],
  ['join_code', 'Join codes'],
  ['invoice', 'Invoices'],
  ['bill', 'Bills'],
  ['payment', 'Payments'],
  ['journal_entry', 'Journal'],
  ['account', 'Accounts'],
  ['contact', 'Contacts'],
]

function Changes({ before, after }: { before: unknown; after: unknown }) {
  if (!before && !after) return null
  const b = (before ?? {}) as Record<string, unknown>
  const a = (after ?? {}) as Record<string, unknown>
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])]
  const show = (v: unknown): ReactNode => (v === null || v === undefined || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : String(v))
  return (
    <details className="mt-1">
      <summary className="text-muted-foreground cursor-pointer text-xs">What changed</summary>
      <dl className="mt-1 grid gap-1 text-xs">
        {keys.map((k) => (
          <div key={k} className="grid gap-0.5">
            <dt className="text-muted-foreground">{k}</dt>
            <dd>
              <span className="line-through opacity-60">{show(b[k])}</span> → {show(a[k])}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

export function AuditLogPage() {
  const workspace = useWorkspace()
  const can = useCan()
  const [entity, setEntity] = useState('')
  const entries = useQuery({ ...settingsQueries.audit(workspace.id, entity || undefined), enabled: can('audit.view') })

  if (!can('audit.view')) return <NoAccess what="the audit log" />

  return (
    <div>
      <PageHeader
        title="Audit log"
        description="Every change, who made it and when. Nobody can edit or delete these entries, not even an owner."
        actions={
          <NativeSelect aria-label="Show" className="w-44" value={entity} onChange={(e) => setEntity(e.target.value)}>
            {ENTITIES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </NativeSelect>
        }
      />
      {entries.error ? (
        <LoadError error={entries.error} />
      ) : !entries.data ? (
        <Loading />
      ) : entries.data.length === 0 ? (
        <EmptyState title="Nothing recorded yet" />
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>What</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.data.map((e) => (
                <TableRow key={e.id} className="align-top">
                  <TableCell className="text-muted-foreground whitespace-nowrap">{when(e.at)}</TableCell>
                  <TableCell className="whitespace-nowrap">{e.actor?.name ?? 'Someone who has left'}</TableCell>
                  <TableCell className="min-w-64">
                    {e.summary}
                    <Changes before={e.before} after={e.after} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {entries.data.length === 100 && <p className="text-muted-foreground p-3 text-center text-xs">Showing the latest 100.</p>}
        </div>
      )}
    </div>
  )
}
