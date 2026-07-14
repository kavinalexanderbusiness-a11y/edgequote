// ── Morning briefing (the ONE start-of-day digest) ───────────────────────────
// Assembles a single, calm summary of the day from data EdgeQuote already has —
// today's jobs (scheduling), drive time + finish (the route/ETA engine), revenue,
// payments due (invoices), follow-ups (CRM) and weather (weatherImpact). Pure +
// synchronous: the caller passes already-loaded rows; nothing is fetched or
// duplicated here. Returns only the lines that actually matter today.

import type { Coord } from '@/lib/geo'
import { routeKmEstimate, AVG_SPEED_KM_PER_MIN, roughFinishEstimate, DEFAULT_JOB_MIN } from '@/lib/route'

export interface BriefingJob {
  id: string
  status: string
  price: number | null
  duration_minutes: number | null
  lat: number | null
  lng: number | null
}

export interface MorningBriefingInput {
  today: string
  jobsToday: BriefingJob[]
  base: Coord | null
  workStart: string
  unpaid: { amount: number | null; due_date: string | null }[]
  followUpCount: number
  weather: { affectsToday: boolean; text: string | null } | null
}

export interface BriefingStat {
  key: string
  label: string
  value: string
  detail?: string
  tone?: 'good' | 'warn' | 'default'
  href?: string
}

export interface MorningBriefing {
  headline: string
  stats: BriefingStat[]
}

export function buildMorningBriefing(i: MorningBriefingInput): MorningBriefing {
  const active = i.jobsToday.filter(j => j.status !== 'cancelled' && j.status !== 'completed')
  const jobCount = active.length
  const laborMin = active.reduce((s, j) => s + (j.duration_minutes || DEFAULT_JOB_MIN), 0)
  const located = active.filter(j => j.lat != null && j.lng != null).map(j => ({ lat: j.lat as number, lng: j.lng as number }))
  const km = i.base && located.length ? routeKmEstimate(i.base, located) : 0
  const driveMin = Math.round(km / AVG_SPEED_KM_PER_MIN)
  const finish = roughFinishEstimate(i.workStart, laborMin, jobCount).finish
  const revenue = Math.round(active.reduce((s, j) => s + (Number(j.price) || 0), 0))

  const overdue = i.unpaid.filter(u => u.due_date && u.due_date < i.today)
  const unpaidTotal = Math.round(i.unpaid.reduce((s, u) => s + (Number(u.amount) || 0), 0))
  const overdueTotal = Math.round(overdue.reduce((s, u) => s + (Number(u.amount) || 0), 0))

  const stats: BriefingStat[] = []
  stats.push({
    key: 'jobs', label: "Today's jobs", value: jobCount ? String(jobCount) : 'None',
    detail: jobCount ? `Done ~${finish}` : 'Nothing scheduled', href: '/dashboard/schedule',
  })
  if (jobCount) stats.push({ key: 'revenue', label: 'Revenue today', value: `$${revenue.toLocaleString()}`, href: '/dashboard/schedule' })
  if (jobCount && i.base && located.length) stats.push({ key: 'travel', label: 'Drive time', value: `${driveMin} min`, detail: `${km} km`, href: '/dashboard/routes' })
  if (i.weather?.affectsToday) stats.push({ key: 'weather', label: 'Weather', value: 'Watch', detail: i.weather.text || 'May affect today', tone: 'warn', href: '/dashboard/schedule' })
  if (i.unpaid.length) stats.push({
    key: 'pay', label: 'Payments due', value: `$${unpaidTotal.toLocaleString()}`,
    detail: overdue.length ? `${overdue.length} overdue · $${overdueTotal.toLocaleString()}` : `${i.unpaid.length} unpaid`,
    tone: overdue.length ? 'warn' : 'default', href: '/dashboard/invoices',
  })
  if (i.followUpCount) stats.push({
    key: 'followups', label: 'Follow-ups', value: String(i.followUpCount),
    detail: 'Quotes to chase', tone: 'warn', href: '/dashboard/quotes',
  })

  const headline = jobCount
    ? `${jobCount} job${jobCount !== 1 ? 's' : ''} today${i.weather?.affectsToday ? ' · weather watch' : ''} · done ~${finish}`
    : 'No jobs scheduled today'
  return { headline, stats }
}
