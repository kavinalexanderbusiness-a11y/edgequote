// ── Verify: test data is not the business's book ─────────────────────────────
//   npm run verify:production-hygiene
//
// WHAT WENT WRONG. A production audit of the live tenant found fixture workers
// and fixture crews on real screens, fixture services in the customer portal,
// $1 fixture services shown to customers as real prices, and fixture rows
// counting toward capacity and analytics. None of it was a bug in a feature.
// It was the absence of a concept: nothing in the system had ever been asked to
// tell a test row from a real one.
//
// ⭐⭐ THE MEASURED STARTING POINT — the fact that shapes every rule below.
// **No table in this schema carries a fixture marker.** No `is_test`, no
// `source`, no `origin`, no `seeded_by`. The only fixture concept that exists is
// `verify_fixture_tenants`, and its own COMMENT says no trigger, policy or
// application path reads it: it marks a whole TENANT for the guard scripts and
// cannot answer "is this ROW inside the owner's real book a fixture?".
//
// So fixture-ness is recovered from what the fixture WRITERS put in the data.
// §1 asserts those markers are still exactly what the harnesses emit — if a
// harness changes its prefix, this guard goes red rather than the rule going
// quietly hollow.
//
// ⛔⛔ THE RULE THIS GUARD DEFENDS HARDEST — TWO TIERS, NEVER ONE.
// "Do not classify legitimate data merely because its name contains 'test'."
// A pressure washer sells "Deck Testing". A customer lives on "Test Valley
// Road". A landscaper's biggest client is "Demo Farms". Every one is real money,
// and a hygiene rule that hides them is worse than the problem it solves,
// because it silently subtracts revenue from the owner's own reports and
// nothing on screen says why.
//
//   TIER 1 CLASSIFIES  unmistakable machine-written markers → acts automatically
//   TIER 2 FLAGS       looks like test data → tells a human, never acts
//
// §2 is the adversarial half: a long list of legitimate names that MUST survive.
//
// This guard is OFFLINE by construction. It reads source and asserts rules; it
// opens no database connection, so it runs identically in CI and locally and
// can never be the reason a suite skips.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  FIXTURE_EXACT_MARKERS, FIXTURE_PREFIXES, PLACEHOLDER_WORDS, SUSPECT_WORDS,
  blocksPublication, catalogueSuspicions, duplicateNameSet, fixtureCount,
  isAnyFixtureName, isFixtureName, recommendedAction, withoutFixtures,
} from '../src/lib/fixtureData'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// ⚠️⚠️ CR-or-LF split, and it is load-bearing. Every file here is CRLF; `.` does
// not match a carriage return and an unanchored `$` will not match before one,
// so the obvious newline-only split yields a stripper that removes NOTHING and
// every assertion made through it passes over raw source. Asserted alive below.
const strip = (s: string) => s.split(/\r?\n/).map(l => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n')
const stripperAlive = (s: string) => { const t = strip(s); return t.length > s.length * 0.2 && t.length < s.length * 0.99 }

// ── 1. The markers are what the harnesses actually write ─────────────────────
console.log('\n═══ The fixture markers are MEASURED against the scripts that write them ═══')

const SCRIPT_DIR = 'scripts'
const scriptSrc = readdirSync(join(process.cwd(), SCRIPT_DIR))
  .filter(f => f.endsWith('.ts') || f.endsWith('.mjs'))
  .map(f => read(join(SCRIPT_DIR, f)))
  .join('\n')

// Every quoted literal the harnesses use to name a row they created.
const emitted = [...scriptSrc.matchAll(/['"`](ZZ-[^'"`]{0,60}|VERIFY-[^'"`]{0,60}|Automated guard fixture[^'"`]{0,60})['"`]/g)]
  .map(m => m[1])
const uniqueEmitted = [...new Set(emitted)]

check('the harnesses really do tag their rows (the markers are not imagined)',
  uniqueEmitted.length >= 8,
  `found ${uniqueEmitted.length} tagged literals across scripts/ — if this collapses, the rule below is describing nothing`)
check('⭐ EVERY marker the harnesses emit is classified by the rule',
  uniqueEmitted.every(n => isFixtureName(n)),
  `unclassified: ${uniqueEmitted.filter(n => !isFixtureName(n)).join(', ')} — a harness changed its prefix and the rule went hollow`)
check('the guard-fixture sentence is matched exactly as written',
  isFixtureName('Automated guard fixture — safe to delete'))
check('…including the ASCII-dash variant, which a copy-paste produces',
  isFixtureName('Automated guard fixture - safe to delete'))
check('matching is case-insensitive and tolerates surrounding whitespace',
  isFixtureName('  zz-s70 TEXT  ') && isFixtureName('Verify-Options'))

// ── 2. ⛔ THE ADVERSARIAL HALF: legitimate names MUST survive ────────────────
console.log('\n═══ Real names a real business uses — none of these may be classified ═══')
const MUST_SURVIVE = [
  // The exact trap the brief names.
  'Soil Testing', 'Deck Testing', 'Water Testing', 'Test Valley Farms', 'Testing Laboratory Ltd',
  'Demo Farms', 'Demo Day Cleanup', 'Sample Preparation', 'Sample Collection',
  // Trades where a suspect word is the actual product.
  'Concrete Sample Cores', 'Air Quality Testing', 'Backflow Testing', 'Pressure Testing',
  // Ordinary services and people.
  'Lawn Mowing', 'Window Cleaning', 'Snow Removal', 'Gutter Guards', 'Spring Cleanup',
  'Zachary Zimmerman', 'Zoe Zhang', 'ZZ Top Tribute Band Venue Clean',
  'Verification Services Inc', 'Verify Home Inspections',
]
for (const name of MUST_SURVIVE) {
  check(`“${name}” is NOT classified as fixture data`, !isFixtureName(name),
    'classifying this would silently remove a real customer or a real service from the owner’s book')
}
check('a blank or missing name is not evidence of anything',
  !isFixtureName('') && !isFixtureName(null) && !isFixtureName(undefined) && !isFixtureName('   '))
// ⭐ Anchoring is what makes MUST_SURVIVE possible. An `includes()` rule would
// classify "ZZ Top Tribute Band Venue Clean" and "Verify Home Inspections".
check('⭐ the prefixes are ANCHORED at the start, never substring-matched',
  !isFixtureName('Deck ZZ-Top Mural') && !isFixtureName('Please verify-check the meter')
  && isFixtureName('ZZ-anything'),
  'a substring rule hides real rows whose name merely contains a marker')

// ── 3. Tier 1 never contains a natural word ──────────────────────────────────
console.log('\n═══ The two tiers cannot be collapsed into one ═══')
check('⛔ no Tier-1 prefix is a natural English word a person might type',
  FIXTURE_PREFIXES.every(p => !SUSPECT_WORDS.includes(p.replace(/[-_]+$/, ''))),
  `a natural word in FIXTURE_PREFIXES would make every "Test …" service disappear`)
check('“test”, “demo” and “sample” are SUSPECT words, not classifiers',
  ['test', 'demo', 'sample'].every(w => SUSPECT_WORDS.includes(w) && !FIXTURE_PREFIXES.includes(w)))
check('the exact markers are full sentences, not fragments that could collide',
  FIXTURE_EXACT_MARKERS.every(m => m.length > 20))
check('a SUSPECT word never blocks publication on its own',
  !blocksPublication(catalogueSuspicions({ name: 'Soil Testing', default_rate: 180, is_active: true })),
  'a real service whose name reads oddly must still be publishable — the owner decides')
check('…but a PLACEHOLDER does block it',
  blocksPublication(catalogueSuspicions({ name: 'Untitled', default_rate: 180, is_active: true })))
check('every placeholder word is one with no honest customer-facing reading',
  PLACEHOLDER_WORDS.every(w => !SUSPECT_WORDS.includes(w)))

// ── 4. The catalogue-quality rules, including the $1 case ────────────────────
console.log('\n═══ Catalogue quality — flagged for a human, never silently rewritten ═══')
const codes = (r: Parameters<typeof catalogueSuspicions>[0], o?: Parameters<typeof catalogueSuspicions>[1]) =>
  catalogueSuspicions(r, o).map(s => s.code).sort()

check('⭐ a $1 service is FLAGGED and blocked from publication',
  codes({ name: 'Mowing', default_rate: 1, is_active: true }).includes('trivial_price')
  && blocksPublication(catalogueSuspicions({ name: 'Mowing', default_rate: 1, is_active: true })),
  'this is the exact row the audit found in a customer portal')
check('a $0 service is flagged too, and says so in a way a free estimate can answer',
  catalogueSuspicions({ name: 'Estimate', default_rate: 0, is_active: true })
    .some(s => s.code === 'trivial_price' && /free estimate/i.test(s.message)))
check('⛔ NOTHING is rewritten — the result is sentences, not a corrected row',
  catalogueSuspicions({ name: 'Mowing', default_rate: 1, is_active: true })
    .every(s => typeof s.message === 'string' && s.message.length > 10),
  '"Do not silently rewrite legitimate owner prices" — a $1 call-out fee may be real')
check('a real price raises no price flag at all',
  !codes({ name: 'Mowing', default_rate: 65, is_active: true }).includes('trivial_price'))
check('an unusable price is flagged as UNKNOWN, never coerced to 0',
  codes({ name: 'Mowing', default_rate: null, is_active: true }).includes('unknown_price'))
check('a nameless service is flagged and blocked',
  codes({ name: '', default_rate: 65, is_active: true }).includes('malformed_label')
  && blocksPublication(catalogueSuspicions({ name: '', default_rate: 65, is_active: true })))
check('a padded name is flagged but does NOT block — it is a tidy-up, not a lie',
  codes({ name: '  Mowing  ', default_rate: 65, is_active: true }).includes('malformed_label')
  && !blocksPublication(catalogueSuspicions({ name: '  Mowing  ', default_rate: 65, is_active: true })))
check('an INACTIVE service is flagged and blocked',
  codes({ name: 'Mowing', default_rate: 65, is_active: false }).includes('inactive')
  && blocksPublication(catalogueSuspicions({ name: 'Mowing', default_rate: 65, is_active: false })))
check('a duplicate name is flagged and blocked',
  blocksPublication(catalogueSuspicions({ name: 'Mowing', default_rate: 65, is_active: true }, { duplicateOfName: 'Mowing' })))
check('duplicate detection is a property of the SET, case- and space-insensitive',
  duplicateNameSet(['Mowing', ' mowing ', 'Edging']).has('mowing')
  && !duplicateNameSet(['Mowing', 'Edging']).size)

// ── 5. Fixture rows leave at the doors, not at the call sites ────────────────
console.log('\n═══ The exclusions live at the DOOR, so no screen can forget them ═══')
const SRC = {
  crews: read('src/lib/crews.ts'),
  dayFit: read('src/lib/dayFitLoad.ts'),
  dashboard: read('src/lib/dashboard/data.ts'),
}
for (const [k, s] of Object.entries(SRC)) check(`the comment stripper is alive on ${k}`, stripperAlive(s))
const CODE = Object.fromEntries(Object.entries(SRC).map(([k, s]) => [k, strip(s)]))

check('⭐ loadTechnicians drops fixture rows by default',
  /export async function loadTechnicians[\s\S]{0,900}?withoutFixtures\(rows, t => t\.name\)/.test(CODE.crews),
  'a fixture worker on the roster is also a fixture worker in the capacity figure')
check('⭐ loadCrews drops fixture rows by default',
  /export async function loadCrews[\s\S]{0,900}?withoutFixtures\(rows, c => c\.name\)/.test(CODE.crews))
check('both doors offer an explicit includeFixtures escape, mirroring includeArchived',
  /includeFixtures\?: boolean/.test(CODE.crews)
  && /includeArchived\?: boolean; includeFixtures\?: boolean/.test(CODE.crews),
  'money replay must be able to see the complete roster, exactly as it already can for archived people')
check('⭐⭐ the CAPACITY read drops them before anything counts',
  /withoutFixtures\(\(tRes\.data as WorkerForAvailability\[\]\) \|\| \[\], t => t\.name\)/.test(CODE.dayFit),
  'a fixture worker raises available staffing, so the fit engine offers dates the business cannot serve')
check('⭐⭐ the analytics/revenue loader drops fixture quotes AND invoices',
  /invRes\.rows\.filter\(r => !isAnyFixtureName\(r\.invoice_number, r\.customer_name\)\)/.test(CODE.dashboard)
  && /quoteRes\.rows\.filter\(q => !isAnyFixtureName\(q\.quote_number, q\.customer_name\)\)/.test(CODE.dashboard),
  'left in, a guard fixture lands in pipeline value, Owed/Collected, win rate and the follow-up queue')
check('…identified by BOTH the number and the customer name',
  isAnyFixtureName('VERIFY-ADDONS-x', 'Real Person')
  && isAnyFixtureName('EPS-2026-0001', 'Automated guard fixture — safe to delete')
  && !isAnyFixtureName('EPS-2026-0001', 'Real Person'),
  'different harnesses tag different fields; asking both is what makes one rule cover them all')

// ── 6. The helpers behave ────────────────────────────────────────────────────
console.log('\n═══ The helpers ═══')
const roster = [{ name: 'Real Person' }, { name: 'ZZ-S61-FIXTURE' }, { name: 'Demo Farms' }]
check('withoutFixtures keeps the real rows and the merely-odd one',
  withoutFixtures(roster, r => r.name).map(r => r.name).join() === 'Real Person,Demo Farms')
check('fixtureCount can say how many were hidden',
  fixtureCount(roster, r => r.name) === 1,
  'hygiene nobody can see reads as data loss')
check('an empty or missing list is safe',
  withoutFixtures(null, (r: { name: string }) => r.name).length === 0 && fixtureCount(undefined, () => '') === 0)

// ── 7. Cleanup is a RECOMMENDATION, never an action ──────────────────────────
console.log('\n═══ Nothing here deletes anything ═══')
check('⛔ a referenced fixture row is never recommended for deletion',
  recommendedAction([{ table: 'jobs', count: 3 }], { archive: true }) === 'archive'
  && recommendedAction([{ table: 'jobs', count: 3 }], { deactivate: true }) === 'deactivate'
  && recommendedAction([{ table: 'jobs', count: 3 }], {}) === 'review',
  'deleting it would take real history with it — that history is the owner’s')
check('an UNREFERENCED row prefers archive, then deactivate, then delete',
  recommendedAction([], { archive: true }) === 'archive'
  && recommendedAction([], { deactivate: true }) === 'deactivate'
  && recommendedAction([], {}) === 'delete')
check('⛔ lib/fixtureData contains no delete, no update, no supabase client',
  !/\.delete\(|\.update\(|createClient|from\(/.test(strip(read('src/lib/fixtureData.ts'))),
  'the classification engine must be pure — a rule that can act is a rule that can act by accident')
// ⭐⭐ The report must REFUSE rather than report a clean book it could not see.
// Every table it reads is RLS-protected; an anon read returns an empty list with
// NO error, so “0 fixture rows” would be indistinguishable from “invisible”. That
// is a false all-clear on the exact surface the report exists to audit.
const REPORT = read('scripts/hygiene-report.ts')
check('⛔ the cleanup report REFUSES to run without a key that can actually see rows',
  /const CAN_SEE_ROWS = !!serviceKey/.test(strip(REPORT))
  && /if \(!CAN_SEE_ROWS\) \{[\s\S]{0,900}?process\.exit\(3\)/.test(strip(REPORT)),
  'an empty RLS-filtered read must never print as “nothing to clean up”')
check('…and it says WHY, so the operator fixes the credential rather than trusting the zero',
  /would mean “invisible”, not “clean”|false all-clear/.test(REPORT))
check('the cleanup reporter is read-only too',
  !/\.delete\(|\.update\(|\.insert\(|\.upsert\(/.test(strip(read('scripts/hygiene-report.ts'))),
  'it produces candidates for a human; it must not be able to enact them')

// ── 8. Universal product copy ────────────────────────────────────────────────
console.log('\n═══ One product, every trade — platform copy names geometry, not a trade ═══')
// ⭐ The BOOKING page is the platform's own customer-facing surface: one
// codebase, every tenant, no owner configuration in the strings. The portal was
// already generic (its own comments say "never surface the word lawn"); this
// page was not.
const BOOKING = strip(read('src/app/book/[token]/BookingClient.tsx'))
const TRADE_WORDS = /\b(lawn|lawns|mow|mowing|grass|turf|yard)\b/i
// Only the strings a customer READS — JSX text, labels, placeholders, titles.
const customerStrings = [
  ...BOOKING.matchAll(/(?:title|sub|label|placeholder|aria-label|alt)=(?:"([^"]*)"|\{`([^`]*)`\})/g),
].map(m => m[1] ?? m[2] ?? '')
const jsxText = [...BOOKING.matchAll(/>\s*([A-Z][^<>{}\n]{6,})\s*</g)].map(m => m[1])
const allCopy = [...customerStrings, ...jsxText]
check('the copy extractor found real customer-facing strings',
  allCopy.length >= 10, `found ${allCopy.length} — an extractor that finds nothing proves nothing`)
const offenders = allCopy.filter(s => TRADE_WORDS.test(s))
check('⭐⭐ no platform booking copy names a trade',
  offenders.length === 0,
  offenders.map(s => `“${s.trim()}”`).join(' · ') + ' — a window cleaner\'s customer reads this page too')
check('…and the generic vocabulary is actually used',
  /Measured area|Confirm the area|Approximate area|Estimated area/.test(BOOKING),
  'removing the trade word is only half the fix; the replacement has to say what the number IS')

// ⛔ The other half of the rule: trade vocabulary comes from CONFIGURATION.
check('⛔ no engine branches on a trade keyword found in a service NAME',
  !/(includes|startsWith|endsWith|match|test)\s*\(\s*['"`/](lawn|mow|grass|turf)/i.test(strip(read('src/lib/servicePricing.ts')))
  && !/(includes|startsWith)\s*\(\s*['"`](lawn|mow)/i.test(CODE.dashboard),
  'the trade must arrive from the owner’s own catalogue and settings, never from a keyword')
check('the trade registry still forbids engines importing it',
  /no engine[\s\S]{0,200}?may import lib\/trades/i.test(read('src/lib/trades/types.ts')),
  'that rule is what makes "configuration, never keywords" structural rather than a habit')

// ── 9. The database no longer hardcodes a trade ──────────────────────────────
console.log('\n═══ …and neither does the database ═══')
const MIGRATIONS = 'supabase/migrations'
const baselineFile = readdirSync(join(process.cwd(), MIGRATIONS)).filter(f => f.endsWith('_baseline.sql')).sort().pop()
const BASELINE = baselineFile ? read(join(MIGRATIONS, baselineFile)) : ''
const pubMigration = readdirSync(join(process.cwd(), MIGRATIONS)).find(f => f.includes('service_publication'))
const PUBSQL = pubMigration ? read(join(MIGRATIONS, pubMigration)) : ''

check('the publication migration is on the APPLY PATH', !!pubMigration && PUBSQL.length > 1000,
  'supabase/archive is not the apply path — a migration there never runs')
check('⭐ book_service’s hardcoded trade fallback is replaced by a configured one',
  /coalesce\(v_service, v_fallback_service\)/.test(PUBSQL)
  && /from public\.service_templates[\s\S]{0,200}?published_at is not null[\s\S]{0,120}?order by sort_order/.test(PUBSQL),
  'one function serves every tenant; “Lawn Mowing” was stamped on a window cleaner’s quote')
check('…falling back to a neutral noun only when the catalogue offers nothing',
  /coalesce\(v_fallback_service, ''Service''\)|coalesce\(v_fallback_service, 'Service'\)/.test(PUBSQL))
check('…and it PROVES the trade word is gone before committing',
  /position\('Lawn Mowing' in v_src\) > 0 then[\s\S]{0,120}?raise exception/.test(PUBSQL))
// The baseline still carries the OLD body — that is history, and correct. What
// must be true is that the migration replacing it exists and is verified above.
check('the defect really was in the shipped baseline (this is not a fix for nothing)',
  /coalesce\(v_service,'Lawn Mowing'\)/.test(BASELINE),
  'if this stops matching, the baseline has converged and this assertion should be retired deliberately')

console.log('\n── Summary ────────────────────────────────────────────────────')
console.log(failures === 0
  ? '\n✅ verify:production-hygiene — test data is classified only when a machine wrote it, flagged when a human might have, and never counted as the business\n'
  : `\n❌ verify:production-hygiene — ${failures} contract${failures === 1 ? '' : 's'} broken\n`)
process.exit(failures === 0 ? 0 : 1)
