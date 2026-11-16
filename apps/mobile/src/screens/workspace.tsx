import { formatPeso, JoinInput, type FinanceOverview, type InvoiceSummary, type Workspace, type WorkspaceSummary } from '@erp/shared'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { RefreshControl, Text, View } from 'react-native'
import { api, ApiError } from '../lib/api'
import { enablePush, pushStatus, type PushStatus } from '../lib/push'
import { useSession } from '../lib/session'
import { Body, Button, Card, ErrorBox, Field, Loading, Screen, Stat, Title, useColors } from '../ui/components'
import { HrShortcuts } from './hr'

export type SignedInStack = {
  Workspaces: undefined
  Join: undefined
  Home: undefined
  Account: undefined
  Stock: undefined
  Clock: undefined
  Leave: undefined
  Payslips: undefined
  Payslip: { id: string }
  Approvals: undefined
  Tasks: undefined
  Task: { id: string }
}
type Props<K extends keyof SignedInStack> = NativeStackScreenProps<SignedInStack, K>

const workspacesQuery = { queryKey: ['workspaces'], queryFn: async () => (await api<{ workspaces: WorkspaceSummary[] }>('/workspaces')).workspaces }

/** The workspace switcher: every workspace this person is in, and the way to join another. */
export function WorkspacesScreen({ navigation }: Props<'Workspaces'>) {
  const { chooseWorkspace, state } = useSession()
  const q = useQuery(workspacesQuery)
  const current = state.status === 'signed-in' ? state.workspaceId : null

  return (
    <Screen refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />}>
      <Title sub="Each workspace is one business. Pick the one to work in.">Your workspaces</Title>
      <ErrorBox message={q.error?.message} />
      {q.isPending ? (
        <Loading />
      ) : q.data?.length === 0 ? (
        <Card>
          <Body>You’re not in a workspace yet.</Body>
          <Body muted>Join your company’s with the code someone gave you. To set up a new business, use the web app.</Body>
        </Card>
      ) : (
        q.data?.map((w) => (
          <Card
            key={w.id}
            onPress={() => {
              void chooseWorkspace(w.id).then(() => navigation.navigate('Home'))
            }}
          >
            <Body style={{ fontWeight: '600' }}>{w.name}</Body>
            <Body muted>
              {w.roleName}
              {w.id === current ? ' · open now' : ''}
            </Body>
          </Card>
        ))
      )}
      <Button title="Join with a code" variant="outline" onPress={() => navigation.navigate('Join')} />
    </Screen>
  )
}

