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
import { looksLikeFixture } from '../src/lib/growthEvidence'

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
  // ⭐ The adversarial half of the SELF_IDENTIFYING conjunction. Each of these
  // carries ONE of the two halves and must survive; a keyword rule would hide
  // a real electrician's and a real plumber's core service.
  'Light Fixture Installation', 'Fixture Repair', 'Plumbing Fixture Replacement',
  'Fixture Swap', 'Delete Me Later', 'Please Delete Me',
  // ⭐⭐ Session 114 — the names Growth's rival classifier used to hide. Its
  // `/^s\d{2,3}\s/` rule read a session-numbered ARTEFACT into any business whose
  // name simply starts that way, and "Demo Farms" is the canonical example of a
  // real customer whose name is a suspect WORD. Both are Tier 2 at most.
  'S61 Roofing Ltd', 'S22 Plumbing', 'S7 Electrical Co', 'Demo Farms', 'Demo Day Cleanup',
  // The intersection of the two protected shapes — a session-shaped token AND the
  // word fixture, but written the way a PERSON writes a name (spaced, not joined).
  'S61 Light Fixture Co',
  // ⭐ ANCHORING, for the zz+fixture shape. Mutation testing caught that nothing
  // here proved it: an unanchored version of that rule hid this name and every
  // check still passed.
  'Deck ZZ Fixture Mural', 'Restore ZZ Light Fixture',
  // ⭐ And the reserved-DOMAIN rule is about a domain, not the letters "example".
  // Widening it to a substring hid these, unnoticed, until a mutation said so.
  'Exampleton Property Care', 'jo@exampleton.ca', 'sales@examplestone.com',
  // ⛔⛔ Session 114 FOLLOW-UP AUDIT of the approved convergence. The zz-shape
  // rule checked `n.includes('fixture')` — anywhere in the WHOLE string, not
  // beside the zz-token — so any zz-branded business that merely mentions
  // "fixture" later in its name was wrongly excluded. Picking a name starting
  // with a letter early in the alphabet (so it lists first in a directory) is a
  // real small-business practice, and any of these could be a real lighting,
  // electrical or plumbing-fixture retailer. All four MUST survive; before the
  // fix, all four were classified as machine fixtures.
  'ZZ Lighting Fixture Supply', 'ZZ Electric Fixture & Supply Co',
  'ZZ Home Fixture Emporium', 'ZZ Modern Fixtures & Design',
  // ⛔⛔ The companion finding: the bare `s\d{1,3}[-_]fixture` shape was
  // justified by a comment claiming scripts/s61-field-cdp.mjs writes
  // "S61-FIXTURE". MEASURED: it does not. Every row that script names is
  // "ZZ-S61-FIXTURE" (see the zz- prefix test above) — no harness anywhere
  // writes a bare "S##-FIXTURE". The shape existed only to satisfy a
  // self-authored guard string with no real backing, and it was over-broad
  // enough to exclude a plausible mall-unit or store-numbered retailer. Removed
  // from lib/fixtureData; these must survive with no replacement rule needed.
  'S7-Fixture Gallery', 'S24-Fixture Supply', 'S3_Fixture Wholesale',
  'S61-Fixture Installations Inc',
]
for (const name of MUST_SURVIVE) {
  check(`“${name}” is NOT classified as fixture data`, !isFixtureName(name),
    'classifying this would silently remove a real customer or a real service from the owner’s book')
}
check('a blank or missing name is not evidence of anything',
  !isFixtureName('') && !isFixtureName(null) && !isFixtureName(undefined) && !isFixtureName('   '))
// ⭐ Anchoring is what makes MUST_SURVIVE possible. An `includes()` rule would
// classify "ZZ Top Tribute Band Venue Clean" and "Verify Home Inspections".
// ⭐⭐ The production case this rule was written for. `S61 FIELD FIXTURE — DELETE
// ME (A)` was a LIVE, ACTIVE technician counting toward capacity, and the
// anchored prefixes missed it entirely.
check('⭐⭐ a self-identifying fixture row is classified wherever the marker sits',
  isFixtureName('S61 FIELD FIXTURE — DELETE ME (A)')
  && isFixtureName('S61 FIELD FIXTURE - DELETE ME (B)')
  && isFixtureName('some fixture, delete me'),
  'this exact name was active in production and my anchored rule did not see it')
check('⛔ …and it needs BOTH halves, so neither word acts alone',
  !isFixtureName('Light Fixture Installation')
  && !isFixtureName('Fixture Repair')
  && !isFixtureName('Delete Me Later'),
  'a keyword rule here would hide a real electrician’s core service')
check('⭐ the prefixes are ANCHORED at the start, never substring-matched',
  !isFixtureName('Deck ZZ-Top Mural') && !isFixtureName('Please verify-check the meter')
  && isFixtureName('ZZ-anything'),
  'a substring rule hides real rows whose name merely contains a marker')

