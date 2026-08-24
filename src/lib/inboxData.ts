// ── The Owner Inbox loader ───────────────────────────────────────────────────
// lib/inbox.ts is pure; this is the ONE place that knows which tables the
// inbox's sources come from. Engine · loader · UI — the same split as
// dayFit / dayFitLoad and timeline / timelineData.
//
// ══ FAILURE HONESTY ══════════════════════════════════════════════════════════
// The dashboard loader is all-or-throw (one failed read takes the morning to
// the error screen). The inbox deliberately is NOT: it is a composition of
// FIVE independent sources, and four of them still being readable is four
// answers the owner should get. Each source resolves to
// {ok:true,rows}|{ok:false,error}; the engine turns ok:false into a named line
// in the degraded banner and refuses to say "all clear". A failed read is an
// answer — it is never an empty list.
//
// ══ TENANCY ══════════════════════════════════════════════════════════════════
// Every read is `.eq('user_id', userId)` on RLS own-row tables — explicit, so
// this loader stays correct the day a caller hands it a service-role client.
//
// ══ QUERY BUDGET ═════════════════════════════════════════════════════════════
// All sources load in ONE Promise.all (no waterfalls). Standalone
// (loadOwnerInbox): ~10 core reads + ~12 source reads, every one bounded —
// windowed, limited, or a single row. The dashboard adds only loadInboxSources
// (~12) to its existing batch. Nothing here scans unbounded history: the
// notification window is LIMITed, crew messages are a 14-day window, the day
// plan is a 7-day horizon, and the learning read is capped by its own engine.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Quote } from '@/types'
import { localTodayISO } from '@/lib/utils'
import { pageAll } from '@/lib/supabase/pageAll'
import { computeLeadsNeedingResponse, type LeadConvRow, type LeadQuoteRow } from '@/lib/leadResponse'
import { computePriorities, type Priority, type PriorityInvoice } from '@/lib/dashboard/priorities'
import { QUOTE_COLUMNS } from '@/lib/dashboard/data'
import { openRequests } from '@/lib/portalRequests'
import { settingsToSeasons } from '@/lib/seasons'
import { loadOwnerUnread } from '@/lib/crewMessages'
import { loadDayFitContext } from '@/lib/dayFitLoad'
import { planDay, type DayPlanStopInput } from '@/lib/dayPlan'
import type { ReachCustomer } from '@/lib/comms/reach'
import type { RJob, RRecurrence } from '@/lib/reactivation'
import type { AppNotification } from '@/components/notifications/NotificationBell'
import {
  composeInbox, type ChangeOrderRow, type CrewUnreadRow, type DayPlanRow,
  type InboxResult, type InboxSources, type SourceResult,
} from '@/lib/inbox'

/** How far ahead the inbox checks that booked days can actually run. */
export const INBOX_DAYPLAN_HORIZON_DAYS = 7
/** How far back a crew message can still be "unread" here before it is stale
 *  enough that the schedule board (which has no window) is the honest surface. */
export const CREW_UNREAD_WINDOW_DAYS = 14
/** Newest notifications considered. Bounded like the bell page's own read. */
const NOTIFICATIONS_LIMIT = 200

const fail = <T,>(error: unknown): SourceResult<T> =>
  ({ ok: false, error: error instanceof Error ? error.message : String(error ?? 'unknown') })

// ── The four event/derived sources beyond the Session-13 queue ───────────────
// Self-contained on purpose: the dashboard calls this beside its own batch, the
// inbox page calls it beside loadWorkSource — neither has to know what feeds it.
export async function loadInboxSources(
  sb: SupabaseClient, userId: string, todayISO: string,
): Promise<Omit<InboxSources, 'work'>> {
  if (!userId) {
    const e = { ok: false as const, error: 'not_signed_in' }
    return { changeOrders: e, crew: e, dayPlan: e, events: e }
  }

  const [events, changeOrders, crew, dayPlan] = await Promise.all([
    loadEvents(sb, userId),
    loadChangeOrders(sb, userId),
    loadCrewUnread(sb, userId),
    loadDayConflicts(sb, userId, todayISO),
  ])
  return { events, changeOrders, crew, dayPlan }
}

