import type { SupabaseClient } from '@supabase/supabase-js'
import type { Job, Quote, JobRecurrence, Property, Customer, JobLineItem } from '@/types'
import { Coord, haversineKm } from '@/lib/geo'
import { dayLoad, DEFAULT_JOB_MIN } from '@/lib/route'
import { densityFor } from '@/lib/routeDensity'
import { effectiveFreq, jobVisitValue, quoteVisitAmount, syncDraftInvoiceAmounts } from '@/lib/invoicing'
import { recordPriceChange, isRecurringProgramService, normalizeServiceKey } from '@/lib/jobPricing'
import { PricingConfig, recommendedJobPrice, estimateVisitMinutes, SEASON_VISITS } from '@/lib/pricing'
import { visitEconomics } from '@/lib/economics'
import { ProfitJob, ProfitContext, neighborhoodProfitability } from '@/lib/profitability'
import { OptJob, OptOptions, OptimizeScope, OptimizeMode, analyzeSchedule, optimizeSchedule } from '@/lib/optimizer'
import { dayProfitability } from '@/lib/profitability'
import { FOLLOW_UP_DAYS } from '@/lib/followup'
import { generateOccurrences, dayDelta } from '@/lib/recurrence'
import { ServiceSeasons, serviceCategory, seasonForService, seasonEndDateFor, isWithinSeason } from '@/lib/seasons'
import { addDays, parseISO, format, getDay } from 'date-fns'

// ── Suggestions Center — EdgeQuote's business advisor ────────────────────────
// Decision-first, action-first. This is NOT another analytics view: it turns the
// existing engines (pricing, economics, profitability, optimizer, seasons,
// reactivation, neighborhoods) into a RANKED feed of "do this next" actions.
//
// HARD RULE (codebase invariant): compose existing engines, never re-derive
// pricing / routing / profit math here. Every number must trace to real data —
// no placeholder figures. Where a projection is unavoidable (upsell adoption,
// flyer conversion, win-back rate) it is a conservative, labelled assumption
// applied to REAL counts/averages, and the suggestion's confidence reflects it.
//
// Ranking key = ANNUAL PROFIT IMPACT, recurrence-aware: a $10 weekly raise
// (≈28 visits/Calgary-season) ranks far above a $10 one-time. See SEASON_VISITS.

export type SuggestionCategory = 'profit' | 'growth' | 'route' | 'problem' | 'retention'

