import type { SupabaseClient } from '@supabase/supabase-js'
import { localTodayISO } from '@/lib/utils'
import { crewCostPerHour } from '@/lib/economics'
import { effectiveFreq, jobVisitValue } from '@/lib/invoicing'
import { SEASON_VISITS } from '@/lib/pricing'
import { settingsToSeasons, seasonForService, isWithinSeason, ServiceSeasons } from '@/lib/seasons'
import { learnDurations, learnedDurationFor } from '@/lib/duration'
import { densityFor, locatedStops } from '@/lib/routeDensity'
import { analyzeWinLoss, WLQuote, QuoteOutcomeRow } from '@/lib/winLoss'
import {
  ProfitJob, ProfitContext, ProfitQuote, RecInfo,
  jobValue, neighborhoodProfitability, dayProfitability, monthlyTrends, neighborhoodKey, MonthTrend, Grade,
} from '@/lib/profitability'

// ── Business Intelligence engine (Growth) ───────────────────────────────────────
// The owner's single source of truth: how is the business performing and where to
// focus. COMPOSITION ONLY — every number routes through an existing engine
// (profitability, economics, invoicing valuation, win/loss, duration learning,
// route density, seasons). No new pricing/routing/valuation math. Pure + sync;
// a thin loader assembles the inputs in one parallel fetch.

const DEFAULT_LABOR_MIN = 45

export interface NamedValue { name: string; value: number; sub?: number }
export interface BIReport {
  generatedFor: string // 'Jun 2026'
  financial: {
    revenueThisMonth: number
    revenueLastMonth: number
    revenueYTD: number
    monthOverMonthPct: number | null
    byService: NamedValue[]
    byNeighborhood: NamedValue[]
    byCustomer: NamedValue[]
    trend: MonthTrend[] // last 12 months
  }
  profitability: {
    revenuePerLaborHour: number
    grossProfitYTD: number
    grossMarginPct: number
    topCustomers: NamedValue[]      // by profit
    topNeighborhoods: NamedValue[]  // by revenue/hr
    topServices: NamedValue[]       // by profit/hr
    crewEfficiencyPct: number | null // actual vs estimated time (100 = on estimate; <100 = faster)
    routeRevPerKm: number
    avgGrade: Grade | null
  }
  customers: {
    active: number
    total: number
    newThisMonth: number
    churnRatePct: number | null
    retentionRatePct: number | null
    avgLifetimeValue: number
    avgAnnualValue: number
    forecastLtv: number             // active recurring annual × expected lifetime
    growth: NamedValue[]            // new customers per month (last 6)
  }
  sales: {
    quoteAcceptancePct: number | null
    won: number
    lost: number
    avgQuoteValue: number
    lostValue: number
    byServiceType: NamedValue[]     // win rate % per service type
    byNeighborhood: NamedValue[]    // win rate % per hood
    topLossReasons: NamedValue[]
  }
  operations: {
    capacityUtilizationPct: number | null // trailing 4 weeks
    bookedUtilizationPct: number | null   // next 2 weeks
    laborAccuracyPct: number | null
    autoMeasureAccuracyPct: number | null
    avgRouteDensity: number               // 0-100
    timedJobs: number
  }
  forecasting: {
    projectedThisMonth: number
    projectedRecurringAnnual: number
    projectedSeasonRemaining: number
    capacityForecastPct: number | null
    growthForecastPct: number | null
  }
}

const round = (n: number) => Math.round(n)
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0)
const laborMinOf = (j: ProfitJob) => Number(j.actual_minutes) || Number(j.duration_minutes) || DEFAULT_LABOR_MIN
const monthKey = (iso: string) => iso.slice(0, 7)

