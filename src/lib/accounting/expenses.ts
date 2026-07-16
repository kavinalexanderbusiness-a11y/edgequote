import type { SupabaseClient } from '@supabase/supabase-js'
import type { Expense, ExpenseFormValues, ExpenseWithRelations } from '@/types'
import { fetchAllRows } from '@/lib/fetchAll'

// ── Expenses — money OUT ─────────────────────────────────────────────────────
// The write and read side of the expense ledger, plus THE amount convention every
// report in this app derives from. `payments` (money in) is untouched by this
// file; lib/accounting/report.ts is the one place the two meet.
//
// ══ THE AMOUNT CONVENTION — read this before writing any figure ══════════════
//   amount     = GROSS. The total paid, exactly as the receipt/bank line reads.
//   tax_amount = the tax INCLUDED in that total (GST paid → an ITC).
//   net        = amount − tax_amount.
//
// Cash flow sums GROSS: it has to reconcile against a bank statement, and the
// bank moved the gross. The P&L sums NET: recoverable tax is not an expense, it's
// money the government gives back, and counting it as cost understates profit.
//
// Storing gross + tax makes both derivable from ONE row, so the two reports can
// never disagree. Storing net instead would make cash flow unreconcilable without
// re-deriving tax — the reason this convention is in the schema, not a preference.
// ═════════════════════════════════════════════════════════════════════════════

const round2 = (n: number) => Math.round(n * 100) / 100

// ── Pure amount maths ────────────────────────────────────────────────────────

/** What this expense actually COST the business: gross less the tax it can reclaim. */
export function expenseNet(e: Pick<Expense, 'amount' | 'tax_amount'>): number {
  return round2((Number(e.amount) || 0) - (Number(e.tax_amount) || 0))
}

export interface ExpenseTotals {
  /** Gross out — sums to the bank. Cash flow uses this. */
  gross: number
  /** Tax paid across these rows (input tax credits). */
  tax: number
  /** gross − tax. The P&L uses this. */
  net: number
  count: number
  /** Net of the rows in DEDUCTIBLE categories only — what a tax return can claim. */
  deductibleNet: number
}

/**
 * Sum any slice of expenses. Pure — no queries, no second source of truth.
 *
 * `deductibleNet` needs the category, so it reads the joined relation. A row whose
 * category is missing (uncategorised, or the category was hard-deleted) counts as
 * DEDUCTIBLE: the overwhelming majority of business spend is, and the alternative —
 * silently dropping uncategorised rows out of the claimable figure — understates
 * the deduction without telling anyone. The UI surfaces uncategorised rows instead,
 * where the owner can fix the cause rather than absorb a quiet subtraction.
 */
export function sumExpenses(rows: ExpenseWithRelations[]): ExpenseTotals {
  let gross = 0, tax = 0, deductibleNet = 0
  for (const r of rows) {
    const amt = Number(r.amount) || 0
    const t = Number(r.tax_amount) || 0
    gross += amt
    tax += t
    if (r.expense_categories?.tax_deductible !== false) deductibleNet += amt - t
  }
  return {
    gross: round2(gross),
    tax: round2(tax),
    net: round2(gross - tax),
    count: rows.length,
    deductibleNet: round2(deductibleNet),
  }
}

// ── Form ↔ row ───────────────────────────────────────────────────────────────

export function blankExpense(todayISO: string): ExpenseFormValues {
  return {
    vendor_id: '', category_id: '', job_id: '',
    amount: '', tax_amount: '',
    spent_at: todayISO,
    description: '', payment_method: '', reference: '', notes: '',
  }
}

export function expenseToForm(e: Expense): ExpenseFormValues {
  return {
    vendor_id: e.vendor_id || '',
    category_id: e.category_id || '',
    job_id: e.job_id || '',
    amount: String(e.amount),
    // A recorded 0 tax renders as '0', not '' — "this receipt had no tax" is a
    // fact the owner entered, and reopening the form must not downgrade it to
    // "unknown". This is the whole reason the form holds strings.
    tax_amount: e.tax_amount == null ? '' : String(e.tax_amount),
    spent_at: e.spent_at,
    description: e.description || '',
    payment_method: e.payment_method || '',
    reference: e.reference || '',
    notes: e.notes || '',
  }
}

