import Link from 'next/link'
import { Wallet, AlertCircle, CalendarCheck, Percent } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { Card } from '@/components/ui/Card'

// One compact business-health strip under the day plan: money in, money owed, work
// done this month, and how well quotes convert. Four numbers, one glance — the
// "how is my business doing?" half of the 7 AM view. Presentational only (values
// computed once server-side in the dashboard page).
export interface DashboardKpiValues {
  collected: number
  outstanding: number
  jobsThisMonth: number
  conversionRate: number
}

export function DashboardKpis({ collected, outstanding, jobsThisMonth, conversionRate }: DashboardKpiValues) {
  const tiles = [
    { label: 'Collected', value: formatCurrency(collected), icon: Wallet, color: 'text-emerald-400', bg: 'bg-emerald-500/10', href: '/dashboard/invoices' },
    { label: 'Outstanding', value: formatCurrency(outstanding), icon: AlertCircle, color: 'text-amber-400', bg: 'bg-amber-500/10', href: '/dashboard/invoices' },
    { label: 'Jobs This Month', value: String(jobsThisMonth), icon: CalendarCheck, color: 'text-accent', bg: 'bg-accent-dim', href: '/dashboard/schedule' },
    { label: 'Conversion', value: `${conversionRate}%`, icon: Percent, color: 'text-teal-400', bg: 'bg-teal-500/10', href: '/dashboard/quotes' },
  ]
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {tiles.map(({ label, value, icon: Icon, color, bg, href }) => (
        <Link key={label} href={href}
          className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          <Card className="p-4 h-full card-lift">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] font-semibold text-ink-muted uppercase tracking-wide">{label}</p>
              <div className={`w-7 h-7 rounded-lg ${bg} flex items-center justify-center`}>
                <Icon className={`w-3.5 h-3.5 ${color}`} />
              </div>
            </div>
            <p className="text-xl font-bold text-ink tracking-tight tabular-nums">{value}</p>
          </Card>
        </Link>
      ))}
    </div>
  )
}
