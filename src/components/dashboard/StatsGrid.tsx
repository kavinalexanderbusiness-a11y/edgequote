import { DollarSign, TrendingUp, Percent, Wallet, AlertCircle, CalendarCheck } from 'lucide-react'
import { DashboardStats } from '@/types'
import { formatCurrency } from '@/lib/utils'
import { Card } from '@/components/ui/Card'

interface StatsGridProps {
  stats: DashboardStats
}

export function StatsGrid({ stats }: StatsGridProps) {
  // Six tiles, one story: money (booked → collected → outstanding), work done,
  // momentum, close rate. All-time vanity counts ("Total Quotes") and raw pending
  // counts were dropped — the actionable version of pending work already sits in
  // Today's Priorities with a dollar figure attached.
  const cards = [
    {
      // One card for accepted work — the count lives in the sub so the same dollar
      // figure isn't rendered twice in the grid (it also appeared under "Accepted Jobs").
      label: 'Booked Revenue',
      value: formatCurrency(stats.acceptedRevenue),
      sub: `${stats.acceptedJobs} accepted quote${stats.acceptedJobs !== 1 ? 's' : ''}`,
      icon: DollarSign,
      color: 'text-accent',
      bg: 'bg-accent-dim',
    },
    {
      label: 'Collected',
      value: formatCurrency(stats.collectedRevenue),
      sub: 'Invoices paid',
      icon: Wallet,
      color: 'text-emerald-400',
      bg: 'bg-emerald-500/10',
    },
    {
      label: 'Outstanding',
      value: formatCurrency(stats.outstandingRevenue),
      sub: 'Billed, unpaid',
      icon: AlertCircle,
      color: 'text-amber-400',
      bg: 'bg-amber-500/10',
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
      label: 'This Month',
      value: formatCurrency(stats.monthlyRevenue),
      sub: 'Quoted this month',
      icon: TrendingUp,
      color: 'text-purple-400',
      bg: 'bg-purple-500/10',
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
    <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
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