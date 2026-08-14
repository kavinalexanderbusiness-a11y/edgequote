// ── THE renewal queue ────────────────────────────────────────────────────────
// A REPORT, in the same sense lib/reactivation is a report: every rule it needs
// already lives in lib/signals, and it owns no threshold of its own. It reads
// plans off the recurrence engine, asks signals/renewal whether each one is due,
// and dresses the answer for a human.
//
// WHAT A RENEWAL IS HERE
//   A service plan reached the ending it was given — its end date, its visit
//   count, or the close of its season — and the next cycle is near enough to ask
//   about. That is all. It is NOT a churn score, NOT a prediction, and NOT an
//   instruction: every row carries the dated facts it was built from so the
//   owner can disagree with it.
//
// ⛔ NOTHING IN THIS FILE WRITES A SCHEDULE, and that is the point.
//   completed plan → renewal offer → the owner reviews price and scope →
//   they send a quote → the customer accepts → and only then does anyone create
//   next year's visits. The single write path is createRenewedPlan() at the
//   bottom, which refuses to run unless a real customer has accepted a real
//   quote. There is no cron, no "auto-renew" flag, and no code path from
//   "the season ended" to "26 visits appeared on the calendar".
//
// ⭐ THE PREVIOUS PLAN IS NEVER TOUCHED. A renewal creates a NEW recurrence with
//   NEW visits. Last season's rows keep their dates, prices, invoices and
//   photos exactly as they were — history is a record, not a draft. The only
//   link between old and new is quotes.renewal_of_recurrence_id, which points
//   BACKWARDS and is written once.
//
// UNIVERSAL. Nothing here knows a trade. "Plan", "cycle", "visit" and "season"
// are the only nouns; a snow contract, a pool season, a quarterly inspection
// round, a twelve-month maintenance agreement and a four-week cleaning block all
// go through the same three functions.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Customer, RecurUnit } from '@/types'
import { daysBetween, isVip, lifetimeValue, planRenewal, visitValue, type ValueRec } from '@/lib/signals'
import { createRecurringPlan, recurrenceLabel } from '@/lib/recurrence'
import { seasonLabel, settingsToSeasons, type ServiceSeason, type ServiceSeasons } from '@/lib/seasons'
import { effectiveFreq } from '@/lib/visitValue'
import { formatDate, localTodayISO } from '@/lib/utils'

type Supa = SupabaseClient

// ── Row shapes: only the columns the rules read ──────────────────────────────
export interface RnJob {
  id: string
  customer_id: string | null
  recurrence_id: string | null
  property_id: string | null
  scheduled_date: string
  status: string
  service_type: string | null
  title: string | null
  quote_id: string | null
  price: number | null
  crew_size: number | null
  duration_minutes: number | null
  is_initial_visit?: boolean | null
}
export interface RnRecurrence {
  id: string
  customer_id: string | null
  freq: string | null
  interval_unit: string | null
  interval_count: number | null
  start_date: string
  end_date: string | null
  end_count: number | null
}
export interface RnQuote {
  id: string
  quote_number: string
  customer_id: string | null
  status: string
  total: number | null
  created_at: string
  sent_at: string | null
  valid_until: string | null
  service_type: string
  initial_price: number | null
  weekly_price: number | null
  biweekly_price: number | null
  monthly_price: number | null
  renewal_of_recurrence_id: string | null
}

/** Where the renewal offer for a plan has got to. Derived from the quote the
 *  owner sent — never stored on the plan, so there is no second lifecycle to
 *  keep in step (the same choice lib/quoteStatus made for 'expired'). */
export type RenewalStage =
  | 'due'       // nothing offered yet — the owner has not looked at this
  | 'drafted'   // a renewal quote exists but was never sent
  | 'sent'      // out with the customer, awaiting their answer
  | 'expired'   // sent, and its own valid-until date has passed
  | 'accepted'  // ⭐ they said yes — this is the ONLY state that may create a plan
  | 'declined'  // they said no. An answer, not an opportunity.
  | 'planned'   // the renewed plan exists. Finished business.

