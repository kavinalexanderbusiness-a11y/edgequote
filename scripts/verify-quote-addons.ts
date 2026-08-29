// ── Verify: an optional extra is ADDED BY A PERSON, never by us — and once it is
//    decided it is a record, not a template ────────────────────────────────────
//   npm run verify:quote-addons
//
// WHAT THE FEATURE IS FOR
// "Gutter guards +$180", "Haul the debris away +$95" — things the customer may
// ADD to whatever they approve, chosen BEFORE they approve. It is the third and
// last shape a row on a quote can have, and the three must never blur:
//
//   quote_services  ADDITIVE scope the OWNER wrote.       Sums into the price.
//   quote_options   ALTERNATIVE whole-job prices.         Exactly one REPLACES it.
//   quote_addons    ADDITIVE scope the CUSTOMER chooses.  Zero or more ADD to it.
//
// ⭐⭐ WHY THE MODEL IS SAFE, in one paragraph. `quotes.addons_total` is written
// ONLY by the trigger `quote_addons_sync_total`, and `quotes.total` is a STORED
// GENERATED column over it (initial_price + travel_fee + addons_total). So there
// is still exactly ONE money path out of a quote and every downstream system
// reads it unchanged — the send gate, the invoice conversion, job costing,
// pipeline reporting and the deposit engine all needed no edit. The application
// never writes either column, and this guard is largely the proof of that
// sentence.
//
// ⛔⛔ THE LINE THIS FEATURE MUST NEVER CROSS. An add-on is PRE-acceptance; a
// change order is POST-acceptance. The database draws the line, not the app:
// `quote_addons_write_guard` raises on every insert/update/delete once the quote
// leaves draft/sent. That is what makes "the extras on an accepted quote" a
// frozen historical record rather than a template that could be edited into
// something the customer never agreed to — and it is why extra scope after
// approval has exactly one home (`change_orders`, with its own approval and its
// own audit trail). Section 6 attacks that freeze from both directions.
//
// ⭐ THE DECISION THIS GUARD PINS HARDEST: NOTHING IS EVER PRE-SELECTED BY THE
// BUSINESS. `is_selected` is the one column that costs money; it drives the
// trigger, which drives the generated total, which is what the customer's own
// PDF prints and what the deposit engine takes a percentage of. An owner ticking
// an extra would therefore put money nobody agreed to onto the customer's
// document — and the schema would stamp it selected_via='default', the database
// admitting nobody chose it. The database can express that state; this
// application refuses to create it, and the write-payload section proves the
// builder physically cannot.
//
// THE LIVE HALF WRITES, AND ONLY INSIDE A MARKED FIXTURE TENANT.
// Same harness and same reason as verify:quote-options: accepting a quote fires
// trg_notify_quote_accepted, and this guard must never put "Automated guard
// fixture" into a real owner's notification bell or a real customer's portal.
// openFixtureTenant aborts unless the database confirms the tenant is marked, so
// no env var can aim this file at a real business. Section 5 needs no login at
// all — it is pure refusal-probing against anonymous callers and writes nothing.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  MAX_QUOTE_ADDONS, addonIdsFor, addonProblemMessage, addonRowsFor, addonSetProblem,
  addonValueBasis, addonValueBasisLabel, addonsFrozen, approvalTotal, hasAddons,
  quoteAddonJobLines, selectedAddons, sortedAddons,
} from '../src/lib/quoteAddons'
// The choice engine this composes with, imported rather than described: if an
// option ever stopped REPLACING the price, the composition claim below would be
// false, and this import is what makes that a compile-time relationship.
import { headlineOptionPrice, optionRowsFor } from '../src/lib/quoteOptions'
import { openFixtureTenant, isSkipped, fixtureResidue, loadEnvLocal } from './lib/verify-fixture'

loadEnvLocal()

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const GHOST = '00000000-0000-0000-0000-0000000000ff'

// ── The apply path, resolved rather than remembered ──────────────────────────
// ⛔ The baseline filename is a MOVING TARGET — it is regenerated and
// re-versioned every time the schema converges, and this guard has to keep
// working across that. `supabase/archive/` is NOT the apply path, and a guard
// reading it would pass against SQL production never runs.
const MIGRATIONS = 'supabase/migrations'
const baselineFile = readdirSync(join(process.cwd(), MIGRATIONS))
  .filter(f => f.endsWith('_baseline.sql')).sort().pop()
const SCHEMA = baselineFile ? read(join(MIGRATIONS, baselineFile)) : ''

// ── The comment stripper, and why its shape matters ──────────────────────────
// ⚠️⚠️ The split on CR-or-LF is LOAD-BEARING. Every file in this repo uses CRLF
// line endings, the dot does not match a carriage return, and an unanchored
// end-of-string will not match before one — so the obvious newline-only split
// produces a stripper that matches NOTHING, and every assertion made through it
// passes vacuously. The liveness checks below caught exactly that while this
// guard was being written. (A block-comment regex once deleted 83% of a file on
// this same feature, and every assertion over that file passed too.)
const strip = (s: string) => s.split(/\r?\n/)
  .map(l => l.replace(/^\s*(\/\/|\*|\/\*).*$/, ''))
  .join('\n')
// Both bounds matter: a stripper that removes nothing lets a claim in a COMMENT
// satisfy a check about CODE; one that removes everything lets an absent-thing
// check pass over an empty string.
const stripperAlive = (src: string) => {
  const t = strip(src)
  return t.length > src.length * 0.2 && t.length < src.length * 0.99
}
const SCHEMA_CODE = SCHEMA.split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n')

// ── 1. The pricing rule, which is the whole feature ──────────────────────────
console.log('\n═══ An extra ADDS — it never replaces, and it is never a component of a choice ═══')

const ADDONS = [
  { id: 'a1', name: 'Gutter guards', price: 180, sort_order: 0, is_selected: false },
  { id: 'a2', name: 'Haul away debris', price: 95, sort_order: 1, is_selected: false },
  { id: 'a3', name: 'Second coat', price: 400, sort_order: 2, is_selected: false },
]
const OPTS = [
  { id: 'o1', name: 'Budget', price: 3900, sort_order: 0, is_recommended: false },
  { id: 'o2', name: 'Standard', price: 5400, sort_order: 1, is_recommended: true },
]

