import Link from 'next/link'
import { Wallet, CalendarRange, AlertCircle } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'

// ── The money answer, above everything else ──────────────────────────────────
// Three figures the owner needs before the first coffee: what landed today, what
// the week has produced, and what's owed (with the overdue slice called out,
// because that's the part that needs a phone call). Every number is computed
// server-side in dashboard/page.tsx from THE ledger — this is presentation only.
//
// Overdue is the only tile that changes tone: money owed is normal, money owed
// PAST ITS DUE DATE is a problem. Today/this-week stay calm even at $0 — a slow
// morning isn't an alarm.

export interface MoneyBandValues {
  today: number
  todayCount: number
  week: number
  weekLabel: string
  owed: number
  owedCount: number
  overdue: number
  overdueCount: number
}

export function MoneyBand({ today, todayCount, week, weekLabel, owed, owedCount, overdue, overdueCount }: MoneyBandValues) {
  // A refund-heavy day nets negative. "-$300 · Nothing received yet" reads as a
  // bug, so the sub explains the sign instead of contradicting it.
  const todaySub = today < 0 ? 'Net of refunds'
    : todayCount > 0 ? `${todayCount} payment${todayCount !== 1 ? 's' : ''} received`
    : 'Nothing received yet'

  const tiles = [
    {
      key: 'today',
      // Short label on phones: at a third of a 390px screen the full label
      // truncates to noise. Under three money tiles "Today" is unambiguous.
      label: 'Money in today', short: 'Today',
      value: formatCurrency(today),
      sub: todaySub, subShort: today < 0 ? 'Net of refunds' : todayCount > 0 ? `${todayCount} received` : 'None yet',
      icon: Wallet,
      href: '/dashboard/invoices',
      tone: today > 0 ? 'text-emerald-400' : today < 0 ? 'text-amber-400' : 'text-ink',
      chip: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
      surface: 'border-border',
    },
    {
      key: 'week',
      label: 'Money in this week', short: 'This week',
      value: formatCurrency(week),
      sub: weekLabel, subShort: '7 days',
      icon: CalendarRange,
      href: '/dashboard/invoices',
      tone: 'text-ink',
      chip: 'bg-accent/10 border-accent/20 text-accent-text',
      surface: 'border-border',
    },
    {
      key: 'owed',
      label: 'Owed to you', short: 'Owed',
      value: formatCurrency(owed),
      // The overdue slice is the actionable part — say it plainly or say it's
      // clean. It survives onto the phone: it's the reason to tap.
      sub: overdue > 0
        ? `${formatCurrency(overdue)} overdue · ${overdueCount} invoice${overdueCount !== 1 ? 's' : ''}`
        : owedCount > 0 ? `${owedCount} invoice${owedCount !== 1 ? 's' : ''} · none overdue` : 'All settled',
      subShort: overdue > 0
        ? `${formatCurrency(overdue)} overdue`
        : owedCount > 0 ? 'None overdue' : 'All settled',
      icon: AlertCircle,
      // Plain /dashboard/invoices: the invoices page only parses ?invoice and
      // ?job, so ?status=overdue was silently ignored and the tile landed on the
      // unfiltered All list — a destination that contradicted the number clicked.
      // Better to promise nothing than to promise a filter that never applies.
      href: '/dashboard/invoices',
      tone: overdue > 0 ? 'text-amber-400' : 'text-ink',
      chip: overdue > 0 ? 'bg-amber-500/10 border-amber-500/20 text-amber-400' : 'bg-surface border-border text-ink-faint',
      surface: overdue > 0 ? 'border-amber-500/30' : 'border-border',
    },
  ]

  return (
    // 3-across at EVERY width, matching the KPI strip. Stacking the page's most
    // important band cost ~200px and pushed the ranked queue off a phone's first
    // screen — while the least important band fitted three across just fine.
    <div className="grid grid-cols-3 gap-2 sm:gap-3">
      {tiles.map(t => {
        const Icon = t.icon
        return (
          <Link key={t.key} href={t.href}
            className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <Card className={cn('p-3 sm:p-4 h-full card-lift', t.surface)}>
              <div className="flex items-center justify-between gap-1 mb-1.5 sm:mb-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint truncate">
                  <span className="sm:hidden">{t.short}</span>
                  <span className="hidden sm:inline">{t.label}</span>
                </p>
                {/* Decorative: the label already names the tile, so the icon
                    would just repeat it to a screen reader. Dropped on phones —
                    at a third of the width the number needs the room, and the
                    tile's tone already carries the signal. (`sm:` — this codebase
                    defines no `xs` breakpoint, and an undefined variant compiles
                    to nothing, silently hiding the icon at every size.) */}
                <span aria-hidden className={cn('w-7 h-7 rounded-lg border hidden sm:flex items-center justify-center shrink-0', t.chip)}>
                  <Icon className="w-3.5 h-3.5" />
                </span>
              </div>
              <p className={cn('text-lg sm:text-2xl font-black tracking-tight tabular-nums truncate', t.tone)}>{t.value}</p>
              <p className="text-[10px] sm:text-[11px] text-ink-muted mt-0.5 sm:mt-1 tabular-nums truncate">
                <span className="sm:hidden">{t.subShort}</span>
                <span className="hidden sm:inline">{t.sub}</span>
              </p>
            </Card>
          </Link>
        )
      })}
    </div>
  )
}