export const CATEGORY_META: Record<SuggestionCategory, { label: string; emoji: string; tone: string }> = {
  profit:    { label: 'More Profit',      emoji: '💰', tone: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
  growth:    { label: 'Growth',           emoji: '📍', tone: 'text-sky-400 border-sky-500/30 bg-sky-500/10' },
  route:     { label: 'Route',            emoji: '🚗', tone: 'text-violet-400 border-violet-500/30 bg-violet-500/10' },
  problem:   { label: 'Problems to Fix',  emoji: '⚠️', tone: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
  retention: { label: 'Keep Customers',   emoji: '❤️', tone: 'text-rose-400 border-rose-500/30 bg-rose-500/10' },
}

export type Confidence = 'high' | 'medium' | 'low'
const CONF_SCORE: Record<Confidence, number> = { high: 85, medium: 60, low: 35 }

// A one-click price raise that respects the no-drift architecture: write the
// quote cadence price (recurring) or job.price (one-time), freeze billed/past
// visits at the old value, clear future visits so they derive the new price.
export interface PriceApplyPayload {
  jobId?: string | null
  quoteId?: string | null
  cadenceField?: 'weekly_price' | 'biweekly_price' | 'monthly_price' | null
  newPrice: number
  oldVisitValue: number    // the OLD cadence price (from the quote) — used to freeze history
  freezeJobIds: string[]   // past non-initial visits → pin at old value (protect history)
  clearJobIds: string[]    // future non-completed non-initial visits → null (derive new price)
  repJobId?: string | null // a stable visit id for the audit log even when nothing is cleared
}

// One-click creation of a recurring plan from a customer's repeated one-offs.
// All dates/price are computed in the engine (which has ctx) so the apply fn is
// a pure DB write that mirrors the schedule page's convertToRecurring.
export interface RecurringPlanPayload {
  customerId: string | null
  propertyId: string | null
  serviceType: string | null
  title: string
  perVisitPrice: number
  intervalUnit: 'week'
  intervalCount: 1 | 2          // 1 = weekly, 2 = biweekly
  startDate: string             // yyyy-MM-dd
  endDate: string | null        // season end (lawn) or null
  crewSize: number
  durationMinutes: number | null
}

export interface SuggestionAction {
  kind: 'apply-price' | 'navigate' | 'create-recurring'
  label: string
  href?: string
  apply?: PriceApplyPayload
  plan?: RecurringPlanPayload
}

export interface Suggestion {
  id: string
  category: SuggestionCategory
  title: string
  subtitle?: string
  // Magnitude used for ranking. For recurring items it's a true $/YEAR figure;
  // for one-time items (a route reshuffle, recovering unbilled work, chasing a
  // quote) it's the one-off dollar value — `oneTime` flags which, so the UI never
  // prints a one-time number with a "/yr" suffix.
  impact: number
  oneTime: boolean
  revenueImpact?: number    // $ revenue moved (display)
  profitImpact?: number     // $ profit (display)
  timeSavedMin?: number     // minutes saved (route)
  distanceSavedKm?: number  // km saved (route)
  confidence: Confidence
  confidenceScore: number   // 0..100
  why: string[]             // "Why?" — the reasons this surfaced
  calc?: string[]           // "How calculated?" — the math, traced to real numbers
  action: SuggestionAction  // primary action
  actions?: SuggestionAction[] // when present, render these instead (e.g. weekly/biweekly)
}

export interface SuggestionContext {
  today: string
  crewCost: number
  targetRevPerHour: number   // owner's minimum acceptable revenue/crew-hour (guardrail)
  pricingConfig: PricingConfig
  seasons: ServiceSeasons
  baseCoord: Coord | null
  preferredDays: number[]
  capacityHours: number
  jobs: Job[]                               // with customers/properties joins
  quotes: Quote[]
  recurrences: Record<string, JobRecurrence>
  properties: Property[]
  customers: Customer[]
  invoices: { status: string; amount: number | null; property_id: string | null; customer_id: string | null }[]
  lineItemsByJob: Record<string, JobLineItem[]>
  neighborLeads: { status: string | null; neighborhood: string | null }[]
  invoicedJobIds: Set<string>
}

// ── shared helpers ────────────────────────────────────────────────────────────

const ONSITE_DEFAULT = 45
const SEASON_DAYS = 200            // Calgary lawn season ≈ Apr 15 – Oct 31
const FUEL_COST_PER_KM = 0.6       // vehicle operating cost (fuel + maintenance)
const SEASON_VISITS_BIWEEKLY = SEASON_VISITS.biweekly // 14 — the conservative "season of visits" yardstick

function visitsPerYear(cadence: string | null): number {
  if (cadence === 'weekly') return SEASON_VISITS.weekly
  if (cadence === 'biweekly') return SEASON_VISITS.biweekly
  if (cadence === 'monthly') return SEASON_VISITS.monthly
  return 1
}
// Visits per season for a SERIES — uses the standard cadence when known, else
// derives from the recurrence interval so a non-standard recurring series (every
// 10 days, every 3 weeks…) is still annualized correctly instead of as one-time.
function seriesVisitsPerYear(s: Series): number {
  if (s.cadence) return visitsPerYear(s.cadence)
  const count = Math.max(1, s.rec.interval_count ?? 1)
  const stepDays = s.rec.interval_unit === 'day' ? count
    : s.rec.interval_unit === 'week' ? 7 * count
    : s.rec.interval_unit === 'month' ? 30 * count
    : 14
  return Math.max(1, Math.round(SEASON_DAYS / stepDays))
}
function cadenceField(cadence: string | null): PriceApplyPayload['cadenceField'] {
  return cadence === 'weekly' ? 'weekly_price' : cadence === 'biweekly' ? 'biweekly_price' : cadence === 'monthly' ? 'monthly_price' : null
}
function round5(n: number): number { return Math.round(n / 5) * 5 }
function quoteById(ctx: SuggestionContext): Record<string, Quote> {
  const m: Record<string, Quote> = {}
  for (const q of ctx.quotes) m[q.id] = q
  return m
}
function propsById(ctx: SuggestionContext): Record<string, Property> {
  const m: Record<string, Property> = {}
  for (const p of ctx.properties) m[p.id] = p
  return m
}
// lawn_sqft from the property (latest measurement or stored), 0 when unknown.
function sqftFor(p: Property | undefined): number {
  if (!p) return 0
  if (Number(p.lawn_sqft) > 0) return Number(p.lawn_sqft)
  const hist = Array.isArray(p.measurement_history) ? p.measurement_history : []
  const last = hist[hist.length - 1]
  return Number(last?.total_sqft ?? last?.lawn_sqft ?? 0) || 0
}
// Drive minutes attributed to a visit = leg to the NEAREST other located job
// (one way), same signal the prospect verdict uses. Falls back to base distance.
function driveMinFor(p: Property | undefined, ctx: SuggestionContext, locatedCoords: Coord[]): number {
  if (!p || p.lat == null || p.lng == null) return 12
  const here = { lat: p.lat, lng: p.lng }
  let nearest = Infinity
  for (const c of locatedCoords) {
    if (c.lat === here.lat && c.lng === here.lng) continue
    const d = haversineKm(here, c)
    if (d < nearest) nearest = d
  }
  if (!isFinite(nearest) && ctx.baseCoord) nearest = haversineKm(here, ctx.baseCoord)
  if (!isFinite(nearest)) return 12
  return Math.round((nearest / 0.5)) // AVG_SPEED_KM_PER_MIN = 0.5
}
// The soonest preferred work day strictly after today — where a new recurring
// plan's first visit lands.
function nextWorkdayStart(ctx: SuggestionContext): string {
  const pref = ctx.preferredDays.length ? new Set(ctx.preferredDays) : null
  let d = addDays(parseISO(ctx.today + 'T00:00:00'), 1)
  for (let i = 0; i < 21; i++) {
    if (!pref || pref.has(getDay(d))) return format(d, 'yyyy-MM-dd')
    d = addDays(d, 1)
  }
  return format(addDays(parseISO(ctx.today + 'T00:00:00'), 1), 'yyyy-MM-dd')
}
// Distinct nearby OTHER-customer stops within ~2km of a property (route-density signal).
function nearbyCustomerStops(prop: Property | undefined, ctx: SuggestionContext, excludeCustomerId: string | null): number {
  if (!prop || prop.lat == null || prop.lng == null) return 0
  const here = { lat: prop.lat, lng: prop.lng }
  const seen = new Set<string>()
  for (const j of ctx.jobs) {
    if (j.customer_id === excludeCustomerId) continue
    const lat = j.properties?.lat, lng = j.properties?.lng
    if (lat == null || lng == null) continue
    if (haversineKm(here, { lat, lng }) <= 2 && j.customer_id) seen.add(j.customer_id)
  }
  return seen.size
}

// A representative recurring "series" the owner manages — one card per series.
interface Series {
  recurrenceId: string
  rec: JobRecurrence
  quote: Quote | null
  cadence: string | null
  jobs: Job[]            // all visits in the series
  futureOpen: Job[]      // future, not completed/cancelled
  rep: Job               // representative visit (earliest future open, else latest)
  perVisit: number       // current per-visit value
  customerName: string
  property?: Property
  customerId: string | null
}

function buildSeries(ctx: SuggestionContext): Series[] {
  const qById = quoteById(ctx)
  const pById = propsById(ctx)
  const byRec: Record<string, Job[]> = {}
  for (const j of ctx.jobs) if (j.recurrence_id) (byRec[j.recurrence_id] ||= []).push(j)
  const out: Series[] = []
  for (const [rid, list] of Object.entries(byRec)) {
    const rec = ctx.recurrences[rid]
    if (!rec) continue
    const sorted = [...list].sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))
    const futureOpen = sorted.filter(j => j.scheduled_date >= ctx.today && j.status !== 'completed' && j.status !== 'cancelled')
    const rep = futureOpen[0] || sorted[sorted.length - 1]
    if (!rep) continue
    const cadence = effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count)
    const quote = rep.quote_id ? (qById[rep.quote_id] || null) : null
    const perVisit = jobVisitValue(rep.price, quote as unknown as Record<string, unknown>, cadence, rep.is_initial_visit)
    out.push({
      recurrenceId: rid, rec, quote, cadence, jobs: sorted, futureOpen, rep, perVisit,
      customerName: rep.customers?.name || rep.title,
      property: rep.property_id ? pById[rep.property_id] : undefined,
      customerId: rep.customer_id,
    })
  }
  return out
}

function profitJobsAndCtx(ctx: SuggestionContext): { jobs: ProfitJob[]; pctx: ProfitContext } {
  const pById = propsById(ctx)
  const quotesById: ProfitContext['quotesById'] = {}
  for (const q of ctx.quotes) quotesById[q.id] = { total: q.total, initial_price: q.initial_price, weekly_price: q.weekly_price, biweekly_price: q.biweekly_price, monthly_price: q.monthly_price }
  const recById: ProfitContext['recById'] = {}
  for (const [id, r] of Object.entries(ctx.recurrences)) recById[id] = { freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count }
  const jobs: ProfitJob[] = ctx.jobs.map(j => {
    const p = j.property_id ? pById[j.property_id] : undefined
    return {
      id: j.id, scheduled_date: j.scheduled_date, status: j.status, service_type: j.service_type,
      quote_id: j.quote_id, recurrence_id: j.recurrence_id, duration_minutes: j.duration_minutes,
      actual_minutes: j.actual_minutes, price: j.price,
      lat: j.properties?.lat ?? p?.lat ?? null, lng: j.properties?.lng ?? p?.lng ?? null,
      city: p?.city ?? null, postal_code: p?.postal_code ?? null, neighborhood: p?.neighborhood ?? null,
      customer_id: j.customer_id,
    }
  })
  return { jobs, pctx: { quotesById, recById, base: ctx.baseCoord, today: ctx.today } }
}

