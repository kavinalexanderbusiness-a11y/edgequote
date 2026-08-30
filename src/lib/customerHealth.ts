import type { SupabaseClient } from '@supabase/supabase-js'
import { localTodayISO } from '@/lib/utils'
import { effectiveFreq } from '@/lib/visitValue'
import { isWithinSeason, settingsToSeasons, ServiceSeasons } from '@/lib/seasons'
import { serviceCategory, bridgeSeasonForSeries } from '@/lib/legacySeasonInference'
import { VIP_LTV, cadenceDays, churnRisk, daysBetween, isLapsed, lifetimeValue } from '@/lib/signals'
import { invoiceBalance } from '@/lib/payments/ledger'
import type { FeeSettings } from '@/lib/invoiceTotals'

// ── Customer Health Score (Growth) ─────────────────────────────────────────────
// ONE 0-100 number per customer that fuses the signals already scattered across
// churn, reactivation and the suggestions feed: lifetime value, tenure, recurring
// status, cadence adherence (are they on schedule?), overdue/churn risk, and
// payment behaviour. So "who's slipping" and "who's most valuable" are scannable
// and sortable in one place. Pure/sync compute + a self-contained loader. Reads
// jobs/invoices/customers only — never writes.

export type HealthTier = 'healthy' | 'watch' | 'at_risk'
export type HealthFlag = 'vip' | 'at_risk' | 'unpaid' | 'new' | 'recurring' | 'lapsed'

export interface HealthRow {
  customerId: string
  name: string
  score: number              // 0..100
  tier: HealthTier
  ltv: number                // lifetime value (completed-visit value)
  tenureDays: number
  recurring: boolean         // has an active recurring plan
  completedVisits: number
  overdueDays: number | null // days past their own cadence (null = on track / no cadence)
  intervalDays: number | null
  unpaidCount: number
  unpaidAmount: number
  flags: HealthFlag[]
  reason: string             // the headline driver (decision-first)
}

interface HJob {
  customer_id: string | null
  status: string
  scheduled_date: string
  service_type: string | null
  recurrence_id: string | null
  quote_id: string | null
  price: number | null
  is_initial_visit?: boolean | null
}
interface HRec { freq: string | null; interval_unit: string | null; interval_count: number | null }
interface HQuote { id: string }
interface HInvoice {
  customer_id: string | null
  status: string
  amount: number | null
  amount_paid?: number | null
  discount_type?: 'amount' | 'percent' | null
  discount_value?: number | null
}
interface HCustomer { id: string; name: string; created_at: string }

