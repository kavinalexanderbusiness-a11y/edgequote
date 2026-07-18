import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  Payment, BusinessSettings, ExpenseWithRelations, FixedAsset, Liability,
} from '@/types'
import { pageAll } from '@/lib/supabase/pageAll'
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
  price: number | null
  scheduled_date: string | null
  service_type: string | null
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
  const { rows, error } = await pageAll<AccountingJob>(() => sb
    .from('jobs')
    .select('id, title, price, scheduled_date, service_type')
    .eq('user_id', userId)
    .order('scheduled_date', { ascending: false }))
  if (error) errors.push(`jobs: ${error}`)
  return rows
}

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
