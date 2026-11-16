import { formatPeso, LEAVE_STATUS_LABELS, type LeaveRequest, type LeaveType, type MyHr, type PayLine, type Payslip, type Workspace } from '@erp/shared'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as Location from 'expo-location'
import { useState } from 'react'
import { Pressable, RefreshControl, Text, View } from 'react-native'
import { api } from '../lib/api'
import { useSession } from '../lib/session'
import { Body, Button, Card, ErrorBox, Field, Loading, Screen, Title, useColors } from '../ui/components'
import type { SignedInStack } from './workspace'

/**
 * HR on the phone (Phase 5): clocking in and out with where you are, leave, payslips, and for
 * managers, deciding leave. What happens here is the same as on the web; the API applies the rules.
 */

type Props<K extends keyof SignedInStack> = NativeStackScreenProps<SignedInStack, K>

function useWorkspaceId() {
  const { state } = useSession()
  return state.status === 'signed-in' ? state.workspaceId : null
}

const timeOf = (iso: string) => new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
const dateOf = (d: string) => new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`))
const todayManila = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())

export const meQuery = (id: string | null) => ({ queryKey: ['w', id, 'me-hr'], queryFn: async () => (await api<{ me: MyHr }>(`/w/${id}/me/hr`)).me, enabled: !!id })

/** Asks for the phone's location. Clocking in still works when it's refused or unavailable. */
export async function here() {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync()
    if (status !== 'granted') return null
    const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })
    return { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy ?? null }
  } catch {
    return null
  }
}

export function ClockScreen({ navigation }: Props<'Clock'>) {
  const c = useColors()
  const id = useWorkspaceId()
  const queryClient = useQueryClient()
  const q = useQuery(meQuery(id))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  async function punch(action: 'in' | 'out') {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const at = await here()
      await api(`/w/${id}/me/clock`, { method: 'POST', body: { action, source: 'phone', ...at } })
      if (!at) setNote('Saved without your location (it wasn’t allowed or couldn’t be found).')
      await queryClient.invalidateQueries({ queryKey: ['w', id] })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (q.isPending) return <Loading />
  const me = q.data
  if (!me?.employee) {
    return (
      <Screen>
        <ErrorBox message={q.error?.message} />
        <Card>
          <Body>You aren’t on this workspace’s employee list.</Body>
          <Body muted>Ask HR to link your account to your employee record.</Body>
        </Card>
      </Screen>
    )
  }
  const open = me.openEntry
  return (
    <Screen refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />}>
      <Title sub={`${me.employee.position} · shift starts ${me.employee.shiftStart}`}>{me.employee.name}</Title>
      <View style={{ alignItems: 'center', gap: 6, paddingVertical: 16 }}>
        <Text style={{ color: c.muted, fontSize: 15 }}>{open ? 'Clocked in since' : 'Not clocked in'}</Text>
        {open && <Text style={{ color: c.fg, fontSize: 40, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{timeOf(open.clockIn)}</Text>}
      </View>
      <ErrorBox message={error} />
      {note && <Body muted>{note}</Body>}
      <Button title={open ? 'Clock out' : 'Clock in'} variant={open ? 'outline' : 'primary'} busy={busy} onPress={() => void punch(open ? 'out' : 'in')} />
      <Body muted>Your location is saved with each clock-in and clock-out, so HR can see you were at work.</Body>
      {me.today.length > 0 && (
        <Card>
          <Body style={{ fontWeight: '600' }}>Today</Body>
          {me.today.map((t) => (
            <Body key={t.id} style={{ fontVariant: ['tabular-nums'] }}>
              {timeOf(t.clockIn)} – {t.clockOut ? timeOf(t.clockOut) : 'now'}
            </Body>
          ))}
        </Card>
      )}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Button title="Leave" variant="outline" onPress={() => navigation.navigate('Leave')} />
        </View>
        <View style={{ flex: 1 }}>
          <Button title="Payslips" variant="outline" onPress={() => navigation.navigate('Payslips')} />
        </View>
      </View>
    </Screen>
  )
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

export function LeaveScreen() {
  const c = useColors()
  const id = useWorkspaceId()
  const queryClient = useQueryClient()
  const q = useQuery(meQuery(id))
  const types = useQuery({ queryKey: ['w', id, 'my-leave-types'], queryFn: async () => (await api<{ leaveTypes: LeaveType[] }>(`/w/${id}/me/leave-types`)).leaveTypes, enabled: !!id })
  const [asking, setAsking] = useState(false)
  const [typeId, setTypeId] = useState<string | null>(null)
  const [from, setFrom] = useState(todayManila())
  const [to, setTo] = useState(todayManila())
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setError(null)
    if (!typeId) return setError('Choose the kind of leave.')
    if (!DATE.test(from) || !DATE.test(to)) return setError('Enter dates like 2026-11-20.')
    setBusy(true)
    try {
      await api(`/w/${id}/me/leave`, { method: 'POST', body: { leaveTypeId: typeId, startDate: from, endDate: to, reason } })
      setAsking(false)
      setReason('')
      await queryClient.invalidateQueries({ queryKey: ['w', id] })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function withdraw(r: LeaveRequest) {
    try {
      await api(`/w/${id}/me/leave/${r.id}/cancel`, { method: 'POST' })
      await queryClient.invalidateQueries({ queryKey: ['w', id] })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (q.isPending) return <Loading />
  const me = q.data
  return (
    <Screen refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />}>
      <Title sub="This year. Rest days and holidays aren’t counted.">Leave</Title>
      <ErrorBox message={error ?? q.error?.message} />
      {me?.leave.map((b) => (
        <View key={b.leaveType.id} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
          <Body>{b.leaveType.name}</Body>
          <Body muted>{b.left === null ? `${b.used} used` : `${b.left} of ${b.entitled} left`}</Body>
        </View>
      ))}
      {!asking ? (
        <Button title="Ask for leave" onPress={() => setAsking(true)} />
      ) : (
        <Card>
          <Body style={{ fontWeight: '600' }}>Kind of leave</Body>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {types.data
              ?.filter((t) => t.active)
              .map((t) => (
                <Pressable
                  key={t.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: typeId === t.id }}
                  onPress={() => setTypeId(t.id)}
                  style={{ borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, borderColor: typeId === t.id ? c.primary : c.border, backgroundColor: typeId === t.id ? c.primary : 'transparent' }}
                >
                  <Text style={{ color: typeId === t.id ? c.primaryFg : c.fg }}>{t.name}</Text>
                </Pressable>
              ))}
          </View>
          <Field label="First day" value={from} onChangeText={setFrom} placeholder="2026-11-20" autoCapitalize="none" />
          <Field label="Last day" value={to} onChangeText={setTo} placeholder="2026-11-20" autoCapitalize="none" />
          <Field label="Reason" value={reason} onChangeText={setReason} />
          <Button title="Send request" busy={busy} onPress={() => void submit()} />
          <Button title="Cancel" variant="ghost" onPress={() => setAsking(false)} />
        </Card>
      )}
      {me?.requests.map((r) => (
        <Card key={r.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
            <Body style={{ fontWeight: '600', flexShrink: 1 }}>{r.leaveType.name}</Body>
            <Body muted>{LEAVE_STATUS_LABELS[r.status]}</Body>
          </View>
          <Body muted>
            {dateOf(r.startDate)}
            {r.endDate !== r.startDate ? ` to ${dateOf(r.endDate)}` : ''} · {r.days} day(s)
          </Body>
          {r.decisionNote && <Body muted>{r.decisionNote}</Body>}
          {r.status === 'pending' && <Button title="Withdraw" variant="ghost" onPress={() => void withdraw(r)} />}
        </Card>
      ))}
    </Screen>
  )
}

export function PayslipsScreen({ navigation }: Props<'Payslips'>) {
  const id = useWorkspaceId()
  const q = useQuery(meQuery(id))
  if (q.isPending) return <Loading />
  return (
    <Screen refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />}>
      <Title>Payslips</Title>
      <ErrorBox message={q.error?.message} />
      {q.data?.payslips.length === 0 && <Body muted>None yet. They appear here when payroll is posted.</Body>}
      {q.data?.payslips.map((p) => (
        <Card key={p.id} onPress={() => navigation.navigate('Payslip', { id: p.id })}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
            <Body style={{ fontWeight: '600', flexShrink: 1 }}>{p.kind === 'thirteenth' ? `13th month ${p.periodEnd.slice(0, 4)}` : `${dateOf(p.periodStart)} – ${dateOf(p.periodEnd)}`}</Body>
            <Body style={{ fontVariant: ['tabular-nums'] }}>{formatPeso(p.net)}</Body>
          </View>
          <Body muted>Paid {dateOf(p.payDate)}</Body>
        </Card>
      ))}
    </Screen>
  )
}

function Lines({ title, lines }: { title: string; lines: PayLine[] }) {
  return (
    <Card>
      <Body style={{ fontWeight: '600' }}>{title}</Body>
      {lines.map((l, i) => (
        <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
          <View style={{ flexShrink: 1 }}>
            <Body>{l.label}</Body>
            {l.detail ? <Body muted style={{ fontSize: 13 }}>{l.detail}</Body> : null}
          </View>
          <Body style={{ fontVariant: ['tabular-nums'] }}>{formatPeso(l.amount)}</Body>
        </View>
      ))}
    </Card>
  )
}

export function PayslipScreen({ route }: Props<'Payslip'>) {
  const c = useColors()
  const id = useWorkspaceId()
  const q = useQuery({ queryKey: ['w', id, 'my-payslip', route.params.id], queryFn: async () => (await api<{ payslip: Payslip }>(`/w/${id}/me/payslips/${route.params.id}`)).payslip, enabled: !!id })
  if (q.isPending) return <Loading />
  const p = q.data
  if (!p) return <Screen><ErrorBox message={q.error?.message} /></Screen>
  return (
    <Screen>
      <Title sub={`${p.employer.name} · paid ${dateOf(p.run.payDate)}`}>{p.run.kind === 'thirteenth' ? '13th month pay' : `${dateOf(p.run.periodStart)} – ${dateOf(p.run.periodEnd)}`}</Title>
      <Card>
        <Body muted>Take-home pay</Body>
        <Text style={{ color: c.fg, fontSize: 32, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{formatPeso(p.result.net)}</Text>
      </Card>
      <Lines title="Earnings" lines={p.result.earnings} />
      {p.result.deductions.length > 0 && <Lines title="Deductions" lines={p.result.deductions} />}
      <Body muted>
        SSS {p.employee.sssNo ?? '—'} · PhilHealth {p.employee.philhealthNo ?? '—'} · Pag-IBIG {p.employee.pagibigNo ?? '—'}
      </Body>
    </Screen>
  )
}

/** Managers: leave waiting for a decision. */
export function ApprovalsScreen() {
  const id = useWorkspaceId()
  const queryClient = useQueryClient()
  const q = useQuery({ queryKey: ['w', id, 'leave', 'pending'], queryFn: async () => (await api<{ requests: LeaveRequest[] }>(`/w/${id}/leave/requests?status=pending`)).requests, enabled: !!id })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  async function decide(r: LeaveRequest, what: 'approve' | 'reject') {
    setBusy(r.id)
    setError(null)
    try {
      await api(`/w/${id}/leave/requests/${r.id}/${what}`, { method: 'POST', body: {} })
      await queryClient.invalidateQueries({ queryKey: ['w', id] })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (q.isPending) return <Loading />
  return (
    <Screen refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />}>
      <Title sub="Approved paid leave is paid in the payroll; unpaid leave is deducted.">Leave to decide</Title>
      <ErrorBox message={error ?? q.error?.message} />
      {q.data?.length === 0 && <Body muted>Nothing waiting.</Body>}
      {q.data?.map((r) => (
        <Card key={r.id}>
          <Body style={{ fontWeight: '600' }}>{r.employee.name}</Body>
          <Body>
            {r.leaveType.name} · {r.days} day(s)
          </Body>
          <Body muted>
            {dateOf(r.startDate)}
            {r.endDate !== r.startDate ? ` to ${dateOf(r.endDate)}` : ''}
            {r.reason ? ` · ${r.reason}` : ''}
          </Body>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Button title="Not approved" variant="outline" disabled={!!busy} onPress={() => void decide(r, 'reject')} />
            </View>
            <View style={{ flex: 1 }}>
              <Button title="Approve" busy={busy === r.id} disabled={!!busy} onPress={() => void decide(r, 'approve')} />
            </View>
          </View>
        </Card>
      ))}
    </Screen>
  )
}

/** The HR buttons on the home screen: shown when the workspace has HR on. */
export function HrShortcuts({ workspace, navigate }: { workspace: Workspace; navigate: (screen: 'Clock' | 'Approvals') => void }) {
  if (!workspace.modules.includes('hr')) return null
  return (
    <View style={{ gap: 10 }}>
      <Button title="Clock in / out" onPress={() => navigate('Clock')} />
      {workspace.permissions.includes('hr.manage') && <Button title="Leave to decide" variant="outline" onPress={() => navigate('Approvals')} />}
    </View>
  )
}
