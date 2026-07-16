import type { Part, PartMovement } from '@/lib/parts'
import { stockStatus, partValue, inventorySummary } from '@/lib/parts'
import type { PurchaseOrder, PurchaseOrderItem, ReceiptMovement } from '@/lib/purchasing'
import { poDisplayStatus, receivedQty } from '@/lib/purchasing'

// ── Inventory analytics ──────────────────────────────────────────────────────
// Forecasting, valuation, purchase + vendor analytics.
//
// THIS IS NOT A SECOND INVENTORY ENGINE. It computes nothing about stock that
// lib/parts already answers: stockStatus() is still the only thing that says
// out/low/ok, partValue() is still the only thing that says what a shelf is
// worth, and inventorySummary() is still the only rollup. This file DERIVES new
// questions (how fast do we use it, when will it run out, what have we paid)
// from the same movement ledger, and delegates the old ones.
//
// Nothing here writes. Stock is still only ever sum(part_movements.qty),
// recomputed by the recompute_part_stock trigger.
//
// ⚠️ THE RULE THIS FILE EXISTS TO KEEP: a forecast may never be invented.
// Every figure below is earned from movements that actually happened, and says
// "not enough history" when they didn't. A confident "3 days left" derived from
// two data points is worse than no number, because someone will order against
// it. Confidence is returned, not implied.

const round2 = (n: number) => Math.round(n * 100) / 100
const DAY_MS = 86_400_000

// ── Usage + forecasting ──────────────────────────────────────────────────────

/**
 * How much history a forecast is standing on.
 *  none  — no usage logged: say nothing.
 *  low   — some usage, but too thin/short to extrapolate (shown, never ranked).
 *  good  — enough spread of real usage to be worth acting on.
 */
export type ForecastConfidence = 'none' | 'low' | 'good'

export interface UsageForecast {
  /** Average units consumed per day over the window. 0 when unknown. */
  perDay: number
  /** Days until stock hits zero at that rate. null = not forecastable. */
  daysLeft: number | null
  /** Date stock is projected to run out. null = not forecastable. */
  runOutOn: Date | null
  confidence: ForecastConfidence
  /** Always says what the number stands on, in plain words. */
  basis: string
  usedInWindow: number
  observedDays: number
}

// A rate needs BOTH enough events and enough elapsed time. Two draws on
// consecutive days is not "8 units/day" — it's a coincidence with a slope.
const MIN_EVENTS_GOOD = 3
const MIN_DAYS_GOOD = 21

/**
 * Consumption rate for one part, from the ledger's 'use' movements.
 *
 * The window is measured from FIRST OBSERVED USE, not from `windowDays` ago: a
 * part first used 10 days ago has 10 days of history, not 90, and dividing by 90
 * would understate its burn by 9x and hide a stockout. Elapsed time is what the
 * evidence actually covers.
 */
