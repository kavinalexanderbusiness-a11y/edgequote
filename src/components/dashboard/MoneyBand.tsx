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
  const tiles = [
    {
      key: 'today',
      label: 'Money in today',
      value: formatCurrency(today),
      sub: todayCount > 0
        ? `${todayCount} payment${todayCount !== 1 ? 's' : ''} received`
        : 'Nothing received yet',
      icon: Wallet,
      href: '/dashboard/invoices',
      tone: today > 0 ? 'text-emerald-400' : 'text-ink',
      chip: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
      surface: 'border-border',
    },
    {
      key: 'week',
      label: 'Money in this week',
      value: formatCurrency(week),
      sub: weekLabel,
      icon: CalendarRange,
      href: '/dashboard/invoices',
      tone: 'text-ink',
      chip: 'bg-accent/10 border-accent/20 text-accent-text',
      surface: 'border-border',
    },
    {
      key: 'owed',
      label: 'Owed to you',
      value: formatCurrency(owed),
      // The overdue slice is the actionable part — say it plainly or say it's clean.
      sub: overdue > 0
        ? `${formatCurrency(overdue)} overdue · ${overdueCount} invoice${overdueCount !== 1 ? 's' : ''}`
        : owedCount > 0 ? `${owedCount} invoice${owedCount !== 1 ? 's' : ''} · none overdue` : 'All settled',
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
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {tiles.map(t => {
        const Icon = t.icon
        return (
          <Link key={t.key} href={t.href}
            className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <Card className={cn('p-4 h-full card-lift', t.surface)}>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">{t.label}</p>
                <span className={cn('w-7 h-7 rounded-lg border flex items-center justify-center shrink-0', t.chip)}>
                  <Icon className="w-3.5 h-3.5" />
                </span>
              </div>
              <p className={cn('text-2xl font-black tracking-tight tabular-nums', t.tone)}>{t.value}</p>
              <p className="text-[11px] text-ink-muted mt-1 tabular-nums truncate">{t.sub}</p>
            </Card>
          </Link>
        )
      })}
    </div>
  )
}
