// ── Shared route/neighborhood profitability engine ───────────────────────────
// The ONE place profitability math lives. Built so the Saturation Map,
// Neighborhood Revenue, Route Density and Neighbor Quote Generator features all
// reuse the same calculations. Reuses lib/route (distance) + lib/invoicing
// (per-visit value) — never re-implements routing or pricing.

import { Coord } from '@/lib/geo'
import { routeKmEstimate, routeStats, type SpeedModel } from '@/lib/route'
import { visitEconomics } from '@/lib/economics'
import { jobVisitValue, effectiveFreq } from '@/lib/invoicing'
import type { Grade } from './grade'

export interface ProfitJob {
  id: string
  scheduled_date: string
  status: string
  service_type: string | null
  quote_id: string | null
  recurrence_id: string | null
  duration_minutes: number | null
  actual_minutes: number | null
  price: number | null
  lat: number | null
  lng: number | null
  city: string | null
  postal_code: string | null
  neighborhood: string | null // real community name (reverse-geocoded, stored on the property)
  customer_id: string | null
}

export interface ProfitQuote {
  total: number | null
  initial_price: number | null
  weekly_price: number | null
  biweekly_price: number | null
  monthly_price: number | null
}

// Grade + its colours now live in lib/grade (shared with lib/dataQuality and the
// GradeBadge primitive). Re-exported here so every existing importer is unchanged.
export { GRADE_COLORS } from './grade'
export type { Grade }

export interface RecInfo { freq: string | null; interval_unit: string | null; interval_count: number | null }

export interface ProfitContext {
  quotesById: Record<string, ProfitQuote>
  recById: Record<string, RecInfo>
  base: Coord | null
  today: string // yyyy-MM-dd — so completion counts only past-due jobs
  speed?: SpeedModel // learned drive speed (lib/travelLearning); else legacy 2 min/km
}

// One visit's billable value — reuses the ONE valuation engine, resolving the
// cadence interval-aware so custom-cadence series aren't priced at first-visit.
export function jobValue(j: ProfitJob, ctx: ProfitContext): number {
  const q = j.quote_id ? ctx.quotesById[j.quote_id] : null
  const rec = j.recurrence_id ? ctx.recById[j.recurrence_id] : null
  const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
  return jobVisitValue(j.price, q as unknown as Record<string, unknown>, freq)
}

export interface RouteProfit {
  date: string
  future: boolean        // scheduled_date is after "today" → booked, not yet earned
  revenue: number        // BOOKED route value (cadence-priced), not collected cash
  driveMinutes: number
  driveKm: number
  laborMinutes: number
  totalHours: number
  revPerHour: number
  revPerKm: number
  revPerStop: number
  stops: number
  locatedStops: number   // stops with coordinates (the drive denominator)
  jobsTotal: number
  jobsDue: number        // non-future jobs (denominator for completion)
  jobsCompleted: number
  completionPct: number
  avgLegKm: number
  hasDriveData: boolean
  grade: Grade
}

const DEFAULT_LABOR_MIN = 45 // assumed labour when a job has no duration/actual

