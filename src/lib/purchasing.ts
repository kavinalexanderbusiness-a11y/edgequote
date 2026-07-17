import type { SupabaseClient } from '@supabase/supabase-js'
import type { Tone } from '@/lib/tone'
import type { Part, PartMovement } from '@/lib/parts'

// ── THE purchasing engine ────────────────────────────────────────────────────
// Purchase orders, receiving, and what you've bought from whom.
//
// IT OWNS NO STOCK MATHS. Receiving inserts a part_movements(kind='restock')
// row and stops; recompute_part_stock recomputes parts.qty_on_hand as sum(qty),
// exactly as it already does for 'use' and 'adjust'. Nothing in this file writes
// qty_on_hand, and nothing here re-implements stockStatus/partValue — those stay
// in lib/parts, the one engine that answers "how much have I got".
//
// ⚠️ RECEIVED QUANTITY IS DERIVED, NEVER STORED.
// purchase_order_items has no qty_received column on purpose. Storing "how much
// arrived" beside a ledger that already knows creates two answers to one
// question, and they drift the moment a movement is deleted, a receipt reverted
// or a count adjusted. receivedQty() sums the movements linked to the line — so
// the receipt and the stock are literally the same rows.
//
// Status mirrors the invoices pattern (lib/payments/ledger.displayInvoiceStatus):
//   STORED  = draft | ordered | cancelled  — the workflow the owner drives
//   DERIVED = partial | received           — read from the ledger
// so a PO can never claim "received" while the stock says otherwise.

export type PoStatus = 'draft' | 'ordered' | 'cancelled'
/** Stored status widened with what the ledger says actually arrived. */
export type PoDisplayStatus = PoStatus | 'partial' | 'received'

export interface PurchaseOrder {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  supplier_id: string | null
  po_number: string | null
  status: PoStatus
  ordered_at: string | null
  expected_at: string | null
  notes: string | null
}

export interface PurchaseOrderItem {
  id: string
  created_at: string
  user_id: string
  purchase_order_id: string
  part_id: string
  qty_ordered: number
  unit_cost: number | null
  notes: string | null
  // No qty_received — see the header.
}

/** A movement that carries a receipt link. */
export type ReceiptMovement = PartMovement & { purchase_order_item_id?: string | null }

export const PO_STATUSES: { value: PoStatus; label: string }[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'ordered', label: 'Ordered' },
  { value: 'cancelled', label: 'Cancelled' },
]

const round2 = (n: number) => Math.round(n * 100) / 100

// ── Derived receipt state (the ledger is the only source) ────────────────────

/** How much of this line has actually arrived = the sum of its receipts. */
export function receivedQty(itemId: string, movements: ReceiptMovement[]): number {
  return round2(movements
    .filter(m => m.purchase_order_item_id === itemId)
    .reduce((s, m) => s + (Number(m.qty) || 0), 0))
}

/** What's still owed on a line. Never negative — an over-receipt isn't "-2 due". */
export function outstandingQty(item: PurchaseOrderItem, movements: ReceiptMovement[]): number {
  return Math.max(0, round2(Number(item.qty_ordered || 0) - receivedQty(item.id, movements)))
}

export type LineState = 'none' | 'partial' | 'received' | 'over'

export function lineState(item: PurchaseOrderItem, movements: ReceiptMovement[]): LineState {
  const got = receivedQty(item.id, movements)
  const want = Number(item.qty_ordered) || 0
  if (got <= 0) return 'none'
  // Over-receipt is shown, not clamped: the supplier sent more than you ordered
  // and the stock is real. Hiding it would make the shelf disagree with the page.
  if (got > want) return 'over'
  return got >= want ? 'received' : 'partial'
}

/**
 * THE PO status. Stored workflow, overlaid with what the ledger says arrived.
 * 'cancelled' is terminal and passes through untouched — the same rule
 * displayInvoiceStatus follows for a cancelled invoice.
 */
export function poDisplayStatus(
  po: PurchaseOrder, items: PurchaseOrderItem[], movements: ReceiptMovement[],
): PoDisplayStatus {
  if (po.status === 'cancelled') return 'cancelled'
  const mine = items.filter(i => i.purchase_order_id === po.id)
  if (mine.length === 0) return po.status
  const states = mine.map(i => lineState(i, movements))
  if (states.every(s => s === 'received' || s === 'over')) return 'received'
  if (states.some(s => s !== 'none')) return 'partial'
  return po.status
}

export const PO_STATUS_LABELS: Record<PoDisplayStatus, string> = {
  draft: 'Draft', ordered: 'Ordered', partial: 'Partly received',
  received: 'Received', cancelled: 'Cancelled',
}
export const PO_STATUS_TONES: Record<PoDisplayStatus, Tone> = {
  draft: 'neutral', ordered: 'info', partial: 'warn', received: 'success', cancelled: 'neutral',
}

/** Line cost — the PO's own unit_cost wins; the part's is the fallback. */
export function lineCost(item: PurchaseOrderItem, part?: Part | null): number {
  const unit = item.unit_cost ?? part?.unit_cost ?? 0
  return round2((Number(item.qty_ordered) || 0) * (Number(unit) || 0))
}

export function poTotal(items: PurchaseOrderItem[], partsById: Map<string, Part>): number {
  return round2(items.reduce((s, i) => s + lineCost(i, partsById.get(i.part_id)), 0))
}

// ── Vendor purchase history ──────────────────────────────────────────────────
// Spend is what was actually RECEIVED, valued at what that receipt cost — read
// from the movement rows, not from what was ordered. An ordered-but-never-
// delivered PO is not money spent, and claiming it would be inventing a number.

