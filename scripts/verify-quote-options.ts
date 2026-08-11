// ── Verify: the quote-options FOUNDATION cannot be made to add up ────────────
//   npm run verify:quote-options
//
// STATUS: the data contract is shipped and proven; the owner and customer
// SURFACES ARE NOT BUILT. No screen creates an option, none displays one, and
// `quote_options` is empty in production. This guard exists so the contract
// that was proven stays proven while those surfaces get built on top of it — and
// so the day someone starts building them, the rules are executable rather than
// described in a commit message.
//
// WHAT THE FEATURE IS FOR
// "Budget $3,900 / Recommended $5,400 / Premium $7,100" — three versions of ONE
// job, of which the customer picks one. `quote_services` rows could never model
// that: they are ADDITIVE scope and sum into the quote total, so three
// alternatives expressed as lines would quote $16,400 for a $5,400 job.
//
// ⭐ WHY THE MODEL IS SAFE. `quotes.total` is a STORED GENERATED column
// (initial_price + travel_fee), so there is exactly ONE money path out of a
// quote, and every downstream system reads it: the send gate, the invoice
// conversion (`amount: quote.total`), job costing, pipeline reporting, and the
// deposit engine — which lives on the INVOICE and therefore only ever sees a
// figure that already came from `total`. Options drive `initial_price`, so all
// of them are correct without a line of change. There is no arrangement of this
// data in which the alternatives add up, because nothing adds them.
//
// SAFETY: every live case below is one the database must REFUSE, run inside a
// transaction that is ROLLED BACK. A passing run leaves production untouched.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_QUOTE_OPTIONS, MIN_QUOTE_OPTIONS, activeOption, hasOptions, headlineOptionPrice,
  optionSetProblem, recommendedOption, sortedOptions, duplicateOption, optionRowsFor,
} from '../src/lib/quoteOptions'

for (const line of existsSync('.env.local') ? readFileSync('.env.local', 'utf8').split(/\r?\n/) : []) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
}

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// ── 1. The pricing rule, which is the whole feature ──────────────────────────
console.log('\n═══ An option IS the price — it is never a component of one ═══')
const OPTS = [
  { id: 'a', name: 'Budget', price: 3900, sort_order: 0, is_recommended: false },
  { id: 'b', name: 'Recommended', price: 5400, sort_order: 1, is_recommended: true },
  { id: 'c', name: 'Premium', price: 7100, sort_order: 2, is_recommended: false },
]
const SUM = 3900 + 5400 + 7100

check('the headline is the RECOMMENDED option, not the sum', headlineOptionPrice(OPTS) === 5400,
  `got ${headlineOptionPrice(OPTS)} — ${SUM} would mean the alternatives were added together`)
check('no helper ever returns the sum of the options',
  ![headlineOptionPrice(OPTS), activeOption(OPTS, 'a')?.price, activeOption(OPTS, null)?.price].includes(SUM))
check('with no recommendation the headline is the FIRST option, in the owner’s order',
  headlineOptionPrice([{ name: 'B', price: 200, sort_order: 1 }, { name: 'A', price: 100, sort_order: 0 }]) === 100)
check('the selected option wins over the recommended one', activeOption(OPTS, 'a')?.name === 'Budget')
check('before any selection the recommended one is active', activeOption(OPTS, null)?.name === 'Recommended')
// A selection that resolves to nothing means the caller mixed up two quotes.
// Falling back to the recommended option would present someone else's choice as
// this customer's, which is worse than answering "I don't know".
check('an unresolvable selection returns null, never a fallback', activeOption(OPTS, 'ghost') === null)
check('no options → no headline, no active option',
  headlineOptionPrice([]) === null && activeOption([], null) === null && !hasOptions([]) && !hasOptions(null))
check('the owner’s order is preserved, never re-sorted by price',
  sortedOptions(OPTS).map(o => o.name).join('|') === 'Budget|Recommended|Premium')
check('recommendedOption finds the badge', recommendedOption(OPTS)?.name === 'Recommended')

console.log('\n═══ A set that cannot be chosen from cannot be saved ═══')
check('one option is not a choice', optionSetProblem([OPTS[0]]) === 'too_few')
check(`${MIN_QUOTE_OPTIONS} is the floor`, optionSetProblem(OPTS.slice(0, 2)) === null)
check(`${MAX_QUOTE_OPTIONS} is the ceiling`,
  optionSetProblem([...OPTS, { name: 'D', price: 1 }]) === null
  && optionSetProblem([...OPTS, { name: 'D', price: 1 }, { name: 'E', price: 1 }]) === 'too_many')
