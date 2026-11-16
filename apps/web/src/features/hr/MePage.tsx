import { formatPeso } from '@erp/shared'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CalendarPlus, LogIn, LogOut } from 'lucide-react'
import { useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { EmptyState, LoadError, Loading, PageHeader } from '@/features/finance/components'
import { useWorkspaceMutation } from '@/features/finance/queries'
import { useWorkspace } from '@/features/workspaces/queries'
import { api } from '@/lib/api'
import { formatDate } from '@/lib/dates'
import { MyWork } from '@/features/projects/ProjectsPages'
import { LeaveBalances, LeaveForm, LeaveStatusBadge } from './HrPages'
import { clockTime, hoursBetween, hrQueries } from './queries'

/** Where the browser says we are, if the person allows it. Clocking in works without it. */
function where(): Promise<{ latitude: number; longitude: number; accuracy: number } | null> {
  if (!('geolocation' in navigator)) return Promise.resolve(null)
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8_000, maximumAge: 60_000 },
    ),
  )
}

/** The signed-in member's own clock-ins, leave and payslips, whatever their role. */
export function MePage() {
  const workspace = useWorkspace()
  const q = useQuery({ ...hrQueries.me(workspace.id), enabled: workspace.modules.includes('hr') })
  const [asking, setAsking] = useState(false)
  const clock = useWorkspaceMutation(async (w, action: 'in' | 'out') => api(`/w/${w}/me/clock`, { method: 'POST', body: { action, source: 'web', ...(await where()) } }))
  const withdraw = useWorkspaceMutation((w, id: string) => api(`/w/${w}/me/leave/${id}/cancel`, { method: 'POST' }))

  if (!workspace.modules.includes('hr')) return <EmptyState title="HR & Payroll is turned off">An owner or admin can turn it on in Settings.</EmptyState>
  if (q.error) return <LoadError error={q.error} />
  if (!q.data) return <Loading />
  const me = q.data
  if (!me.employee) {
    return <EmptyState title="You aren’t on the employee list here">Ask HR to link your account to your employee record. Then you can clock in, ask for leave and see your payslips.</EmptyState>
  }
  const workedToday = me.today.reduce((s, t) => s + (t.clockOut ? hoursBetween(t.clockIn, t.clockOut) : 0), 0)

  return (
    <div className="space-y-6">
      <PageHeader title="My time & pay" description={`${me.employee.name} · ${me.employee.position} · ${me.employee.employeeNo}`} />
      {(clock.error || withdraw.error) && (
        <Alert variant="destructive">
          <AlertDescription>{(clock.error ?? withdraw.error)!.message}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>{me.openEntry ? `In since ${clockTime(me.openEntry.clockIn)}` : 'Not clocked in'}</CardTitle>
            <CardDescription>
              Shift starts {me.employee.shiftStart}
              {workedToday > 0 && ` · ${Math.round(workedToday * 10) / 10} h so far today`}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Button size="lg" variant={me.openEntry ? 'outline' : 'default'} disabled={clock.isPending} onClick={() => clock.mutate(me.openEntry ? 'out' : 'in')}>
              {me.openEntry ? <LogOut /> : <LogIn />}
              {clock.isPending ? 'Saving…' : me.openEntry ? 'Clock out' : 'Clock in'}
            </Button>
            <p className="text-muted-foreground text-xs">Your browser may ask to share where you are. It’s recorded with the clock-in, so HR can see you were at work.</p>
            {me.today.map((t) => (
              <p key={t.id} className="text-sm tabular-nums">
                {clockTime(t.clockIn)} – {t.clockOut ? clockTime(t.clockOut) : 'now'}
              </p>
            ))}
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-start justify-between gap-3">
            <div>
              <CardTitle>Leave</CardTitle>
              <CardDescription>This year.</CardDescription>
            </div>
            <Button variant="outline" onClick={() => setAsking(true)}>
              <CalendarPlus />
              Ask for leave
            </Button>
          </CardHeader>
          <CardContent className="grid gap-6">
            <LeaveBalances balances={me.leave} />
            {me.requests.length > 0 && (
              <Table>
                <TableBody>
                  {me.requests.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="pl-0">
                        {l.leaveType.name}
                        <span className="text-muted-foreground block text-xs">
                          {formatDate(l.startDate)}
                          {l.endDate !== l.startDate && ` to ${formatDate(l.endDate)}`} · {l.days} day(s)
                        </span>
                      </TableCell>
                      <TableCell>
                        <LeaveStatusBadge status={l.status} />
                        {l.decisionNote && <span className="text-muted-foreground block text-xs">{l.decisionNote}</span>}
                      </TableCell>
                      <TableCell className="pr-0 text-right">
                        {l.status === 'pending' && (
                          <Button size="sm" variant="ghost" onClick={() => withdraw.mutate(l.id)}>
                            Withdraw
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Payslips</CardTitle>
        </CardHeader>
        <CardContent>
          {me.payslips.length === 0 ? (
            <p className="text-muted-foreground text-sm">None yet. They appear here when payroll is posted.</p>
          ) : (
            <Table>
              <TableBody>
                {me.payslips.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="pl-0">
                      <Link to="/w/$workspaceId/me/payslips/$id" params={{ workspaceId: workspace.id, id: p.id }} className="font-medium hover:underline">
                        {p.kind === 'thirteenth' ? `13th month pay ${p.periodEnd.slice(0, 4)}` : `${formatDate(p.periodStart)} – ${formatDate(p.periodEnd)}`}
                      </Link>
                      <span className="text-muted-foreground block text-xs">Paid {formatDate(p.payDate)}</span>
                    </TableCell>
                    <TableCell className="pr-0 text-right tabular-nums">{formatPeso(p.net)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {workspace.modules.includes('projects') && <MyWork />}
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent>{asking && <LeaveForm onDone={() => setAsking(false)} />}</DialogContent>
      </Dialog>
    </div>
  )
}
