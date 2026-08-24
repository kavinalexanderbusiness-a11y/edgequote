// ── Verify: the PRICE BOOK is one catalogue, and it only ever offers DEFAULTS ─
//   npm run verify:price-book
//
// WHY THIS SCRIPT EXISTS
// Session 76's whole risk is not that the feature fails to work — two nullable
// columns are hard to get wrong — but that it quietly becomes something it must
// never be. Three specific failures, each silent, each expensive:
//
//   1. A SECOND CATALOGUE / A SECOND PRICING ENGINE. `service_templates` has been
//      the price book since the product had one. A new table, or arithmetic on a
//      rate anywhere in lib/priceBook, splits the answer to "what does this cost?"
//      in two — and this repo has already paid for one word meaning three things.
//
//   2. A CATALOGUE EDIT REACHING A SENT QUOTE. Re-pricing next month must not
//      rewrite what a customer already accepted. The guarantee is STRUCTURAL —
//      no live link exists from a saved line back to the catalogue's rate, text
//      or duration — so the assertion is over the ABSENCE, which is exactly the
//      kind of property a later "helpful" change deletes without noticing.
//
//   3. A TYPED DEFAULT OUTRANKING MEASURED HISTORY. The catalogue's duration is
//      a number an owner typed once. Learned duration is what the work has
//      actually taken. If the first ever wins over the second, the learning loop
//      keeps running, keeps being right, and is never heard again.
//
// Everything below is asserted against the REAL modules with hand-derived
// fixtures — behaviour, not copy. Deterministic, no network in the offline half.
//
// THE RULES PINNED:
//    1  ONE catalogue: no second price-book table, no pricing arithmetic here
//    2  NULL means "not stated" — never 0, in either direction
//    3  duration precedence: own → learned → CATALOGUE → unknown
//    4  learned evidence is never overwritten, and is never stored
//    5  a catalogue price is a DEFAULT: no live link from a saved quote back
//    6  a quote's own figure always wins over the catalogue
//    7  bundles follow the catalogue for TIME exactly as they do for PRICE
//    8  Quote Options are untouched (an option REPLACES; it is not a default)
//    9  Quote Add-ons: S57's pricing seam is canonical and left intact
//   10  crew: default ≠ scheduled assignment ≠ who actually worked
//   11  archive hides from FUTURE picking; it never edits the past
//   12  forms (S69) landed: the catalogue holds it, the price book does not own it
//   13  tenancy: every catalogue read is user-scoped
//   14  mobile: the new fields cannot introduce a fixed width
//   15  the migration says what it does, and can only add nullable columns
//   16  the neighbouring engines (smart time, S79 appointments, measure,
//       bundles) keep their own jobs — the price book absorbs none of them

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDuration } from '../src/lib/dayFit'
import {
  catalogDefaults, catalogMinutesFor, catalogCrewFor,
  resolveEstMinutes, durationBasis, describeDurationSource,
} from '../src/lib/priceBook'
import { bundleLines, resolveUnitPrice, templateIndex } from '../src/lib/serviceBundles'
import { MIN_SERVICE_SAMPLE, type ServiceVariance } from '../src/lib/estimateVsActual'
import type { ServiceTemplate, ServiceBundleItem } from '../src/types'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const readIf = (p: string) => existsSync(join(process.cwd(), p)) ? read(p) : ''

// ── Fixtures ─────────────────────────────────────────────────────────────────
const T = (over: Partial<ServiceTemplate> & { id: string }): ServiceTemplate => ({
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  name: 'Fixture service', category: 'General', pricing_display_type: 'starting_from',
  default_rate: 100, default_description: null, notes: null, is_active: true,
  sort_order: 0, user_id: 'u1', unit_cost: null, material_cost: null,
  is_favorite: false, recurrence: null, default_minutes: null, default_crew_size: null,
  // S69's default-checklist column. null here so every assertion in this file is
  // about the price book alone; §12 sets it explicitly where the two must be
  // shown to be independent.
  form_template_id: null,
  ...over,
})
const I = (over: Partial<ServiceBundleItem> & { name: string }): ServiceBundleItem => ({
  id: 'i-' + over.name, created_at: '2026-01-01T00:00:00Z', user_id: 'u1', bundle_id: 'b1',
  service_template_id: null, quantity: 1, unit: 'each', unit_price: null, est_minutes: null,
  notes: null, kind: 'service', sort_order: 0, ...over,
})
/** A service history rollup. `established` is the canonical reliability flag —
 *  this fixture never sets it independently of the sample size, because the two
 *  disagreeing is not a state the real engine can produce. */
