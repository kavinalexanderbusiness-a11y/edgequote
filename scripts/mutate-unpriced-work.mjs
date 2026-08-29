// ── Mutation test for verify:unpriced-work ───────────────────────────────────
//
//   node scripts/mutate-unpriced-work.mjs
//
// A guard that has never failed proves nothing. This reintroduces the silent
// zero — one way at a time, in the exact shapes the production audit found — and
// requires the guard to go RED for each. A mutation the guard survives is
// reported as MISSED; that is the finding, not a footnote.
//
// The mutations are the brief's own list, plus the ones the audit turned up:
//   · unknown → zero in the value engine
//   · the QuoteBuilder `?? 0` pricing-package fallback
//   · a $0 quote becoming sendable
//   · all-zero options becoming acceptable
//   · an unpriced job entering a revenue total
//   · an unpriced quote being marked won / invoiced
//   · the free-work reason bypassed (a bare $0 read as free)
//   · legitimate free work treated as unknown (the regression the fix must NOT
//     reintroduce — refusing every $0 is what made honest free work unsendable)
//
// ⚠️⚠️ COMMIT FIRST. This rewrites tracked files and restores with
//     `git checkout -- .`, which DESTROYS uncommitted work. It refuses to run on
//     a dirty tree, and it verifies the tree is byte-identical when it finishes.
//
// ⚠️ A mutation that changes nothing reads as SURVIVED and looks like a guard
//     hole. Every mutation below asserts its own edit actually landed before the
//     guard is run — a no-op is reported as a BROKEN MUTATION, never as a miss.

import { execSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const GUARD = 'scripts/verify-unpriced-work.ts'

const VISIT   = 'src/lib/visitValue.ts'
const STATE   = 'src/lib/pricingState.ts'
const OPTIONS = 'src/lib/quoteOptions.ts'
const STATUS  = 'src/lib/quoteStatus.ts'
const BUILDER = 'src/components/quotes/QuoteBuilder.tsx'
const JOBFORM = 'src/components/schedule/JobForm.tsx'
const SCHED   = 'src/app/dashboard/schedule/page.tsx'

const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim()

if (sh('git status --porcelain')) {
  console.error('✗ working tree is dirty. Commit first — restore is `git checkout -- .`,')
  console.error('  which would destroy uncommitted work.')
  process.exit(2)
}
const TREE_BEFORE = sh('git rev-parse HEAD') + '|' + sh('git status --porcelain')

const runGuard = () => {
  const r = spawnSync('npx', ['tsx', GUARD], { encoding: 'utf8', shell: true })
  return { green: r.status === 0, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

console.log('── baseline: the guard must be GREEN before we break anything ──')
const base = runGuard()
if (!base.green) {
  console.error('✗ the guard is already red — fix that first, this test is meaningless otherwise.')
  console.error(base.out.split('\n').filter(l => l.includes('✗')).join('\n'))
  process.exit(2)
}
console.log('   ✓ green\n')

let caught = 0, missed = 0, broken = 0

/** Apply one mutation, run the guard, restore. */
function mutate(name, file, from, to) {
  const path = file
  const before = readFileSync(path, 'utf8')
  const after = before.replace(from, to)
  if (after === before) {
    broken++
    console.log(`  ⚠ BROKEN MUTATION  ${name}`)
    console.log(`      the edit did not apply — its pattern no longer matches ${file}.`)
    console.log('      This is NOT a guard hole; it is a stale mutation. Fix the pattern.')
    return
  }
  writeFileSync(path, after)
  try {
    const r = runGuard()
    if (r.green) {
      missed++
      console.log(`  ✗ MISSED   ${name}`)
      console.log('      the guard stayed GREEN with this break in place.')
    } else {
      caught++
      const first = r.out.split('\n').find(l => l.includes('✗'))?.trim() ?? ''
      console.log(`  ✓ caught   ${name}`)
      if (first) console.log(`      ${first}`)
    }
  } finally {
    writeFileSync(path, before)
  }
}

console.log('── 1 · unknown collapses back into zero ──')

mutate('the value engine returns 0 instead of unknown',
  VISIT, '  const total = Number(quote.total)\n  if (total) return total\n  return null',
  '  const total = Number(quote.total)\n  if (total) return total\n  return 0')

mutate('a job with no price and no quote resolves to 0, not unknown',
  VISIT, 'export function jobVisitValueOrNull(jobPrice: number | null | undefined, quote: Record<string, unknown> | null | undefined, freq: string | null, isInitial = false): DerivedAmount {\n  const p = Number(jobPrice)',
  'export function jobVisitValueOrNull(jobPrice: number | null | undefined, quote: Record<string, unknown> | null | undefined, freq: string | null, isInitial = false): DerivedAmount {\n  if (!quote && !jobPrice) return 0\n  const p = Number(jobPrice)')

mutate('the unknown label becomes a currency amount',
  STATE, "export const UNKNOWN_AMOUNT_TEXT = 'Not set'", "export const UNKNOWN_AMOUNT_TEXT = '$0.00'")

mutate('amountText renders an unknown as money',
  STATE, "  return amount == null ? UNKNOWN_AMOUNT_TEXT : money(amount)",
  "  return money(amount ?? 0)")

mutate('a total stops reporting what it excluded',
  STATE, '  if (!unknownCount || unknownCount < 1) return null',
  '  if (true) return null')

mutate('the summer counts unpriced records as zero instead of excluding them',
  STATE, '    if (a == null) { unknown++; continue }',
  '    if (a == null) { counted++; continue }')

console.log('\n── 2 · the free-work reason is bypassed ──')

mutate('a bare $0 is treated as free (no reason, no actor, no timestamp)',
  STATE, '  if (isNoCharge(q)) return \'no_charge\'\n  const t = Number(q.total)',
  '  if (isNoCharge(q) || Number(q.total) === 0) return \'no_charge\'\n  const t = Number(q.total)')

mutate('a no-charge record passes with only a timestamp',
  STATE, "  return !!(r?.no_charge_at && String(r.no_charge_reason ?? '').trim() && r?.no_charge_by)",
  '  return !!r?.no_charge_at')

mutate('a blank reason counts as a reason',
  STATE, "  return !!(r?.no_charge_at && String(r.no_charge_reason ?? '').trim() && r?.no_charge_by)",
  '  return !!(r?.no_charge_at && r?.no_charge_reason !== undefined && r?.no_charge_by)')

console.log('\n── 3 · legitimate free work treated as unknown (the regression to NOT reintroduce) ──')

mutate('the money doors refuse explicitly free work again',
  STATE, "  return s !== 'unpriced'", "  return s === 'priced'")

mutate('the send refusal stops offering the No charge route',
  STATUS, "    ? 'This quote has no price yet — add one, or mark it No charge, before sending it.'",
  "    ? 'This quote has no price yet — add one before sending it.'")

console.log('\n── 4 · an unpriced quote becomes sendable / acceptable ──')

mutate('a $0 quote becomes sendable',
  STATUS, "  if (!passesMoneyDoor(quotePriceState(q))) return 'no_price'",
  "  if (q.total == null) return 'no_price'")

mutate('the won gate is removed from the quote page',
  'src/app/dashboard/quotes/[id]/page.tsx',
  '    const wonBlock = moneyDoorBlock(quotePriceState(quote), \'won\')\n    if (wonBlock) { toast.error(wonBlock); return }',
  '    const wonBlock = null')

mutate('the status picker stops gating accepted/completed/paid',
  'src/components/quotes/QuoteStatusControl.tsx',
  "    if (s === 'accepted' || s === 'completed' || s === 'paid') {",
  '    if (false) {')

mutate('the invoice drafter stops refusing a $0 amount',
  'src/lib/invoicing.ts',
  "  if (!(amount > 0)) return { created: false, reason: 'no-amount' }",
  "  if (false) return { created: false, reason: 'no-amount' }")

console.log('\n── 5 · quote options ──')

mutate('all-zero options become acceptable again',
  OPTIONS, "  if (list.every(o => Number(o.price) === 0)) return 'all_unpriced'", '')

mutate('optionRowsFor coerces a blank price back to 0',
  OPTIONS, '    price: priceOrThrow(o.price, String(o.name).trim()),',
  '    price: Number(o.price) || 0,')

console.log('\n── 6 · the forms manufacture a zero again ──')

mutate('the QuoteBuilder pricing-package fallback returns to `?? 0`',
  BUILDER, "    const priceFor = (c: string) => pkg.options.find(o => o.cadence === c)?.price ?? null",
  "    const priceFor = (c: string) => pkg.options.find(o => o.cadence === c)?.price ?? 0")

mutate('an unpriceable cadence tile becomes tappable again',
  BUILDER, '<button key={opt.c} type="button" aria-pressed={active} disabled={unpriced}',
  '<button key={opt.c} type="button" aria-pressed={active}')

mutate('Add Job seeds the price field with 0 again',
  JOBFORM, '        price: BLANK,', '        price: 0,')

mutate('the job price hint tells the owner to leave 0',
  JOBFORM, "Leave blank to use the linked quote", "Leave 0 to use the linked quote")

mutate('the job editor renders a NULL price as 0 again',
  SCHED, '                price: editing.price ?? BLANK_NUMERIC_FIELD,',
  '                price: editing.price ?? 0,')

mutate('the save path writes 0 instead of NULL for a blank price',
  SCHED, '      price: Number(values.price) > 0 ? Number(values.price) : null,',
  '      price: Number(values.price) > 0 ? Number(values.price) : 0,')

console.log('\n── 7 · the guard\'s own machinery ──')

mutate('the banned `|| 0` sum expression comes back in a real file',
  'src/lib/dashboard/data.ts', '  const quotesOutTotal = sumQuoteAmounts(quotesOut).total',
  '  const quotesOutTotal = quotesOut.reduce((s, q) => s + Number(q.total || 0), 0)')

mutate('the no-charge proposal loses the accept-door fix',
  'supabase/proposals/no_charge_v1.sql',
  '  if not v_free and (v_base is null or v_base <= 0) then',
  '  if false then')

// ── Restore proof ────────────────────────────────────────────────────────────
const TREE_AFTER = sh('git rev-parse HEAD') + '|' + sh('git status --porcelain')
const restored = TREE_BEFORE === TREE_AFTER

console.log('\n════════════════════════════════════════════════════════════')
console.log(`  CAUGHT ${caught}   MISSED ${missed}   BROKEN ${broken}`)
console.log(`  tree restored byte-for-byte: ${restored ? 'YES' : 'NO — INVESTIGATE'}`)
console.log('════════════════════════════════════════════════════════════\n')

if (!restored) {
  console.error('✗ the working tree did not come back clean. Run `git status` before doing anything else.')
  process.exit(3)
}
process.exit(missed === 0 && broken === 0 ? 0 : 1)
