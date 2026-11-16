import { z } from 'zod'
import { textField } from './workspace.ts'

// Projects (Phase 7): milestones, tasks on a Gantt chart, timesheets, job costing, and field work
// from the phone.
//
// A project is for a customer (billed at a fixed price by milestones, or for time and materials at
// an hourly rate) or internal (not billed). Its costs are the hours logged against it (at each
// employee's daily rate ÷ 8), materials taken from stock for it, and supplier bills tagged to it;
// its revenue is the invoices tagged to it. Labour is costed for the project only: payroll already
// books the wages, so timesheets make no journal entries.

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use ${max} characters or fewer.`)
    .transform((v) => (v === '' ? undefined : v))
    .optional()

const centavos = (label: string) => z.number(`Enter the ${label}.`).int(`Enter the ${label} to the centavo.`).min(0, `The ${label} can’t be negative.`).max(1_000_000_000_000)
const dateSchema = z.iso.date('Enter a date.')
const hours = (label: string) =>
  z.coerce
    .number(`Enter the ${label}.`)
    .min(0, `The ${label} can’t be negative.`)
    .max(100_000, 'That’s too many hours.')
    .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, 'Use at most two decimal places.')

export const PROJECT_STATUSES = ['planning', 'active', 'on_hold', 'completed', 'cancelled'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = { planning: 'Planning', active: 'Active', on_hold: 'On hold', completed: 'Completed', cancelled: 'Cancelled' }

export const BILLING_METHODS = ['fixed', 'hourly', 'none'] as const
export type BillingMethod = (typeof BILLING_METHODS)[number]
export const BILLING_METHOD_LABELS: Record<BillingMethod, string> = { fixed: 'Fixed price, billed by milestone', hourly: 'Time and materials, by the hour', none: 'Internal, not billed' }

export const ProjectInput = z
  .object({
    name: textField('project name', 160),
    customerId: z.uuid().nullish(),
    /** The member who runs it. */
    managerId: z.uuid().nullish(),
    status: z.enum(PROJECT_STATUSES).default('planning'),
    startDate: dateSchema,
    endDate: dateSchema,
    billing: z.enum(BILLING_METHODS).default('fixed'),
    /** Fixed price: what the customer pays in all, before VAT. */
    contractValue: centavos('contract value').default(0),
    /** Time and materials: what an hour is billed at, before VAT. */
    hourlyRate: centavos('hourly rate').default(0),
    /** What it's expected to cost. */
    costBudget: centavos('cost budget').default(0),
    /**
     * Fixed price: the share of each milestone the customer holds back until turnover, in basis points
     * (1000 = 10%, the usual in construction). Billed later as its own invoice. Left out: the
     * template's (Construction: 10%), or what the project has.
     */
    retentionBp: z.coerce.number().int().min(0).max(5000).nullish(),
    siteAddress: optionalText(300),
    description: optionalText(2000),
  })
  .refine((p) => p.endDate >= p.startDate, { message: 'It can’t end before it starts.', path: ['endDate'] })
  .refine((p) => p.billing === 'none' || p.customerId, { message: 'Choose the customer to bill, or make it internal.', path: ['customerId'] })
  .refine((p) => p.billing !== 'hourly' || p.hourlyRate > 0, { message: 'Enter the hourly rate.', path: ['hourlyRate'] })
export type ProjectInput = z.input<typeof ProjectInput>

export const MilestoneInput = z.object({
  name: textField('milestone', 160),
  dueDate: dateSchema,
  /** Fixed-price projects: what reaching it bills, before VAT. */
  amount: centavos('amount').default(0),
})
export type MilestoneInput = z.input<typeof MilestoneInput>

export const TASK_STATUSES = ['todo', 'in_progress', 'done'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = { todo: 'To do', in_progress: 'In progress', done: 'Done' }

export const TaskInput = z
  .object({
    name: textField('task', 160),
    description: optionalText(2000),
    milestoneId: z.uuid().nullish(),
    /** The member doing it; they see it under My tasks, and on the phone. */
    assigneeId: z.uuid().nullish(),
    startDate: dateSchema,
    endDate: dateSchema,
    estimatedHours: hours('estimated hours').default(0),
    /** Starts when this one ends (shown on the Gantt chart). */
    dependsOnId: z.uuid().nullish(),
    /** Done on site: shows on the phone with where to go. */
    fieldWork: z.boolean().default(false),
    location: optionalText(300),
  })
  .refine((t) => t.endDate >= t.startDate, { message: 'It can’t end before it starts.', path: ['endDate'] })
export type TaskInput = z.input<typeof TaskInput>

/** Progress on a task, from the web or the phone. Location is recorded when given (field work). */
export const TaskProgressInput = z.object({
  status: z.enum(TASK_STATUSES),
  progress: z.coerce.number().int().min(0).max(100).optional(),
  note: optionalText(1000),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
})
export type TaskProgressInput = z.input<typeof TaskProgressInput>

export const TimesheetInput = z.object({
  projectId: z.uuid('Choose the project.'),
  taskId: z.uuid().nullish(),
  /** Someone with Projects manage may log for anyone; others log their own. */
  employeeId: z.uuid().nullish(),
  date: dateSchema,
  hours: hours('hours').refine((h) => h > 0, 'Enter the hours.').refine((h) => h <= 24, 'A day has 24 hours.'),
  billable: z.boolean().default(true),
  note: optionalText(500),
})
export type TimesheetInput = z.input<typeof TimesheetInput>

/** Taking materials from stock for a project (its cost, not for sale). */
export const ProjectMaterialsInput = z.object({
  date: dateSchema,
  warehouseId: z.uuid('Choose the warehouse.'),
  lines: z
    .array(z.object({ itemId: z.uuid('Choose an item.'), quantity: z.coerce.number().positive('Enter the quantity.').max(1_000_000_000), lotNo: optionalText(40) }))
    .min(1, 'Add at least one item.')
    .max(100),
  note: optionalText(300),
})
export type ProjectMaterialsInput = z.input<typeof ProjectMaterialsInput>

export type ProjectSummary = {
  id: string
  number: string
  name: string
  status: ProjectStatus
  billing: BillingMethod
  customer: { id: string; name: string } | null
  manager: { id: string; name: string } | null
  startDate: string
  endDate: string
  contractValue: number
  costBudget: number
  /** Weighted by estimated hours (or counted, when there are none). */
  percentComplete: number
  /** Cost so far: labour, materials and bills. */
  costToDate: number
  /** Past its end date and not completed. */
  late: boolean
}

export type Milestone = {
  id: string
  name: string
  dueDate: string
  amount: number
  status: 'open' | 'done' | 'invoiced'
  doneAt: string | null
  invoice: { id: string; number: string | null; status: string } | null
}

export type ProjectTask = {
  id: string
  name: string
  description: string | null
  milestoneId: string | null
  assignee: { id: string; name: string } | null
  startDate: string
  endDate: string
  estimatedHours: number
  loggedHours: number
  progress: number
  status: TaskStatus
  dependsOnId: string | null
  fieldWork: boolean
  location: string | null
  /** Field work: where it was marked done from, if the phone said. */
  doneAt: { at: string; latitude: number | null; longitude: number | null } | null
  notes: string | null
}

export type TimesheetEntry = {
  id: string
  date: string
  project: { id: string; number: string; name: string }
  task: { id: string; name: string } | null
  employee: { id: string; name: string }
  hours: number
  billable: boolean
  note: string | null
  /** Null when the viewer may not see pay. */
  cost: number | null
  invoice: { id: string; number: string | null } | null
}

export type JobCosting = {
  /** Before VAT: posted invoices tagged to the project. */
  revenue: number
  /** Drafts waiting to be posted. */
  draftRevenue: number
  labour: number
  materials: number
  bills: number
  totalCost: number
  /** Revenue − cost so far. */
  profit: number
  hours: number
  unbilledHours: number
  /** Cost to date ÷ budget, in percent (0 with no budget). */
  budgetUsed: number
  /** At this rate of spending for the work done: cost ÷ percent complete. */
  forecastCost: number | null
}

export type Project = ProjectSummary & {
  retentionBp: number
  /** Held back from milestone invoices so far, and the invoice that bills it (once). */
  retention: { held: number; invoice: { id: string; number: string | null } | null }
  siteAddress: string | null
  description: string | null
  hourlyRate: number
  milestones: Milestone[]
  tasks: ProjectTask[]
  costing: JobCosting
  /** Material issues and tagged bills, newest first. */
  costEntries: { date: string; kind: 'materials' | 'bill'; reference: string | null; description: string; amount: number; id: string }[]
}

/** A task as its assignee sees it (My tasks, and the phone). */
export type MyTask = ProjectTask & { project: { id: string; number: string; name: string; siteAddress: string | null } }

export type ProjectsOverview = {
  active: number
  late: number
  contractValue: number
  costToDate: number
  hoursThisWeek: number
  dueSoon: { project: { id: string; number: string; name: string }; kind: 'milestone' | 'task'; name: string; dueDate: string }[]
}
