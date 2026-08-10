// ── Verify: the low-frequency surfaces stay calm, and stay honest ────────────
//   npm run verify:secondary-surfaces
//
// WHY THIS SCRIPT EXISTS
// The 2026-08-10 secondary-surfaces pass audited the pages an owner opens
// monthly, not daily: Properties, Equipment and Data Quality. It found ONE
// design failure and ONE defect class, and this guard pins both.
//
// THE DESIGN FAILURE — a triage queue wearing a dossier.
//   /dashboard/properties exists to rank every address by what needs doing, and
//   it did that underneath ~779px of reference material per row against ~150px
//   of current state: performance, paperwork, pricing memory, the measurement
//   price list and a photo UPLOADER, all expanded on every row. Ten properties
//   ran to fourteen screens. Nothing was deleted — it went behind one <details>.
//   The rule this guard enforces: those five blocks live INSIDE the disclosure,
//   and the recommendation + primary action stay OUTSIDE it.
//
// THE DEFECT CLASS — a screen claiming more than its data earned. Same family
// the back-office and portal audits kept finding, in three new species:
//   1. A FAILED READ RENDERED AS AN ANSWER. Data Quality read six tables with
//      `(res.data as T) || []` and never inspected `.error`. Every count fell to
//      0, coveragePct(0,0) returns 100, overallScore returns 100 — so a database
//      that never answered was graded **A, "Your data is clean."** Properties had
//      the same shape: a dropped request painted "No properties yet."
//   2. A WRITE THAT REPORTS SUCCESS IT DIDN'T HAVE. PostgREST returns NO error
//      when RLS matches zero rows, so equipment delete/status and the property
//      measurement-history append all toasted success over rows that never moved.
//   3. HAND-ROLLED MONEY. Properties summed raw `invoices.amount` — the PRE-tax,
//      PRE-discount subtotal — over `status === 'paid'` only, called it "Lifetime
//      revenue", and SORTED the list by it. A part-paid property reported $0.
//
// Plus one engine bug that rendered a literal null: serviceStatus() with a day
// interval and no date to count from printed "null days until next service" in
// GREEN, on a machine that is plausibly a first run.
//
// Structural over source: these are single-file invariants no runtime observes.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const PROPS = read('src/app/dashboard/properties/page.tsx')
const EQP = read('src/app/dashboard/equipment/page.tsx')
const EQLIB = read('src/lib/equipment.ts')
const DQ = read('src/app/dashboard/data-quality/page.tsx')
const SVCDLG = read('src/components/equipment/ServiceLogDialog.tsx')

// ── 1. Properties: the triage queue is a queue again ─────────────────────────
console.log('\nProperties — triage first, dossier behind one tap')

const detailsAt = PROPS.indexOf('<details className="group mt-3">')
const detailsEnd = PROPS.indexOf('</details>')
check('the card has exactly one <details> disclosure', detailsAt > 0 && detailsEnd > detailsAt,
  'the reference material must be folded behind a single disclosure, not five')
check('the disclosure closes after the photo block', PROPS.indexOf('</details>') > PROPS.indexOf('<JobPhotos'),
  'photos must be inside the fold')

const inFold = (marker: string) => {
  const i = PROPS.indexOf(marker)
  return i > detailsAt && i < detailsEnd
}
for (const [label, marker] of [
  ['performance', '{/* Performance — this property as a business asset */}'],
  ['last quote / last invoice', '{/* Last quote + last invoice'],
  ['pricing memory', '{/* Pricing memory'],
  ['latest measurement', '{/* Latest measurement'],
  ['photos', '{/* Photos — visual service history'],
] as const) {
  check(`${label} is behind the disclosure`, inFold(marker),
    `${label} renders on first paint again — that is the 779px this pass removed`)
}
// …and the two things that ARE this week's work must NOT be folded.
const recIdx = PROPS.indexOf('{health.recommendation && (')
check('the ONE recommendation stays on the face of the card', recIdx > 0 && recIdx < detailsAt,
  'the recommendation is the page\'s whole point; it can never move behind a tap')
