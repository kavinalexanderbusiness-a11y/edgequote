// ── Grow hub — hierarchy, capability and honesty — npm run verify:grow ──────
//
// Grow answers one question: "what should I do to get more work?" It used to
// answer it with 18 blocks under a 9-pill rail — an action feed, three feature
// cards, two analytics panels and TWELVE equal-weight tool cards in five groups.
// Everything the app can do about growth was on one screen at one size, so
// nothing was the next step.
//
// Simplifying a hub is easy to get wrong in two opposite ways, and this guard
// exists for both:
//   • losing capability — Grow is the ONLY door to these routes (they are not in
//     the sidebar registry), so a deleted card is a page nobody can reach
//   • losing the hierarchy again — one more "just add a card" and the catalogue
//     is back
//
// It also pins the correctness fix found during the pass: the two analytics
// loaders coerced every failed read to `[]`, so a network blip rendered as a
// confident "nobody needs attention".

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}
const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const PAGE = read('src/app/dashboard/grow/page.tsx')
const NAV = read('src/components/grow/GrowNav.tsx')
const HEALTH_LIB = read('src/lib/customerHealth.ts')
const HEALTH_UI = read('src/components/grow/CustomerHealthPanel.tsx')
const WL_LIB = read('src/lib/winLoss.ts')
const WL_UI = read('src/components/grow/WinLossPanel.tsx')

// ═══════════════════════════════════════════════════════════════════════════
H('1. ACTION BEFORE ANALYSIS')

{
  const feed = PAGE.indexOf('<SuggestionsCenter />')
  const goals = PAGE.indexOf('{GOALS.map(')
  const drawers = PAGE.indexOf('<Drawer')
  check('the action feed is on the page', feed > 0, true)
  check('it renders BEFORE the goal sections', feed < goals, true)
  check('…and before the disclosure drawers', feed < drawers, true)
  check('the goals render before the drawers', goals < drawers, true)
}

H('2. A FEW GOALS, NOT A CATALOGUE')
{
  // Three things an owner can DO about growth. Five "groups" was a drawer with
  // a heading on it.
  const titles = [...PAGE.matchAll(/title: '([^']+)',\s*\n\s*sub:/g)].map(m => m[1])
  check('exactly three goals', titles.length, 3)
  check('and they are the three that pay off',
    titles, ['Get more customers', 'Keep the customers you have', 'Charge what the work is worth'])
  // Rows, not cards: a card says "consider me", a row says "here it is".
  check('destinations render as rows, not equal-weight cards', /function ToolRow/.test(PAGE), true)
  check('the old five-group catalogue is gone', /const GROUPS/.test(PAGE), false)
  check('…and so is the big FeatureCard', /function FeatureCard/.test(PAGE), false)
}

H('3. NOTHING ON THE PAGE DUPLICATES THE RAIL ABOVE IT')
{
  // GrowNav is rendered by grow/layout.tsx above EVERY Grow surface, so a card
  // pointing at a pill is the same destination twice on one screen.
  const navHrefs = [...NAV.matchAll(/href: '(\/dashboard\/grow\/[^']+)'/g)].map(m => m[1])
  check('the rail still carries the marketing surfaces', navHrefs.length >= 8, true)
  const duped = navHrefs.filter(h => PAGE.includes(`'${h}'`))
  check('no Grow-page link repeats a rail pill', duped, [])
}

H('4. GROWTH FIRST — HOUSEKEEPING BEHIND DISCLOSURE')
{
  // These are useful, but they are not "what do I do to get more work".
  const drawerStart = PAGE.indexOf('const LOOK')
  for (const href of ['/dashboard/weather', '/dashboard/data-quality', '/dashboard/measurements', '/dashboard/reports']) {
    check(`${href} is behind disclosure, not on first paint`,
      PAGE.indexOf(`'${href}'`) > drawerStart, true)
  }
  // …while the acquisition/retention actions are NOT hidden.
  for (const href of ['/dashboard/neighbors', '/dashboard/saturation', '/dashboard/reactivation', '/dashboard/pricing-recovery']) {
    check(`${href} stays in a goal, not a drawer`,
      PAGE.indexOf(`'${href}'`) < drawerStart, true)
  }
  check('disclosure is native <details> (keyboard + SR for free)', /<details/.test(PAGE), true)
  check('the summary meets a 48px touch target', /min-h-\[48px\]/.test(PAGE), true)
}

