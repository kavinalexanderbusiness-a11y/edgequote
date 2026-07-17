import type { SupabaseClient } from '@supabase/supabase-js'
import { localTodayISO } from '@/lib/utils'
import { effectiveFreq, jobVisitValue } from '@/lib/invoicing'
import { estimateLabor, learnLaborModel, LaborModel, LaborObservation } from '@/lib/labor'
import { fetchForecast, DayForecast, weatherScore, WeatherScore } from '@/lib/weather'
import { buildDayStatusMap, DAY_STATUS_SELECT, DayStatusRow, DayStatusMap, dayStatusLabel } from '@/lib/dayStatus'

// ── Weather Impact analytics ─────────────────────────────────────────────────────
// Turns the forecast + your booked work into a risk picture: which jobs, labor
// hours, revenue and customers are exposed on rainy days, what each day's capacity
// looks like, and the best dry day to move to. COMPOSITION ONLY — reuses Smart
// Labor V2 (estimateLabor) for hours, the valuation engine for revenue, and the
// capacity math. It analyses and recommends; the actual move stays in the existing
// Rain Delay Center / optimizer.

export interface WIJob {
  id: string
  date: string
  serviceType: string | null
  crewSize: number
  propertyId: string | null
  sqft: number
  isInitial: boolean
  value: number
  customerId: string | null
}

// One actionable verdict for a day with booked work — the Rain Delay Recommendation
// (req #8). 'delay' = move the jobs, 'monitor' = watch it, 'keep' = work as planned.
export interface DayRecommendation {
  action: 'keep' | 'monitor' | 'delay'
  jobsAffected: number
  text: string
}

export interface DayImpact {
  date: string
  forecast: DayForecast
  score: WeatherScore       // Green / Yellow / Red
  recommendation: DayRecommendation
  jobs: number
  laborHours: number
  revenue: number
  customers: number
  capacityHours: number
  utilizationPct: number
  overbooked: boolean
  recommendedDay: string | null
  recommendedProjectedHours: number | null // dest day's hours if these jobs move there
  recommendedOverbooks: boolean
  recommendedNote: string
}

export interface WeatherImpactReport {
  hasBase: boolean
  forecast: DayForecast[]
  today: DayForecast | null
  tomorrow: DayForecast | null
  atRiskDays: DayImpact[]
  // Headline verdict across the week — what the owner should do, in one line.
  headline: string
  // Which location the forecast is for (e.g. "Calgary, AB" or the base address),
  // and whether we fell back to the Calgary default because no base is configured.
  locationLabel: string
  usingDefaultLocation: boolean
  // Days in the forecast window the owner manually marked unavailable (Day Status).
  // Weather Ops never recommends these AND explains why (e.g. "Rain — manually
  // blocked") instead of silently skipping them.
  blockedDays: { date: string; status: string; label: string }[]
  totals: { jobs: number; laborHours: number; revenue: number; customers: number; days: number }
}

// Default business location when none is configured in Settings yet.
export const DEFAULT_LOCATION = { lat: 51.0447, lng: -114.0719, label: 'Calgary, AB' }

const round1 = (n: number) => Math.round(n * 10) / 10
const dow = (iso: string) => new Date(iso + 'T00:00:00').getDay()

