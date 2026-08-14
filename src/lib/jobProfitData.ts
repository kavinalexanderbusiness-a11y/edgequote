// ── Loading a job's profit review ────────────────────────────────────────────
// lib/jobProfit.ts is pure and I/O-free; this is the ONE place that knows which
// tables its five figures come from. Same three-way split as lib/jobCost +
// lib/jobCostData and lib/estimateVsActual + lib/estimateVsActualData: engine ·
// loader · UI, so the arithmetic can never acquire a database and the database
// can never acquire an opinion about arithmetic.
//
// ══ WHY A FAILED READ IS ITS OWN OUTCOME ═════════════════════════════════════
// "This visit made no money" and "we could not read this visit's money" are
// different findings that lead to opposite actions, and the entire class of bug
// this lane exists to prevent is the second quietly rendering as the first. So
// `unavailable` is a branch the UI must handle, AND the engine is called with
// `readFailed` so that even a caller who ignores the outcome gets "unknown" in
// every figure rather than a confident $0.
//
// ⚠️ ONE FAILED READ FAILS THE WHOLE REVIEW, deliberately. A margin is a
// subtraction across four tables; showing three of them and quietly dropping the
// fourth is how a screen ends up claiming a profit that rests on a query nobody
// noticed had errored. lib/jobCostData took the same decision for the same reason.
//
// ══ TENANCY ══════════════════════════════════════════════════════════════════
// Every read here is `.eq('user_id', userId)`. `jobs`, `expenses`, `time_entries`,
// `invoices`, `payments`, `job_line_items` and `job_work_sessions` are all RLS
// own-row, so a session client physically cannot see another business's rows —
// but this filter is NOT redundant theatre. It is the only thing standing if this
// loader is ever handed a service-role client, which bypasses RLS entirely, and a
// cost or a payment landing on the wrong business's visit is exactly the leak that
// was live in production until the composite `(job_id, user_id)` foreign keys
// shipped on 2026-08-11.
//
// The work-session read goes through Session 47's own loader (which relies on RLS)
// and is then filtered by `user_id` in JS — the same service-role backstop Session
// 48's learning loader applies, for the same reason.

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  BusinessSettings, ExpenseWithRelations, Payment, TimeEntry, WorkSession,
} from '@/types'
import { isGstRegistrant } from '@/lib/accounting/report'
import { readJobActualCost } from '@/lib/jobCost'
import { loadJobCost, EXPENSE_SELECT, type JobCostTarget } from '@/lib/jobCostData'
import { effectiveFreq } from '@/lib/visitValue'
import { loadWorkSessions, loadWorkSessionsForJobs } from '@/lib/workSession'
import {
  reviewJobProfit, rollupProfit,
  type InvoiceFacts, type JobProfitReview, type ProfitRollup,
} from '@/lib/jobProfit'

/** Columns the review needs off the visit itself. Every one is load-bearing:
 *  `price` and `is_initial_visit` decide the authorized value, `started_at`
 *  decides whether the work is still running, `actual_minutes` is what the
 *  session total is checked against. */
const JOB_SELECT =
  'id, title, status, price, service_type, is_initial_visit, started_at, actual_minutes, '
  + 'crew_size, quote_id, recurrence_id, scheduled_date, customer_id'

const INVOICE_SELECT =
  'id, job_id, invoice_number, amount, amount_paid, status, discount_type, discount_value'

interface JobRow {
  id: string
  title: string | null
  status: string | null
  price: number | null
  service_type: string | null
  is_initial_visit: boolean | null
  started_at: string | null
  actual_minutes: number | null
  crew_size: number | null
  quote_id: string | null
  recurrence_id: string | null
  scheduled_date: string | null
  customer_id: string | null
}

interface RecRow { id: string; freq: string | null; interval_unit: string | null; interval_count: number | null }

/**
 * A `job_line_items` row as this loader reads it. `change_order_id` is optional in
 * the TYPE as well as in the query, because the column is in production and not in
 * main's baseline — a row read from a rebuilt database simply will not have the key.
 */
interface ExtraRow {
  job_id?: string
  description: string
  amount: number | string
  change_order_id?: string | null
}

const toExtra = (a: ExtraRow) => ({
  description: a.description,
  amount: Number(a.amount) || 0,
  changeOrderId: a.change_order_id ?? null,
})

export interface JobProfitLoad {
  outcome: 'ok' | 'unavailable'
  /**
   * ALWAYS present. On `unavailable` every figure is unknown, so a surface that
   * forgets to branch still cannot print a zero.
   */
  review: JobProfitReview
  reason?: string
}