export function usageForecast(
  part: Part, movements: PartMovement[], opts?: { windowDays?: number; now?: Date },
): UsageForecast {
  const windowDays = opts?.windowDays ?? 90
  const now = opts?.now ?? new Date()
  const since = new Date(now.getTime() - windowDays * DAY_MS)

  const uses = movements.filter(m =>
    m.part_id === part.id && m.kind === 'use' && new Date(m.created_at) >= since)

  const qty = Number(part.qty_on_hand) || 0
  const none = (basis: string): UsageForecast =>
    ({ perDay: 0, daysLeft: null, runOutOn: null, confidence: 'none', basis, usedInWindow: 0, observedDays: 0 })

  if (uses.length === 0) return none('No usage logged yet — nothing to forecast from.')

  // 'use' movements are stored negative (stock going out). Magnitude is the draw.
  const used = round2(uses.reduce((s, m) => s + Math.abs(Number(m.qty) || 0), 0))
  if (used <= 0) return none('No quantity used yet — nothing to forecast from.')

  const first = uses.reduce((a, m) => Math.min(a, new Date(m.created_at).getTime()), Infinity)
  // At least a day, so a same-day pair can't divide by ~0 and read as infinite burn.
  const observedDays = Math.max(1, Math.round((now.getTime() - first) / DAY_MS))
  const perDay = round2(used / observedDays)

  const confidence: ForecastConfidence =
    uses.length >= MIN_EVENTS_GOOD && observedDays >= MIN_DAYS_GOOD ? 'good' : 'low'

  const unit = part.unit === 'each' ? '' : ` ${part.unit}`
  const basis = confidence === 'good'
    ? `${used}${unit} used over ${observedDays} days (${uses.length} times).`
    : `Only ${uses.length} use${uses.length !== 1 ? 's' : ''} over ${observedDays} day${observedDays !== 1 ? 's' : ''} — too little history to project yet.`

  // A rate exists, but we only project from history worth projecting from.
  if (confidence !== 'good' || perDay <= 0) {
    return { perDay, daysLeft: null, runOutOn: null, confidence, basis, usedInWindow: used, observedDays }
  }
  // Already out: stockStatus owns that fact — don't restate it as "0 days left".
  if (qty <= 0) {
    return { perDay, daysLeft: 0, runOutOn: null, confidence, basis, usedInWindow: used, observedDays }
  }
  const daysLeft = Math.floor(qty / perDay)
  return {
    perDay, daysLeft,
    runOutOn: new Date(now.getTime() + daysLeft * DAY_MS),
    confidence, basis, usedInWindow: used, observedDays,
  }
}

/** How much to buy to cover `coverDays` at the observed rate. null = unknowable. */
export function suggestedOrderQty(
  part: Part, f: UsageForecast, coverDays = 60,
): number | null {
  if (f.confidence !== 'good' || f.perDay <= 0) return null
  const target = f.perDay * coverDays
  const need = target - (Number(part.qty_on_hand) || 0)
  return need > 0 ? Math.ceil(need) : null
}

/** Parts running out soonest — forecastable ones only, never padded with guesses. */
export function runningOutSoon(
  parts: Part[], movements: PartMovement[], opts?: { withinDays?: number; now?: Date },
): { part: Part; forecast: UsageForecast }[] {
  const within = opts?.withinDays ?? 30
  return parts
    .map(part => ({ part, forecast: usageForecast(part, movements, { now: opts?.now }) }))
    .filter(r => r.forecast.confidence === 'good' && r.forecast.daysLeft !== null && r.forecast.daysLeft <= within)
    .sort((a, b) => (a.forecast.daysLeft! - b.forecast.daysLeft!))
}

// ── Valuation ────────────────────────────────────────────────────────────────
// ⚠️ partValue() REMAINS THE ONE ANSWER to "what is this shelf worth". Nothing
// here re-values stock; a second valuation that disagreed with the parts page
// would be a bug with a dashboard. What this adds is what you've PAID (from the
// receipt movements) — a cost insight sitting beside the valuation, never a
// rival to it.

export interface ValuationRow {
  part: Part
  /** THE shelf value — delegated to partValue, never recomputed. */
  value: number
  /** Share of total shelf value, 0–1. */
  share: number
  state: ReturnType<typeof stockStatus>['state']
}

export interface Valuation {
  /** Delegated to inventorySummary — the same figure the parts page shows. */
  total: number
  rows: ValuationRow[]
  /** Value sitting in parts at or below their reorder point. */
  atRiskValue: number
  /** Value in parts with no reorder point set — invisible to low-stock alerts. */
  untrackedValue: number
}

export function valuation(parts: Part[]): Valuation {
  const total = inventorySummary(parts).shelfValue
  const rows = parts
    .map(part => {
      const value = partValue(part)
      return {
        part, value,
        share: total > 0 ? value / total : 0,
        state: stockStatus(part).state,
      }
    })
    .sort((a, b) => b.value - a.value)
  return {
    total,
    rows,
    atRiskValue: round2(rows.filter(r => r.state === 'low' || r.state === 'out').reduce((s, r) => s + r.value, 0)),
    untrackedValue: round2(rows.filter(r => r.state === 'untracked').reduce((s, r) => s + r.value, 0)),
  }
}

