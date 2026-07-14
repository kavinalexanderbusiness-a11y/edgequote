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
import { visitEconomics, crewCostPerHour as resolveCrewCost } from '@/lib/economics'
import {
  ProfitJob, ProfitQuote, ProfitContext, RecInfo, Grade,
  gradeRoute, neighborhoodProfitability,
} from '@/lib/profitability'
import { PricingPackage, PricingConfig, CadenceKey, SEASON_VISITS, pricingPackage } from '@/lib/pricing'

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
    // Profit after crew cost (labour + overhead) for the time this visit eats.
    // All from lib/economics — the one profit engine. profitPerHour is the
    // headline rate; laborCost is the crew-time cost subtracted from revenue.
    expectedProfit: number
    profitPerHour: number
    laborCost: number
    crewCostPerHour: number  // the rate used, so the card can show the basis
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
  // ── The decision, pre-composed ── everything a decision-first card (or the
  // Suggestions Center) needs to render "take / maybe / pass" without redoing
  // any math: the headline, the four money numbers, ✓/✗ reasoning, and a
  // one-line recommendation. Built from the same signals as the score.
  decision: {
    call: 'take' | 'maybe' | 'pass'
    headline: string            // "Excellent Customer" | "Decent Customer" | "Poor Fit"
    recommendedPrice: number    // per-visit price to charge
    expectedRevenue: number     // what the visit bills (= recommendedPrice)
    expectedProfit: number      // after crew cost
    revPerHour: number
    profitPerHour: number
    reasons: { good: boolean; text: string }[]
    summary: string             // "Take this customer" | "Consider passing or charging more"
  }
}

