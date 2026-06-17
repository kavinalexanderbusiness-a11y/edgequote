import type { SupabaseClient } from '@supabase/supabase-js'
import type { Job, Quote, JobRecurrence, Property, Customer, JobLineItem } from '@/types'
import { Coord, haversineKm } from '@/lib/geo'
import { effectiveFreq, jobVisitValue, quoteVisitAmount, syncDraftInvoiceAmounts } from '@/lib/invoicing'
import { recordPriceChange, isRecurringProgramService, normalizeServiceKey } from '@/lib/jobPricing'
import { PricingConfig, recommendedJobPrice, estimateVisitMinutes, SEASON_VISITS } from '@/lib/pricing'
import { visitEconomics } from '@/lib/economics'
import { ProfitJob, ProfitContext, neighborhoodProfitability } from '@/lib/profitability'
import { OptJob, OptOptions, OptimizeScope, OptimizeMode, analyzeSchedule, optimizeSchedule } from '@/lib/optimizer'
import { needsFollowUp } from '@/lib/followup'
import { ServiceSeasons, serviceCategory, seasonForService, isWithinSeason } from '@/lib/seasons'

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

export interface SuggestionAction {
  kind: 'apply-price' | 'navigate'
  label: string
  href?: string
  apply?: PriceApplyPayload
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
  why: string[]
  action: SuggestionAction
}