// Profitability of ONE day's route. Revenue = the route's BOOKED value across all
// non-cancelled stops (cadence-priced); labour = actual minutes when logged else
// planned; drive = nearest-neighbour estimate from base (shared lib/route).
// Completion is measured only against jobs whose date has passed.
export function dayProfitability(date: string, dayJobs: ProfitJob[], ctx: ProfitContext): RouteProfit {
  const active = dayJobs.filter(j => j.status !== 'cancelled')
  const future = date > ctx.today
  const completed = active.filter(j => j.status === 'completed')
  const located = active.filter(j => j.lat != null && j.lng != null).map(j => ({ lat: j.lat as number, lng: j.lng as number }))

  const revenue = Math.round(active.reduce((s, j) => s + jobValue(j, ctx), 0))
  const laborMinutes = active.reduce((s, j) => s + (j.actual_minutes ?? j.duration_minutes ?? DEFAULT_LABOR_MIN), 0)
  const driveKm = ctx.base ? routeKmEstimate(ctx.base, located) : 0
  const stats = routeStats(located, driveKm, ctx.speed)
  const hasDriveData = driveKm > 0
  const driveMinutes = hasDriveData ? stats.driveMinutes : 0
  const totalMinutes = laborMinutes + driveMinutes
  const totalHours = Math.round((totalMinutes / 60) * 10) / 10
  const revPerHour = totalMinutes > 0 ? Math.round(revenue / (totalMinutes / 60)) : 0
  const revPerKm = driveKm > 0 ? Math.round((revenue / driveKm) * 10) / 10 : 0
  const stops = active.length
  const revPerStop = stops > 0 ? Math.round(revenue / stops) : 0
  const jobsDue = future ? 0 : active.length
  const completionPct = jobsDue > 0 ? Math.round((completed.length / jobsDue) * 100) : 0

  return {
    date, future, revenue, driveMinutes, driveKm, laborMinutes, totalHours,
    revPerHour, revPerKm, revPerStop, stops, locatedStops: located.length,
    jobsTotal: active.length, jobsDue, jobsCompleted: completed.length, completionPct,
    avgLegKm: stats.avgLegKm, hasDriveData,
    grade: gradeRoute(revPerHour, revPerKm, stats.avgLegKm, hasDriveData),
  }
}

// Letter grade from revenue/hour (primary), adjusted for driving efficiency.
// Without drive data, $/hr excludes travel (inflated) and density is unknown, so
// the route can't earn A/B — capped at C until a base + geocoded stops exist.
export function gradeRoute(revPerHour: number, revPerKm: number, avgLegKm: number, hasDriveData = true): Grade {
  let g = revPerHour >= 120 ? 4 : revPerHour >= 90 ? 3 : revPerHour >= 60 ? 2 : revPerHour >= 40 ? 1 : 0
  if (!hasDriveData) return (['F', 'D', 'C', 'C', 'C'] as Grade[])[g]
  if (revPerKm < 5 || avgLegKm > 8) g = Math.max(0, g - 1)                       // inefficient driving
  if (revPerKm >= 25 && avgLegKm > 0 && avgLegKm <= 1.5) g = Math.min(4, g + 1)  // excellent density
  return (['F', 'D', 'C', 'B', 'A'] as Grade[])[g]
}

export function improvementSuggestions(p: RouteProfit): string[] {
  const s: string[] = []
  if (p.revPerHour < 60) s.push(`Raise pricing — $${p.revPerHour}/hr is below a healthy $60–90/hr.`)
  if (p.avgLegKm > 5) s.push(`Combine nearby customers — stops average ${p.avgLegKm} km apart.`)
  if (p.driveMinutes > p.laborMinutes && p.driveMinutes > 0) s.push('Reduce travel — more time driving than working.')
  if (p.stops < 4) s.push('Add more jobs in this area — few stops means the drive isn’t paying off.')
  if (p.revPerKm > 0 && p.revPerKm < 5) s.push(`Low $${p.revPerKm}/km — book denser jobs near this route.`)
  return s
}

// THE one geographic naming engine. Priority: real community/district name
// (properties.neighborhood, reverse-geocoded once and stored) → postal FSA
// prefix → city → Unknown. "Queensland" beats "T2J" for business decisions;
// the FSA only appears for properties that haven't been resolved yet.
export function neighborhoodKey(postal: string | null, city: string | null, neighborhood?: string | null): string {
  if (neighborhood && neighborhood.trim()) return neighborhood.trim()
  if (postal && postal.trim().length >= 3) return postal.trim().slice(0, 3).toUpperCase()
  if (city && city.trim()) return city.trim()
  return 'Unknown'
}

export interface NeighborhoodProfit {
  key: string
  revenue: number
  jobs: number
  customers: number
  laborMinutes: number
  revPerJob: number
  revPerHour: number
}