export function assessProspect(
  pkg: PricingPackage,
  ctx: ProspectContext,
  opts: {
    distanceKm?: number | null; travelFee?: number; neighborhoodName?: string | null
    estimatedMinutes?: number; timedJobs?: number; crewCostPerHour?: number | null
    // Pass 2 of gradedProspectPricing: reuse pass 1's grade instead of re-deriving
    // it from the (now grade-adjusted) prices — the grade prices the customer, the
    // price must never re-grade the customer.
    lockedScore?: ProspectScore
  },
): ProspectAssessment {
  const cadence: CadenceKey = pkg.recommended.cadence
  const opt = pkg.options.find(o => o.cadence === cadence)
  const revPerVisit = opt?.price ?? pkg.oneTime
  const annual = opt?.annual ?? pkg.oneTime
  const visits = opt ? SEASON_VISITS[opt.cadence] : 1
  const hood = opts.neighborhoodName?.trim() || null

  // ── Route economics: THE route grading engine, applied to this one stop ──
  // Drive leg = distance to the nearest existing job (joining a route), else
  // the from-base distance (a standalone trip). This is ONE input to the
  // overall grade below — not the grade itself.
  const legKm = ctx.nearbyJobs > 0 && ctx.nearestKm != null ? ctx.nearestKm : (opts.distanceKm ?? null)
  const onSiteMin = opts.estimatedMinutes ?? DEFAULT_JOB_MIN
  const driveMin = legKm != null ? Math.round(legKm / AVG_SPEED_KM_PER_MIN) : 0
  const revPerHour = Math.round(revPerVisit / ((onSiteMin + driveMin) / 60))
  const revPerKm = legKm && legKm > 0 ? Math.round((revPerVisit / legKm) * 10) / 10 : 25
  const routeEconGrade = gradeRoute(revPerHour, revPerKm, legKm ?? 10, legKm != null)

  // ── Profit: revenue minus the crew-time this visit eats (lib/economics) ──
  const crewCost = resolveCrewCost(opts.crewCostPerHour)
  const econ = visitEconomics(revPerVisit, onSiteMin, driveMin, crewCost)

  const routeImpact: RouteImpact = ctx.nearbyJobs >= 2 ? 'strengthens' : ctx.nearbyJobs === 1 ? 'neutral' : 'isolated'
  const recurring = cadence === 'weekly' || cadence === 'biweekly' || cadence === 'monthly'

  const reasons: string[] = []
  if (hood) reasons.push(hood)
  reasons.push(ctx.nearbyJobs > 0 ? `${ctx.nearbyJobs} nearby job${ctx.nearbyJobs !== 1 ? 's' : ''}` : 'No nearby jobs — isolated property')
  reasons.push(`${cadence === 'one_time' ? 'One-time' : cadence === 'weekly' ? 'Weekly' : cadence === 'biweekly' ? 'Bi-weekly' : 'Monthly'} value $${annual.toLocaleString()}/season`)
  if (ctx.nearbyJobs >= 3) reasons.push('Strong route density — fits existing routes')
  else if (ctx.nearbyJobs >= 1) reasons.push('Builds route density')
  else if (opts.distanceKm != null && opts.distanceKm > 10) reasons.push(`Far from base (${opts.distanceKm} km)`)
  if (!recurring) reasons.push('One-time service only')
  // Profit signal: high/healthy margin vs thin/negative after crew cost.
  if (econ.profitPerHour >= 80) reasons.push(`Strong profit — $${econ.profitPerHour}/hr after crew cost`)
  else if (econ.profit <= 0) reasons.push('Loses money after crew cost — raise the price')
  else if (econ.margin < 0.35) reasons.push(`Thin margin — only $${econ.profit} profit/visit`)

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

  // ── Overall grade: composed from ALL four sub-scores ──
  // Route economics ($/hr, $/km), profit after crew cost, route ownership and
  // customer value each contribute — a stop that strengthens a route, bills
  // recurring and clears healthy profit can no longer sit at C just because one
  // denominator (a long on-site visit) drags $/hr. The sub-scores themselves are
  // unchanged and still shown separately (Route Impact / Customer Value stars).
  const routePts = ({ A: 100, B: 78, C: 55, D: 30, F: 5 } as Record<Grade, number>)[routeEconGrade]
  const profitPts = econ.profit <= 0 ? 0 : econ.margin >= 0.5 ? 100 : econ.margin >= 0.35 ? 75 : 45
  const ownPts = (ownStars - 1) * 25
  const valuePts = (starsClamped - 1) * 25
  const composite = Math.round(routePts * 0.35 + profitPts * 0.3 + ownPts * 0.2 + valuePts * 0.15)
  let overall: Grade = composite >= 82 ? 'A' : composite >= 65 ? 'B' : composite >= 45 ? 'C' : composite >= 28 ? 'D' : 'F'
  // Money-losing work can never grade well, whatever the route looks like.
  if (econ.profit <= 0 && (overall === 'A' || overall === 'B')) overall = 'C'
  // lockedScore: pass 2 of the graded-pricing composition — the grade priced the
  // package; the discounted price must not re-grade the customer (no feedback loop).
  const score: ProspectScore = opts.lockedScore
    ?? (overall === 'A' && recurring && ctx.nearbyJobs >= 3 ? 'A+' : overall)
  let verdict = (score === 'A+' || score === 'A' || score === 'B') ? 'excellent' as const
    : score === 'C' ? 'decent' as const : 'weak' as const
  // Profit overrides the grade: a customer that loses money after crew cost can
  // never be "excellent", and a thin margin caps it at "decent".
  if (econ.profit <= 0) verdict = 'weak'
  else if (econ.margin < 0.35 && verdict === 'excellent') verdict = 'decent'
  // Explain a split verdict — trust comes from saying WHY the letter moved.
  if (routeEconGrade !== overall && !opts.lockedScore) {
    reasons.push(routePts < composite
      ? `Route economics alone grade ${routeEconGrade} — lifted by profit, route ownership and customer value`
      : `Strong route economics (${routeEconGrade}) held back by profit / ownership / customer value`)
  }

  // ── Pre-composed decision (decision-first cards + Suggestions Center) ──
  const call: 'take' | 'maybe' | 'pass' =
    verdict === 'excellent' ? 'take' : verdict === 'decent' ? 'maybe' : 'pass'
  const decisionReasons: { good: boolean; text: string }[] = []
  // Route fit
  decisionReasons.push(
    routeImpact === 'strengthens' ? { good: true, text: 'Strong route fit' }
      : routeImpact === 'neutral' ? { good: true, text: 'Fits near an existing stop' }
        : { good: false, text: 'Weak route fit' })
  // Nearby customers
  decisionReasons.push(
    ctx.nearbyJobs >= 2 ? { good: true, text: 'Close to existing customers' }
      : ctx.nearbyJobs === 1 ? { good: true, text: 'One customer nearby' }
        : { good: false, text: 'Isolated customer' })
  // Profit after crew cost
  decisionReasons.push(
    econ.profit <= 0 ? { good: false, text: 'Loses money after crew cost' }
      : econ.profit >= 35 ? { good: true, text: `High profit — $${econ.profit}/visit` }
        : { good: false, text: `Thin profit — $${econ.profit}/visit` })
  // Drive time
  if (legKm != null) {
    if (driveMin <= 12) decisionReasons.push({ good: true, text: 'Low drive time' })
    else if (driveMin >= 20) decisionReasons.push({ good: false, text: 'Long drive' })
  }
  // Long-term value
  if (recurring && annual >= 1200) decisionReasons.push({ good: true, text: 'High long-term value' })
  else if (!recurring) decisionReasons.push({ good: false, text: 'One-time service only' })
  const decision = {
    call,
    headline: verdict === 'excellent' ? 'Excellent Customer' : verdict === 'decent' ? 'Decent Customer' : 'Poor Fit',
    recommendedPrice: revPerVisit,
    expectedRevenue: revPerVisit,
    expectedProfit: econ.profit,
    revPerHour: econ.revPerHour,
    profitPerHour: econ.profitPerHour,
    reasons: decisionReasons,
    summary: call === 'take' ? 'Take this customer'
      : call === 'maybe' ? 'Worth taking — watch the margin'
        : 'Consider passing or charging more',
  }

  return {
    score, verdict, reasons,
    stars: starsClamped, starReasons,
    financial: {
      revPerVisit,
      revPerHour,
      annual,
      expectedProfit: econ.profit,
      profitPerHour: econ.profitPerHour,
      laborCost: econ.laborCost,
      crewCostPerHour: crewCost,
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
    decision,
  }
}

// ── Graded pricing + assessment, composed ONCE ───────────────────────────────
// THE two-pass flow every verdict surface must use. Pass 1 grades the prospect
// off the neutral package; pass 2 re-prices the package with that grade and
// REASSESSES against the graded package with the score locked — so the hero
// recommendation, CTA, Accept-at tile, Pricing Details, Pricing Guidance and
// "Use recommended" all read the SAME number, and profit/annual/lifetime are
// computed from the price actually shown. Never build the graded package and
// the assessment separately — that is exactly the $65 hero vs  details
// split this exists to prevent.
export function gradedProspectPricing(
  sqft: number,
  cfg: PricingConfig,
  pkgCtx: { overgrowth?: number; nearbyCount: number; neighborhoodName?: string | null },
  ctx: ProspectContext,
  opts: { distanceKm?: number | null; travelFee?: number; neighborhoodName?: string | null; estimatedMinutes?: number; timedJobs?: number; crewCostPerHour?: number | null },
): { pkg: PricingPackage; assessment: ProspectAssessment } {
  const basePkg = pricingPackage(sqft, cfg, pkgCtx)
  const first = assessProspect(basePkg, ctx, opts)
  const pkg = pricingPackage(sqft, cfg, { ...pkgCtx, valueGrade: first.score })
  const assessment = assessProspect(pkg, ctx, { ...opts, lockedScore: first.score })
  return { pkg, assessment }
}
