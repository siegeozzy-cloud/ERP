import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Account, MyTask, Project, Role, Unit, Warehouse } from '@erp/shared'
import { buildApp } from '../src/app.ts'
import { db, pool, runMigrations } from '../src/db/client.ts'
import { sessions, users } from '../src/db/schema.ts'
import { hashToken, newToken } from '../src/lib/crypto.ts'
import { testPushOutbox } from '../src/lib/push.ts'

// Phase 7: an electrical contractor wires a café (fixed price, billed by milestone) and does
// maintenance for another customer by the hour. Tasks go on a Gantt chart; the field technician sees
// his on the phone, updates them on site and logs his hours; job costing adds up labour, materials
// from stock and the subcontractor's bill against what was invoiced.

const app = await buildApp()
const run = Date.now()

async function makeUser(name: string) {
  const [user] = await db
    .insert(users)
    .values({ email: `prj+${name.toLowerCase()}+${run}@example.com`, name, passwordHash: 'x', emailVerifiedAt: new Date(), termsAcceptedAt: new Date() })
    .returning()
  const token = newToken()
  await db.insert(sessions).values({ id: hashToken(token), userId: user!.id, remember: false, expiresAt: new Date(Date.now() + 3_600_000) })
  return {
    id: user!.id,
    call: async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) => {
      const r = await app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } })
      return { status: r.statusCode, body: r.body ? r.json() : undefined }
    },
  }
}

let owner: Awaited<ReturnType<typeof makeUser>>
let tech: Awaited<ReturnType<typeof makeUser>>
let ws = ''
const w = (p: string) => `/api/w/${ws}${p}`
const call = (...a: Parameters<typeof owner.call>) => owner.call(...a)
const acct: Record<string, string> = {}
let customer = ''
let subcon = ''
let techEmployee = ''
let wire = ''
let main = ''
let project: Project

const balanceOf = async (key: string) => {
  const tb = (await call('GET', w('/reports/trial-balance?asOf=2030-12-31'))).body.report
  return tb.rows.find((r: { id: string }) => r.id === acct[key])?.balance ?? 0
}

