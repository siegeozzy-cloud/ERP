import { sql } from 'drizzle-orm'
import type { Executor } from '../../db/types.ts'
import { todayInManila } from '../finance/ledger.ts'

export type Exposure = { owed: number; overdue: number; onOrder: number }

/**
 * What customers owe and have on order, for the credit check and the customer pages:
 * - owed: posted invoices less what's been paid or withheld on them
 * - overdue: the part of that past its due date
 * - onOrder: confirmed orders not invoiced yet, at their order prices
 */
export async function exposureOf(db: Executor, workspaceId: string, customerId?: string) {
  const today = todayInManila()
  const rows = await db.execute<{ id: string; owed: string; overdue: string; on_order: string }>(sql`
    with balances as (
      select i.customer_id, i.due_date,
        i.amount_due - coalesce((select sum(p.amount + p.withheld) from payments p where p.invoice_id = i.id and p.status = 'posted'), 0) as balance
      from sales_invoices i
      where i.workspace_id = ${workspaceId} and i.status = 'posted'
    ),
    ordered as (
      select o.customer_id, sum(round(l.gross * (l.quantity - least(l.invoiced_qty, l.quantity)) / l.quantity)) as value
      from sales_lines l
      join sales_orders o on o.id = l.order_id
      where o.workspace_id = ${workspaceId} and o.status in ('confirmed', 'partly_delivered', 'delivered')
      group by o.customer_id
    )
    select c.id,
      coalesce((select sum(b.balance) from balances b where b.customer_id = c.id), 0)::bigint as owed,
      coalesce((select sum(b.balance) from balances b where b.customer_id = c.id and b.due_date < ${today}), 0)::bigint as overdue,
      coalesce((select value from ordered o where o.customer_id = c.id), 0)::bigint as on_order
    from contacts c
    where c.workspace_id = ${workspaceId} and c.is_customer ${customerId ? sql`and c.id = ${customerId}` : sql``}
  `)
  return new Map<string, Exposure>(rows.rows.map((r) => [r.id, { owed: Number(r.owed), overdue: Number(r.overdue), onOrder: Number(r.on_order) }]))
}
