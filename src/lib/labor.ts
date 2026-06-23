import type { SupabaseClient } from '@supabase/supabase-js'
import { estimateVisitMinutes } from '@/lib/pricing'
import { crewCostPerHour } from '@/lib/economics'
import { jobVisitValue } from '@/lib/invoicing'

// ── Smart Labor Calculator V2 — the self-learning labor engine ───────────────────
// Estimates on-site minutes from a property's OWN history first, then the service
// combo / sqft / season / crew, learning from every completed timed job. Returns a
// confidence range and an explanation. BACKWARDS COMPATIBLE: feeds the labor layer
// only — never pricing. Designed as the ONE labor model so capacity forecasting,
// crew scheduling, route planning and hiring can later read the same primitives
// (per-combo solo-minutes, learned crew efficiency, seasonal factors).

export interface LaborObservation {
  job_id: string | null
  property_id: string | null
  service_date: string | null
  sqft: number | null
  service_type: string | null
  crew_size: number
  frequency: string | null
  is_initial_visit: boolean
  overgrowth: number | null
  estimated_minutes: number | null
  actual_minutes: number
}

export type Season = 'spring' | 'summer' | 'fall' | 'winter'
export type Confidence = 'high' | 'medium' | 'low'

// Diminishing-returns starting point; OVERRIDDEN by learned values where data allows.
const DEFAULT_CREW_EFFICIENCY: Record<number, number> = { 1: 1.0, 2: 1.8, 3: 2.5, 4: 3.1, 5: 3.6, 6: 4.0 }
const DEFAULT_SEASON_FACTOR: Record<Season, number> = { spring: 1.2, summer: 1.0, fall: 1.1, winter: 1.0 }
const DEFAULT_FIRST_CUT_FACTOR = 1.35
const MIN_CREW_SAMPLES = 4
const MIN_SEASON_SAMPLES = 4

// ── service combo normalization (req #4) ────────────────────────────────────────
const TOKEN_HINTS: { token: string; re: RegExp }[] = [
  { token: 'mow', re: /mow|grass\s*cut|lawn\s*cut|\bcut\b/i },
  { token: 'trim', re: /trim|whipper|string/i },
  { token: 'edge', re: /edg/i },
  { token: 'cleanup', re: /clean\s*-?\s*up/i },
  { token: 'mulch', re: /mulch/i },
  { token: 'weed', re: /weed/i },
  { token: 'aerate', re: /aerat/i },
  { token: 'fertilize', re: /fertil/i },
  { token: 'snow', re: /snow|plow|plough|shovel|\bice\b|salt/i },
]
export function normalizeCombo(serviceType: string | null | undefined): { tokens: string[]; key: string } {
  const s = (serviceType || '').toLowerCase()
  const tokens = TOKEN_HINTS.filter(h => h.re.test(s)).map(h => h.token)
  if (!tokens.length) return { tokens: ['other'], key: 'other' }
  return { tokens: tokens.sort(), key: tokens.sort().join('+') }
}
export const COMBO_LABEL: Record<string, string> = {
  mow: 'Mow', 'edge+mow': 'Mow + Edge', 'mow+trim': 'Mow + Trim', 'edge+mow+trim': 'Mow + Trim + Edge',
  cleanup: 'Cleanup', mulch: 'Mulch', weed: 'Weed control', aerate: 'Aeration', snow: 'Snow', other: 'Other',
}
export function comboLabel(key: string): string {
  return COMBO_LABEL[key] || key.split('+').map(t => t[0].toUpperCase() + t.slice(1)).join(' + ')
}
const isLawnCombo = (key: string) => key !== 'snow' && key !== 'other'

function seasonOf(dateISO: string | null | undefined): Season {
  if (!dateISO) return 'summer'
  const m = Number(dateISO.slice(5, 7))
  if (m >= 4 && m <= 5) return 'spring'
  if (m >= 6 && m <= 8) return 'summer'
  if (m >= 9 && m <= 10) return 'fall'
  return 'winter'
}
function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function cv(xs: number[]): number {
  if (xs.length < 2) return 0.25
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  if (mean <= 0) return 0.25
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length
  return Math.min(1, Math.sqrt(v) / mean)
}
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