// The safe one-click raise action for a series: write the quote cadence price
// (freeze past, clear future) when quote-linked & standard cadence; else navigate
// to Pricing. Shared by the price-raise card and the below-target "raise" path.
function raiseAction(s: Series, newPrice: number, ctx: SuggestionContext): SuggestionAction {
  const field = cadenceField(s.cadence)
  if (s.quote && field) {
    const oldCadenceValue = Math.round(quoteVisitAmount(s.quote as unknown as Record<string, unknown>, s.cadence))
    return {
      kind: 'apply-price', label: 'Apply raise',
      apply: {
        quoteId: s.quote.id, cadenceField: field, newPrice, oldVisitValue: oldCadenceValue, repJobId: s.rep.id,
        freezeJobIds: s.jobs.filter(j => !j.is_initial_visit && j.scheduled_date < ctx.today && j.price == null).map(j => j.id),
        clearJobIds: s.futureOpen.filter(j => !j.is_initial_visit).map(j => j.id),
      },
    }
  }
  return { kind: 'navigate', label: 'Raise in Pricing', href: '/dashboard/pricing-recovery' }
}

// ── 💰 PROFIT: underpriced recurring raises ─────────────────────────────────────
// Only fires on a MEASURED lawn with a proven (≥1 completed visit) series, so the
// target traces to recommendedJobPrice — not the service-mixed neighbourhood
// average (which conflated mowing with one-off cleanups and produced phantom
// raises). Unmeasured underpricing is left to the "below minimum" roadmap item.
function priceRaises(ctx: SuggestionContext): Suggestion[] {
  const out: Suggestion[] = []
  const series = buildSeries(ctx)
  for (const s of series) {
    if (!s.futureOpen.length || s.perVisit <= 0) continue
    const sqft = sqftFor(s.property)
    if (sqft <= 0) continue                                   // need a real measurement to trust the target
    const completedVisits = s.jobs.filter(j => j.status === 'completed').length
    if (completedVisits < 1) continue                          // don't raise an unproven brand-new series
    const recommended = recommendedJobPrice(sqft, ctx.pricingConfig)
    if (recommended <= 0) continue
    const newPrice = round5(Math.min(recommended, s.perVisit * 1.4)) // never propose an absurd jump
    if (newPrice < s.perVisit + 5) continue
    const vpy = seriesVisitsPerYear(s)
    const annual = Math.round((newPrice - s.perVisit) * vpy)
    if (annual < 100) continue                                 // skip trivial raises (raised floor)

    const confidence: Confidence = completedVisits >= 3 ? 'high' : 'medium'
    const why: string[] = [
      `Below the recommended price for this ${sqft.toLocaleString()} ft² lawn`,
      `${s.cadence || 'recurring'} · ${vpy} visit${vpy !== 1 ? 's' : ''}/season → +$${annual}/yr`,
    ]
    if (completedVisits >= 3) why.push(`Long-term customer — ${completedVisits} visits completed`)
    const calc = [
      `Recommended for ${sqft.toLocaleString()} ft² ≈ $${recommended}/visit (your pricing settings)`,
      `Raise = $${Math.round(s.perVisit)} → $${newPrice} = +$${newPrice - Math.round(s.perVisit)}/visit`,
      `Annual = +$${newPrice - Math.round(s.perVisit)} × ${vpy} visits/season = +$${annual}/yr`,
    ]

    out.push({
      id: `price-${s.recurrenceId}`,
      category: 'profit',
      title: `Raise ${s.customerName} from $${Math.round(s.perVisit)} → $${newPrice}`,
      subtitle: s.rep.service_type || (s.cadence ? `${s.cadence} service` : undefined),
      impact: annual, oneTime: false, revenueImpact: annual, profitImpact: annual,
      confidence, confidenceScore: CONF_SCORE[confidence], why, calc,
      action: raiseAction(s, newPrice, ctx),
    })
  }
  return out
}

// ── 💰 PROFIT: add-on upsell programs ───────────────────────────────────────────
function addonUpsells(ctx: SuggestionContext): Suggestion[] {
  const out: Suggestion[] = []
  // Penetration of each add-on across LAWN jobs only (so the denominator and the
  // add-on amounts are apples-to-apples; ignore $0 line items in the average).
  const lawnJobs = ctx.jobs.filter(j => serviceCategory(j.service_type) === 'lawn')
  const lawnCustomers = new Set(lawnJobs.map(j => j.customer_id).filter(Boolean) as string[])
  if (lawnCustomers.size < 2) return out
  const buyersByKey: Record<string, { label: string; amounts: number[]; custIds: Set<string>; program: boolean }> = {}
  for (const j of lawnJobs) {
    for (const li of ctx.lineItemsByJob[j.id] || []) {
      const amt = Number(li.amount) || 0
      if (amt <= 0) continue
      const key = li.service_key || normalizeServiceKey(li.description)
      const e = (buyersByKey[key] ||= { label: li.description, amounts: [], custIds: new Set(), program: isRecurringProgramService(li.description) })
      e.amounts.push(amt)
      if (j.customer_id) e.custIds.add(j.customer_id)
    }
  }
  for (const [key, e] of Object.entries(buyersByKey)) {
    if (e.custIds.size < 2 || !e.amounts.length) continue // need a real signal
    const penetration = e.custIds.size / lawnCustomers.size
    if (penetration <= 0 || penetration > 0.7) continue
    const avg = Math.round(e.amounts.reduce((s, n) => s + n, 0) / e.amounts.length)
    if (avg <= 0) continue
    const candidates = [...lawnCustomers].filter(cid => !e.custIds.has(cid))
    if (candidates.length < 1) continue
    const appsPerYear = e.program ? 4 : 1 // a season program bills ~4×; one-shots once
    const annual = Math.round(candidates.length * avg * appsPerYear * 0.4) // conservative 40% take-up
    if (annual < 50) continue
    const confidence: Confidence = penetration >= 0.3 ? 'medium' : 'low'
    out.push({
      id: `upsell-${key}`,
      category: 'profit',
      title: `Offer ${e.label} to ${candidates.length} more customer${candidates.length !== 1 ? 's' : ''}`,
      subtitle: `${Math.round(penetration * 100)}% of your lawn customers already buy it`,
      impact: annual, oneTime: false, revenueImpact: annual, profitImpact: Math.round(annual * 0.8),
      confidence, confidenceScore: CONF_SCORE[confidence],
      why: [
        `${e.custIds.size} customer${e.custIds.size !== 1 ? 's' : ''} already buy ${e.label} (avg $${avg})`,
        `${candidates.length} similar customers don't have it yet`,
        appsPerYear === 1 ? 'One-time add-on · conservative 40% take-up' : 'Recurring program (~4×/season) · conservative 40% take-up',
      ],
      action: { kind: 'navigate', label: 'View customers', href: '/dashboard/customers' },
    })
  }
  return out
}