export interface RenewalQuoteRef {
  id: string
  number: string
  total: number
  stage: RenewalStage
  /** The date that stage happened, for the "sent 6 days ago" line. */
  at: string | null
}

export interface RenewalOpportunity<C = Customer> {
  /** Stable across loads — the plan being renewed, not the row's position. */
  key: string
  customer: C
  recurrenceId: string
  propertyId: string | null
  /** What they used to buy, in the owner's own words (the visits' service type). */
  serviceName: string
  cadenceLabel: string
  planStart: string
  planEnd: string
  /** Set only when a season gave the plan its ending. */
  seasonWindow: string | null
  servedVisits: number
  lastServedDate: string | null
  perVisit: number
  /** What the plan just delivered — visits × per-visit. Last cycle's money, a
   *  fact, never a forecast of the next one. */
  cycleValue: number
  lifetimeRevenue: number
  isVip: boolean
  stage: RenewalStage
  /** 'ending' — still running, its end in sight. 'ended' — its last visit has been. */
  phase: 'ending' | 'ended'
  nextCycleStart: string
  /** Where the RENEWED plan would end — the next season's close, or the same
   *  term length again. A proposal shown to the owner before anything is
   *  created, and overridable at the moment of creation. null = open-ended. */
  renewedEndDate: string | null
  daysToNextCycle: number
  /** One line, ≤ ~60 chars: why this is on the list TODAY. Mobile shows this. */
  reason: string
  /** The dated facts behind the reason. Nothing here is inferred or scored. */
  evidence: string[]
  quote: RenewalQuoteRef | null
}

export interface RenewalReport<C = Customer> {
  /** Everything worth the owner's attention, most actionable first. */
  opportunities: RenewalOpportunity<C>[]
  /** Waiting on the OWNER (due / drafted / accepted) — the badge-worthy number.
   *  A quote sitting with the customer is not something to do. */
  actionable: number
  /** Last cycle's value of every plan on the list. What is being decided. */
  valueAtStake: number
}

export interface RenewalInputRows<C extends { id: string } = Customer> {
  customers: C[]
  jobs: RnJob[]
  quotes: RnQuote[]
  recurrences: RnRecurrence[]
  seasons: ServiceSeasons
  today: string
}

const LIVE_FUTURE = (j: RnJob, today: string) =>
  j.scheduled_date >= today && (j.status === 'scheduled' || j.status === 'in_progress')

/** Quote status → where the renewal offer stands. `validUntil` supplies the one
 *  overlay quotes already have: a sent quote past its date is expired, and
 *  expired means "re-send", not "waiting". */
export function renewalStageFor(status: string, validUntil: string | null, today: string): RenewalStage {
  if (status === 'declined') return 'declined'
  if (status === 'accepted') return 'accepted'
  if (status === 'scheduled' || status === 'completed' || status === 'paid') return 'planned'
  if (status === 'sent') return validUntil && validUntil < today ? 'expired' : 'sent'
  return 'drafted'
}

/** Stages that still leave a renewal on the queue. `declined` and `planned` are
 *  ANSWERS — the customer said no, or the work exists — and an answered question
 *  must stop being asked, or the queue becomes a list the owner learns to skip. */
const OPEN_STAGES: RenewalStage[] = ['due', 'drafted', 'sent', 'expired', 'accepted']

/** Waiting on the owner. 'sent' and 'expired' are waiting on the customer —
 *  except that an expired one IS the owner's move again, so it counts. */
const OWNER_STAGES: RenewalStage[] = ['due', 'drafted', 'expired', 'accepted']

// Most actionable first: a yes to act on, then a draft to finish, then an offer
// to make, then a lapsed one to re-send, and last the ones already with the
// customer. Within a stage: VIPs, then the bigger plan.
const STAGE_ORDER: Record<RenewalStage, number> = {
  accepted: 0, drafted: 1, due: 2, expired: 3, sent: 4, declined: 5, planned: 6,
}