// A representative active recurring series → its per-visit value + cadence, for
// recurring run-rate / forecasting. Lightweight grouping (not the suggestions
// engine's Series, but the same valuation path).
interface MiniSeries { customerId: string | null; cadence: string | null; perVisit: number; rep: ProfitJob; hasFuture: boolean; lastCompleted: string | null; serviceType: string | null }
function buildMiniSeries(jobs: ProfitJob[], recs: Record<string, RecInfo>, quotesById: Record<string, ProfitQuote>, today: string): MiniSeries[] {
  const byRec: Record<string, ProfitJob[]> = {}
  for (const j of jobs) if (j.recurrence_id) (byRec[j.recurrence_id] ||= []).push(j)
  const out: MiniSeries[] = []
  for (const [rid, list] of Object.entries(byRec)) {
    const rec = recs[rid]
    if (!rec) continue
    const sorted = [...list].sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))
    const futureOpen = sorted.filter(j => j.scheduled_date >= today && j.status !== 'completed' && j.status !== 'cancelled')
    const rep = futureOpen[0] || sorted[sorted.length - 1]
    if (!rep) continue
    const cadence = effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count)
    const q = rep.quote_id ? quotesById[rep.quote_id] : null
    const perVisit = jobVisitValue(rep.price, q as unknown as Record<string, unknown>, cadence)
    const lastCompleted = [...sorted].reverse().find(j => j.status === 'completed')?.scheduled_date ?? null
    out.push({ customerId: rep.customer_id, cadence, perVisit, rep, hasFuture: futureOpen.length > 0, lastCompleted, serviceType: rep.service_type })
  }
  return out
}
function visitsPerSeason(cadence: string | null): number {
  if (cadence === 'weekly') return SEASON_VISITS.weekly
  if (cadence === 'biweekly') return SEASON_VISITS.biweekly
  if (cadence === 'monthly') return SEASON_VISITS.monthly
  return 1
}

export interface BIInput {
  jobs: ProfitJob[]
  pctx: ProfitContext
  customers: { id: string; name: string; created_at: string }[]
  quotes: { id: string; status: string; total: number | null; service_type: string | null; property_id: string | null }[]
  quoteOutcomes: QuoteOutcomeRow[]
  properties: { id: string; lat: number | null; lng: number | null; postal_code: string | null; city: string | null; neighborhood: string | null }[]
  recurrences: Record<string, RecInfo>
  invoices: { status: string; amount: number | null; customer_id: string | null }[]
  crewCost: number
  capacityHours: number
  preferredDays: number[]
  seasons: ServiceSeasons
  today: string
}