// ── 💰 PROFIT: one-off → recurring conversion ───────────────────────────────────
// A customer who keeps booking the SAME category of one-off service but has no
// active recurring plan is leaving recurring revenue on the table. Offer to lock
// them in (weekly or biweekly), one click — creating a real plan + visits.
function recurringConversions(ctx: SuggestionContext): Suggestion[] {
  const out: Suggestion[] = []
  const pById = propsById(ctx)
  const qById = quoteById(ctx)
  // Customers who ALREADY have an active plan in a category → skip that pairing.
  const activeRec = new Set<string>()
  for (const s of buildSeries(ctx)) {
    if (s.futureOpen.length > 0 && s.customerId) activeRec.add(`${s.customerId}|${serviceCategory(s.rep.service_type)}`)
  }
  // Group non-recurring, non-cancelled jobs by customer + service category.
  const groups: Record<string, { custId: string; cat: string; jobs: Job[] }> = {}
  for (const j of ctx.jobs) {
    if (j.recurrence_id || j.status === 'cancelled' || !j.customer_id) continue
    const cat = serviceCategory(j.service_type)
    const key = `${j.customer_id}|${cat}`
    ;(groups[key] ||= { custId: j.customer_id, cat, jobs: [] }).jobs.push(j)
  }
  for (const [key, g] of Object.entries(groups)) {
    if (activeRec.has(key)) continue                              // already has a plan in this category
    const completed = g.jobs.filter(j => j.status === 'completed').sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))
    if (completed.length < 2) continue                            // need REPEATED one-offs
    const prices = completed.map(j => jobVisitValue(j.price, (j.quote_id ? qById[j.quote_id] : null) as unknown as Record<string, unknown>, null, false)).filter(p => p > 0)
    if (!prices.length) continue
    const avg = round5(prices.reduce((a, b) => a + b, 0) / prices.length)
    if (avg <= 0) continue
    // Observed cadence from the median gap between visits → recommend weekly/biweekly.
    const gaps: number[] = []
    for (let i = 1; i < completed.length; i++) gaps.push(dayDelta(completed[i - 1].scheduled_date, completed[i].scheduled_date))
    const medGap = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 14
    const recommended = medGap > 0 && medGap <= 10 ? 'weekly' : 'biweekly'
    const weeklyAnnual = avg * SEASON_VISITS.weekly
    const biweeklyAnnual = avg * SEASON_VISITS.biweekly
    const recAnnual = recommended === 'weekly' ? weeklyAnnual : biweeklyAnnual

    const rep = completed[completed.length - 1]
    const prop = rep.property_id ? pById[rep.property_id] : undefined
    const nearby = nearbyCustomerStops(prop, ctx, g.custId)
    const startDate = nextWorkdayStart(ctx)
    const season = seasonForService(rep.service_type, ctx.seasons)
    if (season && !isWithinSeason(startDate, season)) continue   // don't start a seasonal plan off-season
    const endDate = season ? seasonEndDateFor(startDate, season) : null
    const mkPlan = (count: 1 | 2): RecurringPlanPayload => ({
      customerId: g.custId, propertyId: rep.property_id, serviceType: rep.service_type, title: rep.title,
      perVisitPrice: avg, intervalUnit: 'week', intervalCount: count, startDate, endDate,
      crewSize: rep.crew_size || 1, durationMinutes: rep.duration_minutes,
    })
    const confidence: Confidence = completed.length >= 3 ? 'high' : 'medium'
    const svcLabel = g.cat === 'lawn' ? 'mowing' : (rep.service_type || 'service')
    out.push({
      id: `convert-${key}`,
      category: 'profit',
      title: `Put ${rep.customers?.name || rep.title} on a recurring plan`,
      subtitle: `${completed.length} one-off ${svcLabel} visits · no plan yet`,
      impact: Math.round(recAnnual), oneTime: false, revenueImpact: Math.round(recAnnual), profitImpact: Math.round(recAnnual * 0.85),
      confidence, confidenceScore: CONF_SCORE[confidence],
      why: [
        `${completed.length} one-off ${svcLabel} visits at avg $${avg} — re-quoted each time`,
        nearby > 0 ? `On-route: ${nearby} nearby customer${nearby !== 1 ? 's' : ''} — recurring adds route density` : 'Locks in predictable recurring revenue',
        `They visit ~every ${medGap || 14} days → ${recommended} fits`,
      ],
      calc: [
        `Weekly: $${avg} × ${SEASON_VISITS.weekly} visits/season = $${Math.round(weeklyAnnual)}/yr`,
        `Biweekly: $${avg} × ${SEASON_VISITS.biweekly} visits/season = $${Math.round(biweeklyAnnual)}/yr`,
        `Per-visit price = average of ${prices.length} past one-off${prices.length !== 1 ? 's' : ''}`,
      ],
      action: { kind: 'create-recurring', label: `Convert to ${recommended}`, plan: mkPlan(recommended === 'weekly' ? 1 : 2) },
      actions: [
        { kind: 'create-recurring', label: `Weekly · +$${Math.round(weeklyAnnual)}/yr`, plan: mkPlan(1) },
        { kind: 'create-recurring', label: `Biweekly · +$${Math.round(biweeklyAnnual)}/yr`, plan: mkPlan(2) },
      ],
    })
  }
  return out
}

// ── 🚗 ROUTE: validated optimizer moves ─────────────────────────────────────────
function routeImprovements(ctx: SuggestionContext): Suggestion[] {
  const out: Suggestion[] = []
  const optJobs: OptJob[] = ctx.jobs.map(j => ({
    id: j.id, scheduled_date: j.scheduled_date, status: j.status, recurrence_id: j.recurrence_id,
    start_time: j.start_time, duration_minutes: j.duration_minutes,
    lat: j.properties?.lat ?? null, lng: j.properties?.lng ?? null,
    value: 0, invoiced: ctx.invoicedJobIds.has(j.id), title: j.title,
    customerName: j.customers?.name || j.title, customerId: j.customer_id,
    serviceType: j.service_type, neighborhood: j.properties?.neighborhood ?? null,
    preferredDays: j.customers?.preferred_days ?? j.properties?.preferred_days ?? null,
    avoidDays: j.customers?.avoid_days ?? j.properties?.avoid_days ?? null,
  }))
  if (!optJobs.length) return out
  const recs: Record<string, { freq: string | null; interval_unit: string | null; interval_count: number | null }> = {}
  for (const [id, r] of Object.entries(ctx.recurrences)) recs[id] = { freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count }
  const base: Omit<OptOptions, 'mode' | 'scope' | 'anchorDate'> = {
    today: ctx.today, base: ctx.baseCoord, preferredDays: ctx.preferredDays, capacityHours: ctx.capacityHours, recurrences: recs,
  }
  let schedSuggestions
  try { schedSuggestions = analyzeSchedule(optJobs, base) } catch { return out }
  // Several cards (cluster-merge + recurring) can be backed by the SAME
  // optimization run — attribute its savings to ONE card only, so a single
  // reshuffle isn't counted twice in the feed.
  const seenOptKey = new Set<string>()
  for (const s of schedSuggestions) {
    if (!s.actionable) continue
    const optKey = `${s.mode}|${s.scope}|${s.anchorDate}`
    if (seenOptKey.has(optKey)) continue
    let kmSaved = 0, minSaved = 0
    try {
      const r = optimizeSchedule(optJobs, { ...base, mode: s.mode as OptimizeMode, scope: s.scope as OptimizeScope, anchorDate: s.anchorDate })
      kmSaved = r.kmSaved; minSaved = r.minutesSaved
    } catch { /* fall back to qualitative */ }
    if (kmSaved <= 0 && minSaved <= 0) continue
    seenOptKey.add(optKey)
    // ONE-TIME value of the reshuffle: freed crew time + fuel/maintenance.
    const value = Math.round((minSaved / 60) * ctx.crewCost + kmSaved * FUEL_COST_PER_KM)
    out.push({
      id: `route-${s.id}`,
      category: 'route',
      title: s.title,
      subtitle: s.detail,
      impact: value, oneTime: true,
      timeSavedMin: minSaved > 0 ? minSaved : undefined,
      distanceSavedKm: kmSaved > 0 ? kmSaved : undefined,
      confidence: 'high', confidenceScore: CONF_SCORE.high,
      why: [
        kmSaved > 0 ? `Cuts ~${kmSaved} km of driving` : '',
        minSaved > 0 ? `Frees ~${minSaved} min of drive time` : '',
        'Every move is cadence- and preference-validated by the optimizer',
      ].filter(Boolean),
      action: { kind: 'navigate', label: 'Review & apply', href: '/dashboard/schedule' },
    })
  }
  return out
}

