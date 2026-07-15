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
    // Short labels below sm, exactly as MoneyBand does: at a third of a 390px
    // screen "Jobs This Month" wraps into noise. Same tile, same rules.
    { label: 'Collected', short: 'Collected', value: formatCurrency(collected), sub: 'All time', subShort: 'All time', icon: Wallet, color: 'text-emerald-400', bg: 'bg-emerald-500/10', href: '/dashboard/invoices' },
    { label: 'Jobs This Month', short: 'Jobs', value: String(jobsThisMonth), sub: 'Completed', subShort: 'This month', icon: CalendarCheck, color: 'text-accent-text', bg: 'bg-accent-dim', href: '/dashboard/schedule' },
    // —, not 0%: with no decided quotes there is no rate, and "0%" on a brand
    // new business's first morning is a false claim, not a metric.
    { label: 'Conversion', short: 'Conversion', value: conversionRate == null ? '—' : `${conversionRate}%`, sub: conversionRate == null ? 'No quotes yet' : 'Quotes accepted', subShort: conversionRate == null ? 'No quotes' : 'Accepted', icon: Percent, color: 'text-teal-400', bg: 'bg-teal-500/10', href: '/dashboard/quotes' },
  ]
  return (
    // Geometry matched to MoneyBand tile-for-tile — same grid, gap, padding, type
    // scale and icon rule. Two three-across money strips on one page that don't
    // line up is the kind of thing you feel without being able to name it.
    <div className="grid grid-cols-3 gap-2 sm:gap-3">
      {tiles.map(({ label, short, value, sub, subShort, icon: Icon, color, bg, href }) => (
        <Link key={label} href={href}
          className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          <Card className="p-3 sm:p-4 h-full card-lift">
            <div className="flex items-center justify-between gap-1 mb-1.5 sm:mb-2">
              <p className="text-[10px] font-semibold text-ink-faint uppercase tracking-[0.14em] truncate">
                <span className="sm:hidden">{short}</span>
                <span className="hidden sm:inline">{label}</span>
              </p>
              {/* Decorative — the label already names the tile. Dropped on phones
                  so the number keeps the width. */}
              <div aria-hidden className={`w-7 h-7 rounded-lg ${bg} hidden sm:flex items-center justify-center shrink-0`}>
                <Icon className={`w-3.5 h-3.5 ${color}`} />
              </div>
            </div>
            <p className="text-lg sm:text-xl font-black text-ink tracking-tight tabular-nums truncate">{value}</p>
            <p className="text-[10px] sm:text-[11px] text-ink-faint mt-0.5 truncate">
              <span className="sm:hidden">{subShort}</span>
              <span className="hidden sm:inline">{sub}</span>
            </p>
          </Card>
        </Link>
      ))}
    </div>
  )
}
