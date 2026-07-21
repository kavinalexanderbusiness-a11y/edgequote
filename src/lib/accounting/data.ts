import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  Payment, BusinessSettings, ExpenseWithRelations, FixedAsset, Liability,
} from '@/types'
import { pageAll } from '@/lib/supabase/pageAll'
import { jobVisitValue, effectiveFreq } from '@/lib/invoicing'
import { listExpenses } from '@/lib/accounting/expenses'
import type { GstInput } from '@/lib/accounting/gst'

// ── THE accounting loader ────────────────────────────────────────────────────
// ONE place fetches the rows every financial surface reads. The engines are pure
// functions over these rows; this is the only file that knows how to get them.
//
// It exists because eleven report pages each writing their own query is eleven
// chances to forget `.range()` and silently truncate at 1000 rows, or to filter by
// `created_at` instead of `paid_at`, or to miss `archived_at`. Every one of those
// bugs produces a page that renders perfectly and reports the wrong money. The
// engines can't catch it — they faithfully compute over whatever they're handed.
//
// So: fetch once, here, completely. Every caller gets the same rows, which is also
// why two reports on this data can never disagree.

export interface AccountingData {
  userId: string
  settings: BusinessSettings | null
  payments: Payment[]
  expenses: ExpenseWithRelations[]
  invoices: GstInput['invoices']
  fixedAssets: FixedAsset[]
  liabilities: Liability[]
  /** Parts on hand at cost — a CURRENT snapshot (see balanceSheet's caveat). */
  inventoryValue: number
  jobs: AccountingJob[]
  /** Anything that failed to load. Non-empty = the figures are incomplete, and say so. */
  errors: string[]
}

/** A job as the financial surfaces read it. Named (it was inline) so the columns
 *  job costing values a visit from can't drift from the columns this select asks
 *  for — the two must move together or a job silently values at $0. */
export interface AccountingJob {
  id: string
  title: string | null
  /** The job-level manual price. May be null — most jobs carry no override. */
  price: number | null
  scheduled_date: string | null
  service_type: string | null
  /**
   * What this visit is worth, through THE valuation seam (lib/invoicing
   * jobVisitValue): the job's own price when set, otherwise the price its quote
   * actually bills at this cadence.
   *
   * NULL means genuinely unknown — no price AND no quote to derive one from. It
   * is never 0-for-unknown: a $0 revenue turns an uncosted job into a 0% margin,
   * which reads as a real business fact instead of a missing one (the honesty
   * rule lib/margin.ts and jobCosting.ts already hold to).
   */
  value: number | null
}

/**
 * Load everything the accounting surfaces need.
 *
 * `pageAll` on the money tables, deliberately: a P&L missing payment 1001 because
 * of a default 1000-row cap is wrong in the direction nobody checks — it looks
 * like a quiet year, not a bug.
 *
 * Errors are COLLECTED, never swallowed. A page that renders $0 because a query
 * failed is indistinguishable from a business that earned nothing, so every caller
 * gets told and every caller shows a banner.
 */
export async function loadAccountingData(
  sb: SupabaseClient,
  userId: string,
): Promise<AccountingData> {
  const errors: string[] = []

  const [payments, expenses, invoices, assets, liabilities, inventory, jobs, settings] =
    await Promise.all([
      loadPayments(sb, userId, errors),
      loadExpenses(sb, userId, errors),
      loadInvoices(sb, userId, errors),
      loadFixedAssets(sb, userId, errors),
      loadLiabilities(sb, userId, errors),
      loadInventoryValue(sb, userId, errors),
      loadJobs(sb, userId, errors),
      loadSettings(sb, userId, errors),
    ])

  return {
    userId, settings, payments, expenses, invoices,
    fixedAssets: assets, liabilities, inventoryValue: inventory, jobs, errors,
  }
}

async function loadPayments(sb: SupabaseClient, userId: string, errors: string[]): Promise<Payment[]> {
  // pageAll appends the `id` tiebreak itself — the business order stays here.
  const { rows, error } = await pageAll<Payment>(() => sb
    .from('payments')
    .select('id, amount, method, provider, paid_at, kind, status, invoice_id, customer_id, currency, created_at, user_id, notes')
    .eq('user_id', userId)
    .order('paid_at', { ascending: false }))
  if (error) errors.push(`payments: ${error}`)
  return rows
}

async function loadExpenses(sb: SupabaseClient, userId: string, errors: string[]): Promise<ExpenseWithRelations[]> {
  const { rows, error } = await listExpenses(sb, userId)
  if (error) errors.push(`expenses: ${error}`)
  return rows
}

async function loadInvoices(sb: SupabaseClient, userId: string, errors: string[]): Promise<GstInput['invoices']> {
  const { rows, error } = await pageAll<GstInput['invoices'][number]>(() => sb
    .from('invoices')
    .select('id, invoice_number, amount, amount_paid, status, issued_date, discount_type, discount_value, customers(name)')
    .eq('user_id', userId)
    .order('issued_date', { ascending: false }))
  if (error) errors.push(`invoices: ${error}`)
  return rows
}

