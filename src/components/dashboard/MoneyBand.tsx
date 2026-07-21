import Link from 'next/link'
import { Wallet, CalendarRange, AlertCircle, Send, TrendingUp, TrendingDown } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'

// ── The money answer, above everything else ──────────────────────────────────
// Four figures, one glance: what landed today, what the week produced (against
// the week before it), what's owed (with the overdue slice called out), and
// what's sitting in quotes waiting for an answer. Past → present → due → maybe:
// the whole money story left to right. Every number is computed server-side in
// lib/dashboard/data from THE ledger — this is presentation only.
//
// THE DELTA IS ABSOLUTE, NOT A PERCENT. "vs $850 the week before" reads honestly
// at every size of business; "+340%" on a $120 week is technically true and
// practically noise. The arrow carries direction (the canonical emerald/red
// TrendingUp/Down vocabulary from the intelligence page); the text stays muted —
// direction is information, alarm is not.
//
// Overdue is the only tile that changes tone: money owed is normal, money owed
// PAST ITS DUE DATE is a problem. Today/this-week stay calm even at $0 — a slow
// morning isn't an alarm.

export interface MoneyBandValues {
  today: number
  todayCount: number
  week: number
  /** The 7 days before the current window — the delta's baseline. */
  weekPrev: number
  owed: number
  owedCount: number
  overdue: number
  overdueCount: number
  /** Sent quotes awaiting an answer — the pipeline, from rows already loaded. */
  quotesOut: number
  quotesOutCount: number
}

export function MoneyBand({ today, todayCount, week, weekPrev, owed, owedCount, overdue, overdueCount, quotesOut, quotesOutCount }: MoneyBandValues) {
  // A refund-heavy day nets negative. "-$300 · Nothing received yet" reads as a
  // bug, so the sub explains the sign instead of contradicting it.
  const todaySub = today < 0 ? 'Net of refunds'
    : todayCount > 0 ? `${todayCount} payment${todayCount !== 1 ? 's' : ''} received`
    : 'Nothing received yet'

  // Only claim a comparison when the baseline exists. A brand-new business's
  // second week "up from $0" is not an insight, it's an artifact.
  const weekDelta = weekPrev > 0 ? (
    <span className="inline-flex items-center gap-1">
      {week >= weekPrev
        ? <TrendingUp aria-hidden className="w-3 h-3 text-emerald-400 shrink-0" />
        : <TrendingDown aria-hidden className="w-3 h-3 text-red-400 shrink-0" />}
      <span>vs {formatCurrency(weekPrev)} week before</span>
    </span>
  ) : null

  const tiles = [
    {
      key: 'today',
      // Short label on phones: at a quarter of a 390px screen the full label
      // truncates to noise. Under four money tiles "Today" is unambiguous.
      label: 'Money in today', short: 'Today',
      value: formatCurrency(today),
      sub: todaySub,
      subShort: today < 0 ? 'Refunds' : todayCount > 0 ? `${todayCount} received` : 'None yet',
      icon: Wallet,
      href: '/dashboard/invoices',
      tone: today > 0 ? 'text-emerald-400' : today < 0 ? 'text-amber-400' : 'text-ink',
      chip: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
      surface: 'border-border',
    },
    {
      key: 'week',
      label: 'Money in this week', short: 'Week',
      value: formatCurrency(week),
      sub: weekDelta ?? 'Last 7 days',
      subShort: weekDelta ? (week >= weekPrev ? '↑ on last week' : '↓ on last week') : '7 days',
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
      // ?job, so a status filter param would be silently ignored. Better to
      // promise nothing than a filter that never applies.
      href: '/dashboard/invoices',
      tone: overdue > 0 ? 'text-amber-400' : 'text-ink',
      chip: overdue > 0 ? 'bg-amber-500/10 border-amber-500/20 text-amber-400' : 'bg-surface border-border text-ink-faint',
      surface: overdue > 0 ? 'border-amber-500/30' : 'border-border',
    },
    {
      key: 'quotesOut',
      label: 'Quotes out', short: 'Quoted',
      value: formatCurrency(quotesOut),
      sub: quotesOutCount > 0
        ? `${quotesOutCount} awaiting an answer`
        : 'Nothing out for decision',
      subShort: quotesOutCount > 0 ? `${quotesOutCount} waiting` : 'None out',
      icon: Send,
      href: '/dashboard/quotes',
      tone: 'text-ink',
      chip: 'bg-sky-500/10 border-sky-500/20 text-sky-400',
      surface: 'border-border',
    },
  ]

  return (
    // 2×2 on phones, 4-across from sm. Four tiles at grid-cols-4 on a 390px
    // screen leaves ~90px per money figure — the numbers this band exists for
    // would truncate. 2×2 keeps every figure legible and the band above the
    // queue either way.
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
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
                    the number needs the room, and the tile's tone already
                    carries the signal. (`sm:` — this codebase defines no `xs`
                    breakpoint, and an undefined variant compiles to nothing,
                    silently hiding the icon at every size.) */}
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
