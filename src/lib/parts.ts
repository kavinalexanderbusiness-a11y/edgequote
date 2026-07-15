import type { SupabaseClient } from '@supabase/supabase-js'
import type { Tone } from '@/lib/tone'
import type { ServiceKind } from '@/lib/equipment'

// ── THE parts engine ─────────────────────────────────────────────────────────
// Stock questions only: what a part is, whether you're short, what the shelf is
// worth. It deliberately owns NO maintenance maths — a machine's service cost and
// cost-of-ownership stay in lib/equipment, computed from equipment_service.cost,
// exactly as before. Consuming a part prefills that ONE cost field; it never adds
// a second cost path.

export type PartCategory = 'blade' | 'oil' | 'filter' | 'spark_plug' | 'belt' | 'tire' | 'fluid' | 'other'
export type MovementKind = 'restock' | 'use' | 'adjust'

export interface Part {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  name: string
  sku: string | null
  category: PartCategory
  unit: string
  /** Derived by the DB trigger from part_movements — never written by app code. */
  qty_on_hand: number
  reorder_at: number | null
  unit_cost: number | null
  supplier: string | null
  notes: string | null
}

export interface PartMovement {
  id: string
  created_at: string
  user_id: string
  part_id: string
  kind: MovementKind
  /** Signed: +in, −out. Stock is the sum. */
  qty: number
  unit_cost: number | null
  equipment_service_id: string | null
  notes: string | null
}

export const PART_CATEGORIES: { value: PartCategory; label: string }[] = [
  { value: 'blade', label: 'Blade' },
  { value: 'oil', label: 'Oil' },
  { value: 'filter', label: 'Filter' },
  { value: 'spark_plug', label: 'Spark plug' },
  { value: 'belt', label: 'Belt' },
  { value: 'tire', label: 'Tire' },
  { value: 'fluid', label: 'Fluid' },
  { value: 'other', label: 'Other' },
]
export const PART_UNITS = ['each', 'L', 'qt', 'kg']

export function partCategoryLabel(c: PartCategory): string {
  return PART_CATEGORIES.find(p => p.value === c)?.label ?? 'Other'
}

// Which parts a given service naturally reaches for — so logging an oil change
// offers your oil first instead of the whole shelf. Presentation only: the owner
// can still pick anything.
const KIND_TO_CATEGORY: Partial<Record<ServiceKind, PartCategory[]>> = {
  oil: ['oil', 'filter'],
  blade: ['blade'],
  filter: ['filter'],
  spark_plug: ['spark_plug'],
  tire: ['tire'],
  tune_up: ['oil', 'filter', 'spark_plug', 'belt'],
  repair: ['belt', 'blade', 'filter', 'other'],
}
export function suggestedCategories(kind: ServiceKind): PartCategory[] {
  return KIND_TO_CATEGORY[kind] ?? []
}

export type StockState = 'out' | 'low' | 'ok' | 'untracked'

export interface StockStatus {
  state: StockState
  /** Always says why, in the part's own unit. */
  reason: string
  tone: Tone
}

// Out at zero (or below — a negative count means the ledger says you used more
// than you logged buying, which is worth showing rather than hiding at 0).
export function stockStatus(p: Part): StockStatus {
  const qty = Number(p.qty_on_hand) || 0
  const unit = p.unit === 'each' ? '' : ` ${p.unit}`
  if (qty <= 0) {
    return { state: 'out', reason: qty < 0 ? `Ledger says ${qty}${unit} — recount` : 'Out of stock', tone: 'danger' }
  }
  if (p.reorder_at == null) {
    return { state: 'untracked', reason: `${qty}${unit} on hand`, tone: 'neutral' }
  }
  if (qty <= Number(p.reorder_at)) {
    return { state: 'low', reason: `${qty}${unit} left — reorder at ${p.reorder_at}${unit}`, tone: 'warn' }
  }
  return { state: 'ok', reason: `${qty}${unit} on hand`, tone: 'success' }
}

/** What a part's shelf is worth right now. */
export function partValue(p: Part): number {
  return round2((Number(p.qty_on_hand) || 0) * (Number(p.unit_cost) || 0))
}

/** Shelf rollup for the page's stat strip — one place, so tiles can't drift. */
export function inventorySummary(parts: Part[]) {
  const needing = parts.filter(p => { const s = stockStatus(p).state; return s === 'low' || s === 'out' })
  return {
    partCount: parts.length,
    needingReorder: needing.length,
    outCount: parts.filter(p => stockStatus(p).state === 'out').length,
    shelfValue: round2(parts.reduce((s, p) => s + partValue(p), 0)),
  }
}

/** What a picked set of parts is worth — prefills the service's ONE cost field. */
export function pickedValue(picks: { part: Part; qty: number }[]): number {
  return round2(picks.reduce((s, p) => s + (Number(p.part.unit_cost) || 0) * (Number(p.qty) || 0), 0))
}

// ── Movements (the only way stock moves) ─────────────────────────────────────

/** Record consumption against a service. CASCADE returns them if it's reverted. */
export async function consumeParts(
  sb: SupabaseClient,
  opts: { userId: string; serviceId: string; picks: { part: Part; qty: number }[] },
): Promise<{ error?: string }> {
  const rows = opts.picks
    .filter(p => Number(p.qty) > 0)
    .map(p => ({
      user_id: opts.userId,
      part_id: p.part.id,
      kind: 'use' as const,
      qty: -Math.abs(Number(p.qty)),          // signed out
      unit_cost: p.part.unit_cost,
      equipment_service_id: opts.serviceId,
    }))
  if (!rows.length) return {}
  const { error } = await sb.from('part_movements').insert(rows)
  return error ? { error: error.message } : {}
}

export async function restockPart(
  sb: SupabaseClient,
  opts: { userId: string; partId: string; qty: number; unitCost?: number | null; notes?: string | null },
): Promise<{ error?: string }> {
  const { error } = await sb.from('part_movements').insert({
    user_id: opts.userId, part_id: opts.partId, kind: 'restock',
    qty: Math.abs(Number(opts.qty)), unit_cost: opts.unitCost ?? null, notes: opts.notes ?? null,
  })
  return error ? { error: error.message } : {}
}

/** A counted correction — the delta needed to reach `counted`. */
export async function adjustPart(
  sb: SupabaseClient,
  opts: { userId: string; part: Part; counted: number; notes?: string | null },
): Promise<{ error?: string }> {
  const delta = round2(Number(opts.counted) - (Number(opts.part.qty_on_hand) || 0))
  if (delta === 0) return {}
  const { error } = await sb.from('part_movements').insert({
    user_id: opts.userId, part_id: opts.part.id, kind: 'adjust', qty: delta,
    notes: opts.notes ?? `Counted ${opts.counted}`,
  })
  return error ? { error: error.message } : {}
}

function round2(n: number) { return Math.round(n * 100) / 100 }