// ── ⚠️ PROBLEMS: below revenue/hour target (customers, routes, areas) + missed ──
// The guardrail. A customer/route/area earning below the owner's Target Revenue
// Per Hour is flagged with a GRADUATED fix — raise price → improve density →
// review — never jumping straight to "drop".
function problems(ctx: SuggestionContext): Suggestion[] {
  const out: Suggestion[] = []
  const target = ctx.targetRevPerHour
  const series = buildSeries(ctx)
  const located = ctx.jobs.filter(j => j.properties?.lat != null && j.properties?.lng != null).map(j => ({ lat: j.properties!.lat as number, lng: j.properties!.lng as number }))
  const actualByCust: Record<string, number[]> = {}
  for (const j of ctx.jobs) if (j.customer_id && j.status === 'completed' && Number(j.actual_minutes) > 0) (actualByCust[j.customer_id] ||= []).push(Number(j.actual_minutes))

  // 1) Customers below target — graduated recommendation.
  for (const s of series) {
    if (!s.futureOpen.length || s.perVisit <= 0) continue
    const sqft = sqftFor(s.property)
    const actuals = s.customerId ? actualByCust[s.customerId] : undefined
    const onSite = actuals?.length ? Math.round(actuals.reduce((a, b) => a + b, 0) / actuals.length)
      : sqft > 0 ? estimateVisitMinutes(sqft) : ONSITE_DEFAULT
    const hasGeo = s.property?.lat != null && s.property?.lng != null
    // Only flag when there's a real signal (geo or timed visits) — never on pure guesses.
    if (!hasGeo && !(actuals?.length ?? 0)) continue
    const driveMin = driveMinFor(s.property, ctx, located)
    const econ = visitEconomics(s.perVisit, onSite, driveMin, ctx.crewCost)
    if (econ.revPerHour >= target) continue                    // meets the floor → fine
    const vpy = seriesVisitsPerYear(s)
    const hoursPerVisit = (onSite + driveMin) / 60
    const annualGap = Math.round(Math.max(0, Math.round(target * hoursPerVisit) - s.perVisit) * vpy)

    const recommended = sqft > 0 ? recommendedJobPrice(sqft, ctx.pricingConfig) : 0
    // Route Density Score decides the "isolated → improve density" path.
    const density = hasGeo ? densityFor({ lat: s.property!.lat as number, lng: s.property!.lng as number }, located) : null
    const isolated = !density || density.tier === 'isolated'
    const confidence: Confidence = (actuals?.length ?? 0) >= 3 && hasGeo && located.length > 1 ? 'high' : 'medium'
    const name = s.customerName
    const calc = [
      `Revenue/hr = $${Math.round(s.perVisit)} ÷ ${hoursPerVisit.toFixed(2)} h (${onSite} on-site + ${driveMin} drive) = $${econ.revPerHour}/hr`,
      `Profit/hr = $${econ.profitPerHour}/hr after $${ctx.crewCost}/hr crew cost`,
      `Your target is $${target}/hr → reaching it ≈ +$${annualGap}/yr`,
    ]
    let title: string, why: string[], action: SuggestionAction
    if (recommended > s.perVisit + 5) {
      // FIX #1 — RAISE PRICE (measured & below recommended).
      const newPrice = round5(Math.min(recommended, s.perVisit * 1.4))
      title = `Raise ${name} to $${newPrice} — under your $${target}/hr target`
      why = [
        `$${econ.revPerHour}/hr revenue — below your $${target}/hr floor`,
        `Below the recommended price for this ${sqft.toLocaleString()} ft² lawn`,
        `${driveMin} min drive · ${onSite} min on site · $${Math.round(s.perVisit)}/visit`,
      ]
      action = raiseAction(s, newPrice, ctx)
    } else if (isolated) {
      // FIX #2 — IMPROVE ROUTE DENSITY (isolated stop, per the density score).
      title = `Tighten the route around ${name} — under $${target}/hr`
      why = [
        `$${econ.revPerHour}/hr revenue — below your $${target}/hr floor`,
        `Isolated stop: ${density?.within2km ?? 0} customers within 2 km${density?.nearestKm != null ? `, nearest ${density.nearestKm} km` : ''}, ${driveMin} min drive each way`,
        'Add a neighbour on the same day, or move to a denser day, to lift $/hr',
      ]
      action = { kind: 'navigate', label: 'Build density', href: '/dashboard/saturation' }
    } else {
      // FIX #3 — REVIEW (can't easily raise, not isolated). Drop only as last resort.
      title = `Review ${name} — under your $${target}/hr target`
      why = [
        `$${econ.revPerHour}/hr revenue, $${econ.profit}/visit profit — below your $${target}/hr floor`,
        `${driveMin} min drive · ${onSite} min on site · $${Math.round(s.perVisit)}/visit`,
        econ.profit <= 0 ? 'Losing money — raise the price, or drop only if it can’t be fixed' : 'Consider a small raise or a route change before anything drastic',
      ]
      action = { kind: 'navigate', label: 'Review customer', href: s.customerId ? `/dashboard/customers/${s.customerId}` : '/dashboard/customers' }
    }
    out.push({
      id: `problem-${s.recurrenceId}`,
      category: 'problem',
      title,
      subtitle: s.rep.service_type || undefined,
      impact: annualGap, oneTime: false, profitImpact: annualGap, revenueImpact: 0,
      confidence, confidenceScore: CONF_SCORE[confidence], why, calc, action,
    })
  }

  // 2) Routes below target — the worst upcoming work day.
  try {
    const { jobs: pjobs, pctx } = profitJobsAndCtx(ctx)
    const byDate: Record<string, typeof pjobs> = {}
    for (const j of pjobs) if (j.scheduled_date >= ctx.today && j.status !== 'cancelled' && j.lat != null) (byDate[j.scheduled_date] ||= []).push(j)
    const dayCards = Object.entries(byDate)
      .filter(([, dj]) => dj.length >= 3)
      .map(([date, dj]) => ({ date, rp: dayProfitability(date, dj, pctx) }))
      .filter(x => x.rp.revPerHour > 0 && x.rp.revPerHour < target)
      .sort((a, b) => a.rp.revPerHour - b.rp.revPerHour)
    for (const { date, rp } of dayCards.slice(0, 1)) {
      const label = format(parseISO(date + 'T00:00:00'), 'EEE, MMM d')
      out.push({
        id: `target-route-${date}`,
        category: 'route',
        title: `${label} route earns $${rp.revPerHour}/hr`,
        subtitle: `Below your $${target}/hr target`,
        impact: Math.round((target - rp.revPerHour) * rp.totalHours), oneTime: true,
        confidence: 'medium', confidenceScore: CONF_SCORE.medium,
        why: [
          `$${rp.revPerHour}/hr across ${rp.driveMinutes} min driving + ${rp.laborMinutes} min on site`,
          'Tighten or add a stop on this day to lift $/hr',
        ],
        calc: [`Revenue/hr = $${rp.revenue} ÷ ${rp.totalHours.toFixed(1)} h = $${rp.revPerHour}/hr (target $${target})`],
        action: { kind: 'navigate', label: 'Optimize the day', href: '/dashboard/schedule' },
      })
    }
    // 3) Areas below target — the worst neighbourhood.
    const hoods = neighborhoodProfitability(pjobs, pctx)
      .filter(h => h.key !== 'Unknown' && h.customers >= 2 && h.revPerHour > 0 && h.revPerHour < target)
      .sort((a, b) => a.revPerHour - b.revPerHour)
    for (const h of hoods.slice(0, 1)) {
      out.push({
        id: `target-area-${h.key}`,
        category: 'problem',
        title: `${h.key} earns $${h.revPerHour}/hr — under target`,
        subtitle: `${h.customers} customers · target $${target}/hr`,
        impact: Math.round((target - h.revPerHour) * (h.laborMinutes / 60)), oneTime: false,
        confidence: 'low', confidenceScore: CONF_SCORE.low,
        why: [
          `$${h.revPerHour}/hr across ${h.customers} customers — below your $${target}/hr floor`,
          'Raise prices here or build route density to lift the whole area',
        ],
        calc: [`Revenue/hr = $${h.revenue} ÷ ${(h.laborMinutes / 60).toFixed(1)} h = $${h.revPerHour}/hr (target $${target})`],
        action: { kind: 'navigate', label: 'See the area', href: '/dashboard/saturation' },
      })
    }
  } catch { /* route/area cards are best-effort */ }

  // Missed jobs — overdue SCHEDULED visits sitting unbilled. (in_progress is
  // legitimately being worked, not missed.)
  const missed = ctx.jobs.filter(j => j.status === 'scheduled' && j.scheduled_date < ctx.today)
  if (missed.length) {
    const qById = quoteById(ctx)
    const atRisk = missed.reduce((sum, j) => {
      const rec = j.recurrence_id ? ctx.recurrences[j.recurrence_id] : null
      const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
      const q = j.quote_id ? qById[j.quote_id] : null
      return sum + jobVisitValue(j.price, q as unknown as Record<string, unknown>, freq, j.is_initial_visit)
    }, 0)
    out.push({
      id: 'problem-missed',
      category: 'problem',
      title: `Close ${missed.length} missed job${missed.length !== 1 ? 's' : ''}`,
      subtitle: 'Overdue visits not marked done or rescheduled',
      impact: Math.round(atRisk), oneTime: true, profitImpact: Math.round(atRisk), revenueImpact: Math.round(atRisk),
      confidence: 'high', confidenceScore: CONF_SCORE.high,
      why: [
        `${missed.length} visit${missed.length !== 1 ? 's' : ''} past their scheduled date`,
        `$${Math.round(atRisk)} in unrecorded work`,
        'Mark done (invoice it) or reschedule to recover',
      ],
      action: { kind: 'navigate', label: 'Fix on schedule', href: '/dashboard/schedule' },
    })
  }
  return out
}