async function loadFixedAssets(sb: SupabaseClient, userId: string, errors: string[]): Promise<FixedAsset[]> {
  const { data, error } = await sb
    .from('fixed_assets')
    .select('*')
    .eq('user_id', userId)
    .is('archived_at', null)
    .order('in_service_date', { ascending: false })
  if (error) errors.push(`assets: ${error.message}`)
  return (data as FixedAsset[]) || []
}

async function loadLiabilities(sb: SupabaseClient, userId: string, errors: string[]): Promise<Liability[]> {
  const { data, error } = await sb
    .from('liabilities')
    .select('*')
    .eq('user_id', userId)
    .is('archived_at', null)
    .order('as_of_date', { ascending: false })
  if (error) errors.push(`liabilities: ${error.message}`)
  return (data as Liability[]) || []
}

/**
 * Parts on hand, at cost.
 *
 * Summed in JS rather than by the DB so the valuation rule (qty × unit_cost, never
 * below zero) lives in code beside the balance sheet that depends on it, instead of
 * inside a query string nobody re-reads. Inventory is small by nature — this is one
 * page of rows, not a scan.
 */
async function loadInventoryValue(sb: SupabaseClient, userId: string, errors: string[]): Promise<number> {
  const { data, error } = await sb
    .from('parts')
    .select('qty_on_hand, unit_cost')
    .eq('user_id', userId)
  if (error) {
    // A failed inventory read must not silently value the shelf at $0 — that reads
    // as "we own no parts" on the balance sheet.
    errors.push(`inventory: ${error.message}`)
    return 0
  }
  const total = (data || []).reduce(
    (s, p) => s + Math.max(0, Number(p.qty_on_hand) || 0) * (Number(p.unit_cost) || 0),
    0,
  )
  return Math.round(total * 100) / 100
}

async function loadJobs(sb: SupabaseClient, userId: string, errors: string[]) {
  // Three reads, because a visit's value is not one column. `jobs.price` is only
  // the manual OVERRIDE — most jobs don't carry one, so costing by price alone
  // valued the majority of the book at $0 and reported margins against revenue
  // the business plainly did earn. The quote holds the real number, and which of
  // its prices applies depends on the recurrence's cadence.
  const [jobRes, quoteRes, recRes] = await Promise.all([
    pageAll<JobRow>(() => sb
      .from('jobs')
      .select('id, title, price, scheduled_date, service_type, quote_id, recurrence_id, is_initial_visit')
      .eq('user_id', userId)
      .order('scheduled_date', { ascending: false })),
    pageAll<QuoteRow>(() => sb
      .from('quotes')
      .select('id, initial_price, weekly_price, biweekly_price, monthly_price, total')
      .eq('user_id', userId)),
    pageAll<RecurrenceRow>(() => sb
      .from('job_recurrences')
      .select('id, freq, interval_unit, interval_count')
      .eq('user_id', userId)),
  ])
  if (jobRes.error) errors.push(`jobs: ${jobRes.error}`)
  // A failed quote/recurrence read must NOT silently fall back to price-only
  // costing — that is the exact bug this loader exists to fix, and it would look
  // like a business with no revenue rather than a query that failed.
  if (quoteRes.error) errors.push(`job quotes: ${quoteRes.error}`)
  if (recRes.error) errors.push(`job recurrences: ${recRes.error}`)

  const quoteById = new Map(quoteRes.rows.map(q => [q.id, q]))
  const recById = new Map(recRes.rows.map(r => [r.id, r]))

  return jobRes.rows.map(j => {
    const quote = j.quote_id ? quoteById.get(j.quote_id) ?? null : null
    const rec = j.recurrence_id ? recById.get(j.recurrence_id) ?? null : null
    const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
    // THE seam. `is_initial_visit` matters: the anchor visit of a series bills the
    // quote's INITIAL price, not its cadence price — a first cut can be $150 while
    // every visit after it is $65.
    const value = jobVisitValue(j.price, quote, freq, !!j.is_initial_visit)
    return {
      id: j.id, title: j.title, price: j.price,
      scheduled_date: j.scheduled_date, service_type: j.service_type,
      // > 0, not >= 0: the seam returns 0 when it has nothing to go on, and that
      // is "unknown", not "free".
      value: value > 0 ? value : null,
    }
  })
}

type JobRow = {
  id: string; title: string | null; price: number | null
  scheduled_date: string | null; service_type: string | null
  quote_id: string | null; recurrence_id: string | null; is_initial_visit: boolean | null
}
type QuoteRow = { id: string } & Record<string, unknown>
type RecurrenceRow = { id: string; freq: string | null; interval_unit: string | null; interval_count: number | null }

async function loadSettings(sb: SupabaseClient, userId: string, errors: string[]): Promise<BusinessSettings | null> {
  const { data, error } = await sb.from('business_settings').select('*').eq('user_id', userId).maybeSingle()
  if (error) {
    // Settings carry gst_percent and the opening balance. Failing to read them and
    // carrying on would silently switch the GST rules and blank the balance sheet.
    errors.push(`settings: ${error.message}`)
    return null
  }
  return (data as BusinessSettings) || null
}
