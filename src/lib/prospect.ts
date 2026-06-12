// ── "Should I take this customer?" ───────────────────────────────────────────
// COMPOSITION ONLY — no new scoring math. The letter score comes from the route
// grading engine (gradeRoute), density from the geo engine (nearbyJobCount,
// same radius as the travel discount), neighborhood strength from
// neighborhoodProfitability, per-visit value from the pricing package. This
// module just gathers the context and assembles the verdict.

import { format } from 'date-fns'
import type { createClient } from '@/lib/supabase/client'
import { Coord, haversineKm, NEARBY_RADIUS_KM } from '@/lib/geo'
import { AVG_SPEED_KM_PER_MIN, DEFAULT_JOB_MIN } from '@/lib/route'
import {
  ProfitJob, ProfitQuote, ProfitContext, RecInfo, Grade,
  gradeRoute, neighborhoodProfitability,
} from '@/lib/profitability'
import { PricingPackage, CadenceKey, SEASON_VISITS } from '@/lib/pricing'

type Supa = ReturnType<typeof createClient>

export interface ProspectContext {
  nearbyJobs: number          // located upcoming jobs within range
  nearestKm: number | null
  nearbyRecurring: number     // of those, how many are recurring visits
  nearbyPendingQuotes: number // pending (draft/sent) quotes within range
  hoods: { key: string; revenue: number; customers: number }[] // per-area booked revenue + customer count (shared engine)
  // The owner's REAL pace from check-in/check-out data: median minutes per
  // 1,000 ft² across completed timed jobs on measured lawns (null until ≥3).
  observedMinPer1000: number | null
  timedJobs: number
}

// One fetch, computed with the same engines every analytics page uses.
export async function loadProspectContext(supabase: Supa, userId: string, center: Coord): Promise<ProspectContext> {
  const today = format(new Date(), 'yyyy-MM-dd')
  const [jRes, qRes, rRes] = await Promise.all([
    supabase.from('jobs')
      .select('id, scheduled_date, status, service_type, quote_id, recurrence_id, duration_minutes, actual_minutes, price, customer_id, properties(lat, lng, city, postal_code, neighborhood, lawn_sqft)')
      .eq('user_id', userId),
    supabase.from('quotes').select('id, status, property_id, total, initial_price, weekly_price, biweekly_price, monthly_price, properties(lat, lng)').eq('user_id', userId),
    supabase.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', userId),
  ])

  const quotesById: Record<string, ProfitQuote> = {}
  for (const q of (qRes.data as (ProfitQuote & { id: string })[]) || []) quotesById[q.id] = q
  const recById: Record<string, RecInfo> = {}
  for (const r of (rRes.data as (RecInfo & { id: string })[]) || []) recById[r.id] = { freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count }
  const ctx: ProfitContext = { quotesById, recById, base: null, today }

  const jobs: ProfitJob[] = ((jRes.data as unknown as Array<Record<string, any>>) || []).map(j => ({
    id: j.id, scheduled_date: j.scheduled_date, status: j.status, service_type: j.service_type,
    quote_id: j.quote_id, recurrence_id: j.recurrence_id, duration_minutes: j.duration_minutes,
    actual_minutes: j.actual_minutes, price: j.price, customer_id: j.customer_id,
    lat: j.properties?.lat ?? null, lng: j.properties?.lng ?? null,
    city: j.properties?.city ?? null, postal_code: j.properties?.postal_code ?? null,
    neighborhood: j.properties?.neighborhood ?? null,
  }))

  // Density around the prospect — same radius the travel discount uses.
  const upcoming = jobs.filter(j => j.scheduled_date >= today && (j.status === 'scheduled' || j.status === 'in_progress') && j.lat != null && j.lng != null)
  let nearbyJobs = 0, nearbyRecurring = 0
  let nearestKm: number | null = null
  for (const j of upcoming) {
    const km = haversineKm(center, { lat: j.lat as number, lng: j.lng as number })
    if (km <= NEARBY_RADIUS_KM) {
      nearbyJobs++
      if (j.recurrence_id) nearbyRecurring++
    }
    if (nearestKm == null || km < nearestKm) nearestKm = Math.round(km * 10) / 10
  }

  let nearbyPendingQuotes = 0
  for (const q of ((qRes.data as unknown as Array<{ status: string; properties?: { lat: number | null; lng: number | null } | null }>) || [])) {
    if (q.status !== 'draft' && q.status !== 'sent') continue
    if (q.properties?.lat == null || q.properties?.lng == null) continue
    if (haversineKm(center, { lat: q.properties.lat, lng: q.properties.lng }) <= NEARBY_RADIUS_KM) nearbyPendingQuotes++
  }

  const hoods = neighborhoodProfitability(jobs, ctx).map(h => ({ key: h.key, revenue: h.revenue, customers: h.customers }))

  // Personal pace from timed jobs (check-in/check-out) on measured lawns.
  const rates: number[] = []
  for (const j of ((jRes.data as unknown as Array<Record<string, any>>) || [])) {
    const sqft = Number(j.properties?.lawn_sqft)
    const actual = Number(j.actual_minutes)
    if (j.status === 'completed' && actual > 0 && sqft >= 300) rates.push(actual / (sqft / 1000))
  }
  rates.sort((a, b) => a - b)
  const observedMinPer1000 = rates.length >= 3 ? Math.round(rates[Math.floor(rates.length / 2)] * 10) / 10 : null

  return { nearbyJobs, nearestKm, nearbyRecurring, nearbyPendingQuotes, hoods, observedMinPer1000, timedJobs: rates.length }
}