// ── the learned model ───────────────────────────────────────────────────────────
export interface LaborModel {
  combos: Record<string, { soloPer1000: number; cv: number; n: number }> // solo-equivalent min / 1000 ft²
  lawnAll: { soloPer1000: number; cv: number; n: number }
  byProperty: Record<string, { soloMinutes: number[]; sqft: number | null }> // absolute solo-equiv minutes per visit
  crewEff: Record<number, number>          // learned-or-default effective-workers
  crewManMinPer1000: Record<number, number> // raw man-min/1000 per crew (dashboard trend)
  season: Record<Season, number>
  firstCutFactor: number
  totalSamples: number
}

function crewEffFn(model: LaborModel | null, crew: number): number {
  const c = Math.max(1, Math.round(crew))
  if (model?.crewEff[c]) return model.crewEff[c]
  if (DEFAULT_CREW_EFFICIENCY[c]) return DEFAULT_CREW_EFFICIENCY[c]
  return Math.max(1, c * 0.7) // extrapolate for big crews
}

export function learnLaborModel(obs: LaborObservation[]): LaborModel {
  // Learn crew efficiency first (raw man-min/1000 per crew → effective workers).
  const manMinByCrew: Record<number, number[]> = {}
  for (const o of obs) {
    if (!(o.actual_minutes > 0) || !(Number(o.sqft) > 0)) continue
    const c = Math.max(1, o.crew_size || 1)
    ;(manMinByCrew[c] ||= []).push((c * o.actual_minutes) / (Number(o.sqft) / 1000))
  }
  const crewManMinPer1000: Record<number, number> = {}
  for (const [c, xs] of Object.entries(manMinByCrew)) crewManMinPer1000[Number(c)] = Math.round(median(xs))
  const crewEff: Record<number, number> = {}
  const baseline = manMinByCrew[1] && manMinByCrew[1].length >= MIN_CREW_SAMPLES ? median(manMinByCrew[1]) : null
  for (const [cStr, xs] of Object.entries(manMinByCrew)) {
    const c = Number(cStr)
    if (c === 1) { crewEff[1] = 1.0; continue }
    if (baseline && xs.length >= MIN_CREW_SAMPLES) {
      // effective workers = c × (solo man-min ÷ this crew's man-min); ≤ c, ≥ 1.
      crewEff[c] = clamp(c * (baseline / median(xs)), 1, c)
    }
  }

  // Normalize every sized observation to SOLO-equivalent duration per 1000 ft².
  const eff = (c: number) => crewEff[c] ?? DEFAULT_CREW_EFFICIENCY[c] ?? Math.max(1, c * 0.7)
  const comboVals: Record<string, number[]> = {}
  const lawnVals: number[] = []
  const seasonVals: Record<Season, number[]> = { spring: [], summer: [], fall: [], winter: [] }
  const firstCutVals: number[] = []
  const nonFirstVals: number[] = []
  const byProperty: Record<string, { soloMinutes: number[]; sqft: number | null }> = {}

  for (const o of obs) {
    if (!(o.actual_minutes > 0)) continue
    const soloMin = o.actual_minutes * eff(Math.max(1, o.crew_size || 1)) // solo-equivalent absolute minutes
    if (o.property_id) {
      const p = (byProperty[o.property_id] ||= { soloMinutes: [], sqft: o.sqft })
      p.soloMinutes.push(soloMin); if (o.sqft) p.sqft = o.sqft
    }
    if (!(Number(o.sqft) > 0)) continue
    const per1000 = soloMin / (Number(o.sqft) / 1000)
    const { key } = normalizeCombo(o.service_type)
    ;(comboVals[key] ||= []).push(per1000)
    if (isLawnCombo(key)) {
      lawnVals.push(per1000)
      seasonVals[seasonOf(o.service_date)].push(per1000)
      if (o.is_initial_visit) firstCutVals.push(per1000); else nonFirstVals.push(per1000)
    }
  }

  const combos: LaborModel['combos'] = {}
  for (const [k, xs] of Object.entries(comboVals)) combos[k] = { soloPer1000: median(xs), cv: cv(xs), n: xs.length }
  const lawnAll = { soloPer1000: median(lawnVals), cv: cv(lawnVals), n: lawnVals.length }

  // Seasonal factors RELATIVE to overall (learned where enough data, else default).
  const overall = median(lawnVals) || 1
  const season: Record<Season, number> = { ...DEFAULT_SEASON_FACTOR }
  for (const s of ['spring', 'summer', 'fall', 'winter'] as Season[]) {
    if (seasonVals[s].length >= MIN_SEASON_SAMPLES) season[s] = clamp(median(seasonVals[s]) / overall, 0.7, 1.8)
  }
  const firstCutFactor = (firstCutVals.length >= MIN_SEASON_SAMPLES && nonFirstVals.length >= MIN_SEASON_SAMPLES)
    ? clamp(median(firstCutVals) / median(nonFirstVals), 1.0, 2.0)
    : DEFAULT_FIRST_CUT_FACTOR

  return { combos, lawnAll, byProperty, crewEff, crewManMinPer1000, season, firstCutFactor, totalSamples: obs.filter(o => o.actual_minutes > 0).length }
}

