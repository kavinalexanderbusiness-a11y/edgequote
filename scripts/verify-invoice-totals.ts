// ── Invoice totals verification — npm run verify:invoice-totals ─────────────
//
// lib/invoiceTotals.ts is the money math on the customer-facing invoice: fee
// recovery (YOUR revenue), the discount reversal that reconstructs a gross for
// display, and GST (a pass-through tax LIABILITY — a wrong number is a CRA
// problem, not a rounding nit). It is consumed by ~19 surfaces including the two
// live charge paths (api/payments/checkout, api/portal/pay) and every invoice/
// receipt PDF — yet nothing exercised its behaviour. This pins it.
//
// These are CHARACTERIZATION tests: they encode what the code does today, so a
// future refactor that silently moves GST onto the gross, drops a discount cap,
// or breaks the percent inverse fails HERE instead of on a customer's invoice.
// Pure + deterministic, no I/O — same discipline as verify-onboarding /
// verify-comms-governor, runnable in CI beside them.

import {
  gstRegistrationNumber, feeRecoveryMultiplier, applyFeeRecovery,
  applyDiscount, invoiceTotals,
} from '../src/lib/invoiceTotals'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}

// ═══════════════════════════════════════════════════════════════════════════
H('1. GST REGISTRATION NUMBER — the dual gate (registrant AND a number)')
// Both halves must hold: printing a number while charging no GST misstates the
// business's tax status, and an empty "GST #:" label is worse than no line.
check('registered + number → the trimmed number',
  gstRegistrationNumber({ gst_percent: 5, gst_number: '  123456789RT0001  ' }), '123456789RT0001')
check('a number but 0% (not a registrant) → null',
  gstRegistrationNumber({ gst_percent: 0, gst_number: '123456789RT0001' }), null)
check('a number but no percent → null',
  gstRegistrationNumber({ gst_number: '123456789RT0001' }), null)
check('charging GST but blank/whitespace number → null (no empty label)',
  gstRegistrationNumber({ gst_percent: 5, gst_number: '   ' }), null)
check('charging GST but no number field → null',
  gstRegistrationNumber({ gst_percent: 5 }), null)
check('null settings → null', gstRegistrationNumber(null), null)
// Subtle, pinned on purpose: a non-string registration is treated as absent, so
// a numeric value in the column is dropped rather than printed as "[object]".
check('a non-string number is dropped, not stringified',
  gstRegistrationNumber({ gst_percent: 5, gst_number: 123456789 as unknown as string }), null)

// ═══════════════════════════════════════════════════════════════════════════
H('2. FEE RECOVERY MULTIPLIER — only the global-price-increase strategy raises it')
check('global_price_increase @3% → 1.03',
  feeRecoveryMultiplier({ payment_fee_strategy: 'global_price_increase', fee_recovery_percent: 3 }), 1.03)
check('absorb → 1 (prices untouched)',
  feeRecoveryMultiplier({ payment_fee_strategy: 'absorb', fee_recovery_percent: 3 }), 1)
check('etransfer_discount → 1 (prices untouched)',
  feeRecoveryMultiplier({ payment_fee_strategy: 'etransfer_discount', fee_recovery_percent: 3 }), 1)
check('null settings → 1', feeRecoveryMultiplier(null), 1)
check('global strategy but 0% → 1', feeRecoveryMultiplier({ payment_fee_strategy: 'global_price_increase', fee_recovery_percent: 0 }), 1)
check('global strategy but negative % → 1', feeRecoveryMultiplier({ payment_fee_strategy: 'global_price_increase', fee_recovery_percent: -5 }), 1)
check('global strategy but NaN % → 1', feeRecoveryMultiplier({ payment_fee_strategy: 'global_price_increase', fee_recovery_percent: NaN }), 1)

// ═══════════════════════════════════════════════════════════════════════════
H('3. APPLY FEE RECOVERY — bake into one price, round to cents, pass empties through')
const GLOBAL3 = { payment_fee_strategy: 'global_price_increase' as const, fee_recovery_percent: 3 }
check('100 @3% → 103', applyFeeRecovery(100, GLOBAL3), 103)
check('99.99 @3% → 102.99 (rounded to cents)', applyFeeRecovery(99.99, GLOBAL3), 102.99)
check('absorb leaves the price exactly', applyFeeRecovery(100, { payment_fee_strategy: 'absorb' }), 100)
check('null price → null (an unset cadence price stays unset)', applyFeeRecovery(null, GLOBAL3), null)
check('undefined price → null', applyFeeRecovery(undefined, GLOBAL3), null)
check('zero price → 0 (not null: 0 is a set price)', applyFeeRecovery(0, GLOBAL3), 0)
check('negative price passes through untouched', applyFeeRecovery(-5, GLOBAL3), -5)
check('numeric-string price is coerced', applyFeeRecovery('100' as unknown as number, GLOBAL3), 103)