export interface ExpenseValidation {
  ok: boolean
  errors: Partial<Record<keyof ExpenseFormValues, string>>
}

/**
 * Validate BEFORE hitting the DB — not instead of it. `expenses_tax_within_amount`
 * and the non-negative checks are constraints in Postgres and stay the authority;
 * these messages exist so the owner gets a sentence next to the field instead of a
 * 23514 in a toast. If the two ever disagree, the DB wins by design.
 */
export function validateExpense(v: ExpenseFormValues): ExpenseValidation {
  const errors: ExpenseValidation['errors'] = {}
  const amount = parseMoney(v.amount)
  const tax = parseMoney(v.tax_amount)

  if (v.amount.trim() === '') errors.amount = 'How much was it?'
  else if (amount == null) errors.amount = 'Enter an amount like 42.50'
  else if (amount < 0) errors.amount = 'An amount cannot be negative.'

  if (v.tax_amount.trim() !== '') {
    if (tax == null) errors.tax_amount = 'Enter a tax amount like 2.10'
    else if (tax < 0) errors.tax_amount = 'Tax cannot be negative.'
    else if (amount != null && tax > amount) {
      errors.tax_amount = 'Tax is included in the total, so it cannot be more than the amount.'
    }
  }

  if (!v.spent_at) errors.spent_at = 'When was it spent?'
  return { ok: Object.keys(errors).length === 0, errors }
}

/**
 * Form → row. Every '' becomes null EXCEPT tax, which becomes 0.
 *
 * That asymmetry is deliberate and load-bearing: `tax_amount` is NOT NULL DEFAULT 0
 * in the schema, and a blank tax field means "no tax on this receipt" — the common
 * case for a cash purchase from an unregistered supplier. Blank amount, by contrast,
 * never reaches here: validateExpense rejects it, because a 0 total is a real fact
 * ("free") and coercing an empty field into it would invent one.
 */
export function expenseFromForm(v: ExpenseFormValues) {
  return {
    vendor_id: v.vendor_id || null,
    category_id: v.category_id || null,
    job_id: v.job_id || null,
    amount: parseMoney(v.amount) ?? 0,
    tax_amount: v.tax_amount.trim() === '' ? 0 : (parseMoney(v.tax_amount) ?? 0),
    spent_at: v.spent_at,
    description: v.description.trim() || null,
    payment_method: v.payment_method || null,
    reference: v.reference.trim() || null,
    notes: v.notes.trim() || null,
  }
}

/**
 * '42.50' → 42.5 · '' → null · 'abc' → null.
 * Returns null for anything that isn't a number so the caller decides what a blank
 * means. Tolerates '$', thousands separators and whitespace — the owner is copying
 * off a receipt, not filling in a form.
 */
export function parseMoney(s: string): number | null {
  const cleaned = s.replace(/[$,\s]/g, '')
  if (cleaned === '') return null
  const n = Number(cleaned)
  return isFinite(n) ? round2(n) : null
}

// ── Reads ────────────────────────────────────────────────────────────────────

const EXPENSE_SELECT =
  '*, vendors(id, name), expense_categories(id, name, tax_deductible), jobs(id, title, scheduled_date)'

export interface ExpenseFilters {
  /** Inclusive 'YYYY-MM-DD' bounds on spent_at. */
  from?: string
  to?: string
  categoryId?: string
  vendorId?: string
  jobId?: string
  paymentMethod?: string
  /** Matched against description, reference and notes. */
  search?: string
}

/**
 * Every expense matching the filters — ALL of them, not the first thousand.
 *
 * Reports must never silently truncate: 1,400 expenses would produce a confident
 * P&L missing $Xk of cost, and nothing on screen would say so. Ordered by
 * (spent_at desc, id) so paging is stable — without the id tiebreak, two receipts
 * on the same day can straddle a page boundary and repeat or vanish.
 */