/**
 * What you've actually been paying per unit, averaged over receipts by quantity.
 * A COST INSIGHT, not a valuation — it answers "is this getting dearer", which
 * parts.unit_cost (the current price) cannot. null when nothing was received.
 */
export function weightedAvgCost(partId: string, receipts: ReceiptMovement[]): number | null {
  const rows = receipts.filter(m => m.part_id === partId && m.kind === 'restock' && m.unit_cost != null)
  if (!rows.length) return null
  const qty = rows.reduce((s, m) => s + Math.abs(Number(m.qty) || 0), 0)
  if (qty <= 0) return null
  const spend = rows.reduce((s, m) => s + Math.abs(Number(m.qty) || 0) * (Number(m.unit_cost) || 0), 0)
  return round2(spend / qty)
}

/** Current price vs what you've paid on average. null when either is unknown. */
export function costDrift(part: Part, receipts: ReceiptMovement[]): { avg: number; delta: number; pct: number } | null {
  const avg = weightedAvgCost(part.id, receipts)
  const now = Number(part.unit_cost) || 0
  if (avg == null || avg <= 0 || now <= 0) return null
  const delta = round2(now - avg)
  return { avg, delta, pct: round2((delta / avg) * 100) }
}

// ── Purchase analytics ───────────────────────────────────────────────────────
// Spend means goods that ARRIVED, valued at what that receipt cost. An ordered-
// but-undelivered PO is not money spent, and counting it would inflate every
// figure on the page.

export interface PurchaseStats {
  received: number
  onOrderValue: number
  openOrders: number
  /** Orders fully in, of those raised. */
  receivedOrders: number
  avgOrderValue: number
}

export function purchaseStats(
  pos: PurchaseOrder[], items: PurchaseOrderItem[], receipts: ReceiptMovement[],
  partsById: Map<string, Part>, opts?: { sinceDays?: number; now?: Date },
): PurchaseStats {
  const now = opts?.now ?? new Date()
  const since = opts?.sinceDays ? new Date(now.getTime() - opts.sinceDays * DAY_MS) : null
  const live = pos.filter(p => p.status !== 'cancelled')
  const liveIds = new Set(live.map(p => p.id))
  const itemById = new Map(items.map(i => [i.id, i]))

  const received = round2(receipts.reduce((s, m) => {
    if (!m.purchase_order_item_id) return s
    if (since && new Date(m.created_at) < since) return s
    const item = itemById.get(m.purchase_order_item_id)
    if (!item || !liveIds.has(item.purchase_order_id)) return s
    const unit = m.unit_cost ?? item.unit_cost ?? partsById.get(item.part_id)?.unit_cost ?? 0
    return s + Math.abs(Number(m.qty) || 0) * (Number(unit) || 0)
  }, 0))

  // Still owed = ordered minus received, valued at the line's cost. Never
  // negative: an over-receipt doesn't mean the supplier owes you money back.
  const onOrderValue = round2(live.reduce((s, po) => {
    const st = poDisplayStatus(po, items, receipts)
    if (st !== 'ordered' && st !== 'partial') return s
    return s + items.filter(i => i.purchase_order_id === po.id).reduce((t, i) => {
      const outstanding = Math.max(0, (Number(i.qty_ordered) || 0) - receivedQty(i.id, receipts))
      const unit = i.unit_cost ?? partsById.get(i.part_id)?.unit_cost ?? 0
      return t + outstanding * (Number(unit) || 0)
    }, 0)
  }, 0))

  const openOrders = live.filter(p => {
    const st = poDisplayStatus(p, items, receipts)
    return st === 'ordered' || st === 'partial'
  }).length
  const receivedOrders = live.filter(p => poDisplayStatus(p, items, receipts) === 'received').length

  return {
    received, onOrderValue, openOrders, receivedOrders,
    avgOrderValue: live.length ? round2(received / live.length) : 0,
  }
}

