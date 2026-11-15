import { Outlet } from '@tanstack/react-router'
import { Boxes, Landmark, Users } from 'lucide-react'
import { Brand } from '@/components/brand'

const POINTS = [
  { icon: Landmark, text: 'Books, invoices and VAT that follow BIR rules' },
  { icon: Users, text: 'Payroll with SSS, PhilHealth and Pag-IBIG built in' },
  { icon: Boxes, text: 'Inventory, sales and production in one place' },
]

/** Signed-out pages: a short pitch on wide screens, and the form. */
export function AuthLayout() {
  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      <aside className="bg-sidebar hidden flex-col justify-between border-r p-10 lg:flex">
        <Brand />
        <div className="max-w-md space-y-6">
          <h1 className="text-3xl font-semibold tracking-tight">One system for running a Philippine business.</h1>
          <ul className="space-y-4">
            {POINTS.map(({ icon: Icon, text }) => (
              <li key={text} className="text-muted-foreground flex items-center gap-3">
                <Icon className="text-foreground size-5 shrink-0" />
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-muted-foreground text-xs">Demo – not registered with the BIR.</p>
      </aside>
      <main className="flex flex-col items-center justify-center px-4 py-10">
        <Brand className="mb-8 lg:hidden" />
        <div className="w-full max-w-sm">
          <Outlet />
        </div>
      </main>
    </div>
  )
}

/** Title and one line of explanation at the top of each signed-out form. */
export function AuthHeading({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 space-y-1.5">
      <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      {children && <p className="text-muted-foreground text-sm">{children}</p>}
    </div>
  )
}
