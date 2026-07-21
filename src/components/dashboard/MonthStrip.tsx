import Link from 'next/link'
import { Wallet, CalendarCheck, Percent, TrendingUp, TrendingDown } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'

// ── This month, against last month ───────────────────────────────────────────
// The slow-moving half of the business, last on the page — and every figure
// carries its own baseline, because an absolute number can't be judged in the
// ten seconds this page gets. $2,480 collected means nothing on its own;
// "vs $1,900 by this point last month" is a verdict.
//
// Replaces the old KPI strip's "Collected — All time": a lifetime cumulative
// only ever goes up and never changes what the owner does this morning — the
// same class as the deliberately-deleted vanity stats, surviving under a
// different name. The month window is the one an owner actually manages in.
//
// The comparison is month-to-date vs the SAME point of last month (computed by
// THE ledger engine in lib/dashboard/data) — a partial month against a full one
// would read "down" until the 28th every single month.

export interface MonthStripValues {
  collected: number
  collectedLastMonthToDate: number
  jobsDone: number
  jobsDoneLastMonth: number
  conversionRate: number | null
}

export function MonthStrip({ collected, collectedLastMonthToDate, jobsDone, jobsDoneLastMonth, conversionRate }: MonthStripValues) {
  // Deltas only when the baseline exists — "up from $0" on month two of a new
  // business is an artifact, not an insight. Absolute figures, never percents:
  // small-business months are small numbers, and a percent on a small base is
  // technically true and practically noise.
  const collectedDelta = collectedLastMonthToDate > 0 ? (
    <span className="inline-flex items-center gap-1">
      {collected >= collectedLastMonthToDate
        ? <TrendingUp aria-hidden className="w-3 h-3 text-emerald-400 shrink-0" />
        : <TrendingDown aria-hidden className="w-3 h-3 text-red-400 shrink-0" />}
      <span>vs {formatCurrency(collectedLastMonthToDate)} by now last month</span>
    </span>
  ) : null

  const jobsDelta = jobsDoneLastMonth > 0 ? (
    <span className="inline-flex items-center gap-1">
      {jobsDone >= jobsDoneLastMonth
        ? <TrendingUp aria-hidden className="w-3 h-3 text-emerald-400 shrink-0" />
        : <TrendingDown aria-hidden className="w-3 h-3 text-red-400 shrink-0" />}
      <span>vs {jobsDoneLastMonth} by now last month</span>
    </span>
  ) : null

  const tiles = [
    {
      key: 'collected',
      label: 'Collected this month', short: 'This month',
      value: formatCurrency(collected),
      sub: collectedDelta ?? 'Payments received',
      subShort: collectedDelta ? (collected >= collectedLastMonthToDate ? '↑ on last month' : '↓ on last month') : 'Received',
      icon: Wallet, color: 'text-emerald-400', bg: 'bg-emerald-500/10',
      href: '/dashboard/invoices',
    },
    {
      key: 'jobs',
      label: 'Jobs done this month', short: 'Jobs',
      value: String(jobsDone),
      sub: jobsDelta ?? 'Completed',
      subShort: jobsDelta ? (jobsDone >= jobsDoneLastMonth ? '↑ on last month' : '↓ on last month') : 'Completed',
      icon: CalendarCheck, color: 'text-accent-text', bg: 'bg-accent-dim',
      href: '/dashboard/schedule',
    },
    {
      // —, not 0%: with no decided quotes there is no rate, and "0%" on a brand
      // new business's first morning is a false claim, not a metric.
      key: 'conversion',
      label: 'Conversion', short: 'Conversion',
      value: conversionRate == null ? '—' : `${conversionRate}%`,
      sub: conversionRate == null ? 'No quotes decided yet' : 'Of all decided quotes',
      subShort: conversionRate == null ? 'No quotes' : 'Accepted',
      icon: Percent, color: 'text-teal-400', bg: 'bg-teal-500/10',
      href: '/dashboard/quotes',
    },
  ]

  return (
    // Geometry matched to MoneyBand tile-for-tile — same padding, type scale and
    // icon rule — but deliberately 3-across vs the hero's 4: same family,
    // visibly the supporting band, not a second hero.
    <div className="grid grid-cols-3 gap-2 sm:gap-3">
      {tiles.map(({ key, label, short, value, sub, subShort, icon: Icon, color, bg, href }) => (
        <Link key={key} href={href}
          className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          <Card className="p-3 sm:p-4 h-full card-lift">
            <div className="flex items-center justify-between gap-1 mb-1.5 sm:mb-2">
              <p className="text-[10px] font-semibold text-ink-faint uppercase tracking-[0.14em] truncate">
                <span className="sm:hidden">{short}</span>
                <span className="hidden sm:inline">{label}</span>
              </p>
              {/* Decorative — the label already names the tile. Dropped on phones
                  so the number keeps the width. */}
              <div aria-hidden className={cn('w-7 h-7 rounded-lg hidden sm:flex items-center justify-center shrink-0', bg)}>
                <Icon className={cn('w-3.5 h-3.5', color)} />
              </div>
            </div>
            <p className="text-lg sm:text-xl font-black text-ink tracking-tight tabular-nums truncate">{value}</p>
            <p className="text-[10px] sm:text-[11px] text-ink-muted mt-0.5 tabular-nums truncate">
              <span className="sm:hidden">{subShort}</span>
              <span className="hidden sm:inline">{sub}</span>
            </p>
          </Card>
        </Link>
      ))}
    </div>
  )
}
