import type { MyTask, Project, ProjectsOverview, ProjectSummary, TimesheetEntry } from '@erp/shared'
import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'

export type MyTimesheets = {
  employee: { id: string; name: string } | null
  projects: { id: string; number: string; name: string; tasks: { id: string; name: string }[] }[]
  entries: TimesheetEntry[]
}

export const projectQueries = {
  overview: (w: string) => queryOptions({ queryKey: ['w', w, 'projects-overview'], queryFn: async () => (await api<{ overview: ProjectsOverview }>(`/w/${w}/projects/overview`)).overview }),
  list: (w: string, status = 'all') =>
    queryOptions({ queryKey: ['w', w, 'projects', status], queryFn: async () => (await api<{ projects: ProjectSummary[] }>(`/w/${w}/projects${status === 'all' ? '' : `?status=${status}`}`)).projects }),
  one: (w: string, id: string) => queryOptions({ queryKey: ['w', w, 'project', id], queryFn: async () => (await api<{ project: Project }>(`/w/${w}/projects/${id}`)).project }),
  timesheets: (w: string, projectId?: string) =>
    queryOptions({ queryKey: ['w', w, 'timesheets', projectId ?? 'all'], queryFn: async () => (await api<{ timesheets: TimesheetEntry[] }>(`/w/${w}/timesheets${projectId ? `?projectId=${projectId}` : ''}`)).timesheets }),
  myTasks: (w: string) => queryOptions({ queryKey: ['w', w, 'my-tasks'], queryFn: async () => (await api<{ tasks: MyTask[] }>(`/w/${w}/me/tasks`)).tasks }),
  myTimesheets: (w: string) => queryOptions({ queryKey: ['w', w, 'my-timesheets'], queryFn: () => api<MyTimesheets>(`/w/${w}/me/timesheets`) }),
}

/** "2026-11-16" plus days. */
export const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
/** Whole days from a to b. */
export const daysFrom = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
