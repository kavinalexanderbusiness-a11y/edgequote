// ── Verify: the navigation stays small, layered, and whole ───────────────────
//   npm run verify:information-architecture
//
// Session 112 cut the resting sidebar from nineteen rows to eight by giving the
// registry a presentation tier: primary modules always render, `secondary` ones
// wait one click behind their group heading. That trade is only honest while
// three things stay true, none of which tsc can see:
//
//   • the PRIMARY set stays small — if tiers drift until twelve modules are
//     primary again, the disclosure is decoration;
//   • every secondary module is still REACHABLE — rendered by the same sidebar
//     when its group opens, found by ⌘K, listed in the Marketplace. Tier is
//     resting visibility, never access control;
//   • the group holding the CURRENT page can never be collapsed away — the nav
//     must always answer "where am I".
//
// It also pins the Schedule↔Dispatch weld (two lenses on the same day, which
// had ZERO links either way before S112) and the redirects that keep retired
// routes' bookmarks alive.

import { FEATURE_MODULES } from '../src/lib/modules'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// ── 1. The tier system itself ────────────────────────────────────────────────
console.log('\n═══ Primary stays small; secondary stays reachable ═══')

const primary = FEATURE_MODULES.filter(m => m.tier !== 'secondary')
const secondary = FEATURE_MODULES.filter(m => m.tier === 'secondary')

check(`primary tier is at most 8 modules (now ${primary.length})`, primary.length <= 8,
  `${primary.map(m => m.key).join(', ')} — the whole point of the tier is a short resting nav; ` +
  'promote something only by demoting something else, or the disclosure becomes decoration')

// The daily eight, by name — a rename or accidental demotion of a daily surface
// should be a decision, not a drive-by.
const DAILY = ['dashboard', 'inbox', 'schedule', 'customers', 'messages', 'quotes', 'invoices', 'grow']
for (const k of DAILY) {
  const m = FEATURE_MODULES.find(x => x.key === k)
  check(`${k} is primary`, !!m && m.tier !== 'secondary',
    'a surface an owner opens daily fell behind a disclosure — if deliberate, update DAILY here with the reasoning')
}

check("tier is only ever 'secondary' or absent",
  FEATURE_MODULES.every(m => m.tier === undefined || m.tier === 'secondary'),
  'a third tier value would render nowhere — the sidebar only knows primary and secondary')

// No duplicate destinations: two registry entries sharing an href is how the
// sidebar grows two identical rows that go to the same page.
const hrefs = FEATURE_MODULES.map(m => m.href)
const keys = FEATURE_MODULES.map(m => m.key)
check('no duplicate module hrefs', new Set(hrefs).size === hrefs.length,
  hrefs.filter((h, i) => hrefs.indexOf(h) !== i).join(', '))
check('no duplicate module keys', new Set(keys).size === keys.length,
  keys.filter((k, i) => keys.indexOf(k) !== i).join(', '))

// ── 2. The sidebar renders BOTH tiers from the registry ──────────────────────
console.log('\n═══ Tier is resting visibility, not access control ═══')

const sidebar = read('src/components/layout/Sidebar.tsx')

check('the sidebar splits tiers from the registry, not a second list',
  sidebar.includes("tier !== 'secondary'") && sidebar.includes("tier === 'secondary'"),
  'the primary/secondary split must read m.tier off the registry rows the sidebar already maps')
check('secondary modules render through the SAME navLink as primary ones',
  /primary\.map\(m => navLink\(m, onNavigate\)\)/.test(sidebar) &&
  /secondary\.map\(m => navLink\(m, onNavigate\)\)/.test(sidebar),
  'two renderers is how active states, badges and hit areas start disagreeing between tiers')
check('the group holding the current page is forced open',
  sidebar.includes('activeSecondaryGroup') && /activeSecondaryGroup === cat/.test(sidebar),
  'collapsing the group you are standing in makes the nav claim you are nowhere')
check('group state persists per owner',
  sidebar.includes("localStorage.getItem('eq-nav-open')") && sidebar.includes("localStorage.setItem('eq-nav-open'"),
  'without persistence every page load re-collapses the groups an owner works from')
check('the disclosure is a real button with a11y state',
  sidebar.includes('aria-expanded={open}') && sidebar.includes('aria-controls={`nav-group-${cat}`}'),
  'a div-with-onClick heading is invisible to keyboards and screen readers')

// ── 3. The Schedule↔Dispatch weld ────────────────────────────────────────────
console.log('\n═══ Two lenses on the same day, linked both ways ═══')

const schedule = read('src/app/dashboard/schedule/page.tsx')
const dispatch = read('src/app/dashboard/dispatch/page.tsx')

check('Schedule day view offers the crew board, carrying the day',
  /\/dashboard\/dispatch\?d=\$\{dayISO\}/.test(schedule),
  'the crew board is the day seen by WHO — without this link it is a separate universe again')
check('…and only when the Dispatch module is enabled',
  /dispatchEnabled\s*&&/.test(schedule) && /key === 'dispatch'/.test(schedule),
  'a business that uninstalled Dispatch must not be offered a door into it')
check('Dispatch crumbs back to Schedule, carrying the day',
  /crumb=\{\{ label: 'Schedule', href: `\/dashboard\/schedule\?d=\$\{date\}` \}\}/.test(dispatch),
  'the weld is two-way or it is a funnel, not a weld')
check('Dispatch accepts the day it was handed (?d=)',
  /URLSearchParams\(window\.location\.search\)\.get\('d'\)/.test(dispatch),
  'handing the day across only works if the receiving side reads it')

// ── 4. Retired routes keep their bookmarks ───────────────────────────────────
console.log('\n═══ Old links still land somewhere real ═══')

for (const [route, target] of [
  ['labor-intelligence', '/dashboard/intelligence'],
  ['marketplace', '/dashboard/settings#modules'],
] as const) {
  const page = read(`src/app/dashboard/${route}/page.tsx`)
  check(`/dashboard/${route} redirects to ${target}`,
    page.includes('redirect(') && page.includes(target),
    'people bookmark pages; a retired route must forward, not 404')
}

console.log('\n── Summary ────────────────────────────────────────────────────')
if (failures) {
  console.log(`\n❌ verify:information-architecture — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:information-architecture — eight doors, everything one click away, welds intact\n')