export function computeRenewals<C extends { id: string } = Customer>(
  input: RenewalInputRows<C>,
): RenewalReport<C> {
  const { customers, jobs, quotes, recurrences, seasons, today } = input

  const customerById = new Map<string, C>()
  for (const c of customers) customerById.set(c.id, c)

  const quotesById: Record<string, RnQuote> = {}
  for (const q of quotes) quotesById[q.id] = q
  const recById: Record<string, ValueRec> = {}
  for (const r of recurrences) recById[r.id] = r

  // Renewal offers, newest per plan. Only ever read by recurrence id — a quote
  // that merely happens to be for the same customer is somebody else's quote.
  const offerByPlan = new Map<string, RnQuote>()
  for (const q of quotes) {
    if (!q.renewal_of_recurrence_id) continue
    const prev = offerByPlan.get(q.renewal_of_recurrence_id)
    if (!prev || q.created_at > prev.created_at) offerByPlan.set(q.renewal_of_recurrence_id, q)
  }

  const seriesByRec = new Map<string, RnJob[]>()
  const jobsByCustomer = new Map<string, RnJob[]>()
  for (const j of jobs) {
    if (j.recurrence_id) {
      const list = seriesByRec.get(j.recurrence_id)
      if (list) list.push(j); else seriesByRec.set(j.recurrence_id, [j])
    }
    if (j.customer_id) {
      const list = jobsByCustomer.get(j.customer_id)
      if (list) list.push(j); else jobsByCustomer.set(j.customer_id, [j])
    }
  }

  const out: RenewalOpportunity<C>[] = []

  for (const r of recurrences) {
    const series = seriesByRec.get(r.id) || []
    if (series.length === 0) continue

    // A plan belongs to whoever its visits are for; the recurrence's own
    // customer_id is nullable and, on older rows, unset.
    const customerId = r.customer_id || series.find(j => j.customer_id)?.customer_id || null
    const customer = customerId ? customerById.get(customerId) : undefined
    if (!customer) continue // archived, deleted, or another tenant's — never surface it

    const live = series.filter(j => j.status !== 'cancelled')
    if (live.length === 0) continue // wholly cancelled: nothing was ever a plan here
    const completed = series.filter(j => j.status === 'completed').sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))
    const sample = live.find(j => j.service_type) || live[0]
    const serviceName = sample.service_type || sample.title || 'Recurring service'
    const freq = effectiveFreq(r.freq, r.interval_unit, r.interval_count)

    // ⭐ ONE resolver, shared with lib/reactivation. Whether this plan was given
    // an ending, when its next cycle starts and how long that cycle is are
    // judgement calls, and two engines making them separately is precisely how
    // one customer ends up described two ways on two screens.
    const plan = planRenewal({
      planStart: r.start_date,
      liveDates: live.map(j => j.scheduled_date),
      cancelledDates: series.filter(j => j.status === 'cancelled').map(j => j.scheduled_date),
      completedCount: completed.length,
      endDate: r.end_date,
      endCount: r.end_count,
      serviceType: serviceName,
      cadence: freq,
      interval: r,
      customerHasFutureVisit: (jobsByCustomer.get(customerId!) || []).some(j => LIVE_FUTURE(j, today)),
    }, seasons, today)
    if (!plan) continue
    const { signal, season, planEnd } = plan
    const planStart = r.start_date || [...live.map(j => j.scheduled_date)].sort()[0]

    const offer = offerByPlan.get(r.id) || null
    const stage: RenewalStage = offer ? renewalStageFor(offer.status, offer.valid_until, today) : 'due'
    const offerDate = offer
      ? (stage === 'drafted' ? offer.created_at.slice(0, 10) : (offer.sent_at?.slice(0, 10) ?? offer.created_at.slice(0, 10)))
      : null

    // An offer already in flight keeps the plan on the queue even outside the
    // window — the owner needs to see the answer to a question they asked, and
    // a sent quote that drops off the list on a date boundary is a quote nobody
    // ever follows up. `due` rows must earn their place through the signal.
    const keep = stage === 'due' ? signal.isDue : OPEN_STAGES.includes(stage)
    if (!keep) continue

    const valueOf = (j: RnJob) => visitValue(
      { price: j.price, quote_id: j.quote_id, recurrence_id: j.recurrence_id, is_initial_visit: !!j.is_initial_visit },
      quotesById as unknown as Record<string, Record<string, unknown>>,
      recById,
    )
    // Per-visit at stake = an ORDINARY visit of the plan, never the anchor: a
    // first visit often carries a setup price that no later visit repeats, and
    // quoting it here would overstate every renewal by that difference.
    const ordinary = live.find(j => !j.is_initial_visit) || live[0]
    const perVisit = Math.round(valueOf(ordinary))
    const lifetimeRevenue = lifetimeValue(
      (jobsByCustomer.get(customerId!) || [])
        .filter(j => j.status === 'completed')
        .map(j => ({ price: j.price, quote_id: j.quote_id, recurrence_id: j.recurrence_id, is_initial_visit: !!j.is_initial_visit })),
      quotesById as unknown as Record<string, Record<string, unknown>>,
      recById,
    )

    out.push({
      key: `renewal:${r.id}`,
      customer,
      recurrenceId: r.id,
      propertyId: sample.property_id ?? null,
      serviceName,
      cadenceLabel: recurrenceLabel((r.interval_unit as RecurUnit | null), r.interval_count, r.freq),
      planStart,
      planEnd,
      seasonWindow: season && plan.endedBySeason ? seasonLabel(season) : null,
      servedVisits: completed.length,
      lastServedDate: completed.length ? completed[completed.length - 1].scheduled_date : null,
      perVisit,
      cycleValue: perVisit * live.length,
      lifetimeRevenue,
      isVip: isVip(lifetimeRevenue),
      stage,
      phase: signal.stage ?? (today > planEnd ? 'ended' : 'ending'),
      nextCycleStart: plan.nextCycleStart,
      renewedEndDate: plan.renewedEndDate,
      daysToNextCycle: signal.daysToNextCycle ?? daysBetween(today, plan.nextCycleStart),
      reason: renewalReason({
        stage, endedBySeason: plan.endedBySeason, endedByCount: plan.endedByCount, planEnd,
        nextCycleStart: plan.nextCycleStart, today, offerDate,
      }),
      evidence: renewalEvidence({
        completed: completed.length, planStart, planEnd, season,
        endedByCount: plan.endedByCount, endedBySeason: plan.endedBySeason, hasEndDate: !!r.end_date,
        nextCycleStart: plan.nextCycleStart, offer, stage,
      }),
      quote: offer
        ? { id: offer.id, number: offer.quote_number, total: Number(offer.total) || 0, stage, at: offerDate }
        : null,
    })
  }

  out.sort((a, b) =>
    STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage]
    || Number(b.isVip) - Number(a.isVip)
    || b.cycleValue - a.cycleValue
    || a.daysToNextCycle - b.daysToNextCycle)

  return {
    opportunities: out,
    actionable: out.filter(o => OWNER_STAGES.includes(o.stage)).length,
    valueAtStake: out.reduce((s, o) => s + o.cycleValue, 0),
  }
}