async function loadEvents(sb: SupabaseClient, userId: string): Promise<SourceResult<AppNotification>> {
  // Same columns and same active-set predicate as the notifications page —
  // snoozed rows ARE loaded (the engine sorts them into `snoozedEvents`; an
  // active snooze is a state to show collapsed, not a row to forget).
  const { data, error } = await sb.from('notifications')
    .select('id, created_at, type, title, body, href, read, snoozed_until, archived_at')
    .eq('user_id', userId)
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(NOTIFICATIONS_LIMIT)
  if (error) return fail(error.message)
  return { ok: true, rows: (data as AppNotification[]) ?? [] }
}

async function loadChangeOrders(sb: SupabaseClient, userId: string): Promise<SourceResult<ChangeOrderRow>> {
  // Drafts only — the one change-order state that is the OWNER's move (see the
  // engine's comment). The status filter is duplicated engine-side so a broken
  // query here cannot widen what renders.
  const { data, error } = await sb.from('change_orders')
    .select('id, job_id, status, co_number, amount, created_at, customers(name)')
    .eq('user_id', userId)
    .eq('status', 'draft')
    .order('created_at', { ascending: true })
    .limit(100)
  if (error) return fail(error.message)
  type Row = {
    id: string; job_id: string; status: string; co_number: string | null
    amount: number | null; created_at: string
    customers: { name: string | null } | { name: string | null }[] | null
  }
  return {
    ok: true,
    rows: ((data as Row[]) ?? []).map(r => {
      const c = Array.isArray(r.customers) ? r.customers[0] ?? null : r.customers
      return {
        id: r.id, jobId: r.job_id, status: r.status,
        coNumber: r.co_number, amount: Number(r.amount || 0),
        customerName: c?.name ?? null, createdAt: r.created_at,
      }
    }),
  }
}

async function loadCrewUnread(sb: SupabaseClient, userId: string): Promise<SourceResult<CrewUnreadRow>> {
  // Which visits have RECENT crew words at all — a cheap windowed candidate
  // read. The actual unread derivation is loadOwnerUnread's (THE shared
  // sentence: a person's words, newer than the owner's high-water mark), so
  // this loader can never disagree with the schedule board's badges.
  const cutoff = new Date(Date.now() - CREW_UNREAD_WINDOW_DAYS * 86_400_000).toISOString()
  const cand = await sb.from('crew_messages')
    .select('job_id, created_by, author_kind')
    .eq('user_id', userId)
    .gte('created_at', cutoff)
  if (cand.error) return fail(cand.error.message)

  const jobIds = [...new Set(
    ((cand.data as { job_id: string; created_by: string | null; author_kind: string }[]) ?? [])
      // Pre-filter only to avoid pointless follow-up reads; the real unread
      // rule lives in loadOwnerUnread and is applied below regardless.
      .filter(m => m.created_by !== userId && m.author_kind !== 'system')
      .map(m => m.job_id),
  )]
  if (jobIds.length === 0) return { ok: true, rows: [] }

  const unread = await loadOwnerUnread(sb, userId, jobIds)
  const withUnread = Object.entries(unread).filter(([, n]) => n > 0)
  if (withUnread.length === 0) return { ok: true, rows: [] }

  const info = await sb.from('jobs')
    .select('id, title, scheduled_date, customers(name)')
    .eq('user_id', userId)
    .in('id', withUnread.map(([id]) => id))
  if (info.error) return fail(info.error.message)
  type JRow = { id: string; title: string | null; scheduled_date: string | null; customers: { name: string | null } | { name: string | null }[] | null }
  const byId = new Map(((info.data as JRow[]) ?? []).map(j => [j.id, j]))
  return {
    ok: true,
    rows: withUnread.map(([jobId, n]) => {
      const j = byId.get(jobId)
      const c = j ? (Array.isArray(j.customers) ? j.customers[0] ?? null : j.customers) : null
      return {
        jobId, unread: n,
        title: j?.title ?? null,
        customerName: c?.name ?? null,
        scheduledDate: j?.scheduled_date ?? null,
      }
    }),
  }
}