export function neighborhoodProfitability(jobs: ProfitJob[], ctx: ProfitContext): NeighborhoodProfit[] {
  const map: Record<string, { revenue: number; jobs: number; labor: number; custs: Set<string> }> = {}
  for (const j of jobs) {
    if (j.status === 'cancelled') continue
    const key = neighborhoodKey(j.postal_code, j.city, j.neighborhood)
    const e = (map[key] ||= { revenue: 0, jobs: 0, labor: 0, custs: new Set<string>() })
    e.revenue += jobValue(j, ctx)
    e.jobs += 1
    e.labor += (j.actual_minutes ?? j.duration_minutes ?? DEFAULT_LABOR_MIN)
    if (j.customer_id) e.custs.add(j.customer_id)
  }
  return Object.entries(map).map(([key, e]) => ({
    key,
    revenue: Math.round(e.revenue),
    jobs: e.jobs,
    customers: e.custs.size,
    laborMinutes: e.labor,
    revPerJob: e.jobs ? Math.round(e.revenue / e.jobs) : 0,
    revPerHour: e.labor ? Math.round(e.revenue / (e.labor / 60)) : 0,
  })).sort((a, b) => b.revenue - a.revenue)
}

export interface MonthTrend {
  month: string // yyyy-MM
  revenue: number
  driveMinutes: number
  laborMinutes: number
  driveKm: number
  revPerHour: number
  revPerKm: number
  profit: number | null    // revenue − on-site labour cost; null when crewCost wasn't supplied
  marginPct: number | null // profit as % of revenue; null without crewCost or revenue
  jobs: number             // stops completed/booked that month
  // Revenue ÷ jobs. Separates "more work" from "better-paid work" — the two look
  // identical on a revenue line and call for opposite responses. null when no jobs.
  avgJobValue: number | null
}

// Roll day-routes up into monthly trends so improvement over time is visible.
// Pass `crewCost` (lib/economics crewCostPerHour) to get profit/margin per month;
// without it those stay null and every other field is unchanged.
//
// Costing note: RouteProfit.laborMinutes is ON-SITE crew time only — the sum of
// each non-cancelled stop's actual_minutes ?? duration_minutes ?? DEFAULT_LABOR_MIN.
// Travel is NOT inside it; dayProfitability tracks it separately as driveMinutes.
// So profit here charges the crew rate against on-site labour only and leaves
// drive time uncosted — the same basis as the BI report's grossProfitYTD, which
// keeps the two figures comparable. (revPerHour below is unaffected: it keeps
// using drive + labour hours, as it always has.)
export function monthlyTrends(routes: RouteProfit[], crewCost?: number): MonthTrend[] {
  const map: Record<string, Omit<MonthTrend, 'profit' | 'marginPct' | 'avgJobValue'>> = {}
  for (const r of routes) {
    const month = r.date.slice(0, 7)
    const m = (map[month] ||= { month, revenue: 0, driveMinutes: 0, laborMinutes: 0, driveKm: 0, revPerHour: 0, revPerKm: 0, jobs: 0 })
    m.revenue += r.revenue
    m.driveMinutes += r.driveMinutes
    m.laborMinutes += r.laborMinutes
    m.driveKm += r.driveKm
    m.jobs += r.stops
  }
  return Object.values(map).map(m => {
    const hours = (m.driveMinutes + m.laborMinutes) / 60
    // Profit comes from THE profit engine (lib/economics), never a local
    // revenue−hours×rate spelling — that's the whole point of that module.
    // Drive time is passed as 0 because it is NOT inside laborMinutes here (it's
    // tracked separately), and costing it would diverge from BI's grossProfitYTD.
    const econ = crewCost != null ? visitEconomics(m.revenue, m.laborMinutes, 0, crewCost) : null
    return {
      ...m,
      driveKm: Math.round(m.driveKm * 10) / 10,
      revPerHour: hours > 0 ? Math.round(m.revenue / hours) : 0,
      revPerKm: m.driveKm > 0 ? Math.round((m.revenue / m.driveKm) * 10) / 10 : 0,
      profit: econ ? econ.profit : null,
      marginPct: econ && m.revenue > 0 ? Math.round(econ.margin * 100) : null,
      avgJobValue: m.jobs > 0 ? Math.round(m.revenue / m.jobs) : null,
    }
  }).sort((a, b) => a.month.localeCompare(b.month))
}