export interface VendorHistory {
  orders: number
  /** Money against goods that actually arrived. */
  spend: number
  lastOrderedAt: string | null
}

export function vendorHistory(
  supplierId: string,
  pos: PurchaseOrder[],
  items: PurchaseOrderItem[],
  movements: ReceiptMovement[],
): VendorHistory {
  const mine = pos.filter(p => p.supplier_id === supplierId && p.status !== 'cancelled')
  const poIds = new Set(mine.map(p => p.id))
  const myItems = items.filter(i => poIds.has(i.purchase_order_id))
  const itemById = new Map(myItems.map(i => [i.id, i]))
  // Value each RECEIPT at its own unit_cost — what you actually paid on the day.
  const spend = movements.reduce((s, m) => {
    if (!m.purchase_order_item_id) return s
    const item = itemById.get(m.purchase_order_item_id)
    if (!item) return s
    const unit = m.unit_cost ?? item.unit_cost ?? 0
    return s + (Number(m.qty) || 0) * (Number(unit) || 0)
  }, 0)
  const dates = mine.map(p => p.ordered_at).filter(Boolean) as string[]
  return {
    orders: mine.length,
    spend: round2(spend),
    lastOrderedAt: dates.length ? dates.sort().slice(-1)[0] : null,
  }
}

// ── Loaders / writers ────────────────────────────────────────────────────────

export async function loadPurchaseOrders(sb: SupabaseClient): Promise<{
  pos: PurchaseOrder[]; items: PurchaseOrderItem[]; movements: ReceiptMovement[]; error?: string
}> {
  const { data: { session } } = await sb.auth.getSession()
  const user = session?.user
  if (!user) return { pos: [], items: [], movements: [] }
  const [pRes, iRes, mRes] = await Promise.all([
    sb.from('purchase_orders').select('*').eq('user_id', user.id).order('created_at', { ascending: false }),
    sb.from('purchase_order_items').select('*').eq('user_id', user.id),
    // Only receipt movements — the rest of the ledger isn't purchasing's business.
    sb.from('part_movements').select('*').eq('user_id', user.id).not('purchase_order_item_id', 'is', null),
  ])
  const error = pRes.error?.message || iRes.error?.message || mRes.error?.message
  // Never render a PO list that lost its receipts: every line would read
  // "nothing arrived" and invite receiving the same goods twice.
  if (error) return { pos: [], items: [], movements: [], error }
  return {
    pos: (pRes.data as PurchaseOrder[]) || [],
    items: (iRes.data as PurchaseOrderItem[]) || [],
    movements: (mRes.data as ReceiptMovement[]) || [],
  }
}

export async function savePurchaseOrder(
  sb: SupabaseClient,
  opts: { userId: string; id?: string | null; values: Partial<PurchaseOrder> },
): Promise<{ error?: string; po?: PurchaseOrder }> {
  const row = { ...opts.values, updated_at: new Date().toISOString() }
  const q = opts.id
    ? sb.from('purchase_orders').update(row).eq('id', opts.id).select('*').single()
    : sb.from('purchase_orders').insert({ ...row, user_id: opts.userId }).select('*').single()
  const { data, error } = await q
  return error ? { error: error.message } : { po: data as PurchaseOrder }
}

export async function savePoItem(
  sb: SupabaseClient,
  opts: { userId: string; poId: string; partId: string; qty: number; unitCost?: number | null; id?: string | null },
): Promise<{ error?: string }> {
  if (!(Number(opts.qty) > 0)) return { error: 'Enter a quantity.' }
  const row = {
    purchase_order_id: opts.poId, part_id: opts.partId,
    qty_ordered: Number(opts.qty), unit_cost: opts.unitCost ?? null,
  }
  const { error } = opts.id
    ? await sb.from('purchase_order_items').update(row).eq('id', opts.id)
    : await sb.from('purchase_order_items').insert({ ...row, user_id: opts.userId })
  return error ? { error: error.message } : {}
}

/**
 * Delete a line. Its receipts CASCADE, so stock returns automatically — the
 * same contract as reverting a service. No app code adjusts the count.
 */
export async function deletePoItem(sb: SupabaseClient, itemId: string): Promise<{ error?: string }> {
  const { error } = await sb.from('purchase_order_items').delete().eq('id', itemId)
  return error ? { error: error.message } : {}
}

/**
 * RECEIVE. The one write in this module that moves stock — and it does it by
 * inserting a restock movement, exactly like lib/parts.restockPart. It never
 * touches qty_on_hand; the trigger recomputes it from the ledger.
 *
 * Partial receiving needs no special case: receive 4 today and 6 next week and
 * the line's received qty is simply the sum of both movements.
 */
export async function receivePoItems(
  sb: SupabaseClient,
  opts: {
    userId: string
    receipts: { item: PurchaseOrderItem; qty: number; unitCost?: number | null }[]
    notes?: string | null
  },
): Promise<{ error?: string; received: number }> {
  const rows = opts.receipts
    .filter(r => Number(r.qty) > 0)
    .map(r => ({
      user_id: opts.userId,
      part_id: r.item.part_id,
      kind: 'restock' as const,
      qty: Math.abs(Number(r.qty)),                       // signed +in, like restockPart
      unit_cost: r.unitCost ?? r.item.unit_cost ?? null,  // what THIS receipt cost
      purchase_order_item_id: r.item.id,                  // the receipt link
      notes: opts.notes ?? null,
    }))
  if (!rows.length) return { error: 'Nothing to receive — enter a quantity.', received: 0 }
  const { error } = await sb.from('part_movements').insert(rows)
  return error ? { error: error.message, received: 0 } : { received: rows.length }
}
