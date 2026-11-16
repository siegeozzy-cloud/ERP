import { TASK_STATUS_LABELS, type MyTask } from '@erp/shared'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Linking, Pressable, RefreshControl, Text, View } from 'react-native'
import { api } from '../lib/api'
import { useSession } from '../lib/session'
import { Body, Button, Card, ErrorBox, Field, Loading, Screen, Title, useColors } from '../ui/components'
import { here } from './hr'
import type { SignedInStack } from './workspace'

/**
 * Field work orders (Phase 7): the project tasks assigned to this person. On site they start a task,
 * update how far it's got, log their hours and mark it done; "done" records where the phone was.
 */

type Props<K extends keyof SignedInStack> = NativeStackScreenProps<SignedInStack, K>

function useWorkspaceId() {
  const { state } = useSession()
  return state.status === 'signed-in' ? state.workspaceId : null
}

const dateOf = (d: string) => new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`))
const todayManila = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())

export const myTasksQuery = (id: string | null) => ({ queryKey: ['w', id, 'my-tasks'], queryFn: async () => (await api<{ tasks: MyTask[] }>(`/w/${id}/me/tasks`)).tasks, enabled: !!id })

export function TasksScreen({ navigation }: Props<'Tasks'>) {
  const c = useColors()
  const id = useWorkspaceId()
  const q = useQuery(myTasksQuery(id))
  return (
    <Screen refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />}>
      <Title sub="Project tasks assigned to you. Tap one to update it or log your hours.">My tasks</Title>
      {q.error ? <ErrorBox message={(q.error as Error).message} /> : null}
      {!q.data ? (
        <Loading />
      ) : q.data.length === 0 ? (
        <Card>
          <Body muted>Nothing assigned to you right now.</Body>
        </Card>
      ) : (
        q.data.map((t) => {
          const late = t.status !== 'done' && t.endDate < todayManila()
          return (
            <Card key={t.id} onPress={() => navigation.navigate('Task', { id: t.id })}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <Text style={{ color: c.fg, fontSize: 16, fontWeight: '600', flex: 1 }}>{t.name}</Text>
                <Text style={{ color: t.status === 'done' ? c.success : late ? c.danger : c.muted, fontSize: 13 }}>{t.status === 'done' ? 'Done' : late ? 'Late' : TASK_STATUS_LABELS[t.status]}</Text>
              </View>
              <Body muted>
                {t.project.number} · {t.project.name}
              </Body>
              <Body muted>
                {dateOf(t.startDate)} – {dateOf(t.endDate)}
                {t.fieldWork ? ` · ${t.location ?? t.project.siteAddress ?? 'On site'}` : ''}
              </Body>
              {t.status === 'in_progress' ? (
                <View style={{ height: 6, backgroundColor: c.border, borderRadius: 3, overflow: 'hidden', marginTop: 4 }}>
                  <View style={{ width: `${t.progress}%`, height: 6, backgroundColor: c.primary }} />
                </View>
              ) : null}
            </Card>
          )
        })
      )}
    </Screen>
  )
}

export function TaskScreen({ route }: Props<'Task'>) {
  const c = useColors()
  const id = useWorkspaceId()
  const queryClient = useQueryClient()
  const q = useQuery(myTasksQuery(id))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [hours, setHours] = useState('')
  const task = q.data?.find((t) => t.id === route.params.id)

  async function run(work: () => Promise<unknown>, done: string) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await work()
      await queryClient.invalidateQueries({ queryKey: ['w', id] })
      setNotice(done)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const update = (status: MyTask['status'], progress?: number) =>
    run(async () => {
      // marking it done on site records where the phone is
      const at = status === 'done' ? await here() : null
      await api(`/w/${id}/me/tasks/${route.params.id}/progress`, { method: 'POST', body: { status, progress, note: note || undefined, latitude: at?.latitude, longitude: at?.longitude } })
      setNote('')
    }, status === 'done' ? 'Marked done.' : 'Updated.')

  if (!task) return q.data ? <Screen><Body muted>That task isn’t assigned to you any more.</Body></Screen> : <Loading />
  const where = task.location ?? task.project.siteAddress
  return (
    <Screen>
      <Title sub={`${task.project.number} · ${task.project.name}`}>{task.name}</Title>
      <ErrorBox message={error} />
      {notice ? <Text style={{ color: c.success, fontSize: 15 }}>{notice}</Text> : null}
      <Card>
        <Body>
          {dateOf(task.startDate)} – {dateOf(task.endDate)} · {TASK_STATUS_LABELS[task.status]}
          {task.status === 'in_progress' ? `, ${task.progress}%` : ''}
        </Body>
        {task.estimatedHours ? (
          <Body muted>
            {task.loggedHours} of about {task.estimatedHours} hours logged
          </Body>
        ) : null}
        {where ? (
          <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(`https://maps.google.com/?q=${encodeURIComponent(where)}`)}>
            <Text style={{ color: c.fg, textDecorationLine: 'underline', fontSize: 15 }}>📍 {where}</Text>
          </Pressable>
        ) : null}
        {task.description ? <Body>{task.description}</Body> : null}
        {task.notes ? <Body muted>{task.notes}</Body> : null}
      </Card>

      {task.status !== 'done' ? (
        <>
          <Field label="Note (optional)" value={note} onChangeText={setNote} placeholder="What was done, what’s needed" />
          {task.status === 'todo' ? (
            <Button title="Start" onPress={() => void update('in_progress')} busy={busy} />
          ) : (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {[25, 50, 75].map((p) => (
                <View key={p} style={{ flex: 1 }}>
                  <Button title={`${p}%`} variant={task.progress === p ? 'primary' : 'outline'} onPress={() => void update('in_progress', p)} disabled={busy} />
                </View>
              ))}
            </View>
          )}
          <Button title="Mark done" variant={task.status === 'todo' ? 'outline' : 'primary'} onPress={() => void update('done')} busy={busy} />

          <Title sub="Today, on this task">Log hours</Title>
          <Field label="Hours" value={hours} onChangeText={setHours} keyboardType="decimal-pad" placeholder="e.g. 8" />
          <Button
            title="Log hours"
            variant="outline"
            disabled={busy || !(Number(hours) > 0)}
            onPress={() =>
              void run(async () => {
                await api(`/w/${id}/timesheets`, { method: 'POST', body: { projectId: task.project.id, taskId: task.id, date: todayManila(), hours: Number(hours), note: note || undefined } })
                setHours('')
              }, `${hours} h logged.`)
            }
          />
        </>
      ) : (
        <Card>
          <Body>Done{task.doneAt?.latitude != null ? ', marked on site' : ''}.</Body>
          <Button title="Reopen" variant="outline" onPress={() => void update('in_progress', 90)} busy={busy} />
        </Card>
      )}
    </Screen>
  )
}
