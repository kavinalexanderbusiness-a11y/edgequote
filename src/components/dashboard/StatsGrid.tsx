import { DollarSign, Percent, Wallet, CalendarCheck } from 'lucide-react'
import { DashboardStats } from '@/types'
import { formatCurrency } from '@/lib/utils'
import { Card } from '@/components/ui/Card'

interface StatsGridProps {
  stats: DashboardStats
}

// The at-a-glance business-health strip — four numbers that tell the whole story
// (cash in, revenue won, work shipped, win rate). Deliberately NOT nine tiles:
// "Outstanding" is already an actionable row in Today's Priorities, and Total Quotes
// / This Month / Pending were vanity or duplicates. This stays a glance, not a report.
export function StatsGrid({ stats }: StatsGridProps) {
  const cards = [
    {
      label: 'Collected',
      value: formatCurrency(stats.collectedRevenue),
      sub: 'Invoices paid',
      icon: Wallet,
      color: 'text-emerald-400',
      bg: 'bg-emerald-500/10',
    },
    {
      label: 'Booked Revenue',
      value: formatCurrency(stats.acceptedRevenue),
      sub: 'Accepted quotes',
      icon: DollarSign,
      color: 'text-accent',
      bg: 'bg-accent-dim',
    },
    {
      label: 'Jobs Done',
      value: stats.jobsDone.toString(),
      sub: stats.jobsDoneThisMonth + ' this month',
      icon: CalendarCheck,
      color: 'text-emerald-400',
      bg: 'bg-emerald-500/10',
    },
    {
      label: 'Conversion Rate',
      value: stats.conversionRate + '%',
      sub: 'Accepted vs decided',
      icon: Percent,
      color: 'text-teal-400',
      bg: 'bg-teal-500/10',
    },
  ]

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map(({ label, value, sub, icon: Icon, color, bg }) => (
        <Card key={label} className="p-5">
          <div className="flex items-start justify-between mb-3">
            <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">{label}</p>
            <div className={`w-8 h-8 rounded-lg ${bg} flex items-center justify-center`}>
              <Icon className={`w-4 h-4 ${color}`} />
            </div>
          </div>
          <p className="text-2xl font-bold text-ink tracking-tight">{value}</p>
          <p className="text-xs text-ink-faint mt-1">{sub}</p>
        </Card>
      ))}
    </div>
  )
}