// One line the mobile queue can show whole. States the FACT that put the row
// here — never a prediction, never a score.
function renewalReason(a: {
  stage: RenewalStage; endedBySeason: boolean; endedByCount: boolean
  planEnd: string; nextCycleStart: string; today: string; offerDate: string | null
}): string {
  if (a.stage === 'accepted') return 'They accepted — create the plan'
  if (a.stage === 'drafted') return 'Renewal quote drafted, not sent yet'
  if (a.stage === 'sent') return `Renewal sent ${formatDate(a.offerDate ?? a.today)} — awaiting their reply`
  if (a.stage === 'expired') return 'Renewal quote expired — send it again'
  const days = daysBetween(a.today, a.nextCycleStart)
  // "The season ended" only when the SEASON is what ended it. A short block that
  // happened to sit inside a season ended on its own date, and saying otherwise
  // would point the owner at next April for work they could re-book this week.
  if (a.endedBySeason) {
    return a.today > a.planEnd
      ? `Season ended ${formatDate(a.planEnd)} · next starts in ${days}d`
      : `Season ends ${formatDate(a.planEnd)} · nothing booked after`
  }
  if (a.endedByCount) return `All booked visits delivered · ended ${formatDate(a.planEnd)}`
  return a.today > a.planEnd
    ? `Plan ended ${formatDate(a.planEnd)} · nothing booked after`
    : `Plan ends ${formatDate(a.planEnd)} · ${daysBetween(a.today, a.planEnd)}d left`
}

