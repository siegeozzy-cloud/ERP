import type { Dashboard } from '@erp/shared'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { db } from '../../db/client.ts'
import { can, needs, workspaceOf } from '../../lib/workspace.ts'
import { todayInManila } from '../finance/ledger.ts'

/**
 * The dashboard (Phase 9). One request, a handful of grouped queries: money for those who may see
 * Finance, and counts of what's waiting in each module the person can work in.
 */

type Row = Record<string, unknown>
const rows = async <T extends Row>(q: ReturnType<typeof sql>) => (await db.execute<T>(q)).rows

/** The first day of the month `back` months before today's, as YYYY-MM-01. */
function monthStart(today: string, back: number) {
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() - back)
  return d.toISOString().slice(0, 10)
}

export default async function dashboardRoutes(app: FastifyInstance) {
  app.get('/dashboard', needs('member'), async (req): Promise<{ dashboard: Dashboard }> => {
    const ws = workspaceOf(req)
    const today = todayInManila()
    const from = monthStart(today, 5)
    const months = Array.from({ length: 6 }, (_, i) => monthStart(today, 5 - i).slice(0, 7))

    let money: Dashboard['money'] = null
    if (can(req, 'finance.view')) {
      const flows = await rows<{ month: string; income: string; expenses: string }>(sql`
        select to_char(e.date, 'YYYY-MM') as month,
          coalesce(sum(l.credit - l.debit) filter (where a.type = 'income'), 0) as income,
          coalesce(sum(l.debit - l.credit) filter (where a.type = 'expense'), 0) as expenses
        from journal_lines l
        join journal_entries e on e.id = l.entry_id
        join accounts a on a.id = l.account_id
        where e.workspace_id = ${ws.id} and e.status = 'posted' and e.date >= ${from} and e.date <= ${today}
        group by 1`)
      const byMonth = new Map(flows.map((f) => [f.month, f]))
      // cash and bank: the balance before the window, then each month's movement on top
      const [opening] = await rows<{ balance: string }>(sql`
        select coalesce(sum(l.debit - l.credit), 0) as balance
        from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
        where e.workspace_id = ${ws.id} and e.status = 'posted' and e.date < ${from} and a.subtype in ('cash', 'bank')`)
      const cashMoves = new Map(
        (
          await rows<{ month: string; change: string }>(sql`
            select to_char(e.date, 'YYYY-MM') as month, sum(l.debit - l.credit) as change
            from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
            where e.workspace_id = ${ws.id} and e.status = 'posted' and e.date >= ${from} and e.date <= ${today} and a.subtype in ('cash', 'bank')
            group by 1`)
        ).map((r) => [r.month, Number(r.change)]),
      )
      let balance = Number(opening?.balance ?? 0)
      const cash = months.map((m) => ({ month: m, balance: (balance += cashMoves.get(m) ?? 0) }))

      const aging = await rows<{ bucket: string; amount: string; count: string }>(sql`
        with open as (
          select i.id, coalesce(i.due_date, i.date) as due,
            i.amount_due - coalesce((select sum(p.amount + p.withheld) from payments p where p.invoice_id = i.id and p.status = 'posted'), 0) as balance
          from sales_invoices i where i.workspace_id = ${ws.id} and i.status = 'posted'
        )
        select case
            when due >= ${today}::date then 'current'
            when ${today}::date - due <= 30 then '1-30'
            when ${today}::date - due <= 60 then '31-60'
            when ${today}::date - due <= 90 then '61-90'
            else '90+' end as bucket,
          sum(balance) as amount, count(*) as count
        from open where balance > 0 group by 1`)
      const agingBy = new Map(aging.map((a) => [a.bucket, a]))

      const top = await rows<{ id: string; name: string; sales: string }>(sql`
        select c.id, c.name, sum(i.total - i.vat_amount) as sales
        from sales_invoices i join contacts c on c.id = i.customer_id
        where i.workspace_id = ${ws.id} and i.status = 'posted' and i.date > ${today}::date - 90
        group by c.id, c.name order by 3 desc limit 5`)

      // a business younger than six months: leave out the months before it had any activity (keep at least two)
      const flowsBy = months.map((m) => ({ month: m, income: Number(byMonth.get(m)?.income ?? 0), expenses: Number(byMonth.get(m)?.expenses ?? 0) }))
      let skip = 0
      while (skip < months.length - 2 && flowsBy[skip]!.income === 0 && flowsBy[skip]!.expenses === 0 && cash[skip]!.balance === 0) skip++
      money = {
        months: flowsBy.slice(skip),
        cash: cash.slice(skip),
        aging: (['current', '1-30', '31-60', '61-90', '90+'] as const).map((b) => ({ bucket: b, amount: Number(agingBy.get(b)?.amount ?? 0), count: Number(agingBy.get(b)?.count ?? 0) })),
        topCustomers: top.map((t) => ({ id: t.id, name: t.name, sales: Number(t.sales) })),
      }
    }

    // what's waiting, in one round trip
    const on = (m: string) => ws.modules.includes(m)
    const counts: [string, string, string, boolean, ReturnType<typeof sql>][] = [
      ['overdue', 'Invoices overdue', 'finance/invoices', on('finance') && can(req, 'finance.view'), sql`(select count(*) from sales_invoices i where i.workspace_id = ${ws.id} and i.status = 'posted' and i.due_date < ${today} and i.amount_due > coalesce((select sum(p.amount + p.withheld) from payments p where p.invoice_id = i.id and p.status = 'posted'), 0))`],
      ['bills', 'Bills to pay this week', 'finance/bills', on('finance') && can(req, 'finance.view'), sql`(select count(*) from bills b where b.workspace_id = ${ws.id} and b.status = 'posted' and b.due_date <= ${today}::date + 7 and b.amount_due > coalesce((select sum(p.amount) from payments p where p.bill_id = b.id and p.status = 'posted'), 0))`],
      ['low', 'Items running low', 'inventory', on('inventory') && can(req, 'inventory.view'), sql`(select count(*) from items it where it.workspace_id = ${ws.id} and it.kind = 'stock' and it.active and it.reorder_point > 0 and coalesce((select sum(m.quantity) from stock_moves m where m.item_id = it.id), 0) <= it.reorder_point)`],
      ['expired', 'Expired lots to write off', 'inventory', on('inventory') && can(req, 'inventory.view'), sql`(select count(*) from (select m.lot_id from stock_moves m join stock_lots l on l.id = m.lot_id where m.workspace_id = ${ws.id} and l.expiry_date < ${today} group by m.lot_id, m.warehouse_id having sum(m.quantity) > 0) x)`],
      ['quarantine', 'Lots waiting for QC', 'inventory/quality', on('inventory') && can(req, 'inventory.view'), sql`(select count(*) from stock_lots l where l.workspace_id = ${ws.id} and l.status = 'quarantine')`],
      ['deliver', 'Orders to deliver', 'crm/orders', on('crm') && can(req, 'crm.view'), sql`(select count(*) from sales_orders o where o.workspace_id = ${ws.id} and o.status in ('confirmed', 'partly_delivered'))`],
      ['wo', 'Work orders open', 'manufacturing/work-orders', on('manufacturing') && can(req, 'manufacturing.view'), sql`(select count(*) from work_orders w where w.workspace_id = ${ws.id} and w.status in ('released', 'in_progress'))`],
      ['leave', 'Leave to decide', 'hr/leave', on('hr') && can(req, 'hr.manage'), sql`(select count(*) from leave_requests r where r.workspace_id = ${ws.id} and r.status = 'pending')`],
      ['tasks', 'Your open tasks', 'me', on('projects'), sql`(select count(*) from project_tasks t where t.workspace_id = ${ws.id} and t.assignee_id = ${req.auth!.user.id} and t.status <> 'done')`],
    ]
    const shown = counts.filter((c) => c[3])
    const todo: Dashboard['todo'] = []
    if (shown.length) {
      const [r] = await rows<Row>(sql`select ${sql.join(shown.map((c) => sql`${c[4]} as ${sql.identifier(c[0])}`), sql`, `)}`)
      for (const [key, label, to] of shown) {
        const count = Number(r?.[key] ?? 0)
        if (count > 0) todo.push({ key, label, count, to })
      }
    }
    return { dashboard: { money, todo } }
  })
}
