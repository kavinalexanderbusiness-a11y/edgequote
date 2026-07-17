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
// The marketing widget is the reason this verifier exists: it was appended last so
// that new users and users with a saved layout see it in the SAME place.
check("'marketing' is registered", ids.includes('marketing' as WidgetId))
check("'marketing' is LAST in the registry", ids[ids.length - 1] === 'marketing',
  `last is '${ids[ids.length - 1]}' — normalizeLayout appends unseen ids to the end, so anything else puts marketing mid-page for new users and last for existing ones`)

console.log('\n── normalizeLayout: the forward-compatibility rules ──')
// THE regression this guards: someone saved a layout before Marketing existed.
const oldSaved: unknown = { order: ids.filter(i => i !== 'marketing'), hidden: [] }
const migrated = normalizeLayout(oldSaved)
check('a layout saved before a new widget shipped GAINS that widget',
  migrated.order.includes('marketing' as WidgetId),
  'a widget missing from a saved order must be appended, or it is invisible forever')
check('...and it lands at the end, not the start',
  migrated.order[migrated.order.length - 1] === 'marketing')
check('...and nothing else is reordered by the migration',
  migrated.order.slice(0, -1).join() === ids.filter(i => i !== 'marketing').join())

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
  reorder(base.order, 'marketing', 'executive')[0] === 'marketing')
check('reorder onto itself is a no-op', reorder(base.order, 'sales', 'sales').join() === base.order.join())
check('reorder with an unknown id is a no-op',
  reorder(base.order, 'ghost' as WidgetId, 'sales').join() === base.order.join())

console.log('\n── step: the keyboard/touch path (drag alone is unusable on a phone) ──')
check('step down moves one place', step(base, 'executive', 1).order[1] === 'executive')
check('step up at the top is a no-op', step(base, 'executive', -1).order.join() === base.order.join())
check('step down at the bottom is a no-op', step(base, 'marketing', 1).order.join() === base.order.join())
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

console.log(failures === 0
  ? '\n✅ analytics layout verified\n'
  : `\n❌ ${failures} analytics check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
