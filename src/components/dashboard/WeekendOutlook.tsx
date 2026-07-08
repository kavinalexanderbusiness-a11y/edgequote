'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { addDays, format, getDay, parseISO } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { formatCurrency } from '@/lib/utils'
import { jobVisitValue, effectiveFreq } from '@/lib/invoicing'
import { todayLocalISO } from '@/lib/geo'
import { roughFinishEstimate, dayLoad } from '@/lib/route'
import { cn } from '@/lib/utils'
import { CalendarRange, Phone, MapPin, DollarSign, Clock, Plus } from 'lucide-react'

const DEFAULT_WORK_DAYS = [5, 6, 0]
const DEFAULT_MIN = 45
const DAYS_TO_SHOW = 3

interface DayJob {
  id: string; customer_name: string; phone: string | null; address: string | null
  service_type: string | null; start_time: string | null; value: number
}
interface DayGroup { date: string; weekday: string; jobs: DayJob[]; hours: number; revenue: number; finish: string; loadState: 'overloaded' | 'full' | 'room' }

// "This weekend" command center on home: the owner's next work days at a glance —
// planned revenue, hours, the stops (with call/map), and which days are still open.
// Reuses the one valuation engine; aggregates per day. No new engine.
export function WeekendOutlook() {
  const supabase = createClient()
  const [groups, setGroups] = useState<DayGroup[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      // Local session read — no auth round-trip before the RLS-scoped queries below.
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      const [jRes, qRes, rRes, sRes] = await Promise.all([
        supabase.from('jobs')
          .select('id, scheduled_date, status, start_time, service_type, duration_minutes, price, quote_id, recurrence_id, customers(name, phone), properties(address)')
          .eq('user_id', user!.id).gte('scheduled_date', todayLocalISO())
          // The scan window below maxes out at 21 days — don't download a whole
          // season of materialized recurring visits just to keep 3 dates.
          .lte('scheduled_date', format(addDays(parseISO(todayLocalISO()), 21), 'yyyy-MM-dd'))
          .in('status', ['scheduled', 'in_progress'])
          .order('start_time', { nullsFirst: true }),
        supabase.from('quotes').select('id, total, initial_price, weekly_price, biweekly_price, monthly_price').eq('user_id', user!.id),
        supabase.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', user!.id),
        supabase.from('business_settings').select('preferred_work_days, work_start_time, daily_capacity_hours').eq('user_id', user!.id).maybeSingle(),
      ])
      const quotesById: Record<string, Record<string, unknown>> = {}
      for (const q of (qRes.data as Record<string, unknown>[]) || []) quotesById[q.id as string] = q
      const recById: Record<string, { freq: string | null; interval_unit: string | null; interval_count: number | null }> = {}
      for (const r of (rRes.data as { id: string; freq: string | null; interval_unit: string | null; interval_count: number | null }[]) || []) recById[r.id] = r
      const sRow = sRes.data as { preferred_work_days: number[] | null; work_start_time: string | null; daily_capacity_hours: number | null } | null
      const pref = sRow?.preferred_work_days?.length ? sRow.preferred_work_days : DEFAULT_WORK_DAYS
      const prefSet = new Set(pref)
      const workStart = sRow?.work_start_time || '08:00'
      const capacity = sRow?.daily_capacity_hours && sRow.daily_capacity_hours > 0 ? sRow.daily_capacity_hours : 8

      // The next DAYS_TO_SHOW preferred work days from today.
      const wantDates: string[] = []
      let d = parseISO(todayLocalISO())
      for (let i = 0; i < 21 && wantDates.length < DAYS_TO_SHOW; i++) {
        if (prefSet.has(getDay(d))) wantDates.push(format(d, 'yyyy-MM-dd'))
        d = addDays(d, 1)
      }

      const byDate: Record<string, DayJob[]> = {}
      const minByDate: Record<string, number> = {}
      for (const j of (jRes.data as unknown as Array<Record<string, any>>) || []) {
        if (!wantDates.includes(j.scheduled_date)) continue
        const quote = j.quote_id ? quotesById[j.quote_id] : null
        const rec = j.recurrence_id ? recById[j.recurrence_id] : null
        const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
        ;(byDate[j.scheduled_date] ||= []).push({
          id: j.id, customer_name: j.customers?.name || 'Job', phone: j.customers?.phone ?? null,
          address: j.properties?.address ?? null, service_type: j.service_type, start_time: j.start_time,
          value: Math.round(jobVisitValue(j.price, quote, freq)),
        })
        minByDate[j.scheduled_date] = (minByDate[j.scheduled_date] || 0) + ((j.duration_minutes as number) || DEFAULT_MIN)
      }

      setGroups(wantDates.map(date => {
        const dayJobs = byDate[date] || []
        const laborMin = minByDate[date] || 0
        // Rough plan-level timing (no route order here — Day Ops has the precise one).
        const fin = roughFinishEstimate(workStart, laborMin, dayJobs.length)
        const load = dayLoad(laborMin + dayJobs.length * 10, capacity)
        return {
          date,
          weekday: format(parseISO(date + 'T00:00:00'), 'EEEE'),
          jobs: dayJobs,
          hours: Math.round((laborMin / 60) * 10) / 10,
          revenue: dayJobs.reduce((s, j) => s + j.value, 0),
          finish: fin.finish,
          loadState: load.state,
        }
      }))
      setLoading(false)
    }
    load()
  }, [supabase])

  if (loading) return null
  const totalJobs = groups.reduce((s, g) => s + g.jobs.length, 0)
  const totalHours = Math.round(groups.reduce((s, g) => s + g.hours, 0) * 10) / 10
  const totalRev = groups.reduce((s, g) => s + g.revenue, 0)

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-2"><CalendarRange className="w-4 h-4 text-accent" /><h2 className="text-sm font-semibold text-ink">Your next work days</h2></span>
        <span className="ml-auto flex items-center gap-3 text-xs text-ink-muted">
          <span className="flex items-center gap-1"><DollarSign className="w-3 h-3 text-accent" />{formatCurrency(totalRev)}</span>
          <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{totalHours}h</span>
          <span>{totalJobs} job{totalJobs !== 1 ? 's' : ''}</span>
        </span>
      </CardHeader>
      <CardBody className="p-0">
        <div className="divide-y divide-border">
          {groups.map(g => (
            <div key={g.date} className="px-5 py-3">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <p className="text-sm font-semibold text-ink">{g.weekday} <span className="text-ink-faint font-normal">{format(parseISO(g.date + 'T00:00:00'), 'MMM d')}</span></p>
                {g.jobs.length > 0 ? (
                  <span className="text-xs text-ink-muted flex items-center gap-1.5 flex-wrap justify-end">
                    <span>{g.jobs.length} job{g.jobs.length !== 1 ? 's' : ''} · {g.hours}h · done ~{g.finish} · <span className="text-accent font-semibold">{formatCurrency(g.revenue)}</span></span>
                    {g.loadState !== 'full' && (
                      <span className={cn('text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border',
                        g.loadState === 'overloaded' ? 'text-red-400 border-red-500/30 bg-red-500/10' : 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10')}>
                        {g.loadState === 'overloaded' ? 'Overloaded' : 'Room'}
                      </span>
                    )}
                  </span>
                ) : (
                  <Link href="/dashboard/schedule" className="text-xs text-amber-400 font-medium flex items-center gap-1 hover:underline"><Plus className="w-3 h-3" /> Open — add a job</Link>
                )}
              </div>
              {g.jobs.length > 0 && (
                <div className="space-y-1">
                  {g.jobs.map(j => (
                    <div key={j.id} className="flex items-center justify-between gap-2 text-xs">
                      <span className="min-w-0 flex items-center gap-1.5 text-ink">
                        {j.start_time && <span className="text-ink-faint shrink-0">{j.start_time.slice(0, 5)}</span>}
                        <span className="truncate font-medium">{j.customer_name}</span>
                        {j.service_type && <span className="text-ink-faint truncate hidden sm:inline">· {j.service_type}</span>}
                      </span>
                      <span className="flex items-center gap-1 shrink-0">
                        <span className={j.value > 0 ? 'text-ink-muted' : 'text-amber-400'}>{j.value > 0 ? formatCurrency(j.value) : '$?'}</span>
                        {/* 40px hit areas — these get tapped with gloves on */}
                        {j.phone && <a href={`tel:${j.phone}`} className="text-accent hover:opacity-80 w-10 h-10 -my-2.5 flex items-center justify-center" title="Call"><Phone className="w-4 h-4" /></a>}
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
          <Link href="/dashboard/schedule" className="text-xs text-accent font-medium hover:underline">Open Schedule →</Link>
        </div>
      </CardBody>
    </Card>
  )
}