const H = (n: number, medianMin: number): ServiceVariance => ({
  serviceKey: 'mowing', serviceLabel: 'Mowing', sampleSize: n,
  established: n >= MIN_SERVICE_SAMPLE,
  medianEstimateMinutes: null, medianActualMinutes: medianMin,
  medianDeltaMinutes: null, medianDeltaPct: null,
  crewSampleSize: 0, medianCrewSize: null,
  laborSampleSize: 0, medianLaborMinutes: null, laborSource: 'none',
} as unknown as ServiceVariance)

console.log('\n══ price book ═══════════════════════════════════════════════════════════\n')

// ═════════════════════════════════════════════════════════════════════════════
console.log('── 1 · ONE catalogue, and no pricing engine in it ──')

const baseline = (() => {
  const dir = 'supabase/migrations'
  const f = readdirSync(join(process.cwd(), dir)).find(x => /_baseline\.sql$/.test(x))
  return f ? read(join(dir, f)) : ''
})()
check('the schema baseline is readable', baseline.length > 0)

// A second catalogue would be a new table whose name says "price book". The
// point of this assertion is that the feature was built by EXTENDING
// service_templates; if a later change adds a rival, this is what notices.
const migrationDir = 'supabase/migrations'
const allMigrations = readdirSync(join(process.cwd(), migrationDir))
  .filter(f => f.endsWith('.sql')).map(f => read(join(migrationDir, f))).join('\n')

// ⚠️ DISCOVERED BY SUFFIX, never by version. This migration has already been
// re-versioned once — `20260815120000` collided with production's job_forms_v1
// (Session 69) and also sorted before the current baseline. A hardcoded path
// would simply have gone unreadable at that rename, silently taking every
// assertion that depends on it down to a vacuous pass.
const pbMigrationFile = readdirSync(join(process.cwd(), migrationDir))
  .find(x => /_price_book_defaults\.sql$/.test(x)) || ''
const pbMigration = pbMigrationFile ? read(join(migrationDir, pbMigrationFile)) : ''
const rivalTable = /create table (if not exists )?(public\.)?"?(price_book|price_book_items|catalog_services|service_catalog)"?/i
check('no rival price-book table is created anywhere in the apply path',
  !rivalTable.test(allMigrations),
  'service_templates IS the catalogue — extend it, never shadow it')

const priceBookSrc = read('src/lib/priceBook.ts')
// ⛔ The module may PASS a rate through; it may not compute one. Multiplication,
// division and percentage arithmetic are how a "helper" becomes a second engine.
const stripped = priceBookSrc
  .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
check('lib/priceBook contains no price arithmetic',
  !/\brate\s*[*/]|[*/]\s*\brate\b|markup|margin|multiplier|discount/i.test(stripped),
  'a catalogue reports a rate; it must never derive one')