/** What you buy most, by money actually received. */
export function topPartsBySpend(
  items: PurchaseOrderItem[], receipts: ReceiptMovement[], partsById: Map<string, Part>, limit = 5,
): { part: Part; spend: number; qty: number }[] {
  const itemById = new Map(items.map(i => [i.id, i]))
  const acc = new Map<string, { spend: number; qty: number }>()
  for (const m of receipts) {
    if (!m.purchase_order_item_id) continue
    const item = itemById.get(m.purchase_order_item_id)
    if (!item) continue
    const unit = m.unit_cost ?? item.unit_cost ?? partsById.get(item.part_id)?.unit_cost ?? 0
    const q = Math.abs(Number(m.qty) || 0)
    const cur = acc.get(item.part_id) ?? { spend: 0, qty: 0 }
    acc.set(item.part_id, { spend: cur.spend + q * (Number(unit) || 0), qty: cur.qty + q })
  }
  return [...acc.entries()]
    .map(([partId, v]) => ({ part: partsById.get(partId)!, spend: round2(v.spend), qty: round2(v.qty) }))
    .filter(r => r.part)
    .sort((a, b) => b.spend - a.spend)
    .slice(0, limit)
}

// ── Vendor analytics ─────────────────────────────────────────────────────────
// Extends vendorHistory (orders/spend/last) with delivery behaviour — read from
// the receipts, because when things ARRIVED is the only honest record of it.

export interface VendorStats {
  /** Receipts that landed on or before the PO's expected date, of those datable. */
  onTimeRate: number | null
  /** Average days from ordered_at to first receipt. null = never received. */
  avgLeadDays: number | null
  /** Orders raised but not fully in. */
  openOrders: number
  /** Fully-received orders, of live orders — the "do they deliver" figure. */
  fillRate: number | null
}

export function vendorStats(
  supplierId: string, pos: PurchaseOrder[], items: PurchaseOrderItem[], receipts: ReceiptMovement[],
): VendorStats {
  const mine = pos.filter(p => p.supplier_id === supplierId && p.status !== 'cancelled')
  if (!mine.length) return { onTimeRate: null, avgLeadDays: null, openOrders: 0, fillRate: null }

  const itemsByPo = new Map<string, PurchaseOrderItem[]>()
  for (const i of items) {
    if (!itemsByPo.has(i.purchase_order_id)) itemsByPo.set(i.purchase_order_id, [])
    itemsByPo.get(i.purchase_order_id)!.push(i)
  }
  const firstReceipt = (poId: string): Date | null => {
    const ids = new Set((itemsByPo.get(poId) ?? []).map(i => i.id))
    const times = receipts
      .filter(m => m.purchase_order_item_id && ids.has(m.purchase_order_item_id))
      .map(m => new Date(m.created_at).getTime())
    return times.length ? new Date(Math.min(...times)) : null
  }

  // ⚠️ Date-only columns are parsed as UTC ON PURPOSE. `created_at` is a UTC
  // timestamp; parsing 'YYYY-MM-DD' without a zone would make it SERVER-local,
  // so lead time would skew by the server's offset (and silently be "correct"
  // on Vercel, where local IS UTC, while wrong everywhere else). That is the
  // same mistake the automation engine shipped by reading a UTC hour as the
  // owner's local hour. business_settings has no timezone column, so the
  // owner's true local day is unknowable — UTC is the one consistent basis,
  // and consistency is what a lead-time average needs.
  const startOfDayUtc = (d: string) => new Date(d + 'T00:00:00Z')
  const endOfDayUtc = (d: string) => new Date(d + 'T23:59:59Z')

  // On-time is only measurable where BOTH an expectation and an arrival exist.
  // Orders with no expected date aren't late — they're undated, and counting
  // them as either would be inventing a record the owner never kept.
  const datable = mine.filter(p => p.expected_at && firstReceipt(p.id))
  const onTime = datable.filter(p => firstReceipt(p.id)! <= endOfDayUtc(p.expected_at!))

  const leads = mine
    .map(p => ({ ordered: p.ordered_at, got: firstReceipt(p.id) }))
    .filter(r => r.ordered && r.got)
    .map(r => (r.got!.getTime() - startOfDayUtc(r.ordered!).getTime()) / DAY_MS)
    .filter(d => d >= 0)

  const done = mine.filter(p => poDisplayStatus(p, items, receipts) === 'received').length
  const open = mine.filter(p => {
    const st = poDisplayStatus(p, items, receipts)
    return st === 'ordered' || st === 'partial'
  }).length

  return {
    onTimeRate: datable.length ? round2(onTime.length / datable.length) : null,
    avgLeadDays: leads.length ? round2(leads.reduce((s, d) => s + d, 0) / leads.length) : null,
    openOrders: open,
    fillRate: mine.length ? round2(done / mine.length) : null,
  }
}

