// ── Customer V2 verification — run by CI on every push (npm run verify:customer-v2) ──
//
// Customer → Property, as build failures instead of intentions:
//
//   1. THE RESOLVER: displayAddress is the ONE place display-address precedence
//      lives (primary property → any property → legacy customers.address → '').
//      Every list/picker/export reads it; these pin its order so no consumer can
//      quietly disagree about where a customer "is".
//   2. THE FORM SPLIT: the customer form carries the relationship only. Source
//      pins assert no address field can sneak back in, and that the create page
//      no longer writes property rows itself (the guided step, through
//      PropertySelect → ensurePropertyForCustomer, is the only way).
//   3. DERIVED PLANS: service plans attribute to properties THROUGH jobs —
//      job_recurrences deliberately has no property_id column. Pin its absence:
//      adding one would fork attribution into two places.
//
// Style follows the other verify scripts: deterministic, no network, no DB.

import { readFileSync } from 'fs'
import { join } from 'path'
import { displayAddress, normalizeTags, findCustomerMatch, phoneMatches } from '../src/lib/customers'
import type { Customer } from '../src/types'

let pass = 0
let fail = 0
function H(title: string) { console.log(`\n═══ ${title} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}
const SRC = join(__dirname, '..', 'src')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

// ═══════════════════════════════════════════════════════════════════════════
H('1. displayAddress — one precedence, everywhere')
check('primary property wins over legacy customer columns',
  displayAddress({ address: 'OLD 1 Legacy Rd', city: 'Oldtown', properties: [
    { address: '77 Second St', city: 'Calgary', is_primary: false },
    { address: '12 Primary Ave', city: 'Airdrie', is_primary: true },
  ] }),
  { address: '12 Primary Ave', city: 'Airdrie' })
check('no primary → first property (a property still beats the legacy copy)',
  displayAddress({ address: 'OLD', properties: [{ address: '77 Second St', city: 'Calgary', is_primary: false }] }),
  { address: '77 Second St', city: 'Calgary' })
check('no properties → legacy customers.address (pre-M4 rows keep working)',
  displayAddress({ address: '1 Legacy Rd', city: 'Oldtown', properties: [] }),
  { address: '1 Legacy Rd', city: 'Oldtown' })
check('properties not joined (undefined) → legacy fallback, not a crash',
  displayAddress({ address: '1 Legacy Rd', city: 'Oldtown' }),
  { address: '1 Legacy Rd', city: 'Oldtown' })
check('a primary property with a NULL address falls through to the legacy copy',
  displayAddress({ address: '1 Legacy Rd', properties: [{ address: null, city: null, is_primary: true }] }),
  { address: '1 Legacy Rd', city: '' })
check('nothing anywhere → empty strings, never undefined',
  displayAddress({}), { address: '', city: '' })

// ═══════════════════════════════════════════════════════════════════════════
H('2. normalizeTags — what the form shows is what stores')
check('trims, drops empties', normalizeTags(['  VIP ', '', '  ', null, undefined]), ['VIP'])
check('dedupes case-insensitively, first spelling wins', normalizeTags(['VIP', 'vip', 'Vip', 'landlord']), ['VIP', 'landlord'])
check('preserves entry order', normalizeTags(['b', 'a', 'c']), ['b', 'a', 'c'])

// ═══════════════════════════════════════════════════════════════════════════
H('3. SOURCE PINS — the form split cannot quietly regress')
const form = read('components/customers/CustomerForm.tsx')
check('CustomerForm registers no address field',
  ['address', 'city', 'province', 'postal_code'].filter(f => form.includes(`register('${f}')`) || form.includes(`name="${f}"`)), [])
check('CustomerForm carries the tags input', form.includes("name=\"tags\""), true)
const createPage = read('app/dashboard/customers/page.tsx')
check('the create page writes NO property rows itself (the guided step owns it)',
  createPage.includes("from('properties').insert"), false)
check('the guided step goes through PropertySelect (ensurePropertyForCustomer — the one find-or-create)',
  createPage.includes('PropertySelect'), true)
const types = read('types/index.ts')
const cfv = types.slice(types.indexOf('interface CustomerFormValues'), types.indexOf('}', types.indexOf('interface CustomerFormValues')))
check('CustomerFormValues has no address fields', ['address:', 'city:', 'province:', 'postal_code:'].filter(f => cfv.includes(f)), [])
check('CustomerFormValues has tags', cfv.includes('tags: string[]'), true)
const importPage = read('app/dashboard/customers/import/page.tsx')
const customersInsert = importPage.slice(importPage.indexOf('const insertRows'), importPage.indexOf("from('customers').insert"))
check('CSV import puts the address on the PROPERTY, not the customer row',
  customersInsert.includes('address'), false)

// ═══════════════════════════════════════════════════════════════════════════
H('4. DERIVED PLANS — attribution has one path')
const schema = readFileSync(join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8')
const recBlock = schema.slice(schema.indexOf('create table if not exists public.job_recurrences'), schema.indexOf(');', schema.indexOf('create table if not exists public.job_recurrences')))
check('job_recurrences has NO property_id column (plans derive from jobs.property_id — buildServicePlans)',
  recBlock.includes('property_id'), false)

// ═══════════════════════════════════════════════════════════════════════════
H('5. IDENTITY MATCHER — the app door agrees with the SQL intake seam (BK-1)')
// phoneMatches is the app-side half of resolve_intake_customer's `right(digits,10)`
// rule. If these two ever disagree, one person books once and quotes once and becomes
// two customers — the exact fork BK-1 closed on the SQL side.
check('same number, different formatting → match (unchanged)',
  phoneMatches('(403) 555-0100', '403-555-0100'), true)
check('country-code variant → match (the fix: "+1 403…" == "403…")',
  phoneMatches('+1 403 555 0100', '4035550100'), true)
check('leading 1 on BOTH lengths still resolves to one national number',
  phoneMatches('14035550100', '4035550100'), true)
check('different national numbers never collide (last ten differ)',
  phoneMatches('4035550100', '4035559999'), false)
check('same last 7 but different area code → NOT the same number',
  phoneMatches('4035550100', '5875550100'), false)
check('a partial/too-short number is never a confident match',
  phoneMatches('555', '5551234'), false)
check('two blanks do not match (a missing number links nobody)',
  phoneMatches('', ''), false)

// End-to-end through findCustomerMatch: a returning caller whose stored number carries
// a country code must resolve to the SAME customer, by phone, confidently.
const C = (o: Partial<Customer>) => o as Customer
const book: Customer[] = [
  C({ id: 'c1', name: 'Pat Lang', phone: '+1 (403) 555-0100', email: 'pat@example.com', address: '84 17 St NW' }),
  C({ id: 'c2', name: 'Sam Ng', phone: '(587) 555-0199', email: 'sam@example.com', address: '7 Parkdale Cres NW' }),
]
check('country-code-variant phone resolves to the existing customer, reason=phone',
  findCustomerMatch(book, { phone: '4035550100' }), { customer: book[0], reason: 'phone', confident: true })
check('exact-format phone still resolves (no regression)',
  findCustomerMatch(book, { phone: '403-555-0100' }), { customer: book[0], reason: 'phone', confident: true })
check('an unknown phone does NOT phone-match; falls through to email',
  findCustomerMatch(book, { phone: '4035551234', email: 'SAM@example.com' })?.reason, 'email')
check('a genuinely new contact matches nobody',
  findCustomerMatch(book, { phone: '4035551234', email: 'new@example.com', name: 'Nobody Here' }), null)

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