export type ProspectScore = 'A+' | Grade
export type RouteImpact = 'strengthens' | 'neutral' | 'isolated'

export interface ProspectAssessment {
  score: ProspectScore
  verdict: 'excellent' | 'decent' | 'weak'
  reasons: string[]
  stars: 1 | 2 | 3 | 4 | 5
  starReasons: string[]
  financial: {
    revPerVisit: number
    revPerHour: number      // est., on-site + drive to nearest anchor
    annual: number
    travelImpact: string
    routeImpact: string
    timeBasis: string       // where the time estimate came from (calibrated vs model)
  }
  growth: { bullets: string[]; narrative: string | null }
  routeImpact: RouteImpact
  // What this customer UNLOCKS — beachhead into a new area, or domination of one
  // you already work. Null when there's no area name to anchor it.
  expansion: {
    kind: 'beachhead' | 'domination'
    hood: string
    current: string[]
    potential: string[]
    reason: string
  } | null
  // Area revenue rank today vs after winning this customer (shared hood revenue).
  competitive: { hood: string; currentRank: number | null; projectedRank: number; totalAreas: number } | null
  // Season value compounded — recurring customers are worth far more than one visit.
  lifetime: { cadenceLabel: string; oneYear: number; threeYear: number; fiveYear: number }
  // Does this stop make the BUSINESS stronger? Asset vs liability.
  routeOwnership: { stars: 1 | 2 | 3 | 4 | 5; label: 'Route Asset' | 'Solid Addition' | 'Route Liability'; reasons: string[] }
}