async function loadDayConflicts(
  sb: SupabaseClient, userId: string, todayISO: string,
): Promise<SourceResult<DayPlanRow>> {
  // THE fit context (lib/dayFitLoad): committed visits, capacity, workforce
  // minus time off, learned durations — the same inputs the schedule's
  // suggester trusts. Then planDay — THE Session-60 realism engine — judges
  // each day; this loader adds no arithmetic of its own.
  const [fit, setRes] = await Promise.all([
    loadDayFitContext(sb, userId, { fromISO: todayISO, horizonDays: INBOX_DAYPLAN_HORIZON_DAYS }),
    // work_start_time is the one planDay input the fit context doesn't carry.
    sb.from('business_settings').select('work_start_time').eq('user_id', userId).maybeSingle(),
  ])
  if (fit.outcome === 'unavailable') return fail(fit.reason)
  if (setRes.error) return fail(setRes.error.message)
  const startTime = (setRes.data as { work_start_time: string | null } | null)?.work_start_time || '08:00'

  const rows: DayPlanRow[] = []
  for (const date of fit.ctx.horizonDates) {
    const visits = fit.ctx.visitsByDate[date] || []
    if (visits.length === 0) continue
    // No coordinates here on purpose: the blocking verdicts (day blocked, crew
    // short, labour over) are capacity questions, and travel falls back to the
    // same per-stop allowance the calendar bar charges. Route-quality caveats
    // (unlocated stops, no base) are emitted and then filtered by severity in
    // the engine — the schedule board is where that nuance lives.
    const stops: DayPlanStopInput[] = visits.map((v, idx) => ({
      jobId: `${date}#${idx}`,
      durationMinutes: v.duration_minutes,
      crewSize: v.crew_size,
      serviceType: v.service_type,
      status: v.status,
      located: false,
    }))
    const plan = planDay({
      stops,
      startTime,
      capacityHours: fit.ctx.capacityHours,
      workers: fit.ctx.workersByDate(date),
      learnedFor: fit.ctx.learnedFor,
      hasBase: false,
    })
    rows.push({ date, stops: plan.stopCount, warnings: plan.warnings })
  }
  return { ok: true, rows }
}