// ── 📍 GROWTH: expand into strong neighborhoods + neighbor leads ─────────────────
function growth(ctx: SuggestionContext): Suggestion[] {
  const out: Suggestion[] = []
  const { jobs, pctx } = profitJobsAndCtx(ctx)
  let hoods: ReturnType<typeof neighborhoodProfitability> = []
  try { hoods = neighborhoodProfitability(jobs, pctx) } catch { hoods = [] }
  const ranked = hoods.filter(h => h.key !== 'Unknown' && h.customers >= 2)
  const avgRevPerJob = ranked.length ? ranked.reduce((s, h) => s + h.revPerJob, 0) / ranked.length : 0
  // Strong + not yet saturated → flyer / expansion target.
  const targets = ranked.filter(h => h.revPerJob >= avgRevPerJob && h.customers < 6).sort((a, b) => b.revPerJob - a.revPerJob).slice(0, 2)
  for (const h of targets) {
    // Conservative annual value of one new customer = per-job revenue across a
    // biweekly-equivalent season (the assumption is disclosed in the why bullets).
    const annualPerCustomer = h.revPerJob * SEASON_VISITS_BIWEEKLY
    const newCustomers = Math.max(1, Math.min(4, Math.round(h.customers * 0.5)))
    const annual = Math.round(annualPerCustomer * newCustomers * 0.3) // conservative 30% conversion
    if (annual < 100) continue
    out.push({
      id: `growth-hood-${h.key}`,
      category: 'growth',
      title: `Target ${h.key} for flyers`,
      subtitle: `${h.customers} customers already · strong route density`,
      impact: annual, oneTime: false, revenueImpact: annual,
      confidence: 'low', confidenceScore: CONF_SCORE.low,
      why: [
        `${h.customers} customers, $${h.revPerJob}/job — above your $${Math.round(avgRevPerJob)} average`,
        `Dense route here absorbs travel — new stops are nearly pure profit`,
        `Estimate: ${newCustomers} more × ~${SEASON_VISITS_BIWEEKLY} visits/season × 30% flyer conversion ≈ +$${annual}/yr`,
      ],
      action: { kind: 'navigate', label: 'See the map', href: '/dashboard/saturation' },
    })
  }
  // Neighbor leads not yet quoted — warm, on-route prospects. Rank by their real
  // projected value (lead count × on-route customer value × conservative close
  // rate) instead of $0, so they don't sink to the bottom of the feed.
  const openLeads = ctx.neighborLeads.filter(l => l.status === 'prospect' || l.status === 'contacted').length
  if (openLeads >= 1) {
    const perCustomer = (avgRevPerJob > 0 ? avgRevPerJob : 50) * SEASON_VISITS_BIWEEKLY
    const annual = Math.round(openLeads * perCustomer * 0.4) // warm on-route leads close at ~40%
    out.push({
      id: 'growth-leads',
      category: 'growth',
      title: `Follow up ${openLeads} neighbor lead${openLeads !== 1 ? 's' : ''}`,
      subtitle: 'Warm prospects next to your existing routes',
      impact: annual, oneTime: false,
      confidence: 'medium', confidenceScore: CONF_SCORE.medium,
      why: [
        `${openLeads} lead${openLeads !== 1 ? 's' : ''} waiting in prospect/contacted`,
        'They sit right on your current routes — low travel cost to win',
        `Estimate: ${openLeads} × on-route customer value × 40% close ≈ +$${annual}/yr`,
      ],
      action: { kind: 'navigate', label: 'Open leads', href: '/dashboard/neighbors' },
    })
  }
  return out
}