// ── the estimate ─────────────────────────────────────────────────────────────────
export interface EstimateInput {
  sqft: number
  serviceType: string | null
  crewSize: number
  overgrowth?: number        // multiplier (light .9 / standard 1 / heavy 1.25 / extreme 1.5)
  isInitialVisit?: boolean
  date?: string | null       // for seasonality; defaults to today's month
  propertyId?: string | null
}
export interface LaborEstimate {
  minutes: number
  minMinutes: number
  maxMinutes: number
  confidence: Confidence
  confidencePct: number
  sampleSize: number
  basis: 'property' | 'learned' | 'size-model'
  reasons: string[]
  manMinutes: number         // crew-independent work (for capacity/crew planning — future)
}

export function estimateLabor(input: EstimateInput, model: LaborModel | null): LaborEstimate {
  const sqft = Math.max(0, input.sqft || 0)
  const crew = Math.max(1, Math.round(input.crewSize || 1))
  const og = input.overgrowth && input.overgrowth > 0 ? input.overgrowth : 1
  const { key } = normalizeCombo(input.serviceType)
  const season = seasonOf(input.date ?? null)
  const seasonF = model ? model.season[season] : DEFAULT_SEASON_FACTOR[season]
  const firstCutF = input.isInitialVisit ? (model ? model.firstCutFactor : DEFAULT_FIRST_CUT_FACTOR) : 1

  const reasons: string[] = []
  const comboStats = model?.combos[key] && model.combos[key].n >= 2 ? model.combos[key]
    : model && isLawnCombo(key) && model.lawnAll.n >= 2 ? model.lawnAll : null
  const comboN = comboStats?.n ?? 0
  const comboCv = comboStats?.cv ?? 0.3

  // Combo-based solo-equivalent minutes (size-model fallback when no learned data).
  let comboSolo: number
  let usedSizeModel = false
  if (comboStats && sqft > 0) {
    comboSolo = comboStats.soloPer1000 * (sqft / 1000) * seasonF * firstCutF * og
    reasons.push(`${comboN} similar ${comboLabel(key)} job${comboN !== 1 ? 's' : ''}`)
    if (input.isInitialVisit) reasons.push('First cut of the season — heavier than a maintenance visit')
    if (season !== 'summer') reasons.push(`${season[0].toUpperCase() + season.slice(1)} adjustment applied`)
  } else {
    comboSolo = estimateVisitMinutes(sqft) * firstCutF * og
    usedSizeModel = true
    reasons.push('Size-based estimate — time a few of these jobs to sharpen it')
  }

  // Property-level weighting — the property's OWN history dominates when present.
  const propStats = input.propertyId ? model?.byProperty[input.propertyId] : undefined
  const propN = propStats?.soloMinutes.length ?? 0
  let solo = comboSolo
  let propCv = comboCv
  if (propStats && propN >= 1) {
    const propSolo = median(propStats.soloMinutes) * og * firstCutF
    propCv = cv(propStats.soloMinutes)
    const w = clamp(propN / (propN + 2), 0, 0.85) // heavy property weight, capped
    solo = w * propSolo + (1 - w) * comboSolo
    reasons.unshift(`${propN} past visit${propN !== 1 ? 's' : ''} to this exact property (weighted ${Math.round(w * 100)}%)`)
  }

  const minutes = clamp(Math.round(solo / crewEffFn(model, crew)), 10, 240)
  const manMinutes = Math.round(solo)
  const varianceCv = propN >= 2 ? Math.min(propCv, comboCv) : comboCv
  const band = clamp(varianceCv, 0.08, 0.4)
  const minMinutes = clamp(Math.round(minutes * (1 - band)), 8, minutes)
  const maxMinutes = clamp(Math.round(minutes * (1 + band)), minutes, 300)

  // Confidence (req #5): property history OR large sample = high; moderate = medium;
  // mostly size-based = low. Always explained.
  let confidence: Confidence, confidencePct: number, basis: LaborEstimate['basis']
  if (propN >= 2 || comboN >= 12) {
    confidence = 'high'
    confidencePct = clamp(Math.round(80 + Math.min(15, comboN * 0.5 + propN * 4) - varianceCv * 25), 70, 96)
    basis = propN >= 2 ? 'property' : 'learned'
  } else if (comboN >= 4 || propN >= 1) {
    confidence = 'medium'
    confidencePct = clamp(Math.round(55 + Math.min(16, comboN * 1.5 + propN * 6) - varianceCv * 15), 45, 74)
    basis = propN >= 1 ? 'property' : 'learned'
  } else {
    confidence = 'low'
    confidencePct = clamp(Math.round((usedSizeModel ? 35 : 45) - varianceCv * 10), 25, 50)
    basis = usedSizeModel ? 'size-model' : 'learned'
  }
  if (confidence === 'high' && basis === 'property') reasons.unshift('High confidence — this property has its own track record')
  else if (confidence === 'high') reasons.unshift('High confidence — large sample of similar jobs')
  else if (confidence === 'low') reasons.push('Low confidence — based mostly on lawn size')

  return { minutes, minMinutes, maxMinutes, confidence, confidencePct, sampleSize: propN + comboN, basis, reasons, manMinutes }
}

