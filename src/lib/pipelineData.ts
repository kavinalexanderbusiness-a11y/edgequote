// ── THE pipeline loader ──────────────────────────────────────────────────────
// One read batch for the whole board, handed to the pure engine (lib/pipeline).
// This file fetches and delegates: it contains no stage logic and no ranking.
//
// Every full-history read is PAGED. An unbounded select silently stops at 1000
// rows, and a truncated `jobs` read is the worst possible failure here — the
// booked-work set would come back short and the board would tell the owner to
// schedule work that is already on the calendar.
//
// ⚠️ ALL-OR-THROW, deliberately. supabase-js RESOLVES on failure ({data: null,
// error}), so a tolerant `|| []` turns a dead connection into the most reassuring
// screen in the app: an empty pipeline, nothing to do, all caught up. On a book
// with 40 live deals that is a confident lie. A failed read throws and the route's
// error boundary says the board didn't load — the same contract lib/dashboard/data
// holds for the morning screen.

import type { SupabaseClient } from '@supabase/supabase-js'
import { pageAll } from '@/lib/supabase/pageAll'
import { settingsToSeasons } from '@/lib/seasons'
import { localTodayISO } from '@/lib/utils'
import {
  computePipeline, type PipelineReport, type PQuote, type PJob, type PInvoice, type PCustomer,
} from '@/lib/pipeline'
import type { LeadConvRow } from '@/lib/leadResponse'
import type { RRecurrence } from '@/lib/reactivation'
import type { GateLedgerRow } from '@/lib/payments/depositGate'

// The union the engine actually consumes. Explicit, never `*`: quotes has 60
// columns and every one of them would cross the wire and be serialized into the
// RSC payload for the fourteen that matter.
const QUOTE_COLUMNS =
  'id, customer_id, customer_name, status, total, service_type, created_at, sent_at, last_followed_up_at, valid_until, lead_meta, initial_price, weekly_price, biweekly_price, monthly_price, deposit_type, deposit_value, deposit_override_at, accepted_price'

const INVOICE_COLUMNS =
  'id, invoice_number, quote_id, customer_id, status, amount, amount_paid, discount_type, discount_value, deposit_amount, deposit_requested_at'

// last_contacted_at is THE "have we reached out" fact (trigger-maintained from
// outbound messages) — it decides New lead vs Contacted. The reach fields decide
// whether a chase can happen at all. Both ride in one read.
const CUSTOMER_COLUMNS =
  'id, name, created_at, last_contacted_at, phone, email, sms_opt_in, email_opt_in, message_prefs'

export async function loadPipeline(
  sb: SupabaseClient,
  userId: string,
  opts?: { limit?: number },
): Promise<PipelineReport> {
  const today = localTodayISO()

  const [quoteRes, jobRes, invRes, custRes, convRes, recRes, outRes, setRes, depRes] = await Promise.all([
    pageAll<PQuote>(() => sb.from('quotes').select(QUOTE_COLUMNS).eq('user_id', userId)),
    pageAll<PJob>(() => sb.from('jobs').select('id, quote_id, customer_id, status, scheduled_date, recurrence_id, price, service_type').eq('user_id', userId)),
    pageAll<PInvoice>(() => sb.from('invoices').select(INVOICE_COLUMNS).eq('user_id', userId)),
    sb.from('customers').select(CUSTOMER_COLUMNS).eq('user_id', userId).is('archived_at', null),
    sb.from('conversations')
      .select('id, customer_id, unread, lead_status, last_direction, last_message_at, created_at, snoozed_until, customers(name)')
      .eq('user_id', userId).is('archived_at', null),
    sb.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', userId),
    sb.from('quote_outcomes').select('quote_id, reason').eq('user_id', userId),
    sb.from('business_settings').select('gst_percent, service_seasons').eq('user_id', userId).maybeSingle(),
    // Quote-linked deposit ledger rows — the scheduling gate's input, read exactly
    // as the dashboard reads it. Tiny by construction: only rows that secure a
    // booking carry quote_id.
    sb.from('payments').select('quote_id, amount, kind, provider, status')
      .eq('user_id', userId).not('quote_id', 'is', null),
  ])

  const failure =
    quoteRes.error ? `quotes: ${quoteRes.error}`
    : jobRes.error ? `jobs: ${jobRes.error}`
    : invRes.error ? `invoices: ${invRes.error}`
    : custRes.error ? `customers: ${custRes.error.message}`
    : convRes.error ? `conversations: ${convRes.error.message}`
    : recRes.error ? `recurrences: ${recRes.error.message}`
    // The loss reasons decide whether a lost deal is still ASKING to be
    // explained. A failed read here would make every tagged loss reappear on the
    // board demanding a reason it already has — so it joins the all-or-throw rule
    // rather than degrading to "nothing is tagged".
    : outRes.error ? `loss reasons: ${outRes.error.message}`
    : setRes.error ? `settings: ${setRes.error.message}`
    // ⚠️ A failed deposit read must NOT report "no deposit" — that answer
    // un-secures a booking the customer may have paid for, and the board would
    // urge work onto the schedule the owner deliberately gated. depositGate's own
    // loader states this rule; the pipeline obeys it by refusing to guess.
    : depRes.error ? `deposit payments: ${depRes.error.message}`
    : null
  if (failure) throw new Error(`The pipeline could not load — ${failure}`)

  const settings = setRes.data as { gst_percent: number | null; service_seasons: unknown } | null
  const recById: Record<string, RRecurrence> = {}
  for (const r of (recRes.data as RRecurrence[]) || []) recById[r.id] = r

  // Grouped by the booking they secure — the same shape the Owner Action queue builds.
  const quoteDepositRows: Record<string, GateLedgerRow[]> = {}
  for (const r of (depRes.data as ({ quote_id: string | null } & GateLedgerRow)[]) || []) {
    if (r.quote_id) (quoteDepositRows[r.quote_id] ||= []).push(r)
  }

  return computePipeline({
    quotes: quoteRes.rows,
    jobs: jobRes.rows,
    invoices: invRes.rows,
    customers: (custRes.data as unknown as PCustomer[]) || [],
    conversations: (convRes.data as unknown as LeadConvRow[]) || [],
    outcomes: (outRes.data as { quote_id: string; reason: string }[]) || [],
    recById,
    quoteDepositRows,
    seasons: settingsToSeasons(settings?.service_seasons),
    feeSettings: settings,
    today,
    limit: opts?.limit,
  })
}
