/* eslint-disable no-console */
// Regression guard for the invoice payment-status engine.
//
// THE BUG THIS PINS (2026-07-26, INV-0025): recompute_invoice_paid derives
// invoices.amount_paid/status/paid_at from the payments ledger, but its only
// trigger sat on PAYMENTS. Editing the invoice itself — a discount reducing the
// total to exactly what had been paid — changed the other half of the equation
// and nothing refired the engine: balance $0, status stuck 'partial', paid_at
// never stamped. The fix moved the recompute body verbatim into ONE core
// function (recompute_invoice_paid_for) with two ignitions: the payments
// trigger and trg_recompute_invoice_on_edit on invoices' money columns.
//
// The engine is SQL, so this harness can't execute it; instead it pins the
// WIRING that made the bug possible: the one-engine shape, the edit trigger's
// column list covering every money column the editor writes, the unchanged
// status thresholds, and the editor reading the derived row back. The app-side
// balance maths uses the REAL functions — nothing is reimplemented here.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { invoiceBalance, displayInvoiceStatus } from '@/lib/payments/ledger'
import type { FeeSettings } from '@/lib/invoiceTotals'

let pass = 0, fail = 0
const fails: string[] = []
function check(group: string, name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(`${group} › ${name}`); console.log(`  ❌ ${name}\n       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`) }
}
const H = (s: string) => console.log(`\n═══ ${s} ═══`)

const SCHEMA = readFileSync(resolve(process.cwd(), 'supabase/schema.sql'), 'utf8')
const RUN = readFileSync(resolve(process.cwd(), 'supabase/RUN-2026-07-26-invoice-status-on-total-edit.sql'), 'utf8')
const PAGE = readFileSync(resolve(process.cwd(), 'src/app/dashboard/invoices/page.tsx'), 'utf8')

// schema.sql is an append log — old definitions of a function remain above the
// current one. Every structural check below therefore runs on the LAST
// definition, exactly what the DB holds after replaying the file.
function lastDef(src: string, header: string): string {
  const i = src.lastIndexOf(header)
  if (i < 0) return ''
  const end = src.indexOf('end; $$;', i)
  return end < 0 ? src.slice(i) : src.slice(i, end + 'end; $$;'.length)
}

H('one engine, two ignitions (schema.sql = what the DB holds)')
{
  const core = lastDef(SCHEMA, 'create or replace function public.recompute_invoice_paid_for(p_invoice_id uuid)')
  const payFn = lastDef(SCHEMA, 'create or replace function public.recompute_invoice_paid()')
  const editFn = lastDef(SCHEMA, 'create or replace function public.recompute_invoice_paid_on_edit()')

  check('engine', 'core recompute_invoice_paid_for exists', core.length > 0, true)
  check('engine', 'core derives the total from amount × (1 + gst)', /v_total := round\(v_inv\.amount \* \(1 \+ v_gst \/ 100\), 2\);/.test(core), true)
  check('engine', 'payments trigger fn delegates to the core', /perform public\.recompute_invoice_paid_for\(coalesce\(new\.invoice_id, old\.invoice_id\)\);/.test(payFn), true)
  check('engine', '➜ and no longer carries its own status CASE', payFn.includes("'partial'"), false)
  check('engine', 'edit trigger fn delegates to the core', /perform public\.recompute_invoice_paid_for\(new\.id\);/.test(editFn), true)
  check('engine', '➜ and no longer carries its own status CASE', editFn.includes("'partial'"), false)

  // The status rule the task froze — thresholds verbatim. A drift here is an
  // accounting-rule change, not a wiring change, and must be a deliberate one.
  check('engine', "core: 'partial' below total by more than a cent", core.includes("when v_paid + 0.01 < v_total then 'partial'"), true)
  check('engine', "core: 'paid' within a cent of total", core.includes("when v_paid <= v_total + 0.01 then 'paid'"), true)
  check('engine', "core: anything above is 'overpaid'", core.includes("else 'overpaid'"), true)
  check('engine', 'core: cancelled stays terminal', core.includes("when status = 'cancelled' then status"), true)
  check('engine', 'core: draft stays draft', core.includes("when status = 'draft' then status"), true)
  check('engine', 'core: paid_at stamps when settled, clears when not', core.includes('paid_at = case when v_paid + 0.01 >= v_total and v_total > 0 then coalesce(paid_at, now()) else null end'), true)
}