check('the primary action stays on the face of the card',
  PROPS.indexOf('{health.actionLabel}') > 0 && PROPS.indexOf('{health.actionLabel}') < detailsAt,
  'the action that resolves the recommendation must sit beside it')
check('the service plan stays on the face of the card',
  PROPS.indexOf('{/* Current Service Plan') > 0 && PROPS.indexOf('{/* Current Service Plan') < detailsAt)

// Capability trace — folding must not delete. Everything that was reachable is.
for (const [label, marker] of [
  ['Quote this', 'Quote this'],
  ['Recalculate', 'Recalculate'],
  ['photo capture', '<JobPhotos'],
  ['service history link', 'View schedule'],
] as const) {
  check(`${label} still exists in the product`, PROPS.includes(marker),
    'hiding is allowed; deleting a capability is not')
}

// ── 2. Properties: money comes from the ONE ledger engine ────────────────────
console.log('\nProperties — money')

check('the page imports invoiceBalance', /import \{[^}]*invoiceBalance[^}]*\} from '@\/lib\/payments\/ledger'/.test(PROPS),
  'every money figure on this page must come from the canonical engine')
check('buildPerformance calls invoiceBalance', /invoiceBalance\(inv, settings\)/.test(PROPS),
  'the totals must be engine-derived, not hand-summed')
check('no hand-rolled paid-invoice sum survives', !/inv\.status !== 'paid'/.test(PROPS) && !/Number\(inv\.amount\) \|\| 0/.test(PROPS),
  'summing raw invoices.amount is the PRE-tax subtotal — that is the bug this replaced')
check('cancelled invoices are excluded explicitly', /inv\.status === 'cancelled'/.test(PROPS),
  'a cancelled invoice keeps its full balance, so it can never be inferred — it must be named')