// ── 2b. ONE classifier, repo-wide ────────────────────────────────────────────
// ⭐⭐ Session 114. Main carried TWO fixture rules — this one and Growth's own
// `FIXTURE_MARKERS` — and they were not equivalent in EITHER direction. Growth
// classified on single words (hiding "Light Fixture Installation" and "S61
// Roofing Ltd") while having no `VERIFY-` rule at all (counting guard fixtures
// as real money). Divergence in production measured ZERO on the day, which is
// precisely why it was worth converging before a lighting or roofing tenant
// signed up rather than after.
console.log('\n═══ There is exactly ONE fixture classifier ═══')
{
  const growthRaw = read('src/lib/growthEvidence.ts')
  // ⚠️ Strip comments FIRST. The convergence note in that file explains what
  // `FIXTURE_MARKERS` was and why it went — so a raw grep reports the
  // documentation of the fix as the fix being undone. (This repo has now been
  // bitten by a self-matching comment three times; the stripper is asserted
  // alive below so it can never quietly match nothing.)
  check('the comment stripper is alive before it is trusted', stripperAlive(growthRaw))
  const growthSrc = strip(growthRaw)
  check('⛔ Growth no longer keeps a rival marker list',
    !/FIXTURE_MARKERS/.test(growthSrc),
    'a second fixture rule is back in growthEvidence — converge it on lib/fixtureData')
  check('…it delegates to the canonical rule instead',
    /isAnyFixtureName\(\.\.\.texts\)/.test(growthSrc) && /from '@\/lib\/fixtureData'/.test(growthSrc),
    'looksLikeFixture must BE the canonical rule, not a copy of it')

  // ⭐ Behavioural equivalence over the corpus, not a promise in a comment. Every
  // name this file already reasons about is run through BOTH doors; they must
  // agree on every one, because they are now the same function.
  const corpus = [
    ...MUST_SURVIVE,
    'ZZ-S70 Fixture', 'VERIFY-ADDONS-3391', 'ZZ-S61-FIXTURE CREW', 'ZZ S111 Fixture A',
    'S61 FIELD FIXTURE — DELETE ME (A)', 'Automated guard fixture — safe to delete',
    'bob@example.com', 'someone@realroofing.ca', '', '   ',
  ]
  const disagreements = corpus.filter(n => isFixtureName(n) !== looksLikeFixture(n))
  check('⭐ the two doors agree on every name in the corpus',
    disagreements.length === 0, `disagree on: ${disagreements.join(' · ')}`)

  // ⛔ The four the convergence was ordered to protect, asserted at THIS door too.
  for (const n of ['Light Fixture Installation', 'S61 Roofing Ltd', 'Demo Farms', 'ZZ Top Tribute Band Venue Clean']) {
    check(`“${n}” survives Growth's door as well`, !looksLikeFixture(n),
      'Growth would drop this business\'s own revenue out of its report')
  }
  // …and the real machine fixtures still classify at both.
  for (const n of ['ZZ-S61-FIXTURE CREW', 'ZZ S111 Fixture A', 'S61 FIELD FIXTURE — DELETE ME (A)', 'VERIFY-ADDONS-3391']) {
    check(`“${n}” is a fixture at both doors`, isFixtureName(n) && looksLikeFixture(n))
  }
}

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
// ⚠️ Re-expressed for the CURRENT shape: the report gained an OWNER-SESSION read
// path (least privilege — RLS keeps it to that tenant) beside the service-role
// one, so the old single-boolean spelling is gone. THE RULE IS UNCHANGED and is
// what is asserted: anonymous is not a read path, and the script exits rather
// than counting rows it could never have seen.
check('⛔ the cleanup report REFUSES to run with no authorized read path',
  /type AuthPath = 'owner' \| 'service_role' \| 'none'/.test(strip(REPORT))
  && /if \(authPath === 'none'\) \{[\s\S]{0,1200}?process\.exit\(3\)/.test(strip(REPORT)),
  'an empty RLS-filtered read must never print as “nothing to clean up”')
check('⛔ …and a FAILED owner sign-in also refuses, instead of falling back to anon',
  /signInWithPassword[\s\S]{0,600}?if \(authErr \|\| !session\?\.user\) \{[\s\S]{0,600}?process\.exit\(3\)/.test(strip(REPORT)),
  'a sign-in that silently failed would leave an anonymous client behind and every zero would be the false all-clear again')
// ⭐ Asserted over what the script PRINTS, not over where a secret is mentioned.
// The password is necessarily named once — it is passed to signInWithPassword.
// What must never happen is a secret reaching an output line.
const printed = [...strip(REPORT).matchAll(/\b(?:line|console\.log|console\.error)\(([\s\S]*?)\)\n/g)].map(m => m[1])
check('the printed-output extractor found the report’s real output lines',
  printed.length >= 15, `found ${printed.length}`)
// ⚠️ The rule is about the VALUE, not the NAME. The report legitimately tells an
// operator which environment variable to set — that string is help text, and a
// rule that forbade it would push the script toward being unhelpful about its own
// requirements. What must never happen is a secret being INTERPOLATED into
// output, so only `${…}` expressions are inspected.
const SECRETS = /\b(ownerPassword|ownerEmail|serviceKey|anonKey|key)\b/
const interpolated = printed.flatMap(p => [...p.matchAll(/\$\{([^}]*)\}/g)].map(m => m[1]))
check('⛔ no credential is ever INTERPOLATED into output — only an identity suffix',
  interpolated.every(x => !SECRETS.test(x)) && /slice\(-6\)/.test(strip(REPORT)),
  `offending: ${interpolated.filter(x => SECRETS.test(x)).join(' · ')} — credentials are used, never echoed`)
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
// ⭐⭐ TWO LIVES. In flight the migration is its own file under
// supabase/migrations/; once production has run it the file moves to
// supabase/archive/ledger/ and the baseline carries its effect. Read whichever
// exists, and assert the STATE — the boundary is on the apply path — rather than
// the statement, which inverts the day the migration succeeds.
const ARCHIVE = 'supabase/archive/ledger'
const pubMigration = readdirSync(join(process.cwd(), MIGRATIONS)).find(f => f.includes('service_publication'))
const pubArchived = readdirSync(join(process.cwd(), ARCHIVE)).find(f => f.includes('service_publication'))
const PUBSQL = pubMigration ? read(join(MIGRATIONS, pubMigration))
  : pubArchived ? read(join(ARCHIVE, pubArchived)) : ''

check('the publication boundary is on the APPLY PATH',
  PUBSQL.length > 1000
  && (!!pubMigration || /where user_id = v_user and is_active and published_at is not null/.test(BASELINE)),
  pubMigration
    ? 'supabase/archive is not the apply path — a migration there never runs'
    : 'the migration is archived, so the BASELINE must carry the gated doors')
check('⭐ book_service’s hardcoded trade fallback is replaced by a configured one',
  /coalesce\(v_service, v_fallback_service\)/.test(PUBSQL)
  && /from public\.service_templates[\s\S]{0,200}?published_at is not null[\s\S]{0,120}?order by sort_order/.test(PUBSQL),
  'one function serves every tenant; “Lawn Mowing” was stamped on a window cleaner’s quote')
check('…falling back to a neutral noun only when the catalogue offers nothing',
  /coalesce\(v_fallback_service, ''Service''\)|coalesce\(v_fallback_service, 'Service'\)/.test(PUBSQL))
check('…and it PROVES the trade word is gone before committing',
  /position\('Lawn Mowing' in v_src\) > 0 then[\s\S]{0,120}?raise exception/.test(PUBSQL))
// ⭐⭐ RETIRED DELIBERATELY, as the original note instructed. This read the
// baseline for the DEFECT — `coalesce(v_service,'Lawn Mowing')` — to prove the
// fix was not written for a problem nobody had. Production has now run the
// migration and the baseline was regenerated FROM production, so the hardcoded
// trade is gone and the old assertion could only fail. The two dishonest ways to
// get it green would be reverting the baseline or deleting the question.
//
// The question survives, asked of the artefact that keeps history: the archived
// ledger records the transform refusing to commit unless the trade word was
// gone, which is only meaningful if it was there. The other half asserts the
// converged state — the trade word is now absent from what actually ships.
check('⭐ the defect was real: the archived ledger records removing a hardcoded trade',
  /position\('Lawn Mowing' in v_src\)/.test(PUBSQL)
  && /'coalesce\(v_service,''Lawn Mowing''\)'/.test(PUBSQL),
  'the archived migration is the permanent record that one tenant’s trade was stamped on every tenant’s quote')
check('…and the shipped baseline no longer stamps a trade on anyone',
  !/coalesce\(v_service,'Lawn Mowing'\)/.test(BASELINE)
  && /coalesce\(v_service, v_fallback_service\)/.test(BASELINE),
  'the converged state the retired check was waiting for: configuration, not a hardcoded word')

console.log('\n── Summary ────────────────────────────────────────────────────')
console.log(failures === 0
  ? '\n✅ verify:production-hygiene — test data is classified only when a machine wrote it, flagged when a human might have, and never counted as the business\n'
  : `\n❌ verify:production-hygiene — ${failures} contract${failures === 1 ? '' : 's'} broken\n`)
process.exit(failures === 0 ? 0 : 1)