// ═══════════════════════════════════════════════════════════════════════════
H('4. APPLY DISCOUNT (SAVE-time net) — $ capped at subtotal, % capped at 100')
check('$30 off 100 → net 70', applyDiscount(100, { type: 'amount', value: 30 }), { net: 70, discountAmount: 30 })
check('$ discount is capped at the subtotal (never negative net)',
  applyDiscount(100, { type: 'amount', value: 150 }), { net: 0, discountAmount: 100 })
check('10% off 100 → net 90', applyDiscount(100, { type: 'percent', value: 10 }), { net: 90, discountAmount: 10 })
check('% discount is capped at 100%', applyDiscount(100, { type: 'percent', value: 150 }), { net: 0, discountAmount: 100 })
check('no discount type → gross passes through', applyDiscount(100, { value: 10 }), { net: 100, discountAmount: 0 })
check('zero value → gross passes through', applyDiscount(100, { type: 'amount', value: 0 }), { net: 100, discountAmount: 0 })
check('null discount → gross passes through', applyDiscount(100, null), { net: 100, discountAmount: 0 })
check('zero subtotal → passes through, no discount', applyDiscount(0, { type: 'amount', value: 10 }), { net: 0, discountAmount: 0 })
check('rounds to cents through the whole calc', applyDiscount(33.335, { type: 'percent', value: 10 }), { net: 30.01, discountAmount: 3.33 })

// ═══════════════════════════════════════════════════════════════════════════
H('5. INVOICE TOTALS — the display breakdown from a stored NET amount')
check('bare amount, no fee settings → subtotal === amount (backward compatible)',
  invoiceTotals(100, null), {
    subtotal: 100, discountAmount: 0, discountedSubtotal: 100, discountLabel: null,
    gstPercent: 0, gstAmount: 0, total: 100, hasGst: false, hasDiscount: false })
check('GST is added on top of the net and shown',
  invoiceTotals(100, { gst_percent: 5 }), {
    subtotal: 100, discountAmount: 0, discountedSubtotal: 100, discountLabel: null,
    gstPercent: 5, gstAmount: 5, total: 105, hasGst: true, hasDiscount: false })
check('null amount → all zeros, GstPercent carried', invoiceTotals(null, { gst_percent: 5 }), {
  subtotal: 0, discountAmount: 0, discountedSubtotal: 0, discountLabel: null,
  gstPercent: 5, gstAmount: 0, total: 0, hasGst: true, hasDiscount: false })
check('string amount is coerced', invoiceTotals('100' as unknown as number, null).subtotal, 100)

// ═══════════════════════════════════════════════════════════════════════════
H('6. THE MONEY-CRITICAL INVARIANTS — a regression here overcharges a customer')
// GST is computed on the NET (post-discount) amount, NOT the reconstructed gross.
// If this ever flips to the gross, every discounted invoice silently overcharges
// tax — the single highest-stakes line in the file.
const disc = invoiceTotals(90, { gst_percent: 5 }, { type: 'percent', value: 10 })
check('GST rides the NET (4.50 on 90), never the gross (would be 5.00 on 100)', disc.gstAmount, 4.5)
check('percent discount reconstructs the gross exactly (net·p/(100−p))', disc.subtotal, 100)
check('  …and reports the reconstructed discount', disc.discountAmount, 10)
check('  …and the total is net + GST-on-net', disc.total, 94.5)
check('  …and labels the percentage', disc.discountLabel, '10%')
check('a $ discount reconstructs gross but carries NO label (label is %-only)',
  invoiceTotals(70, null, { type: 'amount', value: 30 }), {
    subtotal: 100, discountAmount: 30, discountedSubtotal: 70, discountLabel: null,
    gstPercent: 0, gstAmount: 0, total: 70, hasGst: false, hasDiscount: true })
check('fractional percent keeps its decimals in the label', invoiceTotals(90, null, { type: 'percent', value: 12.5 }).discountLabel, '12.5%')
check('fractional percent reconstructs to cents', invoiceTotals(90, null, { type: 'percent', value: 12.5 }).discountAmount, 12.86)
// A 100% discount can't be inverted (gross would be infinite), so the reversal
// yields 0 and hasDiscount stays false — pinned so nobody "fixes" it into NaN.
const full = invoiceTotals(50, null, { type: 'percent', value: 100 })
check('100% discount: no gross reconstruction, but the label still shows',
  { amt: full.discountAmount, label: full.discountLabel, has: full.hasDiscount },
  { amt: 0, label: '100%', has: false })

// ═══════════════════════════════════════════════════════════════════════════
H('7. ROUND-TRIP — save-time net and display-time gross agree')
// applyDiscount (SAVE) and invoiceTotals (DISPLAY) are two ends of one rule; a
// value stored by the first must reconstruct through the second. This is the
// property the file's own comment promises ("never duplicating the math").
for (const [gross, pct] of [[100, 10], [250, 15], [80, 33], [199.99, 20]] as const) {
  const saved = applyDiscount(gross, { type: 'percent', value: pct })
  const shown = invoiceTotals(saved.net, null, { type: 'percent', value: pct })
  check(`${pct}% off ${gross}: net ${saved.net} reconstructs to gross ${gross}`, shown.subtotal, round2(gross))
}
function round2(n: number) { return Math.round(n * 100) / 100 }

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
