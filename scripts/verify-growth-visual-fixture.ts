// ── Verify: the Growth visual fixture exercises what it claims to ────────────
//   npx tsx scripts/verify-growth-visual-fixture.ts
//
// The browser proof (scripts/growth-visual-fixture-cdp.mjs) can only show what
// the fixture's rows make the REAL engine produce. This guard pins that: the
// synthetic book must yield a material multi-customer concentration, a
// genuinely refused figure, the two long-name shapes and the audited score —
// through `computeRevenueIntel`, not through hand-written report objects. If
// the engine or the rows drift so that a scene silently disappears, this fails
// before anyone opens a browser.
//
// ⛔ FIXTURE DATA ONLY. No database, no build, no browser.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildFixture, ANCHOR, UNBROKEN, THIN, SLIPPING, AUDITED_SCORE } from '../src/app/dev/growth-visual-fixture/fixtureData'
import { concentrationNote } from '../src/lib/growthConcentration'
import { SEASON_VISITS } from '../src/lib/pricing'
import { formatCurrency } from '../src/lib/utils'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, c: boolean, d = '') => (c ? ok(n) : fail(n, d))
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const { report, feedback } = buildFixture()
const { summary, opportunities, ltvForecast } = report
const opp = (key: string) => opportunities.find(o => o.key === key)

console.log('\n── 1. CONCENTRATION — real threshold, several contributors, the long spaced name ──')
{
  const c = summary.concentration
  check('the book is materially concentrated', !!c && c.material, JSON.stringify(c))
  check('…across more than two contributors (the sentence with "across N customers")', !!c && c.contributorCount >= 3, String(c?.contributorCount))
  eq('…and the dominant customer is the anchor', c?.topCustomerId, ANCHOR.id)
  const note = c ? concentrationNote(c, formatCurrency) : null
  check('the rendered sentence names the anchor and the customer count',
    !!note && note.includes(ANCHOR.name) && /across \d+ customers/.test(note), String(note))
  check('the anchor name is long and spaced (≥40 chars, must wrap)', ANCHOR.name.length >= 40 && /\s/.test(ANCHOR.name), ANCHOR.name)
}

console.log('\n── 2. THE ENGINE, NOT A HAND-BUILT REPORT ──')
{
  const a = opp(`renewal:${ANCHOR.id}`)
  eq('the anchor renewal is $1,900 × the declared bi-weekly season, exactly', a?.expectedValue, 1900 * SEASON_VISITS.biweekly)
  const u = opp(`renewal:${UNBROKEN.id}`)
  eq('the unbroken-name renewal is $70 × the declared weekly season, exactly', u?.expectedValue, 70 * SEASON_VISITS.weekly)
  check('no synthetic name trips the fixture classifier (nothing excluded as a fixture)',
    opportunities.every(o => !o.evidence.excluded.some(x => x.reason === 'fixture')), '')
}

console.log('\n── 3. UNQUANTIFIED — the gate refuses a figure it cannot support ──')
{
  const t = opp(`renewal:${THIN.id}`)
  check('the two-visit customer gets a card', !!t, '')
  eq('…with no figure', t?.expectedValue, 0)
  eq('…because the evidence is insufficient', t?.evidence.strength, 'insufficient')
  check('the headline caveat renders (quantified AND unquantified both > 0)', summary.quantified >= 2 && summary.unquantified >= 1,
    JSON.stringify({ q: summary.quantified, u: summary.unquantified }))
}

console.log('\n── 4. THE AUDITED SCORE AND THE UNBROKEN NAME ──')
{
  const u = opp(`renewal:${UNBROKEN.id}`)
  eq(`one card scores exactly ${AUDITED_SCORE} (55 base + 6 for 3+ visits)`, u?.score, AUDITED_SCORE)
  check('the unbroken name has no break opportunity (no whitespace, no hyphen) and is ≥40 chars',
    UNBROKEN.name.length >= 40 && !/[\s-]/.test(UNBROKEN.name), UNBROKEN.name)
  check('a top action exists with a positive figure and a 0-100 score',
    !!summary.topAction && summary.topAction.expectedValue > 0 && Number.isInteger(summary.topAction.score) && summary.topAction.score >= 0 && summary.topAction.score <= 100, '')
}

console.log('\n── 5. RECORDED DECISIONS AND CHURN ──')
{
  const won = Object.values(feedback).find(f => f.status === 'won')
  const acted = Object.values(feedback).find(f => f.status === 'acted')
  check('one won and one acted decision, both for cards that exist', !!won && !!acted && !!opp(won.opportunity_key) && !!opp(acted.opportunity_key), JSON.stringify(Object.keys(feedback)))
  eq('the won row\'s result_value is the forecast (the seam the label fix was about)', won?.result_value, opp(won?.opportunity_key ?? '')?.expectedValue)
  const slipping = ltvForecast.find(f => f.customerId === SLIPPING.id)
  check('the slipping customer carries a high churn risk with money at stake', !!slipping && slipping.churnRisk === 'high' && slipping.churnRiskImpact > 0, JSON.stringify(slipping))
}

console.log('\n── 6. THE ROUTE STAYS LOCKED AND RENDERS THE SHIPPING VIEW ──')
{
  const ROOT = process.cwd()
  const page = readFileSync(join(ROOT, 'src/app/dev/growth-visual-fixture/page.tsx'), 'utf8')
  const fixture = readFileSync(join(ROOT, 'src/app/dev/growth-visual-fixture/GrowthVisualFixture.tsx'), 'utf8')
  // ⛔ Security-relevant, so asserted structurally: a production build must
  // 404 this route, and every other environment must too unless the process
  // was started with the flag.
  check('the route refuses a production build', /process\.env\.NODE_ENV === 'production'\) notFound\(\)/.test(page), '')
  check('…and refuses without GROWTH_VISUAL_FIXTURE=1', /process\.env\.GROWTH_VISUAL_FIXTURE !== '1'\) notFound\(\)/.test(page), '')
  // ⭐ The point of the fixture: the SHIPPING view, not a lookalike.
  check('the fixture renders RevenueIntelligenceView from the dashboard folder',
    /from '@\/app\/dashboard\/revenue-intelligence\/RevenueIntelligenceView'/.test(fixture) && /<RevenueIntelligenceView\b/.test(fixture), '')
  check('…and imports no data client', !/supabase|createClient|clientCache/.test(fixture), '')
}

console.log(failures === 0 ? '\n✅ growth visual fixture: all checks passed\n' : `\n❌ ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