export function computeCustomerHealth(
  customers: HCustomer[],
  jobs: HJob[],
  recurrences: Record<string, HRec>,
  quotesById: Record<string, HQuote>,
  invoices: HInvoice[],
  seasons: ServiceSeasons,
  today: string,
  /** GST settings for invoiceBalance. Optional so the pure function stays
   *  callable without settings — omitted = 0%, which only understates. */
  fees?: FeeSettings | null,
): HealthRow[] {
  // Per-customer aggregates in one pass.
  const completed: Record<string, HJob[]> = {}
  const futureOpen: Record<string, HJob[]> = {}
  for (const j of jobs) {
    if (!j.customer_id || j.status === 'cancelled') continue
    if (j.status === 'completed') (completed[j.customer_id] ||= []).push(j)
    else if (j.scheduled_date >= today) (futureOpen[j.customer_id] ||= []).push(j)
  }
  // The customer's dominant active recurrence (most future visits).
  const recByCust: Record<string, { rec: HRec; cadence: string | null; active: boolean }> = {}
  const futureByRec: Record<string, number> = {}
  for (const j of jobs) {
    if (j.recurrence_id && j.scheduled_date >= today && j.status !== 'cancelled' && j.status !== 'completed') futureByRec[j.recurrence_id] = (futureByRec[j.recurrence_id] || 0) + 1
  }
  for (const j of jobs) {
    if (!j.customer_id || !j.recurrence_id) continue
    const rec = recurrences[j.recurrence_id]
    if (!rec) continue
    const cadence = effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count)
    const active = (futureByRec[j.recurrence_id] || 0) > 0
    const prev = recByCust[j.customer_id]
    if (!prev || (active && !prev.active)) recByCust[j.customer_id] = { rec, cadence, active }
  }
  // Who still owes money, and how much. Two rules, both from the ledger contract:
  //
  //  • 'partial' COUNTS. It used to not — so the moment a customer paid a deposit
  //    (the trigger flips unpaid→partial), their entire remaining debt vanished
  //    from the health score, the 'unpaid' flag and the reason line. Paying $2,000
  //    of $4,000 read as healthier than paying nothing, and deposits make partial
  //    the NORMAL state of a big invoice, not an edge case.
  //  • the figure is the BALANCE (invoiceBalance: GST-inclusive total − paid),
  //    not the raw ex-GST `amount` — an invoice 90% paid is $400 of risk, not
  //    $4,000, and the number here must match what Invoices calls Outstanding.
  const unpaidByCust: Record<string, { count: number; amount: number }> = {}
  for (const inv of invoices) {
    if (!inv.customer_id) continue
    if (inv.status === 'unpaid' || inv.status === 'sent' || inv.status === 'partial') {
      const { balance } = invoiceBalance(
        { amount: Number(inv.amount) || 0, amount_paid: Number(inv.amount_paid) || 0, discount_type: inv.discount_type ?? null, discount_value: inv.discount_value ?? null },
        fees,
      )
      if (balance <= 0.01) continue
      const e = (unpaidByCust[inv.customer_id] ||= { count: 0, amount: 0 })
      e.count++; e.amount += balance
    }
  }

  const rows: HealthRow[] = []
  for (const c of customers) {
    const done = (completed[c.id] || []).sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))
    const visits = done.length
    const ltv = lifetimeValue(done, quotesById, recurrences)
    const tenureDays = c.created_at ? Math.max(0, daysBetween(c.created_at.slice(0, 10), today)) : 0
    const recInfo = recByCust[c.id]
    const recurring = !!recInfo?.active
    const hasFuture = (futureOpen[c.id]?.length || 0) > 0
    const unpaid = unpaidByCust[c.id] || { count: 0, amount: 0 }

    // Overdue vs the customer's own cadence (in-season only).
    let overdueDays: number | null = null
    let intervalDays: number | null = null
    const lastDone = done[done.length - 1]
    if (recInfo && lastDone) {
      const season = bridgeSeasonForSeries(null, lastDone.service_type, seasons)
      const inSeason = !season || isWithinSeason(today, season)
      if (inSeason) {
        intervalDays = cadenceDays(recInfo.cadence, recInfo.rec)
        const since = daysBetween(lastDone.scheduled_date, today)
        if (!hasFuture && since > intervalDays) overdueDays = since
      }
    }

    // ── Score: start neutral, reward loyalty/value, penalise risk. ──
    let score = 60
    const flags: HealthFlag[] = []
    if (recurring) { score += 12; flags.push('recurring') }
    if (tenureDays >= 365) score += 8; else if (tenureDays >= 180) score += 4
    if (ltv >= VIP_LTV) { score += 12; flags.push('vip') } else if (ltv >= 500) score += 6
    if (visits >= 6) score += 4
    // Cadence adherence — recent gaps close to the interval = a reliable rhythm.
    if (recInfo && intervalDays && done.length >= 3) {
      const g1 = daysBetween(done[done.length - 2].scheduled_date, done[done.length - 1].scheduled_date)
      const adherence = g1 / intervalDays
      if (adherence <= 1.3) score += 8
      else if (adherence >= 2) score -= 8
    }
    // How far past their own cadence they've drifted — the shared churn thresholds.
    // Measured against the series' rhythm whether or not it's still active.
    const risk = churnRisk({ hasActiveRecurring: !!recInfo, daysSinceLastService: overdueDays, cadenceDays: intervalDays ?? 0 })
    if (risk.level === 'high') { score -= 22; flags.push('at_risk') }
    else if (risk.level === 'watch') { score -= 10; flags.push('at_risk') }
    if (isLapsed({ hasRecurring: recurring, hasUpcoming: hasFuture, completedVisits: visits })) { score -= 6; flags.push('lapsed') }
    if (unpaid.count > 0) { score -= Math.min(18, unpaid.count * 6); flags.push('unpaid') }
    if (tenureDays < 60 && visits <= 1) flags.push('new')
    score = Math.max(0, Math.min(100, Math.round(score)))

    const tier: HealthTier = score >= 75 ? 'healthy' : score >= 50 ? 'watch' : 'at_risk'

    // Headline driver — decision-first.
    let reason = 'Stable customer'
    if (overdueDays != null) reason = `Overdue ${overdueDays} days vs ${intervalDays}-day cadence`
    else if (unpaid.count > 0) reason = `${unpaid.count} unpaid invoice${unpaid.count !== 1 ? 's' : ''} ($${Math.round(unpaid.amount)})`
    else if (flags.includes('lapsed')) reason = 'No upcoming visit booked'
    else if (ltv >= VIP_LTV) reason = `Top customer — $${ltv.toLocaleString()} lifetime`
    else if (recurring) reason = 'Active recurring — on track'
    else if (flags.includes('new')) reason = 'New customer'

    rows.push({
      customerId: c.id, name: c.name, score, tier, ltv, tenureDays, recurring,
      completedVisits: visits, overdueDays, intervalDays,
      unpaidCount: unpaid.count, unpaidAmount: Math.round(unpaid.amount), flags, reason,
    })
  }
  // Default order: worst health first, weighted by value (save the expensive ones).
  return rows.sort((a, b) => ((100 - b.score) * (1 + b.ltv / 1000)) - ((100 - a.score) * (1 + a.ltv / 1000)))
}

