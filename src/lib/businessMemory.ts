import type { SupabaseClient } from '@supabase/supabase-js'
import { loadLaborModel, serviceKey, serviceLabel, type LaborModel } from '@/lib/labor'
import { loadTravelModel, type TravelModel } from '@/lib/travelLearning'
import { loadQuotePricingModel, type LoadedQuoteModel } from '@/lib/quoteLearning'
import { readCache, writeCache, CACHE_TTL } from '@/lib/clientCache'

// ── Business Memory — the ONE read seam over everything EdgeQuote has learned ────
// NOT a new learning engine and NOT new storage. Every learner keeps its single
// responsibility — labor (lib/labor), travel (lib/travelLearning), pricing win-rates
// (lib/quoteLearning), win/loss (lib/winLoss), marketing quality (marketing_assets),
// scheduling prefs (lib/preferences) — and this module simply composes them, plus
// derives per-customer HABITS from tables that already record behaviour (invoices,
// messages, jobs). Read-only, cached, fault-tolerant: a consumer asks Business
// Memory one question instead of five engines, and every answer can say WHY.
// Feeding it is automatic — completing jobs, sending quotes, getting paid and
// replying to texts is the data entry.

export interface CustomerHabits {
  customerId: string
  // Communication
  preferredChannel: 'sms' | 'email' | 'portal' | null   // the channel THEY actually reply on
  medianResponseMin: number | null                       // how fast they answer an outbound
  // Money
  medianDaysToPay: number | null                         // invoice issued → paid
  paymentsOnRecord: number
  // Work
  favoriteServices: { key: string; label: string; n: number }[]  // by completed jobs
  completedJobs: number
  cancelledJobs: number
  typicalStartTime: string | null                        // median HH:MM of their completed visits
  lastCompletedAt: string | null
  repeatCustomer: boolean                                // 3+ completed visits
  reasons: string[]                                      // WHY — derived, human-readable
}

export interface BusinessMemory {
  labor: LaborModel | null            // duration learning (per service × cadence × property)
  travel: TravelModel | null          // drive-time learning (min/km + overhead + per-hood)
  pricing: LoadedQuoteModel | null    // win-rate learning (per service, ratio-based)
  crewCost: number
  habitsByCustomer: Record<string, CustomerHabits>
  decidedQuotes: number
  trainedJobs: number
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const i = Math.floor(s.length / 2)
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2
}
const mmToHHMM = (mm: number) => `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(Math.round(mm) % 60).padStart(2, '0')}`
const hhmmToMin = (t: string | null): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

// ── per-customer habit derivation (pure — rows in, habits out) ───────────────────
interface MsgRow { customer_id: string | null; direction: string; channel: string; created_at: string }
interface InvRow { customer_id: string | null; issued_date: string | null; paid_at: string | null }
interface JobRowBM { customer_id: string | null; service_type: string | null; status: string | null; start_time: string | null; scheduled_date: string | null; completed_at: string | null }