/** The all-unknown review, for every path that could not read. */
function unavailableReview(job: JobCostTarget): JobProfitReview {
  return reviewJobProfit({
    job: { id: job.id, status: job.status ?? null },
    cost: readJobActualCost({ job, expenses: [], timeEntries: [], registrant: false, readFailed: true }),
    readFailed: true,
  })
}

/**
 * ⭐ Did this visit make money? Everything one panel needs, in two round trips.
 *
 * The visit is re-read from the database rather than taken from the caller: this
 * answers what the RECORD says, and a half-typed price in a form is not a price
 * the business agreed to. (The cost panel above it does read live form values,
 * because it is a door for recording rather than a statement of fact.)
 */
export async function loadJobProfit(
  supabase: SupabaseClient, userId: string, jobId: string,
): Promise<JobProfitLoad> {
  const target: JobCostTarget = { id: jobId }
  const failed = (reason: string): JobProfitLoad =>
    ({ outcome: 'unavailable', review: unavailableReview(target), reason })

  if (!userId) return failed('not_signed_in')
  if (!jobId) return failed('no_job')

  const jobRes = await supabase
    .from('jobs').select(JOB_SELECT).eq('user_id', userId).eq('id', jobId).maybeSingle()
  if (jobRes.error) return failed(jobRes.error.message || 'job_read_failed')
  const job = jobRes.data as JobRow | null
  if (!job) return failed('job_not_found')

  const costTarget: JobCostTarget = {
    id: job.id,
    status: job.status,
    service_type: job.service_type,
    actual_minutes: job.actual_minutes,
    crew_size: job.crew_size,
  }

  const [costLoad, quoteRes, recRes, extraRes, invRes, sessionLoad] = await Promise.all([
    // The cost side, whole: expenses, shifts, settings and the completeness
    // contract. Never re-derived here — one costing engine.
    loadJobCost(supabase, userId, costTarget),
    job.quote_id
      ? supabase.from('quotes').select('*').eq('user_id', userId).eq('id', job.quote_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    job.recurrence_id
      ? supabase.from('job_recurrences').select('id, freq, interval_unit, interval_count')
        .eq('user_id', userId).eq('id', job.recurrence_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    // `*`, not a column list, ON PURPOSE: `change_order_id` exists in production
    // (Session 51) but not in this repository's baseline, so naming it would 404
    // on a database rebuilt from main and blank every figure on the panel. With
    // `*` it is read where it exists and simply absent where it does not.
    supabase.from('job_line_items').select('*')
      .eq('user_id', userId).eq('job_id', job.id),
    supabase.from('invoices').select(INVOICE_SELECT)
      .eq('user_id', userId).eq('job_id', job.id).limit(1),
    loadWorkSessions(supabase, job.id),
  ])

  if (costLoad.outcome !== 'ok') return failed(costLoad.reason || 'cost_read_failed')
  if (quoteRes.error) return failed(quoteRes.error.message || 'quote_read_failed')
  if (recRes.error) return failed(recRes.error.message || 'recurrence_read_failed')
  // A null payload with no error is included deliberately: PostgREST can produce
  // it, and it is otherwise indistinguishable from "this visit has no extras".
  if (extraRes.error) return failed(extraRes.error.message || 'extras_read_failed')
  if (!Array.isArray(extraRes.data)) return failed('extras_no_rows_returned')
  if (invRes.error) return failed(invRes.error.message || 'invoice_read_failed')
  if (!Array.isArray(invRes.data)) return failed('invoice_no_rows_returned')

  const invoice = (invRes.data as InvoiceFacts[])[0] ?? null

  // Cash, and only this invoice's. A visit with no invoice has no payments to
  // read — asking anyway would return the whole customer's ledger.
  let payments: Payment[] = []
  if (invoice) {
    const payRes = await supabase.from('payments').select('*')
      .eq('user_id', userId).eq('invoice_id', invoice.id)
    if (payRes.error) return failed(payRes.error.message || 'payments_read_failed')
    if (!Array.isArray(payRes.data)) return failed('payments_no_rows_returned')
    payments = payRes.data as Payment[]
  }

  const rec = recRes.data as RecRow | null
  return {
    outcome: 'ok',
    review: reviewJobProfit({
      job: {
        id: job.id,
        status: job.status,
        price: job.price,
        service_type: job.service_type,
        is_initial_visit: job.is_initial_visit,
        started_at: job.started_at,
        actual_minutes: job.actual_minutes,
      },
      cost: costLoad.cost,
      quote: (quoteRes.data as Record<string, unknown> | null) ?? null,
      freq: rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null,
      extras: (extraRes.data as ExtraRow[]).map(toExtra),
      // ⛔ `change_orders` is NOT read here. The table exists in production but not
      // in main's baseline, and one 404 blanks the whole review. Approved change
      // money still lands correctly, because approval mints the line item above —
      // and a pending or declined change has no row to find. When Session 51
      // merges, add the read and pass `changeOrders` so pending money is REPORTED
      // (never added — see readChanges).
      invoice,
      payments,
      // The service-role backstop: the composite foreign key already makes a
      // foreign session unreachable, and this makes it unreadable too.
      sessions: sessionLoad.sessions.filter(s => s.user_id === userId),
      sessionsFailed: sessionLoad.failed,
      settings: costLoad.settings,
    }),
  }
}

// ── Many visits: the finished-work comparison ────────────────────────────────

/**
 * The most recent finished visits to review. A CAP, not a date window: a seasonal
 * business can go months without work, and a window would silently empty its own
 * history in the off-season. When it bites, `truncated` says so rather than
 * letting the surface imply it read everything.
 */
export const PROFIT_BOOK_LIMIT = 60

export interface ProfitRow {
  review: JobProfitReview
  jobId: string
  label: string
  date: string | null
  invoiceNumber: string | null
}

export type ProfitBookLoad =
  | {
    outcome: 'ok'
    rows: ProfitRow[]
    rollup: ProfitRollup
    truncated: boolean
    /** Finished visits in the book, whether or not they fitted in the cap. */
    completedTotal: number | null
  }
  /** The read did not happen. NOT an empty book — say so, show no figures. */
  | { outcome: 'unavailable'; reason: string }

/**
 * ⭐ Which finished visits made money — and, far more often, which cannot say.
 *
 * One pass per table, never one pass per visit: sixty visits reviewed through
 * per-row queries is sixty chances to forget a `user_id` filter and sixty round
 * trips on a page an owner opens to think, not to wait.
 */
export async function loadProfitBook(
  supabase: SupabaseClient, userId: string, opts?: { limit?: number },
): Promise<ProfitBookLoad> {
  const limit = Math.max(1, Math.min(opts?.limit ?? PROFIT_BOOK_LIMIT, 200))
  const failed = (reason: string): ProfitBookLoad => ({ outcome: 'unavailable', reason })
  if (!userId) return failed('not_signed_in')

  const [jobRes, countRes] = await Promise.all([
    supabase.from('jobs').select(JOB_SELECT)
      .eq('user_id', userId).eq('status', 'completed')
      .order('scheduled_date', { ascending: false })
      .limit(limit + 1),
    supabase.from('jobs').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('status', 'completed'),
  ])
  if (jobRes.error) return failed(jobRes.error.message || 'jobs_read_failed')
  if (!Array.isArray(jobRes.data)) return failed('jobs_no_rows_returned')

  const all = jobRes.data as unknown as JobRow[]
  const truncated = all.length > limit
  const jobs = all.slice(0, limit)
  if (jobs.length === 0) {
    return {
      outcome: 'ok',
      rows: [],
      rollup: rollupProfit([]),
      truncated: false,
      completedTotal: countRes.error ? null : (countRes.count ?? 0),
    }
  }

  const jobIds = jobs.map(j => j.id)
  const quoteIds = [...new Set(jobs.map(j => j.quote_id).filter((x): x is string => !!x))]
  const recIds = [...new Set(jobs.map(j => j.recurrence_id).filter((x): x is string => !!x))]

  const [expRes, timeRes, setRes, quoteRes, recRes, extraRes, invRes, sessionLoad] = await Promise.all([
    supabase.from('expenses').select(EXPENSE_SELECT)
      .eq('user_id', userId).in('job_id', jobIds).is('archived_at', null),
    supabase.from('time_entries').select('*').eq('user_id', userId).in('job_id', jobIds),
    supabase.from('business_settings').select('*').eq('user_id', userId).maybeSingle(),
    quoteIds.length
      ? supabase.from('quotes').select('*').eq('user_id', userId).in('id', quoteIds)
      : Promise.resolve({ data: [], error: null }),
    recIds.length
      ? supabase.from('job_recurrences').select('id, freq, interval_unit, interval_count')
        .eq('user_id', userId).in('id', recIds)
      : Promise.resolve({ data: [], error: null }),
    // `*` for the same reason as the single-visit path above.
    supabase.from('job_line_items').select('*')
      .eq('user_id', userId).in('job_id', jobIds),
    supabase.from('invoices').select(INVOICE_SELECT).eq('user_id', userId).in('job_id', jobIds),
    loadWorkSessionsForJobs(supabase, jobIds),
  ])

  // Every one of these is a figure, so every one of them fails the whole read.
  // Settings decides the tax split; guessing it would move the invoiced figures.
  if (expRes.error) return failed(expRes.error.message || 'expenses_read_failed')
  if (!Array.isArray(expRes.data)) return failed('expenses_no_rows_returned')
  if (timeRes.error) return failed(timeRes.error.message || 'time_read_failed')
  if (!Array.isArray(timeRes.data)) return failed('time_no_rows_returned')
  if (setRes.error) return failed(setRes.error.message || 'settings_read_failed')
  if (quoteRes.error) return failed(quoteRes.error.message || 'quotes_read_failed')
  if (recRes.error) return failed(recRes.error.message || 'recurrences_read_failed')
  if (extraRes.error) return failed(extraRes.error.message || 'extras_read_failed')
  if (invRes.error) return failed(invRes.error.message || 'invoices_read_failed')
  if (!Array.isArray(invRes.data)) return failed('invoices_no_rows_returned')

  const invoices = invRes.data as unknown as (InvoiceFacts & { job_id: string | null })[]
  const invoiceIds = invoices.map(i => i.id)

  let payments: Payment[] = []
  if (invoiceIds.length) {
    const payRes = await supabase.from('payments').select('*')
      .eq('user_id', userId).in('invoice_id', invoiceIds)
    if (payRes.error) return failed(payRes.error.message || 'payments_read_failed')
    if (!Array.isArray(payRes.data)) return failed('payments_no_rows_returned')
    payments = payRes.data as Payment[]
  }

  const expenses = expRes.data as unknown as ExpenseWithRelations[]
  const timeEntries = timeRes.data as unknown as TimeEntry[]
  const settings = (setRes.data as BusinessSettings | null) ?? null
  const registrant = isGstRegistrant(settings)

  const quoteById = new Map<string, Record<string, unknown>>()
  for (const q of (quoteRes.data as Record<string, unknown>[] | null) ?? []) {
    quoteById.set(String(q.id), q)
  }
  const recById = new Map<string, RecRow>()
  for (const r of (recRes.data as RecRow[] | null) ?? []) recById.set(r.id, r)

  const extrasByJob = new Map<string, ReturnType<typeof toExtra>[]>()
  for (const a of (extraRes.data as ExtraRow[] | null) ?? []) {
    if (!a.job_id) continue
    const list = extrasByJob.get(a.job_id)
    const row = toExtra(a)
    if (list) list.push(row)
    else extrasByJob.set(a.job_id, [row])
  }
  const invoiceByJob = new Map<string, InvoiceFacts>()
  for (const i of invoices) if (i.job_id) invoiceByJob.set(i.job_id, i)
  const paymentsByInvoice = new Map<string, Payment[]>()
  for (const p of payments) {
    if (!p.invoice_id) continue
    const list = paymentsByInvoice.get(p.invoice_id)
    if (list) list.push(p)
    else paymentsByInvoice.set(p.invoice_id, [p])
  }
  const sessionsByJob = new Map<string, WorkSession[]>()
  for (const s of sessionLoad.sessions) {
    // Same backstop as the single-visit path.
    if (s.user_id !== userId) continue
    const list = sessionsByJob.get(s.job_id)
    if (list) list.push(s)
    else sessionsByJob.set(s.job_id, [s])
  }

  const rows: ProfitRow[] = jobs.map(job => {
    const rec = job.recurrence_id ? recById.get(job.recurrence_id) : null
    const invoice = invoiceByJob.get(job.id) ?? null
    const review = reviewJobProfit({
      job: {
        id: job.id,
        status: job.status,
        price: job.price,
        service_type: job.service_type,
        is_initial_visit: job.is_initial_visit,
        started_at: job.started_at,
        actual_minutes: job.actual_minutes,
      },
      // The engine filters expenses and shifts to this job itself, so it is
      // handed the whole set rather than a pre-sliced one — one filter, in the
      // module whose rule it is.
      cost: readJobActualCost({
        job: { id: job.id, status: job.status, actual_minutes: job.actual_minutes, crew_size: job.crew_size },
        expenses, timeEntries, registrant,
      }),
      quote: job.quote_id ? quoteById.get(job.quote_id) ?? null : null,
      freq: rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null,
      extras: extrasByJob.get(job.id) ?? [],
      invoice,
      payments: invoice ? paymentsByInvoice.get(invoice.id) ?? [] : [],
      sessions: sessionsByJob.get(job.id) ?? [],
      sessionsFailed: sessionLoad.failed,
      settings,
    })
    return {
      review,
      jobId: job.id,
      label: job.title || job.service_type || 'Visit',
      date: job.scheduled_date,
      invoiceNumber: invoice?.invoice_number ?? null,
    }
  })

  return {
    outcome: 'ok',
    rows,
    rollup: rollupProfit(rows.map(r => r.review)),
    truncated,
    completedTotal: countRes.error ? null : (countRes.count ?? null),
  }
}