before(async () => {
  await runMigrations()
  owner = await makeUser('Engr. Bautista')
  const r = await call('POST', '/api/workspaces', { template: 'construction', name: 'Kidlat Electrical Services', tin: '135-246-357-00000', vatStatus: 'vat', street: 'Pasig City' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  ws = r.body.workspace.id
  for (const a of (await call('GET', w('/accounts'))).body.accounts as Account[]) if (a.systemKey) acct[a.systemKey] = a.id
  customer = (await call('POST', w('/contacts'), { name: 'Kape Tayo Café Inc.', isCustomer: true, paymentTermsDays: 15 })).body.contact.id
  subcon = (await call('POST', w('/contacts'), { name: 'Liwanag Aircon Installers', isSupplier: true })).body.contact.id
  const roles = (await call('GET', w('/roles'))).body.roles as Role[]
  const code = (await call('POST', w('/join-codes'), { roleId: roles.find((x) => x.name === 'Viewer')!.id })).body.code.code
  tech = await makeUser('Rodel')
  assert.equal((await tech.call('POST', '/api/workspaces/join', { code })).status, 200)
  // ₱800 a day: ₱100 an hour on a job
  techEmployee = (await call('POST', w('/employees'), { firstName: 'Rodel', lastName: 'Aquino', position: 'Electrician', hireDate: '2025-01-06', payBasis: 'daily', rate: 800_00, userId: tech.id, tracksAttendance: false })).body.employee.id
  const units = (await call('GET', w('/units'))).body.units as Unit[]
  main = ((await call('GET', w('/warehouses'))).body.warehouses as Warehouse[])[0]!.id
  wire = (await call('POST', w('/items'), { sku: 'THHN-3.5', name: 'THHN wire 3.5 mm², 150 m roll', unitId: units.find((u) => u.code === 'roll')!.id, purchaseCost: 4_000_00 })).body.item.id
  await call('POST', w('/stock/adjustments'), { date: '2026-11-01', warehouseId: main, reason: 'opening', lines: [{ itemId: wire, change: 10, unitCost: 4_000_00 }] })
})
after(async () => {
  await app.close()
  await pool.end()
})

test('a fixed-price project with milestones and tasks that wait for each other', async () => {
  const noCustomer = await call('POST', w('/projects'), { name: 'Wiring', startDate: '2026-11-02', endDate: '2026-12-15', billing: 'fixed' })
  assert.equal(noCustomer.body.error.field, 'customerId')
  const r = await call('POST', w('/projects'), {
    name: 'Kape Tayo Maginhawa: electrical fit-out',
    customerId: customer,
    status: 'active',
    startDate: '2026-11-02',
    endDate: '2026-12-15',
    billing: 'fixed',
    contractValue: 500_000_00,
    costBudget: 350_000_00,
    retentionBp: 0, // retention has its own test (niches.test.ts)
    siteAddress: '88 Maginhawa St., Quezon City',
  })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  project = r.body.project
  assert.equal(project.number, 'PRJ-000001')
  for (const [name, dueDate, amount] of [['Mobilization (30%)', '2026-11-05', 150_000_00], ['Rough-in done', '2026-11-25', 200_000_00], ['Turnover', '2026-12-15', 150_000_00]] as const) {
    project = (await call('POST', w(`/projects/${project.id}/milestones`), { name, dueDate, amount })).body.project
  }
  assert.equal(project.milestones.length, 3)

  project = (await call('POST', w(`/projects/${project.id}/tasks`), { name: 'Load schedule and plans', startDate: '2026-11-02', endDate: '2026-11-06', estimatedHours: 10 })).body.project
  const plans = project.tasks[0]!
  const pushes = testPushOutbox.length
  const added = await call('POST', w(`/projects/${project.id}/tasks`), {
    name: 'Pull wires, ground floor',
    startDate: '2026-11-09',
    endDate: '2026-11-20',
    estimatedHours: 30,
    dependsOnId: plans.id,
    assigneeId: tech.id,
    fieldWork: true,
    location: '88 Maginhawa St., ground floor',
  })
  assert.equal(added.status, 201, JSON.stringify(added.body))
  project = added.body.project
  assert.deepEqual(testPushOutbox.at(-1)!.userIds, [tech.id])
  assert.equal(testPushOutbox.length, pushes + 1)
  const wiring = project.tasks.find((t) => t.name.startsWith('Pull'))!
  // the plans can't wait for the wiring that waits for the plans
  const loop = await call('PUT', w(`/projects/${project.id}/tasks/${plans.id}`), { name: plans.name, startDate: plans.startDate, endDate: plans.endDate, dependsOnId: wiring.id })
  assert.match(loop.body.error.message, /wait for each other/)
  project = (await call('POST', w(`/projects/${project.id}/tasks/${plans.id}/progress`), { status: 'done' })).body.project
  assert.equal(project.percentComplete, 25) // 10 of 40 estimated hours done
})

test('the technician sees his task, works it on site and logs his hours', async () => {
  const mine = (await tech.call('GET', w('/me/tasks'))).body.tasks as MyTask[]
  assert.equal(mine.length, 1)
  assert.equal(mine[0]!.project.siteAddress, '88 Maginhawa St., Quezon City')
  assert.equal(mine[0]!.fieldWork, true)

  const logged = await tech.call('POST', w('/timesheets'), { projectId: project.id, taskId: mine[0]!.id, date: '2026-11-09', hours: 8, note: 'Conduits, ground floor' })
  assert.equal(logged.status, 201, JSON.stringify(logged.body))
  assert.equal(logged.body.timesheet.employee.id, techEmployee)
  assert.equal(logged.body.timesheet.cost, null) // he can't see pay
  assert.equal((await tech.call('POST', w('/timesheets'), { projectId: project.id, date: '2026-11-09', hours: 25 })).body.error.field, 'hours')
  const otherEmp = (await call('POST', w('/employees'), { firstName: 'Ben', lastName: 'Reyes', position: 'Helper', hireDate: '2025-01-06', payBasis: 'daily', rate: 700_00, tracksAttendance: false })).body.employee.id
  assert.equal((await tech.call('POST', w('/timesheets'), { projectId: project.id, employeeId: otherEmp, date: '2026-11-09', hours: 8 })).status, 403)
  // the owner logs the helper's day
  assert.equal((await call('POST', w('/timesheets'), { projectId: project.id, employeeId: otherEmp, date: '2026-11-10', hours: 8 })).status, 201)

  // logging time started the task
  assert.equal(((await tech.call('GET', w('/me/tasks'))).body.tasks as MyTask[])[0]!.status, 'in_progress')
  assert.equal((await tech.call('POST', w(`/me/tasks/${mine[0]!.id}/progress`), { status: 'done', note: 'Megger test passed', latitude: 14.6461, longitude: 121.0632 })).status, 200)
  const done = ((await tech.call('GET', w('/me/tasks'))).body.tasks as MyTask[])[0]!
  assert.equal(done.status, 'done')
  assert.equal(done.doneAt?.latitude, 14.6461)
  assert.match(done.notes ?? '', /Megger test passed/)
})

test('job costing: labour, materials from stock and a tagged bill, against a milestone invoice', async () => {
  const issued = await call('POST', w(`/projects/${project.id}/materials`), { date: '2026-11-09', warehouseId: main, lines: [{ itemId: wire, quantity: 3 }] })
  assert.equal(issued.status, 201, JSON.stringify(issued.body))
  assert.equal(await balanceOf('project_costs'), 12_000_00)

  const bill = (await call('POST', w('/bills'), { supplierId: subcon, projectId: project.id, date: '2026-11-12', lines: [{ description: 'Split-type aircon installation', quantity: 1, unitPrice: 50_000_00, vat: 'vatable', accountId: acct.purchases }] })).body.bill
  assert.equal(bill.projectId, project.id)
  await call('POST', w(`/bills/${bill.id}/post`))

  const ms = project.milestones[0]!
  const made = await call('POST', w(`/projects/${project.id}/milestones/${ms.id}/invoice`))
  assert.equal(made.status, 201, JSON.stringify(made.body))
  assert.equal((await call('POST', w(`/projects/${project.id}/milestones/${ms.id}/invoice`))).body.error.code, 'invoiced')
  const inv = (await call('GET', w(`/invoices/${made.body.invoiceId}`))).body.invoice
  assert.equal(inv.projectId, project.id)
  assert.equal(inv.total, 168_000_00) // ₱150,000 + 12% VAT
  assert.equal(inv.lines[0].accountId, acct.contract_revenue) // the Construction template's Contract Revenue
  assert.equal((await call('POST', w(`/invoices/${inv.id}/post`))).status, 200)

  project = (await call('GET', w(`/projects/${project.id}`))).body.project
  const c = project.costing
  assert.equal(c.labour, 8 * 100_00 + 8 * 87_50) // ₱800 ÷ 8 and ₱700 ÷ 8 an hour
  assert.equal(c.materials, 12_000_00)
  assert.equal(c.bills, 50_000_00)
  assert.equal(c.totalCost, 1_500_00 + 12_000_00 + 50_000_00)
  assert.equal(c.revenue, 150_000_00)
  assert.equal(c.profit, 150_000_00 - c.totalCost)
  assert.equal(c.hours, 16)
  assert.equal(project.milestones[0]!.status, 'invoiced')
  assert.equal(project.percentComplete, 100)
  assert.equal(project.costEntries.length, 2)

  // voiding the invoice frees the milestone to bill again
  const voided = await call('POST', w(`/invoices/${inv.id}/void`), { date: inv.date })
  assert.equal(voided.status, 200, JSON.stringify(voided.body))
  project = (await call('GET', w(`/projects/${project.id}`))).body.project
  assert.equal(project.milestones[0]!.status, 'done')
  assert.equal(project.costing.revenue, 0)
  assert.equal((await call('DELETE', w(`/projects/${project.id}`))).body.error.code, 'in-use')
})

test('time and materials: unbilled hours become an invoice, once', async () => {
  const p = (
    await call('POST', w('/projects'), { name: 'Monthly maintenance, Kape Tayo', customerId: customer, status: 'active', startDate: '2026-11-01', endDate: '2026-11-30', billing: 'hourly', hourlyRate: 1_500_00 })
  ).body.project as Project
  await tech.call('POST', w('/timesheets'), { projectId: p.id, date: '2026-11-14', hours: 3 })
  await tech.call('POST', w('/timesheets'), { projectId: p.id, date: '2026-11-15', hours: 2.5 })
  await tech.call('POST', w('/timesheets'), { projectId: p.id, date: '2026-11-15', hours: 1, billable: false, note: 'Travel' })
  assert.equal((await call('POST', w(`/projects/${project.id}/invoice-hours`))).body.error.code, 'not-hourly')
  const made = await call('POST', w(`/projects/${p.id}/invoice-hours`))
  assert.equal(made.status, 201, JSON.stringify(made.body))
  const inv = (await call('GET', w(`/invoices/${made.body.invoiceId}`))).body.invoice
  assert.equal(inv.lines[0].quantity, 5.5)
  assert.equal(inv.lines[0].unitPrice, 1_500_00)
  assert.equal(inv.dueDate > inv.date, true)
  assert.equal((await call('POST', w(`/projects/${p.id}/invoice-hours`))).body.error.code, 'nothing-to-bill')
  // a deleted draft gives the hours back
  await call('DELETE', w(`/invoices/${inv.id}`))
  assert.equal(((await call('GET', w(`/projects/${p.id}`))).body.project as Project).costing.unbilledHours, 5.5)

  const overview = (await call('GET', w('/projects/overview'))).body.overview
  assert.equal(overview.active, 2)
  assert.ok(overview.hoursThisWeek >= 0)
})

test('Projects can be turned off', async () => {
  const current = (await call('GET', w(''))).body.workspace
  await call('PATCH', w(''), { ...current, modules: ['finance', 'inventory'] })
  assert.equal((await call('GET', w('/projects'))).body.error.code, 'module-off')
  assert.equal((await tech.call('GET', w('/me/tasks'))).body.error.code, 'module-off')
  await call('PATCH', w(''), { ...current, modules: current.modules })
  const tb = (await call('GET', w('/reports/trial-balance?asOf=2030-12-31'))).body.report
  assert.equal(tb.totalDebit, tb.totalCredit)
})
