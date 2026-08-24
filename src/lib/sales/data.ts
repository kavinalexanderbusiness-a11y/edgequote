// ── THE sales analytics loader ───────────────────────────────────────────────
// lib/sales/analytics is pure; this is the ONE place that knows which tables the
// report reads. Same engine · loader · UI split as dayFit/dayFitLoad,
// inbox/inboxData and timeline/timelineData.
//
// ══ QUERY BUDGET — why this does not load the CRM into the browser ═══════════
// The period bounds the whole read. Only the QUOTES table is scanned by date;
// every other read is keyed by the ids that scan produced, so a business with
// ten years of history and a 30-day filter pays for 30 days of quotes and the
// rows welded to them — not for every job, invoice and payment it has ever had.
//
//   quotes       — created_at BETWEEN period                    (the cohort)
//   customers    — the cohort's customers, PLUS created_at in period
//   jobs         — quote_id IN cohort
//   invoices     — quote_id IN cohort  ∪  job_id IN cohort jobs
//   payments     — invoice_id IN those ∪ quote_id IN cohort
//   change_orders— job_id IN cohort jobs
//
// Every one is paged (pageAll — PostgREST truncates at 1000 rows and does NOT
// error) and every `in` list is CHUNKED, because a URL-encoded `in.(…)` of a few
// thousand uuids exceeds what PostgREST will accept and fails the whole request.
//
// ══ TENANCY ══════════════════════════════════════════════════════════════════
// Every read carries an explicit `.eq('user_id', uid)` on top of RLS. The id
// filters are welded to the cohort, but a stale or crafted id must still never
// reach another business's row — so tenancy is asserted per READ, not inferred
// from the previous one.
//
// ══ FAILURE HONESTY ══════════════════════════════════════════════════════════
// Returns NULL when ANY load-bearing read fails. supabase-js RESOLVES with
// `{ data: null, error }` on a dead connection, and a tolerant `|| []` would
// render "you quoted $0 and won nothing this quarter" — a confident, specific,
// entirely false verdict about the owner's business. Same class as
// loadCustomerHealth's false all-clear and loadWinLoss's vanishing panel.

import type { SupabaseClient } from '@supabase/supabase-js'
import { pageAll } from '@/lib/supabase/pageAll'
import type { FeeSettings } from '@/lib/invoiceTotals'
import {
  computeSalesAnalytics, type Period, type SalesAnalyticsReport,
  type SAQuote, type SAJob, type SAInvoice, type SAPayment, type SAChangeOrder, type SACustomer,
} from '@/lib/sales/analytics'

// Columns are listed explicitly so a dropped column breaks the build rather than
// silently reading undefined → 0.
//
// ⚠️⚠️ PostgREST fails the WHOLE select on an unknown column. Every name below
// is one this app already reads elsewhere; do not add a speculative one.
const QUOTE_COLUMNS =
  'id, quote_number, customer_id, customer_name, service_type, status, total, ' +
  'accepted_price, created_at, sent_at, last_followed_up_at'
const INVOICE_COLUMNS =
  'id, invoice_number, quote_id, job_id, customer_id, status, amount, amount_paid, ' +
  'discount_type, discount_value'
const PAYMENT_COLUMNS = 'id, invoice_id, quote_id, customer_id, kind, provider, status, amount'

/** How many ids ride in one `in.(…)` filter. Comfortably inside PostgREST's
 *  URL limits while keeping the round-trip count low. */
const ID_CHUNK = 200

const chunk = <T,>(xs: T[], size = ID_CHUNK): T[][] => {
  if (xs.length === 0) return []
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

/**
 * Run a paged, tenant-scoped read once per id chunk and concatenate.
 *
 * Returns `error` on the FIRST failure — a partial answer here is a wrong
 * answer, and the caller turns it into a null report rather than a short one.
 */
async function readByIds<T>(
  ids: string[],
  build: (batch: string[]) => Parameters<typeof pageAll>[0],
  orderBy = 'id',
): Promise<{ rows: T[]; error: string | null }> {
  const out: T[] = []
  for (const batch of chunk(ids)) {
    const { rows, error } = await pageAll<T>(build(batch), orderBy)
    if (error) return { rows: out, error }
    out.push(...rows)
  }
  return { rows: out, error: null }
}

/** De-duplicate rows that two different id filters can both return. */
const byId = <T extends { id: string }>(rows: T[]): T[] => {
  const seen = new Set<string>()
  return rows.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)))
}

/**
 * Load and compute the sales analytics report for one period.
 *
 * NULL means a load-bearing read failed. It never means "no sales".
 */
