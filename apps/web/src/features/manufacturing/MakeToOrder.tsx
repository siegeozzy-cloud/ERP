import { formatPeso, hasFeature, WO_STATUS_LABELS, type SalesOrder, type WoStatus } from '@erp/shared'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Factory } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatQty } from '@/features/inventory/queries'
import { useCan, useWorkspace } from '@/features/workspaces/queries'
import { mfgQueries } from './queries'

/**
 * Make to order (Phase 8, the Discrete pack): on a sales order, the work orders made for it, what
 * they cost against what the order sells for, and a button to make each line that has a BOM.
 */
export function OrderProduction({ order }: { order: SalesOrder }) {
  const workspace = useWorkspace()
  const can = useCan()
  const navigate = useNavigate()
  const on = workspace.modules.includes('manufacturing') && can('manufacturing.view') && (hasFeature(workspace.template, 'makeToOrder') || order.workOrders.length > 0)
  const boms = useQuery({ ...mfgQueries.boms(workspace.id), enabled: on })
  if (!on || order.status === 'draft' || order.status === 'cancelled') return null
  const made = new Set(boms.data?.filter((b) => b.active).map((b) => b.item.id))
  const toMake = order.lines.filter((l) => made.has(l.item.id) && l.deliveredQty < l.quantity)
  const net = order.total - order.vatAmount
  return (
    <Card className="print:hidden">
      <CardHeader>
        <CardTitle>Production for this order</CardTitle>
        <CardDescription>
          {order.workOrders.length
            ? `Cost so far ${formatPeso(order.productionCost)} against ${formatPeso(net)} before VAT: ${formatPeso(net - order.productionCost)} left over.`
            : 'Make what it needs from the bills of materials; the cost shows here against the order.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        {order.workOrders.map((w) => (
          <Link key={w.id} to="/w/$workspaceId/manufacturing/work-orders/$id" params={{ workspaceId: workspace.id, id: w.id }} className="flex justify-between gap-3 hover:underline">
            <span>
              {w.number ?? 'Draft work order'} · {formatQty(w.quantity)} × {w.item} · {WO_STATUS_LABELS[w.status as WoStatus]}
            </span>
            <span className="tabular-nums">{formatPeso(w.cost)}</span>
          </Link>
        ))}
        {can('manufacturing.manage') &&
          toMake.map((l) => (
            <Button
              key={l.id}
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() =>
                void navigate({ to: '/w/$workspaceId/manufacturing/work-orders/new', params: { workspaceId: workspace.id }, search: { itemId: l.item.id, quantity: String(l.quantity - l.deliveredQty), salesOrderId: order.id } })
              }
            >
              <Factory />
              Make {formatQty(l.quantity - l.deliveredQty)} × {l.item.name}
            </Button>
          ))}
      </CardContent>
    </Card>
  )
}
