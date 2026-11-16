import { z } from 'zod'

// What a role can do. The API checks one of these on every workspace route; the apps use the same
// list to hide what someone can't use. Each later module adds its own (inventory.*, payroll.*…).

export const PERMISSIONS = {
  'workspace.manage': { group: 'Workspace', label: 'Edit the business details and turn modules on or off' },
  'members.view': { group: 'Workspace', label: 'See who’s in the workspace' },
  'members.invite': { group: 'Workspace', label: 'Create join codes' },
  'members.manage': { group: 'Workspace', label: 'Change members’ roles and remove members' },
  'roles.manage': { group: 'Workspace', label: 'Create and edit roles' },
  'audit.view': { group: 'Workspace', label: 'See the audit log' },
  'finance.view': { group: 'Finance', label: 'See invoices, bills, the journal and reports' },
  'finance.edit': { group: 'Finance', label: 'Create and edit drafts, contacts and accounts' },
  'finance.post': { group: 'Finance', label: 'Post, void, record payments and reverse entries' },
  'inventory.view': { group: 'Inventory', label: 'See items, stock levels and purchase orders' },
  'inventory.manage': { group: 'Inventory', label: 'Edit items and warehouses, receive goods, adjust and move stock' },
  'purchasing.manage': { group: 'Inventory', label: 'Create, issue and cancel purchase orders' },
  'crm.view': { group: 'Sales & CRM', label: 'See customers, leads, quotes and sales orders' },
  'crm.manage': { group: 'Sales & CRM', label: 'Add customers, work leads, log activities and make quotes' },
  'sales.manage': { group: 'Sales & CRM', label: 'Create, confirm and cancel sales orders' },
  'hr.view': { group: 'HR & payroll', label: 'See employees, attendance and leave' },
  'hr.manage': { group: 'HR & payroll', label: 'Add and edit employees, fix attendance, approve leave, set holidays' },
  'payroll.run': { group: 'HR & payroll', label: 'See pay, run and post payroll, and file government reports' },
  'manufacturing.view': { group: 'Manufacturing', label: 'See bills of materials, work orders and the production plan' },
  'manufacturing.manage': { group: 'Manufacturing', label: 'Edit bills of materials and work centres; release, start and complete work orders' },
  'projects.view': { group: 'Projects', label: 'See projects, their plans, timesheets and costs' },
  'projects.manage': { group: 'Projects', label: 'Plan projects, assign tasks, log anyone’s time, take materials, bill milestones and hours' },
} as const

export type Permission = keyof typeof PERMISSIONS
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[]
export const permissionSchema = z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]])

/**
 * The roles every workspace starts with. Owner is fixed: it has everything, and only an owner can
 * make someone else one. The rest can be edited, and more can be added.
 */
export const DEFAULT_ROLES: { key: string | null; name: string; description: string; permissions: Permission[] }[] = [
  { key: 'owner', name: 'Owner', description: 'Everything, including making other owners.', permissions: ALL_PERMISSIONS },
  { key: 'admin', name: 'Admin', description: 'Everything except changing owners.', permissions: ALL_PERMISSIONS },
  {
    key: null,
    name: 'Accountant',
    description: 'Runs the books: posts, voids and files reports.',
    permissions: ['members.view', 'audit.view', 'finance.view', 'finance.edit', 'finance.post', 'inventory.view', 'crm.view', 'hr.view', 'manufacturing.view', 'projects.view'],
  },
  { key: null, name: 'Bookkeeper', description: 'Prepares drafts for an accountant to post.', permissions: ['members.view', 'finance.view', 'finance.edit', 'inventory.view', 'crm.view'] },
  { key: null, name: 'Viewer', description: 'Can look but not change anything.', permissions: ['members.view', 'finance.view', 'inventory.view', 'crm.view', 'manufacturing.view', 'projects.view'] },
  { key: null, name: 'Warehouse staff', description: 'Receives goods, counts and moves stock.', permissions: ['members.view', 'inventory.view', 'inventory.manage', 'crm.view', 'manufacturing.view'] },
  { key: null, name: 'Sales', description: 'Works leads, makes quotes and takes orders.', permissions: ['members.view', 'crm.view', 'crm.manage', 'sales.manage'] },
  {
    key: null,
    name: 'Production staff',
    description: 'Runs work orders: issues materials, records output and quality checks.',
    permissions: ['members.view', 'inventory.view', 'manufacturing.view', 'manufacturing.manage'],
  },
  {
    key: null,
    name: 'Project manager',
    description: 'Plans projects, assigns work, tracks time and costs, and bills milestones.',
    permissions: ['members.view', 'crm.view', 'inventory.view', 'projects.view', 'projects.manage'],
  },
  { key: null, name: 'HR & payroll', description: 'Keeps employee records, approves leave and runs payroll.', permissions: ['members.view', 'members.invite', 'hr.view', 'hr.manage', 'payroll.run'] },
]

const roleName = z
  .string('Name the role.')
  .trim()
  .min(1, 'Name the role.')
  .max(60, 'Use 60 characters or fewer.')
  .refine((v) => !/[\p{Cc}]/u.test(v), 'Leave out invisible characters.')

export const RoleInput = z.object({
  name: roleName,
  description: z.string().trim().max(200, 'Use 200 characters or fewer.').default(''),
  permissions: z.array(permissionSchema).max(ALL_PERMISSIONS.length),
})
export type RoleInput = z.input<typeof RoleInput>

export type Role = {
  id: string
  /** 'owner' and 'admin' for the built-in roles, null for the others. */
  key: string | null
  name: string
  description: string
  permissions: Permission[]
  memberCount: number
}
