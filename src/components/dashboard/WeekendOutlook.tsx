import Link from 'next/link'
import { format, parseISO } from 'date-fns'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { formatCurrency, cn } from '@/lib/utils'
import type { DayPlan } from '@/lib/dashboard/dayPlan'
import { CalendarRange, Phone, MapPin, DollarSign, Clock, Plus } from 'lucide-react'

// The owner's next work days at a glance — planned revenue, hours, the stops
// (with glove-friendly call/map), and which days are still open. The aggregation
// lives in lib/dashboard/dayPlan (pure, reuses the one valuation + route/capacity
// engines); this file is presentation only. Server-rendered: today's work is on
// screen at first paint instead of arriving after a skeleton.
export function WeekendOutlook({ plan }: { plan: DayPlan }) {
  const { groups, totalJobs, totalHours, totalRevenue } = plan

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-2.5">
          <span className="w-7 h-7 rounded-lg bg-accent/15 border border-accent/25 flex items-center justify-center shrink-0">
            <CalendarRange className="w-4 h-4 text-accent-text" />
          </span>
          <h2 className="text-sm font-bold tracking-tight text-ink">Your next work days</h2>
        </span>
        <span className="ml-auto flex items-center gap-3 text-xs text-ink-muted tabular-nums">
          <span className="flex items-center gap-1"><DollarSign className="w-3 h-3 text-accent-text" />{formatCurrency(totalRevenue)}</span>
          <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{totalHours}h</span>
          <span>{totalJobs} job{totalJobs !== 1 ? 's' : ''}</span>
        </span>
      </CardHeader>
      <CardBody className="p-0">
        <div className="divide-y divide-border">
          {groups.map(g => (
            // Today gets a faint accent wash + a Today chip — of three near-identical
            // rows, the owner should never have to work out which one is this morning.
            <div key={g.date} className={cn('px-5 py-3', g.isToday && 'bg-accent/[0.04]')}>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <p className="text-sm font-semibold tracking-tight text-ink flex items-center gap-2">
                  {g.weekday} <span className="text-ink-faint font-normal">{format(parseISO(g.date + 'T00:00:00'), 'MMM d')}</span>
                  {g.isToday && (
                    <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-accent-text bg-accent/10 border border-accent/25 rounded px-1.5 py-0.5">Today</span>
                  )}
                </p>
                {g.jobs.length > 0 ? (
                  <span className="text-xs text-ink-muted flex items-center gap-1.5 flex-wrap justify-end tabular-nums">
                    <span>{g.jobs.length} job{g.jobs.length !== 1 ? 's' : ''} · {g.hours}h · done ~{g.finish} · <span className="text-accent-text font-semibold">{formatCurrency(g.revenue)}</span></span>
                    {g.loadState !== 'full' && (
                      <span className={cn('text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border',
                        g.loadState === 'overloaded' ? 'text-red-400 border-red-500/30 bg-red-500/10' : 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10')}>
                        {g.loadState === 'overloaded' ? 'Overloaded' : 'Room'}
                      </span>
                    )}
                  </span>
                ) : (
                  // Accent, not amber — open capacity is opportunity, and amber is reserved for risk on this page.
                  <Link href="/dashboard/schedule" className="text-xs text-accent-text font-medium flex items-center gap-1 hover:underline"><Plus className="w-3 h-3" /> Open — add a job</Link>
                )}
              </div>
              {g.jobs.length > 0 && (
                <div className="space-y-1">
                  {g.jobs.map(j => (
                    <div key={j.id} className="flex items-center justify-between gap-2 text-xs">
                      <span className="min-w-0 flex items-center gap-1.5 text-ink">
                        {j.start_time && <span className="text-ink-faint shrink-0 tabular-nums">{j.start_time.slice(0, 5)}</span>}
                        <span className="truncate font-medium">{j.customer_name}</span>
                        {j.service_type && <span className="text-ink-faint truncate hidden sm:inline">· {j.service_type}</span>}
                      </span>
                      <span className="flex items-center gap-1 shrink-0">
                        <span className={cn('tabular-nums', j.value > 0 ? 'text-ink-muted' : 'text-amber-400')}>{j.value > 0 ? formatCurrency(j.value) : '$?'}</span>
                        {/* 40px hit areas — these get tapped with gloves on */}
                        {j.phone && <a href={`tel:${j.phone}`} className="text-accent-text hover:opacity-80 w-10 h-10 -my-2.5 flex items-center justify-center" title="Call"><Phone className="w-4 h-4" /></a>}
                        {j.address && <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(j.address)}`} target="_blank" rel="noopener noreferrer" className="text-ink-muted hover:text-ink w-10 h-10 -my-2.5 flex items-center justify-center" title="Map"><MapPin className="w-4 h-4" /></a>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="px-5 py-2.5 border-t border-border">
          <Link href="/dashboard/schedule" className="text-xs text-accent-text font-medium hover:underline">Open Schedule →</Link>
        </div>
      </CardBody>
    </Card>
  )
}