export interface SuggestionContext {
  today: string
  crewCost: number
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

// ── 💰 PROFIT: underpriced recurring/one-time raises ────────────────────────────
function priceRaises(ctx: SuggestionContext, hoodAvgRevPerJob: number): Suggestion[] {
  const out: Suggestion[] = []
  const series = buildSeries(ctx)
  for (const s of series) {
    if (!s.futureOpen.length || s.perVisit <= 0) continue
    const sqft = sqftFor(s.property)
    const recommended = sqft > 0 ? recommendedJobPrice(sqft, ctx.pricingConfig) : 0
    const hoodTarget = hoodAvgRevPerJob > 0 ? round5(hoodAvgRevPerJob) : 0
    const target = Math.max(recommended, sqft > 0 ? 0 : hoodTarget)
    if (target <= 0) continue
    const newPrice = round5(Math.min(target, s.perVisit * 1.4)) // never propose an absurd jump
    if (newPrice < s.perVisit + 5) continue
    const vpy = seriesVisitsPerYear(s)
    const annual = Math.round((newPrice - s.perVisit) * vpy)
    if (annual < 50) continue

    const completedVisits = s.jobs.filter(j => j.status === 'completed').length
    const confidence: Confidence = sqft > 0 && completedVisits >= 3 ? 'high' : (sqft > 0 || completedVisits >= 1) ? 'medium' : 'low'
    const why: string[] = []
    if (sqft > 0) why.push(`Below the recommended price for this ${sqft.toLocaleString()} ft² lawn`)
    else if (hoodTarget > 0) why.push(`Below the neighborhood average of $${hoodTarget}/visit`)
    why.push(`${s.cadence || 'recurring'} · ${vpy} visit${vpy !== 1 ? 's' : ''}/season → +$${annual}/yr`)
    if (completedVisits >= 3) why.push(`Long-term customer — ${completedVisits} visits completed`)

    // One-click apply ONLY for a quote-linked series with a standard cadence
    // column — the safe, no-drift path. The OLD value to freeze billed history is
    // the QUOTE cadence price (not the rep visit, which may carry a manual
    // override). Past visits (< today) freeze; future-open visits clear to derive.
    const field = cadenceField(s.cadence)
    const oldCadenceValue = s.quote ? Math.round(quoteVisitAmount(s.quote as unknown as Record<string, unknown>, s.cadence)) : Math.round(s.perVisit)
    const apply: PriceApplyPayload | undefined = s.quote && field
      ? {
          quoteId: s.quote.id, cadenceField: field, newPrice, oldVisitValue: oldCadenceValue, repJobId: s.rep.id,
          freezeJobIds: s.jobs.filter(j => !j.is_initial_visit && j.scheduled_date < ctx.today && j.price == null).map(j => j.id),
          clearJobIds: s.futureOpen.filter(j => !j.is_initial_visit).map(j => j.id),
        }
      : undefined
    const action: SuggestionAction = apply
      ? { kind: 'apply-price', label: 'Apply raise', apply }
      : { kind: 'navigate', label: 'Raise in Pricing', href: '/dashboard/pricing-recovery' }

    out.push({
      id: `price-${s.recurrenceId}`,
      category: 'profit',
      title: `Raise ${s.customerName} from $${Math.round(s.perVisit)} → $${newPrice}`,
      subtitle: s.rep.service_type || (s.cadence ? `${s.cadence} service` : undefined),
      impact: annual, oneTime: false, revenueImpact: annual, profitImpact: annual,
      confidence, confidenceScore: CONF_SCORE[confidence], why, action,
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

// ── ⚠️ PROBLEMS: thin / negative-profit customers + missed jobs ──────────────────
function problems(ctx: SuggestionContext, hoodAvgRevPerJob: number): Suggestion[] {
  const out: Suggestion[] = []
  const series = buildSeries(ctx)
  const located = ctx.jobs.filter(j => j.properties?.lat != null && j.properties?.lng != null).map(j => ({ lat: j.properties!.lat as number, lng: j.properties!.lng as number }))
  // Avg actual minutes per customer (calibration), for the on-site estimate.
  const actualByCust: Record<string, number[]> = {}
  for (const j of ctx.jobs) if (j.customer_id && j.status === 'completed' && Number(j.actual_minutes) > 0) (actualByCust[j.customer_id] ||= []).push(Number(j.actual_minutes))

  for (const s of series) {
    if (!s.futureOpen.length || s.perVisit <= 0) continue
    const sqft = sqftFor(s.property)
    const actuals = s.customerId ? actualByCust[s.customerId] : undefined
    const onSite = actuals?.length ? Math.round(actuals.reduce((a, b) => a + b, 0) / actuals.length)
      : sqft > 0 ? estimateVisitMinutes(sqft) : ONSITE_DEFAULT
    const hasGeo = s.property?.lat != null && s.property?.lng != null
    const driveMin = driveMinFor(s.property, ctx, located)
    const econ = visitEconomics(s.perVisit, onSite, driveMin, ctx.crewCost)
    const thin = econ.profit <= 5 || econ.margin < 0.2
    if (!thin) continue
    const vpy = seriesVisitsPerYear(s)
    // Repricing target = the price that yields a healthy 50% margin given the
    // visit's real labour cost (visitEconomics), or the hood average if higher.
    const targetRev = Math.max(econ.laborCost > 0 ? round5(econ.laborCost / 0.5) : round5(s.perVisit * 1.3), hoodAvgRevPerJob > 0 ? round5(hoodAvgRevPerJob) : 0)
    const annual = Math.round(Math.max(targetRev - s.perVisit, Math.max(0, -econ.profit)) * vpy)
    const confidence: Confidence = (actuals?.length ?? 0) >= 3 && hasGeo && located.length > 1 ? 'high' : 'medium'
    const why = [
      `Only $${econ.profit}/visit profit (${Math.round(econ.margin * 100)}% margin)`,
      hasGeo ? `~${driveMin} min drive each way at $${ctx.crewCost}/hr crew cost` : `$${ctx.crewCost}/hr crew cost · location not set, drive estimated`,
      `$${Math.round(s.perVisit)}/visit · ${onSite} min on site`,
    ]
    out.push({
      id: `problem-${s.recurrenceId}`,
      category: 'problem',
      title: `Reprice or drop ${s.customerName}`,
      subtitle: s.rep.service_type || undefined,
      impact: annual, oneTime: false, profitImpact: annual, revenueImpact: 0,
      confidence, confidenceScore: CONF_SCORE[confidence], why,
      action: { kind: 'navigate', label: 'Review customer', href: s.customerId ? `/dashboard/customers/${s.customerId}` : '/dashboard/customers' },
    })
  }

  // Missed jobs — overdue scheduled/in-progress visits sitting unbilled.
  const missed = ctx.jobs.filter(j => (j.status === 'scheduled' || j.status === 'in_progress') && j.scheduled_date < ctx.today)
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
  // Neighbor leads not yet quoted.
  const openLeads = ctx.neighborLeads.filter(l => l.status === 'prospect' || l.status === 'contacted').length
  if (openLeads >= 1) {
    out.push({
      id: 'growth-leads',
      category: 'growth',
      title: `Follow up ${openLeads} neighbor lead${openLeads !== 1 ? 's' : ''}`,
      subtitle: 'Prospects next to your existing routes',
      impact: 0, oneTime: true,
      confidence: 'medium', confidenceScore: CONF_SCORE.medium,
      why: [`${openLeads} lead${openLeads !== 1 ? 's' : ''} waiting in prospect/contacted`, 'They sit right on your current routes — low travel cost to win'],
      action: { kind: 'navigate', label: 'Open leads', href: '/dashboard/neighbors' },
    })
  }
  return out
}

// ── ❤️ RETENTION: win back ran-out/lapsed + chase quotes ─────────────────────────
function retention(ctx: SuggestionContext): Suggestion[] {
  const out: Suggestion[] = []
  const series = buildSeries(ctx)
  // A series with NO future open visit whose season is currently active = lapsed.
  let lapsedCount = 0, lapsedAnnual = 0
  for (const s of series) {
    if (s.futureOpen.length > 0) continue
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
  // Sent quotes that need a follow-up.
  const toChase = ctx.quotes.filter(q => q.status === 'sent' && needsFollowUp(q))
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

// ── the advisor ─────────────────────────────────────────────────────────────────
export function buildSuggestions(ctx: SuggestionContext): Suggestion[] {
  // One neighborhood pass shared by price + problem generators.
  let avgHoodRevPerJob = 0
  try {
    const { jobs, pctx } = profitJobsAndCtx(ctx)
    const hoods = neighborhoodProfitability(jobs, pctx).filter(h => h.key !== 'Unknown' && h.customers >= 2)
    avgHoodRevPerJob = hoods.length ? hoods.reduce((s, h) => s + h.revPerJob, 0) / hoods.length : 0
  } catch { /* leave 0 */ }

  const gens: Array<() => Suggestion[]> = [
    () => priceRaises(ctx, avgHoodRevPerJob),
    () => addonUpsells(ctx),
    () => routeImprovements(ctx),
    () => problems(ctx, avgHoodRevPerJob),
    () => growth(ctx),
    () => retention(ctx),
  ]
  const all: Suggestion[] = []
  for (const g of gens) { try { all.push(...g()) } catch { /* a failing generator never breaks the feed */ } }
  // Rank by impact, but a RECURRING annual gain outranks a one-time amount of the
  // same size (the spec prioritizes annual profit); ties → higher confidence.
  const rankValue = (s: Suggestion) => s.oneTime ? s.impact * 0.5 : s.impact
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