export function JoinScreen({ navigation }: Props<'Join'>) {
  const { chooseWorkspace } = useSession()
  const queryClient = useQueryClient()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  async function submit() {
    const r = JoinInput.safeParse({ code })
    if (!r.success) return setError(r.error.issues[0]?.message)
    setBusy(true)
    setError(undefined)
    try {
      const { workspace } = await api<{ workspace: Workspace }>('/workspaces/join', { method: 'POST', body: r.data })
      await queryClient.invalidateQueries({ queryKey: ['workspaces'] })
      await chooseWorkspace(workspace.id)
      navigation.navigate('Home')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <Title sub="Enter the code an owner or admin gave you. Each code works once, for one person.">Join a workspace</Title>
      <Field
        label="Join code"
        value={code}
        onChangeText={(v) => setCode(v.toUpperCase())}
        error={error}
        placeholder="7K3Q-9XPA"
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        maxLength={11}
        style={{ fontSize: 24, letterSpacing: 4, textAlign: 'center', fontVariant: ['tabular-nums'] }}
        onSubmitEditing={() => void submit()}
      />
      <Button title="Join" onPress={() => void submit()} busy={busy} />
    </Screen>
  )
}

function statusOf(inv: InvoiceSummary, today: string) {
  if (inv.status === 'draft') return 'Draft'
  if (inv.status === 'void') return 'Void'
  if (inv.balance === 0) return 'Paid'
  return inv.dueDate && inv.dueDate < today ? 'Overdue' : 'Unpaid'
}

/** The workspace at a glance: the money, and the latest invoices. */
export function HomeScreen({ navigation }: Props<'Home'>) {
  const c = useColors()
  const { state, chooseWorkspace } = useSession()
  const id = state.status === 'signed-in' ? state.workspaceId : null
  const ws = useQuery({ queryKey: ['w', id, 'workspace'], queryFn: async () => (await api<{ workspace: Workspace }>(`/w/${id}`)).workspace, enabled: !!id })
  const canFinance = ws.data?.permissions.includes('finance.view') ?? false
  const overview = useQuery({ queryKey: ['w', id, 'overview'], queryFn: async () => (await api<{ overview: FinanceOverview }>(`/w/${id}/reports/overview`)).overview, enabled: !!id && canFinance })
  const invoices = useQuery({ queryKey: ['w', id, 'invoices'], queryFn: async () => (await api<{ invoices: InvoiceSummary[] }>(`/w/${id}/invoices`)).invoices, enabled: !!id && canFinance })

  // the remembered workspace is gone (left, or removed): back to the list
  useEffect(() => {
    if (!id || (ws.error instanceof ApiError && ws.error.status === 404)) {
      void chooseWorkspace(null).then(() => navigation.replace('Workspaces'))
    }
  }, [id, ws.error, chooseWorkspace, navigation])

  const refreshing = ws.isRefetching || overview.isRefetching || invoices.isRefetching
  const refresh = () => void Promise.all([ws.refetch(), overview.refetch(), invoices.refetch()])
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())

  if (ws.isPending) return <Loading />
  if (!ws.data) return <Screen><ErrorBox message={ws.error?.message} /></Screen>

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <HrShortcuts workspace={ws.data} navigate={(screen) => navigation.navigate(screen)} />
      <Title sub={`You’re ${/^[aeiou]/i.test(ws.data.role.name) ? 'an' : 'a'} ${ws.data.role.name} · TIN ${ws.data.tin}`}>{ws.data.name}</Title>

      {canFinance ? (
        <>
          <ErrorBox message={overview.error?.message} />
          {overview.data && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              <Stat label="Cash and bank" value={formatPeso(overview.data.cash)} />
              <Stat label="Customers owe you" value={formatPeso(overview.data.receivables)} />
              <Stat label="You owe suppliers" value={formatPeso(overview.data.payables)} />
              <Stat label="Profit this month" value={formatPeso(overview.data.monthToDate.income - overview.data.monthToDate.expenses)} />
            </View>
          )}
          <Text style={{ color: c.fg, fontSize: 18, fontWeight: '600', marginTop: 8 }}>Latest invoices</Text>
          {invoices.data?.length === 0 && <Body muted>No invoices yet.</Body>}
          {invoices.data?.slice(0, 8).map((inv) => (
            <Card key={inv.id}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
                <Body style={{ fontWeight: '600', flexShrink: 1 }}>{inv.customer.name}</Body>
                <Body style={{ fontVariant: ['tabular-nums'] }}>{formatPeso(inv.total)}</Body>
              </View>
              <Body muted>
                {[inv.number, statusOf(inv, today)].filter(Boolean).join(' · ')}
                {inv.status === 'posted' && inv.balance > 0 ? ` · ${formatPeso(inv.balance)} owed` : ''}
              </Body>
            </Card>
          ))}
        </>
      ) : (
        <Card>
          <Body>Your role doesn’t include Finance.</Body>
          <Body muted>An owner or admin can change that.</Body>
        </Card>
      )}

      {ws.data.modules.includes('projects') && <Button title="My tasks" onPress={() => navigation.navigate('Tasks')} />}
      {ws.data.modules.includes('inventory') && ws.data.permissions.includes('inventory.view') && (
        <Button title="Scan stock" onPress={() => navigation.navigate('Stock')} />
      )}
      <Card>
        <Body style={{ fontWeight: '600' }}>Coming to the phone</Body>
        <Body muted>Field work orders (Phase 7). Invoices, bills and payroll are run on the web.</Body>
      </Card>
      <Button title="Switch workspace" variant="outline" onPress={() => navigation.navigate('Workspaces')} />
    </Screen>
  )
}

const PUSH_TEXT: Record<PushStatus, string> = {
  on: 'On. You’ll be told when someone joins a workspace you manage, or your role changes.',
  denied: 'Off. Turn them on to hear when someone joins, or your role changes.',
  unsupported: 'Notifications need a real phone. Simulators and the web preview can’t receive them.',
  'needs-project': 'This build isn’t linked to an Expo project yet, so it can’t receive notifications. Run “npx eas init” in apps/mobile, then make a development build.',
}

export function AccountScreen() {
  const { state, signOut } = useSession()
  const [push, setPush] = useState<PushStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void pushStatus().then(setPush)
  }, [])

  if (state.status !== 'signed-in') return null
  const { user } = state.session
  return (
    <Screen>
      <Title sub={user.email}>{user.name}</Title>
      <Card>
        <Body style={{ fontWeight: '600' }}>Notifications</Body>
        <Body muted>{push ? PUSH_TEXT[push] : '…'}</Body>
        {push === 'denied' && (
          <Button
            title="Turn on notifications"
            variant="outline"
            busy={busy}
            onPress={() => {
              setBusy(true)
              setError(null)
              enablePush()
                .then(setPush)
                .catch((e: Error) => setError(e.message))
                .finally(() => setBusy(false))
            }}
          />
        )}
      </Card>
      <ErrorBox message={error} />
      <Button title="Sign out" variant="outline" onPress={() => void signOut()} />
    </Screen>
  )
}