export function deriveCustomerHabits(
  messages: MsgRow[], invoices: InvRow[], jobs: JobRowBM[],
): Record<string, CustomerHabits> {
  const byCust: Record<string, { msgs: MsgRow[]; invs: InvRow[]; jobs: JobRowBM[] }> = {}
  const bucket = (id: string) => (byCust[id] ||= { msgs: [], invs: [], jobs: [] })
  for (const m of messages) if (m.customer_id) bucket(m.customer_id).msgs.push(m)
  for (const i of invoices) if (i.customer_id) bucket(i.customer_id).invs.push(i)
  for (const j of jobs) if (j.customer_id) bucket(j.customer_id).jobs.push(j)

  const out: Record<string, CustomerHabits> = {}
  for (const [customerId, d] of Object.entries(byCust)) {
    const reasons: string[] = []

    // Preferred channel = the one THEY write back on (their behaviour, not ours).
    const inboundByChannel: Record<string, number> = {}
    for (const m of d.msgs) if (m.direction === 'inbound' && m.channel !== 'internal') inboundByChannel[m.channel] = (inboundByChannel[m.channel] || 0) + 1
    const topChannel = Object.entries(inboundByChannel).sort((a, b) => b[1] - a[1])[0]
    const preferredChannel = (topChannel?.[0] as CustomerHabits['preferredChannel']) ?? null
    if (topChannel && topChannel[1] >= 2) reasons.push(`Replies by ${topChannel[0]} (${topChannel[1]}×)`)

    // Response time = outbound → next inbound gap (median, capped at 48 h so an
    // unanswered thread doesn't poison the number).
    const sorted = [...d.msgs].sort((a, b) => a.created_at.localeCompare(b.created_at))
    const gaps: number[] = []
    let lastOut: number | null = null
    for (const m of sorted) {
      const t = Date.parse(m.created_at)
      if (m.direction === 'outbound') { if (lastOut == null) lastOut = t }
      else if (m.direction === 'inbound' && lastOut != null) {
        const min = (t - lastOut) / 60_000
        if (min > 0 && min <= 48 * 60) gaps.push(min)
        lastOut = null
      }
    }
    const medianResponseMin = gaps.length >= 2 ? Math.round(median(gaps)!) : null
    if (medianResponseMin != null) reasons.push(medianResponseMin <= 60 ? `Fast responder (~${medianResponseMin} min)` : `Typically replies in ~${Math.round(medianResponseMin / 60)} h`)

    // Payment speed = issued → paid days.
    const payDays: number[] = []
    for (const i of d.invs) {
      if (!i.issued_date || !i.paid_at) continue
      const days = (Date.parse(i.paid_at) - Date.parse(i.issued_date)) / 86_400_000
      if (days >= 0 && days <= 120) payDays.push(days)
    }
    const medianDaysToPay = payDays.length ? Math.round(median(payDays)! * 10) / 10 : null
    if (medianDaysToPay != null) reasons.push(medianDaysToPay <= 2 ? `Pays fast (~${medianDaysToPay} d)` : `Pays in ~${Math.round(medianDaysToPay)} days`)

    // Services + cancellations + typical start time (completed jobs; the same
    // serviceKey identity the labor + pricing learners use — one vocabulary).
    const done = d.jobs.filter(j => (j.status || '').toLowerCase() === 'completed')
    const cancelled = d.jobs.filter(j => (j.status || '').toLowerCase() === 'cancelled').length
    const svcCounts: Record<string, number> = {}
    for (const j of done) { const k = serviceKey(j.service_type); svcCounts[k] = (svcCounts[k] || 0) + 1 }
    const favoriteServices = Object.entries(svcCounts)
      .map(([key, n]) => ({ key, label: serviceLabel(key), n }))
      .sort((a, b) => b.n - a.n).slice(0, 3)
    if (favoriteServices[0] && favoriteServices[0].n >= 2) reasons.push(`Usually books ${favoriteServices[0].label} (${favoriteServices[0].n}×)`)
    const startMins = done.map(j => hhmmToMin(j.start_time)).filter((n): n is number => n != null)
    const startMed = median(startMins)
    const typicalStartTime = startMed != null && startMins.length >= 2 ? mmToHHMM(startMed) : null
    if (typicalStartTime) reasons.push(`Visits usually start ~${typicalStartTime}`)
    if (cancelled >= 2) reasons.push(`${cancelled} cancellations on record`)
    const lastCompletedAt = done.map(j => j.completed_at || j.scheduled_date || '').filter(Boolean).sort().pop() || null

    out[customerId] = {
      customerId,
      preferredChannel, medianResponseMin,
      medianDaysToPay, paymentsOnRecord: payDays.length,
      favoriteServices, completedJobs: done.length, cancelledJobs: cancelled,
      typicalStartTime, lastCompletedAt,
      repeatCustomer: done.length >= 3,
      reasons,
    }
  }
  return out
}

// ── the loader (cached; each sub-load best-effort so one failure never blanks all) ─
export async function loadBusinessMemory(
  supabase: SupabaseClient,
  opts?: { force?: boolean },
): Promise<BusinessMemory | null> {
  const cacheKey = 'business-memory'
  if (!opts?.force) {
    const cached = readCache<BusinessMemory>(cacheKey, CACHE_TTL.medium)
    if (cached) return cached
  }
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const uid = user.id

  const [labor, travel, pricing, msgRes, invRes, jobRes] = await Promise.all([
    loadLaborModel(supabase).catch(() => null),
    loadTravelModel(supabase).catch(() => null),
    loadQuotePricingModel(supabase).catch(() => null),
    supabase.from('messages').select('customer_id, direction, channel, created_at').eq('user_id', uid).order('created_at', { ascending: false }).limit(2000),
    supabase.from('invoices').select('customer_id, issued_date, paid_at').eq('user_id', uid).not('paid_at', 'is', null).limit(1000),
    supabase.from('jobs').select('customer_id, service_type, status, start_time, scheduled_date, completed_at').eq('user_id', uid).limit(2000),
  ])

  const habitsByCustomer = deriveCustomerHabits(
    (msgRes.data as MsgRow[]) || [],
    (invRes.data as InvRow[]) || [],
    (jobRes.data as JobRowBM[]) || [],
  )

  const memory: BusinessMemory = {
    labor: labor?.model ?? null,
    travel: travel ?? null,
    pricing: pricing ?? null,
    crewCost: labor?.crewCost ?? 40,
    habitsByCustomer,
    decidedQuotes: pricing?.model.decidedQuotes ?? 0,
    trainedJobs: labor?.model.totalSamples ?? 0,
  }
  writeCache(cacheKey, memory)
  return memory
}

export function invalidateBusinessMemory(): void {
  try { sessionStorage.removeItem('eq:business-memory') } catch { /* ignore */ }
}