/**
 * Load + score every customer.
 *
 * Returns NULL when a load-bearing read failed — never an empty list.
 *
 * supabase-js does not throw on a dead connection: it RESOLVES with
 * { data: null, error }. Every read below used to be coerced with `|| []` and no
 * error was ever inspected, so a failed customers query scored zero customers and
 * the panel rendered a confident "nobody needs attention" — an all-clear about
 * churn, produced by a network hiccup. A failed INVOICES read was quieter and
 * worse: every customer's unpaid balance silently became $0, so the owner was
 * told nobody owed them anything.
 *
 * The distinction is the same one the portal already draws: a read that FAILED is
 * not an answer. The caller renders "couldn't load" instead of an all-clear.
 */
export async function loadCustomerHealth(supabase: SupabaseClient): Promise<HealthRow[] | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []
  const uid = user.id
  const [cRes, jRes, rRes, qRes, iRes, sRes] = await Promise.all([
    supabase.from('customers').select('id, name, created_at').eq('user_id', uid),
    supabase.from('jobs').select('customer_id, status, scheduled_date, service_type, recurrence_id, quote_id, price, is_initial_visit').eq('user_id', uid),
    supabase.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', uid),
    supabase.from('quotes').select('id, total, initial_price, weekly_price, biweekly_price, monthly_price').eq('user_id', uid),
    // amount_paid + discount so the unpaid figure is the BALANCE, via the one
    // ledger definition — not the raw ex-GST amount of a possibly-part-paid invoice.
    supabase.from('invoices').select('customer_id, status, amount, amount_paid, discount_type, discount_value').eq('user_id', uid),
    supabase.from('business_settings').select('service_seasons, gst_percent').eq('user_id', uid).maybeSingle(),
  ])
  // The four reads every score depends on. A failure in any of them changes the
  // ANSWER rather than trimming it: no customers → "all clear"; no jobs →
  // everyone lapsed; no invoices → nobody owes anything; no settings → the wrong
  // season and GST rate underneath every figure. Recurrences and quotes are
  // enrichment (cadence label, quote-derived value) and degrade honestly, so they
  // keep the tolerant `|| []`.
  if (cRes.error || jRes.error || iRes.error || sRes.error) return null

  const recurrences: Record<string, HRec> = {}
  for (const r of (rRes.data as (HRec & { id: string })[]) || []) recurrences[r.id] = r
  const quotesById: Record<string, HQuote> = {}
  for (const q of (qRes.data as HQuote[]) || []) quotesById[q.id] = q
  return computeCustomerHealth(
    (cRes.data as HCustomer[]) || [],
    (jRes.data as HJob[]) || [],
    recurrences,
    quotesById,
    (iRes.data as HInvoice[]) || [],
    settingsToSeasons((sRes.data as { service_seasons?: unknown } | null)?.service_seasons),
    localTodayISO(),
    (sRes.data as { gst_percent?: number | null } | null),
  )
}
