// ── Verify: multi-location customer UX (Session 94) ──────────────────────────
//   npm run verify:customer-locations
//
// One customer, several service locations. The model was already right —
// properties ARE the locations, jobs/quotes/invoices carry property_id — and the
// customer profile, job form and invoice dialog already asked "which address?"
// properly. What S94 fixed was the places that DIDN'T ask:
//
//   · the quote builder silently pointed every quote at the PRIMARY address —
//     the saved addresses are now one-tap choices, and the measured price
//     follows the picked location instead of always pricing the primary's lawn
//   · work → location had no door (visit editor and quote detail now link the
//     location; quote detail also links the customer)
//   · location → sibling locations had no door (property page now hops between
//     a customer's addresses without the round trip through their profile)
//
// Static source checks, anchored on RENDERED forms and executable statements —
// never on comments (the verify-back-office trap).

import { readFileSync } from 'fs'
import { join } from 'path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { isMeasurementHandoffCompatible } from '../src/lib/measurementHandoff'

const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name: string, ok: boolean, why?: string) {
  if (ok) console.log(`  ✓ ${name}`)
  else { failures++; console.log(`  ✗ ${name}${why ? `\n      ${why}` : ''}`) }
}

const QB = read('src/components/quotes/QuoteBuilder.tsx')
const QUOTE_NEW = read('src/app/dashboard/quotes/new/page.tsx')
const QUOTE_DETAIL = read('src/app/dashboard/quotes/[id]/page.tsx')
const SCHEDULE = read('src/app/dashboard/schedule/page.tsx')
const PROP_DETAIL = read('src/app/dashboard/properties/[id]/page.tsx')
const JOB_FORM = read('src/components/schedule/JobForm.tsx')

// ── 1. The quote builder asks "which address?" when there is a real choice ───
console.log('\nQuote builder — a multi-location customer picks the location explicitly:')

check('the saved-address chips render only when there are 2+ addresses',
  QB.includes('customerProperties.length > 1 && ('),
  'a one-address customer has nothing to decide — the row must not render for them')

check('…as one-tap buttons that fill the address field',
  /onClick=\{\(\) => pickPropertyAddress\(p\)\}/.test(QB),
  'the chips are the explicit choice — without the handler they are decoration')

check('a chip fill is recorded as OUR fill (the autoFilledAddress contract)',
  /function pickPropertyAddress[\s\S]{0,400}autoFilledAddress\.current = full/.test(QB),
  'an unrecorded fill survives a customer switch and quotes the wrong person’s address')

check('…and triggers the same distance follow-up a picked autocomplete address gets',
  /function pickPropertyAddress[\s\S]{0,600}calculateDistance\(full\)/.test(QB),
  'a chip-picked address must not skip the travel-fee math a typed one gets')

check('a pick speaks only for the customer it was made for',
  /useEffect\(\(\) => \{ setPickedPropertyId\(null\) \}, \[customerId\]\)/.test(QB),
  'switching customers must clear the pick or customer B inherits customer A’s location')