H('5. CAPABILITY PRESERVED — Grow is the only door to these routes')
{
  // The whole risk of simplifying this page: these routes are NOT in the sidebar
  // registry, so if a link leaves the codebase the page becomes unreachable.
  // Every destination the old Grow offered must still be linked from SOMEWHERE.
  const SRC = join(ROOT, 'src')
  const files: { path: string; text: string }[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(tsx?|ts)$/.test(e.name)) files.push({ path: p.replace(/\\/g, '/'), text: readFileSync(p, 'utf8') })
    }
  }
  walk(SRC)

  const WAS_ON_GROW = [
    '/dashboard/pricing-recovery', '/dashboard/profitability', '/dashboard/saturation',
    '/dashboard/neighbors', '/dashboard/grow/studio', '/dashboard/grow/before-after',
    '/dashboard/reactivation', '/dashboard/review', '/dashboard/weather',
    '/dashboard/data-quality', '/dashboard/reports', '/dashboard/measurements',
    '/dashboard/intelligence', '/dashboard/revenue-intelligence', '/dashboard/grow/crm',
  ]
  const orphaned = WAS_ON_GROW.filter(href => !files.some(f =>
    !f.path.includes(`app${href}/`) && (f.text.includes(`'${href}'`) || f.text.includes(`"${href}"`))))
  check('every destination the old Grow offered is still reachable', orphaned, [])
}

H('6. PLAIN LANGUAGE, NOT SOFTWARE NAMES')
{
  const bi = read('src/app/dashboard/intelligence/page.tsx')
  const ri = read('src/app/dashboard/revenue-intelligence/page.tsx')
  check('the reports page is no longer titled "Business Intelligence"',
    /title="Business Intelligence"/.test(bi), false)
  check('…it says what it is', /title="How the business is doing"/.test(bi), true)
  check('the customer-ranking page is no longer titled "Revenue Intelligence"',
    /title="Revenue Intelligence"/.test(ri), false)
  check('…it says what it is', /title="Who to call next"/.test(ri), true)
  // Presentation only — the engines keep their names.
  check('the engines were NOT renamed for presentation',
    /businessIntelligence/.test(read('src/app/dashboard/intelligence/page.tsx')) ||
    /lib\/businessIntelligence/.test(bi), true)
  check('the Grow header talks about the job, not the software',
    /advisor|intelligence/i.test(PAGE.match(/description="([^"]*)"/)?.[1] ?? ''), false)
}

// ═══════════════════════════════════════════════════════════════════════════
H('7. A FAILED READ IS NOT AN ALL-CLEAR')
{
  // supabase-js RESOLVES with { data: null, error } on a dead connection. Both
  // loaders coerced that to `[]` and never inspected an error, so a blip scored
  // zero customers and the panel said nobody needed attention.
  check('customer health returns null (not []) when a load-bearing read failed',
    /Promise<HealthRow\[\] \| null>/.test(HEALTH_LIB), true)
  check('…and it actually inspects the errors',
    /if \(cRes\.error \|\| jRes\.error \|\| iRes\.error \|\| sRes\.error\) return null/.test(HEALTH_LIB), true)
  check('the panel distinguishes "couldn\'t check" from "all clear"',
    /Couldn’t check your customers just now/.test(HEALTH_UI), true)
  check('…and says it is not an all-clear', /not an all-clear/.test(HEALTH_UI), true)
  check('…with a way to retry', /onClick=\{load\}/.test(HEALTH_UI), true)

  check('win/loss returns null when the quotes read failed',
    /Promise<WinLossData \| null>/.test(WL_LIB), true)
  check('…and inspects the error', /if \(qRes\.error\) return null/.test(WL_LIB), true)
  check('the panel no longer vanishes silently on a failed read',
    /Couldn’t load your quote results just now/.test(WL_UI), true)
  // The enrichment reads stay tolerant on purpose — they degrade, they don't lie.
  check('enrichment reads keep the tolerant coercion', /\|\| \[\]/.test(HEALTH_LIB), true)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? '✅' : '❌'} grow: ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
