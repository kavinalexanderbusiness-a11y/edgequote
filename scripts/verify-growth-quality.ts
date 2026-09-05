// ── Verify: the Growth advisor only claims what its evidence supports ────────
//   npm run verify:growth-quality
//
// WHY THIS SCRIPT EXISTS
// A production audit found Growth presenting ~$98,000/year of "recurring
// opportunity". The arithmetic was fine. The EVIDENCE was not:
//
//   • `visitsPerSeason(null)` returned SEASON_VISITS.biweekly, so a cadence the
//     owner never declared was silently annualized as fortnightly. 68.6% of
//     customers with completed visits (35/51 on the real book) went through
//     that path; 28 of them alone accounted for $138,144.
//   • Four of six predictors valued a customer at `ltv / completedCount` — a
//     MEAN over a set that counted unpriced visits as $0. Book-wide that mean is
//     $276 against a median of $70, because one visit sits 89.9× above the middle.
//   • 32 customers have exactly ONE completed visit, and ×14 turned it into a year.
//   • An add-on was billed 4×/year or 1× according to a REGEX ON ITS NAME.
//
// None of that is expressible in the type system: a mean and a median are both
// numbers, `0` and "unknown" are both numbers, and a service-name regex
// type-checks perfectly. So it is asserted here, against the REAL engine.
//
// ⛔ FIXTURE DATA ONLY. This guard never touches a database.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  assessEvidence, declaredCadence, robustPerVisit, looksLikeFixture, exclusionForPriceState,
  median, quantile, skewNote, annualize, evidenceSummary, insufficientReason,
  mayShowAnnual, mayShowPerVisit, INSUFFICIENT_LABEL, EXCLUSION_COPY,
  MIN_VISITS_FOR_VALUE, MIN_VISITS_FOR_CONFIDENT,
  type Evidence,
} from '../src/lib/growthEvidence'
import { computeRevenueIntel } from '../src/lib/revenueIntelligence'
import { jobPriceState, jobAmountOrNull, type PriceState } from '../src/lib/pricingState'
import { SEASON_VISITS } from '../src/lib/pricing'
import { DEFAULT_SEASONS } from '../src/lib/seasons'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, c: boolean, d = '') => (c ? ok(n) : fail(n, d))
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
/** ⚠️ `[^\n\r]*` not `[^\n]*` — `.` does not match `\r`, so on a CRLF checkout a
 *  line-comment stripper walks straight past the line ending and leaves the
 *  comment body in the "stripped" text. The rules below are about what the CODE
 *  does, and the code is surrounded by comments that necessarily NAME the things
 *  it must not do. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n\r]*/g, ' ')
const SRC = {
  evidence: read('src/lib/growthEvidence.ts'),
  engine: read('src/lib/revenueIntelligence.ts'),
  page: read('src/app/dashboard/revenue-intelligence/page.tsx'),
}
const CODE = Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, strip(v)])) as Record<keyof typeof SRC, string>

const vps = (c: 'weekly' | 'biweekly' | 'monthly') => SEASON_VISITS[c]

/**
 * One candidate record, in the shape the gate now takes: a CANONICAL verdict
 * from lib/pricingState plus the amount it resolved to.
 *   n > 0  → priced
 *   n = 0  → no_charge (the owner declared it free)
 *   null   → unpriced (nobody recorded anything)
 * ⭐ §1 below proves this mapping against the REAL jobPriceState rather than
 * trusting it, so the fixtures cannot drift away from the engine they stand in for.
 */
const visit = (v: number | null, extra: Partial<{ completed: boolean; labels: (string | null | undefined)[] }> = {}) => ({
  priceState: (v == null ? 'unpriced' : v > 0 ? 'priced' : 'no_charge') as PriceState,
  amount: v,
  completed: true, ...extra,
})