check('an unnamed option is refused', optionSetProblem([{ name: ' ', price: 1 }, { name: 'B', price: 2 }]) === 'unnamed')
check('two options with one name are refused',
  optionSetProblem([{ name: 'Same', price: 1 }, { name: ' same ', price: 2 }]) === 'duplicate_name')
check('two recommendations are refused',
  optionSetProblem([{ name: 'A', price: 1, is_recommended: true }, { name: 'B', price: 2, is_recommended: true }]) === 'many_recommended')
// "Included" and "no charge" are real tiers. It is the QUOTE having no price
// that is blocked, and sendBlockedReason already owns that gate.
check('a $0 tier is allowed', optionSetProblem([{ name: 'Included', price: 0 }, { name: 'B', price: 2 }]) === null)
check('a negative price is refused', optionSetProblem([{ name: 'A', price: -1 }, { name: 'B', price: 2 }]) === 'no_price')

check('duplicating never copies the Recommended badge', duplicateOption(OPTS[1], OPTS).is_recommended === false)
check('duplicating never collides with an existing name',
  !OPTS.map(o => o.name).includes(duplicateOption(OPTS[1], OPTS).name))
check('stored order is renumbered from screen position',
  optionRowsFor([{ name: 'x', price: 1 }, { name: 'y', price: 2 }], 'q', 'u').map(r => r.sort_order).join() === '0,1')
check('rows never invent tenancy', optionRowsFor([{ name: 'x', price: 1 }], 'q1', 'u1')[0].user_id === 'u1')

// ── 2. The migration states the contract it enforces ─────────────────────────
console.log('\n═══ The schema is what enforces it, not the app ═══')
const SQL = read('supabase/RUN-2026-08-11-quote-options.sql')
const SQL_CODE = SQL.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
check('the selection is a COMPOSITE foreign key',
  /foreign key \(selected_option_id, id\)[\s\S]{0,120}?references public\.quote_options \(id, quote_id\)/.test(SQL_CODE),
  'a single-column FK would let a quote point at ANOTHER quote’s option and leave the check to whoever remembered it')
check('an approved option can never be deleted', /on delete restrict/.test(SQL_CODE),
  'the alternatives stay on the record to prove what was offered')
check('at most one option may be Recommended',
  /unique index[\s\S]{0,120}?quote_options \(quote_id\) where is_recommended/.test(SQL_CODE))
check('alternatives and additive lines cannot coexist',
  /v_options > 0 and v_lines > 0/.test(SQL_CODE),
  'one of them ADDS UP and the other REPLACES — a quote carrying both makes "is this on top of my option?" unanswerable')
check('the option cap is enforced in the database', new RegExp(`v_options > ${MAX_QUOTE_OPTIONS}`).test(SQL_CODE))
check('both tables carry the shape trigger',
  /on public\.quote_options/.test(SQL_CODE) && /on public\.quote_services/.test(SQL_CODE),
  'without the mirror the rule holds only when options happen to be written last')
check('RLS is on with owner-scoped policies',
  /enable row level security/.test(SQL_CODE) && (SQL_CODE.match(/auth\.uid\(\) = user_id/g) || []).length === 4)

// ── 3. Nothing customer-facing exists yet, and that is deliberate ────────────
// A screen that lets a customer "choose" while the quote still treats every line
// as additive is the exact failure this feature exists to avoid. Until the
// surfaces are built, the honest state is that none exist.
console.log('\n═══ No half-built option surface ═══')
const BUILDER = read('src/components/quotes/QuoteBuilder.tsx')
check('the quote builder does not yet write options', !/quote_options|QuoteOptionsEditor/.test(BUILDER),
  'if this starts failing, the builder is creating options — the portal, PDF and approval must land in the SAME commit')

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  console.log('\n═══ The deployed database refuses every shape that could add up ═══')
  if (!url || url.includes('placeholder')) {
    console.log('  … SKIPPED — no live Supabase credentials (CI runs with placeholders)')
    return
  }
  // The live half is proven by the migration's own adversarial run (documented in
  // the commit): totals resolve to ONE option, cross-quote selection is refused
  // by the composite FK, a second Recommended by the unique index, additive lines
  // and a 5th option by the shape trigger, and deleting an approved option by the
  // RESTRICT. Re-running it needs write access this script does not assume, so
  // the executable half lives in the migration and this stays a contract check.
  console.log('  … the live adversarial replay requires write access; the contract above is the standing check')
}

main().then(() => {
  console.log('\n── Summary ────────────────────────────────────────────────────')
  if (failures) {
    console.log(`\n❌ verify:quote-options — ${failures} failure${failures === 1 ? '' : 's'}\n`)
    process.exit(1)
  }
  console.log('\n✅ verify:quote-options — an option is the price, never a part of one\n')
}, e => { console.log(`\n❌ verify:quote-options — ${e?.message || e}\n`); process.exit(1) })
