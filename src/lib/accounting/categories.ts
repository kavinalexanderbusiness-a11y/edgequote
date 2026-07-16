import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExpenseCategory } from '@/types'

// ── Expense categories ───────────────────────────────────────────────────────
// Categories are the spine of every report: the P&L groups by them, the tax
// summary filters on `tax_deductible`, and the eventual QBO/Xero export maps
// `external_account` onto them. A business with no categories has an
// uncategorised P&L, which is a list of numbers rather than a report.
//
// So we ship defaults — but as CODE-DEFINED SEEDS the owner then OWNS, the same
// contract service_templates and CAMPAIGN_PRESETS use. Seeded once, on first
// visit; after that they are ordinary rows. Renaming "Fuel" to "Gas" or deleting
// one is permanent and correct, and re-seeding never resurrects it (see below).
//
// INDUSTRY-NEUTRAL on purpose. There is no industry picker in EdgeQuote and
// these must read as sane to a landscaper, an electrician and a cleaner alike —
// so no "Mulch", no "Wire", no "Chemicals". A trade-specific category is one the
// owner adds in five seconds, and one we would otherwise be guessing at.

export interface DefaultCategory {
  name: string
  tax_deductible: boolean
}

// Ordered as a small operator thinks about spend: what the trucks burn, what the
// work consumes, who helps, then the cost of being a business at all.
export const DEFAULT_EXPENSE_CATEGORIES: DefaultCategory[] = [
  { name: 'Fuel', tax_deductible: true },
  { name: 'Vehicle', tax_deductible: true },
  { name: 'Equipment', tax_deductible: true },
  { name: 'Materials', tax_deductible: true },
  { name: 'Subcontractor', tax_deductible: true },
  { name: 'Wages', tax_deductible: true },
  { name: 'Insurance', tax_deductible: true },
  { name: 'Licences & fees', tax_deductible: true },
  { name: 'Marketing', tax_deductible: true },
  { name: 'Office & admin', tax_deductible: true },
  { name: 'Software', tax_deductible: true },
  { name: 'Bank & merchant fees', tax_deductible: true },
  { name: 'Meals & entertainment', tax_deductible: true },
  // The two that are NOT deductible, and the reason `tax_deductible` is a column
  // rather than an assumption. Money genuinely leaves the business here — it
  // belongs in cash flow — but it is not an expense the owner can claim, and a
  // P&L that treats an owner draw as a cost understates profit and overstates
  // nothing the CRA will agree with.
  { name: 'Owner draw', tax_deductible: false },
  { name: 'Personal / non-business', tax_deductible: false },
]

export async function listCategories(sb: SupabaseClient, userId: string): Promise<ExpenseCategory[]> {
  const { data } = await sb
    .from('expense_categories')
    .select('*')
    .eq('user_id', userId)
    .is('archived_at', null)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })
  return (data as ExpenseCategory[]) || []
}

/**
 * Seed the defaults for an owner who has none — idempotent and non-destructive.
 *
 * Two rules make re-running safe:
 *  1. It seeds only when the owner has ZERO categories, archived ones included.
 *     Checking only ACTIVE rows would resurrect every default the owner had
 *     deliberately deleted, the moment they archived the last one.
 *  2. The insert ignores conflicts on the case-insensitive unique index, so a
 *     race between two tabs inserts each name at most once rather than erroring.
 *
 * Returns the resulting list so the caller can render without a second read.
 */
export async function seedDefaultCategories(sb: SupabaseClient, userId: string): Promise<ExpenseCategory[]> {
  const { count, error: countErr } = await sb
    .from('expense_categories')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
  // A failed count is NOT "zero categories" — seeding on an error would duplicate
  // a full set. supabase-js resolves {error} rather than throwing, so this must be
  // checked explicitly or the failure reads as an empty table.
  if (countErr) return []
  if ((count ?? 0) > 0) return listCategories(sb, userId)

  await sb.from('expense_categories').insert(
    DEFAULT_EXPENSE_CATEGORIES.map((c, i) => ({
      user_id: userId,
      name: c.name,
      tax_deductible: c.tax_deductible,
      sort_order: i,
    })),
  )
  return listCategories(sb, userId)
}

export async function createCategory(
  sb: SupabaseClient,
  p: { userId: string; name: string; tax_deductible: boolean; external_account?: string | null; sort_order?: number },
): Promise<{ category?: ExpenseCategory; error?: string }> {
  const name = p.name.trim()
  if (!name) return { error: 'Give the category a name.' }
  const { data, error } = await sb
    .from('expense_categories')
    .insert({
      user_id: p.userId,
      name,
      tax_deductible: p.tax_deductible,
      external_account: p.external_account?.trim() || null,
      sort_order: p.sort_order ?? 999,
    })
    .select()
    .single()
  if (error) return { error: duplicateNameError(error, name) }
  return { category: data as ExpenseCategory }
}

export async function updateCategory(
  sb: SupabaseClient,
  id: string,
  patch: Partial<Pick<ExpenseCategory, 'name' | 'tax_deductible' | 'external_account' | 'sort_order'>>,
): Promise<{ error?: string }> {
  const clean = { ...patch }
  if (typeof clean.name === 'string') clean.name = clean.name.trim()
  if (clean.name === '') return { error: 'Give the category a name.' }
  if (typeof clean.external_account === 'string') clean.external_account = clean.external_account.trim() || null
  const { error } = await sb.from('expense_categories').update(clean).eq('id', id)
  if (error) return { error: duplicateNameError(error, clean.name || 'that name') }
  return {}
}

/**
 * Archive, never delete. Expenses point at categories ON DELETE SET NULL, so a
 * hard delete would silently un-categorise historical spend — the money would
 * survive but every prior P&L would reshape itself. Archiving keeps old rows
 * grouped exactly as they were filed while removing the category from the picker.
 */
export async function archiveCategory(sb: SupabaseClient, id: string): Promise<{ error?: string }> {
  const { error } = await sb
    .from('expense_categories')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id)
  return error ? { error: error.message } : {}
}

export async function restoreCategory(sb: SupabaseClient, id: string): Promise<{ error?: string }> {
  const { error } = await sb.from('expense_categories').update({ archived_at: null }).eq('id', id)
  // Restoring collides with the partial unique index if the owner made a new
  // category with the same name in the meantime. Say that, don't dump 23505.
  if (error) return { error: duplicateNameError(error, 'that name') }
  return {}
}

/** How many expenses reference a category — the honest thing to show before archiving. */
export async function categoryUsage(sb: SupabaseClient, id: string): Promise<number> {
  const { count } = await sb
    .from('expenses')
    .select('id', { count: 'exact', head: true })
    .eq('category_id', id)
    .is('archived_at', null)
  return count ?? 0
}

// The unique index is case-insensitive, so the DB — not the app — is what stops
// "Fuel" and "fuel" becoming two lines in the P&L. Translate its error into the
// sentence that actually explains what happened.
function duplicateNameError(error: { code?: string; message: string }, name: string): string {
  if (error.code === '23505') return `You already have a category called "${name}".`
  return error.message
}
