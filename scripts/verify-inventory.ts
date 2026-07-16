/**
 * npm run verify:inventory
 *
 * Pins the rules the inventory analytics must never break. The live tables are
 * EMPTY (0 parts, 0 movements, no ledger history), so these engines cannot be
 * checked against real data — this harness is the only thing standing between a
 * forecast and an invented number. Every case below is a claim the UI makes.
 *
 * The DB half (the trigger actually recomputing stock) is verified separately
 * and transactionally against production — see the commit message.
 */
import type { Part, PartMovement } from '../src/lib/parts'
import { stockStatus, partValue, inventorySummary } from '../src/lib/parts'
import {
  usageForecast, suggestedOrderQty, runningOutSoon, valuation, weightedAvgCost,
  costDrift, purchaseStats, topPartsBySpend, vendorStats, reorderList,
  reorderBySupplier, normalizeSku, findBySku, searchParts,
} from '../src/lib/inventory/analytics'
import type { PurchaseOrder, PurchaseOrderItem, ReceiptMovement } from '../src/lib/purchasing'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, detail?: string) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const eq = (name: string, got: unknown, want: unknown) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

const NOW = new Date('2026-07-16T12:00:00Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()

const part = (o: Partial<Part> & { id: string }): Part => ({
  created_at: daysAgo(200), updated_at: daysAgo(1), user_id: 'u1',
  name: 'Part', sku: null, category: 'other', unit: 'each',
  qty_on_hand: 0, reorder_at: null, unit_cost: null, supplier: null, notes: null,
  ...o, // caller wins — including id
} as Part)

const use = (partId: string, qty: number, d: number): PartMovement => ({
  id: `m${Math.random()}`, created_at: daysAgo(d), user_id: 'u1', part_id: partId,
  kind: 'use', qty: -Math.abs(qty), unit_cost: null, notes: null,
} as PartMovement)

const restock = (partId: string, qty: number, d: number, cost?: number, itemId?: string): ReceiptMovement => ({
  id: `r${Math.random()}`, created_at: daysAgo(d), user_id: 'u1', part_id: partId,
  kind: 'restock', qty: Math.abs(qty), unit_cost: cost ?? null, notes: null,
  purchase_order_item_id: itemId ?? null,
} as ReceiptMovement)

console.log('\n── Forecasting: never invent a number ─────────────────────────')
{
  const p = part({ id: 'p1', qty_on_hand: 100, unit_cost: 10 })

  // THE headline rule: no usage => no forecast, not "infinite days of cover".
  const f0 = usageForecast(p, [], { now: NOW })
  eq('no usage -> confidence none', f0.confidence, 'none')
  eq('no usage -> daysLeft null (NOT Infinity/0)', f0.daysLeft, null)
  eq('no usage -> runOutOn null', f0.runOutOn, null)
  ok('no usage -> basis says so', /no usage/i.test(f0.basis), f0.basis)

  // Thin history must NOT graduate to a projection.
  const f1 = usageForecast(p, [use('p1', 8, 2), use('p1', 8, 1)], { now: NOW })
  eq('2 uses over 2 days -> confidence low', f1.confidence, 'low')
  eq('thin history -> NO daysLeft', f1.daysLeft, null)
  ok('thin history -> basis explains why', /too little history/i.test(f1.basis), f1.basis)

  // Real history: 30 used over 60 days = 0.5/day; 100 on hand => 200 days.
  const uses = [use('p1', 10, 60), use('p1', 10, 30), use('p1', 10, 5)]
  const f2 = usageForecast(p, uses, { now: NOW })
  eq('good history -> confidence good', f2.confidence, 'good')
  eq('perDay = 30 used / 60 observed days', f2.perDay, 0.5)
  eq('daysLeft = 100 / 0.5', f2.daysLeft, 200)
  ok('runOutOn is set', f2.runOutOn instanceof Date)

  // The window is measured from FIRST USE, not from windowDays ago. A part first
  // used 30 days ago has 30 days of history, not 90 — dividing by 90 would
  // understate the burn 3x and hide a stockout.
  const recent = [use('p2', 10, 30), use('p2', 10, 20), use('p2', 10, 1)]
  const p2 = part({ id: 'p2', qty_on_hand: 30 })
  const f3 = usageForecast(p2, recent, { now: NOW })
  eq('observedDays measured from first use', f3.observedDays, 30)
  eq('perDay = 30/30, not 30/90', f3.perDay, 1)
  eq('daysLeft = 30 / 1', f3.daysLeft, 30)

  // Same-day burst must not divide by ~0 and read as infinite.
  const burst = [use('p3', 5, 0), use('p3', 5, 0), use('p3', 5, 0)]
  const f4 = usageForecast(part({ id: 'p3', qty_on_hand: 10 }), burst, { now: NOW })
  ok('same-day burst never yields Infinity', Number.isFinite(f4.perDay))
  eq('same-day burst stays low confidence', f4.confidence, 'low')

  // Out of stock: stockStatus owns that fact.
  const f5 = usageForecast(part({ id: 'p1', qty_on_hand: 0 }), uses, { now: NOW })
  eq('already out -> daysLeft 0', f5.daysLeft, 0)

  // Window excludes old usage entirely.
  const f6 = usageForecast(p, [use('p1', 999, 200)], { now: NOW })
  eq('usage outside window ignored', f6.confidence, 'none')
}

console.log('\n── Order sizing: silence when unknowable ──────────────────────')
{
  const p = part({ id: 'p1', qty_on_hand: 10 })
  const uses = [use('p1', 20, 60), use('p1', 20, 30), use('p1', 20, 5)]
  const f = usageForecast(p, uses, { now: NOW })
  eq('perDay = 60/60', f.perDay, 1)
  eq('suggest 60d cover: 60 needed - 10 held = 50', suggestedOrderQty(p, f, 60), 50)

  const thin = usageForecast(p, [use('p1', 5, 1)], { now: NOW })
  eq('thin history -> no suggestion (null, not 0)', suggestedOrderQty(p, thin, 60), null)

  const plenty = part({ id: 'p1', qty_on_hand: 500 })
  eq('already covered -> no suggestion', suggestedOrderQty(plenty, usageForecast(plenty, uses, { now: NOW }), 60), null)
}

console.log('\n── runningOutSoon: only forecastable parts ────────────────────')
{
  const soon = part({ id: 'a', name: 'Soon', qty_on_hand: 5 })
  const never = part({ id: 'b', name: 'NoData', qty_on_hand: 1 })
  const uses = [use('a', 10, 60), use('a', 10, 30), use('a', 10, 5)]
  const rows = runningOutSoon([soon, never], uses, { withinDays: 30, now: NOW })
  eq('only the forecastable part appears', rows.map(r => r.part.id), ['a'])
  ok('a part with no history is never listed as running out', !rows.some(r => r.part.id === 'b'))
}

console.log('\n── Valuation delegates to THE engine ──────────────────────────')
{
  const parts = [
    part({ id: 'a', qty_on_hand: 10, unit_cost: 5, reorder_at: 20 }),  // low: 50
    part({ id: 'b', qty_on_hand: 4, unit_cost: 25 }),                  // untracked: 100
    part({ id: 'c', qty_on_hand: 0, unit_cost: 9, reorder_at: 2 }),    // out: 0
  ]
  const v = valuation(parts)
  eq('total === inventorySummary.shelfValue (one source)', v.total, inventorySummary(parts).shelfValue)
  eq('total is the sum of partValue', v.total, parts.reduce((s, p) => s + partValue(p), 0))
  eq('rows sorted by value desc', v.rows.map(r => r.part.id), ['b', 'a', 'c'])
  eq('per-row value === partValue (never recomputed)', v.rows.map(r => r.value), v.rows.map(r => partValue(r.part)))
  eq('shares sum to 1', Math.round(v.rows.reduce((s, r) => s + r.share, 0)), 1)
  eq('atRiskValue = low+out only', v.atRiskValue, 50)
  eq('untrackedValue = no reorder point', v.untrackedValue, 100)
  eq('row state === stockStatus (never re-implemented)', v.rows.map(r => r.state), v.rows.map(r => stockStatus(r.part).state))

  const empty = valuation([])
  eq('empty shelf -> 0 not NaN', empty.total, 0)
  ok('empty shelf -> no divide-by-zero shares', empty.rows.every(r => Number.isFinite(r.share)))
}

console.log('\n── Cost insight is not a second valuation ─────────────────────')
{
  // 10 @ $10 + 30 @ $14 = $520 / 40 = $13
  const r = [restock('p1', 10, 60, 10), restock('p1', 30, 10, 14)]
  eq('weighted avg by qty (not a plain mean)', weightedAvgCost('p1', r), 13)
  eq('no receipts -> null (never 0)', weightedAvgCost('p1', []), null)
  eq('receipts without cost -> null', weightedAvgCost('p1', [restock('p1', 5, 1)]), null)

  const p = part({ id: 'p1', qty_on_hand: 40, unit_cost: 16 })
  const d = costDrift(p, r)
  eq('drift delta = 16 - 13', d?.delta, 3)
  ok('drift pct ≈ 23%', Math.abs((d?.pct ?? 0) - 23.08) < 0.1, String(d?.pct))
  eq('no cost -> no drift claim', costDrift(part({ id: 'p1', qty_on_hand: 1 }), r), null)

  // The invariant: a cost insight must never move the shelf value.
  eq('partValue still uses unit_cost, untouched by avg', partValue(p), 640)
}

console.log('\n── Purchase analytics: spend = what ARRIVED ───────────────────')
{
  const partsById = new Map([['x', part({ id: 'x', unit_cost: 10 })]])
  const pos: PurchaseOrder[] = [
    { id: 'po1', status: 'ordered', supplier_id: 's1', ordered_at: '2026-06-01', expected_at: '2026-06-10' } as PurchaseOrder,
    { id: 'po2', status: 'cancelled', supplier_id: 's1', ordered_at: '2026-06-01' } as PurchaseOrder,
  ]
  const items: PurchaseOrderItem[] = [
    { id: 'i1', purchase_order_id: 'po1', part_id: 'x', qty_ordered: 10, unit_cost: 10 } as PurchaseOrderItem,
    { id: 'i2', purchase_order_id: 'po2', part_id: 'x', qty_ordered: 99, unit_cost: 10 } as PurchaseOrderItem,
  ]
  const receipts = [restock('x', 4, 5, 10, 'i1')]
  const s = purchaseStats(pos, items, receipts, partsById, { now: NOW })
  eq('spend counts only received (4 x $10)', s.received, 40)
  eq('on-order = outstanding 6 x $10, not the full order', s.onOrderValue, 60)
  eq('partial order counts as open', s.openOrders, 1)
  eq('cancelled PO contributes nothing', s.receivedOrders, 0)

  // An over-receipt must not make the supplier "owe" negative value.
  const over = purchaseStats(pos, items, [restock('x', 25, 1, 10, 'i1')], partsById, { now: NOW })
  ok('over-receipt never yields negative on-order', over.onOrderValue >= 0, String(over.onOrderValue))

  const top = topPartsBySpend(items, receipts, partsById, 5)
  eq('top parts by money received', top.map(t => [t.part.id, t.spend]), [['x', 40]])
}

console.log('\n── Vendor analytics: undated ≠ late ───────────────────────────')
{
  const pos: PurchaseOrder[] = [
    { id: 'p1', status: 'ordered', supplier_id: 's1', ordered_at: '2026-07-01', expected_at: '2026-07-10' } as PurchaseOrder,
    { id: 'p2', status: 'ordered', supplier_id: 's1', ordered_at: '2026-07-01', expected_at: null } as PurchaseOrder,
  ]
  const items: PurchaseOrderItem[] = [
    { id: 'i1', purchase_order_id: 'p1', part_id: 'x', qty_ordered: 5 } as PurchaseOrderItem,
    { id: 'i2', purchase_order_id: 'p2', part_id: 'x', qty_ordered: 5 } as PurchaseOrderItem,
  ]
  // p1 received 8 days ago (2026-07-08T12:00Z) => on time vs expected 07-10.
  // p2 received 2 days ago (2026-07-14T12:00Z), undated.
  const receipts = [restock('x', 5, 8, 10, 'i1'), restock('x', 5, 2, 10, 'i2')]
  const v = vendorStats('s1', pos, items, receipts)
  eq('on-time counts only datable orders (1 of 1)', v.onTimeRate, 1)
  ok('undated order excluded, not counted late', v.onTimeRate === 1)
  // Lead time averages BOTH orders: 7.5d (07-01 -> 07-08T12:00Z) and
  // 13.5d (07-01 -> 07-14T12:00Z) => 10.5. Date-only parsed as UTC, so this
  // figure must not move with the machine's timezone.
  eq('avg lead days across both orders', v.avgLeadDays, 10.5)
  eq('both fully received -> fillRate 1', v.fillRate, 1)

  // A single datable order, pinned exactly — the offset bug would show here.
  const solo = vendorStats('s2', [pos[0] as PurchaseOrder].map(p => ({ ...p, supplier_id: 's2' })),
    [items[0]], [receipts[0]])
  eq('single order lead = 7.5d, timezone-independent', solo.avgLeadDays, 7.5)

  // A receipt logged before the order date is nonsense, not a negative lead.
  const early = vendorStats('s3',
    [{ ...pos[0], id: 'p9', supplier_id: 's3', ordered_at: '2026-07-15' } as PurchaseOrder],
    [{ ...items[0], id: 'i9', purchase_order_id: 'p9' } as PurchaseOrderItem],
    [restock('x', 5, 30, 10, 'i9')])
  eq('receipt before order date -> no lead claim, never negative', early.avgLeadDays, null)

  const none = vendorStats('nobody', pos, items, receipts)
  eq('unknown vendor -> null, never 0%', none.onTimeRate, null)
  eq('unknown vendor -> no lead claim', none.avgLeadDays, null)
}

console.log('\n── Reorder: stockStatus decides, forecast only ranks ──────────')
{
  const out = part({ id: 'o', name: 'Out', qty_on_hand: 0, reorder_at: 5, unit_cost: 1, supplier: null })
  const low = part({ id: 'l', name: 'Low', qty_on_hand: 2, reorder_at: 5, unit_cost: 1 })
  const fine = part({ id: 'f', name: 'Fine', qty_on_hand: 99, reorder_at: 5, unit_cost: 1 })
  const untracked = part({ id: 'u', name: 'Untracked', qty_on_hand: 1, reorder_at: null })
  const lines = reorderList([fine, low, out, untracked], [], { now: NOW })
  eq('only low+out listed', lines.map(l => l.part.id), ['o', 'l'])
  ok('a healthy part is never listed', !lines.some(l => l.part.id === 'f'))
  ok('an untracked part is never listed (no reorder point set)', !lines.some(l => l.part.id === 'u'))
  eq('out ranks before low', lines[0].part.id, 'o')
  eq('line status === stockStatus (never re-implemented)', lines.map(l => l.status.state), ['out', 'low'])
  eq('no history -> no invented suggestion', lines.map(l => l.suggestQty), [null, null])

  const groups = reorderBySupplier(lines)
  ok('parts with no supplier group under null', groups.has(null))
}

console.log('\n── Barcode: existing SKU field, never guess ───────────────────')
{
  const a = part({ id: 'a', name: 'Oil filter', sku: 'of-123' })
  const b = part({ id: 'b', name: 'Oil filter XL', sku: 'OF-999' })
  eq('normalize: case + spaces', normalizeSku(' of-123 '), 'OF-123')
  eq('exact SKU wins (case-insensitive)', findBySku('OF-123', [a, b])?.id, 'a')
  eq('scanner whitespace tolerated', findBySku(' of-123\n', [a, b])?.id, 'a')
  eq('unknown scan -> null', findBySku('ZZZ', [a, b]), null)
  eq('empty scan -> null', findBySku('   ', [a, b]), null)
  // THE safety rule: an ambiguous scan must never silently pick one.
  eq('ambiguous name match -> null, not a guess', findBySku('Oil filter', [a, b]), null)
  eq('unique name match is allowed', findBySku('Oil filter XL', [a, b])?.id, 'b')
  eq('search returns all candidates to disambiguate', searchParts('oil', [a, b]).length, 2)
}

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