check('an unselected extra is worth nothing',
  approvalTotal({ base: 5400, travel: 150, addons: [] }) === 5550,
  'the quote is exactly what it was before the extras existed')
check('a selected extra ADDS to the chosen option, never replaces it',
  approvalTotal({ base: 5400, travel: 150, addons: [ADDONS[0]] }) === 5730)
check('two selected extras both add',
  approvalTotal({ base: 5400, travel: 150, addons: [ADDONS[0], ADDONS[1]] }) === 5825)
// ⭐ THE composition claim: an option REPLACES, an extra ADDS, and the two
// compose without either engine knowing about the other.
check('option + extras compose: the CHOSEN option, plus travel, plus the extras taken',
  approvalTotal({ base: headlineOptionPrice(OPTS), travel: 150, addons: [ADDONS[2]] }) === 5950,
  'headline 5400 + travel 150 + 400 = 5950; anything else means one engine reached into the other')
check('travel is added ONCE, never per extra',
  approvalTotal({ base: 1000, travel: 150, addons: [ADDONS[0], ADDONS[1], ADDONS[2]] }) === 1825)
check('the extras are never summed INTO the base',
  approvalTotal({ base: 5400, travel: 0, addons: [] }) === 5400)
// The figure this seam proved on production in Session 57, reproduced.
check('the recorded case reproduces: 2400 + 250 = 2650',
  approvalTotal({ base: 2400, travel: 0, addons: [{ name: 'Extra', price: 250 }] }) === 2650)

console.log('\n═══ Selection is a fact about a PERSON, and the app cannot fake one ═══')
// ⭐⭐ THE most load-bearing assertion in this file. addonRowsFor is the ONLY
// function that produces a quote_addons row from owner input, and it must be
// STRUCTURALLY incapable of writing the column that costs money.
const rows = addonRowsFor(
  // Deliberately hostile input: an owner-typed row that TRIES to arrive selected.
  [{ id: 'x', name: '  Gutter guards  ', description: ' keeps leaves out ', price: 180, is_selected: true } as never],
  'q1', 'u1',
)
check('addonRowsFor writes NO is_selected — an owner cannot tick an extra for the customer',
  !('is_selected' in rows[0]),
  `got keys: ${Object.keys(rows[0]).join(', ')} — selected_via would record it as 'default', the schema admitting nobody chose it`)
check('…nor selected_via / selected_at, which the DB fills from is_selected',
  !('selected_via' in rows[0]) && !('selected_at' in rows[0]))
check('…and it cannot carry an id back either (delete-and-reinsert, like options)',
  !('id' in rows[0]))
check('names and descriptions are trimmed, and a blank description becomes NULL',
  rows[0].name === 'Gutter guards' && rows[0].description === 'keeps leaves out'
  && addonRowsFor([{ name: 'X', description: '   ', price: 1 }], 'q', 'u')[0].description === null)
check('sort_order is renumbered from screen position, so stored order IS shown order',
  addonRowsFor([{ name: 'B', price: 2 }, { name: 'A', price: 1 }], 'q', 'u').map(r => r.sort_order).join() === '0,1')
check('tenancy is never guessed — quote_id and user_id come from the caller',
  rows[0].quote_id === 'q1' && rows[0].user_id === 'u1')

console.log('\n═══ The set rules, from ONE definition the builder and the DB share ═══')
check('no extras is a valid quote — there is no has_addons switch to get stuck on',
  addonSetProblem([]) === null && addonSetProblem(null) === null && !hasAddons([]))
check(`more than ${MAX_QUOTE_ADDONS} extras is refused`,
  addonSetProblem(Array.from({ length: 7 }, (_, i) => ({ name: `E${i}`, price: 1 }))) === 'too_many')
check(`exactly ${MAX_QUOTE_ADDONS} is allowed — the cap mirrors the DB's, it does not undercut it`,
  addonSetProblem(Array.from({ length: 6 }, (_, i) => ({ name: `E${i}`, price: 1 }))) === null)
check('a nameless extra is refused — it is what the customer is choosing',
  addonSetProblem([{ name: '   ', price: 5 }]) === 'unnamed')
check('a NEGATIVE price is refused — an extra that reduces the bill is a discount',
  addonSetProblem([{ name: 'Credit', price: -50 }]) === 'negative_price')
check('a ZERO price is allowed — "included if you want it" is a real offer',
  addonSetProblem([{ name: 'Bin bags', price: 0 }]) === null)
check('two extras with the same name are refused — the customer could not tell them apart',
  addonSetProblem([{ name: 'Guards', price: 1 }, { name: ' guards ', price: 2 }]) === 'duplicate_name')
check('every problem has a sentence for the owner',
  (['too_many', 'unnamed', 'no_price', 'negative_price', 'duplicate_name'] as const)
    .every(p => addonProblemMessage(p).length > 20))

console.log('\n═══ Reporting says what a figure MEANS, and never computes one ═══')
check('a quote with no extras answers null — the question does not arise',
  addonValueBasis([]) === null)
check('extras offered but none taken reads "offered"', addonValueBasis(ADDONS) === 'offered')
check('at least one taken reads "taken"',
  addonValueBasis([{ ...ADDONS[0], is_selected: true }, ADDONS[1]]) === 'taken')
check('the label states BOTH counts, so "1 of 4 taken" can never read as "4 taken"',
  addonValueBasisLabel('taken', 4, 1) === '1 of 4 optional extras taken')
check('the offered label says none were taken, in words',
  /none taken/.test(addonValueBasisLabel('offered', 3, 0)))

console.log('\n═══ The freeze predicate says exactly what the trigger says ═══')
check('draft and sent are NOT frozen — the decision is still open',
  !addonsFrozen('draft') && !addonsFrozen('sent'))
check('every other status IS frozen',
  ['accepted', 'scheduled', 'completed', 'paid', 'declined', 'expired'].every(s => addonsFrozen(s)))
check('an unknown or missing status is frozen — fail CLOSED, never open',
  addonsFrozen(null) && addonsFrozen(undefined) && addonsFrozen('something_new'),
  'a status this app has not met yet must not be treated as "still editable"')

