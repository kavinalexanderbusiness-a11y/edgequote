// ── Invoice search regression suite — `npm run verify:invoice-search` ────────
//
// The invoice list is where an owner goes when a customer says "I already paid
// that one". Search failing is not a cosmetic bug: it ends with the owner insisting
// on money that is already in the bank, or failing to chase money that isn't.
//
// These run the REAL engine (src/lib/invoiceSearch) the page filters with — no
// mocks, no network. Deterministic.

import {
  searchInvoices, buildInvoiceSearchIndex, queryTokens, entryMatches,
  type SearchableInvoice,
} from '../src/lib/invoiceSearch'
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const H = (t: string) => console.log(`\n── ${t} ──`)

type Inv = SearchableInvoice & { id: string; status: string; amount_paid?: number }

const INVOICES: Inv[] = [
  { id: 'a', invoice_number: 'INV-0052', customer_name: 'Maggie Maldonado', address: '35 Cranarch Circle Southeast', service_type: 'Mowing', status: 'paid',
    customers: { name: 'Maggie Maldonado', email: 'maggie@example.com', phone: '403-555-0142' } },
  { id: 'b', invoice_number: 'INV-0065', customer_name: 'Laura', address: '12 Aspen Way SW', service_type: 'Snow Removal', status: 'sent',
    customers: { name: 'Laura', email: 'laura@example.com', phone: '(587) 555-9931' } },
  { id: 'c', invoice_number: 'INV-0004', customer_name: 'Lori', address: '9 Riverbend Rd', service_type: 'Mowing', status: 'partial', amount_paid: 30,
    customers: { name: 'Lori', email: null, phone: null } },
  { id: 'd', invoice_number: 'INV-0113', customer_name: "O'Brien Landscaping", address: null, service_type: 'Fence Repair', status: 'unpaid',
    customers: { name: "O'Brien Landscaping", email: 'ops@obrien.co', phone: null } },
]
const ids = (rows: Inv[]) => rows.map(r => r.id).sort().join(',')

// ═══════════════════════════════════════════════════════════════════════════
H('1. invoice number — the identifier owners actually quote')
check('exact number', ids(searchInvoices(INVOICES, 'INV-0052')) === 'a')
check('lowercase, no dash', ids(searchInvoices(INVOICES, 'inv0052')) === 'a')
check('with a space instead of the dash', ids(searchInvoices(INVOICES, 'inv 0052')) === 'a')
// The owner reads "52" off a bank statement or a text message, not "INV-0052".
check('bare number without leading zeros finds it', ids(searchInvoices(INVOICES, '52')) === 'a')
check('the padded form still works', ids(searchInvoices(INVOICES, '0052')) === 'a')
check('a number that matches nothing returns nothing', searchInvoices(INVOICES, 'INV-9999').length === 0)

H('2. customer name')
check('full name', ids(searchInvoices(INVOICES, 'Maggie Maldonado')) === 'a')
check('surname only', ids(searchInvoices(INVOICES, 'Maldonado')) === 'a')
check('an apostrophe in the name is not a trap', ids(searchInvoices(INVOICES, "O'Brien")) === 'd')
check('… and it is findable without the apostrophe too', ids(searchInvoices(INVOICES, 'obrien')) === 'd')

H('3. partial match')
check('name prefix', ids(searchInvoices(INVOICES, 'Mag')) === 'a')
check('mid-word fragment matches', ids(searchInvoices(INVOICES, 'donad')) === 'a')
// Substring, deliberately NOT fuzzy: a typo must return nothing rather than a
// confident wrong invoice. "Did you mean" is a different feature with a different
// risk profile — silently matching a transposition on a money screen is not it.
check('a transposed typo does NOT match', searchInvoices(INVOICES, 'mladonado').length === 0)
check('street fragment', ids(searchInvoices(INVOICES, 'Cranarch')) === 'a')
check('service fragment', ids(searchInvoices(INVOICES, 'mow')) === 'a,c')
check('email fragment', ids(searchInvoices(INVOICES, 'laura@')) === 'b')
check('phone typed with different punctuation', ids(searchInvoices(INVOICES, '587 555 9931')) === 'b')

