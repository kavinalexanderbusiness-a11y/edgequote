/**
 * verify-analytics — the analytics workspace's layout rules.
 *
 * lib/analytics/layout.ts is deliberately pure and framework-free so these rules
 * can be asserted instead of trusted. They are worth asserting because they are
 * the ones that fail SILENTLY in production: a saved layout is invisible state,
 * so a widget that never appears looks identical to a widget nobody wanted.
 *
 * This verifier makes NO claim about any metric's value — layout cannot change
 * what a number means, only whether and where it is shown. Metric correctness is
 * the engines' business (businessIntelligence, campaignStats), not this file's.
 *
 * Run: npx tsx scripts/verify-analytics.ts
 */
import { readFileSync } from 'node:fs'
import {
  WIDGETS, DEFAULT_LAYOUT, normalizeLayout, visibleWidgets,
  reorder, step, canStep, toggleHidden, isCustomised,
  type WidgetId, type AnalyticsLayout,
} from '../src/lib/analytics/layout'

let failures = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { console.log(`  ✅ ${name}`) }
  else { failures++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`) }
}

console.log('\n── registry ──')
const ids = WIDGETS.map(w => w.id)
check('every widget id is unique', new Set(ids).size === ids.length,
  `duplicates: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`)
check('every widget has a title and a blurb', WIDGETS.every(w => !!w.title && !!w.blurb))
check('DEFAULT_LAYOUT covers the whole registry', DEFAULT_LAYOUT.order.length === WIDGETS.length)
check('DEFAULT_LAYOUT hides nothing', DEFAULT_LAYOUT.hidden.length === 0)
check("'marketing' is registered", ids.includes('marketing' as WidgetId))
// NOTE: an earlier version of this file asserted `marketing` was LAST. That was a
// snapshot, not an invariant — the comms widget was later appended after it, quite
// correctly, and the assertion failed a CHANGE THAT WAS RIGHT. A test that cries
// wolf on correct work is worse than no test, because the next person learns to
// ignore it. The rule actually worth pinning is the one below: a widget appended
// to the registry must reach existing users' saved layouts, whichever widget it is.

console.log('\n── normalizeLayout: the forward-compatibility rules ──')
// THE regression this guards: someone saved a layout before a widget existed.
// Parameterised over the NEWEST widget (last in the registry) rather than a
// hardcoded id, so this keeps testing the rule as widgets are added.
const newest = ids[ids.length - 1]
const oldSaved: unknown = { order: ids.filter(i => i !== newest), hidden: [] }
const migrated = normalizeLayout(oldSaved)
check(`a layout saved before '${newest}' shipped GAINS it`,
  migrated.order.includes(newest),
  'a widget missing from a saved order must be appended, or it is invisible forever')
check('...and it lands at the end, not the start',
  migrated.order[migrated.order.length - 1] === newest)
check('...and nothing else is reordered by the migration',
  migrated.order.slice(0, -1).join() === ids.filter(i => i !== newest).join())
// Stronger form: EVERY widget must survive being absent from a saved layout.
check('every widget is recoverable from a layout that predates it',
  ids.every(id => normalizeLayout({ order: ids.filter(i => i !== id), hidden: [] }).order.includes(id)))

check('unknown ids are dropped (renamed/removed widgets leave no ghost)',
  !normalizeLayout({ order: ['executive', 'a-widget-that-was-deleted'], hidden: [] }).order.includes('a-widget-that-was-deleted' as WidgetId))
check('duplicate ids are collapsed (a widget never renders twice)',
  normalizeLayout({ order: ['executive', 'executive', 'financial'], hidden: [] })
    .order.filter(i => i === 'executive').length === 1)
check('garbage in → complete layout out (null)', normalizeLayout(null).order.length === WIDGETS.length)
check('garbage in → complete layout out (wrong shape)',
  normalizeLayout({ order: 'not-an-array', hidden: 42 }).order.length === WIDGETS.length)
check('hidden survives normalize', normalizeLayout({ order: ids, hidden: ['sales'] }).hidden.includes('sales' as WidgetId))
check('unknown hidden ids are dropped',
  !normalizeLayout({ order: ids, hidden: ['ghost'] }).hidden.includes('ghost' as WidgetId))

console.log('\n── visibility + ordering ──')
const base: AnalyticsLayout = normalizeLayout(null)
check('everything is visible by default', visibleWidgets(base).length === WIDGETS.length)
check('a hidden widget disappears from visible',
  !visibleWidgets(toggleHidden(base, 'sales')).some(w => w.id === 'sales'))
check('toggleHidden is its own inverse',
  visibleWidgets(toggleHidden(toggleHidden(base, 'sales'), 'sales')).length === WIDGETS.length)
check('reorder moves a widget to the target position',
  reorder(base.order, newest, 'executive')[0] === newest)
check('reorder onto itself is a no-op', reorder(base.order, 'sales', 'sales').join() === base.order.join())
check('reorder with an unknown id is a no-op',
  reorder(base.order, 'ghost' as WidgetId, 'sales').join() === base.order.join())

console.log('\n── step: the keyboard/touch path (drag alone is unusable on a phone) ──')
check('step down moves one place', step(base, 'executive', 1).order[1] === 'executive')
check('step up at the top is a no-op', step(base, 'executive', -1).order.join() === base.order.join())
check('step down at the bottom is a no-op', step(base, newest, 1).order.join() === base.order.join())
check('canStep agrees with step at the top', canStep(base, 'executive', -1) === false)
check('canStep agrees with step in the middle', canStep(base, 'financial', -1) === true)
// Stepping OVER a hidden widget must not look like nothing happened.
const withHidden = toggleHidden(base, 'financial') // financial sits at index 1
const stepped = step(withHidden, 'executive', 1)
check('step skips PAST a hidden widget rather than appearing to do nothing',
  stepped.order.indexOf('executive') > stepped.order.indexOf('financial'),
  'executive must land beyond the hidden financial, or the button looks broken')

console.log('\n── isCustomised (drives Save/Reset) ──')
check('a default layout is not customised', isCustomised(base) === false)
check('hiding one widget counts as customised', isCustomised(toggleHidden(base, 'sales')) === true)
check('reordering counts as customised',
  isCustomised({ ...base, order: step(base, 'executive', 1).order }) === true)
check('a round trip back to default is NOT customised',
  isCustomised(normalizeLayout({ order: DEFAULT_LAYOUT.order, hidden: [] })) === false)


// ═══════════════════════════════════════════════════════════════════════════
// FINANCIAL TRUTH — two wiring guards, deliberately NOT unit tests.
//
// Both defects these cover were invisible to a unit test, because in both cases
// the ENGINE was already right and the CALLER was wrong. So these assert the
// wiring: which column a document reads, and whether a screen says what its
// number rests on. Hand-built rows can never catch either.
console.log('\n── financial truth: no document may read the fabricated subtotal ──')
{
  // `quotes.subtotal` is `generated always as (hours * crew_size * rate)` — the
  // exact fabrication RUN-2026-07-16e removed from `quotes.total` after it priced
  // real customer work. It was removed from `total` and left alive as a FALLBACK in
  // two customer-facing document paths and one owner screen. On the live book it
  // disagrees with initial_price on 84 of 93 quotes and is non-zero on 61.
  const files = [
    'src/components/quotes/QuotePDF.tsx',
    'src/lib/portalPdf.ts',
    'src/app/dashboard/quotes/[id]/page.tsx',
  ]
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    // Strip comments: these files now DOCUMENT the trap by name, and prose about a
    // column must never fail a check about reading it.
    const code = src.split('\n').filter(l => {
      const t = l.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*'))
    }).join('\n')
    check(`${f} does not fall back to the legacy quotes.subtotal`,
      !/\?\?\s*\w*\.?\bsubtotal\b/.test(code) && !/\bq(uote)?\.subtotal\b/.test(code),
      'a document is reading hours × crew_size × rate as a price')
  }
  // And the portal mapper must not merely stop preferring it — it must not name it.
  const portal = readFileSync('src/lib/portalPdf.ts', 'utf8')
  const mapping = portal.match(/subtotal:\s*num\([^)]*\)/)?.[0] ?? ''
  check('portalPdf maps subtotal from the real price, not the legacy column',
    mapping.includes('initial_price') && !mapping.includes('q.subtotal'), mapping || '(not found)')
}

console.log('\n── financial truth: a modelled profit may not present as measured ──')
{
  // grossProfitYTD's cost side is minutes × crew rate, and laborMinOf resolves
  // minutes as actual || estimated || a 45-minute constant. Measured on the live
  // book: 35 of 71 YTD jobs (49%) had observed time. The figure was labelled
  // "Gross profit YTD" with no qualifier.
  const bi = readFileSync('src/lib/businessIntelligence.ts', 'utf8')
  check('businessIntelligence reports the labour basis behind gross profit',
    /laborBasis:\s*\{\s*observedJobs/.test(bi), 'the caller cannot tell modelled from measured')
  check('…counted from actual_minutes, mirroring laborMinOf\'s own first branch',
    /if \(Number\(j\.actual_minutes\)\) observedJobs\+\+; else assumedJobs\+\+/.test(bi))
  check('a year\'s profit carries whether its labour was assumed',
    /profitEstimated: yrRoutes\.some\(r => !r\.hasLaborData\)/.test(bi),
    'reuses the profit engine\'s existing hasLaborData rather than a new signal')

  // The wiring half: the surface must actually USE the basis.
  const page = readFileSync('src/app/dashboard/intelligence/page.tsx', 'utf8')
  check('the Intelligence page labels gross profit as an estimate when it is one',
    /laborBasis/.test(page) && /Gross profit YTD \(est\.\)/.test(page),
    'the basis is computed but the screen still claims a measured figure')
  check('…and says how much of it was timed',
    /jobs timed/.test(page))
  check('the yearly profit stat is labelled from profitEstimated',
    /profitEstimated \? 'Profit this year \(est\.\)'/.test(page))
  // The number itself must NOT have moved — this lane repairs claims, not arithmetic.
  check('gross profit arithmetic is untouched (still revenue − minutes × crew rate)',
    /const cost = \(lm \/ 60\) \* crewCost/.test(bi) && /grossProfit \+= p/.test(bi))
}

console.log(failures === 0
  ? '\n✅ analytics layout verified\n'
  : `\n❌ ${failures} analytics check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