console.log('\n═══ The bridge into the work — and the bill it must reconcile to ═══')
const mixed = [
  { id: 'a1', name: 'Gutter guards', price: 180, sort_order: 0, is_selected: true },
  { id: 'a2', name: 'Haul away debris', price: 95, sort_order: 1, is_selected: false },
]
check('only the SELECTED extras become work',
  quoteAddonJobLines(mixed).length === 1 && quoteAddonJobLines(mixed)[0].description === 'Gutter guards',
  'an extra the customer declined is on the record as offered and must never be scheduled or billed')
check('…at the price that was agreed, never re-derived',
  quoteAddonJobLines(mixed)[0].amount === 180)
check('a quote where nothing was taken produces no work at all',
  quoteAddonJobLines(ADDONS).length === 0)

const SCHEDULE_SRC = read('src/lib/scheduleQuote.ts')
const SCHEDULE = strip(SCHEDULE_SRC)
check('the stripper is alive on scheduleQuote', stripperAlive(SCHEDULE_SRC))
// ⛔ The single worst thing this seam could do to a customer.
check('every add-on line item is written NON-recurring',
  /for \(const a of addonLines\)[\s\S]{0,400}?recurring: false,/.test(SCHEDULE),
  'a recurring line would bill a ONE-TIME extra on every visit of the plan, forever')