// ── recommendation layer (req #4) ─────────────────────────────────────────────────
export interface LaborEconomics { laborCost: number; revPerLaborHour: number; grossProfit: number; marginPct: number }
export function laborEconomics(minutes: number, price: number, crewCost: number): LaborEconomics {
  const hours = minutes / 60
  const laborCost = Math.round(hours * crewCost)
  const revPerLaborHour = hours > 0 && price > 0 ? Math.round(price / hours) : 0
  const grossProfit = Math.round(price - laborCost)
  return { laborCost, revPerLaborHour, grossProfit, marginPct: price > 0 ? Math.round((grossProfit / price) * 100) : 0 }
}

// ── learning dashboard (req #6, #7) ───────────────────────────────────────────────
export interface ServiceAccuracy { combo: string; label: string; n: number; accuracyPct: number; avgErrorPct: number }
export interface PropertyAccuracy { propertyId: string; name: string; n: number; accuracyPct: number }
export interface PredictionMiss { propertyName: string; combo: string; estimated: number; actual: number; errorPct: number; date: string | null }
export interface ServiceProfit { combo: string; label: string; n: number; revPerHour: number; profit: number }
export interface CrewTrend { crewSize: number; n: number; manMinPer1000: number; effectiveWorkers: number }
export interface LaborInsights {
  trainingJobs: number
  overallAccuracyPct: number | null
  avgErrorPct: number | null
  mostAccurate: ServiceAccuracy[]
  leastAccurate: ServiceAccuracy[]
  mostProfitable: ServiceProfit[]
  leastProfitable: ServiceProfit[]
  bestProperties: PropertyAccuracy[]
  worstMisses: PredictionMiss[]
  crewTrends: CrewTrend[]
}

