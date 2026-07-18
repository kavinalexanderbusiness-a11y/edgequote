import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  FixedAsset, FixedAssetFormValues, Liability, LiabilityFormValues, BusinessSettings,
} from '@/types'
import { parseMoney } from '@/lib/accounting/expenses'

// ── Writes for the balance-sheet inputs ──────────────────────────────────────
// Assets, liabilities and the opening position. Same shape as vendors.ts /
// categories.ts: validate here for a sentence next to the field, and let the DB
// constraints stay the authority. Where the two disagree, the DB wins.

// ── Fixed assets ─────────────────────────────────────────────────────────────

export function blankAsset(todayISO: string): FixedAssetFormValues {
  return {
    name: '', vendor_id: '', cost: '', tax_amount: '',
    in_service_date: todayISO,
    method: 'straight_line',
    // 5 years is a PLACEHOLDER, not a guess the engine will silently use: the field
    // is required for straight line and validated below. The DB refuses the row
    // without it rather than depreciating on an assumption.
    useful_life_years: '5',
    salvage_value: '', declining_rate: '', disposed_at: '', disposal_proceeds: '', notes: '',
  }
}

export function assetToForm(a: FixedAsset): FixedAssetFormValues {
  return {
    name: a.name,
    vendor_id: a.vendor_id || '',
    cost: String(a.cost),
    tax_amount: a.tax_amount == null ? '' : String(a.tax_amount),
    in_service_date: a.in_service_date,
    method: a.method,
    useful_life_years: a.useful_life_years == null ? '' : String(a.useful_life_years),
    salvage_value: a.salvage_value == null ? '' : String(a.salvage_value),
    declining_rate: a.declining_rate == null ? '' : String(a.declining_rate),
    disposed_at: a.disposed_at || '',
    disposal_proceeds: a.disposal_proceeds == null ? '' : String(a.disposal_proceeds),
    notes: a.notes || '',
  }
}

export interface AssetValidation {
  ok: boolean
  errors: Partial<Record<keyof FixedAssetFormValues, string>>
}

export function validateAsset(v: FixedAssetFormValues): AssetValidation {
  const errors: AssetValidation['errors'] = {}
  const cost = parseMoney(v.cost)
  const salvage = v.salvage_value.trim() === '' ? 0 : parseMoney(v.salvage_value)
  const tax = v.tax_amount.trim() === '' ? 0 : parseMoney(v.tax_amount)

  if (!v.name.trim()) errors.name = 'What is it?'
  if (v.cost.trim() === '') errors.cost = 'What did it cost?'
  else if (cost == null || cost < 0) errors.cost = 'Enter a cost like 4200.00'

  if (tax == null || tax < 0) errors.tax_amount = 'Enter a tax amount like 210.00'
  else if (cost != null && tax > cost) errors.tax_amount = 'Tax is included in the cost, so it cannot exceed it.'

  if (salvage == null || salvage < 0) errors.salvage_value = 'Enter a value like 500.00'
  else if (cost != null && salvage > cost) errors.salvage_value = "It can't be worth more at the end than it cost."

  if (!v.in_service_date) errors.in_service_date = 'When did you start using it?'

  // Mirrors the DB's fixed_assets_sl_needs_life / _db_needs_rate. A schedule with no
  // life isn't a schedule, and the engine will not invent one.
  if (v.method === 'straight_line') {
    const life = Number(v.useful_life_years)
    if (!v.useful_life_years.trim() || !isFinite(life) || life <= 0) {
      errors.useful_life_years = 'How many years will it last? Straight line needs this.'
    }
  }
  if (v.method === 'declining_balance') {
    const rate = Number(v.declining_rate)
    if (!v.declining_rate.trim() || !isFinite(rate) || rate <= 0 || rate > 100) {
      errors.declining_rate = 'Enter a rate between 0 and 100 (e.g. 20 for 20% a year).'
    }
  }
  if (v.disposed_at && v.disposed_at < v.in_service_date) {
    errors.disposed_at = "You can't sell it before you started using it."
  }
  return { ok: Object.keys(errors).length === 0, errors }
}