export function computeBI(inp: BIInput): BIReport {
  const { jobs, pctx, customers, quotes, quoteOutcomes, properties, recurrences, crewCost, capacityHours, preferredDays, seasons, today } = inp
  const yr = today.slice(0, 4)
  const thisMonth = today.slice(0, 7)
  const yearStart = `${yr}-01-01`
  const [py, pm] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))]
  const lastMonth = pm === 1 ? `${py - 1}-12` : `${py}-${String(pm - 1).padStart(2, '0')}`

  const completed = jobs.filter(j => j.status === 'completed')
  const earned = (j: ProfitJob) => jobValue(j, pctx)

  // ── FINANCIAL ──
  let revThisMonth = 0, revLastMonth = 0, revYTD = 0
  const svcRev: Record<string, number> = {}
  const custRev: Record<string, number> = {}
  for (const j of completed) {
    const v = earned(j)
    const mk = monthKey(j.scheduled_date)
    if (mk === thisMonth) revThisMonth += v
    if (mk === lastMonth) revLastMonth += v
    if (j.scheduled_date >= yearStart) {
      revYTD += v
      const svc = j.service_type || 'Other'
      svcRev[svc] = (svcRev[svc] || 0) + v
      if (j.customer_id) custRev[j.customer_id] = (custRev[j.customer_id] || 0) + v
    }
  }
  const custName: Record<string, string> = {}
  for (const c of customers) custName[c.id] = c.name
  const byService = Object.entries(svcRev).map(([name, value]) => ({ name, value: round(value) })).sort((a, b) => b.value - a.value).slice(0, 8)
  const byCustomer = Object.entries(custRev).map(([id, value]) => ({ name: custName[id] || 'Unknown', value: round(value) })).sort((a, b) => b.value - a.value).slice(0, 8)
  // Revenue by neighbourhood (YTD completed) — reuse the profitability engine on a scoped input.
  const ytdCompleted = completed.filter(j => j.scheduled_date >= yearStart)
  const hoodProfit = neighborhoodProfitability(ytdCompleted, pctx)
  const byNeighborhood = hoodProfit.filter(h => h.key !== 'Unknown').map(h => ({ name: h.key, value: h.revenue, sub: h.revPerHour })).slice(0, 8)

  // Monthly trend (last 12 mo) — day routes rolled up by the profitability engine.
  const pastDates = [...new Set(jobs.filter(j => j.scheduled_date <= today && j.status !== 'cancelled').map(j => j.scheduled_date))]
  const jobsByDate: Record<string, ProfitJob[]> = {}
  for (const j of jobs) (jobsByDate[j.scheduled_date] ||= []).push(j)
  const routes = pastDates.map(d => dayProfitability(d, jobsByDate[d] || [], pctx))
  const allTrend = monthlyTrends(routes)
  const trend = allTrend.slice(-12)

  // ── PROFITABILITY ──
  let totalLaborMin = 0, grossProfit = 0
  const custProfit: Record<string, number> = {}
  const svcProfit: Record<string, { profit: number; hours: number }> = {}
  for (const j of ytdCompleted) {
    const v = earned(j)
    const lm = laborMinOf(j)
    totalLaborMin += lm
    const cost = (lm / 60) * crewCost
    const p = v - cost
    grossProfit += p
    if (j.customer_id) custProfit[j.customer_id] = (custProfit[j.customer_id] || 0) + p
    const svc = j.service_type || 'Other'
    const e = (svcProfit[svc] ||= { profit: 0, hours: 0 })
    e.profit += p; e.hours += lm / 60
  }
  const totalHours = totalLaborMin / 60
  const revPerLaborHour = totalHours > 0 ? round(revYTD / totalHours) : 0
  const topCustomers = Object.entries(custProfit).map(([id, value]) => ({ name: custName[id] || 'Unknown', value: round(value) })).sort((a, b) => b.value - a.value).slice(0, 6)
  const topNeighborhoods = hoodProfit.filter(h => h.key !== 'Unknown' && h.revPerHour > 0).map(h => ({ name: h.key, value: h.revPerHour, sub: h.revenue })).sort((a, b) => b.value - a.value).slice(0, 6)
  const topServices = Object.entries(svcProfit).map(([name, e]) => ({ name, value: e.hours > 0 ? round(e.profit / e.hours) : 0, sub: round(e.profit) })).sort((a, b) => b.value - a.value).slice(0, 6)

  // Crew efficiency + labour accuracy from check-in/out actuals.
  const durModel = learnDurations(jobs)
  let effNum = 0, effDen = 0, apeSum = 0, apeN = 0
  for (const j of completed) {
    const actual = Number(j.actual_minutes)
    if (!(actual > 0)) continue
    const est = Number(j.duration_minutes) || learnedDurationFor({ service_type: j.service_type, duration_minutes: null }, durModel)
    if (est > 0) { effNum += actual; effDen += est; apeSum += Math.abs(actual - est) / est; apeN++ }
  }
  const crewEfficiencyPct = effDen > 0 ? Math.round((effNum / effDen) * 100) : null
  const laborAccuracyPct = apeN >= 3 ? Math.max(0, Math.round((1 - apeSum / apeN) * 100)) : null

  const routesWithDrive = routes.filter(r => r.hasDriveData)
  const routeRevPerKm = routesWithDrive.length ? Math.round((routesWithDrive.reduce((s, r) => s + r.revenue, 0) / Math.max(1, routesWithDrive.reduce((s, r) => s + r.driveKm, 0))) * 10) / 10 : 0
  const gradeOrder: Grade[] = ['F', 'D', 'C', 'B', 'A']
  const avgGrade = routesWithDrive.length ? gradeOrder[Math.round(routesWithDrive.reduce((s, r) => s + gradeOrder.indexOf(r.grade), 0) / routesWithDrive.length)] : null

  // ── CUSTOMERS ──
  const series = buildMiniSeries(jobs, recurrences, pctx.quotesById, today)
  const lastVisitByCust: Record<string, string> = {}
  for (const j of completed) if (j.customer_id) { if (!lastVisitByCust[j.customer_id] || j.scheduled_date > lastVisitByCust[j.customer_id]) lastVisitByCust[j.customer_id] = j.scheduled_date }
  const futureCust = new Set(jobs.filter(j => j.customer_id && j.scheduled_date >= today && j.status !== 'completed' && j.status !== 'cancelled').map(j => j.customer_id as string))
  const dDays = (iso: string) => Math.round((new Date(today + 'T00:00:00').getTime() - new Date(iso + 'T00:00:00').getTime()) / 86_400_000)
  const activeIds = new Set<string>()
  for (const id of Object.keys(lastVisitByCust)) if (dDays(lastVisitByCust[id]) <= 90) activeIds.add(id)
  for (const id of futureCust) activeIds.add(id)

  // Churn / retention over RECURRING customers (in-season, ran out vs still active).
  const recCustIds = new Set(series.map(s => s.customerId).filter(Boolean) as string[])
  let retained = 0, churned = 0, recurringAnnual = 0
  const countedRecCust = new Set<string>()
  for (const s of series) {
    if (!s.customerId) continue
    if (s.hasFuture) { recurringAnnual += s.perVisit * visitsPerSeason(s.cadence) }
    if (countedRecCust.has(s.customerId)) continue
    if (s.hasFuture || (s.customerId && futureCust.has(s.customerId))) { retained++; countedRecCust.add(s.customerId); continue }
    const season = seasonForService(s.serviceType, seasons)
    if (season && !isWithinSeason(today, season)) continue // off-season dormant ≠ churned
    if (s.lastCompleted) { churned++; countedRecCust.add(s.customerId) }
  }
  const churnRatePct = retained + churned > 0 ? Math.round((churned / (retained + churned)) * 100) : null
  const retentionRatePct = churnRatePct == null ? null : 100 - churnRatePct

  // Lifetime value (all completed) + averages.
  const ltvByCust: Record<string, number> = {}
  for (const j of completed) if (j.customer_id) ltvByCust[j.customer_id] = (ltvByCust[j.customer_id] || 0) + earned(j)
  const ltvVals = Object.values(ltvByCust)
  const avgLifetimeValue = ltvVals.length ? round(ltvVals.reduce((a, b) => a + b, 0) / ltvVals.length) : 0
  const avgAnnualValue = activeIds.size ? round(revYTD / activeIds.size) : 0
  const forecastLtv = recCustIds.size ? round((recurringAnnual / Math.max(1, retained)) * 3) : 0 // active recurring annual × ~3yr lifetime

  const newByMonth: Record<string, number> = {}
  for (const c of customers) { const mk = monthKey(c.created_at.slice(0, 10)); newByMonth[mk] = (newByMonth[mk] || 0) + 1 }
  const last6 = Array.from({ length: 6 }, (_, i) => { const d = new Date(today + 'T00:00:00'); d.setMonth(d.getMonth() - (5 - i)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` })
  const growth = last6.map(m => ({ name: m, value: newByMonth[m] || 0 }))
  const newThisMonth = newByMonth[thisMonth] || 0

  // ── SALES ──
  const propById: Record<string, { postal_code: string | null; city: string | null; neighborhood: string | null }> = {}
  for (const p of properties) propById[p.id] = p
  const hoodOf = (q: WLQuote) => { const p = q.property_id ? propById[q.property_id] : undefined; return p ? neighborhoodKey(p.postal_code, p.city, p.neighborhood) : 'Unknown' }
  const wlQuotes: WLQuote[] = quotes.map(q => ({ id: q.id, status: q.status, total: q.total, property_id: q.property_id }))
  const wl = analyzeWinLoss(wlQuotes, quoteOutcomes, hoodOf)
  const decidedQuotes = quotes.filter(q => ['accepted', 'scheduled', 'completed', 'paid', 'declined'].includes(q.status))
  const avgQuoteValue = decidedQuotes.length ? round(decidedQuotes.reduce((s, q) => s + Number(q.total || 0), 0) / decidedQuotes.length) : 0
  // Win rate by service type.
  const svcWL: Record<string, { won: number; dec: number }> = {}
  for (const q of quotes) {
    const won = ['accepted', 'scheduled', 'completed', 'paid'].includes(q.status)
    const lost = q.status === 'declined'
    if (!won && !lost) continue
    const k = q.service_type || 'Other'
    const e = (svcWL[k] ||= { won: 0, dec: 0 })
    e.dec++; if (won) e.won++
  }
  const byServiceType = Object.entries(svcWL).filter(([, e]) => e.dec >= 2).map(([name, e]) => ({ name, value: Math.round((e.won / e.dec) * 100), sub: e.dec })).sort((a, b) => b.value - a.value).slice(0, 6)
  const byHoodWL = wl.byHood.filter(h => h.hood !== 'Unknown' && h.decided >= 2).map(h => ({ name: h.hood, value: Math.round(h.winRate * 100), sub: h.decided })).slice(0, 6)
  const topLossReasons = Object.entries(wl.reasonCounts).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 5)

  // ── OPERATIONS ──
  const capMin = capacityHours * 60
  const pref = preferredDays.length ? new Set(preferredDays) : null
  const isPref = (iso: string) => { const dow = new Date(iso + 'T00:00:00').getDay(); return !pref || pref.has(dow) }
  // Trailing 4 weeks completed utilization.
  let trailLabor = 0, trailDays = 0
  for (let i = 1; i <= 28; i++) { const d = new Date(today + 'T00:00:00'); d.setDate(d.getDate() - i); const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; if (!isPref(iso)) continue; const dj = (jobsByDate[iso] || []).filter(j => j.status === 'completed'); if (dj.length) { trailDays++; trailLabor += dj.reduce((s, j) => s + laborMinOf(j), 0) } }
  const capacityUtilizationPct = trailDays > 0 ? Math.round((trailLabor / (trailDays * capMin)) * 100) : null
  // Next 2 weeks booked utilization.
  let fwdLabor = 0, fwdDays = 0
  for (let i = 0; i <= 14; i++) { const d = new Date(today + 'T00:00:00'); d.setDate(d.getDate() + i); const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; if (!isPref(iso)) continue; fwdDays++; const dj = (jobsByDate[iso] || []).filter(j => j.status !== 'cancelled' && j.scheduled_date >= today); fwdLabor += dj.reduce((s, j) => s + laborMinOf(j), 0) }
  const bookedUtilizationPct = fwdDays > 0 ? Math.round((fwdLabor / (fwdDays * capMin)) * 100) : null
  const propStops = locatedStops(jobs.map(j => ({ lat: j.lat, lng: j.lng })))
  const avgRouteDensity = propStops.length > 1 ? Math.round(propStops.reduce((s, c) => s + densityFor(c, propStops).score, 0) / propStops.length) : 0

  // ── FORECASTING ──
  // This month projection = actual-so-far + recurring run-rate for the rest.
  const monthRecurringRunRate = series.filter(s => s.hasFuture).reduce((s, m) => {
    const perMonth = m.cadence === 'weekly' ? 4 : m.cadence === 'biweekly' ? 2 : m.cadence === 'monthly' ? 1 : 0
    return s + m.perVisit * perMonth
  }, 0)
  const dayOfMonth = Number(today.slice(8, 10))
  const daysInMonth = new Date(py, pm, 0).getDate()
  const projectedThisMonth = round(revThisMonth + monthRecurringRunRate * ((daysInMonth - dayOfMonth) / daysInMonth))
  const projectedRecurringAnnual = round(recurringAnnual)
  // Remaining season recurring value (visits left this season).
  let projectedSeasonRemaining = 0
  for (const s of series) {
    if (!s.hasFuture) continue
    const season = seasonForService(s.serviceType, seasons)
    if (season && !isWithinSeason(today, season)) continue
    const futureVisits = s.rep ? jobs.filter(j => j.recurrence_id && j.customer_id === s.customerId && j.scheduled_date >= today && j.status !== 'cancelled' && j.status !== 'completed').length : 0
    projectedSeasonRemaining += s.perVisit * Math.max(futureVisits, 0)
  }
  projectedSeasonRemaining = round(projectedSeasonRemaining)
  // Growth forecast = slope of last 3 months of revenue trend.
  let growthForecastPct: number | null = null
  if (trend.length >= 3) {
    const a = trend[trend.length - 3].revenue, b = trend[trend.length - 1].revenue
    if (a > 0) growthForecastPct = Math.round(((b - a) / a) * 100)
  }

  return {
    generatedFor: new Date(today + 'T00:00:00').toLocaleString('en-US', { month: 'short', year: 'numeric' }),
    financial: { revenueThisMonth: round(revThisMonth), revenueLastMonth: round(revLastMonth), revenueYTD: round(revYTD), monthOverMonthPct: revLastMonth > 0 ? Math.round(((revThisMonth - revLastMonth) / revLastMonth) * 100) : null, byService, byNeighborhood, byCustomer, trend },
    profitability: { revenuePerLaborHour: revPerLaborHour, grossProfitYTD: round(grossProfit), grossMarginPct: pct(grossProfit, revYTD), topCustomers, topNeighborhoods, topServices, crewEfficiencyPct, routeRevPerKm, avgGrade },
    customers: { active: activeIds.size, total: customers.length, newThisMonth, churnRatePct, retentionRatePct, avgLifetimeValue, avgAnnualValue, forecastLtv, growth },
    sales: { quoteAcceptancePct: wl.decided >= 1 ? Math.round(wl.winRate * 100) : null, won: wl.won, lost: wl.lost, avgQuoteValue, lostValue: round(wl.byHood.reduce((s, h) => s + h.lostValue, 0)), byServiceType, byNeighborhood: byHoodWL, topLossReasons },
    operations: { capacityUtilizationPct, bookedUtilizationPct, laborAccuracyPct, autoMeasureAccuracyPct: null, avgRouteDensity, timedJobs: durModel.totalSamples },
    forecasting: { projectedThisMonth, projectedRecurringAnnual, projectedSeasonRemaining, capacityForecastPct: bookedUtilizationPct, growthForecastPct },
  }
}

// ── loader ──────────────────────────────────────────────────────────────────────
export async function loadBusinessIntelligence(supabase: SupabaseClient): Promise<BIReport | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const uid = user.id
  const [jRes, qRes, rRes, pRes, cRes, iRes, sRes, oRes] = await Promise.all([
    supabase.from('jobs').select('id, scheduled_date, status, service_type, quote_id, recurrence_id, duration_minutes, actual_minutes, price, customer_id, property_id, properties(lat, lng, city, postal_code, neighborhood)').eq('user_id', uid),
    supabase.from('quotes').select('id, status, total, initial_price, weekly_price, biweekly_price, monthly_price, service_type, property_id').eq('user_id', uid),
    supabase.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', uid),
    supabase.from('properties').select('id, lat, lng, postal_code, city, neighborhood').eq('user_id', uid),
    supabase.from('customers').select('id, name, created_at').eq('user_id', uid),
    supabase.from('invoices').select('status, amount, customer_id').eq('user_id', uid),
    supabase.from('business_settings').select('crew_cost_per_hour, daily_capacity_hours, preferred_work_days, base_lat, base_lng, service_seasons').eq('user_id', uid).maybeSingle(),
    supabase.from('quote_outcomes').select('quote_id, reason, detail, competitor_price').eq('user_id', uid),
  ])

  const settings = sRes.data as Record<string, unknown> | null
  const quotesById: Record<string, ProfitQuote> = {}
  for (const q of (qRes.data as (ProfitQuote & { id: string })[]) || []) quotesById[q.id] = q
  const recurrences: Record<string, RecInfo> = {}
  for (const r of (rRes.data as (RecInfo & { id: string })[]) || []) recurrences[r.id] = { freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count }

  const baseLat = settings?.base_lat as number | null | undefined
  const baseLng = settings?.base_lng as number | null | undefined
  const today = localTodayISO()
  const pctx: ProfitContext = { quotesById, recById: recurrences, base: baseLat != null && baseLng != null ? { lat: baseLat, lng: baseLng } : null, today }

  const jobs: ProfitJob[] = ((jRes.data as unknown as Array<Record<string, any>>) || []).map(j => ({
    id: j.id, scheduled_date: j.scheduled_date, status: j.status, service_type: j.service_type,
    quote_id: j.quote_id, recurrence_id: j.recurrence_id, duration_minutes: j.duration_minutes,
    actual_minutes: j.actual_minutes, price: j.price, customer_id: j.customer_id,
    lat: j.properties?.lat ?? null, lng: j.properties?.lng ?? null,
    city: j.properties?.city ?? null, postal_code: j.properties?.postal_code ?? null, neighborhood: j.properties?.neighborhood ?? null,
  }))

  return computeBI({
    jobs, pctx,
    customers: (cRes.data as { id: string; name: string; created_at: string }[]) || [],
    quotes: (qRes.data as { id: string; status: string; total: number | null; service_type: string | null; property_id: string | null }[]) || [],
    quoteOutcomes: (oRes.data as QuoteOutcomeRow[]) || [],
    properties: (pRes.data as { id: string; lat: number | null; lng: number | null; postal_code: string | null; city: string | null; neighborhood: string | null }[]) || [],
    recurrences,
    invoices: (iRes.data as { status: string; amount: number | null; customer_id: string | null }[]) || [],
    crewCost: crewCostPerHour(settings?.crew_cost_per_hour as number | null | undefined),
    capacityHours: Number(settings?.daily_capacity_hours) > 0 ? Number(settings!.daily_capacity_hours) : 8,
    preferredDays: (settings?.preferred_work_days as number[] | null)?.length ? (settings!.preferred_work_days as number[]) : [5, 6, 0],
    seasons: settingsToSeasons(settings?.service_seasons),
    today,
  })
}