check('a hand-edited address dethrones the pick',
  /onChange=\{v => \{ field\.onChange\(v\); if \(pickedPropertyId && v !== autoFilledAddress\.current\) setPickedPropertyId\(null\) \}/.test(QB),
  'a lit chip over a field that says somewhere else is a wrong claim about the quote')

check('…and so does picking from the autocomplete',
  /onSelect=\{\(p\) => \{ field\.onChange\(p\.formatted\); if \(pickedPropertyId\) setPickedPropertyId\(null\); calculateDistance/.test(QB),
  'the autocomplete is the other deliberate address act — it must also end the chip’s authority')

check('the measured price follows the picked location',
  /const targetPropertyId = pickedPropertyId \?\? \(propertyStillApplies \? defaultPropertyId! : null\)/.test(QB),
  'without this, tapping "45 Lake Rd" still prices the plan tiles off the primary’s lawn')

check('…and the measurement effect re-runs on a pick',
  /\}, \[customerId, defaultPropertyId, defaultCustomerId, pickedPropertyId, isEdit, getValues, setValue\]\)/.test(QB),
  'targetPropertyId is dead code if the effect never sees the pick change')

check('the free-typed field remains — a NEW job-site address stays quotable',
  QB.includes('label="Service Address *"'),
  'the chips fill the field; they must never replace it')

console.log('\nQuote builder — the loaders feed the chips real property rows:')
for (const [name, src] of [['quotes/new', QUOTE_NEW], ['quotes/[id]', QUOTE_DETAIL]] as const) {
  check(`${name} loads properties(id, address, city, province, is_primary)`,
    src.includes("properties(id, address, city, province, is_primary)"),
    'without ids the chips cannot drive the measurement refresh; without province the fill drifts from the auto-fill format')
}

// ── 2. Work ↔ location ↔ customer — the doors exist ──────────────────────────
console.log('\nQuick switching — every surface links its neighbours:')

check('visit editor links the visit’s LOCATION page',
  /editing\.property_id && <QuickAction href=\{`\/dashboard\/properties\/\$\{editing\.property_id\}`\}/.test(SCHEDULE),
  'Call/Navigate/Customer existed; the location page (access notes, history, siblings) had no door')

check('quote detail links its customer',
  /href=\{`\/dashboard\/customers\/\$\{quote\.customer_id\}`\}/.test(QUOTE_DETAIL),
  'the customer block was plain text — a dead end on the busiest detail page')

check('…and its location',
  /href=\{`\/dashboard\/properties\/\$\{quote\.property_id\}`\}/.test(QUOTE_DETAIL),
  'the quoted address was plain text — no door to what else happened there')

check('…falling back to plain text when the quote has no linked row',
  /quote\.customer_id \? \(/.test(QUOTE_DETAIL) && /quote\.property_id \? \(/.test(QUOTE_DETAIL),
  'a link to /customers/null is worse than no link')

console.log('\nProperty page — hop between a customer’s locations without the profile round trip:')

check('the sibling switcher renders when the customer has other locations',
  PROP_DETAIL.includes('siblings.length > 0 && customer && ('),
  'the one-location customer must not grow an empty "other locations" row')

check('…as links to each sibling’s own page',
  /href=\{`\/dashboard\/properties\/\$\{s\.id\}`\}/.test(PROP_DETAIL),
  'chips that don’t navigate are not a switcher')

check('…capped, with the overflow going to the profile’s full list',
  PROP_DETAIL.includes('siblings.slice(0, 6)') && PROP_DETAIL.includes('+{siblings.length - 6} more'),
  'a forty-address landlord must not get forty chips above the fold')

check('the sibling read is tenant- and customer-scoped and excludes itself',
  /\.eq\('customer_id', prop\.customer_id\)\.eq\('user_id', user\.id\)\.neq\('id', id\)/.test(PROP_DETAIL),
  'an unscoped read is a cross-tenant leak; an unexcluded self is a chip to the page you are on')

// ── 3. The contracts this feature leans on stay standing ─────────────────────
console.log('\nThe seams S94 builds on (regression tripwires):')

check('JobForm still surfaces the property picker up front for 2+ addresses',
  // S81 recomposed the form (compact edit layout): the create flow keeps the
  // same rule via the extracted propertyField block, and the EDIT flow is
  // stronger still — location is part of the common path and always shows.
  JOB_FORM.includes('(adv || properties.length > 1) && propertyField')
  && JOB_FORM.includes('{isEdit && propertyField}'),
  'the hidden-auto-select bug this rule fixed sends crews to the wrong house')

check('JobForm still auto-selects the single property silently',
  /if \(props\.length > 0 && !watch\('property_id'\)\)/.test(JOB_FORM),
  'a one-address customer must not be made to choose their only address')

check('the location page shows no unlanded systems as placeholders',
  !/coming soon/i.test(PROP_DETAIL),
  'documents/assets are not on main — a fake section is a promise the app cannot keep')

// A retained measurement is older than the customer/property explicitly chosen
// for this quote. Execute the actual mount effect so a correct but unused helper
// cannot pass while the page still adopts the incompatible payload.
console.log('\nMeasurement handoff — preserve the explicit quote destination:')
const pageAst = ts.createSourceFile('page.tsx', QUOTE_NEW, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let adoptionEffect = ''
let compatibilityCall = ''
function findAdoption(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(pageAst) === 'useEffect'
    && node.arguments[0]?.getText(pageAst).includes("getItem('eq_measurement')")) {
    adoptionEffect = node.arguments[0].getText(pageAst)
  }
  if (ts.isCallExpression(node) && node.expression.getText(pageAst) === 'isMeasurementHandoffCompatible') {
    compatibilityCall = node.getText(pageAst)
  }
  ts.forEachChild(node, findAdoption)
}
findAdoption(pageAst)
check('actual measurement adoption effect and compatibility call are present', !!adoptionEffect && !!compatibilityCall)

type HandoffCase = { name: string; search: string; payload?: unknown; raw?: string; accepted: boolean }
const measured = { customerId: 'customer-a', propertyId: 'property-a', address: '10 Example Road', sqft: 1200,
  jobPrice: 87, suggestedPrice: 91, sections: { front: 1200 }, confidence: 'fixture' }
const handoffCases: HandoffCase[] = [
  { name: 'no handoff preserves explicit destination', search: '?customer=customer-b', accepted: false },
  { name: 'direct measurement retains every payload value', search: '?from=measurement', payload: measured, accepted: true },
  { name: 'legacy handoff needs no new route marker', search: '', payload: measured, accepted: true },
  { name: 'matching customer and property', search: '?customer=customer-a&property=property-a', payload: measured, accepted: true },
  { name: 'matching customer alone', search: '?customer=customer-a', payload: measured, accepted: true },
  { name: 'matching property alone', search: '?property=property-a', payload: measured, accepted: true },
  { name: 'different customer rejects all measurement defaults', search: '?customer=customer-b', payload: measured, accepted: false },
  { name: 'different property for same customer rejects all defaults', search: '?customer=customer-a&property=property-b', payload: measured, accepted: false },
  { name: 'property-only mismatch rejects entire handoff', search: '?property=property-b', payload: measured, accepted: false },
  { name: 'measurement marker cannot bypass a customer conflict', search: '?from=measurement&customer=customer-b', payload: measured, accepted: false },
  { name: 'nullable legacy identity without explicit selection', search: '?from=measurement', payload: { ...measured, customerId: null, propertyId: null }, accepted: true },
  { name: 'matching customer allows unknown unselected property', search: '?customer=customer-a', payload: { ...measured, propertyId: null }, accepted: true },
  { name: 'matching property allows unknown unselected customer', search: '?property=property-a', payload: { ...measured, customerId: null }, accepted: true },
  { name: 'empty URL selection preserves legacy semantics', search: '?customer=&property=', payload: measured, accepted: true },
  { name: 'malformed JSON is consumed without adoption', search: '?customer=customer-a', raw: '{broken', accepted: false },
]
for (const field of ['customerId', 'propertyId'] as const) {
  const query = field === 'customerId' ? '?customer=customer-a' : '?property=property-a'
  for (const value of [undefined, null, '', '   ', 42, true, ['customer-a'], { id: 'customer-a' }]) {
    handoffCases.push({ name: `${field} ${JSON.stringify(value) ?? 'missing'} cannot satisfy an explicit selection`,
      search: query, payload: { ...measured, [field]: value }, accepted: false })
  }
  handoffCases.push({ name: `malformed unselected ${field} is not coerced`, search: '',
    payload: { ...measured, [field]: 42 }, accepted: false })
}
for (const payload of [null, [], 42, 'customer-a']) {
  handoffCases.push({ name: `non-object payload ${JSON.stringify(payload)} is rejected`, search: '?customer=customer-a', payload, accepted: false })
}

type Compatibility = typeof isMeasurementHandoffCompatible
function runAdoption(test: HandoffCase, effect = adoptionEffect, compatible: Compatibility = isMeasurementHandoffCompatible) {
  const raw = test.raw ?? (test.payload === undefined ? null : JSON.stringify(test.payload))
  const store = new Map<string, string>(raw == null ? [] : [['eq_measurement', raw]])
  const adopted: unknown[] = []
  const removed: string[] = []
  const unexpected = () => { throw new Error('Unexpected non-measurement handoff operation') }
  const code = ts.transpileModule(`const adopt = ${effect}; adopt()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText
  runInNewContext(code, {
    window: { location: { search: test.search }, sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => { removed.push(key); store.delete(key) },
    } },
    URLSearchParams, isMeasurementHandoffCompatible: compatible,
    setMeasurement: (payload: unknown) => adopted.push(payload),
    LEAD_PREFILL_KEY: 'fixture-lead', setLead: unexpected,
    readRenewalPrefill: () => null, clearRenewalPrefill: unexpected, setRenewal: unexpected,
  }, { timeout: 1000 })
  return { adopted, remaining: store.get('eq_measurement') ?? null, removed, raw }
}
function adoptionPasses(test: HandoffCase, effect = adoptionEffect, compatible: Compatibility = isMeasurementHandoffCompatible): boolean {
  try {
    const result = runAdoption(test, effect, compatible)
    return JSON.stringify(result.adopted) === JSON.stringify(test.accepted ? [test.payload] : [])
      && result.remaining === null
      && JSON.stringify(result.removed) === JSON.stringify(result.raw == null ? [] : ['eq_measurement'])
  } catch { return false }
}
if (adoptionEffect && compatibilityCall) {
  for (const test of handoffCases) check(test.name, adoptionPasses(test))
  const rejectedCustomer = handoffCases.find(test => test.name === 'different customer rejects all measurement defaults')!
  const rejectedProperty = handoffCases.find(test => test.name === 'different property for same customer rejects all defaults')!
  check('[mutation] removing customer compatibility is detected', !adoptionPasses(rejectedCustomer, adoptionEffect,
    (payload, selection) => isMeasurementHandoffCompatible(payload, { propertyId: selection.propertyId })))
  check('[mutation] removing property compatibility is detected', !adoptionPasses(rejectedProperty, adoptionEffect,
    (payload, selection) => isMeasurementHandoffCompatible(payload, { customerId: selection.customerId })))
  check('[mutation] bypassing the actual adoption guard is detected',
    !adoptionPasses(rejectedCustomer, adoptionEffect.replace(compatibilityCall, 'true')))
  check('[mutation] leaving a rejected handoff in storage is detected',
    !adoptionPasses(rejectedCustomer, adoptionEffect.replace("window.sessionStorage.removeItem('eq_measurement')", 'undefined')))
}

console.log(
  failures === 0
    ? '\n✅ customer-locations verified — one location stays silent, many locations stay explicit, and every surface links its neighbours.\n'
    : `\n❌ ${failures} customer-locations check(s) FAILED\n`,
)
process.exit(failures === 0 ? 0 : 1)
