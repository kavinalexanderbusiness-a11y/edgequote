import Link from 'next/link'
import { Wallet, CalendarCheck, Percent } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { Card } from '@/components/ui/Card'

// The slow-moving "how is my business doing?" strip, last on the 7 AM view:
// lifetime money in, work done this month, and how well quotes convert.
// Outstanding deliberately lives in MoneyBand at the TOP now — it's a today
// number, not a trend, and two "owed" figures on one screen would invite the
// question "which one is real?". Presentational only (values computed once
// server-side in the dashboard page).
export interface DashboardKpiValues {
  collected: number
  jobsThisMonth: number
  conversionRate: number | null
}

export function DashboardKpis({ collected, jobsThisMonth, conversionRate }: DashboardKpiValues) {
  const tiles = [
    { label: 'Collected', value: formatCurrency(collected), sub: 'All time', icon: Wallet, color: 'text-emerald-400', bg: 'bg-emerald-500/10', href: '/dashboard/invoices' },
    { label: 'Jobs This Month', value: String(jobsThisMonth), sub: 'Completed', icon: CalendarCheck, color: 'text-accent-text', bg: 'bg-accent-dim', href: '/dashboard/schedule' },
    // —, not 0%: with no decided quotes there is no rate, and "0%" on a brand
    // new business's first morning is a false claim, not a metric.
    { label: 'Conversion', value: conversionRate == null ? '—' : `${conversionRate}%`, sub: conversionRate == null ? 'No quotes yet' : 'Quotes accepted', icon: Percent, color: 'text-teal-400', bg: 'bg-teal-500/10', href: '/dashboard/quotes' },
  ]
  return (
    <div className="grid grid-cols-3 gap-3">
      {tiles.map(({ label, value, sub, icon: Icon, color, bg, href }) => (
        <Link key={label} href={href}
          className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          <Card className="p-4 h-full card-lift">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-semibold text-ink-faint uppercase tracking-wide">{label}</p>
              <div className={`w-7 h-7 rounded-lg ${bg} flex items-center justify-center`}>
                <Icon className={`w-3.5 h-3.5 ${color}`} />
              </div>
            </div>
            <p className="text-xl font-black text-ink tracking-tight tabular-nums">{value}</p>
            <p className="text-[11px] text-ink-faint mt-0.5">{sub}</p>
          </Card>
        </Link>
      ))}
    </div>
  )
}