// The dated facts. Every line is something the owner could go and check.
function renewalEvidence(a: {
  completed: number; planStart: string; planEnd: string; season: ServiceSeason | null
  endedByCount: boolean; endedBySeason: boolean; hasEndDate: boolean
  nextCycleStart: string; offer: RnQuote | null; stage: RenewalStage
}): string[] {
  const e: string[] = []
  e.push(`${a.completed} visit${a.completed !== 1 ? 's' : ''} delivered, ${formatDate(a.planStart)} → ${formatDate(a.planEnd)}`)
  if (a.endedBySeason && a.season) e.push(`Ended with the ${seasonLabel(a.season)} season, as planned`)
  else if (a.endedByCount) e.push('Ended after the number of visits it was booked for')
  else if (a.hasEndDate) e.push(`Ended on its own end date, ${formatDate(a.planEnd)}`)
  e.push(`Next cycle would start ${formatDate(a.nextCycleStart)}`)
  if (a.offer) e.push(`Renewal quote ${a.offer.quote_number} is ${a.stage}`)
  else e.push('Nothing booked after this plan, and no renewal offered yet')
  return e
}

// ── Loader ───────────────────────────────────────────────────────────────────
// A failed read is not an answer. supabase-js RESOLVES with { data: null, error }
// on a dead connection, so `|| []` turns a network blip into "no plans need
// renewing" — a confident all-clear about next year's revenue, manufactured by a
// dropped socket. There is no `report` field on the failure branch, so a caller
// cannot render an empty queue from one.
export type RenewalLoad<C = Customer> =
  | { ok: true; report: RenewalReport<C> }
  | { ok: false; error: string }

export async function loadRenewals(sb: Supa): Promise<RenewalLoad> {
  const { data: { session } } = await sb.auth.getSession()
  const user = session?.user
  if (!user) return { ok: false, error: 'Not signed in' }

  const [cRes, jRes, qRes, rRes, sRes] = await Promise.all([
    // Archived customers are a decision too — never suggest renewing them.
    sb.from('customers').select('*').eq('user_id', user.id).is('archived_at', null),
    sb.from('jobs').select('id, customer_id, recurrence_id, property_id, scheduled_date, status, service_type, title, quote_id, price, crew_size, duration_minutes, is_initial_visit').eq('user_id', user.id),
    sb.from('quotes').select('id, quote_number, customer_id, status, total, created_at, sent_at, valid_until, service_type, initial_price, weekly_price, biweekly_price, monthly_price, renewal_of_recurrence_id').eq('user_id', user.id),
    sb.from('job_recurrences').select('id, customer_id, freq, interval_unit, interval_count, start_date, end_date, end_count').eq('user_id', user.id),
    sb.from('business_settings').select('service_seasons').eq('user_id', user.id).maybeSingle(),
  ])

  // Every one of these changes the ANSWER rather than trimming it. No plans →
  // "nothing to renew"; no jobs → every plan looks unserved; no quotes → offers
  // already sent read as never made, and the owner sends a second one; no
  // seasons → the wrong season underneath every date on the page.
  const failed = [cRes, jRes, qRes, rRes, sRes].find(r => r.error)
  if (failed?.error) return { ok: false, error: failed.error.message }

  return {
    ok: true,
    report: computeRenewals({
      customers: (cRes.data as Customer[]) || [],
      jobs: (jRes.data as RnJob[]) || [],
      quotes: (qRes.data as RnQuote[]) || [],
      recurrences: (rRes.data as RnRecurrence[]) || [],
      seasons: settingsToSeasons((sRes.data as { service_seasons: unknown } | null)?.service_seasons),
      today: localTodayISO(),
    }),
  }
}