check('…and they ride the EXISTING job line-item engine, not a second one',
  /addonLines[\s\S]{0,300}?addLineItems\(supabase/.test(SCHEDULE)
  && !/from\('job_line_items'\)\s*\.insert/.test(SCHEDULE))
check('the selected-only filter lives in the one engine, so no call site can forget it',
  /quoteAddonJobLines\(/.test(SCHEDULE))
check('the extras are NOT folded into jobs.price as well',
  !/price:[^\n]*addon/i.test(SCHEDULE),
  'base + line items is how the invoice sums; putting extras in both bills them twice')

// ── 2. The application reads the money columns and never writes them ─────────
console.log('\n═══ The app reads the money columns and never writes them ═══')
const APP_FILES = [
  'src/lib/quoteAddons.ts',
  'src/components/quotes/QuoteAddonsEditor.tsx',
  'src/components/quotes/QuoteBuilder.tsx',
  'src/app/dashboard/quotes/new/page.tsx',
  'src/app/dashboard/quotes/[id]/page.tsx',
  'src/app/portal/[token]/PortalClient.tsx',
  'src/app/portal/[token]/components/BillingTab.tsx',
  'src/app/portal/[token]/model.ts',
  'src/components/quotes/QuotePDF.tsx',
  'src/lib/portalPdf.ts',
  'src/lib/scheduleQuote.ts',
]
const SRC = Object.fromEntries(APP_FILES.map(f => [f, read(f)]))
// ⚠️ Asserted ALIVE before anything is asserted THROUGH it.
check('the comment stripper is alive on every file it is used on',
  APP_FILES.every(f => stripperAlive(SRC[f])),
  APP_FILES.filter(f => !stripperAlive(SRC[f])).join(', ') + ' — CRLF disarms a naive stripper')
const CODE = Object.fromEntries(APP_FILES.map(f => [f, strip(SRC[f])]))

// ⭐ THE rule is about WRITES, so it is asserted over write PAYLOADS, not over
// every occurrence of a column name. A display mapping that READS is_selected to
// decide whether to draw a tick is not a write, and a rule that could not tell
// the two apart would either be noise or would have to be weakened until it
// caught nothing.
const writePayloads = (src: string): string[] =>
  // Each insert/update/upsert payload, non-greedily to its closing brace. A
  // nested brace would truncate a payload early — which can only make this check
  // MISS, never fire falsely, and every payload on this seam is flat.
  [...src.matchAll(/\.(insert|update|upsert)\(\s*\{([\s\S]*?)\}/g)].map(m => m[2])
const ALL_WRITES = APP_FILES.flatMap(f => writePayloads(CODE[f]))
check('the write-payload extractor found real writes to look at',
  ALL_WRITES.length >= 5,
  `found ${ALL_WRITES.length} — an extractor that finds nothing makes every rule below it vacuous`)
check('⭐⭐ no application write payload sets quote_addons.is_selected',
  !ALL_WRITES.some(p => /\bis_selected\s*:/.test(p)),
  'the ONLY writers of that fact are the two doors into quote_apply_choice')
check('no application write payload sets selected_via or selected_at',
  !ALL_WRITES.some(p => /\bselected_(via|at)\s*:/.test(p)),
  `provenance is the database's to fill from is_selected — a CHECK pins the trio`)
check('no application write payload sets quotes.addons_total',
  !ALL_WRITES.some(p => /\baddons_total\s*:/.test(p)),
  'that column belongs to the trigger quote_addons_sync_total, and to nothing else')
check('the owner surfaces READ addons_total from the column, and never re-derive it',
  ['src/components/quotes/QuotePDF.tsx', 'src/app/dashboard/quotes/[id]/page.tsx']
    .every(f => /Number\(quote\.addons_total\)/.test(CODE[f]) && !/addons_total\s*=[^=\n]*reduce/.test(CODE[f])))
check('the ONE documented exception is the portal PDF bridge, and it stays documented',
  /addons_total: num\(q\.addons_total \?\? null\) \|\|/.test(CODE['src/lib/portalPdf.ts'])
  && /RECONSTRUCTED/.test(SRC['src/lib/portalPdf.ts']),
  'get_portal_data projects the add-on rows but not the column; widening it is a migration, so the reconstruction is checked against the real column live in section 6')

console.log('\n═══ Both approval doors are the SAME core, and both carry the extras ═══')
const DETAIL = CODE['src/app/dashboard/quotes/[id]/page.tsx']
const PORTAL_CLIENT = CODE['src/app/portal/[token]/PortalClient.tsx']
check('the OWNER door passes the extras to owner_select_quote_option',
  /owner_select_quote_option'?,\s*\{[\s\S]{0,400}?p_addon_ids/.test(DETAIL))
check('the CUSTOMER door passes the extras to portal_accept_quote',
  /portal_accept_quote'?,\s*\{[\s\S]{0,500}?p_addon_ids/.test(PORTAL_CLIENT))
check('the ids handed to either door come from ONE helper, never an inline map of UI state',
  /addonIdsFor\(/.test(DETAIL))
// ⛔ The plain-quote win is the trap: markWon() patches the row directly and
// cannot touch quote_addons, so a quote WITH extras must not take that path.
check('a plain quote that offers extras is won through the RPC, not the direct patch',
  /if \(addons\.length > 0\) \{ await recordPlainWinWithAddons\(\); return \}/.test(DETAIL),
  'the patch path writes status + accepted_price and never touches quote_addons — the extras would freeze unbought')
check('…and that path is the SAME core, with a null option',
  /recordPlainWinWithAddons[\s\S]{0,2000}?owner_select_quote_option[\s\S]{0,300}?p_option_id: null/.test(DETAIL))
check('every surface that quotes an approval figure reads it from ONE function',
  [DETAIL, PORTAL_CLIENT, CODE['src/app/portal/[token]/components/BillingTab.tsx']]
    .every(s => /approvalTotal\(/.test(s)),
  'the dialog, the button and the owner sentence must all state what quote_apply_choice will write')

console.log('\n═══ The customer sees the offer; the customer never sees the office ═══')
const BILLING = CODE['src/app/portal/[token]/components/BillingTab.tsx']
const MODEL_SRC = SRC['src/app/portal/[token]/model.ts']
check('the portal payload type carries only customer-safe add-on fields',
  /PortalQuoteAddon \{ id: string; name: string; description: string \| null; price: number; sort_order: number; is_selected: boolean \}/.test(MODEL_SRC),
  'selected_via/selected_at are the business’s provenance record, not the customer’s business')
check('…and quote_addons has no internal-note column at all, so safety is structural',
  !/quote_addons[\s\S]{0,900}?internal/i.test(SCHEMA_CODE),
  'customer-safe BY CONSTRUCTION beats customer-safe by a filter someone has to remember')
check('the portal never renders quotes.internal_notes beside the extras',
  !/internal_notes/.test(BILLING) && !/internal_notes/.test(strip(MODEL_SRC)))
check('nothing is pre-ticked in the portal',
  /const \[pickedAddons, setPickedAddons\] = useState<string\[\]>\(\[\]\)/.test(BILLING),
  'a pre-ticked extra is money added to a bill by whoever wrote the quote')
check('the portal states what the UNTICKED extras mean, at the moment of commitment',
  /didn’t add|didn't add/.test(SRC['src/app/portal/[token]/PortalClient.tsx']),
  '"am I being charged for the ones I left alone?" is the question this screen exists to answer')
check('an extra is only tickable while the quote is still open for approval',
  /const Wrapper = canAccept \? 'button' : 'div'/.test(BILLING),
  'after the decision the write guard would refuse anyway — a control that cannot work is worse than none')

console.log('\n═══ An extra is not a change order, and the code says so ═══')
// ⚠️ An IMPORT, not a mention. lib/quoteAddons names lib/changeOrders in prose
// precisely BECAUSE the boundary matters — a rule that forbade saying the word
// would delete the explanation and keep the coupling.
const importsOf = (src: string) => [...src.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map(m => m[1])
check('lib/quoteAddons states the boundary explicitly',
  /AN ADD-ON IS NOT A CHANGE ORDER/.test(SRC['src/lib/quoteAddons.ts'])
  && /ACCEPTANCE/.test(SRC['src/lib/quoteAddons.ts']))
check('the add-on engine imports nothing from the change-order engine, or the reverse',
  !importsOf(SRC['src/lib/quoteAddons.ts']).some(i => /changeOrders/.test(i))
  && !importsOf(read('src/lib/changeOrders.ts')).some(i => /quoteAddons/.test(i)),
  'two concepts, two engines — the moment one calls the other, the boundary is a convention')
check('nothing in the change-order path writes a quote_addons row',
  !/quote_addons/.test(read('src/lib/changeOrders.ts')))

// ── 3. The document must reconcile to its own bottom line ────────────────────
console.log('\n═══ The document’s rows add up to the document’s total ═══')
const PDF = CODE['src/components/quotes/QuotePDF.tsx']
check('the PDF prints the extras whenever the quote offers any',
  /quoteHasAddons \? \(/.test(PDF))
check('…in their OWN table, after the alternatives table rather than inside it',
  PDF.indexOf('quoteHasAddons ? (') > PDF.indexOf('isOptionsQuote ? ('),
  'the options table says "pick one of these"; borrowing its rows would say the wrong thing')
check('the extras’ contribution is READ from quotes.addons_total, never re-summed',
  /const addonsTotal = Number\(quote\.addons_total\) \|\| 0/.test(PDF),
  'a second sum in the document is how the paper and the record start disagreeing')
check('a pre-acceptance document says the extras are NOT in the total',
  /not included above/.test(SRC['src/components/quotes/QuotePDF.tsx']))
check('a decided document distinguishes added from not-added',
  /'Added' : declined \? 'Not added'/.test(PDF))
check('"Not added" is only stamped once something WAS added',
  /const declined = takenAddons\.length > 0 && !taken/.test(PDF),
  'stamping six rows "Not added" before any decision reads as six refusals nobody made')
check('the customer’s own copy renders the SAME document, extras and all',
  /renderQuoteBlob\([\s\S]{0,200}?addons\)/.test(CODE['src/lib/portalPdf.ts']))

// ── 4. The database contract, read from the APPLY PATH ───────────────────────
console.log('\n═══ The schema on the apply path — the half that was never lost ═══')
check('a baseline was found on the apply path at all',
  !!baselineFile && SCHEMA.length > 1000,
  'supabase/archive is NOT the apply path — a guard reading it proves nothing about production')
check('the comment stripper is alive on the schema too',
  SCHEMA_CODE.length > SCHEMA.length * 0.4 && SCHEMA_CODE.length < SCHEMA.length)
check('quote_addons exists', /create table if not exists public\."quote_addons"/.test(SCHEMA_CODE))
check('⭐ addons_total is written ONLY by the sync trigger',
  /update public\.quotes q set addons_total = v_sum/.test(SCHEMA_CODE)
  && (SCHEMA_CODE.match(/set addons_total/g) || []).length === 1,
  'a second writer anywhere means two answers to "what do the extras cost"')
check('⭐⭐ quotes.total is GENERATED over initial_price + travel_fee + addons_total',
  /"total" numeric\(10,2\) generated always as \(\(\(initial_price \+ COALESCE\(travel_fee, \(0\)::numeric\)\) \+ COALESCE\(addons_total, \(0\)::numeric\)\)\) stored/.test(SCHEMA_CODE),
  'ONE money path out of a quote is why nothing downstream needed changing')
check('the sum counts SELECTED rows only',
  /from public\.quote_addons a where a\.quote_id = v_quote and a\.is_selected/.test(SCHEMA_CODE))
check('⛔ THE FREEZE: any status but draft/sent refuses every write',
  /if v_status not in \('draft', 'sent'\) then\s*\n?\s*raise exception/.test(SCHEMA_CODE))
check('…and it names the change order as where further scope goes',
  /Additional work goes on a change order/.test(SCHEMA))
check('…but it does NOT escape into "an approved quote can never be deleted"',
  /if v_status is null then return coalesce\(new, old\); end if;/.test(SCHEMA_CODE),
  'the parent is already gone: refusing here would make ON DELETE CASCADE impossible')
check('the selection invariant is the DATABASE’s, so the app can only ever say is_selected',
  /if new\.selected_via is null then new\.selected_via := 'default'; end if;/.test(SCHEMA_CODE)
  && /new\.selected_via := null;/.test(SCHEMA_CODE))
check('a CHECK pins the selected/via/at trio in both directions',
  /quote_addons_selection_check.*is_selected AND \(selected_via IS NOT NULL\) AND \(selected_at IS NOT NULL\)/.test(SCHEMA_CODE))
check(`the cap of ${MAX_QUOTE_ADDONS} is enforced by the trigger, and the app mirrors it`,
  new RegExp(`if v_count \\+ 1 > ${MAX_QUOTE_ADDONS} then`).test(SCHEMA_CODE))
check('tenancy is a COMPOSITE foreign key (user_id, quote_id) → quotes(user_id, id)',
  /quote_addons_quote_fkey" FOREIGN KEY \(user_id, quote_id\) REFERENCES quotes\(user_id, id\)/.test(SCHEMA_CODE),
  'a single-column quote_id FK would let a row name another tenant’s quote')
check('RLS is on, and every WRITE policy carries the draft/sent predicate too',
  /alter table public\."quote_addons" enable row level security/.test(SCHEMA_CODE)
  && (SCHEMA_CODE.match(/quote_addons\.quote_id\) AND \(q\.user_id = auth\.uid\(\)\) AND \(q\.status = ANY \(ARRAY\['draft'::text, 'sent'::text\]\)/g) || []).length >= 3,
  'the freeze is defended twice — remove either layer and the other still holds')
check('anon holds NO grant on the table',
  /revoke all on table public\."quote_addons" from public, anon, authenticated, service_role;/.test(SCHEMA_CODE)
  && !/grant [A-Z]+ on table public\."quote_addons" to anon/.test(SCHEMA_CODE))

console.log('\n═══ The choice core: one function, two doors, and no third ═══')
check('quote_apply_choice takes the add-on ids',
  /FUNCTION public\.quote_apply_choice\(p_quote_id uuid, p_option_id uuid, p_addon_ids uuid\[\], p_via text\)/.test(SCHEMA_CODE))
check('⭐ an id it cannot resolve THROUGH this quote is a REFUSAL, never a silent drop',
  /if v_known <> v_want then return false; end if;/.test(SCHEMA_CODE),
  'approving "the ones we recognised" records consent to a configuration nobody saw')
check('…and the resolution is scoped by quote_id, in the core, not at a call site',
  /from public\.quote_addons\s*\n?\s*where quote_id = p_quote_id and id = any\(v_ids\)/.test(SCHEMA_CODE))
check('duplicate ids are de-duplicated before they can be counted twice',
  /array_agg\(distinct x\)/.test(SCHEMA_CODE))
check('⭐⭐ the selection is set for EVERY extra on the quote, not just the chosen ones',
  /update public\.quote_addons\s*\n?\s*set is_selected  = \(id = any\(v_ids\)\)/.test(SCHEMA_CODE),
  'otherwise an extra the customer unticked would stay selected and be billed')
check('accepted_price is computed EXPLICITLY as base + travel + extras',
  /accepted_price = v_base \+ v_travel \+ v_addons/.test(SCHEMA_CODE)
  && !/accepted_price = coalesce\(accepted_price, total\)/.test(SCHEMA_CODE),
  'total is GENERATED and a SET expression reads the OLD row — it would snapshot the pre-choice price')
check('the core authorises NOTHING itself and is granted to no role',
  !/grant execute on function public\."quote_apply_choice"/.test(SCHEMA_CODE))
check('the OWNER door proves auth.uid() and ownership before delegating',
  /FUNCTION public\.owner_select_quote_option\([\s\S]{0,600}?if auth\.uid\(\) is null then return false; end if;/.test(SCHEMA_CODE))
check('the CUSTOMER door proves the token owns the quote AND that it is still sent',
  /FUNCTION public\.portal_accept_quote\([\s\S]{0,1200}?status = 'sent'/.test(SCHEMA_CODE),
  'a draft is the owner’s unfinished document and can never be approved from the portal')
check('the portal projection carries the extras, and only the safe six fields',
  /select qa\.id, qa\.name, qa\.description, qa\.price, qa\.sort_order, qa\.is_selected/.test(SCHEMA_CODE))
check('…and the draft-privacy predicate on the quotes projection is still intact',
  /qt\.customer_id = v_customer and qt\.user_id = v_user and qt\.status <> 'draft'/.test(SCHEMA_CODE),
  'deleting that clause re-opens a confirmed data exposure')

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  console.log('\n═══ 5. The deployed database, attacked anonymously ═══')
  if (!url || !anonKey || url.includes('placeholder')) {
    console.log('  … SKIPPED — no live Supabase credentials (CI runs with placeholders)')
    return
  }
  const anon: SupabaseClient = createClient(url, anonKey)

  // The single most important live assertion: the core authorises nothing. If
  // PostgREST can reach it, anyone who can guess two uuids can accept any quote
  // in any tenant, with any extras, at any price.
  const coreAsAnon = await anon.rpc('quote_apply_choice', {
    p_quote_id: GHOST, p_option_id: null, p_addon_ids: [GHOST], p_via: 'portal',
  })
  check('an anonymous caller cannot reach the unauthorised core',
    coreAsAnon.error !== null && /permission denied|not find the function|does not exist/i.test(coreAsAnon.error?.message ?? ''),
    `got ${coreAsAnon.error ? coreAsAnon.error.message : `data=${JSON.stringify(coreAsAnon.data)}`}`)
  const tableAsAnon = await anon.from('quote_addons').select('id').limit(1)
  check('an anonymous caller cannot read the table',
    tableAsAnon.error !== null || (tableAsAnon.data ?? []).length === 0,
    `got ${tableAsAnon.error ? tableAsAnon.error.message : JSON.stringify(tableAsAnon.data)}`)
  const writeAsAnon = await anon.from('quote_addons')
    .insert({ quote_id: GHOST, user_id: GHOST, name: 'Injected', price: 1, sort_order: 0 })
  check('an anonymous caller cannot write the table', writeAsAnon.error !== null)
  const forged = await anon.rpc('portal_accept_quote', {
    p_token: 'forged-token-not-a-real-customer', p_quote_id: GHOST, p_addon_ids: [GHOST],
  })
  check('a forged portal token cannot name an extra',
    forged.error === null && forged.data === false,
    `returned ${JSON.stringify(forged.data)}`)

  // ── The writable half runs in a fixture tenant, or it does not run ─────────
  const t = await openFixtureTenant('verify:quote-addons')
  if (isSkipped(t)) {
    console.log(`  … SKIPPED the end-to-end run — ${t.skipped}`)
    return
  }
  const owner = t.db
  const uid = t.uid
  const NUM = t.tag('VERIFY-ADDONS')

  let quoteId: string | null = null
  let otherQuoteId: string | null = null
  try {
    console.log('\n═══ 6. The mutation matrix, against the real database ═══')
    const fx = await t.fixtureCustomer()
    const token = fx.token

    // A real options quote WITH extras — the composition, end to end.
    const optRows = optionRowsFor(
      [{ name: 'Budget', price: 3900, is_recommended: false },
       { name: 'Standard', price: 5400, is_recommended: true }],
      'pending', uid,
    )
    const { data: q, error: qErr } = await owner.from('quotes').insert({
      quote_number: NUM, customer_id: fx.id,
      customer_name: 'Automated guard fixture — safe to delete',
      address: '1 Verification Way', service_type: 'Guard fixture',
      initial_price: headlineOptionPrice(optRows), travel_fee: 150,
      hours: 4, crew_size: 2, rate: 60, status: 'sent', user_id: uid, follow_up_count: 0,
    }).select('id, total, addons_total').single()
    if (qErr || !q) { fail('the guard could not create its fixture quote', qErr?.message); return }
    quoteId = (q as { id: string }).id
    check('a fresh quote starts with addons_total = 0',
      Number((q as { addons_total: number }).addons_total) === 0 && Number((q as { total: number }).total) === 5550)

    const { data: optRowsBack } = await owner.from('quote_options')
      .insert(optRows.map(r => ({ ...r, quote_id: quoteId! }))).select('id, name')
    const optByName = Object.fromEntries(((optRowsBack ?? []) as { id: string; name: string }[]).map(o => [o.name, o.id]))

    const { data: addonsBack, error: aErr } = await owner.from('quote_addons')
      .insert(addonRowsFor(
        [{ name: 'Gutter guards', description: 'Keeps the leaves out', price: 180 },
         { name: 'Haul away debris', description: 'We take it with us', price: 95 }],
        quoteId, uid,
      )).select('id, name, price, is_selected, selected_via, selected_at')
    if (aErr || !addonsBack) { fail('the guard could not create its fixture extras', aErr?.message); return }
    const byName = Object.fromEntries((addonsBack as { id: string; name: string }[]).map(a => [a.name, a.id]))

    const readQ = async (qid: string) => {
      const { data } = await owner.from('quotes')
        .select('total, initial_price, addons_total, accepted_price, status, selected_option_id').eq('id', qid).single()
      return data as { total: number; initial_price: number; addons_total: number; accepted_price: number | null; status: string; selected_option_id: string | null }
    }
    const readAddons = async (qid: string) => {
      const { data } = await owner.from('quote_addons')
        .select('id, name, price, is_selected, selected_via, selected_at, sort_order').eq('quote_id', qid).order('sort_order')
      return (data ?? []) as { id: string; name: string; price: number; is_selected: boolean; selected_via: string | null; selected_at: string | null; sort_order: number }[]
    }

    let state = await readQ(quoteId)
    check('⭐ OFFERING extras does not change what the quote is worth',
      Number(state.addons_total) === 0 && Number(state.total) === 5550,
      `total=${state.total} addons_total=${state.addons_total} — an offer nobody took is worth nothing`)
    check('…and the rows really are unselected, with null provenance',
      (await readAddons(quoteId)).every(a => !a.is_selected && a.selected_via === null && a.selected_at === null))

    // ── MUTATION: the cap, the blank name, the negative price ────────────────
    const many = await owner.from('quote_addons').insert(
      Array.from({ length: 5 }, (_, i) => ({ quote_id: quoteId!, user_id: uid, name: `Filler ${i}`, price: 1, sort_order: 10 + i })),
    )
    check(`MUTATION — more than ${MAX_QUOTE_ADDONS} extras is refused by the database`,
      many.error !== null,
      'a list a customer has to audit line by line stops being a choice')
    await owner.from('quote_addons').delete().eq('quote_id', quoteId).like('name', 'Filler %')
    const blank = await owner.from('quote_addons').insert({ quote_id: quoteId, user_id: uid, name: '   ', price: 5, sort_order: 9 })
    check('MUTATION — a blank name is refused by the database', blank.error !== null)
    const negative = await owner.from('quote_addons').insert({ quote_id: quoteId, user_id: uid, name: 'Credit', price: -50, sort_order: 9 })
    check('MUTATION — a negative price is refused by the database', negative.error !== null,
      'an extra that reduces the bill is a discount, and discounts have their own engine')

    // ── MUTATION: an extra from ANOTHER quote ────────────────────────────────
    const { data: q2 } = await owner.from('quotes').insert({
      quote_number: NUM, customer_name: 'Automated guard fixture — safe to delete',
      address: '2 Verification Way', service_type: 'Guard fixture B',
      initial_price: 999, travel_fee: 0, hours: 1, crew_size: 1, rate: 60,
      status: 'sent', user_id: uid,
    }).select('id').single()
    otherQuoteId = (q2 as { id: string } | null)?.id ?? null
    let foreignAddonId: string | null = null
    if (otherQuoteId) {
      const { data: fa } = await owner.from('quote_addons').insert({
        quote_id: otherQuoteId, user_id: uid, name: 'Foreign extra', price: 99999, sort_order: 0,
      }).select('id').single()
      foreignAddonId = (fa as { id: string } | null)?.id ?? null
    }

    if (foreignAddonId) {
      const crossOwner = await owner.rpc('owner_select_quote_option', {
        p_quote_id: quoteId, p_option_id: optByName['Standard'], p_addon_ids: [foreignAddonId],
      })
      state = await readQ(quoteId)
      check('MUTATION — OWNER: another quote’s extra cannot be named against this quote',
        crossOwner.data === false && state.status === 'sent' && Number(state.addons_total) === 0,
        `returned ${JSON.stringify(crossOwner.data)} / status ${state.status} / addons_total ${state.addons_total}`)
      if (token) {
        const crossPortal = await anon.rpc('portal_accept_quote', {
          p_token: token, p_quote_id: quoteId, p_option_id: optByName['Standard'], p_addon_ids: [foreignAddonId],
        })
        state = await readQ(quoteId)
        check('MUTATION — CUSTOMER: another quote’s extra cannot be named against this quote',
          crossPortal.data === false && state.status === 'sent' && Number(state.addons_total) === 0,
          `returned ${JSON.stringify(crossPortal.data)}`)
      }
      // ⭐ THE partial-set attack: one id that belongs, one that does not. The
      // refusal must be TOTAL — approving the recognised half would record
      // consent to a configuration the customer never saw.
      const mixedIds = await owner.rpc('owner_select_quote_option', {
        p_quote_id: quoteId, p_option_id: optByName['Standard'],
        p_addon_ids: [byName['Gutter guards'], foreignAddonId],
      })
      state = await readQ(quoteId)
      check('MUTATION — a set with ONE foreign id is refused ENTIRELY, never partially applied',
        mixedIds.data === false && state.status === 'sent' && Number(state.addons_total) === 0,
        `addons_total=${state.addons_total} — 180 would mean the recognised half was silently approved`)
    }

    const ghostAddon = await owner.rpc('owner_select_quote_option', {
      p_quote_id: quoteId, p_option_id: optByName['Standard'], p_addon_ids: [GHOST],
    })
    check('MUTATION — a ghost extra id is refused', ghostAddon.data === false)

    // ── MUTATION: the customer tampering with a price or a tick ──────────────
    if (token) {
      const anonEdit = await anon.from('quote_addons')
        .update({ price: 1 }).eq('id', byName['Gutter guards'])
      const rowsNow = await readAddons(quoteId)
      check('MUTATION — the customer cannot re-price an extra before approving it',
        Number(rowsNow.find(a => a.id === byName['Gutter guards'])!.price) === 180,
        `price is now ${rowsNow.find(a => a.id === byName['Gutter guards'])!.price} (err: ${anonEdit.error?.message ?? 'none'}) — the price the RPC sums is the ROW’s, so tampering here is the only way to change what is charged`)
      const anonSelect = await anon.from('quote_addons')
        .update({ is_selected: true }).eq('id', byName['Gutter guards'])
      const rowsAfter = await readAddons(quoteId)
      check('MUTATION — the customer cannot select an extra by writing the table directly',
        !rowsAfter.find(a => a.id === byName['Gutter guards'])!.is_selected,
        `(err: ${anonSelect.error?.message ?? 'none'}) — selection has exactly one door, and it snapshots accepted_price in the same transaction`)
    }

    // ── MUTATION: naming the same extra twice ────────────────────────────────
    const dup = token
      ? await anon.rpc('portal_accept_quote', {
          p_token: token, p_quote_id: quoteId, p_option_id: optByName['Standard'],
          p_addon_ids: [byName['Gutter guards'], byName['Gutter guards']],
        })
      : await owner.rpc('owner_select_quote_option', {
          p_quote_id: quoteId, p_option_id: optByName['Standard'],
          p_addon_ids: [byName['Gutter guards'], byName['Gutter guards']],
        })
    state = await readQ(quoteId)
    check('MUTATION — naming the same extra twice bills it ONCE',
      dup.data === true && Number(state.addons_total) === 180,
      `addons_total=${state.addons_total} — 360 would mean a duplicated id was counted twice`)

    // ── THE positive case, fully ─────────────────────────────────────────────
    check('⭐ the accepted total is option + travel + the extras taken',
      Number(state.accepted_price) === 5730 && state.status === 'accepted'
      && state.selected_option_id === optByName['Standard'],
      `accepted_price=${state.accepted_price} — 5400 + 150 + 180`)
    check('⭐⭐ the accepted total does NOT ignore addons_total',
      Number(state.accepted_price) === Number(state.total)
      && Number(state.accepted_price) - Number(state.addons_total) === 5550,
      `accepted=${state.accepted_price} total=${state.total} addons=${state.addons_total}`)
    check('…and initial_price holds the CHOSEN option, with the extras kept separate',
      Number(state.initial_price) === 5400 && Number(state.addons_total) === 180,
      'quoted/base, option, extras and travel stay four distinct facts')
    const finalAddons = await readAddons(quoteId)
    const taken = finalAddons.find(a => a.id === byName['Gutter guards'])!
    const untaken = finalAddons.find(a => a.id === byName['Haul away debris'])!
    check('the taken extra records WHO chose it and WHEN',
      taken.is_selected && (taken.selected_via === 'portal' || taken.selected_via === 'owner') && !!taken.selected_at,
      `via=${taken.selected_via} at=${taken.selected_at}`)
    check('⛔ selected_via is never "default" — nothing was pre-ticked by the business',
      finalAddons.every(a => a.selected_via !== 'default'))
    check('the UNTAKEN extra is left unselected, with null provenance, worth nothing',
      !untaken.is_selected && untaken.selected_via === null && untaken.selected_at === null)
    // The reconstruction the portal PDF bridge performs, checked against the very
    // column it is reconstructing.
    check('Σ selected prices === quotes.addons_total (the portal PDF’s reconstruction is correct)',
      selectedAddons(finalAddons).reduce((s, a) => s + Number(a.price), 0) === Number(state.addons_total))
    check('the app’s own helpers agree with the database about what was taken',
      addonValueBasis(finalAddons) === 'taken'
      && addonIdsFor(selectedAddons(finalAddons)).join() === byName['Gutter guards']
      && sortedAddons(finalAddons)[0].name === 'Gutter guards')
    check('quoteAddonJobLines would schedule exactly the extra that was bought',
      quoteAddonJobLines(finalAddons).length === 1
      && quoteAddonJobLines(finalAddons)[0].amount === 180)

    // ── MUTATION: an extra becoming a change order ───────────────────────────
    const addAfter = await owner.from('quote_addons')
      .insert({ quote_id: quoteId, user_id: uid, name: 'Snuck in later', price: 500, sort_order: 5 })
    check('⛔ MUTATION — a NEW extra cannot be added to a decided quote',
      addAfter.error !== null,
      'scope after acceptance is a CHANGE ORDER — the one thing this feature must never become')
    const editAfter = await owner.from('quote_addons')
      .update({ price: 9999 }).eq('id', byName['Gutter guards'])
    const afterEdit = await readQ(quoteId)
    check('⛔ MUTATION — the HISTORICAL accepted total cannot be moved by re-pricing an extra',
      Number(afterEdit.accepted_price) === 5730 && Number(afterEdit.addons_total) === 180,
      `accepted_price=${afterEdit.accepted_price} addons_total=${afterEdit.addons_total} (err: ${editAfter.error?.message ?? 'none'}) — a signed number that moves is not a record`)
    const selectAfter = await owner.from('quote_addons')
      .update({ is_selected: true }).eq('id', byName['Haul away debris'])
    const afterSelect = await readQ(quoteId)
    check('⛔ MUTATION — an extra the customer DECLINED cannot be selected afterwards',
      Number(afterSelect.addons_total) === 180,
      `addons_total=${afterSelect.addons_total} (err: ${selectAfter.error?.message ?? 'none'}) — billing for declined work is the failure this freeze exists to make impossible`)
    const delAfter = await owner.from('quote_addons').delete().eq('id', byName['Haul away debris'])
    const afterDel = await readAddons(quoteId)
    check('⛔ MUTATION — the record of what was OFFERED cannot be deleted afterwards',
      afterDel.some(a => a.id === byName['Haul away debris']),
      `(err: ${delAfter.error?.message ?? 'none'}) — "what else did you show them?" must stay answerable`)

    // ── MUTATION: re-deciding ────────────────────────────────────────────────
    const redecide = await owner.rpc('owner_select_quote_option', {
      p_quote_id: quoteId, p_option_id: optByName['Standard'],
      p_addon_ids: [byName['Gutter guards'], byName['Haul away debris']],
    })
    const afterRedecide = await readQ(quoteId)
    check('MUTATION — an approved set of extras cannot be swapped underneath the customer',
      redecide.data === false && Number(afterRedecide.addons_total) === 180
      && Number(afterRedecide.accepted_price) === 5730,
      `returned ${JSON.stringify(redecide.data)} / addons_total ${afterRedecide.addons_total}`)
    check('a refused approval reports FALSE — it never looks like a success',
      redecide.data === false && redecide.error === null)

    // ── The reload: what a brand-new session actually sees ───────────────────
    const fresh = createClient(url, anonKey, { auth: { persistSession: false } })
    await fresh.auth.signInWithPassword({
      email: process.env.VERIFY_FIXTURE_EMAIL!, password: process.env.VERIFY_FIXTURE_PASSWORD!,
    })
    const { data: reloadedQ } = await fresh.from('quotes')
      .select('total, addons_total, accepted_price').eq('id', quoteId).single()
    const { data: reloadedAddons } = await fresh.from('quote_addons')
      .select('id, name, price, is_selected, sort_order').eq('quote_id', quoteId).order('sort_order')
    const rq = reloadedQ as { total: number; addons_total: number; accepted_price: number } | null
    check('the decision survives a reload on a brand-new session',
      Number(rq?.addons_total) === 180 && Number(rq?.accepted_price) === 5730,
      `addons_total=${rq?.addons_total} accepted_price=${rq?.accepted_price}`)
    check('…and the display helpers read that persisted truth, not a cached one',
      addonValueBasisLabel('taken', (reloadedAddons ?? []).length,
        selectedAddons((reloadedAddons ?? []) as never[]).length) === '1 of 2 optional extras taken')
    await fresh.auth.signOut({ scope: 'local' }).catch(() => {})
  } finally {
    // ⚠️ The freeze deliberately ESCAPES when the parent quote is already gone —
    // without that escape an APPROVED quote could never be deleted at all. Proven
    // here rather than assumed, because a cleanup that silently fails is how
    // fixture rows used to accumulate in a real book.
    for (const qid of [quoteId, otherQuoteId]) {
      if (!qid) continue
      const del = await owner.from('quotes').delete().eq('id', qid)
      if (qid === quoteId) {
        check('⭐ an APPROVED quote with FROZEN extras can still be DELETED (the freeze escapes on cascade)',
          del.error === null, del.error?.message ?? '')
        const { data: orphans } = await owner.from('quote_addons').select('id').eq('quote_id', qid)
        check('…and its extras go with it — ON DELETE CASCADE, no orphans',
          (orphans ?? []).length === 0)
      }
    }
    await t.close()
    // Measured, not assumed: cleanup that is claimed but never counted is how
    // fixture rows used to accumulate. Scoped to THIS run's id, so a concurrent
    // run's live fixtures can neither be deleted nor counted here.
    const residue = await fixtureResidue(t)
    const left = Object.entries(residue).filter(([, n]) => n !== 0)
    check('the guard cleaned up after itself, in the fixture tenant',
      left.length === 0,
      left.map(([k, n]) => `${n} ${k}`).join(', ') + ` still carry run id ${t.runId}`)
  }
}

main()
  .catch(e => { fail('the guard itself could not run', String(e?.message ?? e)) })
  .finally(() => {
    console.log('\n── Summary ────────────────────────────────────────────────────')
    console.log(failures === 0
      ? '\n✅ verify:quote-addons — an extra is added by a person, priced by the database, and frozen the moment it is decided\n'
      : `\n❌ verify:quote-addons — ${failures} contract${failures === 1 ? '' : 's'} broken\n`)
    process.exit(failures === 0 ? 0 : 1)
  })