H('4. mixed case')
check('ALL CAPS', ids(searchInvoices(INVOICES, 'MAGGIE')) === 'a')
check('sTuDLy', ids(searchInvoices(INVOICES, 'mAgGiE')) === 'a')
check('mixed-case address', ids(searchInvoices(INVOICES, 'aspen WAY')) === 'b')

H('5. no result — and it must be EMPTY, not everything')
check('gibberish returns zero rows', searchInvoices(INVOICES, 'zzzzqqq').length === 0)
check('a real word that is in no invoice returns zero', searchInvoices(INVOICES, 'helicopter').length === 0)

H('6. multi-token narrows (AND), it does not widen')
check('two tokens must BOTH match', ids(searchInvoices(INVOICES, 'mowing lori')) === 'c')
check('… so an impossible pair returns nothing', searchInvoices(INVOICES, 'mowing laura').length === 0)

H('7. search COMPOSES with a status filter rather than replacing it')
// The page filters by status first, then hands that subset to the search engine.
// This is that contract: searching a filtered list can only ever narrow it.
const partialOnly = INVOICES.filter(i => i.status === 'partial')
check('a partially-paid invoice is findable by number', ids(searchInvoices(partialOnly, 'INV-0004')) === 'c')
check('… by customer name', ids(searchInvoices(partialOnly, 'lori')) === 'c')
check('… and by bare number', ids(searchInvoices(partialOnly, '4')) === 'c')
const paidOnly = INVOICES.filter(i => i.status === 'paid')
check('a term matching another status finds nothing inside this one', searchInvoices(paidOnly, 'lori').length === 0)
check('search never returns a row outside the filtered set',
  searchInvoices(partialOnly, 'mowing').every(r => r.status === 'partial'))
check('the result is always a subset of what it was given',
  searchInvoices(INVOICES, 'mow').every(r => INVOICES.includes(r)))

H('8. clearing search restores the list WITHOUT touching the filter')
check('an empty query returns every row it was given', ids(searchInvoices(INVOICES, '')) === 'a,b,c,d')
check('whitespace-only is also "not searching"', ids(searchInvoices(INVOICES, '   ')) === 'a,b,c,d')
// The status subset must come back intact — clearing search must not silently
// promote the owner back to "All".
check('clearing inside a status filter returns that status, not everything',
  ids(searchInvoices(partialOnly, '')) === 'c')
check('queryTokens treats blank input as no filter at all', queryTokens('  ').length === 0)

H('9. an empty book vs a failed load')
check('searching an empty list is empty, never a throw', searchInvoices([], 'anything').length === 0)
// The list is gated on loadError BEFORE the empty state renders, so "we could not
// reach the server" can never be shown as "you have no invoices". Pinned here
// because it is one deleted ternary away from being the worst bug on this page.
const page = readFileSync('src/app/dashboard/invoices/page.tsx', 'utf8')
check('the invoice page still renders nothing (not "no invoices") while loadError is set',
  /loadError\s*\?\s*null\s*:/.test(page))
check('… and still shows a retry banner for that error', /loadError\s*&&/.test(page) && /Retry/.test(page))

H('10. the index is reusable across keystrokes (what the page relies on)')
const index = buildInvoiceSearchIndex(INVOICES)
check('index has one entry per invoice', index.length === INVOICES.length)
check('entries carry both haystacks', index.every(e => typeof e.text === 'string' && typeof e.ident === 'string'))
check('entryMatches agrees with searchInvoices',
  ids(index.filter(e => entryMatches(e, queryTokens('mow'))).map(e => e.item)) === ids(searchInvoices(INVOICES, 'mow')))
check('no token list matches an entry it should not', !entryMatches(index[0], queryTokens('laura')))

console.log(`\n${fail === 0 ? '✓' : '✗'} invoice search checks: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