// ── Step 1 of 4: hand the previous plan to the quote builder ─────────────────
// The renewal REVIEW is the quote builder. There is no second pricing screen and
// no renewal-specific form: the owner opens the door they already know, with last
// cycle's service, cadence and price sitting in the fields, and changes whatever
// they want to change. That is what "the owner reviews price and scope" means —
// an editable quote, not a confirmation dialog over a number we chose.
//
// The plan ID travels in the URL and the convenience prefill travels in
// sessionStorage, deliberately split by what it costs to lose. The link
// (renewal_of_recurrence_id) is load-bearing — lose it and the renewal is an
// ordinary quote that never closes its own queue row — so it rides in the address
// bar where a refresh, a back-nav and a re-open all keep it. The pre-filled
// numbers are a convenience; if they are lost the owner types them, which is
// exactly what they did before this feature existed.
export const RENEWAL_PREFILL_KEY = 'eq_renewal_prefill'

export interface RenewalPrefillPayload {
  recurrenceId: string
  customerId: string
  customerName: string
  propertyId: string | null
  serviceName: string
  /** Which cadence field to seed. null = a cadence with no standard price column,
   *  so the per-visit figure goes in as the one-time price and the owner decides. */
  cadence: 'weekly' | 'biweekly' | 'monthly' | null
  cadenceLabel: string
  perVisit: number
  previousVisits: number
  previousWindow: string
  nextCycleStart: string
}

/** The door. `?customer=` (and `?property=`) is the standing prefill contract
 *  every quote door honours; `?renew=` is what makes this one a renewal. */
export function renewalQuoteHref(o: RenewalOpportunity): string {
  const p = new URLSearchParams({ customer: o.customer.id, renew: o.recurrenceId })
  if (o.propertyId) p.set('property', o.propertyId)
  return `/dashboard/quotes/new?${p.toString()}`
}

export function renewalPrefillFor(o: RenewalOpportunity): RenewalPrefillPayload {
  const freq = cadenceOf(o.cadenceLabel)
  return {
    recurrenceId: o.recurrenceId,
    customerId: o.customer.id,
    customerName: o.customer.name,
    propertyId: o.propertyId,
    serviceName: o.serviceName,
    cadence: freq,
    cadenceLabel: o.cadenceLabel,
    perVisit: o.perVisit,
    previousVisits: o.servedVisits,
    previousWindow: `${formatDate(o.planStart)} → ${formatDate(o.planEnd)}`,
    nextCycleStart: o.nextCycleStart,
  }
}

function cadenceOf(label: string): 'weekly' | 'biweekly' | 'monthly' | null {
  if (label === 'Weekly') return 'weekly'
  if (label === 'Every 2 weeks') return 'biweekly'
  if (label === 'Monthly') return 'monthly'
  return null
}

export function stashRenewalPrefill(o: RenewalOpportunity): void {
  if (typeof window === 'undefined') return
  try { window.sessionStorage.setItem(RENEWAL_PREFILL_KEY, JSON.stringify(renewalPrefillFor(o))) } catch { /* private mode — the URL still carries the link */ }
}

/** Read WITHOUT consuming. A destructive read means a refresh mid-build silently
 *  drops the prefill — the trap the lead handoff already had to be fixed for. */
export function readRenewalPrefill(): RenewalPrefillPayload | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(RENEWAL_PREFILL_KEY)
    return raw ? JSON.parse(raw) as RenewalPrefillPayload : null
  } catch { return null }
}

export function clearRenewalPrefill(): void {
  if (typeof window === 'undefined') return
  try { window.sessionStorage.removeItem(RENEWAL_PREFILL_KEY) } catch { /* nothing to clear */ }
}