// ── The Session-13 queue as an inbox source ──────────────────────────────────
// The same reads and the same assembly as THE dashboard loader (whose copy is
// pinned by verify:priority-queue §9), feeding the same engines — deliberately
// duplicated the way lib/pipelineData duplicates it, so this page loads without
// the dashboard's money/month baggage. If a column is added there, QUOTE_COLUMNS
// is shared and the guard pins the engine calls here.
export async function loadWorkSource(
  sb: SupabaseClient, userId: string, todayISO: string,
): Promise<SourceResult<Priority>> {
  if (!userId) return { ok: false, error: 'not_signed_in' }
  try {
    const [invRes, jobRes, quoteRes, recRes, convRes, custRes, reqRes, setRes, depositRes] = await Promise.all([
      pageAll<PriorityInvoice>(() => sb.from('invoices')
        .select('id, amount, status, amount_paid, discount_type, discount_value, due_date, invoice_number, customer_name, viewed_at')
        .eq('user_id', userId)),
      pageAll<RJob>(() => sb.from('jobs')
        .select('id, quote_id, customer_id, status, scheduled_date, recurrence_id, price, service_type')
        .eq('user_id', userId)),
      pageAll<Quote>(() => sb.from('quotes').select(QUOTE_COLUMNS).eq('user_id', userId)),
      sb.from('job_recurrences').select('id, freq, interval_unit, interval_count, start_date, end_date, end_count').eq('user_id', userId),
      sb.from('conversations')
        .select('id, customer_id, unread, lead_status, last_direction, last_message_at, created_at, snoozed_until, customers(name)')
        .eq('user_id', userId).is('archived_at', null),
      sb.from('customers').select('id, phone, email, sms_opt_in, email_opt_in, message_prefs').eq('user_id', userId).is('archived_at', null),
      sb.from('service_requests').select('id, customer_id, from_portal, status')
        .eq('user_id', userId).eq('from_portal', true).eq('status', 'new'),
      sb.from('business_settings').select('gst_percent, service_seasons').eq('user_id', userId).maybeSingle(),
      sb.from('payments').select('quote_id, amount, kind, provider, status')
        .eq('user_id', userId).not('quote_id', 'is', null),
    ])

    // One failed read fails the WHOLE work source: computePriorities over a
    // partial book would confidently omit the very row the outage hid ("no
    // unpaid invoices" because invoices didn't load). The other four sources
    // still render; this one reports itself in the banner.
    const failure =
      invRes.error ? `invoices: ${invRes.error}`
      : jobRes.error ? `jobs: ${jobRes.error}`
      : quoteRes.error ? `quotes: ${quoteRes.error}`
      : recRes.error ? `recurrences: ${recRes.error.message}`
      : convRes.error ? `conversations: ${convRes.error.message}`
      : custRes.error ? `customers: ${custRes.error.message}`
      : reqRes.error ? `requests: ${reqRes.error.message}`
      : setRes.error ? `settings: ${setRes.error.message}`
      : depositRes.error ? `deposits: ${depositRes.error.message}`
      : null
    if (failure) return { ok: false, error: failure }

    const recById: Record<string, RRecurrence> = {}
    for (const r of (recRes.data as RRecurrence[]) || []) recById[r.id] = r
    const conversations = (convRes.data as unknown as (LeadConvRow & { unread: number })[]) || []
    const settings = setRes.data as { gst_percent: number | null; service_seasons: unknown } | null
    const quoteDepositRows: Record<string, { amount: number; kind?: string | null; provider?: string | null; status?: string | null }[]> = {}
    for (const r of (depositRes.data as { quote_id: string | null; amount: number; kind: string | null; provider: string | null; status: string | null }[]) || []) {
      if (r.quote_id) (quoteDepositRows[r.quote_id] ||= []).push(r)
    }

    const leads = computeLeadsNeedingResponse({
      conversations,
      quotes: quoteRes.rows as unknown as LeadQuoteRow[],
    })
    const rows = computePriorities({
      quotes: quoteRes.rows,
      invoices: invRes.rows,
      jobs: jobRes.rows,
      recById,
      quoteDepositRows,
      customers: (custRes.data as (ReachCustomer & { id: string })[]) || [],
      conversations: conversations.filter(c => Number(c.unread || 0) > 0),
      requests: openRequests((reqRes.data as { id: string; customer_id: string | null; from_portal: boolean; status: string }[] | null) ?? []),
      leads,
      seasons: settingsToSeasons(settings?.service_seasons),
      feeSettings: settings,
      today: todayISO,
      // Uncapped in effect: the inbox IS the full queue (the dashboard's cap is
      // a preview concern, applied at render). 50 kinds cannot exist.
      limit: 50,
    })
    return { ok: true, rows }
  } catch (e) {
    return fail(e)
  }
}

// ── The whole inbox, one call ────────────────────────────────────────────────
export interface OwnerInboxLoad {
  result: InboxResult
  todayISO: string
}

export async function loadOwnerInbox(sb: SupabaseClient, userId: string): Promise<OwnerInboxLoad> {
  const todayISO = localTodayISO()
  const [work, rest] = await Promise.all([
    loadWorkSource(sb, userId, todayISO),
    loadInboxSources(sb, userId, todayISO),
  ])
  const result = composeInbox({
    sources: { work, ...rest },
    now: new Date(),
    todayISO,
  })
  return { result, todayISO }
}