// ── Reorder ──────────────────────────────────────────────────────────────────

export interface ReorderLine {
  part: Part
  status: ReturnType<typeof stockStatus>
  forecast: UsageForecast
  /** Units to buy for the cover window. null when history can't say. */
  suggestQty: number | null
  supplierId: string | null
}

/**
 * What to reorder. stockStatus() decides — this never re-implements "low".
 * Forecast only ORDERS the list and sizes the suggestion; a part is on it
 * because the ledger says it's low or out, not because a projection guessed.
 */
export function reorderList(
  parts: Part[], movements: PartMovement[], opts?: { coverDays?: number; now?: Date },
): ReorderLine[] {
  return parts
    .filter(p => { const s = stockStatus(p).state; return s === 'low' || s === 'out' })
    .map(part => {
      const forecast = usageForecast(part, movements, { now: opts?.now })
      return {
        part,
        status: stockStatus(part),
        forecast,
        suggestQty: suggestedOrderQty(part, forecast, opts?.coverDays ?? 60),
        supplierId: (part as Part & { supplier_id?: string | null }).supplier_id ?? null,
      }
    })
    // Out before low; then soonest to run out; then biggest money on the shelf.
    .sort((a, b) => {
      if (a.status.state !== b.status.state) return a.status.state === 'out' ? -1 : 1
      const ad = a.forecast.daysLeft ?? Infinity, bd = b.forecast.daysLeft ?? Infinity
      if (ad !== bd) return ad - bd
      return partValue(b.part) - partValue(a.part)
    })
}

/** Group the reorder list by vendor — one trip, one order, one conversation. */
export function reorderBySupplier(lines: ReorderLine[]): Map<string | null, ReorderLine[]> {
  const out = new Map<string | null, ReorderLine[]>()
  for (const l of lines) {
    if (!out.has(l.supplierId)) out.set(l.supplierId, [])
    out.get(l.supplierId)!.push(l)
  }
  return out
}

// ── Barcode / SKU lookup ─────────────────────────────────────────────────────
// Uses the EXISTING parts.sku field. No barcode column, no barcode table — a
// SKU is already the number printed on the box.

/** Normalise for comparison: scanners vary on case, spaces and leading zeros. */
export function normalizeSku(raw: string): string {
  return raw.trim().replace(/\s+/g, '').toUpperCase()
}

/**
 * Find the part a scan refers to. Exact SKU wins; a name match is the fallback
 * so typing works where a camera isn't handy.
 */
export function findBySku(scan: string, parts: Part[]): Part | null {
  const q = normalizeSku(scan)
  if (!q) return null
  const bySku = parts.find(p => p.sku && normalizeSku(p.sku) === q)
  if (bySku) return bySku
  const byName = parts.filter(p => normalizeSku(p.name).includes(q))
  // Only when unambiguous — two matches means the scan didn't identify a part,
  // and picking the first would silently move stock on the wrong shelf.
  return byName.length === 1 ? byName[0] : null
}

/** Ambiguous or unknown scans, for the UI to disambiguate rather than guess. */
export function searchParts(scan: string, parts: Part[]): Part[] {
  const q = normalizeSku(scan)
  if (!q) return []
  return parts.filter(p =>
    (p.sku && normalizeSku(p.sku).includes(q)) || normalizeSku(p.name).includes(q))
}