export async function loadSalesAnalytics(
  supabase: SupabaseClient,
  period: Period,
  opts?: { nowMs?: number },
): Promise<SalesAnalyticsReport | null> {
  // getSession (local read) rather than getUser (network hop) — the id only
  // scopes reads RLS already constrains. Matches loadWinLoss / loadAcquisitionFunnel.
  const { data: { session } } = await supabase.auth.getSession()
  const uid = session?.user?.id
  if (!uid) return null

  // The period is a calendar range on a timestamptz column, so the upper bound is
  // the END of `to` — `lte('created_at', to)` alone would drop everything quoted
  // during the last day of the window.
  const fromTs = `${period.from}T00:00:00.000Z`
  const toTsExclusive = new Date(new Date(`${period.to}T00:00:00.000Z`).getTime() + 86_400_000).toISOString()

  // ── 1 · The cohort ─────────────────────────────────────────────────────────
  const qRes = await pageAll<SAQuote>(() =>
    supabase.from('quotes').select(QUOTE_COLUMNS)
      .eq('user_id', uid)
      .gte('created_at', fromTs)
      .lt('created_at', toTsExclusive))
  if (qRes.error) return null
  const quotes = qRes.rows
  const quoteIds = quotes.map(q => q.id)

  // ── 2 · Everything welded to it ────────────────────────────────────────────
  // Jobs first: invoices and change orders can both reach a deal THROUGH a job,
  // so their id filters depend on this answer.
  const jRes = await readByIds<SAJob>(quoteIds, batch => () =>
    supabase.from('jobs').select('id, quote_id, customer_id')
      .eq('user_id', uid)
      .in('quote_id', batch))
  if (jRes.error) return null
  const jobs = jRes.rows
  const jobIds = jobs.map(j => j.id)

  const [invByQuote, invByJob, coRes, custPeriodRes, settingsRes] = await Promise.all([
    readByIds<SAInvoice>(quoteIds, batch => () =>
      supabase.from('invoices').select(INVOICE_COLUMNS).eq('user_id', uid).in('quote_id', batch)),
    readByIds<SAInvoice>(jobIds, batch => () =>
      supabase.from('invoices').select(INVOICE_COLUMNS).eq('user_id', uid).in('job_id', batch)),
    readByIds<SAChangeOrder>(jobIds, batch => () =>
      supabase.from('change_orders').select('id, job_id, status, amount').eq('user_id', uid).in('job_id', batch)),
    // Customers who ARRIVED in the period — the unquoted-lead count needs them,
    // and they are not reachable from any cohort quote by definition.
    pageAll<SACustomer>(() =>
      supabase.from('customers').select('id, acquisition_source, created_at')
        .eq('user_id', uid).is('archived_at', null)
        .gte('created_at', fromTs).lt('created_at', toTsExclusive)),
    supabase.from('business_settings')
      .select('payment_fee_strategy, fee_recovery_percent, gst_percent')
      .eq('user_id', uid).maybeSingle(),
  ])
  if (invByQuote.error || invByJob.error || coRes.error || custPeriodRes.error) return null
  // Settings degrade honestly: absent fee/GST settings mean 0% — the same figure
  // invoiceTotals produces for a business that has never configured either.
  const feeSettings = (settingsRes.data as FeeSettings | null) ?? null

  const invoices = byId([...invByQuote.rows, ...invByJob.rows])
  const invoiceIds = invoices.map(inv => inv.id)

  // Payments reach a deal by invoice, or by `quote_id` for a deposit taken to
  // secure a booking before any invoice existed. Both routes are read; the
  // engine de-duplicates by payment id.
  const [payByInvoice, payByQuote, custRes] = await Promise.all([
    readByIds<SAPayment>(invoiceIds, batch => () =>
      supabase.from('payments').select(PAYMENT_COLUMNS).eq('user_id', uid).in('invoice_id', batch)),
    readByIds<SAPayment>(quoteIds, batch => () =>
      supabase.from('payments').select(PAYMENT_COLUMNS).eq('user_id', uid).in('quote_id', batch)),
    readByIds<SACustomer>(
      [...new Set(quotes.map(q => q.customer_id).filter((c): c is string => !!c))],
      batch => () =>
        supabase.from('customers').select('id, acquisition_source, created_at')
          .eq('user_id', uid).in('id', batch)),
  ])
  if (payByInvoice.error || payByQuote.error || custRes.error) return null

  return computeSalesAnalytics({
    quotes,
    jobs,
    invoices,
    payments: byId([...payByInvoice.rows, ...payByQuote.rows]),
    changeOrders: coRes.rows,
    customers: byId([...custRes.rows, ...custPeriodRes.rows]),
    feeSettings,
    period,
    nowMs: opts?.nowMs,
  })
}