check('amount_paid is actually selected', /select\('id, property_id, invoice_number, amount, amount_paid/.test(PROPS),
  'invoiceBalance needs amount_paid + discount fields or it silently reports zero paid')
check('"Lifetime revenue" is gone from the UI', !PROPS.includes('label="Lifetime revenue"'),
  'the figure was never lifetime revenue; the label has to match what it is')
check('the value sort reads the engine-derived figure', /perf\?\.collected \?\? 0/.test(PROPS),
  '"Highest value" ordered the whole list by the wrong number')

// ── 3. A failed read is never rendered as an answer ──────────────────────────
console.log('\nFailed reads are not answers')

check('Properties branches on the properties read error', /if \(pRes\.error\)/.test(PROPS),
  '"No properties yet" is a claim about the owner\'s book; it must not come from a dropped request')
check('Properties distinguishes a partial failure', /jRes\.error \|\| iRes\.error/.test(PROPS),
  'jobs/invoices feed the health SCORE — a silent [] drops properties into "At risk"')
check('Properties renders a retry, not an empty state, on failure', /We couldn’t load your properties/.test(PROPS))

check('Data Quality reads its errors', /const readErr = cRes\.error \|\| qRes\.error/.test(DQ),
  'six reads used `(res.data as T) || []` with no .error — a dead database graded the book an A')
check('Data Quality suppresses the grade when it cannot vouch for it', /\) : loadError \? null : \(/.test(DQ),
  'the hero must not render a score computed from reads that failed')
check('Data Quality says the picture is incomplete', /don’t treat it as an all-clear/.test(DQ))
check('Equipment reports a failed SERVICE read', /setServiceError\(sRes\.error/.test(EQP),
  'a failed service read zeroed Maintenance YTD and every cost-per-hour as fact')

// ── 4. "Your data is clean" must mean it ─────────────────────────────────────
console.log('\nData Quality — the all-clear is earned')

for (const term of ['customersNoContact', 'propsNoSize', 'dupes', 'propsNoCustomer']) {
  check(`allClean counts ${term}`, new RegExp(`allClean[\\s\\S]{0,600}m\\.${term}`).test(DQ),
    `${term} renders its own section BELOW the green banner — omitting it makes the page contradict itself`)
}
check('an EMPTY book is not graded', /const nothingToCheck = m\.rows\.every\(r => r\.total === 0\)/.test(DQ),
  'coveragePct(0,0) is 100, so a brand-new account was told its data was Trustworthy')
check('the empty book gets an explanation instead of a grade', /Nothing to check yet/.test(DQ))
check('the clean banner requires a successful read', /allClean && !loadError && !nothingToCheck/.test(DQ))

// ── 5. Data Quality speaks about consequences, not tables ────────────────────
console.log('\nData Quality — plain language and triage order')

check('no "Job → quote linkage"', !DQ.includes('Job → quote linkage'), 'an arrow between two table names')
check('no bare "Customer coverage"', !DQ.includes("label: 'Customer coverage'"))
check('no bare "Revenue coverage"', !DQ.includes("label: 'Revenue coverage'"))
check('coverage rows name the consequence', DQ.includes('never become an invoice') && DQ.includes('no quote, reminder or invoice can be sent'),
  'the owner needs to know what BREAKS, not which column is null')

// Order: what costs money today must outrank what changes a chart label.
const iContact = DQ.indexOf('{m.customersNoContact.length > 0 && (')
const iJobsNoCust = DQ.indexOf('{m.jobsNoCustomer.length > 0 && (')
const iUnnamed = DQ.indexOf('{m.propsUnnamed.length > 0 && (')
const iSize = DQ.indexOf('{m.propsNoSize.length > 0 && (')
for (const [n, i] of [['contact', iContact], ['jobs-no-customer', iJobsNoCust], ['unnamed', iUnnamed], ['size', iSize]] as const) {
  check(`the ${n} section is still rendered`, i > 0, 'the reorder must not drop a section')
}
check('unreachable customers outrank cosmetic labels', iContact > 0 && iUnnamed > 0 && iContact < iUnnamed,
  'a postcode where a neighbourhood name should be is not more urgent than a customer who can never be invoiced')
check('jobs with no customer outrank cosmetic labels', iJobsNoCust > 0 && iJobsNoCust < iUnnamed,
  'a job with no customer can never be invoiced; it was second to last')
check('contact is the first section on the page', iContact < iJobsNoCust && iContact < iSize,
  'the dashboard priority that links here promises a phone number — it must be what opens')
check('the cosmetic tail is labelled as such', /only affects labels and pricing suggestions/.test(DQ))

// ── 6. Bulk runs tell the truth about what they did ──────────────────────────
console.log('\nData Quality — bulk runs')

check('the locate run counts what it could not find', /let found = 0, missed = 0/.test(DQ),
  'geocodeAddressDetailed returns null for every failure mode; 12 of 12 could fail in total silence')
check('the locate run reports a partial outcome', /couldn't be found — check the spelling on those/.test(DQ))
check('a run in progress locks the other runs out', (DQ.match(/disabled=\{!!working && working !== /g) ?? []).length >= 3,
  'starting a second bulk run overwrote the first run\'s sentinel and the progress label stopped matching reality')
check('the long address lists are folded, not dumped', /Show the other \{m\.propsUngeocoded\.length - 3\}/.test(DQ),
  '40 rows with no per-row control is ~1,700px of scroll on a phone')
check('the folded list still says the bulk button covers it', /all included in “Locate all”/.test(DQ),
  'folding must not make the owner think the hidden ones are excluded')

// ── 7. Equipment: the engine, and writes that prove they landed ──────────────
console.log('\nEquipment')

check('serviceStatus can never print a null countdown',
  /if \(hoursRemaining == null && daysRemaining == null\)/.test(EQLIB),
  'a day interval with no date to count from templated null into "null days until next service", in GREEN')
check('the null-countdown branch says what is missing',
  /Add a purchase or last-service date to start the countdown/.test(EQLIB))
check('needsService is exported from the engine', /export function needsService\(/.test(EQLIB),
  'the page had its own copy of the predicate, so the pill count and the filtered list could disagree')
check('the page calls the engine predicate', /if \(filter === 'needs_service'\) return needsService\(e, today\)/.test(EQP))
check('the page no longer re-derives due/due_soon', !/s === 'due' \|\| s === 'due_soon'/.test(EQP))

check('the equipment delete proves it deleted', /\.delete\(\)\.eq\('id', eq\.id\)\.select\('id'\)/.test(EQP),
  'PostgREST returns no error when RLS matches zero rows — the card vanished and the row survived')
check('a zero-row delete is reported', /could not be removed/.test(EQP))
check('the status write proves it wrote', /\.update\(\{ status \}\)\.eq\('id', eq\.id\)\.select\('id'\)/.test(EQP))
check('a zero-row status write is reported and rolled back', /!wrote \|\| wrote\.length === 0/.test(EQP))

check('the service dialog resolves the LIVE row', /const logFor = logForId \? equipment\.find\(e => e\.id === logForId\)/.test(EQP),
  'a snapshot taken at click kept shouting "Service due" straight after the service was logged')
check('picked parts are cleared on success too', /setPicks\(\{\}\)\s*\n\s*onChanged\(\)/.test(SVCDLG),
  'logging a second service without closing the dialog consumed the same parts twice, silently')

check('Add equipment is the header\'s first control', EQP.indexOf('Add equipment') < EQP.indexOf('/dashboard/equipment/inventory'),
  'the page\'s only primary action sat last, behind four links into another lane')
check('the redundant hidden stat button is gone', !/onClick=\{\(\) => setFilter\(summary\.needingService/.test(EQP),
  'an invisible button doing exactly what the visible pill beneath it does')
check('Remove is visibly destructive without hover', /text-red-400\/80/.test(EQP),
  'hover:text-red-400 does not exist on touch — Remove looked identical to Retire')

// ── 8. Properties: writes that prove they landed, and mobile ─────────────────
console.log('\nProperties — writes and mobile')

check('the measurement append proves it landed', /\.eq\('id', p\.id\)\.select\('id'\)/.test(PROPS),
  'a zero-row update returns no error, so the owner saw history the database never got')
check('a zero-row measurement append is reported', /that property could not be updated/.test(PROPS))
check('the card header stacks on a phone', /flex flex-col sm:flex-row items-stretch sm:items-start justify-between/.test(PROPS),
  'a fixed 150px action column left the address and badges 94px at 390px')
check('the action column is full-width on a phone', /w-full sm:w-\[150px\]/.test(PROPS))
check('the paperwork tiles stack on a phone', /mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2/.test(PROPS),
  'two 138px tiles truncated "QUO-0042 · $1,250.00" to "$1,…"')
check('the last-invoice tile deep-links to its invoice', /\/dashboard\/invoices\?invoice=\$\{encodeURIComponent\(lastInvoice\.invoice_number\)\}/.test(PROPS),
  'it named an invoice and then dumped the owner in the unfiltered list')
check('the header count respects the filter', /of \$\{properties\.length\} propert/.test(PROPS),
  'searching "Elm" left "38 properties on file" above 2 rows')
check('the derivation is memoised', /const rows = useMemo\(\(\) => properties\.map\(property => \{/.test(PROPS),
  'a haversine sweep per property re-ran on every keystroke in the search box')
check('the search filters the derived rows', /rows\.filter\(\(\{ property: p \}\)/.test(PROPS))

// ── Result ──────────────────────────────────────────────────────────────────
console.log(failures === 0
  ? '\n✅ secondary surfaces: calm, honest, and still complete\n'
  : `\n❌ ${failures} check${failures === 1 ? '' : 's'} failed\n`)
process.exit(failures === 0 ? 0 : 1)
