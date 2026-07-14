import type { SupabaseClient } from '@supabase/supabase-js'
import type { Job, Quote, JobRecurrence, Property, Customer, JobLineItem } from '@/types'
import { Coord, haversineKm } from '@/lib/geo'
import { dayLoad, DEFAULT_JOB_MIN, computeDayEtas, timeToMinutes, type SpeedModel } from '@/lib/route'
import { densityFor, locatedStops } from '@/lib/routeDensity'
import { resolvePrefs } from '@/lib/preferences'
import { analyzeWinLoss, WLQuote, QuoteOutcomeRow, LOSS_REASON_LABEL } from '@/lib/winLoss'
import { effectiveFreq, jobVisitValue, quoteVisitAmount, syncDraftInvoiceAmounts } from '@/lib/invoicing'
import { recordPriceChange, isRecurringProgramService, normalizeServiceKey } from '@/lib/jobPricing'
import { PricingConfig, recommendedJobPrice, estimateVisitMinutes, SEASON_VISITS } from '@/lib/pricing'
import { visitEconomics } from '@/lib/economics'
import { learnDurations, learnedDurationFor, DurationModel } from '@/lib/duration'
import { ProfitJob, ProfitContext, neighborhoodProfitability, neighborhoodKey, jobValue } from '@/lib/profitability'
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
  // Suggestion keys the owner has dismissed/snoozed (still active as of today).
  // Pre-resolved in loadSuggestions (a snooze that has expired is NOT included),
  // so buildSuggestions just filters by membership.
  dismissedKeys: Set<string>
  workStart: string         // business_settings.work_start_time ('HH:mm') — ETA origin
  speed?: SpeedModel        // learned drive speed (lib/travelLearning); else legacy 2 min/km
  quoteOutcomes: { quote_id: string; reason: string; detail: string | null; competitor_price: number | null }[]
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
// Days between visits for a series — the standard cadence when known, else derived
// from the recurrence interval. Used by predictive churn (how overdue is "overdue").
function cadenceIntervalDays(s: Series): number {
  if (s.cadence === 'weekly') return 7
  if (s.cadence === 'biweekly') return 14
  if (s.cadence === 'monthly') return 30
  const count = Math.max(1, s.rec.interval_count ?? 1)
  return s.rec.interval_unit === 'day' ? count
    : s.rec.interval_unit === 'week' ? 7 * count
    : s.rec.interval_unit === 'month' ? 30 * count
    : 14
}
function round5(n: number): number { return Math.round(n / 5) * 5 }

// ── per-context memoization ─────────────────────────────────────────────────────
// buildSuggestions runs ~9 generators over the SAME ctx; several independently
// rebuild the series list, the quote/property lookups and the ProfitJob
// projection — each an O(jobs) pass. Cache them per ctx object (fresh per load)
// so the heavy work happens once, not 6×. WeakMaps drop with the ctx, no leak.
const _quoteByIdCache = new WeakMap<SuggestionContext, Record<string, Quote>>()
const _propsByIdCache = new WeakMap<SuggestionContext, Record<string, Property>>()
const _seriesCache = new WeakMap<SuggestionContext, Series[]>()
const _profitCache = new WeakMap<SuggestionContext, { jobs: ProfitJob[]; pctx: ProfitContext }>()
const _propStopsCache = new WeakMap<SuggestionContext, Coord[]>()

function quoteById(ctx: SuggestionContext): Record<string, Quote> {
  let m = _quoteByIdCache.get(ctx)
  if (m) return m
  m = {}
  for (const q of ctx.quotes) m[q.id] = q
  _quoteByIdCache.set(ctx, m)
  return m
}
function propsById(ctx: SuggestionContext): Record<string, Property> {
  let m = _propsByIdCache.get(ctx)
  if (m) return m
  m = {}
  for (const p of ctx.properties) m[p.id] = p
  _propsByIdCache.set(ctx, m)
  return m
}
// Memoized series — generators call this; buildSeries does the real work once.
function getSeries(ctx: SuggestionContext): Series[] {
  let s = _seriesCache.get(ctx)
  if (s) return s
  s = buildSeries(ctx)
  _seriesCache.set(ctx, s)
  return s
}
// Located customer stops DEDUPED BY PROPERTY (one point per address). Feeding
// densityFor the raw per-visit jobs would count a customer's own 28 seasonal
// visits as 28 "nearby stops" — wildly inflating density. Dedupe once, reuse.
function propertyStops(ctx: SuggestionContext): Coord[] {
  let s = _propStopsCache.get(ctx)
  if (s) return s
  s = locatedStops(ctx.jobs.map(j => ({ lat: j.properties?.lat ?? null, lng: j.properties?.lng ?? null })))
  _propStopsCache.set(ctx, s)
  return s
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
  return Math.round(nearest * (ctx.speed?.minPerKm ?? 2)) // learned drive speed, else 2 min/km
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
  const cached = _profitCache.get(ctx)
  if (cached) return cached
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
  const result = { jobs, pctx: { quotesById, recById, base: ctx.baseCoord, today: ctx.today } }
  _profitCache.set(ctx, result)
  return result
}

// Lifetime value per customer = sum of completed-visit value (the ONE valuation
// engine via jobValue). Memoized — used by referral ranking and VIP churn.
const _ltvCache = new WeakMap<SuggestionContext, Record<string, number>>()
function getLifetimeValues(ctx: SuggestionContext): Record<string, number> {
  let m = _ltvCache.get(ctx)
  if (m) return m
  const { jobs, pctx } = profitJobsAndCtx(ctx)
  m = {}
  for (const j of jobs) {
    if (j.status !== 'completed' || !j.customer_id) continue
    m[j.customer_id] = (m[j.customer_id] || 0) + jobValue(j, pctx)
  }
  for (const k of Object.keys(m)) m[k] = Math.round(m[k])
  _ltvCache.set(ctx, m)
  return m
}

// Learned on-site durations from check-in/out actuals (lib/duration). Memoized;
// feeds capacity math so "booked solid" reflects the owner's real pace.
const _durationCache = new WeakMap<SuggestionContext, DurationModel>()
function getDurationModel(ctx: SuggestionContext): DurationModel {
  let m = _durationCache.get(ctx)
  if (m) return m
  m = learnDurations(ctx.jobs)
  _durationCache.set(ctx, m)
  return m
}

// Lifetime-value threshold for a "VIP" customer — mirrors the reactivation page.
const VIP_THRESHOLD = 1500

// ── season-date helpers (cross-sell + renewal timing) ──────────────────────────
function pad2(n: number): string { return String(n).padStart(2, '0') }
// The NEXT start date (yyyy-MM-dd, strictly after today) of a recurring season.
function nextSeasonStartISO(season: { startMonth: number; startDay: number }, today: string): string {
  const y = Number(today.slice(0, 4))
  const thisYear = `${y}-${pad2(season.startMonth)}-${pad2(season.startDay)}`
  return thisYear > today ? thisYear : `${y + 1}-${pad2(season.startMonth)}-${pad2(season.startDay)}`
}
// The next end date (yyyy-MM-dd, on/after today) of a season — for "season ending soon".
function nextSeasonEndISO(season: { endMonth: number; endDay: number }, today: string): string {
  const y = Number(today.slice(0, 4))
  const thisYear = `${y}-${pad2(season.endMonth)}-${pad2(season.endDay)}`
  return thisYear >= today ? thisYear : `${y + 1}-${pad2(season.endMonth)}-${pad2(season.endDay)}`
}
function daysUntilISO(iso: string, today: string): number { return dayDelta(today, iso) }
// First preferred work day on/after an ISO date (where a renewed plan begins).
function firstWorkdayOnOrAfter(ctx: SuggestionContext, iso: string): string {
  const pref = ctx.preferredDays.length ? new Set(ctx.preferredDays) : null
  let d = parseISO(iso + 'T00:00:00')
  for (let i = 0; i < 21; i++) {
    if (!pref || pref.has(getDay(d))) return format(d, 'yyyy-MM-dd')
    d = addDays(d, 1)
  }
  return iso
}