check('lib/priceBook never writes to the database',
  !/\.(insert|update|upsert|delete)\s*\(|from\s*\(\s*['"]/.test(stripped),
  'it is a pure read/normalise module; the write paths are the form and the builder')

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 2 · NULL means "not stated" — never zero ──')

eq('a catalogue with no duration reports null minutes',
  catalogDefaults(T({ id: 't1' })).minutes, null)
eq('…and no crew reports null crew', catalogDefaults(T({ id: 't1' })).crewSize, null)
// The DB CHECKs refuse 0, so this is the defence for rows that predate them.
eq('a stored 0 duration normalises to null, not 0',
  catalogDefaults(T({ id: 't2', default_minutes: 0 })).minutes, null)
eq('a stored 0 crew normalises to null, not 0',
  catalogDefaults(T({ id: 't2', default_crew_size: 0 })).crewSize, null)
eq('a negative duration normalises to null',
  catalogDefaults(T({ id: 't3', default_minutes: -30 })).minutes, null)
eq('a real duration survives', catalogDefaults(T({ id: 't4', default_minutes: 90 })).minutes, 90)
eq('a real crew survives', catalogDefaults(T({ id: 't4', default_crew_size: 2 })).crewSize, 2)
// The inverse direction, which is the one a refactor breaks: absence must not
// become a number further down.
eq('an unresolvable template id yields null minutes, not 0',
  catalogMinutesFor('nope', new Map()), null)
eq('a null template id yields null minutes', catalogMinutesFor(null, new Map()), null)
eq('an unresolvable template id yields null crew', catalogCrewFor('nope', new Map()), null)

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 3 · duration precedence: own → learned → CATALOGUE → unknown ──')

const established = H(MIN_SERVICE_SAMPLE, 120)
const thin = H(1, 200)

eq('the quote\'s own figure wins over everything',
  resolveDuration(45, established, 90).minutes, 45)
eq('…and is labelled as this quote\'s', resolveDuration(45, established, 90).source, 'estimate')

eq('⭐ LEARNED history outranks the catalogue default',
  resolveDuration(null, established, 90).minutes, 120)
eq('…and is labelled learned, never catalog',
  resolveDuration(null, established, 90).source, 'learned')

eq('the catalogue fills the gap when history is NOT established',
  resolveDuration(null, thin, 90).minutes, 90)
eq('…and says so — its own source label',
  resolveDuration(null, thin, 90).source, 'catalog')
eq('the catalogue fills the gap when there is no history at all',
  resolveDuration(null, null, 90).source, 'catalog')
// A catalogue figure is not evidence, so it must not carry an evidence count.
eq('a catalogue answer reports NO sample size',
  resolveDuration(null, null, 90).sampleSize, null)

eq('with nothing anywhere the answer stays unknown',
  resolveDuration(null, null, null).minutes, null)
eq('…and is never invented as 0 or a default',
  resolveDuration(null, null, null).source, 'unknown')
eq('a catalogue 0 is not a duration', resolveDuration(null, null, 0).source, 'unknown')

// ⭐ BACKWARD COMPATIBILITY. Every pre-existing caller passes two arguments; the
// third is optional precisely so a catalogue default reaches a surface only when
// that surface asked for it. If this ever changes, existing screens start showing
// catalogue numbers they never opted into.
eq('a two-argument call is unchanged: established history still learned',
  resolveDuration(null, established).source, 'learned')
eq('a two-argument call is unchanged: thin history is still unknown',
  resolveDuration(null, thin).source, 'unknown')
eq('a two-argument call is unchanged: own estimate still wins',
  resolveDuration(300, established).minutes, 300)

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 4 · learned evidence is never overwritten, and never stored ──')

// The structural guarantee: there is no column to overwrite. lib/workEstimate
// derives at read time and says so; a "learned_minutes" column anywhere would be
// the thing that lets a catalogue write clobber measurement.
check('no learned-duration column exists in the schema',
  !/\blearned_(minutes|duration|estimate)\b/i.test(baseline),
  'a learned figure must stay derived — a stored one can be overwritten')
const workEstimateSrc = read('src/lib/workEstimate.ts')
check('lib/workEstimate still performs no writes',
  !/\.(insert|update|upsert)\s*\(/.test(workEstimateSrc),
  'it suggests; it never writes')

// The behavioural guarantee, stated as the property that matters: for EVERY
// established history, adding a catalogue default changes nothing.
let clobbered = 0
for (const [n, med, cat] of [[3, 60, 999], [5, 120, 1], [8, 30, 480], [MIN_SERVICE_SAMPLE, 45, 45]] as const) {
  const h = H(n, med)
  if (!h.established) continue
  const withCat = resolveDuration(null, h, cat)
  const without = resolveDuration(null, h)
  if (withCat.minutes !== without.minutes || withCat.source !== without.source) clobbered++
}
eq('across every established history, a catalogue default changes NOTHING', clobbered, 0)

// The builder's write guard — the one place a catalogue default touches a field
// the learned estimator also writes.
const builderSrc = read('src/components/quotes/QuoteBuilder.tsx')
check('the builder only auto-fills hours it filled itself (or a blank box)',
  /autoFilledHours/.test(builderSrc) &&
  /current === autoFilledHours\.current/.test(builderSrc),
  'without this, switching service deletes a learned or typed figure')
check('…and never re-seeds a SAVED quote from the catalogue',
  /if \(!isEdit\) \{[\s\S]{0,900}catalogDefaults\(t\)/.test(builderSrc),
  'an existing quote\'s numbers are its own — see rule 5')

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 5 · a catalogue price is a DEFAULT — no live link back ──')

// THE historical-truth assertion, and it is over an ABSENCE. A saved line owns
// its own money, its own name and its own time; `service_template_id` records
// WHICH row was used and is deliberately never followed to render one.
const qsDdl = (baseline.match(/create table if not exists public\."quote_services"[\s\S]*?\n\);/) || [''])[0]
check('quote_services stores its OWN unit_price', /"unit_price"/.test(qsDdl))
check('quote_services stores its OWN service_type (the name, copied)', /"service_type"/.test(qsDdl))
check('quote_services stores its OWN est_minutes', /"est_minutes"/.test(qsDdl))
check('quote_services stores its OWN notes', /"notes"/.test(qsDdl))

// If a service is deleted the link goes null and the line keeps every fact it
// needs — which is only true because the facts were copied.
//
// ⚠️ BOUND TO THE CONSTRAINT, NOT TO A SPAN. The first draft of this check was
// /quote_services.*service_template_id.*on delete set null/is over the whole
// file: with `.*` and the `s` flag it matched some LATER table's SET NULL and
// stayed green with this very constraint flipped to CASCADE. Mutation H9 caught
// it. Extract the one statement, then assert about that.
const qsFk = (baseline.match(
  /alter table public\."quote_services" add constraint "quote_services_service_template_id_fkey"[^;]*;/) || [''])[0]
check('the quote-line → catalogue link exists', !!qsFk)
check('deleting a catalogue service SET NULLs the link and destroys no line',
  !!qsFk && /on delete set null/i.test(qsFk) && !/on delete cascade/i.test(qsFk),
  `ON DELETE CASCADE here would delete quoted history along with the service\n      ${qsFk}`)

// The rendering surfaces must not reach into the catalogue for a QUOTE's price.
const pdfSrc = readIf('src/components/quotes/QuotePDF.tsx')
check('the quote PDF is readable', !!pdfSrc)
check('the quote PDF renders no line price from default_rate',
  !!pdfSrc && !/default_rate/.test(pdfSrc),
  'a rendered quote must show what was AGREED, not what the catalogue says today')

// ⚠️ THE PORTAL CARRIES BOTH SHAPES, AND THE DISTINCTION IS THE POINT.
//   PortalQuoteService — a line on a quote the customer was SENT. Its money is
//                        `unit_price`, copied at build time. Frozen.
//   PortalService      — the owner's live catalogue, offered so a customer can
//                        REQUEST something new. Its money IS `default_rate`, and
//                        showing today's rate there is correct: it is an offer,
//                        not a record of one.
// Asserting "no default_rate anywhere in this file" would be wrong and would
// have to be deleted by the first person who read it. The real invariant is that
// the QUOTE shape never acquires a catalogue rate.
const portalModel = readIf('src/app/portal/[token]/model.ts')
check('the portal model is readable', !!portalModel)
const quoteShape = (portalModel.match(/interface PortalQuoteService \{[^}]*\}/) || [''])[0]
check('the portal QUOTE-LINE shape exists', !!quoteShape)
check('…and prices from its own copied unit_price',
  /unit_price/.test(quoteShape),
  'the agreed figure travels with the line')
check('…and never carries a catalogue default_rate',
  !!quoteShape && !/default_rate|default_minutes|default_crew_size/.test(quoteShape),
  'a sent quote re-priced from the catalogue is the exact failure this session must not cause')
check('the live catalogue listing is a SEPARATE shape (PortalService)',
  /interface PortalService \{/.test(portalModel),
  'one type serving both would make "offer" and "record" the same object')

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 6 · the quote\'s own figure always wins ──')

const tmpl = T({ id: 'tpl-1', default_rate: 100, default_minutes: 90 })
const idx = templateIndex([tmpl])
eq('a line that typed its own minutes keeps them',
  resolveEstMinutes({ est_minutes: 20, service_template_id: 'tpl-1' }, idx), 20)
eq('a line that typed its own price keeps it',
  resolveUnitPrice({ unit_price: 12, service_template_id: 'tpl-1' }, idx), 12)
eq('an override of 20 against a catalogue 90 is reported as the line\'s own',
  durationBasis({ est_minutes: 20, service_template_id: 'tpl-1' }, idx), 'bundle')

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 7 · bundles follow the catalogue for TIME as for PRICE ──')

eq('a bundle item with no minutes follows the catalogue',
  resolveEstMinutes({ est_minutes: null, service_template_id: 'tpl-1' }, idx), 90)
eq('…and says the figure is the catalogue\'s',
  durationBasis({ est_minutes: null, service_template_id: 'tpl-1' }, idx), 'catalogue')
eq('a bundle item linked to nothing, with no minutes, is 0 (not stated)',
  resolveEstMinutes({ est_minutes: null, service_template_id: null }, idx), 0)
eq('…and is reported as unstated, never as the catalogue\'s',
  durationBasis({ est_minutes: null, service_template_id: null }, idx), 'unstated')
// The rule that already governs price, restated for time: an explicit figure is
// the owner's, and `!= null` is what distinguishes it from absence.
eq('an explicit 0 on a linked item is NOT a silent re-price to the catalogue',
  resolveUnitPrice({ unit_price: 0, service_template_id: 'tpl-1' }, idx), 0)

// End to end, through the real bundle→lines path.
const lines = bundleLines(
  [I({ name: 'Mow', service_template_id: 'tpl-1', sort_order: 0 }),
   I({ name: 'Edge', est_minutes: 15, sort_order: 1 })],
  idx,
)
eq('bundleLines: the linked line inherits the catalogue duration', lines[0].est_minutes, 90)
eq('bundleLines: the line with its own duration keeps it', lines[1].est_minutes, 15)
eq('bundleLines: the linked line still inherits the catalogue PRICE', lines[0].unit_price, 100)

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 8 · Quote Options are untouched ──')

// An OPTION replaces the whole-job price; a catalogue entry is a DEFAULT for a
// line. Merging them is the failure this pins. The price book must not appear
// in the options engine at all.
const optionsSrcs = ['src/components/quotes/QuoteOptionsEditor.tsx', 'src/lib/quoteOptions.ts']
for (const p of optionsSrcs) {
  const src = readIf(p)
  if (!src) continue
  check(`${p} does not import the price book`,
    !/from '@\/lib\/priceBook'/.test(src),
    'an option is an alternative TOTAL, never a catalogue default')
}
check('the options shape rule still exists in the schema',
  /quote_options_shape_guard|quote_options/i.test(baseline),
  'options are a separate table and stay one')

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 9 · Quote Add-ons: the S57 pricing seam, preserved ──')

// An ADD-ON adds to the price; an OPTION replaces it; a CATALOGUE entry seeds a
// line. Three concepts this session must never have merged.
//
// ⭐ Session 57's schema IS now canonical on main (baseline 20260816110001), so
// this is no longer a DECLARED seam — it is a live invariant, and the price book
// reconciles with it by touching none of it.
check('the Quote Add-ons schema is canonical in the baseline',
  /quote_addons/.test(baseline),
  'S57 landed its schema; if this goes false the baseline regressed')
check('quotes.addons_total exists and is the add-on money column',
  /"addons_total" numeric/.test(baseline))
// ⭐⭐ THE PRICING SEMANTIC ITSELF. quotes.total is GENERATED over three terms;
// if a later change drops addons_total from that expression every accepted quote
// silently loses its extras, and nothing else in the repo asserts it.
// ⚠️⚠️ BOUND TO THE ONE COLUMN LINE. The first draft was
//   /generated always as[^;]*initial_price[^;]*travel_fee[^;]*addons_total/
// over the whole baseline. `[^;]*` does not stop at a newline, and the quotes
// table declares `"addons_total" numeric(10,2)` FIFTEEN LINES BELOW `"total"`
// inside the same semicolon-terminated statement — so deleting addons_total from
// the generated expression left the regex matching the COLUMN instead, and the
// check stayed green while every accepted quote silently lost its extras.
// Mutation A1 caught it. Extract the line, then assert about the line.
const totalCol = (baseline.match(/^\s*"total" numeric[^\r\n]*$/m) || [''])[0]
check('the quotes.total column is readable', !!totalCol)
check('quotes.total is still generated as initial_price + travel_fee + addons_total',
  !!totalCol && /generated always as/.test(totalCol) && /initial_price/.test(totalCol)
    && /travel_fee/.test(totalCol) && /addons_total/.test(totalCol),
  `the add-on total must remain a term of the one money figure\n      ${totalCol.trim()}`)
check('quote_apply_choice is the canonical 4-arg choice engine',
  baseline.includes('FUNCTION public.quote_apply_choice(p_quote_id uuid, p_option_id uuid, p_addon_ids uuid[], p_via text)'),
  'the portal and owner doors both delegate to this one function')
check('…and it is granted to NO role',
  /revoke all on function public."quote_apply_choice"[^;]*from public, anon, authenticated, service_role;/.test(baseline),
  'it is reachable only through the two SECURITY DEFINER doors')

// The APP half of S57 is still not on main. Say so, rather than let a green run
// imply the whole feature shipped.
const addonLib = readIf('src/lib/quoteAddons.ts')
if (!addonLib) {
  console.log('  ⚠ src/lib/quoteAddons.ts is NOT on main — S57 shipped its SCHEMA only,')
  console.log('      and scripts/verify-quote-addons.ts does not exist yet. The price')
  console.log('      book never needed that code; the pricing seam above is what gated it.')
} else {
  check('the add-on engine does not import the price book',
    !/priceBook/.test(addonLib),
    'an add-on is chosen scope, not a catalogue default')
}

// Whatever the app half's state, the price book stays away from the money.
check('nothing in lib/priceBook references quotes.total or addons_total',
  !/addons_total|quotes.total/.test(priceBookSrc),
  'a catalogue default must never reach the one money figure')

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 10 · crew: default ≠ scheduled ≠ actual ──')

eq('the catalogue reports its own typical crew', catalogCrewFor('tpl-1', templateIndex([
  T({ id: 'tpl-1', default_crew_size: 3 }),
])), 3)
// The three must remain three separate stores. If a later change made the
// catalogue the source of a scheduled or worked figure, these break.
// Line-anchored, for the reason spelled out in §13: an unanchored schema check
// happily matches a commented-out version of the thing it is defending.
const jobsDdl = (baseline.match(/^create table if not exists public\."jobs" \([\s\S]*?\n\);/m) || [''])[0]
check('jobs still own their OWN crew_size (the scheduled assignment)',
  !!jobsDdl && /"crew_size"/.test(jobsDdl),
  'the scheduled crew is the job\'s, not the catalogue\'s')
check('work sessions still own who ACTUALLY worked',
  /^create table if not exists public\."job_work_sessions"/m.test(baseline),
  'attendance is recorded, never defaulted')
// Over the CODE, not the prose — the module's header names job_work_sessions in
// order to say it never touches it, and a check that cannot tell an explanation
// from an implementation fails on its own documentation.
check('lib/priceBook never reads a job or a work session',
  !/job_work_sessions|from\('jobs'\)|actual_minutes/.test(stripped),
  'the catalogue states an expectation; it never reconciles it against reality')
check('the catalogue crew default cannot overwrite a stated crew',
  /current === '1' \|\| current === autoFilledCrew\.current/.test(builderSrc),
  'only the form\'s structural floor (1) or our own value may be replaced')

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 11 · archive hides from FUTURE picking; it never edits the past ──')

// The past renders from copied facts, so an archived service cannot change it.
// (Rule 5 proves the copy; this proves the picker behaviour around it.)
check('the builder re-admits an INACTIVE template a quote already points at',
  /templates\.filter\(t => t\.id === currentId && !t\.is_active\)/.test(builderSrc),
  'without this, editing an old quote silently blanks its service')
check('the picker otherwise offers active services only',
  /templates\.filter\(t => t\.is_active\)/.test(builderSrc),
  'a switched-off service and its stale rate must not be one tap from a new quote')
// An archived service keeps its row — the quote's link stays resolvable and the
// catalogue keeps its history. Archive is is_active, NOT a delete.
check('archiving is a flag, not a delete',
  /is_active/.test(read('src/app/dashboard/settings/templates/page.tsx')) &&
  /update\(\{ is_active: !t\.is_active \}\)/.test(read('src/app/dashboard/settings/templates/page.tsx')),
  'deleting would break the link an old quote uses to say which service it was')

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 12 · forms (S69) landed: the catalogue carries one, the price book does NOT own it ──')

// ⭐ THIS RULE WAS RE-EXPRESSED, NOT DELETED. When S76 was written neither S69
// nor S72 was on main, so the honest assertion was that no such seam existed.
// S69 has since landed and `service_templates.form_template_id` is real. A guard
// that went red because the WORLD changed must have its RULE restated, never
// removed — the thing worth defending was never 'forms are absent', it was that
// the price book does not absorb a concern that belongs to another engine.
const formsLanded = /form_template_id/.test(baseline)
if (formsLanded) {
  check('the catalogue carries a default checklist (S69 owns this column)',
    /"form_template_id" uuid/.test(baseline))
  // ⛔ THE SEPARATION. lib/priceBook answers 'how long, how many, what rate'.
  // Which checklist a visit gets is Job Forms' question, resolved lazily at
  // attach time so changing it never rewrites a form already minted on a visit.
  check('lib/priceBook does not read or resolve the form association',
    !/form_template_id|formTemplate|checklist/i.test(priceBookSrc),
    'the price book must not become the forms engine')
  check('the price-book migration does not touch the forms column',
    !!pbMigration && !/form_template_id/i.test(pbMigration),
    'S69 owns that column; S76 adds two of its own and nothing else')
  // The two concerns share a table and must stay independently settable: a
  // service with a checklist and no duration, or a duration and no checklist,
  // are both ordinary states.
  eq('a catalogue row with a checklist but no duration still reports null minutes',
    catalogDefaults(T({ id: 'f1', form_template_id: 'ft-1' } as never)).minutes, null)
  eq('…and a duration with no checklist is unaffected by the forms column',
    catalogDefaults(T({ id: 'f2', default_minutes: 45, form_template_id: null } as never)).minutes, 45)
} else {
  console.log('  ⚠ form_template_id is not in the baseline — S69 is not landed here.')
}

// S72 customer-assets still does not exist. The prompt explicitly did not
// require it, so absence remains the correct assertion.
check('no asset/category association exists on the catalogue',
  !/asset_category|asset_type_id/i.test(baseline + priceBookSrc),
  'Session 72 does not exist; the prompt explicitly does not require it')

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 13 · tenancy ──')

// ⚠️ ANCHORED TO THE START OF A LINE, and that is not pedantry: the unanchored
// version of the RLS check below matched its own commented-out self. Mutation T3
// switched RLS off by prefixing `-- ` and the guard stayed green, because
// "…enable row level security" is still present in the file — inside a comment.
// Every schema assertion here is line-anchored for that reason.
const atLineStart = (re: string) => new RegExp(`^\\s*${re}`, 'im')
check('service_templates is tenant-scoped by user_id',
  atLineStart(String.raw`create table if not exists public\."service_templates"`).test(baseline) &&
  /create table if not exists public\."service_templates"[\s\S]*?"user_id" uuid not null[\s\S]*?\n\);/.test(baseline))
check('…and has RLS enabled',
  atLineStart(String.raw`alter table (public\.)?"?service_templates"? enable row level security`).test(baseline),
  'a commented-out ENABLE is not an enabled policy')
// The new columns inherit those policies — but only because they were added to
// the SAME table. A rival table would have needed its own, which is a second
// place to get tenancy wrong.
check('the price-book migration adds columns to the EXISTING table',
  !!pbMigration && /alter table public\."service_templates"/.test(pbMigration) &&
  !/create table/i.test(pbMigration),
  'columns on an existing table inherit its policies; a new table would not')
// Every read path scopes by the signed-in user.
for (const p of ['src/hooks/useBusinessData.ts', 'src/app/dashboard/quotes/new/page.tsx']) {
  const src = read(p)
  const m = src.match(/from\('service_templates'\)[^\n]*/g) || []
  check(`${p}: every service_templates read is user-scoped`,
    m.length > 0 && m.every(l => /\.eq\('user_id'/.test(l)),
    m.filter(l => !/\.eq\('user_id'/.test(l)).join('\n      '))
}
// lib/priceBook is handed rows; it never queries, so it cannot cross a tenant.
check('lib/priceBook performs no queries of its own',
  !/supabase|createClient/.test(priceBookSrc),
  'it operates on rows the caller already scoped — the loader owns tenancy')

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 14 · mobile ──')

const tplPage = read('src/app/dashboard/settings/templates/page.tsx')
// ⚠️ The slice is bound to the PAIR — from the wrapper that lays them out to the
// close of the second input — not to a character count. A fixed-width span that
// runs past its target is how a mutation-tested guard still passes with the real
// code deleted (cf. verify:service-bundles, which learned this the hard way).
const dsMatch = tplPage.match(
  /<div className="grid[^"]*">\s*<Input label="Typical Duration[\s\S]*?register\('default_crew_size'\)\} \/>/)
check('the two new fields exist in the catalogue editor, laid out together', !!dsMatch)
if (dsMatch) {
  const block = dsMatch[0]
  check('…and stack on a phone before pairing (grid-cols-1 sm:grid-cols-2)',
    /grid-cols-1 sm:grid-cols-2/.test(block),
    'a two-column pair at 375px is how a settings form starts scrolling sideways')
  check('…and introduce no fixed pixel width',
    !/\bw-\[\d+px\]|\bmin-w-\[\d+px\]|style=\{\{[^}]*width/.test(block),
    'a fixed width cannot shrink, and one overflow widens the whole page')
  check('…and both are numeric inputs',
    (block.match(/type="number"/g) || []).length === 2)
}
check('the new inputs are numeric on a phone keyboard',
  /inputMode="numeric"/.test(tplPage),
  'a text keyboard for a minutes field is two extra taps every time')

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 15 · the migration ──')

check('the price-book migration exists', !!pbMigration)
if (pbMigration) {
  const body = pbMigration.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')
  check('it adds exactly the two intended columns',
    /add column if not exists "default_minutes" integer/.test(body) &&
    /add column if not exists "default_crew_size" integer/.test(body))
  check('both columns are NULLABLE (no NOT NULL, no DEFAULT)',
    !/default_(minutes|crew_size)"? integer[^,;]*\b(not null|default)\b/i.test(body),
    'a default value would invent evidence on every existing row')
  check('both CHECKs permit NULL and refuse 0',
    /"default_minutes" is null or \("default_minutes" > 0/.test(body) &&
    /"default_crew_size" is null or \("default_crew_size" >= 1/.test(body))
  check('it drops nothing and rewrites nothing',
    !/\b(drop|truncate|delete from|alter column .* type)\b/i.test(body),
    'this migration is additive only')
  check('it creates no trigger and no function',
    !/create (or replace )?(trigger|function)/i.test(body),
    'a catalogue default is read at pick time — nothing needs to fire')
}
// Version hygiene: it must sort AFTER the generated baseline, or a rebuild
// replays it before the table it alters exists.
const files = readdirSync(join(process.cwd(), migrationDir)).filter(f => f.endsWith('.sql')).sort()
const baseIdx = files.findIndex(f => /_baseline\.sql$/.test(f))
const pbIdx = files.findIndex(f => /_price_book_defaults\.sql$/.test(f))
check('the price-book migration sorts after the baseline', baseIdx >= 0 && pbIdx > baseIdx,
  `baseline at ${baseIdx}, price book at ${pbIdx}`)

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 16 · the neighbouring engines keep their own jobs ──')

// Session 76 reconciled onto a main that had moved a long way. Each engine below
// touches DURATION or PRICE somewhere, and the reconciliation risk is the same in
// every case: the price book quietly becoming the place that answers their
// question too. These pin the boundary rather than the wiring.

// ── Smart Time / estimate-vs-actual ──────────────────────────────────────────
// ⭐ ONE duration rule. lib/workEstimate must keep delegating to dayFit's
// resolveDuration; a second precedence ladder is how the card in the job form and
// the 'Fits Tuesday' claim start disagreeing about the same work.
check('lib/workEstimate still delegates to dayFit.resolveDuration',
  workEstimateSrc.includes('resolveDuration('),
  'the smart estimate must not grow a rival precedence')
check('…and still asks the pure history question (null own estimate)',
  workEstimateSrc.includes('resolveDuration(null,'))
// ⛔ And it must NOT have been handed a catalogue default: the smart estimate
// answers 'what does history say?', and a typed default is not history. Feeding
// one in would make an unmeasured service report a confident learned figure.
check('the smart estimate is NOT given a catalogue default',
  !/resolveDuration\(null,[^)]*catalog/i.test(workEstimateSrc),
  'workEstimate must stay a report about MEASURED history only')
check('lib/workEstimate does not import the price book',
  !/priceBook/.test(workEstimateSrc),
  'learning and defaults are separate claims and stay separate modules')

// ── Estimate appointments (S79) ──────────────────────────────────────────────
// A booked estimate visit is scheduled time, not quoted work. It must not pick up
// a catalogue price or duration by accident.
const apptSrc = readIf('src/lib/estimateAppointments.ts')
check('estimate appointments module is present (S79 landed)', !!apptSrc)
check('…and does not import the price book',
  !apptSrc || !/priceBook/.test(apptSrc),
  'an estimate appointment is a visit to GO AND LOOK — it has no catalogue price')
check('schedule_items is still the estimate-appointment table',
  atLineStart(String.raw`create table if not exists public\."schedule_items"`).test(baseline),
  'S79 revived this table rather than building a rival')

// ── Measure & Price ──────────────────────────────────────────────────────────
// Measurement drives PRICE through the pricing engine, never through the
// catalogue. If the price book ever read a measurement it would be deriving a
// price, which rule 1 forbids.
check('lib/priceBook reads no measurement',
  !/measured_sqft|lawn_sqft|measurement|sqft/i.test(stripped),
  'area drives the pricing engine; the catalogue only reports a stored rate')
const autoMeasure = readIf('src/lib/autoMeasure.ts')
check('the measure path does not import the price book',
  !autoMeasure || !/priceBook/.test(autoMeasure),
  'measurement and catalogue defaults are independent inputs to a quote')

// ── Bundles ──────────────────────────────────────────────────────────────────
// Already pinned behaviourally in §7; this is the structural half — the bundle
// engine may READ the catalogue, and still owns no rate of its own.
const bundleSrc = read('src/lib/serviceBundles.ts')
check('bundles resolve duration through the ONE price-book helper',
  bundleSrc.includes('resolveEstMinutes(it, templates)'),
  'a second inline fallback here is how price and time drift apart')
check('…and still resolve price through their own resolveUnitPrice',
  bundleSrc.includes('resolveUnitPrice(it, templates)'))
// ⭐ COPY, NOT LIVE LINK — asserted over the ABSENCE, the same way Service
// Bundles guaranteed it originally. With no bundle_id to follow, editing or
// deleting a bundle cannot reach a quote already sent or approved.
const qsDdlForBundle = (baseline.match(
  /create table if not exists public\."quote_services"[\s\S]*?\n\);/) || [''])[0]
check('the quote_services DDL is readable', !!qsDdlForBundle)
check('no bundle_id was added to a quote line (copy, not live link)',
  !!qsDdlForBundle && !/bundle_id/.test(qsDdlForBundle),
  'the absence IS the guarantee that editing a bundle cannot reach a sent quote')

// ── Wording ──────────────────────────────────────────────────────────────────
console.log('\n── wording: a typed default never claims to be measured ──')
eq('a catalogue duration is called the owner\'s own default',
  describeDurationSource('catalog'), 'your service default')
eq('learned is the only source that points at past visits',
  describeDurationSource('learned'), 'past visits')
check('the catalogue is never described as "typical" (dayFit reserves that for learned)',
  !/typical/i.test(String(describeDurationSource('catalog'))),
  '"typical" reads as measured; the catalogue measured nothing')
eq('an unknown duration says nothing at all', describeDurationSource('unknown'), null)

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n${failures === 0 ? '✅ price book: all checks passed' : `❌ price book: ${failures} check(s) failed`}\n`)
process.exit(failures === 0 ? 0 : 1)