export function computeWeatherImpact(
  jobs: WIJob[],
  forecast: DayForecast[],
  model: LaborModel,
  capacityHours: number,
  preferredDays: number[],
  today: string,
  locationLabel = 'your business location',
  usingDefaultLocation = false,
  dayStatus: DayStatusMap = { byDate: {}, blockedDates: new Set() },  // Day Status — never recommend blocked days
): WeatherImpactReport {
  const pref = preferredDays.length ? new Set(preferredDays) : null
  const fByDate: Record<string, DayForecast> = {}
  for (const f of forecast) fByDate[f.date] = f

  // Hours per day (Smart Labor estimate) + grouping.
  const jobsByDate: Record<string, WIJob[]> = {}
  const hoursByDate: Record<string, number> = {}
  for (const j of jobs) {
    ;(jobsByDate[j.date] ||= []).push(j)
    const est = estimateLabor({ sqft: j.sqft, serviceType: j.serviceType, crewSize: j.crewSize, propertyId: j.propertyId, isInitialVisit: j.isInitial, date: j.date }, model)
    hoursByDate[j.date] = (hoursByDate[j.date] || 0) + est.minutes / 60
  }

  // Best dry day to MOVE a rainy day's work to: the soonest preferred work day that
  // isn't rainy AND still has room for these hours — accounting for what EARLIER
  // rain days this week were already assigned, so multiple rain days spread across
  // multiple dry days instead of all piling onto the first dry day.
  const committedExtra: Record<string, number> = {}
  const findDryDay = (afterDate: string, neededHours: number): string | null => {
    let firstDry: string | null = null
    for (const f of forecast) {
      if (f.date <= afterDate) continue
      if (pref && !pref.has(dow(f.date))) continue
      if (dayStatus.blockedDates.has(f.date)) continue   // day marked unavailable — never recommend it
      if (f.rainy) continue
      if (firstDry == null) firstDry = f.date
      if ((hoursByDate[f.date] || 0) + (committedExtra[f.date] || 0) + neededHours <= capacityHours) return f.date
    }
    return firstDry  // nothing with spare capacity — soonest dry day (flagged overbooked)
  }

  const atRiskDays: DayImpact[] = []
  for (const f of forecast) {
    if (f.date < today) continue
    if (!f.rainy) continue
    // Higher-priority schedule state wins: a day the owner already marked
    // unavailable (manually disabled / vacation / holiday / sick / equipment /
    // no-crew block) is suppressed here so weather NEVER adds a contradictory
    // "delay/monitor" suggestion on top. It's still surfaced — with its real
    // reason — in `blockedDays` below, so the owner sees why it isn't recommended.
    if (dayStatus.blockedDates.has(f.date)) continue
    const dayJobs = jobsByDate[f.date] || []
    if (!dayJobs.length) continue
    const laborHours = round1(hoursByDate[f.date] || 0)
    const revenue = Math.round(dayJobs.reduce((s, j) => s + j.value, 0))
    const customers = new Set(dayJobs.map(j => j.customerId).filter(Boolean)).size
    const rec = findDryDay(f.date, laborHours)
    const recExisting = rec ? (hoursByDate[rec] || 0) + (committedExtra[rec] || 0) : 0
    const recProjected = rec ? round1(recExisting + laborHours) : null
    const recOverbooks = recProjected != null && recProjected > capacityHours
    if (rec) committedExtra[rec] = (committedExtra[rec] || 0) + laborHours  // reserve room for this day
    const score = weatherScore(f)
    const recDayLabel = rec ? new Date(rec + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : null
    const recommendation: DayRecommendation = score.level === 'red'
      ? { action: 'delay', jobsAffected: dayJobs.length,
          text: `Delay ${dayJobs.length} job${dayJobs.length !== 1 ? 's' : ''} — ${score.reason}.${recDayLabel ? ` Best move: ${recDayLabel}.` : ' No dry work day in range — pick a specific date.'}` }
      : score.level === 'yellow'
      ? { action: 'monitor', jobsAffected: dayJobs.length,
          text: `Monitor ${dayJobs.length} job${dayJobs.length !== 1 ? 's' : ''} — ${score.reason}. Decide the morning of.` }
      : { action: 'keep', jobsAffected: dayJobs.length, text: 'Keep schedule' }
    atRiskDays.push({
      date: f.date, forecast: f, score, recommendation, jobs: dayJobs.length, laborHours, revenue, customers,
      capacityHours, utilizationPct: capacityHours > 0 ? Math.round((laborHours / capacityHours) * 100) : 0,
      overbooked: laborHours > capacityHours,
      recommendedDay: rec, recommendedProjectedHours: recProjected, recommendedOverbooks: recOverbooks,
      recommendedNote: !rec ? 'No dry work day in the next week — consider a specific date'
        : recOverbooks ? `${recDayLabel} would be over capacity (${recProjected}h vs ${capacityHours}h) — split across days`
          : `Best move: ${recDayLabel} (${recProjected}h of ${capacityHours}h after)`,
    })
  }

  const totals = atRiskDays.reduce((t, d) => ({
    jobs: t.jobs + d.jobs, laborHours: round1(t.laborHours + d.laborHours), revenue: t.revenue + d.revenue,
    customers: t.customers + d.customers, days: t.days + 1,
  }), { jobs: 0, laborHours: 0, revenue: 0, customers: 0, days: 0 })

  // Headline = the soonest day that needs action (delay), else the soonest to
  // monitor, else "keep schedule".
  const fmtDay = (iso: string) => iso === today ? 'today' : new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long' })
  const firstDelay = atRiskDays.find(d => d.recommendation.action === 'delay')
  const firstMonitor = atRiskDays.find(d => d.recommendation.action === 'monitor')
  const headline = firstDelay
    ? `Delay recommended ${fmtDay(firstDelay.date)} — ${firstDelay.jobs} job${firstDelay.jobs !== 1 ? 's' : ''}, ${firstDelay.laborHours}h, $${Math.round(firstDelay.revenue)} at risk`
    : firstMonitor
    ? `Monitor ${fmtDay(firstMonitor.date)} — ${firstMonitor.jobs} job${firstMonitor.jobs !== 1 ? 's' : ''} could be affected`
    : 'Keep schedule — no rain risk to booked work this week'

  // Manually-blocked days within the forecast window, so the page can explain why
  // they aren't recommended ("Sunday is unavailable (Rain — manually blocked)").
  const blockedDays = Object.values(dayStatus.byDate)
    .filter(r => r.blocks && fByDate[r.date])
    .map(r => ({ date: r.date, status: r.status, label: dayStatusLabel(r) }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return {
    hasBase: true, forecast,
    today: fByDate[today] || null,
    tomorrow: forecast.find(f => f.date > today) || null,
    atRiskDays, headline, locationLabel, usingDefaultLocation, blockedDays, totals,
  }
}

/**
 * Rows a caller has already loaded. Every field is optional — pass what you have
 * and the rest is still fetched. The dashboard reads all of these for its own
 * bands, so without this the weather engine re-read four of the same tables on
 * every morning load (and read them UNPAGED, so a truncated `quotes` would have
 * quietly mispriced the revenue-at-risk figure).
 */
export interface WeatherPreloaded {
  settings?: { base_lat?: number | null; base_lng?: number | null; base_address?: string | null; daily_capacity_hours?: number | null; preferred_work_days?: number[] | null } | null
  /** Must cover today → +8d and include the joined properties(lawn_sqft). */
  jobs?: unknown[]
  quotes?: { id: string }[]
  recurrences?: { id: string; freq: string | null; interval_unit: string | null; interval_count: number | null }[]
}

export async function loadWeatherImpact(supabase: SupabaseClient, pre?: WeatherPreloaded): Promise<WeatherImpactReport> {
  const empty: WeatherImpactReport = { hasBase: false, forecast: [], today: null, tomorrow: null, atRiskDays: [], headline: '', locationLabel: DEFAULT_LOCATION.label, usingDefaultLocation: true, blockedDays: [], totals: { jobs: 0, laborHours: 0, revenue: 0, customers: 0, days: 0 } }
  // getSession is a local cookie read; getUser round-trips the Auth server. This
  // sits on the critical path AHEAD of its own queries, so the round trip was
  // pure latency (matches the repo's getSession-on-hot-loaders convention).
  const { data: { session } } = await supabase.auth.getSession()
  const user = session?.user
  if (!user) return empty
  const uid = user.id
  const today = localTodayISO()
  const horizon = (() => { const d = new Date(today + 'T00:00:00'); d.setDate(d.getDate() + 8); return d.toISOString().slice(0, 10) })()

  const [sRes, jRes, qRes, pRes, rRes, oRes, dRes] = await Promise.all([
    pre?.settings !== undefined ? { data: pre.settings } : supabase.from('business_settings').select('base_lat, base_lng, base_address, daily_capacity_hours, preferred_work_days').eq('user_id', uid).maybeSingle(),
    pre?.jobs ? { data: pre.jobs } : supabase.from('jobs').select('id, scheduled_date, status, service_type, crew_size, property_id, quote_id, recurrence_id, price, is_initial_visit, customer_id, properties(lawn_sqft)').eq('user_id', uid).gte('scheduled_date', today).lte('scheduled_date', horizon),
    pre?.quotes ? { data: pre.quotes } : supabase.from('quotes').select('id, total, initial_price, weekly_price, biweekly_price, monthly_price').eq('user_id', uid),
    supabase.from('properties').select('id, lawn_sqft').eq('user_id', uid),
    pre?.recurrences ? { data: pre.recurrences } : supabase.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', uid),
    supabase.from('labor_observations').select('job_id, property_id, service_date, sqft, service_type, crew_size, frequency, is_initial_visit, overgrowth, estimated_minutes, actual_minutes').eq('user_id', uid),
    supabase.from('day_statuses').select(DAY_STATUS_SELECT).eq('user_id', uid),
  ])
  // Day Status map — Weather Ops never recommends blocked days, and explains them.
  const dayStatus = buildDayStatusMap((dRes.data as DayStatusRow[]) || [])

  const settings = sRes.data as { base_lat?: number | null; base_lng?: number | null; base_address?: string | null; daily_capacity_hours?: number | null; preferred_work_days?: number[] | null } | null
  // Always have a location: the configured base if set, else default to Calgary.
  // Changing the base address in Settings re-geocodes base_lat/lng, so the weather
  // system follows it automatically — no code change needed.
  const hasConfigured = settings?.base_lat != null && settings?.base_lng != null
  const lat = hasConfigured ? settings!.base_lat! : DEFAULT_LOCATION.lat
  const lng = hasConfigured ? settings!.base_lng! : DEFAULT_LOCATION.lng
  const locationLabel = hasConfigured ? (settings?.base_address?.trim() || 'Your business location') : DEFAULT_LOCATION.label
  const usingDefaultLocation = !hasConfigured

  const forecast = await fetchForecast(lat, lng, 7)
  if (!forecast.length) return { ...empty, hasBase: true, locationLabel, usingDefaultLocation }

  const model = learnLaborModel((oRes.data as LaborObservation[]) || [])
  const quotesById: Record<string, Record<string, unknown>> = {}
  for (const q of (qRes.data as { id: string }[]) || []) quotesById[q.id] = q as unknown as Record<string, unknown>
  const sqftByProp: Record<string, number> = {}
  for (const p of (pRes.data as { id: string; lawn_sqft: number | null }[]) || []) sqftByProp[p.id] = Number(p.lawn_sqft) || 0
  const recById: Record<string, { freq: string | null; interval_unit: string | null; interval_count: number | null }> = {}
  for (const r of (rRes.data as { id: string; freq: string | null; interval_unit: string | null; interval_count: number | null }[]) || []) recById[r.id] = r

  const jobs: WIJob[] = ((jRes.data as unknown as Array<Record<string, any>>) || [])
    .filter(j => j.status !== 'cancelled' && j.status !== 'completed')
    .map(j => {
      const rec = j.recurrence_id ? recById[j.recurrence_id] : null
      const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
      const q = j.quote_id ? quotesById[j.quote_id] : null
      return {
        id: j.id, date: j.scheduled_date, serviceType: j.service_type, crewSize: Number(j.crew_size) || 1,
        propertyId: j.property_id ?? null, sqft: Number(j.properties?.lawn_sqft) || (j.property_id ? sqftByProp[j.property_id] : 0) || 0,
        isInitial: !!j.is_initial_visit, value: jobVisitValue(j.price, q, freq, j.is_initial_visit ?? false),
        customerId: j.customer_id ?? null,
      }
    })

  const capacityHours = Number(settings?.daily_capacity_hours) > 0 ? Number(settings!.daily_capacity_hours) : 8
  const preferredDays = settings?.preferred_work_days?.length ? settings!.preferred_work_days! : [5, 6, 0]
  return computeWeatherImpact(jobs, forecast, model, capacityHours, preferredDays, today, locationLabel, usingDefaultLocation, dayStatus)
}