export function assetFromForm(v: FixedAssetFormValues) {
  return {
    name: v.name.trim(),
    vendor_id: v.vendor_id || null,
    cost: parseMoney(v.cost) ?? 0,
    tax_amount: v.tax_amount.trim() === '' ? 0 : (parseMoney(v.tax_amount) ?? 0),
    in_service_date: v.in_service_date,
    method: v.method,
    // Null the field the OTHER method doesn't use: a stale 5-year life left on a
    // declining-balance asset is a trap for whoever reads the row next.
    useful_life_years: v.method === 'straight_line' ? Number(v.useful_life_years) || null : null,
    salvage_value: v.salvage_value.trim() === '' ? 0 : (parseMoney(v.salvage_value) ?? 0),
    declining_rate: v.method === 'declining_balance' ? Number(v.declining_rate) || null : null,
    disposed_at: v.disposed_at || null,
    disposal_proceeds: v.disposed_at && v.disposal_proceeds.trim() !== '' ? parseMoney(v.disposal_proceeds) : null,
    notes: v.notes.trim() || null,
  }
}

export async function listAssets(sb: SupabaseClient, userId: string): Promise<FixedAsset[]> {
  const { data } = await sb
    .from('fixed_assets').select('*').eq('user_id', userId)
    .is('archived_at', null).order('in_service_date', { ascending: false })
  return (data as FixedAsset[]) || []
}

export async function createAsset(
  sb: SupabaseClient, p: { userId: string; values: FixedAssetFormValues },
): Promise<{ asset?: FixedAsset; error?: string }> {
  const v = validateAsset(p.values)
  if (!v.ok) return { error: Object.values(v.errors)[0] }
  const { data, error } = await sb
    .from('fixed_assets').insert({ user_id: p.userId, ...assetFromForm(p.values) }).select().single()
  if (error) return { error: assetError(error) }
  return { asset: data as FixedAsset }
}

export async function updateAsset(
  sb: SupabaseClient, id: string, values: FixedAssetFormValues,
): Promise<{ error?: string }> {
  const v = validateAsset(values)
  if (!v.ok) return { error: Object.values(v.errors)[0] }
  const { error } = await sb.from('fixed_assets').update(assetFromForm(values)).eq('id', id)
  if (error) return { error: assetError(error) }
  return {}
}

/** Archive, never delete: an asset's cost basis is the evidence behind a tax claim. */
export async function archiveAsset(sb: SupabaseClient, id: string): Promise<{ error?: string }> {
  const { error } = await sb.from('fixed_assets').update({ archived_at: new Date().toISOString() }).eq('id', id)
  return error ? { error: error.message } : {}
}

export async function restoreAsset(sb: SupabaseClient, id: string): Promise<{ error?: string }> {
  const { error } = await sb.from('fixed_assets').update({ archived_at: null }).eq('id', id)
  return error ? { error: error.message } : {}
}

// Turn the DB's own guards into sentences. The constraint is the authority; this is
// just the translation, and the names are the ones in the migration.
function assetError(e: { message?: string; code?: string }): string {
  const m = e.message || ''
  if (m.includes('fixed_assets_sl_needs_life')) return 'Straight line needs a useful life in years.'
  if (m.includes('fixed_assets_db_needs_rate')) return 'Declining balance needs a rate.'
  if (m.includes('fixed_assets_salvage_within_cost')) return "It can't be worth more at the end than it cost."
  if (m.includes('fixed_assets_tax_within_cost')) return 'Tax is included in the cost, so it cannot exceed it.'
  if (m.includes('fixed_assets_disposal_after_service')) return "You can't sell it before you started using it."
  return m || 'Could not save that asset.'
}

// ── Liabilities ──────────────────────────────────────────────────────────────

export function blankLiability(todayISO: string): LiabilityFormValues {
  return { name: '', kind: 'loan', current_balance: '', as_of_date: todayISO, interest_rate: '', notes: '' }
}

export function liabilityToForm(l: Liability): LiabilityFormValues {
  return {
    name: l.name,
    kind: l.kind,
    current_balance: String(l.current_balance),
    as_of_date: l.as_of_date,
    interest_rate: l.interest_rate == null ? '' : String(l.interest_rate),
    notes: l.notes || '',
  }
}