// ── Step 4 of 4: the ONLY way a renewal becomes a schedule ───────────────────
// Steps 2 and 3 are the owner sending the quote and the customer accepting it,
// and both already have engines. This is what happens after the yes.
//
// ⭐ IT REFUSES WITHOUT THE YES. The accepted status is re-read from the database
// here rather than trusted from the caller's props, because the props are a
// snapshot from page load and the question being asked — "did this customer
// agree to this?" — is the one question a stale snapshot must never answer.
//
// ⭐ THE PREVIOUS PLAN IS NOT TOUCHED. Not its rows, not its dates, not its end
// date, not its visits. A renewal is a new plan; last season stays exactly as it
// was delivered and invoiced.
export interface RenewedPlanResult {
  ok: boolean
  error?: string
  count?: number
  recurrenceId?: string
}

export async function createRenewedPlan(
  sb: Supa,
  o: RenewalOpportunity,
  opts?: { startDate?: string; endDate?: string | null },
): Promise<RenewedPlanResult> {
  if (!o.quote) return { ok: false, error: 'No renewal quote — send one and let the customer accept it first.' }

  // Re-read the quote. Its status is the customer's consent, and consent is not
  // something to take from a page that loaded ten minutes ago.
  const { data: fresh, error: qErr } = await sb
    .from('quotes')
    .select('id, status, customer_id, service_type, initial_price, weekly_price, biweekly_price, monthly_price, hours, crew_size, renewal_of_recurrence_id')
    .eq('id', o.quote.id)
    .maybeSingle()
  if (qErr) return { ok: false, error: `Could not check the renewal quote: ${qErr.message}` }
  if (!fresh) return { ok: false, error: 'That renewal quote no longer exists.' }

  const q = fresh as {
    id: string; status: string; customer_id: string | null; service_type: string
    initial_price: number | null; weekly_price: number | null; biweekly_price: number | null
    monthly_price: number | null; hours: number | null; crew_size: number | null
    renewal_of_recurrence_id: string | null
  }
  if (q.status !== 'accepted') {
    return { ok: false, error: `That quote is ${q.status}, not accepted. A plan is only created once the customer accepts.` }
  }
  // The quote must be THIS plan's renewal. Guards against a stale row and against
  // a caller pairing an unrelated accepted quote with a plan.
  if (q.renewal_of_recurrence_id !== o.recurrenceId) {
    return { ok: false, error: 'That quote is not the renewal of this plan.' }
  }

  const cadence = cadenceOf(o.cadenceLabel)
  const interval: { unit: 'week' | 'month' | 'day'; count: number } =
    cadence === 'weekly' ? { unit: 'week', count: 1 }
    : cadence === 'biweekly' ? { unit: 'week', count: 2 }
    : cadence === 'monthly' ? { unit: 'month', count: 1 }
    : { unit: 'week', count: 1 }

  const startDate = opts?.startDate ?? o.nextCycleStart
  const endDate = opts?.endDate !== undefined ? opts.endDate : o.renewedEndDate ?? null

  const res = await createRecurringPlan(sb, {
    customerId: o.customer.id,
    propertyId: o.propertyId,
    serviceType: q.service_type || o.serviceName,
    title: `${q.service_type || o.serviceName} — ${o.customer.name}`,
    // NULL, with the quote linked: every visit derives the accepted cadence
    // price from the quote, so there is ONE money path and a later price edit on
    // the quote reaches the whole season. Writing a number here would freeze
    // today's figure onto rows nobody would think to re-check.
    perVisitPrice: null,
    quoteId: q.id,
    intervalUnit: interval.unit,
    intervalCount: interval.count,
    startDate,
    endDate,
    crewSize: Number(q.crew_size) > 0 ? Number(q.crew_size) : 1,
    durationMinutes: Number(q.hours) > 0 ? Math.round(Number(q.hours) * 60) : null,
  })
  if (!res.ok) return res

  // The quote now has work on the calendar. Same accepted → scheduled transition
  // scheduleQuoteAsJob makes, so a renewal quote reads like every other won one.
  // A failure here is reported, never hidden: the plan exists either way, and an
  // owner told "done" about a half-write is how ghost state is born.
  const { error: sErr } = await sb.from('quotes').update({ status: 'scheduled' }).eq('id', q.id)
  if (sErr) {
    return { ...res, error: `${res.count} visits created — but quote ${o.quote.number} still reads accepted. Open it and mark it scheduled.` }
  }
  return res
}