console.log('\n── 1. ⭐⭐ UNPRICED ≠ NO-CHARGE ≠ A PRICE ──')
{
  // ⭐⭐ ONE ENGINE. growthEvidence no longer decides this — lib/pricingState
  // does, and these assertions run the REAL jobPriceState so the gate and the
  // rest of the product cannot answer "is this priced?" differently.
  const declaredFree = { price: null, no_charge_at: '2026-08-01T00:00:00Z', no_charge_reason: 'Goodwill — storm damage', no_charge_by: 'owner-uuid' }
  eq('a declared no-charge is NO_CHARGE, not unpriced', jobPriceState(declaredFree, null, null), 'no_charge')
  eq('…and resolves to a KNOWN zero, not an unknown', jobAmountOrNull(declaredFree, null, null), 0)
  eq('a job with nothing recorded is UNPRICED', jobPriceState({ price: null }, null, null), 'unpriced')
  eq('…and its amount is UNKNOWN, never 0', jobAmountOrNull({ price: null }, null, null), null)
  eq('a real price is PRICED', jobPriceState({ price: 70 }, null, null), 'priced')

  // ⛔ The half-declared row the CHECK constraint refuses: a date with no reason
  // is not an accountable write-off, so it must NOT read as free work.
  eq('a half-declared no-charge is not a no-charge',
    jobPriceState({ price: null, no_charge_at: '2026-08-01T00:00:00Z' }, null, null), 'unpriced')

  // The gate maps those verdicts to owner-facing exclusion reasons, and refuses
  // to invent a third opinion about prices.
  eq('no_charge is excluded, and named as such', exclusionForPriceState('no_charge'), 'no_charge')
  eq('unpriced is excluded, and named as such', exclusionForPriceState('unpriced'), 'unpriced')
  eq('priced is not an exclusion at all', exclusionForPriceState('priced'), null)
  check('growthEvidence no longer decides price state itself',
    !/function priceEvidence/.test(CODE.evidence) && !/zero_price/.test(CODE.evidence),
    'the seam is closed: lib/pricingState owns this question')
  check('and the engine feeds it the canonical verdict',
    /jobPriceState\(/.test(CODE.engine) && /jobAmountOrNull\(/.test(CODE.engine), '')
  // ⭐⭐ THE COLUMNS MUST ACTUALLY BE SELECTED. Without them `isNoCharge()` is
  // always false, every declared write-off silently reads as "no price
  // recorded", and nothing fails — the distinction just quietly stops existing.
  // Mutation testing caught this: deleting them from the query broke nothing.
  for (const col of ['no_charge_at', 'no_charge_reason', 'no_charge_by']) {
    check(`the jobs query selects ${col}`,
      new RegExp(`from\\('jobs'\\)[\\s\\S]{0,400}${col}`).test(CODE.engine),
      'a column that is never selected cannot be reasoned about')
  }

  // ⛔ AN INCONSISTENT INPUT MUST NOT BECOME A ZERO IN THE SAMPLE.
  // `priced` with a null amount should be impossible, but "impossible" is what a
  // future caller bug looks like from in here — and `Number(null) || 0` is one
  // keystroke away. Asserted with the malformed record the belt-and-braces
  // clause exists for, so the clause is reachable rather than decorative.
  const malformed = assessEvidence({
    visits: [visit(70), visit(70), visit(70), { priceState: 'priced' as PriceState, amount: null, completed: true }],
    declaredFreq: 'weekly', visitsPerSeason: vps,
  })
  eq('a priced record with no amount is excluded, not counted as $0', malformed.sampleSize, 3)
  eq('…and reported as unpriced, which is what it actually is',
    malformed.excluded.find(x => x.reason === 'unpriced')?.count, 1)
  eq('so the statistic is untouched by it', malformed.perVisit, 70)

  const e = assessEvidence({ visits: [visit(70), visit(80), visit(90), visit(null), visit(0)], declaredFreq: 'weekly', visitsPerSeason: vps })
  eq('unpriced and no-charge visits are BOTH excluded from the statistic', e.sampleSize, 3)
  const reasons = e.excluded.map(x => x.reason).sort()
  // ⭐ Separately, and by their REAL names. Both earn nothing, but one is a gap
  // in the record and the other is the owner's accountable decision.
  eq('and both are reported, separately', reasons, ['no_charge', 'unpriced'])
  eq('the no-charge exclusion credits the paperwork', EXCLUSION_COPY.no_charge, 'recorded as no charge')
  check('the median is taken over the priced visits only', e.perVisit === 80, String(e.perVisit))
  // ⭐ The failure this prevents: 5 visits, 2 of them valueless → a mean of
  // $240/5 = $48, which is BELOW every price the customer has ever paid.
  check('an unpriced visit never drags the figure toward zero', (e.perVisit as number) > 48, String(e.perVisit))
}

console.log('\n── 2. ⭐⭐ A CADENCE IS DECLARED, NEVER INFERRED ──')
{
  eq('a declared weekly cadence resolves', declaredCadence('weekly'), 'weekly')
  eq('null does not', declaredCadence(null), null)
  eq('and neither does anything else', declaredCadence('sometimes'), null)
  // ⛔ THE FALLBACK MULTIPLIER IS GONE.
  eq('an undeclared cadence annualizes to NOTHING', annualize(70, null, 14), null)
  eq('a declared one annualizes exactly', annualize(70, 'weekly', SEASON_VISITS.weekly)?.annual, 70 * 28)

  const undeclared = assessEvidence({ visits: [visit(70), visit(70), visit(70)], declaredFreq: null, visitsPerSeason: vps })
  eq('with no cadence there is a per-visit figure…', undeclared.perVisit, 70)
  eq('…and NO annual one', undeclared.annual, null)
  check('so an annual figure may not be displayed', !mayShowAnnual(undeclared), '')
  check('but the per-visit one may', mayShowPerVisit(undeclared), '')

  const declared = assessEvidence({ visits: [visit(70), visit(70), visit(70)], declaredFreq: 'biweekly', visitsPerSeason: vps })
  eq('with a declared cadence the annual figure appears', declared.annual, 70 * SEASON_VISITS.biweekly)
  eq('and names the cadence it assumed', declared.annualization?.cadence, 'biweekly')

  // ⛔ NO SERVICE-NAME CADENCE INFERENCE ANYWHERE IN THE MONEY PATH.
  const NAME_CADENCE = [
    /isRecurringProgramService/,
    /\bmow\b/i, /grass\s*cut/i, /lawn\s*care/i, /fertiliz/i, /weed\s*control/i, /bed\s*maintenance/i,
    /appsPerYear/,
  ]
  for (const rx of NAME_CADENCE) {
    check(`the engine derives no cadence from a name (${rx.source.slice(0, 26)})`,
      !rx.test(CODE.engine), 'a NAME IS NOT A CADENCE')
  }
  check('the evidence gate reads no service name at all',
    !/\bmow|lawn|snow|fertiliz/i.test(CODE.evidence), '')
  // The specific constant that used to be the universal fallback.
  check('no default season-length constant survives in the engine',
    !/SEASON_VISITS_BIWEEKLY\s*=/.test(CODE.engine),
    'a constant named "the default season length" invites annualizing what has not earned it')
  check('visitsPerSeason can return null',
    /function visitsPerSeason\([^)]*\):\s*number\s*\|\s*null/.test(CODE.engine), '')
  // ⚠️ The SIGNATURE is not the behaviour. Mutation testing put
  // `return c ? SEASON_VISITS[c] : SEASON_VISITS.biweekly` back and the
  // signature check stayed green. Assert the FALLBACK ARM is null.
  const vpsBody = CODE.engine.slice(CODE.engine.indexOf('function visitsPerSeason'))
  check('…and its undeclared arm returns null, not a default season',
    /return c \? SEASON_VISITS\[c\] : null/.test(vpsBody.slice(0, 220)),
    vpsBody.slice(0, 200))
  check('no SEASON_VISITS fallback survives anywhere in the engine',
    !/:\s*SEASON_VISITS\.\w+/.test(CODE.engine) && !/\?\?\s*SEASON_VISITS/.test(CODE.engine),
    'a default multiplier is how an unearned year gets claimed')
}

console.log('\n── 3. ⭐⭐ ONE-OFF WORK IS NEVER ANNUALIZED ──')
{
  const single = assessEvidence({ visits: [visit(500)], declaredFreq: null, visitsPerSeason: vps })
  eq('a single visit yields NO figure at all', single.strength, 'insufficient')
  eq('not a per-visit one', single.perVisit, null)
  eq('and not an annual one', single.annual, null)
  check(`the minimum sample is ${MIN_VISITS_FOR_VALUE}`, MIN_VISITS_FOR_VALUE === 3, String(MIN_VISITS_FOR_VALUE))

  // ⭐ Even a big single visit. $6,295 × 14 = $88,130 — nearly the entire
  // headline, from ONE job.
  const bigSingle = assessEvidence({ visits: [visit(6295)], declaredFreq: null, visitsPerSeason: vps })
  eq('a LARGE single visit is still insufficient', bigSingle.strength, 'insufficient')
  eq('and produces no annual claim', bigSingle.annual, null)

  // And a single visit does not become annualizable merely by having a cadence.
  const singleDeclared = assessEvidence({ visits: [visit(500)], declaredFreq: 'weekly', visitsPerSeason: vps })
  eq('a declared cadence does not rescue a sample of one', singleDeclared.annual, null)

  // ⭐⭐ TWO IS ALSO TOO FEW, AND THE REASON IS ARITHMETIC.
  // The median of two points IS their mean, so at n=2 the robustness this whole
  // module rests on does not exist. Driving the REAL book proved it costs real
  // money: one customer with exactly two $4,098 visits contributed $86,058 of a
  // $109,130 headline through `$4,098 × 14 bi-weekly visits`.
  eq('the median of two points is just their mean', median([70, 6295]), 3182.5)
  const two = assessEvidence({ visits: [visit(4098), visit(4098)], declaredFreq: 'biweekly', visitsPerSeason: vps })
  eq('so a sample of two is refused', two.strength, 'insufficient')
  eq('and cannot annualize into a five-figure claim', two.annual, null)
  const three = assessEvidence({ visits: [visit(70), visit(70), visit(6295)], declaredFreq: 'biweekly', visitsPerSeason: vps })
  eq('at three, one outlier can no longer move the middle', three.perVisit, 70)
}

console.log('\n── 4. ⭐⭐ NO SINGLE VISIT MAY DOMINATE ──')
{
  // The real distribution's shape, in miniature: two ordinary visits and one
  // 90× outlier — exactly what `ltv / completedCount` could not survive.
  const vals = [70, 70, 6295]
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  eq('the robust statistic is the median', robustPerVisit(vals), 70)
  check('which is NOT the mean', Math.round(mean) === 2145, String(mean))
  check('the outlier moves the figure by nothing', robustPerVisit([70, 70, 6295]) === robustPerVisit([70, 70, 700]),
    'a median must be insensitive to how extreme an outlier is')

  const e = assessEvidence({ visits: vals.map(v => visit(v)), declaredFreq: 'biweekly', visitsPerSeason: vps })
  eq('so the annual figure is built from the median', e.annual, 70 * SEASON_VISITS.biweekly)
  check('and the spread is DISCLOSED rather than hidden', !!e.skew && /90×/.test(e.skew as string), String(e.skew))

  // ⭐⭐ AND THE RULE THAT WAS MEASURED BEFORE BEING WRITTEN. A median+5·MAD cut
  // lands at $170 on the real book and would discard 21 of 103 priced visits.
  // The statistic is the fix; mass exclusion is not.
  const many = [16, 40, 55, 55, 70, 70, 70, 100, 100, 180, 470, 3474]
  const kept = assessEvidence({ visits: many.map(v => visit(v)), declaredFreq: null, visitsPerSeason: vps })
  eq('ordinary larger jobs are NOT discarded as outliers', kept.sampleSize, many.length)
  check('no exclusion reason is "outlier"', !kept.excluded.some(x => x.reason === 'outlier'),
    JSON.stringify(kept.excluded))
  eq('the statistic still reads the middle', kept.perVisit, Math.round(median(many) as number))
  // ⚠️ This started life as `… && !x === false || true`, which is a tautology —
  // a check that can never fail is worse than no check, because it reads as
  // coverage. Assert the real thing: neither module culls records by spread.
  check('neither module culls records by a MAD/std-dev rule',
    !/\bMAD\b/.test(CODE.engine) && !/\bMAD\b/.test(CODE.evidence)
    && !/stdDev|standardDeviation/.test(CODE.evidence),
    'a spread-based cut discards ordinary large jobs; the robust STATISTIC is the fix')
  check("the 'outlier' exclusion reason exists but is never applied",
    /outlier/.test(SRC.evidence) && !/drop\(['"]outlier['"]\)/.test(CODE.evidence),
    'it is reserved and documented, not silently used')
}

console.log('\n── 5. Fixture / test records are refused — and narrowly ──')
{
  // ⭐⭐ RE-EXPRESSED (Session 114) — this section now describes ONE classifier.
  // `looksLikeFixture` used to keep its own marker list; it now delegates to
  // lib/fixtureData, and two of the assertions here were encoding the very
  // over-breadth that made converging necessary. Both are inverted below, with
  // the reason, rather than deleted:
  //
  //   'S61 Field Home'      was asserted CAUGHT by /^s\d{2,3}\s/. That pattern
  //                         cannot tell it from "S61 Roofing Ltd" — and measured
  //                         across the whole repo, "S61 Field Home" is written by
  //                         NO harness. It appeared only in this assertion. It is
  //                         the name of the S61 FEATURE, not of a fixture row, so
  //                         catching it was always wrong and nothing real is lost.
  //
  //   'Test Customer Record' was asserted CAUGHT by a (test|demo|sample)+(data|
  //                         record|…) pair. That is Tier 2 in the canonical rule:
  //                         test-LOOKING data is flagged for a human, never acted
  //                         on. "Demo Farms" and "Soil Testing" are real money.
  check('an explicit fixture marker is caught', looksLikeFixture('ZZ S111 Fixture A'), '')
  check('a delete-me marker is caught', looksLikeFixture('S61 FIELD FIXTURE — DELETE ME'), '')
  // ⚠️⚠️ RE-MEASURED (Session 114 follow-up audit). This asserted
  // 'S61-FIXTURE CREW' (no zz- prefix) as the "harness-joined token". Re-checked
  // against the actual harness: scripts/s61-field-cdp.mjs and s61-field-proof.mjs
  // NEVER write a bare "S61-FIXTURE" — every row they name is "ZZ-S61-FIXTURE",
  // with the zz- prefix. The bare form was fictional, and the rule built to catch
  // it (a bare `s\d+-fixture` shape) was over-broad enough to classify a
  // plausible real business ("S61-Fixture Installations Inc"). The shape is
  // removed from lib/fixtureData; this now asserts the string a harness actually
  // writes, which is ALSO already caught by the pre-existing 'zz-' prefix alone.
  check('a harness-joined token is caught', looksLikeFixture('ZZ-S61-FIXTURE CREW'), '')
  // ⭐ COVERAGE THIS FILE'S OLD RULE DID NOT HAVE. Growth had no VERIFY- rule, so
  // guard fixtures tagged that way were counted as real money by the one report
  // built to exclude them. Converging fixed a narrowness, not only a breadth.
  check('a VERIFY- guard fixture is caught (it was NOT, before convergence)',
    looksLikeFixture('VERIFY-ADDONS-3391'), '')
  check('a reserved documentation address is caught', looksLikeFixture('bob@example.com'), '')
  // ⛔⛔ AND THE OTHER HALF, WHICH MATTERS AS MUCH: excluding a REAL customer's
  // revenue is as much a trust failure as including a fixture's.
  check('a real business with "Test" in its name is NOT excluded', !looksLikeFixture('Test Valley Landscaping'), '')
  check('a real surname is NOT excluded', !looksLikeFixture('Sample & Sons Roofing'), '')
  check('an ordinary name is NOT excluded', !looksLikeFixture('Edge Property Services'), '')
  check('an empty label is not a fixture', !looksLikeFixture(null, undefined, ''), '')
  // ⛔ The four names the convergence was ordered to protect.
  check('an electrician\'s real service is NOT excluded', !looksLikeFixture('Light Fixture Installation'), '')
  check('a roofer named for a session number is NOT excluded', !looksLikeFixture('S61 Roofing Ltd'), '')
  check('a customer called Demo Farms is NOT excluded', !looksLikeFixture('Demo Farms'), '')
  check('a ZZ-prefixed real business is NOT excluded', !looksLikeFixture('ZZ Top Tribute Band Venue Clean'), '')
  // ⛔⛔ FOUND BY THE FOLLOW-UP AUDIT (Session 114): the zz-shape rule used to
  // check `n.includes('fixture')` — anywhere in the WHOLE string — not just
  // beside the zz-token. A zz-branded electrical/lighting retailer (picking a
  // name starting with a letter early in the alphabet for directory listing is
  // a real small-business practice) would have had its real revenue silently
  // excluded. Tightened to require "fixture" beside the zz-token specifically;
  // these four must all survive.
  check('a zz-branded lighting retailer is NOT excluded', !looksLikeFixture('ZZ Lighting Fixture Supply'), '')
  check('a zz-branded electrical supplier is NOT excluded', !looksLikeFixture('ZZ Electric Fixture & Supply Co'), '')
  check('a zz-branded fixture emporium is NOT excluded', !looksLikeFixture('ZZ Home Fixture Emporium'), '')
  check('a zz-branded fixture design shop is NOT excluded', !looksLikeFixture('ZZ Modern Fixtures & Design'), '')
  // ⛔ And the bare-S## direction: a plausible store/unit-numbered retailer.
  check('a unit-numbered fixture retailer is NOT excluded', !looksLikeFixture('S7-Fixture Gallery'), '')
  check('a store-numbered fixture supplier is NOT excluded', !looksLikeFixture('S24-Fixture Supply'), '')

  const e = assessEvidence({
    visits: [visit(70), visit(70), visit(70), visit(9000, { labels: ['ZZ S111 Fixture A', 'Snow'] })],
    declaredFreq: 'weekly', visitsPerSeason: vps,
  })
  eq('a fixture visit is excluded from the sample', e.sampleSize, 3)
  eq('and reported as such', e.excluded.find(x => x.reason === 'fixture')?.count, 1)
  eq('so it cannot move the figure', e.perVisit, 70)
}

console.log('\n── 6. ⭐⭐ WEAK EVIDENCE SHOWS A SENTENCE, NOT A DOLLAR ──')
{
  const none = assessEvidence({ visits: [], declaredFreq: 'weekly', visitsPerSeason: vps })
  eq('no records at all → insufficient', none.strength, 'insufficient')
  check('and no figure is displayable', !mayShowAnnual(none) && !mayShowPerVisit(none), '')
  eq('the label is the one sentence', INSUFFICIENT_LABEL, 'Not enough reliable data')
  check('the reason is specific, not a shrug', /No completed, priced visits/.test(insufficientReason(none)),
    insufficientReason(none))

  const allUnpriced = assessEvidence({ visits: [visit(null), visit(null)], declaredFreq: 'weekly', visitsPerSeason: vps })
  check('"every visit was unpriced" is said in those words',
    /no price recorded/.test(insufficientReason(allUnpriced)), insufficientReason(allUnpriced))

  const thin = assessEvidence({ visits: [visit(70), visit(70), visit(70)], declaredFreq: 'weekly', visitsPerSeason: vps })
  eq('three priced visits are PROVISIONAL, not confident', thin.strength, 'provisional')
  const solid = assessEvidence({ visits: [visit(70), visit(70), visit(70), visit(70), visit(70)], declaredFreq: 'weekly', visitsPerSeason: vps })
  eq(`${MIN_VISITS_FOR_CONFIDENT} are confident`, solid.strength, 'confident')

  // ⛔ The UI must render the sentence, and must not print a confident $0.
  // ⚠️ An IMPORT is not a RENDER — the same trap twice in two sessions. Assert
  // the identifier appears inside JSX braces, not merely in the import list.
  check('the page RENDERS the insufficient label', /\{INSUFFICIENT_LABEL\}/.test(CODE.page), '')
  // ⚠️ And this one is unreachable by construction — `assessEvidence` already
  // returns `annual: null` whenever strength is insufficient — so no input can
  // prove the guard clause present. Defence-in-depth has to be asserted
  // structurally or not at all.
  // ⚠️ Anchored to the function itself, not a byte-slice around it: a 220-char
  // window ran past the closing brace into mayShowPerVisit, which contains the
  // very same clause — so the check answered a question about its NEIGHBOUR and
  // stayed green through the mutation. Two near-identical functions is exactly
  // where a windowed source assertion goes wrong.
  check('mayShowAnnual refuses insufficient evidence in its own right',
    /export function mayShowAnnual\([^)]*\)[^{]*\{\s*return e\.strength !== 'insufficient'/.test(CODE.evidence),
    'the belt as well as the braces: a later refactor may make this reachable')
  check('and mayShowPerVisit does the same',
    /export function mayShowPerVisit\([^)]*\)[^{]*\{\s*return e\.strength !== 'insufficient'/.test(CODE.evidence), '')
  check('the money figure is CONDITIONAL on the value being positive',
    /o\.expectedValue\s*>\s*0\s*\?/.test(CODE.page),
    'an unconditional +$0/yr reads as "this customer is worth nothing"')
}

console.log('\n── 7. ⭐ THE TRANSPARENCY CONTRACT ──')
{
  const e = assessEvidence({
    visits: [visit(70), visit(70), visit(100), visit(null), visit(0)],
    declaredFreq: 'biweekly', visitsPerSeason: vps,
  })
  const s = evidenceSummary(e)
  check('the summary states the record count', /3 visits/.test(s), s)
  check('…names the statistic rather than assuming "average"', /median visit value/.test(s), s)
  check('…shows the annualization formula in full', /\$70 × 14 bi-weekly visits/.test(s), s)
  check('…and discloses every exclusion with its reason',
    /2 excluded/.test(s) && /no price recorded/.test(s) && /recorded as no charge/.test(s), s)
  eq('the cadence assumption is machine-readable too', e.annualization?.visitsPerSeason, SEASON_VISITS.biweekly)

  // No fake precision: the formula must be the actual numbers used.
  check('the formula multiplies the stated statistic by the stated visit count',
    (e.perVisit as number) * (e.annualization?.visitsPerSeason as number) === e.annual, `${e.perVisit} × ${e.annualization?.visitsPerSeason} ≠ ${e.annual}`)

  check('every exclusion reason has owner-facing copy',
    Object.values(EXCLUSION_COPY).every(v => typeof v === 'string' && v.length > 3), '')
  // ⚠️ Rendered, not imported. Emptying the <p> left the import in place and this
  // check green until mutation testing said otherwise.
  check('the page RENDERS the evidence summary',
    /\{evidenceSummary\(o\.evidence\)\}/.test(CODE.page),
    'the owner must be able to see what a figure is based on')
  check('and the spread caveat when the sample is skewed',
    /\{o\.evidence\.skew/.test(CODE.page), '')
  check('and the reason when there is no figure',
    /\{insufficientReason\(o\.evidence\)\}/.test(CODE.page), '')
}

console.log('\n── 8. The REAL engine, end to end ──')
{
  const today = '2026-08-28'
  const q = { id: 'q1', total: 70, initial_price: 70, weekly_price: 70, biweekly_price: 70, monthly_price: 70 }
  const mk = (id: string, cust: string, date: string, price: number | null, rec: string | null = null, svc = 'Service') => ({
    id, scheduled_date: date, status: 'completed', service_type: svc, quote_id: null, recurrence_id: rec,
    duration_minutes: 60, actual_minutes: null, price, lat: null, lng: null, city: null, postal_code: null,
    neighborhood: null, customer_id: cust,
  })
  const jobs = [
    // A — declared weekly, four priced visits. The one customer who has earned a figure.
    mk('a1', 'A', '2026-08-01', 70, 'r1'), mk('a2', 'A', '2026-08-08', 70, 'r1'),
    mk('a3', 'A', '2026-08-15', 70, 'r1'), mk('a4', 'A', '2026-08-22', 70, 'r1'),
    // …plus a future booking. The renewal card requires a LIVE series (the
    // engine's own long-standing gate), so without this the fixture tests the
    // evidence rules against a customer the renewal predictor never looks at.
    { ...mk('a5', 'A', '2026-09-05', 70, 'r1'), status: 'scheduled' },
    // B — three visits, NO recurrence. Must never be annualized.
    mk('b1', 'B', '2026-08-02', 90), mk('b2', 'B', '2026-08-09', 90), mk('b3', 'B', '2026-08-16', 90),
    // C — one enormous visit, nothing else. The $88k-from-one-job case.
    mk('c1', 'C', '2026-08-05', 6295),
    // D — a fixture customer with real-looking money.
    mk('d1', 'D', '2026-08-05', 4000), mk('d2', 'D', '2026-08-12', 4000), mk('d3', 'D', '2026-08-19', 4000),
    // E — unpriced work only.
    mk('e1', 'E', '2026-08-06', null), mk('e2', 'E', '2026-08-13', null),
  ]
  const customers = [
    { id: 'A', name: 'Aster Grounds', created_at: '2024-01-01', referred_by_customer_id: null },
    { id: 'B', name: 'Birch Holdings', created_at: '2024-01-01', referred_by_customer_id: null },
    { id: 'C', name: 'Cedar Ltd', created_at: '2024-01-01', referred_by_customer_id: null },
    { id: 'D', name: 'ZZ S111 Fixture A', created_at: '2024-01-01', referred_by_customer_id: null },
    { id: 'E', name: 'Elm Estates', created_at: '2024-01-01', referred_by_customer_id: null },
  ]
  const recurrences = { r1: { freq: 'weekly', interval_unit: 'week', interval_count: 1 } }
  const report = computeRevenueIntel({
    jobs, pctx: { quotesById: { q1: q } as never, recById: recurrences, base: null, today },
    customers, properties: [], recurrences, invoices: [], lineItems: [], jobCustomerById: {},
    seasons: DEFAULT_SEASONS, capacityHours: 8, preferredDays: [1, 2, 3, 4, 5], today,
  })
  const byCust = (c: string) => report.opportunities.filter(o => o.customerId === c)

  const a = byCust('A').find(o => o.kind === 'renewal')
  check('A (declared weekly, 4 priced visits) gets a renewal figure', !!a && a.expectedValue > 0, JSON.stringify(a?.expectedValue))
  eq('…and it is the MEDIAN × the DECLARED season', a?.expectedValue, 70 * SEASON_VISITS.weekly)
  eq('…with the formula attached', a?.evidence.annualization?.formula, `$70 × ${SEASON_VISITS.weekly} weekly visits`)

  for (const o of byCust('B')) {
    check(`B (no declared cadence) carries no annual figure — ${o.kind}`, o.expectedValue === 0,
      `${o.kind} claimed $${o.expectedValue}`)
  }
  for (const o of byCust('C')) {
    check(`C (one $6,295 visit) is never annualized — ${o.kind}`, o.expectedValue === 0,
      `${o.kind} claimed $${o.expectedValue}`)
  }
  for (const o of byCust('E')) {
    check(`E (unpriced work only) claims nothing — ${o.kind}`, o.expectedValue === 0,
      `${o.kind} claimed $${o.expectedValue}`)
  }
  const d = byCust('D')
  check('D (fixture-named) contributes no money to any recommendation',
    d.every(o => o.expectedValue === 0), JSON.stringify(d.map(o => [o.kind, o.expectedValue])))

  // ⭐⭐ THE HEADLINE. Only customer A has evidence, so only A may reach it —
  // asserted as "every other customer contributes exactly nothing" rather than
  // by matching a total, which would pass just as well if the wrong customer
  // contributed the right number. (A legitimately contributes twice: a renewal
  // at the full annual figure and a referral at half of it.)
  const contribution = (c: string) => byCust(c).reduce((s, o) => s + o.expectedValue, 0)
  for (const c of ['B', 'C', 'D', 'E']) {
    eq(`${c} contributes $0 to the headline`, contribution(c), 0)
  }
  eq('the headline is exactly what A earned', report.summary.totalOpportunity, contribution('A'))
  check('and A earned it from the declared season, not a default',
    contribution('A') === 70 * SEASON_VISITS.weekly + Math.round(70 * SEASON_VISITS.weekly * 0.5),
    String(contribution('A')))
  check('the summary says how many recommendations went unquantified',
    report.summary.unquantified > 0 && report.summary.quantified >= 1,
    JSON.stringify({ q: report.summary.quantified, u: report.summary.unquantified }))
  check('the top action is a QUANTIFIED one',
    !report.summary.topAction || report.summary.topAction.expectedValue > 0,
    JSON.stringify(report.summary.topAction?.expectedValue))

  // ⚠️ The check above passes trivially while ANY quantified opportunity exists,
  // because rankValue is expectedValue × weights and an unquantified one is 0 —
  // so it always sorts last. Mutation testing put `topAction: ranked[0]` back and
  // nothing went red. The case that actually distinguishes them is a book with
  // NOTHING quantifiable: then ranked[0] IS unquantified, and a revenue screen
  // must headline nothing rather than headline a blank figure.
  const weakOnly = computeRevenueIntel({
    jobs: jobs.filter(j => j.customer_id !== 'A'),
    pctx: { quotesById: { q1: q } as never, recById: recurrences, base: null, today },
    customers: customers.filter(c => c.id !== 'A'),
    properties: [], recurrences, invoices: [], lineItems: [], jobCustomerById: {},
    seasons: DEFAULT_SEASONS, capacityHours: 8, preferredDays: [1, 2, 3, 4, 5], today,
  })
  check('a book with nothing quantifiable still produces recommendations',
    weakOnly.opportunities.length > 0, 'the ACTIONS are still good advice')
  eq('…but its headline is zero', weakOnly.summary.totalOpportunity, 0)
  eq('…and it headlines NO top action at all', weakOnly.summary.topAction, null)
  eq('…and says every one of them went unquantified', weakOnly.summary.quantified, 0)
  check('every opportunity carries its evidence',
    report.opportunities.every(o => o.evidence && typeof o.evidence.sampleSize === 'number'), '')

  // ⛔ The specific number that started this: nothing may be annualized at 14
  // without a declaration. C alone would have been $6,295 × 14 = $88,130.
  const wouldHaveBeen = 6295 * SEASON_VISITS.biweekly
  check(`no figure resembles the old one-visit annualization ($${wouldHaveBeen.toLocaleString()})`,
    !report.opportunities.some(o => o.expectedValue >= wouldHaveBeen * 0.9), '')
}

console.log('\n── 9. Quantiles, honestly ──')
{
  eq('the median of an even sample interpolates', median([10, 20, 30, 40]), 25)
  eq('a quantile of one value is that value', quantile([42], 0.9), 42)
  eq('an empty sample has no median', median([]), null)
  eq('and no robust figure', robustPerVisit([]), null)
  eq('negatives and zeros are not prices', robustPerVisit([0, -5]), null)
  eq('no skew note without enough sample', skewNote([70, 6295]), null)
  eq('nor when the sample is tight', skewNote([70, 72, 75]), null)
}

console.log(`\n${failures === 0 ? '✅ growth quality: all checks passed' : `❌ ${failures} check(s) failed`}\n`)
process.exit(failures === 0 ? 0 : 1)