// ── ❤️ RETENTION: win back ran-out/lapsed + chase quotes ─────────────────────────
function retention(ctx: SuggestionContext): Suggestion[] {
  const out: Suggestion[] = []
  const series = buildSeries(ctx)
  // Customers with ANY upcoming visit (any service) are NOT lapsed — they may
  // have a different service booked (e.g. fall aeration), so don't nag them.
  const custWithFuture = new Set(
    ctx.jobs.filter(j => j.customer_id && j.scheduled_date >= ctx.today && j.status !== 'completed' && j.status !== 'cancelled')
      .map(j => j.customer_id as string),
  )
  // A series with NO future visit, customer fully unscheduled, season active = lapsed.
  let lapsedCount = 0, lapsedAnnual = 0
  for (const s of series) {
    if (s.futureOpen.length > 0) continue
    if (s.customerId && custWithFuture.has(s.customerId)) continue // booked for something else
    const lastDone = [...s.jobs].reverse().find(j => j.status === 'completed')
    if (!lastDone) continue
    const season = seasonForService(s.rep.service_type, ctx.seasons)
    if (season && !isWithinSeason(ctx.today, season)) continue // off-season dormant, not lapsed
    lapsedCount++
    lapsedAnnual += s.perVisit * seriesVisitsPerYear(s)
  }
  if (lapsedCount >= 1) {
    const annual = Math.round(lapsedAnnual * 0.3) // conservative 30% win-back
    out.push({
      id: 'retention-lapsed',
      category: 'retention',
      title: `Win back ${lapsedCount} lapsed customer${lapsedCount !== 1 ? 's' : ''}`,
      subtitle: 'Recurring customers with no upcoming visit (in-season)',
      impact: annual, oneTime: false, revenueImpact: Math.round(lapsedAnnual),
      confidence: 'medium', confidenceScore: CONF_SCORE.medium,
      why: [
        `${lapsedCount} recurring customer${lapsedCount !== 1 ? 's' : ''} ran out of scheduled visits`,
        `$${Math.round(lapsedAnnual)}/yr of recurring revenue at stake`,
        `~30% typically return when re-contacted in season → +$${annual}/yr`,
      ],
      action: { kind: 'navigate', label: 'Win them back', href: '/dashboard/reactivation' },
    })
  }
  // Sent quotes gone quiet ≥ the follow-up window. Computed against ctx.today
  // (local midnight) rather than needsFollowUp's Date.now(), so a feed built in
  // the morning is still correct at night / across midnight.
  const daysToToday = (dateStr: string | null): number => {
    if (!dateStr) return Infinity // sent but never timestamped → surface it
    return Math.floor((new Date(ctx.today + 'T00:00:00').getTime() - new Date(dateStr).getTime()) / 86_400_000)
  }
  const toChase = ctx.quotes.filter(q => q.status === 'sent' && daysToToday(q.last_followed_up_at || q.sent_at) >= FOLLOW_UP_DAYS)
  if (toChase.length) {
    const atRisk = toChase.reduce((s, q) => s + Number(q.total || 0), 0)
    out.push({
      id: 'retention-followup',
      category: 'retention',
      title: `Follow up ${toChase.length} quote${toChase.length !== 1 ? 's' : ''}`,
      subtitle: 'Sent quotes gone quiet',
      impact: Math.round(atRisk * 0.15), oneTime: true, revenueImpact: Math.round(atRisk),
      confidence: 'medium', confidenceScore: CONF_SCORE.medium,
      why: [
        `${toChase.length} sent quote${toChase.length !== 1 ? 's' : ''} past the ${3}-day follow-up mark`,
        `$${Math.round(atRisk)} in pending work`,
        'A nudge converts ~15% of quiet quotes',
      ],
      action: { kind: 'navigate', label: 'Chase quotes', href: '/dashboard/quotes' },
    })
  }
  return out
}

// ── 🚗 ROUTE: gap finder — fill unused schedule capacity ────────────────────────
// Spots upcoming preferred work days running well under capacity, and — only when
// there's something concrete to fill them with (warm neighbour leads or in-season
// lapsed customers) — recommends doing so. Reuses the same dayLoad/capacity engine
// Day Ops uses, so "light day" means the same thing everywhere.
function routeGapFinder(ctx: SuggestionContext): Suggestion[] {
  const out: Suggestion[] = []
  const pref = ctx.preferredDays.length ? new Set(ctx.preferredDays) : null
  let lightDays = 0, spareMin = 0
  for (let i = 1; i <= 14; i++) {
    const d = addDays(parseISO(ctx.today + 'T00:00:00'), i)
    if (pref && !pref.has(getDay(d))) continue
    const iso = format(d, 'yyyy-MM-dd')
    const dayJobs = ctx.jobs.filter(j => j.scheduled_date === iso && j.status !== 'cancelled')
    const laborMin = dayJobs.reduce((s, j) => s + (j.duration_minutes || DEFAULT_JOB_MIN), 0)
    const load = dayLoad(laborMin, ctx.capacityHours)
    if (load.spareMin >= 180) { lightDays++; spareMin += load.spareMin } // ≥3h of room = light
  }
  if (lightDays === 0 || spareMin < 240) return out                       // need a meaningful gap (≥4h total)
  const spareHours = Math.round(spareMin / 60)

  // Concrete fillers: warm neighbour leads + in-season lapsed customers.
  const openLeads = ctx.neighborLeads.filter(l => l.status === 'prospect' || l.status === 'contacted').length
  const futureCust = new Set(ctx.jobs.filter(j => j.customer_id && j.scheduled_date >= ctx.today && j.status !== 'completed' && j.status !== 'cancelled').map(j => j.customer_id as string))
  let lapsed = 0
  for (const s of buildSeries(ctx)) {
    if (s.futureOpen.length || (s.customerId && futureCust.has(s.customerId))) continue
    if (!s.jobs.some(j => j.status === 'completed')) continue
    const season = seasonForService(s.rep.service_type, ctx.seasons)
    if (season && !isWithinSeason(ctx.today, season)) continue
    lapsed++
  }
  if (openLeads + lapsed === 0) return out                                // nothing to fill it with → stay quiet

  const impact = Math.round(spareHours * ctx.targetRevPerHour)            // value of the gap if filled
  const useLeads = openLeads > 0
  out.push({
    id: 'route-gap',
    category: 'route',
    title: `Fill ~${spareHours}h of empty capacity over the next 2 weeks`,
    subtitle: `${lightDays} light work day${lightDays !== 1 ? 's' : ''}`,
    impact, oneTime: true,
    confidence: 'medium', confidenceScore: CONF_SCORE.medium,
    why: [
      `${lightDays} upcoming work day${lightDays !== 1 ? 's' : ''} under half capacity (~${spareHours}h free)`,
      openLeads > 0 ? `${openLeads} warm neighbour lead${openLeads !== 1 ? 's' : ''} ready to slot in` : '',
      lapsed > 0 ? `${lapsed} lapsed customer${lapsed !== 1 ? 's' : ''} you could win back` : '',
    ].filter(Boolean),
    calc: [`~${spareHours}h free × $${ctx.targetRevPerHour}/hr target ≈ $${impact} of fillable work`],
    action: { kind: 'navigate', label: useLeads ? 'Knock nearby leads' : 'Win back customers', href: useLeads ? '/dashboard/neighbors' : '/dashboard/reactivation' },
  })
  return out
}