H('the edit ignition (the trigger the bug was missing)')
{
  const trgAt = SCHEMA.lastIndexOf('create trigger trg_recompute_invoice_on_edit')
  const trg = trgAt < 0 ? '' : SCHEMA.slice(trgAt, SCHEMA.indexOf(';', trgAt) + 1)
  check('trigger', 'trg_recompute_invoice_on_edit exists on invoices', /after update of [^;]* on public\.invoices/.test(trg), true)
  check('trigger', 'AFTER (so the nested UPDATE fires the status triggers, like a payment does)', trg.includes('after update of'), true)
  check('trigger', 'guarded to real changes (is distinct from)', (trg.match(/is distinct from/g) || []).length, 3)
  check('trigger', 'executes the delegate fn', trg.includes('execute function public.recompute_invoice_paid_on_edit()'), true)

  // THE regression invariant: every money column the invoice editor writes must
  // be in the trigger's column list. Add a money column to the editor without
  // extending the trigger and the 2026-07-26 bug returns for that column.
  const colList = (trg.match(/after update of ([^\n]*) on public\.invoices/) || [])[1] || ''
  const trgCols = colList.split(',').map(s => s.trim())
  const editorMoneyCols = [...PAGE.matchAll(/patch\.(amount|discount_type|discount_value|line_items)\b/g)].map(m => m[1])
  // line_items is presentation (the PDF breakdown); `amount` is the figure every
  // total reads — the engine's total never consumes line_items directly.
  const totalDefining = [...new Set(editorMoneyCols)].filter(c => c !== 'line_items')
  check('trigger', 'editor writes the expected money columns', totalDefining.sort(), ['amount', 'discount_type', 'discount_value'])
  check('trigger', 'every total-defining column the editor writes is watched by the trigger',
    totalDefining.every(c => trgCols.includes(c)), true)
}

H('RUN file mirrors the schema (what was actually applied)')
{
  check('run', 'defines the core fn', RUN.includes('create or replace function public.recompute_invoice_paid_for(p_invoice_id uuid)'), true)
  check('run', 'defines the edit trigger', RUN.includes('create trigger trg_recompute_invoice_on_edit'), true)
  check('run', 'closes the REST surface on the core fn', RUN.includes('revoke execute on function public.recompute_invoice_paid_for(uuid) from public, anon, authenticated'), true)
  check('run', 'closes the REST surface on the edit trigger fn', RUN.includes('revoke execute on function public.recompute_invoice_paid_on_edit() from public, anon, authenticated'), true)
}

H('editor reads the derived row back (the pill updates without a refresh)')
{
  check('editor', 'save() re-selects status/amount_paid/paid_at after the money update',
    /\.select\('status, amount_paid, paid_at'\)\.eq\('id', inv\.id\)/.test(PAGE), true)
}

H('app-side balance on the repro fixture (real engines, no reimplementation)')
{
  const FEES: FeeSettings = { gst_percent: 0 }
  // INV-0025 as it stood: $100 gross, $25 discount → stored net 75, paid 75.
  const inv = { amount: 75, amount_paid: 75, discount_type: 'amount' as const, discount_value: 25 }
  const b = invoiceBalance(inv, FEES)
  check('balance', 'total is the discounted $75 (discount already inside amount)', b.total, 75)
  check('balance', 'balance is $0 — the state the status must agree with', b.balance, 0)
  check('balance', 'not overpaid', b.overpaid, 0)
  // With the DB now deriving 'paid', the display pipeline passes it through —
  // and a settled invoice can never present as overdue.
  const ds = displayInvoiceStatus({ ...inv, status: 'paid', due_date: '2000-01-01', viewed_at: null }, FEES, '2026-07-26')
  check('balance', "settled + past due displays 'paid', never 'overdue'", ds, 'paid')
}

console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fails.length) { console.log('\n  FAILURES:'); fails.forEach(f => console.log('   • ' + f)) }
process.exit(fail ? 1 : 0)