export function buildLaborInsights(
  obs: LaborObservation[],
  model: LaborModel,
  ctx: { valueByJob: Record<string, number>; nameByProperty: Record<string, string>; crewCost: number },
): LaborInsights {
  const scored = obs.filter(o => o.actual_minutes > 0 && Number(o.estimated_minutes) > 0)
  const ape = (o: LaborObservation) => Math.abs(o.actual_minutes - (o.estimated_minutes as number)) / o.actual_minutes
  const overallAccuracyPct = scored.length >= 3 ? Math.max(0, Math.round((1 - scored.reduce((s, o) => s + ape(o), 0) / scored.length) * 100)) : null
  const avgErrorPct = scored.length >= 3 ? Math.round((scored.reduce((s, o) => s + ape(o), 0) / scored.length) * 100) : null

  // Per-combo accuracy.
  const comboAcc: Record<string, { errs: number[]; }> = {}
  for (const o of scored) { const { key } = normalizeCombo(o.service_type); (comboAcc[key] ||= { errs: [] }).errs.push(ape(o)) }
  const accList: ServiceAccuracy[] = Object.entries(comboAcc).filter(([, v]) => v.errs.length >= 2).map(([combo, v]) => {
    const avgErr = v.errs.reduce((a, b) => a + b, 0) / v.errs.length
    return { combo, label: comboLabel(combo), n: v.errs.length, accuracyPct: Math.max(0, Math.round((1 - avgErr) * 100)), avgErrorPct: Math.round(avgErr * 100) }
  }).sort((a, b) => b.accuracyPct - a.accuracyPct)

  // Per-combo profitability (labor actuals × revenue) — ties labor into BI/Revenue Intel.
  const comboProfit: Record<string, { rev: number; hours: number; profit: number; n: number }> = {}
  for (const o of obs) {
    if (!o.job_id || !(o.actual_minutes > 0)) continue
    const rev = ctx.valueByJob[o.job_id]
    if (rev == null) continue
    const { key } = normalizeCombo(o.service_type)
    const hours = o.actual_minutes / 60
    const e = (comboProfit[key] ||= { rev: 0, hours: 0, profit: 0, n: 0 })
    e.rev += rev; e.hours += hours; e.profit += rev - hours * ctx.crewCost; e.n++
  }
  const profitList: ServiceProfit[] = Object.entries(comboProfit).filter(([, v]) => v.n >= 2).map(([combo, v]) => ({
    combo, label: comboLabel(combo), n: v.n, revPerHour: v.hours > 0 ? Math.round(v.rev / v.hours) : 0, profit: Math.round(v.profit),
  })).sort((a, b) => b.revPerHour - a.revPerHour)

  // Per-property accuracy + worst individual misses.
  const propAcc: Record<string, number[]> = {}
  const misses: PredictionMiss[] = []
  for (const o of scored) {
    if (o.property_id) (propAcc[o.property_id] ||= []).push(ape(o))
    misses.push({ propertyName: o.property_id ? (ctx.nameByProperty[o.property_id] || 'Property') : 'Property', combo: comboLabel(normalizeCombo(o.service_type).key), estimated: o.estimated_minutes as number, actual: o.actual_minutes, errorPct: Math.round(ape(o) * 100), date: o.service_date })
  }
  const bestProperties: PropertyAccuracy[] = Object.entries(propAcc).filter(([, v]) => v.length >= 2).map(([pid, v]) => ({
    propertyId: pid, name: ctx.nameByProperty[pid] || 'Property', n: v.length, accuracyPct: Math.max(0, Math.round((1 - v.reduce((a, b) => a + b, 0) / v.length) * 100)),
  })).sort((a, b) => b.accuracyPct - a.accuracyPct).slice(0, 8)
  const worstMisses = misses.sort((a, b) => b.errorPct - a.errorPct).slice(0, 8)

  const crewTrends: CrewTrend[] = Object.entries(model.crewManMinPer1000).map(([c, v]) => ({
    crewSize: Number(c), n: 0, manMinPer1000: v, effectiveWorkers: Math.round((model.crewEff[Number(c)] ?? DEFAULT_CREW_EFFICIENCY[Number(c)] ?? Number(c)) * 100) / 100,
  })).sort((a, b) => a.crewSize - b.crewSize)

  return {
    trainingJobs: model.totalSamples,
    overallAccuracyPct, avgErrorPct,
    mostAccurate: accList.slice(0, 5), leastAccurate: [...accList].reverse().slice(0, 5),
    mostProfitable: profitList.slice(0, 5), leastProfitable: [...profitList].reverse().slice(0, 5),
    bestProperties, worstMisses, crewTrends,
  }
}

