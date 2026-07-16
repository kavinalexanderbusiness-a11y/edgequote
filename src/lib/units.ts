import type { SupabaseClient } from '@supabase/supabase-js'

// ── THE unit-of-work vocabulary ───────────────────────────────────────────────
// A quote line has always been `quantity × unit_price` (lib/quoteServices
// serviceLineTotals). The maths was never lawn-specific — the unit simply had no
// vocabulary and defaulted to the free-text string 'each'. This is that
// vocabulary, and nothing more.
//
// THE RULE: a unit is a LABEL and a formatting rule. It NEVER enters the
// arithmetic. That is the whole reason nine units are safe to add — no total
// anywhere changes, because nothing here is consulted while computing one.
//
// NOT IN SCOPE — and never will be: lib/pricing.ts. Lawn is
// `base + (sqft/1000 × rate)` with cadence multipliers, overgrowth and
// seasonality. It is NOT quantity × rate, is not expressible as a unit, and must
// never be routed through here. servicePricingKind() already keeps the two
// families apart; this lives strictly on the generic side of that seam.

export interface ServiceUnit {
  id: string
  user_id: string | null    // null = a system unit, shared by every owner
  code: string
  label: string             // "Square feet"
  abbrev: string            // "sq ft"
  step: number              // quantity input step (hours move in 0.25)
  decimals: number          // decimals when displaying a quantity
  sort_order: number
  active: boolean
}

export const UNIT_SELECT = 'id, user_id, code, label, abbrev, step, decimals, sort_order, active'

// The code every pre-existing line already carries, so it must always resolve.
export const DEFAULT_UNIT_CODE = 'each'

// A last-resort unit for a code we can't find. Never written — it only keeps a
// legacy or deleted code rendering as itself instead of vanishing from a quote.
function syntheticUnit(code: string): ServiceUnit {
  return {
    id: `synthetic:${code}`, user_id: null, code,
    label: code, abbrev: code, step: 1, decimals: 0, sort_order: 999, active: true,
  }
}

// The owner's vocabulary: system units + their own customs, in display order.
// RLS does the filtering — a select returns exactly (system ∪ mine).
export async function loadServiceUnits(sb: SupabaseClient): Promise<ServiceUnit[]> {
  const { data, error } = await sb
    .from('service_units')
    .select(UNIT_SELECT)
    .eq('active', true)
    .order('sort_order', { ascending: true })
  if (error) return []
  return (data as ServiceUnit[]) || []
}

// Resolve a stored code against the vocabulary. Lines written before units
// existed carry free text, so an unknown code renders as itself rather than
// being dropped — a quote must never lose a word it was written with.
export function resolveUnit(units: ServiceUnit[], code: string | null | undefined): ServiceUnit {
  const c = (code || '').trim()
  if (!c) return units.find(u => u.code === DEFAULT_UNIT_CODE) ?? syntheticUnit(DEFAULT_UNIT_CODE)
  return units.find(u => u.code === c) ?? syntheticUnit(c)
}

// "6 fixtures" · "1,200 sq ft" · "2.5 hr". Display only — callers still total
// with serviceLineTotals, which never sees a unit.
export function formatQuantity(units: ServiceUnit[], code: string | null | undefined, qty: number): string {
  const u = resolveUnit(units, code)
  const n = Number(qty) || 0
  const num = new Intl.NumberFormat('en-CA', {
    minimumFractionDigits: u.decimals, maximumFractionDigits: u.decimals,
  }).format(n)
  // 'flat' is a shape of deal, not a count — "1 flat" reads like a typo.
  if (u.code === 'flat') return 'Flat rate'
  return `${num} ${u.abbrev}`
}

// "$95/hr" · "$3.00/sq ft" · "$65 flat". The per-unit rate label for a line.
// formatServicePrice() still owns the TEMPLATE catalogue's wording; this is the
// line-level twin for a unit that has no template behind it.
export function formatUnitRate(units: ServiceUnit[], code: string | null | undefined, rate: number): string {
  const u = resolveUnit(units, code)
  const n = Number(rate) || 0
  // Per-unit rates keep cents when fractional; whole dollars drop them.
  const money = new Intl.NumberFormat('en-CA', {
    style: 'currency', currency: 'CAD',
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2,
  }).format(n)
  if (u.code === 'flat') return `${money} flat`
  return `${money}/${u.abbrev}`
}

// ── Custom units (owner-defined) ──────────────────────────────────────────────
// A custom unit is a row, which is the point of a table over an enum: naming a
// tenth unit costs an INSERT, not a deploy. It carries no maths — if a unit ever
// needs its own formula it isn't a unit, it's a pricing engine, and that is a
// different conversation.
export function normalizeUnitCode(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32)
}

export async function addCustomUnit(
  sb: SupabaseClient,
  userId: string,
  input: { label: string; abbrev?: string; step?: number; decimals?: number },
): Promise<{ error?: string; unit?: ServiceUnit }> {
  const label = input.label.trim()
  if (!label) return { error: 'Give the unit a name.' }
  const code = normalizeUnitCode(label)
  if (!code) return { error: 'Give the unit a name using letters or numbers.' }
  const { data, error } = await sb.from('service_units').insert({
    user_id: userId, code, label,
    abbrev: (input.abbrev || '').trim() || label.toLowerCase(),
    step: input.step && input.step > 0 ? input.step : 1,
    decimals: input.decimals && input.decimals > 0 ? input.decimals : 0,
    sort_order: 500,
  }).select(UNIT_SELECT).single()
  // 23505 = the per-user partial unique index. Say what happened, in their words.
  if (error) return { error: error.code === '23505' ? `You already have a unit called “${label}”.` : error.message }
  return { unit: data as ServiceUnit }
}

// Deactivate rather than delete: a quote written last season still references
// the code, and history must keep rendering the word it was quoted in.
export async function deactivateCustomUnit(sb: SupabaseClient, id: string): Promise<{ error?: string }> {
  const { error } = await sb.from('service_units').update({ active: false }).eq('id', id)
  return error ? { error: error.message } : {}
}
