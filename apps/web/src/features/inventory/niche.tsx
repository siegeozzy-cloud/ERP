import { hasFeature, templateByKey } from '@erp/shared'
import { useQuery } from '@tanstack/react-query'
import { TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useCan, useWorkspace } from '@/features/workspaces/queries'
import { formatDate, today } from '@/lib/dates'
import { inventoryQueries } from './queries'

// Niche pieces shown across modules (Phase 8): hazard details under items on deliveries and
// invoices, licence numbers in a document's header, and licences about to expire.

/** Under an item on a delivery receipt or invoice: its printed fields (Chemical: UN number, hazard class). */
export function HazardNote({ itemId }: { itemId: string | null | undefined }) {
  const workspace = useWorkspace()
  const can = useCan()
  const on = hasFeature(workspace.template, 'hazard') && can('inventory.view') && !!itemId
  const items = useQuery({ ...inventoryQueries.items(workspace.id), enabled: on })
  if (!on) return null
  const item = items.data?.find((i) => i.id === itemId)
  const printed = (templateByKey(workspace.template)?.itemFields ?? []).filter((f) => f.printed && item?.attributes[f.key])
  if (!printed.length) return null
  return <span className="block text-xs font-medium">{printed.map((f) => item!.attributes[f.key]).join(' · ')}</span>
}

/** The business's licence numbers, for a document's header (FDA LTO, PCAB licence and category). */
export function LicenceLines() {
  const workspace = useWorkspace()
  const shown = (templateByKey(workspace.template)?.licences ?? []).filter((l) => workspace.licences?.[l.key])
  if (!shown.length) return null
  return (
    <>
      {shown.map((l) => (
        <p key={l.key} className="text-muted-foreground text-sm">
          {l.label.replace(/ no\.$/, '')} {workspace.licences[l.key]}
        </p>
      ))}
    </>
  )
}

/** On the dashboard: licences expired, or expiring within 60 days. */
export function LicenceWarnings() {
  const workspace = useWorkspace()
  const soon = new Date(Date.parse(`${today()}T00:00:00Z`) + 60 * 86_400_000).toISOString().slice(0, 10)
  const due = (templateByKey(workspace.template)?.licences ?? [])
    .filter((l) => l.expires)
    .map((l) => ({ label: l.label.replace(/ no\.$/, ''), on: workspace.licences?.[`${l.key}_expires`] }))
    .filter((l): l is { label: string; on: string } => !!l.on && l.on <= soon)
  if (!due.length) return null
  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertDescription>
        {due.map((d) => (
          <span key={d.label} className="block">
            {d.label} {d.on < today() ? 'expired' : 'expires'} on {formatDate(d.on)}. Renew it, then update it in Settings → Workspace.
          </span>
        ))}
      </AlertDescription>
    </Alert>
  )
}