// ── loaders ──────────────────────────────────────────────────────────────────────
export async function loadLaborModel(supabase: SupabaseClient): Promise<{ model: LaborModel; enabled: boolean; crewCost: number } | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const [oRes, sRes] = await Promise.all([
    supabase.from('labor_observations').select('job_id, property_id, service_date, sqft, service_type, crew_size, frequency, is_initial_visit, overgrowth, estimated_minutes, actual_minutes').eq('user_id', user.id),
    supabase.from('business_settings').select('smart_labor_enabled, crew_cost_per_hour').eq('user_id', user.id).maybeSingle(),
  ])
  const obs = (oRes.data as LaborObservation[]) || []
  const s = sRes.data as { smart_labor_enabled?: boolean; crew_cost_per_hour?: number } | null
  return { model: learnLaborModel(obs), enabled: s?.smart_labor_enabled ?? true, crewCost: crewCostPerHour(s?.crew_cost_per_hour) }
}

export async function loadLaborInsights(supabase: SupabaseClient): Promise<{ insights: LaborInsights; model: LaborModel } | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const uid = user.id
  const [oRes, jRes, qRes, pRes, sRes] = await Promise.all([
    supabase.from('labor_observations').select('job_id, property_id, service_date, sqft, service_type, crew_size, frequency, is_initial_visit, overgrowth, estimated_minutes, actual_minutes').eq('user_id', uid),
    supabase.from('jobs').select('id, price, quote_id, recurrence_id, is_initial_visit').eq('user_id', uid),
    supabase.from('quotes').select('id, total, initial_price, weekly_price, biweekly_price, monthly_price').eq('user_id', uid),
    supabase.from('properties').select('id, address').eq('user_id', uid),
    supabase.from('business_settings').select('crew_cost_per_hour').eq('user_id', uid).maybeSingle(),
  ])
  const obs = (oRes.data as LaborObservation[]) || []
  const model = learnLaborModel(obs)

  // Per-job value (reuse the invoicing valuation — same numbers as BI).
  const quotesById: Record<string, Record<string, unknown>> = {}
  for (const q of (qRes.data as { id: string }[]) || []) quotesById[q.id] = q as unknown as Record<string, unknown>
  const valueByJob: Record<string, number> = {}
  for (const j of (jRes.data as { id: string; price: number | null; quote_id: string | null; is_initial_visit: boolean | null }[]) || []) {
    const q = j.quote_id ? quotesById[j.quote_id] : null
    valueByJob[j.id] = jobVisitValue(j.price, q, null, j.is_initial_visit ?? false)
  }
  const nameByProperty: Record<string, string> = {}
  for (const p of (pRes.data as { id: string; address: string }[]) || []) nameByProperty[p.id] = p.address
  const crewCost = crewCostPerHour((sRes.data as { crew_cost_per_hour?: number } | null)?.crew_cost_per_hour)

  return { insights: buildLaborInsights(obs, model, { valueByJob, nameByProperty, crewCost }), model }
}