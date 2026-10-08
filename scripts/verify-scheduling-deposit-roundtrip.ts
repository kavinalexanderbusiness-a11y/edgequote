// Offline contract test: the real form-to-columns helper, JSON serialization,
// edit-form hydration, and the real scheduling gate. This does not connect to a
// database or verify a live database write. The source assertions pin both save
// doors and the edit hydration to the mapping exercised below.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  depositRuleFromForm, gateBlocksScheduling, schedulingGate,
  type GateLedgerRow, type GateQuote,
} from '../src/lib/payments/depositGate'

let passed = 0
function check(name: string, run: () => void) {
  run()
  passed++
  console.log(`  ✓ ${name}`)
}

function roundTrip(type: string, value: number | string) {
  const saved = depositRuleFromForm(type, value)
  if (!saved.ok) throw new Error(`valid rule rejected: ${type} ${value}: ${saved.error}`)
  const loaded = JSON.parse(JSON.stringify(saved.patch)) as typeof saved.patch
  // Mirrors the edit page's defaultValues mapping, pinned below.
  const form = {
    deposit_type: loaded.deposit_type ?? '',
    deposit_value: Number(loaded.deposit_value) || 0,
  }
  const resaved = depositRuleFromForm(form.deposit_type, form.deposit_value)
  if (!resaved.ok) throw new Error(resaved.error)
  assert.deepEqual(resaved.patch, saved.patch)
  return { saved: saved.patch, loaded, form }
}

const payment = (amount: number): GateLedgerRow => ({
  amount, kind: 'payment', provider: 'cash', status: 'paid',
})

console.log('\n■ Scheduling deposit: offline serialization and booking requirement')
for (const [total, required] of [[595, 297.50], [425, 212.50]] as const) {
  check(`50% of $${total} remains $${required.toFixed(2)} after save/load`, () => {
    const { loaded, form } = roundTrip('percent', '50')
    assert.deepEqual(form, { deposit_type: 'percent', deposit_value: 50 })
    const quote: GateQuote = { status: 'accepted', total, accepted_price: total, ...loaded }
    const unpaid = schedulingGate(quote, [])
    assert.equal(unpaid.required, required)
    assert.equal(unpaid.outstanding, required)
    assert.equal(unpaid.status, 'awaiting')
    assert.equal(gateBlocksScheduling(quote, unpaid), true)
    const paid = schedulingGate(quote, [payment(required)])
    assert.equal(paid.status, 'satisfied')
    assert.equal(paid.outstanding, 0)
    assert.equal(gateBlocksScheduling(quote, paid), false)
  })
}

check('fixed dollars keep their unit and cents after save/load', () => {
  const { loaded, form } = roundTrip('fixed', '212.50')
  assert.deepEqual(form, { deposit_type: 'fixed', deposit_value: 212.5 })
  const quote: GateQuote = { status: 'accepted', total: 595, accepted_price: 595, ...loaded }
  assert.equal(schedulingGate(quote, []).required, 212.5)
})

check('off writes both columns null and reloads off despite a retained form value', () => {
  const { saved, loaded, form } = roundTrip('', 50)
  assert.deepEqual(saved, { deposit_type: null, deposit_value: null })
  assert.deepEqual(form, { deposit_type: '', deposit_value: 0 })
  const quote: GateQuote = { status: 'accepted', total: 595, ...loaded }
  const gate = schedulingGate(quote, [])
  assert.equal(gate.required, 0)
  assert.equal(gate.status, 'none')
  assert.equal(gateBlocksScheduling(quote, gate), false)
})

check('a partial payment and a refund keep an accepted booking blocked', () => {
  const { loaded } = roundTrip('percent', 50)
  const quote: GateQuote = { status: 'accepted', total: 595, accepted_price: 595, ...loaded }
  const partial = schedulingGate(quote, [payment(100)])
  assert.equal(partial.status, 'partial')
  assert.equal(partial.outstanding, 197.5)
  assert.equal(gateBlocksScheduling(quote, partial), true)
  const refunded = schedulingGate(quote, [payment(297.5), payment(-297.5)])
  assert.equal(refunded.status, 'awaiting')
  assert.equal(gateBlocksScheduling(quote, refunded), true)
})

check('an owner override stamp records intent without reporting the deposit paid', () => {
  const { loaded } = roundTrip('percent', 50)
  const quote: GateQuote = {
    status: 'accepted', total: 425, accepted_price: 425, ...loaded,
    deposit_override_at: '2026-10-08T00:00:00Z',
  }
  const gate = schedulingGate(quote, [])
  assert.equal(gate.overridden, true)
  assert.equal(gate.outstanding, 212.5)
  assert.equal(gate.status, 'awaiting')
  assert.equal(gateBlocksScheduling(quote, gate), true)
})

check('the accepted price, rather than a later draft price, determines the percentage', () => {
  const { loaded } = roundTrip('percent', 50)
  assert.equal(schedulingGate({ status: 'accepted', total: 800, accepted_price: 595, ...loaded }, []).required, 297.5)
})

check('a fixed deposit is capped at the accepted price', () => {
  const { loaded } = roundTrip('fixed', 500)
  assert.equal(schedulingGate({ status: 'accepted', total: 425, accepted_price: 425, ...loaded }, []).required, 425)
})

for (const [type, value] of [
  ['percent', 0], ['percent', -1], ['percent', 101], ['percent', ''],
  ['fixed', 0], ['fixed', -1], ['fixed', 'invalid'], ['unknown', 50],
] as const) {
  check(`invalid ${type} ${JSON.stringify(value)} cannot silently save as no deposit`, () => {
    assert.equal(depositRuleFromForm(type, value).ok, false)
  })
}

const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8')
for (const file of ['src/app/dashboard/quotes/new/page.tsx', 'src/app/dashboard/quotes/[id]/page.tsx']) {
  check(`${file} uses the tested mapping and refuses invalid input`, () => {
    const code = source(file)
    assert.match(code, /depositRuleFromForm\(values\.deposit_type, values\.deposit_value\)/)
    assert.match(code, /if \(!depositRule\.ok\)\s*\{[\s\S]*?return false/)
    assert.match(code, /\.\.\.depositRule\.patch/)
  })
}
check('edit hydration restores both saved fields using the tested mapping', () => {
  const code = source('src/app/dashboard/quotes/[id]/page.tsx')
  assert.match(code, /deposit_type:\s*\(quote\.deposit_type\s*\?\?\s*''\)/)
  assert.match(code, /deposit_value:\s*Number\(quote\.deposit_value\)\s*\|\|\s*0/)
})

console.log(`\n✓ ${passed} offline scheduling-deposit roundtrip checks passed`)