export function assessProspect(
  pkg: PricingPackage,
  ctx: ProspectContext,
  opts: { distanceKm?: number | null; travelFee?: number; neighborhoodName?: string | null; estimatedMinutes?: number; timedJobs?: number },
): ProspectAssessment {
  const cadence: CadenceKey = pkg.recommended.cadence
  const opt = pkg.options.find(o => o.cadence === cadence)
  const revPerVisit = opt?.price ?? pkg.oneTime
  const annual = opt?.annual ?? pkg.oneTime
  const visits = opt ? SEASON_VISITS[opt.cadence] : 1
  const hood = opts.neighborhoodName?.trim() || null

  // ── Letter score: THE route grading engine, applied to this one stop ──
  // Drive leg = distance to the nearest existing job (joining a route), else
  // the from-base distance (a standalone trip).
  const legKm = ctx.nearbyJobs > 0 && ctx.nearestKm != null ? ctx.nearestKm : (opts.distanceKm ?? null)
  const onSiteMin = opts.estimatedMinutes ?? DEFAULT_JOB_MIN
  const driveMin = legKm != null ? Math.round(legKm / AVG_SPEED_KM_PER_MIN) : 0
  const revPerHour = Math.round(revPerVisit / ((onSiteMin + driveMin) / 60))
  const revPerKm = legKm && legKm > 0 ? Math.round((revPerVisit / legKm) * 10) / 10 : 25
  const grade = gradeRoute(revPerHour, revPerKm, legKm ?? 10, legKm != null)

  const routeImpact: RouteImpact = ctx.nearbyJobs >= 2 ? 'strengthens' : ctx.nearbyJobs === 1 ? 'neutral' : 'isolated'
  const recurring = cadence === 'weekly' || cadence === 'biweekly' || cadence === 'monthly'

  const score: ProspectScore = grade === 'A' && recurring && ctx.nearbyJobs >= 3 ? 'A+' : grade
  const verdict = (score === 'A+' || score === 'A' || score === 'B') ? 'excellent' as const
    : score === 'C' ? 'decent' as const : 'weak' as const

  const reasons: string[] = []
  if (hood) reasons.push(hood)
  reasons.push(ctx.nearbyJobs > 0 ? `${ctx.nearbyJobs} nearby job${ctx.nearbyJobs !== 1 ? 's' : ''}` : 'No nearby jobs — isolated property')
  reasons.push(`${cadence === 'one_time' ? 'One-time' : cadence === 'weekly' ? 'Weekly' : cadence === 'biweekly' ? 'Bi-weekly' : 'Monthly'} value $${annual.toLocaleString()}/season`)
  if (ctx.nearbyJobs >= 3) reasons.push('Strong route density — fits existing routes')
  else if (ctx.nearbyJobs >= 1) reasons.push('Builds route density')
  else if (opts.distanceKm != null && opts.distanceKm > 10) reasons.push(`Far from base (${opts.distanceKm} km)`)
  if (!recurring) reasons.push('One-time service only')

  // ── Stars: long-term value from the same signals ──
  let stars = 3
  if (recurring) stars += 1; else stars -= 1
  if (ctx.nearbyJobs >= 2) stars += 1
  if (ctx.nearbyJobs === 0) stars -= 1
  if (annual >= 1200) stars += 1
  if (annual < 500) stars -= 1
  const starsClamped = Math.max(1, Math.min(5, stars)) as 1 | 2 | 3 | 4 | 5
  const starReasons = [
    recurring ? `${cadence === 'weekly' ? 'Weekly' : cadence === 'biweekly' ? 'Bi-weekly' : 'Monthly'} service` : 'One-time service',
    annual >= 1200 ? 'High season revenue' : annual >= 500 ? 'Moderate season revenue' : 'Low season revenue',
    ctx.nearbyJobs >= 2 ? (hood ? `Strong ${hood} cluster` : 'Strong area cluster') : ctx.nearbyJobs === 0 ? 'Isolated stop — low growth leverage' : 'Growing area',
  ]

  // ── Growth potential ──
  const growthBullets = [
    `${ctx.nearbyJobs} nearby job${ctx.nearbyJobs !== 1 ? 's' : ''} on the schedule`,
    `${ctx.nearbyRecurring} nearby recurring`,
    `${ctx.nearbyPendingQuotes} nearby pending quote${ctx.nearbyPendingQuotes !== 1 ? 's' : ''}`,
  ]
  let narrative: string | null = null
  if (hood && ctx.hoods.length > 0) {
    const current = ctx.hoods.find(h => h.key === hood)
    const prospective = (current?.revenue ?? 0) + annual
    const rank = 1 + ctx.hoods.filter(h => h.key !== hood && h.revenue > prospective).length
    growthBullets.push(current ? `${hood}: $${current.revenue.toLocaleString()} booked today` : `${hood}: new area for you`)
    if (rank <= 3 && ctx.hoods.length >= 3) narrative = `Adding this customer would make ${hood} one of your top ${Math.max(rank, 3) === 3 ? '3' : rank} route areas.`
    else if (!current) narrative = `This would be your first customer in ${hood} — a beachhead for door-knocking.`
  }

  const travelImpact = ctx.nearbyJobs >= 3
    ? 'Travel absorbed — the truck is already here'
    : (opts.travelFee ?? 0) > 0
      ? `$${opts.travelFee} travel charged${ctx.nearbyJobs >= 1 ? ' (route discount applied)' : ''}`
      : opts.distanceKm != null ? `${opts.distanceKm} km from base, no fee` : 'No travel data'

  // ── Route expansion opportunity: what does winning this customer UNLOCK? ──
  const hoodRow = hood ? ctx.hoods.find(h => h.key === hood) ?? null : null
  const hoodCustomers = hoodRow?.customers ?? 0
  const hoodRevenue = hoodRow?.revenue ?? 0
  const expansion = hood ? (
    hoodCustomers >= 3
      ? {
          kind: 'domination' as const,
          hood,
          current: [`${hoodCustomers} customers`, `$${hoodRevenue.toLocaleString()} booked`],
          potential: ['Strengthens an existing route', 'Increases route density', 'Reduces drive time per stop'],
          reason: 'This customer helps dominate an area you already own.',
        }
      : {
          kind: 'beachhead' as const,
          hood,
          current: hoodCustomers > 0
            ? [`${hoodCustomers} customer${hoodCustomers !== 1 ? 's' : ''}`, `$${hoodRevenue.toLocaleString()} booked`]
            : ['No customers here yet'],
          potential: [
            ...(ctx.nearbyPendingQuotes > 0 ? [`${ctx.nearbyPendingQuotes} pending quote${ctx.nearbyPendingQuotes !== 1 ? 's' : ''} nearby — warm demand`] : []),
            recurring ? 'A recurring anchor for door-knocking & referrals' : 'A first foothold in the area',
            'Could become a major route',
          ],
          reason: 'This customer is a beachhead opportunity.',
        }
  ) : null

  // ── Competitive value: area revenue rank today vs after winning ──
  let competitive: ProspectAssessment['competitive'] = null
  if (hood && ctx.hoods.length > 0) {
    const sorted = [...ctx.hoods].sort((a, b) => b.revenue - a.revenue)
    const currentIdx = sorted.findIndex(h => h.key === hood)
    const projected = 1 + ctx.hoods.filter(h => h.key !== hood && h.revenue > hoodRevenue + annual).length
    competitive = {
      hood,
      currentRank: currentIdx >= 0 ? currentIdx + 1 : null,
      projectedRank: projected,
      totalAreas: ctx.hoods.length + (currentIdx >= 0 ? 0 : 1),
    }
  }

  // ── Lifetime projection: the season value compounded over the years ──
  const lifetime = {
    cadenceLabel: cadence === 'one_time' ? 'One-time service' : cadence === 'weekly' ? 'Weekly service' : cadence === 'biweekly' ? 'Bi-weekly service' : 'Monthly service',
    oneYear: annual,
    threeYear: annual * 3,
    fiveYear: annual * 5,
  }

  // ── Route ownership: does this stop make the business stronger? ──
  let own = 3
  if (routeImpact === 'strengthens') own += 2
  else if (routeImpact === 'isolated') own -= 2
  if (recurring) own += 1; else own -= 1
  if (competitive?.currentRank != null && competitive.currentRank <= 3 && ctx.hoods.length >= 3) own += 1
  if (annual < 500) own -= 1
  const ownStars = Math.max(1, Math.min(5, own)) as 1 | 2 | 3 | 4 | 5
  const routeOwnership = {
    stars: ownStars,
    label: (ownStars >= 4 ? 'Route Asset' : ownStars === 3 ? 'Solid Addition' : 'Route Liability') as 'Route Asset' | 'Solid Addition' | 'Route Liability',
    reasons: [
      routeImpact === 'strengthens' ? 'Strengthens an existing route' : routeImpact === 'neutral' ? 'Near one existing stop' : 'Isolated stop',
      recurring ? 'Recurring service' : 'One-time service',
      competitive?.currentRank != null && competitive.currentRank <= 3 ? 'Strong neighborhood' : hoodCustomers > 0 ? 'Growing neighborhood' : 'Unproven area',
      ...(annual < 500 ? ['Low season revenue'] : []),
    ],
  }

  return {
    score, verdict, reasons,
    stars: starsClamped, starReasons,
    financial: {
      revPerVisit,
      revPerHour,
      annual,
      travelImpact,
      routeImpact: routeImpact === 'strengthens' ? 'Tightens an existing route'
        : routeImpact === 'neutral' ? 'Near one existing stop' : 'Opens a new solo trip',
      timeBasis: (opts.timedJobs ?? 0) >= 3
        ? `~${onSiteMin} min on-site — calibrated from ${opts.timedJobs} of your timed jobs`
        : `~${onSiteMin} min on-site (size model) — time jobs with Start/Complete to calibrate`,
    },
    growth: { bullets: growthBullets, narrative },
    routeImpact,
    expansion,
    competitive,
    lifetime,
    routeOwnership,
  }
}

// Visits-per-season for the financial line ("× N visits").
export function visitsFor(cadence: CadenceKey): number {
  return cadence === 'one_time' ? 1 : SEASON_VISITS[cadence]
}