export async function listExpenses(
  sb: SupabaseClient,
  userId: string,
  filters: ExpenseFilters = {},
): Promise<{ rows: ExpenseWithRelations[]; error: string | null }> {
  return fetchAllRows<ExpenseWithRelations>(async (from, to) => {
    let q = sb
      .from('expenses')
      .select(EXPENSE_SELECT)
      .eq('user_id', userId)
      .is('archived_at', null)
      .order('spent_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to)

    if (filters.from) q = q.gte('spent_at', filters.from)
    if (filters.to) q = q.lte('spent_at', filters.to)
    if (filters.categoryId) q = q.eq('category_id', filters.categoryId)
    if (filters.vendorId) q = q.eq('vendor_id', filters.vendorId)
    if (filters.jobId) q = q.eq('job_id', filters.jobId)
    if (filters.paymentMethod) q = q.eq('payment_method', filters.paymentMethod)

    const term = orSafe(filters.search)
    if (term) q = q.or(`description.ilike.*${term}*,reference.ilike.*${term}*,notes.ilike.*${term}*`)

    const { data, error } = await q
    return { data: (data as unknown as ExpenseWithRelations[]) || [], error }
  })
}

export async function getExpense(sb: SupabaseClient, id: string): Promise<ExpenseWithRelations | null> {
  const { data } = await sb.from('expenses').select(EXPENSE_SELECT).eq('id', id).maybeSingle()
  return (data as unknown as ExpenseWithRelations) || null
}

/** Expenses booked against one job — the raw material of job costing. */
export async function listJobExpenses(
  sb: SupabaseClient,
  userId: string,
  jobId: string,
): Promise<ExpenseWithRelations[]> {
  const { rows } = await listExpenses(sb, userId, { jobId })
  return rows
}

// ── Writes ───────────────────────────────────────────────────────────────────

export async function createExpense(
  sb: SupabaseClient,
  p: { userId: string; values: ExpenseFormValues; receiptPath?: string | null },
): Promise<{ expense?: Expense; error?: string }> {
  const v = validateExpense(p.values)
  if (!v.ok) return { error: Object.values(v.errors)[0] }
  const { data, error } = await sb
    .from('expenses')
    .insert({ user_id: p.userId, ...expenseFromForm(p.values), receipt_path: p.receiptPath ?? null })
    .select()
    .single()
  if (error) return { error: constraintError(error) }
  return { expense: data as Expense }
}

export async function updateExpense(
  sb: SupabaseClient,
  id: string,
  values: ExpenseFormValues,
  receiptPath?: string | null,
): Promise<{ error?: string }> {
  const v = validateExpense(values)
  if (!v.ok) return { error: Object.values(v.errors)[0] }
  const patch: Record<string, unknown> = expenseFromForm(values)
  // undefined = "leave the receipt alone"; null = "the owner removed it". A plain
  // `?? null` here would wipe the receipt on every edit that didn't touch it.
  if (receiptPath !== undefined) patch.receipt_path = receiptPath
  const { error } = await sb.from('expenses').update(patch).eq('id', id)
  if (error) return { error: constraintError(error) }
  return {}
}

/**
 * Archive, never delete — and the receipt object stays put.
 *
 * A deleted expense is a hole in the books that no report can show. Archiving keeps
 * the row, keeps Undo instant, and keeps the receipt readable if a reassessment ever
 * asks. Purging the file here would make Undo restore a row pointing at nothing.
 */
export async function archiveExpense(sb: SupabaseClient, id: string): Promise<{ error?: string }> {
  const { error } = await sb.from('expenses').update({ archived_at: new Date().toISOString() }).eq('id', id)
  return error ? { error: error.message } : {}
}

export async function restoreExpense(sb: SupabaseClient, id: string): Promise<{ error?: string }> {
  const { error } = await sb.from('expenses').update({ archived_at: null }).eq('id', id)
  return error ? { error: error.message } : {}
}

// PostgREST's or() takes a COMMA-SEPARATED filter list, so a search for
// "Home Depot, Barrie" would be parsed as two filters and 400 the request; a
// stray ')' can break it the same way. Strip the syntax characters and the LIKE
// wildcards rather than rejecting the search — the owner typed a real receipt.
function orSafe(search: string | undefined): string | null {
  const t = (search || '').trim().replace(/[,()*%_\\]/g, ' ').replace(/\s+/g, ' ').trim()
  return t.length ? t : null
}

function constraintError(error: { code?: string; message: string }): string {
  // The DB is the authority on these; validateExpense should have caught them
  // first, so reaching here means a client-side rule drifted from the schema.
  if (error.code === '23514' && error.message.includes('tax_within_amount')) {
    return 'Tax is included in the total, so it cannot be more than the amount.'
  }
  if (error.code === '23514') return 'That amount is not valid.'
  return error.message
}