// One pass over jobs → the groupings several generators each used to recompute
// (per-customer, completed-per-customer, the future-scheduled list). Memoized, so
// the whole feed shares one O(jobs) scan instead of one per generator.
interface JobIndex {
  byCustomer: Record<string, Job[]>
  completedByCustomer: Record<string, Job[]>
  futureScheduled: Job[]
}
const _jobIndexCache = new WeakMap<SuggestionContext, JobIndex>()
function getJobIndex(ctx: SuggestionContext): JobIndex {
  let m = _jobIndexCache.get(ctx)
  if (m) return m
  const byCustomer: Record<string, Job[]> = {}
  const completedByCustomer: Record<string, Job[]> = {}
  const futureScheduled: Job[] = []
  for (const j of ctx.jobs) {
    if (j.customer_id) {
      (byCustomer[j.customer_id] ||= []).push(j)
      if (j.status === 'completed') (completedByCustomer[j.customer_id] ||= []).push(j)
    }
    if (j.scheduled_date >= ctx.today && j.status !== 'cancelled' && j.status !== 'completed') futureScheduled.push(j)
  }
  m = { byCustomer, completedByCustomer, futureScheduled }
  _jobIndexCache.set(ctx, m)
  return m
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
  const series = getSeries(ctx)
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

// ── 💰 PROFIT: below the neighborhood median ────────────────────────────────────
// Catches underpricing that priceRaises (measurement-gated) can't: a recurring
// customer charged well below what the OWNER charges peers for the SAME service in
// the SAME neighbourhood. The target is the peer median — no sqft/measurement
// needed — so it surfaces the "you forgot to ever raise this one" customers.
function belowMedianPricing(ctx: SuggestionContext): Suggestion[] {
  const out: Suggestion[] = []
  const series = getSeries(ctx)
  // Bucket active priced series by neighbourhood + service category (mowing vs
  // snow vs …) so the median compares like with like.
  const buckets: Record<string, { perVisit: number; s: Series }[]> = {}
  for (const s of series) {
    if (s.perVisit <= 0 || !s.property) continue
    const hood = neighborhoodKey(s.property.postal_code, s.property.city, s.property.neighborhood)
    if (hood === 'Unknown') continue
    const cat = serviceCategory(s.rep.service_type)
    ;(buckets[`${hood}|${cat}`] ||= []).push({ perVisit: s.perVisit, s })
  }
  for (const [key, arr] of Object.entries(buckets)) {
    if (arr.length < 3) continue                              // need real peers for a median
    const sorted = arr.map(x => x.perVisit).sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    if (median <= 0) continue
    const [hood, cat] = key.split('|')
    const svcLabel = cat === 'lawn' ? 'mowing' : cat === 'snow' ? 'snow service' : (cat || 'service')
    for (const { perVisit, s } of arr) {
      if (!s.futureOpen.length) continue                     // only actionable on a live series
      if (perVisit >= median * 0.85) continue                // not meaningfully below the pack
      // False-positive guard: a SMALL measured lawn legitimately priced below the
      // hood median (of bigger lawns) is NOT underpriced. If we have a measurement
      // and the price already meets the size-appropriate recommendation, skip —
      // priceRaises owns the measured case anyway.
      const sqft = sqftFor(s.property)
      if (sqft > 0) {
        const rec = recommendedJobPrice(sqft, ctx.pricingConfig)
        if (rec > 0 && perVisit >= rec) continue
      }
      const target = round5(Math.min(median, perVisit * 1.4))
      if (target < perVisit + 5) continue
      const vpy = seriesVisitsPerYear(s)
      const annual = Math.round((target - perVisit) * vpy)
      if (annual < 100) continue
      const confidence: Confidence = arr.length >= 5 ? 'medium' : 'low'
      out.push({
        id: `median-${s.recurrenceId}`,
        category: 'profit',
        title: `Raise ${s.customerName} from $${Math.round(perVisit)} → $${target}`,
        subtitle: `Below your ${hood} ${svcLabel} average`,
        impact: annual, oneTime: false, revenueImpact: annual, profitImpact: annual,
        confidence, confidenceScore: CONF_SCORE[confidence],
        why: [
          `$${Math.round(perVisit)}/visit vs your $${Math.round(median)} typical for ${svcLabel} in ${hood}`,
          `${s.cadence || 'recurring'} · ${vpy} visit${vpy !== 1 ? 's' : ''}/season → +$${annual}/yr`,
          `Based on ${arr.length} of your own ${svcLabel} customers in this area`,
        ],
        calc: [
          `Median ${svcLabel} price in ${hood} = $${Math.round(median)}/visit (your ${arr.length} customers)`,
          `Raise = $${Math.round(perVisit)} → $${target} = +$${target - Math.round(perVisit)}/visit × ${vpy} = +$${annual}/yr`,
        ],
        action: raiseAction(s, target, ctx),
      })
    }
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
    // Require a real adoption PATTERN (≥20% already buy) and a meaningful target
    // pool (≥2 customers) — a single coincidental add-on isn't an upsell program.
    if (penetration < 0.2 || penetration > 0.7) continue
    const avg = Math.round(e.amounts.reduce((s, n) => s + n, 0) / e.amounts.length)
    if (avg <= 0) continue
    const candidates = [...lawnCustomers].filter(cid => !e.custIds.has(cid))
    if (candidates.length < 2) continue
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
  for (const s of getSeries(ctx)) {
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
    minPerKm: ctx.speed?.minPerKm,
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
  const series = getSeries(ctx)
  // Deduped per-property stops — NOT per visit — so density/nearest reflects how
  // many distinct CUSTOMERS are nearby, not how often one is serviced.
  const located = propertyStops(ctx)
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
  // (Flyer/expansion hood targeting now lives in neighborhoodDomination — richer:
  // density + leads + marketing focus. growth() keeps the neighbor-leads card.)
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
  const series = getSeries(ctx)
  // Customers with ANY upcoming visit (any service) are NOT lapsed — they may
  // have a different service booked (e.g. fall aeration), so don't nag them.
  const custWithFuture = new Set(
    ctx.jobs.filter(j => j.customer_id && j.scheduled_date >= ctx.today && j.status !== 'completed' && j.status !== 'cancelled')
      .map(j => j.customer_id as string),
  )
  // ── PREDICTIVE CHURN ────────────────────────────────────────────────────────
  // Catch valuable recurring customers SLIPPING before they fully lapse: overdue
  // against their OWN cadence (last visit > 1.6× the interval ago) with nothing
  // booked soon, while their season is active. A leading indicator — the window
  // where a single call still saves the account. Per-customer named cards (capped),
  // ranked by recurring value × churn probability. Distinct from the lapsed
  // aggregate below, which it suppresses for the same customer.
  const churnedCustomers = new Set<string>()
  const churnCards: Suggestion[] = []
  const ltv = getLifetimeValues(ctx)
  for (const s of series) {
    if (s.perVisit <= 0) continue
    const lastDone = [...s.jobs].reverse().find(j => j.status === 'completed')
    if (!lastDone) continue
    const completedCount = s.jobs.filter(j => j.status === 'completed').length
    if (completedCount < 2) continue                              // need an established rhythm
    const season = seasonForService(s.rep.service_type, ctx.seasons)
    if (season && !isWithinSeason(ctx.today, season)) continue    // off-season dormant, not churning
    const interval = cadenceIntervalDays(s)
    const daysSince = dayDelta(lastDone.scheduled_date, ctx.today)
    if (daysSince <= interval * 1.6) continue                     // still roughly on cadence
    const nextFuture = s.futureOpen[0]?.scheduled_date || null
    if (nextFuture && dayDelta(ctx.today, nextFuture) <= interval * 1.5) continue // booked soon → fine
    const annualValue = Math.round(s.perVisit * seriesVisitsPerYear(s))
    if (annualValue < 300) continue                               // focus on accounts worth saving
    const ratio = daysSince / interval
    const churnProb = ratio >= 2.5 ? 0.6 : 0.4
    // LTV-WEIGHTED: the most EXPENSIVE customer to lose ranks first, not just the
    // one with the highest per-visit price. A proven high-lifetime account gets a
    // heavier weight (and VIP framing) so reach-out minutes go where they matter.
    const custLtv = s.customerId ? (ltv[s.customerId] || 0) : 0
    const isVip = custLtv >= VIP_THRESHOLD
    const ltvWeight = isVip ? 1.5 : custLtv >= 800 ? 1.2 : 1.0
    const impact = Math.round(annualValue * churnProb * ltvWeight)
    const svcLabel = serviceCategory(s.rep.service_type) === 'lawn' ? 'mowing' : (s.rep.service_type || 'service')
    if (s.customerId) churnedCustomers.add(s.customerId)
    const confidence: Confidence = isVip || completedCount >= 4 ? 'high' : 'medium'
    churnCards.push({
      id: `churn-${s.recurrenceId}`,
      category: 'retention',
      title: isVip ? `⭐ VIP at risk — reach out to ${s.customerName}` : `Reach out to ${s.customerName} — slipping away`,
      subtitle: `${svcLabel}: last visit ${daysSince}d ago, no follow-up booked`,
      impact, oneTime: false, revenueImpact: annualValue,
      confidence, confidenceScore: CONF_SCORE[confidence],
      why: [
        custLtv > 0 ? `Lifetime value $${custLtv.toLocaleString()}${isVip ? ' — a top customer' : ''}` : 'Established recurring customer',
        `Last ${svcLabel} visit was ${daysSince} days ago — overdue for a ~${interval}-day cadence`,
        nextFuture ? `Next visit not until ${format(parseISO(nextFuture + 'T00:00:00'), 'MMM d')}` : 'Nothing booked ahead',
        `$${annualValue}/yr of recurring revenue at risk`,
      ],
      calc: [
        `${daysSince}d since last visit ÷ ${interval}d cadence = ${ratio.toFixed(1)}× overdue → ~${Math.round(churnProb * 100)}% churn risk`,
        `At-risk value = $${annualValue}/yr × ${Math.round(churnProb * 100)}%${ltvWeight !== 1 ? ` × ${ltvWeight} LTV weight` : ''} = $${impact}`,
      ],
      action: { kind: 'navigate', label: 'Save this customer', href: s.customerId ? `/dashboard/customers/${s.customerId}` : '/dashboard/reactivation' },
    })
  }
  // Highest-VALUE at-risk first (LTV-weighted impact), capped to keep the feed tight.
  churnCards.sort((a, b) => b.impact - a.impact)
  out.push(...churnCards.slice(0, 3))

  // A series with NO future visit, customer fully unscheduled, season active = lapsed.
  let lapsedCount = 0, lapsedAnnual = 0
  for (const s of series) {
    if (s.futureOpen.length > 0) continue
    if (s.customerId && custWithFuture.has(s.customerId)) continue // booked for something else
    if (s.customerId && churnedCustomers.has(s.customerId)) continue // already a named churn card
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
  const futureCust = new Set(getJobIndex(ctx).futureScheduled.map(j => j.customer_id).filter(Boolean) as string[])
  let lapsed = 0
  for (const s of getSeries(ctx)) {
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

// ── 📍 GROWTH: Neighborhood Domination — where to concentrate marketing ─────────
// Per hood: revenue, customer count, route density, annual value, lead/expansion
// opportunity → a marketing-focus recommendation. Concentrating on the hoods you
// can OWN beats scattering flyers everywhere. Composes neighborhoodProfitability
// + the Route Density Score + neighbor leads.
function neighborhoodDomination(ctx: SuggestionContext): Suggestion[] {
  const out: Suggestion[] = []
  const { jobs, pctx } = profitJobsAndCtx(ctx)
  let hoods: ReturnType<typeof neighborhoodProfitability> = []
  try { hoods = neighborhoodProfitability(jobs, pctx) } catch { hoods = [] }
  hoods = hoods.filter(h => h.key !== 'Unknown' && h.customers >= 2)
  if (!hoods.length) return out

  // Dedupe to ONE stop per property, tagged with its hood. Feeding densityFor raw
  // per-visit jobs would count a customer's many seasonal visits as many "nearby
  // stops" → fake density. Count distinct addresses.
  const seen = new Set<string>()
  const allStops: Coord[] = []
  const stopsByHood: Record<string, Coord[]> = {}
  for (const j of jobs) {
    if (j.lat == null || j.lng == null) continue
    const key = `${j.lat.toFixed(5)},${j.lng.toFixed(5)}`
    if (seen.has(key)) continue
    seen.add(key)
    const coord = { lat: j.lat, lng: j.lng }
    allStops.push(coord)
    ;(stopsByHood[neighborhoodKey(j.postal_code, j.city, j.neighborhood)] ||= []).push(coord)
  }
  const leadsByHood: Record<string, number> = {}
  for (const l of ctx.neighborLeads) if (l.neighborhood) leadsByHood[l.neighborhood] = (leadsByHood[l.neighborhood] || 0) + 1
  const avgRevPerJob = hoods.reduce((s, h) => s + h.revPerJob, 0) / hoods.length

  const scored = hoods.map(h => {
    const stops = stopsByHood[h.key] || []
    const dres = stops.map(s => densityFor(s, allStops))
    const avgDensity = dres.length ? Math.round(dres.reduce((a, d) => a + d.score, 0) / dres.length) : 0
    const denseShare = dres.length ? dres.filter(d => d.tier === 'dense').length / dres.length : 0
    const leads = leadsByHood[h.key] || 0
    // STREET-LEVEL: the tightest concentration of homes you already serve — the
    // biggest count within 500 m of a single stop. That cluster is the exact
    // block to door-knock (the cheapest customer is the empty house you drive past).
    let tightCluster = 0, clusterCenter: Coord | null = null
    for (const s of stops) {
      let c = 1
      for (const t of stops) if (t !== s && haversineKm(s, t) <= 0.5) c++
      if (c > tightCluster) { tightCluster = c; clusterCenter = s }
    }
    // Own where you can DOMINATE: already-tight cluster (density + dense share +
    // a concentrated block) × high per-customer VALUE × warm leads.
    const valueRatio = avgRevPerJob > 0 ? Math.min(2, Math.max(0.5, h.revPerJob / avgRevPerJob)) : 1
    const dominanceScore = h.revenue * (1 + avgDensity / 100) * (1 + denseShare) * (1 + tightCluster * 0.1) * (1 + leads * 0.2) * valueRatio
    return { h, avgDensity, denseShare, leads, tightCluster, clusterCenter, strong: h.revPerJob >= avgRevPerJob, dominanceScore }
  }).sort((a, b) => b.dominanceScore - a.dominanceScore)

  // The best target first; a SECOND only if it's high-confidence (filtered below).
  // Concentrating beats scattering — but a genuinely strong second block shouldn't
  // be hidden behind the single top hood.
  for (const { h, avgDensity, denseShare, leads, tightCluster, strong } of scored.slice(0, 3)) {
    const dense = denseShare >= 0.5 || avgDensity >= 50
    const hasBlock = tightCluster >= 3   // a real concentrated block to knock
    const focus = hasBlock
      ? `Door-knock the block where ${tightCluster} of your customers already cluster — highest-conversion, lowest-drive expansion`
      : h.customers >= 4 && dense
        ? 'Referral push — your tight cluster here will refer neighbours; flyers convert cheaply on a dense route'
        : strong && h.customers < 4
          ? 'Flyer / door-knock to expand this strong beachhead'
          : 'Flyers + referrals to deepen this route'
    const annualPerCustomer = Math.round(h.revPerJob * SEASON_VISITS_BIWEEKLY)
    const newCustomers = Math.max(1, Math.min(4, leads > 0 ? leads : Math.round(h.customers * 0.5)))
    // Denser hoods AND a tight block convert door-knocks/referrals better — scale
    // the close rate with cluster tightness (0.25 isolated → ~0.5 tight block).
    const closeRate = Math.min(0.5, 0.25 + denseShare * 0.2 + (hasBlock ? 0.05 : 0))
    const impact = Math.round(annualPerCustomer * newCustomers * closeRate)
    if (impact < 100) continue
    // A dense hood with a concentrated block / warm leads is a grounded call → bump.
    const confidence: Confidence = (tightCluster >= 4 || (dense && leads > 0)) ? 'high'
      : dense && (leads > 0 || h.customers >= 4) ? 'medium' : 'low'
    out.push({
      id: `dominate-${h.key}`,
      category: 'growth',
      title: `Focus marketing on ${h.key}`,
      subtitle: `${h.customers} customers · ${formatMoney(h.revenue)}/yr · density ${avgDensity}/100`,
      impact, oneTime: false, revenueImpact: impact,
      confidence, confidenceScore: CONF_SCORE[confidence],
      why: [
        `${h.customers} customers, $${h.revPerJob}/job (avg $${Math.round(avgRevPerJob)}) — ${strong ? 'above' : 'around'} your average`,
        hasBlock
          ? `Tightest block: ${tightCluster} homes within 500 m — concentrate door-knocking there`
          : `Route density ${avgDensity}/100${denseShare > 0 ? `, ${Math.round(denseShare * 100)}% on dense routes` : ''}${leads > 0 ? ` · ${leads} lead${leads !== 1 ? 's' : ''} waiting` : ''}`,
        focus,
      ],
      calc: [
        `Annual value now ≈ $${h.revenue} booked across ${h.customers} customers`,
        `+${newCustomers} customer${newCustomers !== 1 ? 's' : ''} × ~${SEASON_VISITS_BIWEEKLY} visits × $${h.revPerJob} × ${Math.round(closeRate * 100)}% ≈ +$${impact}/yr`,
      ],
      action: { kind: 'navigate', label: leads > 0 ? 'Knock the leads' : 'See the area', href: leads > 0 ? '/dashboard/neighbors' : '/dashboard/saturation' },
    })
  }
  // Keep the top target; add a second only when it's a high-confidence opportunity.
  if (out.length <= 1) return out
  return [out[0], ...out.slice(1).filter(c => c.confidence === 'high')].slice(0, 2)
}

// Compact money for subtitles ($1,250 not $1250.00).
function formatMoney(n: number): string { return '$' + Math.round(n).toLocaleString() }

// ── 💰 PROFIT: capacity-aware pricing — charge a premium when booked solid ───────
// The demand-side mirror of routeGapFinder. When the next few weeks are at/over
// capacity (using LEARNED durations, not just typed ones), the profit move is to
// price new work UP or waitlist — never discount. Reuses the same dayLoad engine.
function capacityPricing(ctx: SuggestionContext): Suggestion[] {
  const out: Suggestion[] = []
  const pref = ctx.preferredDays.length ? new Set(ctx.preferredDays) : null
  const model = getDurationModel(ctx)
  const capMinPerDay = ctx.capacityHours * 60
  if (capMinPerDay <= 0) return out

  // Sum learned labour per preferred work day over the next 4 weeks, by ISO week.
  const weeks: Record<string, { start: string; workdays: number; labor: number; cap: number; fullDays: number }> = {}
  for (let i = 1; i <= 28; i++) {
    const d = addDays(parseISO(ctx.today + 'T00:00:00'), i)
    if (pref && !pref.has(getDay(d))) continue
    const iso = format(d, 'yyyy-MM-dd')
    const dayJobs = ctx.jobs.filter(j => j.scheduled_date === iso && j.status !== 'cancelled')
    const labor = dayJobs.reduce((s, j) => s + learnedDurationFor(j, model), 0)
    const wk = format(d, "RRRR-'W'II")
    const e = (weeks[wk] ||= { start: iso, workdays: 0, labor: 0, cap: 0, fullDays: 0 })
    if (iso < e.start) e.start = iso
    e.workdays++; e.labor += labor; e.cap += capMinPerDay
    if (labor >= capMinPerDay * 0.9) e.fullDays++
  }
  const overloaded = Object.values(weeks)
    .filter(w => w.workdays >= 2 && w.cap > 0 && w.labor / w.cap >= 0.85)
    .sort((a, b) => a.start.localeCompare(b.start))
  if (overloaded.length === 0) return out

  // Average value of FUTURE booked visits — what a premium would apply to.
  // (Reuses the memoized future-scheduled list — one shared scan, not per-generator.)
  const qById = quoteById(ctx)
  const futureVals: number[] = []
  for (const j of getJobIndex(ctx).futureScheduled) {
    const rec = j.recurrence_id ? ctx.recurrences[j.recurrence_id] : null
    const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
    const q = j.quote_id ? qById[j.quote_id] : null
    const v = jobVisitValue(j.price, q as unknown as Record<string, unknown>, freq, j.is_initial_visit)
    if (v > 0) futureVals.push(v)
  }
  if (!futureVals.length) return out
  const avgVisit = Math.round(futureVals.reduce((a, b) => a + b, 0) / futureVals.length)
  // The premium LEARNS from your quotes: win rate = pricing power, and WHY you lose
  // refines it. High win rate → bigger premium; low → nudge gently. Falls back to a
  // flat 10% until there are enough decided quotes.
  let won = 0, lost = 0
  for (const q of ctx.quotes) {
    if (q.status === 'accepted' || q.status === 'scheduled' || q.status === 'completed' || q.status === 'paid') won++
    else if (q.status === 'declined') lost++
  }
  const winRate = won + lost >= 4 ? won / (won + lost) : null
  // Learn from the LOSS REASONS: if you mostly lose on PRICE, the market is at your
  // ceiling — recommending a premium would lose more work. Suppress when it's the
  // dominant loss reason; minimise it when it's a meaningful share (avoid noise).
  const priceLosses = ctx.quoteOutcomes.filter(o => o.reason === 'price').length
  const priceLossRate = lost >= 3 ? priceLosses / lost : 0
  if (priceLossRate >= 0.5) return out // losing mostly on price → never tell them to raise
  let PREMIUM_PCT = winRate == null ? 0.1 : winRate >= 0.6 ? 0.15 : winRate >= 0.4 ? 0.1 : 0.05
  if (priceLossRate >= 0.3) PREMIUM_PCT = Math.min(PREMIUM_PCT, 0.05) // price-sensitive → keep it gentle
  const premiumPerJob = round5(avgVisit * PREMIUM_PCT)
  if (premiumPerJob < 5) return out
  // Conservative: ~1 premium-priced new job per overloaded week.
  const impact = premiumPerJob * overloaded.length
  const soonest = overloaded[0]
  const util = Math.round((soonest.labor / soonest.cap) * 100)
  const weekLabel = format(parseISO(soonest.start + 'T00:00:00'), 'MMM d')
  out.push({
    id: 'capacity-pricing',
    category: 'profit',
    title: overloaded.length === 1
      ? `Week of ${weekLabel} is booked solid — price new work at a premium`
      : `${overloaded.length} of the next 4 weeks are booked solid — raise new-quote pricing`,
    subtitle: 'Charge a premium or waitlist while you’re full',
    impact, oneTime: true, revenueImpact: impact,
    confidence: 'medium', confidenceScore: CONF_SCORE.medium,
    why: [
      `Week of ${weekLabel} is at ~${util}% of capacity (${soonest.fullDays} full day${soonest.fullDays !== 1 ? 's' : ''})`,
      'When you’re full, new work should carry a premium — not a discount',
      `Each new job at +${Math.round(PREMIUM_PCT * 100)}% ≈ +$${premiumPerJob}; waitlist the rest`,
      winRate != null ? `Your quotes accept at ${Math.round(winRate * 100)}% — ${winRate >= 0.6 ? 'strong pricing power, push the premium' : winRate < 0.4 ? 'price gently' : 'room to nudge up'}` : '',
      priceLossRate >= 0.3 ? `Note: ${priceLosses} recent quote${priceLosses !== 1 ? 's' : ''} lost to price — premium kept small` : '',
    ].filter(Boolean),
    calc: [
      `Week of ${weekLabel}: ${Math.round(soonest.labor / 60)}h booked vs ${Math.round(soonest.cap / 60)}h capacity = ${util}%`,
      `Premium = avg visit $${avgVisit} × ${Math.round(PREMIUM_PCT * 100)}% = +$${premiumPerJob}/new job`,
      model.totalSamples >= 3 ? `Capacity uses your real pace (${model.totalSamples} timed jobs)` : 'Capacity uses scheduled durations — time more jobs to sharpen this',
    ],
    action: { kind: 'navigate', label: 'See booked weeks', href: '/dashboard/schedule' },
  })
  return out
}

// ── 📍 GROWTH: referral engine — ask your best advocates ─────────────────────────
// Ranks customers by likelihood to refer (lifetime value + tenure + active
// recurring + proven prior referrals) and surfaces a one-tap "ask {name}" card.
// The cheapest, highest-close acquisition channel — and the data already exists.
function referralAsks(ctx: SuggestionContext): Suggestion[] {
  const out: Suggestion[] = []
  if (ctx.customers.length < 3) return out
  const ltv = getLifetimeValues(ctx)
  const series = getSeries(ctx)
  const recurringCust = new Set<string>()
  for (const s of series) if (s.futureOpen.length > 0 && s.customerId) recurringCust.add(s.customerId)

  const completedCount: Record<string, number> = {}
  const lastCompleted: Record<string, string> = {}
  for (const j of ctx.jobs) {
    if (j.status !== 'completed' || !j.customer_id) continue
    completedCount[j.customer_id] = (completedCount[j.customer_id] || 0) + 1
    if (!lastCompleted[j.customer_id] || j.scheduled_date > lastCompleted[j.customer_id]) lastCompleted[j.customer_id] = j.scheduled_date
  }
  // Proven advocates — who already referred someone in.
  const referralsGiven: Record<string, number> = {}
  for (const c of ctx.customers) {
    const ref = c.referred_by_customer_id
    if (ref) referralsGiven[ref] = (referralsGiven[ref] || 0) + 1
  }
  const propByCust: Record<string, Property> = {}
  for (const p of ctx.properties) if (p.customer_id && !propByCust[p.customer_id]) propByCust[p.customer_id] = p

  const nowMs = new Date(ctx.today + 'T00:00:00').getTime()
  const scored = ctx.customers.map(c => {
    const value = ltv[c.id] || 0
    const visits = completedCount[c.id] || 0
    const isRecurring = recurringCust.has(c.id)
    const given = referralsGiven[c.id] || 0
    const last = lastCompleted[c.id]
    const active = isRecurring || (last ? dayDelta(last, ctx.today) <= 75 : false)
    const tenureDays = c.created_at ? Math.max(0, Math.floor((nowMs - new Date(c.created_at).getTime()) / 86_400_000)) : 0
    const score = value
      + (tenureDays >= 365 ? 300 : tenureDays >= 180 ? 120 : 0)
      + (isRecurring ? 400 : 0)
      + visits * 20
      + given * 600
    return { c, value, visits, isRecurring, given, active, tenureDays, score }
  })
    .filter(x => x.active && x.visits >= 2 && (x.value >= 300 || x.isRecurring))
    .sort((a, b) => b.score - a.score)

  for (const x of scored.slice(0, 3)) {
    const c = x.c
    const hood = propByCust[c.id]?.neighborhood?.trim() || null
    const s = series.find(se => se.customerId === c.id && se.futureOpen.length > 0)
    const referredAnnual = s ? Math.round(s.perVisit * seriesVisitsPerYear(s))
      : x.visits > 0 ? Math.round((x.value / x.visits) * SEASON_VISITS_BIWEEKLY) : 0
    if (referredAnnual < 200) continue
    const impact = Math.round(referredAnnual * 0.5) // warm referrals close ~50%
    const tenureLabel = x.tenureDays >= 730 ? `${Math.floor(x.tenureDays / 365)} yrs with you`
      : x.tenureDays >= 365 ? '1+ yr with you'
        : x.tenureDays >= 60 ? `${Math.round(x.tenureDays / 30)} months with you` : 'a happy customer'
    const confidence: Confidence = x.given > 0 || x.value >= VIP_THRESHOLD ? 'high' : 'medium'
    out.push({
      id: `referral-${c.id}`,
      category: 'growth',
      title: `Ask ${c.name} for a referral`,
      subtitle: `${x.given > 0 ? `Already referred ${x.given} — ` : ''}$${x.value.toLocaleString()} lifetime${hood ? ` · ${hood}` : ''}`,
      impact, oneTime: false, revenueImpact: impact,
      confidence, confidenceScore: CONF_SCORE[confidence],
      why: [
        `${x.isRecurring ? 'Active recurring customer' : 'Recently served'} · ${tenureLabel} · ${x.visits} visits`,
        x.given > 0 ? `Proven advocate — already referred ${x.given} customer${x.given !== 1 ? 's' : ''}` : 'Happy, loyal customers refer the best leads',
        hood ? `A referral in ${hood} adds density where you already work` : 'Referrals close warm and cost nothing to win',
      ],
      calc: [
        `A similar customer ≈ $${referredAnnual}/yr; warm referrals close ~50% → +$${impact}/yr`,
        `Ranked by lifetime value $${x.value}${x.isRecurring ? ', recurring' : ''}${x.tenureDays >= 365 ? ', long-tenured' : ''}${x.given > 0 ? ', proven referrer' : ''}`,
      ],
      action: { kind: 'navigate', label: `Open ${c.name}`, href: `/dashboard/customers/${c.id}` },
    })
  }
  return out
}

// ── 📍 GROWTH: cross-season cross-sell (lawn ↔ snow) + spring/fall cleanups ───────
// A customer active in one season with NO plan in the other is leaving a whole
// second season on the table — and the truck already knows the address. Gated to
// ~6 weeks before the season flips so the offer lands when it's actionable.
function mkCross(cid: string, name: string, target: 'snow' | 'lawn', impact: number, estAnnual: number, avgVisit: number): Suggestion {
  const svc = target === 'snow' ? 'snow removal' : 'lawn service'
  const from = target === 'snow' ? 'lawn' : 'snow'
  const when = target === 'snow' ? 'before winter' : 'for spring'
  return {
    id: `crosssell-${target}-${cid}`,
    category: 'growth',
    title: `Offer ${svc} to ${name} ${when}`,
    subtitle: `Already on your route — a second season at ~$${avgVisit}/visit`,
    impact, oneTime: false, revenueImpact: impact,
    confidence: 'medium', confidenceScore: CONF_SCORE.medium,
    why: [
      `Active ${from} customer with no ${target} plan`,
      'The truck already serves this address — second-season revenue at near-zero acquisition cost',
      `Est. ~$${estAnnual}/yr; ~40% take-up → +$${impact}/yr`,
    ],
    calc: [
      `Estimate = $${avgVisit}/visit × ~${SEASON_VISITS_BIWEEKLY} visits = $${estAnnual}/season`,
      '× 40% conservative cross-sell take-up',
    ],
    action: { kind: 'navigate', label: 'Quote it', href: `/dashboard/quotes/new?customer=${cid}` },
  }
}
function crossSeasonOffers(ctx: SuggestionContext): Suggestion[] {
  const ltv = getLifetimeValues(ctx)
  const cats: Record<string, Set<string>> = {}
  const visits: Record<string, number> = {}
  const futureByCust: Record<string, Set<string>> = {}
  for (const j of ctx.jobs) {
    if (!j.customer_id || j.status === 'cancelled') continue
    ;(cats[j.customer_id] ||= new Set()).add(serviceCategory(j.service_type))
    if (j.status === 'completed') visits[j.customer_id] = (visits[j.customer_id] || 0) + 1
    if (j.scheduled_date >= ctx.today && j.status !== 'completed') (futureByCust[j.customer_id] ||= new Set()).add((j.service_type || '').toLowerCase())
  }
  const series = getSeries(ctx)
  const activeRecCust = new Set<string>()
  const perVisitByCust: Record<string, number> = {}
  const nameByCust: Record<string, string> = {}
  for (const s of series) {
    if (!s.customerId) continue
    if (s.futureOpen.length > 0) activeRecCust.add(s.customerId)
    if (s.perVisit > 0 && !perVisitByCust[s.customerId]) perVisitByCust[s.customerId] = s.perVisit
    nameByCust[s.customerId] = s.customerName
  }
  for (const c of ctx.customers) if (!nameByCust[c.id]) nameByCust[c.id] = c.name

  const snowApproaching = daysUntilISO(nextSeasonStartISO(ctx.seasons.snow, ctx.today), ctx.today) <= 45
  const lawnApproaching = daysUntilISO(nextSeasonStartISO(ctx.seasons.lawn, ctx.today), ctx.today) <= 45
  const springWindow = daysUntilISO(nextSeasonStartISO(ctx.seasons.lawn, ctx.today), ctx.today) <= 30
  const fallEnd = daysUntilISO(nextSeasonEndISO(ctx.seasons.lawn, ctx.today), ctx.today)
  const fallWindow = fallEnd >= 0 && fallEnd <= 30

  const candidates: Suggestion[] = []
  for (const cid of Object.keys(cats)) {
    const set = cats[cid]
    const active = activeRecCust.has(cid) || (visits[cid] || 0) >= 1
    if (!active) continue
    const name = nameByCust[cid] || 'this customer'
    const avgVisit = perVisitByCust[cid] || ((visits[cid] || 0) > 0 ? Math.round((ltv[cid] || 0) / visits[cid]) : 0)
    if (avgVisit <= 0) continue
    const hasFutureType = (kw: string) => Array.from(futureByCust[cid] || []).some(t => t.includes(kw))

    if (snowApproaching && set.has('lawn') && !set.has('snow')) {
      const estAnnual = Math.round(avgVisit * SEASON_VISITS_BIWEEKLY)
      const impact = Math.round(estAnnual * 0.4)
      if (impact >= 120) candidates.push(mkCross(cid, name, 'snow', impact, estAnnual, avgVisit))
    }
    if (lawnApproaching && set.has('snow') && !set.has('lawn')) {
      const estAnnual = Math.round(avgVisit * SEASON_VISITS_BIWEEKLY)
      const impact = Math.round(estAnnual * 0.4)
      if (impact >= 120) candidates.push(mkCross(cid, name, 'lawn', impact, estAnnual, avgVisit))
    }
    if (set.has('lawn') && (springWindow || fallWindow) && !hasFutureType('clean')) {
      const which = springWindow ? 'Spring' : 'Fall'
      const cleanupPrice = round5(avgVisit * 2.5) // a cleanup is a bigger one-off than a mow
      candidates.push({
        id: `cleanup-${which.toLowerCase()}-${cid}`,
        category: 'growth',
        title: `Offer a ${which} cleanup to ${name}`,
        subtitle: `${which === 'Spring' ? 'Before the season ramps up' : 'Before the snow flies'} · ~$${cleanupPrice}`,
        impact: cleanupPrice, oneTime: true, revenueImpact: cleanupPrice,
        confidence: 'low', confidenceScore: CONF_SCORE.low,
        why: [
          `Active lawn customer with no ${which.toLowerCase()} cleanup booked`,
          `${which} cleanups are an easy high-ticket add for customers already on your route`,
          `Est. ~$${cleanupPrice} one-off (≈ 2–3× a mow)`,
        ],
        action: { kind: 'navigate', label: 'Quote it', href: `/dashboard/quotes/new?customer=${cid}` },
      })
    }
  }
  return candidates.sort((a, b) => b.impact - a.impact).slice(0, 4)
}

// ── ❤️ RETENTION: seasonal renewal — re-book next season before the gap ──────────
// A seasonal recurring series ending at season-end with nothing booked for next
// season is a route you re-quote from scratch every spring. One tap re-creates the
// plan (reusing createRecurringPlan / the recurrence engine). Fires only in the
// ~8-week pre-season window so it lands when re-booking is the right move.
function seasonalRenewals(ctx: SuggestionContext): Suggestion[] {
  const out: Suggestion[] = []
  for (const s of getSeries(ctx)) {
    const season = seasonForService(s.rep.service_type, ctx.seasons)
    if (!season) continue                                   // only seasonal services renew
    if (!s.jobs.some(j => j.status === 'completed')) continue // established series only
    const count: 1 | 2 | null = s.cadence === 'weekly' ? 1 : s.cadence === 'biweekly' ? 2 : null
    if (!count) continue                                    // one-click rebook = weekly/biweekly
    if (s.perVisit <= 0 || !s.customerId) continue
    const start = nextSeasonStartISO(season, ctx.today)
    const daysUntil = daysUntilISO(start, ctx.today)
    if (daysUntil < 0 || daysUntil > 60) continue           // only within the renewal window
    if (s.jobs.some(j => j.scheduled_date >= start && j.status !== 'cancelled')) continue // already re-booked
    const startDate = firstWorkdayOnOrAfter(ctx, start)
    const endDate = seasonEndDateFor(startDate, season)
    const vpy = seriesVisitsPerYear(s)
    const annual = Math.round(s.perVisit * vpy)
    if (annual < 200) continue
    const svc = serviceCategory(s.rep.service_type) === 'lawn' ? 'mowing' : (s.rep.service_type || 'service')
    const startLabel = format(parseISO(startDate + 'T00:00:00'), 'MMM d')
    const plan: RecurringPlanPayload = {
      customerId: s.customerId, propertyId: s.rep.property_id, serviceType: s.rep.service_type, title: s.rep.title,
      perVisitPrice: Math.round(s.perVisit), intervalUnit: 'week', intervalCount: count,
      startDate, endDate, crewSize: s.rep.crew_size || 1, durationMinutes: s.rep.duration_minutes,
    }
    out.push({
      id: `renew-${s.recurrenceId}`,
      category: 'retention',
      title: `Re-book ${s.customerName} for next season`,
      subtitle: `${s.cadence} ${svc} from ${startLabel} · ${vpy} visits`,
      impact: annual, oneTime: false, revenueImpact: annual,
      confidence: 'high', confidenceScore: CONF_SCORE.high,
      why: [
        `${s.customerName}'s ${svc} plan has nothing booked for next season`,
        'Lock in the full season now in one tap — before they drift to a competitor',
        `${vpy} visits × $${Math.round(s.perVisit)} = +$${annual}/yr`,
      ],
      calc: [
        `Re-creates the ${s.cadence} plan ${startLabel} → ${format(parseISO(endDate + 'T00:00:00'), 'MMM d')} (${vpy} visits)`,
        `At the current $${Math.round(s.perVisit)}/visit`,
      ],
      action: { kind: 'create-recurring', label: `Re-book ${vpy} visits`, plan },
    })
  }
  return out.sort((a, b) => b.impact - a.impact).slice(0, 5)
}

// ── 🚗 ROUTE: duration accuracy — learned actuals vs scheduled time ──────────────
// Job Duration Learning made visible: when timed jobs show a service runs much
// longer than the duration scheduled for it, the day plan/ETAs/capacity are all
// optimistic. Surfaces the single biggest under-budget so the owner can fix it.
function durationAccuracy(ctx: SuggestionContext): Suggestion[] {
  const model = getDurationModel(ctx)
  if (model.totalSamples < 5) return []                     // need enough data to advise
  const out: Suggestion[] = []
  let worst: { name: string; planned: number; learned: number; cat: string; vpy: number } | null = null
  for (const s of getSeries(ctx)) {
    if (!s.futureOpen.length) continue
    const cat = serviceCategory(s.rep.service_type)
    const learned = model.byCategory[cat]
    if (learned == null) continue
    const planned = Number(s.rep.duration_minutes) || 0
    if (planned <= 0) continue
    const diff = learned - planned
    if (diff < 10 || diff / planned < 0.25) continue        // only materially under-budgeted
    if (!worst || diff > worst.learned - worst.planned) worst = { name: s.customerName, planned, learned, cat, vpy: seriesVisitsPerYear(s) }
  }
  if (!worst) return out
  const svc = worst.cat === 'lawn' ? 'mowing' : worst.cat === 'snow' ? 'snow' : (worst.name + '’s service')
  // The mis-costed crew time per season (under-budgeted minutes priced at crew cost).
  const impact = Math.max(0, Math.round(((worst.learned - worst.planned) / 60) * ctx.crewCost * worst.vpy))
  out.push({
    id: 'duration-accuracy',
    category: 'route',
    title: `Your ${svc} visits actually take ~${worst.learned} min, not ${worst.planned}`,
    subtitle: 'Scheduled durations are under-budgeting your day',
    impact, oneTime: false,
    confidence: 'medium', confidenceScore: CONF_SCORE.medium,
    why: [
      `Timed jobs show ${svc} averages ~${worst.learned} min on site vs the ${worst.planned} min scheduled`,
      'Under-budgeted durations overload your days and push back every ETA',
      `Learned from ${model.totalSamples} of your check-in/out timed jobs`,
    ],
    calc: [
      `${worst.learned - worst.planned} min/visit under-budget × ${worst.vpy} visits ÷ 60 × $${ctx.crewCost}/hr crew ≈ $${impact}/yr of unaccounted time`,
    ],
    action: { kind: 'navigate', label: 'Review on schedule', href: '/dashboard/schedule' },
  })
  return out
}

// ── 💰 PROFIT: win/loss patterns → pricing intelligence ─────────────────────────
// The win side is already in quotes.status; the loss reasons come from the Grow
// Win/Loss panel. Surfaces the one pattern worth acting on: a neighbourhood where
// you keep losing on PRICE (your rate may be too high there) — plus a nudge to tag
// untagged losses so the intelligence keeps sharpening.
function winLossPatterns(ctx: SuggestionContext): Suggestion[] {
  const out: Suggestion[] = []
  if (ctx.quotes.length < 4) return out
  const pById = propsById(ctx)
  const hoodOf = (q: WLQuote) => {
    const p = q.property_id ? pById[q.property_id] : undefined
    return p ? neighborhoodKey(p.postal_code, p.city, p.neighborhood) : 'Unknown'
  }
  const wlQuotes: WLQuote[] = ctx.quotes.map(q => ({ id: q.id, status: q.status, total: q.total, property_id: q.property_id ?? null }))
  const stats = analyzeWinLoss(wlQuotes, ctx.quoteOutcomes as QuoteOutcomeRow[], hoodOf)
  if (stats.decided < 4) return out

  const priceHood = stats.byHood.find(h => h.hood !== 'Unknown' && h.priceLosses >= 2 && h.decided >= 3)
  if (priceHood) {
    const winPct = Math.round(priceHood.winRate * 100)
    const overallPct = Math.round(stats.winRate * 100)
    const recoverable = Math.round(priceHood.lostValue * 0.3) // a sharper rate could recover ~30%
    const confidence: Confidence = priceHood.decided >= 6 ? 'high' : 'medium'
    out.push({
      id: `winloss-price-${priceHood.hood}`,
      category: 'profit',
      title: `You keep losing on price in ${priceHood.hood}`,
      subtitle: `${priceHood.priceLosses} quotes lost to price · ${winPct}% win rate here`,
      impact: recoverable, oneTime: true, revenueImpact: priceHood.lostValue,
      confidence, confidenceScore: CONF_SCORE[confidence],
      why: [
        `${priceHood.priceLosses} of ${priceHood.lost} lost ${priceHood.hood} quote${priceHood.lost !== 1 ? 's' : ''} were “too expensive”`,
        `Win rate in ${priceHood.hood} is ${winPct}% vs ${overallPct}% overall`,
        `$${Math.round(priceHood.lostValue)} of quoted work walked — a sharper rate may win more of it`,
      ],
      calc: [`Recoverable ≈ $${Math.round(priceHood.lostValue)} lost × ~30% if priced to win = $${recoverable}`],
      action: { kind: 'navigate', label: 'Review the area', href: '/dashboard/saturation' },
    })
  }

  // Capture nudge — only when there's a backlog of untagged losses and no pattern
  // card fired (keeps the feed tight; the panel itself shows the full list).
  if (!out.length && stats.untaggedLost >= 3) {
    out.push({
      id: 'winloss-capture',
      category: 'profit',
      title: `Tag ${stats.untaggedLost} lost quotes to learn why you’re losing`,
      subtitle: `${Math.round(stats.winRate * 100)}% win rate · reasons not recorded yet`,
      impact: 0, oneTime: true,
      confidence: 'low', confidenceScore: CONF_SCORE.low,
      why: [
        `${stats.lost} quotes declined; ${stats.untaggedLost} have no recorded reason`,
        'A few taps turns lost quotes into a clear pricing/positioning signal',
      ],
      action: { kind: 'navigate', label: 'Tag lost quotes', href: '/dashboard/grow' },
    })
  }
  return out
}

// ── ⚠️ PROBLEMS: time-window risk — routes that miss promised arrival windows ────
// Customers/properties carry a preferred time window (pref_time_start/end). Walk
// each upcoming day's route (greedy from base) with the ETA engine and flag stops
// the schedule lands OUTSIDE their window — the #1 avoidable redo-trip / unhappy-
// customer cause. Navigates to the schedule; never edits it.
function nnOrderFromBase(base: Coord, jobs: Job[]): { job: Job; legKm: number }[] {
  const located = jobs.filter(j => j.properties?.lat != null && j.properties?.lng != null)
  const out: { job: Job; legKm: number }[] = []
  const used = new Set<number>()
  let cur = base
  for (let n = 0; n < located.length; n++) {
    let best = -1, bestD = Infinity
    for (let i = 0; i < located.length; i++) {
      if (used.has(i)) continue
      const d = haversineKm(cur, { lat: located[i].properties!.lat as number, lng: located[i].properties!.lng as number })
      if (d < bestD) { bestD = d; best = i }
    }
    if (best < 0) break
    used.add(best)
    const j = located[best]
    out.push({ job: j, legKm: Math.round(bestD * 10) / 10 })
    cur = { lat: j.properties!.lat as number, lng: j.properties!.lng as number }
  }
  return out
}
function windowLabel(p: { timeStart: string | null; timeEnd: string | null }): string {
  if (p.timeStart && p.timeEnd) return `${p.timeStart}–${p.timeEnd}`
  if (p.timeStart) return `after ${p.timeStart}`
  if (p.timeEnd) return `before ${p.timeEnd}`
  return 'preferred time'
}
function timeWindowWarnings(ctx: SuggestionContext): Suggestion[] {
  const out: Suggestion[] = []
  if (!ctx.baseCoord) return out
  const model = getDurationModel(ctx)
  const idx = getJobIndex(ctx)
  const byDate: Record<string, Job[]> = {}
  for (const j of idx.futureScheduled) {
    if (dayDelta(ctx.today, j.scheduled_date) > 10) continue
    ;(byDate[j.scheduled_date] ||= []).push(j)
  }
  const violations: { name: string; date: string; arrival: string; window: string; lateBy: number }[] = []
  for (const [date, dayJobs] of Object.entries(byDate)) {
    const windowed = dayJobs.filter(j => {
      const prefs = resolvePrefs(j.customers ?? null, j.properties ?? null)
      return !!(prefs.timeStart || prefs.timeEnd)
    })
    if (!windowed.length) continue
    const ordered = nnOrderFromBase(ctx.baseCoord, dayJobs)
    const durByJob: Record<string, number> = {}
    for (const j of dayJobs) durByJob[j.id] = learnedDurationFor(j, model)
    const etas = computeDayEtas(ctx.workStart, ordered.map(o => ({ jobId: o.job.id, legKm: o.legKm })), durByJob, ctx.speed)
    const arrivalByJob: Record<string, { min: number; label: string }> = {}
    for (const s of etas.stops) arrivalByJob[s.jobId] = { min: s.arrivalMin, label: s.arrival }
    for (const j of windowed) {
      const a = arrivalByJob[j.id]
      if (!a) continue
      const prefs = resolvePrefs(j.customers ?? null, j.properties ?? null)
      const end = prefs.timeEnd ? timeToMinutes(prefs.timeEnd) : null
      if (end != null && a.min > end + 15) { // 15-min grace
        violations.push({ name: j.customers?.name || j.title, date, arrival: a.label, window: windowLabel(prefs), lateBy: a.min - end })
      }
    }
  }
  if (!violations.length) return out
  violations.sort((a, b) => b.lateBy - a.lateBy)
  const worst = violations[0]
  const count = violations.length
  const impact = Math.round(count * ctx.crewCost * 0.5) // a missed window risks a ~½h redo trip
  out.push({
    id: 'time-window',
    category: 'problem',
    title: count === 1 ? `${worst.name} may miss their ${worst.window} window` : `${count} stops risk missing promised time windows`,
    subtitle: `${format(parseISO(worst.date + 'T00:00:00'), 'EEE MMM d')}: arriving ~${worst.arrival}`,
    impact, oneTime: true,
    confidence: 'medium', confidenceScore: CONF_SCORE.medium,
    why: [
      `${worst.name} prefers ${worst.window}, but the route arrives ~${worst.arrival}`,
      count > 1 ? `${count} promised windows at risk over the next 10 days` : 'Arriving outside the window risks a redo trip or an unhappy customer',
      'Re-order that day or move the stop earlier',
    ],
    calc: [`Estimated from your ${ctx.workStart} start + route order + learned durations`],
    action: { kind: 'navigate', label: 'Fix the route', href: '/dashboard/schedule' },
  })
  return out
}

// ── the advisor ─────────────────────────────────────────────────────────────────
export function buildSuggestions(ctx: SuggestionContext): Suggestion[] {
  const gens: Array<() => Suggestion[]> = [
    () => priceRaises(ctx),
    () => belowMedianPricing(ctx),
    () => recurringConversions(ctx),
    () => addonUpsells(ctx),
    () => capacityPricing(ctx),
    () => winLossPatterns(ctx),
    () => routeImprovements(ctx),
    () => routeGapFinder(ctx),
    () => durationAccuracy(ctx),
    () => timeWindowWarnings(ctx),
    () => problems(ctx),
    () => growth(ctx),
    () => neighborhoodDomination(ctx),
    () => referralAsks(ctx),
    () => crossSeasonOffers(ctx),
    () => seasonalRenewals(ctx),
    () => retention(ctx),
  ]
  let all: Suggestion[] = []
  for (const g of gens) { try { all.push(...g()) } catch { /* a failing generator never breaks the feed */ } }

  // De-dupe overlapping price cards for the SAME series. Strength order:
  // problem (below-target guardrail) > price (measured recommendation) > median
  // (peer comparison). Keep only the strongest, so the owner sees one raise, not
  // three for the same customer.
  const problemRids = new Set(all.filter(s => s.id.startsWith('problem-') && s.id !== 'problem-missed').map(s => s.id.slice('problem-'.length)))
  const priceRids = new Set(all.filter(s => s.id.startsWith('price-')).map(s => s.id.slice('price-'.length)))
  all = all.filter(s => {
    if (s.id.startsWith('price-') && problemRids.has(s.id.slice('price-'.length))) return false
    if (s.id.startsWith('median-')) {
      const rid = s.id.slice('median-'.length)
      if (problemRids.has(rid) || priceRids.has(rid)) return false
    }
    return true
  })

  // De-dupe neighbour-lead surfaces: the richer neighborhoodDomination card (which
  // already routes to the leads) supersedes the generic "follow up N leads" card.
  if (all.some(s => s.id.startsWith('dominate-'))) all = all.filter(s => s.id !== 'growth-leads')

  // Drop anything the owner dismissed or snoozed (resolved to "still active" in load).
  if (ctx.dismissedKeys.size) all = all.filter(s => !ctx.dismissedKeys.has(s.id))

  // Rank by EXPECTED impact: weight the magnitude by confidence (owners want
  // trustworthy moves first, not the biggest guess), and halve speculative
  // one-time amounts — EXCEPT missed jobs, which are money owed today and pin high.
  const CONF_WEIGHT: Record<Confidence, number> = { high: 1, medium: 0.7, low: 0.45 }
  const rankValue = (s: Suggestion) => {
    const oneTimePenalty = s.oneTime && s.id !== 'problem-missed' ? 0.5 : 1
    return s.impact * CONF_WEIGHT[s.confidence] * oneTimePenalty
  }
  const ranked = all.sort((a, b) => (rankValue(b) - rankValue(a)) || (b.confidenceScore - a.confidenceScore))

  // Cap the speculative tail: keep only the strongest few low-confidence ideas so
  // the feed can't bloat into a wall of "worth a look" guesses. High/medium
  // (trustworthy, actionable) cards are never capped.
  const MAX_LOW = 3
  const lows = ranked.filter(s => s.confidence === 'low')
  if (lows.length <= MAX_LOW) return ranked
  const keepLow = new Set(lows.slice(0, MAX_LOW).map(s => s.id))
  return ranked.filter(s => s.confidence !== 'low' || keepLow.has(s.id))
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

// ── dismiss / snooze ──────────────────────────────────────────────────────────
// Suppress a suggestion by its stable key. snoozeUntil null = dismissed
// indefinitely; an ISO date (yyyy-MM-dd) = hidden until that day, then it
// resurfaces if still relevant. Upsert so re-dismissing just updates the window.
export async function dismissSuggestion(
  supabase: SupabaseClient,
  key: string,
  snoozeUntil: string | null = null,
): Promise<{ ok: boolean; error?: string }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in' }
  const { error } = await supabase.from('suggestion_dismissals')
    .upsert({ user_id: user.id, suggestion_key: key, snooze_until: snoozeUntil }, { onConflict: 'user_id,suggestion_key' })
  return error ? { ok: false, error: error.message } : { ok: true }
}

// Undo a dismiss/snooze — bring the card straight back.
export async function undismissSuggestion(
  supabase: SupabaseClient,
  key: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in' }
  const { error } = await supabase.from('suggestion_dismissals')
    .delete().eq('user_id', user.id).eq('suggestion_key', key)
  return error ? { ok: false, error: error.message } : { ok: true }
}
