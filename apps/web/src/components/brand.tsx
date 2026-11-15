import { APP_NAME } from '@erp/shared'
import { cn } from '@/lib/utils'

/** The product mark and name. Placeholder until there's a real logo. */
export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2 font-semibold tracking-tight', className)}>
      <span aria-hidden className="bg-primary text-primary-foreground grid size-8 place-items-center rounded-lg text-sm font-bold">
        {APP_NAME.slice(0, 1)}
      </span>
      {APP_NAME}
    </span>
  )
}