export function validateLiability(v: LiabilityFormValues): { ok: boolean; errors: Partial<Record<keyof LiabilityFormValues, string>> } {
  const errors: Partial<Record<keyof LiabilityFormValues, string>> = {}
  const bal = parseMoney(v.current_balance)
  if (!v.name.trim()) errors.name = 'What is it?'
  if (v.current_balance.trim() === '') errors.current_balance = 'How much is still owed?'
  // Negative is refused, not flipped: a "negative loan" is an asset, and guessing
  // which the owner meant would silently move money across the balance sheet.
  else if (bal == null || bal < 0) errors.current_balance = 'Enter what you owe, as a positive number.'
  if (!v.as_of_date) errors.as_of_date = 'When was this the balance?'
  return { ok: Object.keys(errors).length === 0, errors }
}

export function liabilityFromForm(v: LiabilityFormValues) {
  return {
    name: v.name.trim(),
    kind: v.kind,
    current_balance: parseMoney(v.current_balance) ?? 0,
    as_of_date: v.as_of_date,
    interest_rate: v.interest_rate.trim() === '' ? null : (parseMoney(v.interest_rate) ?? null),
    notes: v.notes.trim() || null,
  }
}

export async function listLiabilities(sb: SupabaseClient, userId: string): Promise<Liability[]> {
  const { data } = await sb
    .from('liabilities').select('*').eq('user_id', userId)
    .is('archived_at', null).order('as_of_date', { ascending: false })
  return (data as Liability[]) || []
}

export async function createLiability(
  sb: SupabaseClient, p: { userId: string; values: LiabilityFormValues },
): Promise<{ error?: string }> {
  const v = validateLiability(p.values)
  if (!v.ok) return { error: Object.values(v.errors)[0] }
  const { error } = await sb.from('liabilities').insert({ user_id: p.userId, ...liabilityFromForm(p.values) })
  return error ? { error: error.message } : {}
}

export async function updateLiability(
  sb: SupabaseClient, id: string, values: LiabilityFormValues,
): Promise<{ error?: string }> {
  const v = validateLiability(values)
  if (!v.ok) return { error: Object.values(v.errors)[0] }
  const { error } = await sb.from('liabilities').update(liabilityFromForm(values)).eq('id', id)
  return error ? { error: error.message } : {}
}

export async function archiveLiability(sb: SupabaseClient, id: string): Promise<{ error?: string }> {
  const { error } = await sb.from('liabilities').update({ archived_at: new Date().toISOString() }).eq('id', id)
  return error ? { error: error.message } : {}
}

// ── Opening position ─────────────────────────────────────────────────────────

export interface OpeningValues {
  opening_bank_balance: string
  opening_balance_date: string
  opening_equity: string
}

export function openingFromSettings(s: BusinessSettings | null | undefined): OpeningValues {
  return {
    opening_bank_balance: s?.opening_bank_balance == null ? '' : String(s.opening_bank_balance),
    opening_balance_date: s?.opening_balance_date || '',
    opening_equity: s?.opening_equity == null ? '' : String(s.opening_equity),
  }
}

/**
 * Save the opening position.
 *
 * A blank field writes NULL, not 0 — and that distinction is the whole point. NULL
 * means "unknown", which makes the balance sheet report an unexplained difference
 * instead of quietly inventing capital to force Assets = Liabilities + Equity. A 0
 * would be a claim: "the owner put nothing in", which is almost never true and would
 * silently absorb the gap this module exists to surface.
 */
export async function saveOpening(
  sb: SupabaseClient, userId: string, v: OpeningValues,
): Promise<{ error?: string }> {
  const balance = v.opening_bank_balance.trim() === '' ? null : parseMoney(v.opening_bank_balance)
  const equity = v.opening_equity.trim() === '' ? null : parseMoney(v.opening_equity)

  if (v.opening_bank_balance.trim() !== '' && balance == null) return { error: 'Enter a bank balance like 2500.00' }
  if (v.opening_equity.trim() !== '' && equity == null) return { error: 'Enter an amount like 5000.00' }
  // A balance with no date is unusable: "cash = opening + movements since WHEN?"
  if (balance != null && !v.opening_balance_date) return { error: 'Which date was that balance true on?' }

  const { error } = await sb
    .from('business_settings')
    .update({
      opening_bank_balance: balance,
      opening_balance_date: v.opening_balance_date || null,
      opening_equity: equity,
    })
    .eq('user_id', userId)
  return error ? { error: error.message } : {}
}