// ── the advisor ─────────────────────────────────────────────────────────────────
export function buildSuggestions(ctx: SuggestionContext): Suggestion[] {
  const gens: Array<() => Suggestion[]> = [
    () => priceRaises(ctx),
    () => recurringConversions(ctx),
    () => addonUpsells(ctx),
    () => routeImprovements(ctx),
    () => routeGapFinder(ctx),
    () => problems(ctx),
    () => growth(ctx),
    () => retention(ctx),
  ]
  let all: Suggestion[] = []
  for (const g of gens) { try { all.push(...g()) } catch { /* a failing generator never breaks the feed */ } }

  // De-dupe contradictory cards for the SAME customer: a thin-margin "problem"
  // dominates — suppress that series' plain price-raise (same action, confusing as two).
  const problemRids = new Set(all.filter(s => s.id.startsWith('problem-') && s.id !== 'problem-missed').map(s => s.id.slice('problem-'.length)))
  all = all.filter(s => !(s.id.startsWith('price-') && problemRids.has(s.id.slice('price-'.length))))

  // Rank by EXPECTED impact: weight the magnitude by confidence (owners want
  // trustworthy moves first, not the biggest guess), and halve speculative
  // one-time amounts — EXCEPT missed jobs, which are money owed today and pin high.
  const CONF_WEIGHT: Record<Confidence, number> = { high: 1, medium: 0.7, low: 0.45 }
  const rankValue = (s: Suggestion) => {
    const oneTimePenalty = s.oneTime && s.id !== 'problem-missed' ? 0.5 : 1
    return s.impact * CONF_WEIGHT[s.confidence] * oneTimePenalty
  }
  return all.sort((a, b) => (rankValue(b) - rankValue(a)) || (b.confidenceScore - a.confidenceScore))
}

// ── one-click apply (price raise) ─────────────────────────────────────────────
// Mirrors the schedule page's applyPriceChange future-scope: write the quote
// cadence price (or jobs.price for one-time), freeze billed/past visits at the
// old value, clear future visits so they DERIVE the new price, log the change,
// and re-sync affected draft invoices. The JOB stays the source of truth.
export async function applyPriceRaise(
  supabase: SupabaseClient,
  payload: PriceApplyPayload,
  reason = 'Suggested raise',
): Promise<{ ok: boolean; error?: string }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in' }
  try {
    if (payload.quoteId && payload.cadenceField) {
      if (payload.freezeJobIds.length && payload.oldVisitValue > 0) {
        await supabase.from('jobs').update({ price: payload.oldVisitValue }).in('id', payload.freezeJobIds)
      }
      const { error: qErr } = await supabase.from('quotes').update({ [payload.cadenceField]: payload.newPrice }).eq('id', payload.quoteId)
      if (qErr) return { ok: false, error: qErr.message }
      if (payload.clearJobIds.length) await supabase.from('jobs').update({ price: null }).in('id', payload.clearJobIds)
      await recordPriceChange(supabase, { userId: user.id, jobId: payload.repJobId ?? payload.clearJobIds[0] ?? null, quoteId: payload.quoteId, scope: 'future', oldAmount: payload.oldVisitValue, newAmount: payload.newPrice, reason, changedByEmail: user.email })
      // Re-sync the draft invoices of BOTH the cleared (future) and frozen (past)
      // visits so jobs.price and invoice.amount can't drift apart (idempotent).
      await syncDraftInvoiceAmounts(supabase, [...payload.clearJobIds, ...payload.freezeJobIds], { reason })
    } else if (payload.jobId) {
      const { error: jErr } = await supabase.from('jobs').update({ price: payload.newPrice }).eq('id', payload.jobId)
      if (jErr) return { ok: false, error: jErr.message }
      await recordPriceChange(supabase, { userId: user.id, jobId: payload.jobId, scope: 'this', oldAmount: payload.oldVisitValue, newAmount: payload.newPrice, reason, changedByEmail: user.email })
      await syncDraftInvoiceAmounts(supabase, [payload.jobId], { reason })
    } else {
      return { ok: false, error: 'Nothing to apply' }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Apply failed' }
  }
}

// ── one-click apply (create recurring plan) ───────────────────────────────────
// Mirrors the schedule page's convertToRecurring: GENERATE + VALIDATE before any
// write (refuse a plan with no visits), insert the recurrence, then its visits;
// roll the orphan recurrence back if the visit insert fails. Non-quote series →
// the per-visit price lives on every job (no initial/cadence split).
export async function createRecurringPlan(
  supabase: SupabaseClient,
  plan: RecurringPlanPayload,
): Promise<{ ok: boolean; error?: string; count?: number }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in' }
  try {
    const dates = generateOccurrences(plan.startDate, plan.intervalUnit, plan.intervalCount, plan.endDate, null)
    const future = dates.filter(d => d >= plan.startDate)
    if (future.length === 0) return { ok: false, error: 'No visits would be generated — check the season window.' }
    const { data: rec, error: recErr } = await supabase.from('job_recurrences').insert({
      user_id: user.id,
      freq: plan.intervalCount === 1 ? 'weekly' : plan.intervalCount === 2 ? 'biweekly' : null,
      interval_unit: plan.intervalUnit, interval_count: plan.intervalCount,
      start_date: plan.startDate, end_date: plan.endDate, end_count: null,
      customer_id: plan.customerId,
    }).select().single()
    if (recErr || !rec) return { ok: false, error: recErr?.message || 'Could not create the plan' }
    const rows = future.map(d => ({
      user_id: user.id, customer_id: plan.customerId, property_id: plan.propertyId, quote_id: null,
      recurrence_id: (rec as { id: string }).id, title: plan.title, service_type: plan.serviceType,
      scheduled_date: d, crew_size: plan.crewSize, status: 'scheduled', price: plan.perVisitPrice,
      is_initial_visit: false, duration_minutes: plan.durationMinutes,
    }))
    const { error: jErr } = await supabase.from('jobs').insert(rows)
    if (jErr) {
      await supabase.from('job_recurrences').delete().eq('id', (rec as { id: string }).id) // rollback orphan
      return { ok: false, error: jErr.message }
    }
    return { ok: true, count: future.length }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Create failed' }
  }
}
