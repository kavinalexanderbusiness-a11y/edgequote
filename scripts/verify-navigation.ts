// ── Verify: EdgeQuote reads as one business, not a pile of features ──────────
//   npm run verify:navigation
//
// WHY THIS SCRIPT EXISTS
// There are 31 routes under /dashboard and 15 modules in the registry. That gap
// is fine — most of those routes are analytics leaves behind the Grow hub — but
// it is only fine while every one of them is REACHABLE and while the primary
// nav stays a short, grouped list of the work an owner actually does.
//
// Three ways that decays, none of which tsc or a build will notice:
//   • a new page ships with no link from anywhere — a dead end you can only
//     reach by typing the URL (this is how /dashboard/labor-intelligence would
//     have rotted if it were not a redirect);
//   • a settings/admin page gets promoted into the primary nav because there was
//     nowhere else to put it (Service Templates sat beside Customers and Quotes
//     for exactly that reason, and Settings never even linked it);
//   • the sidebar stops rendering FROM the registry and grows a second hand-kept
//     list, so the nav, the Marketplace and the Modules manager disagree about
//     what exists and where it belongs.

import {
  FEATURE_MODULES, CATEGORY_ORDER, MODULE_CATEGORIES, visibleModules, moduleByKey, modulesForNavigation,
} from '../src/lib/modules'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

// ── 1. The registry is the one catalogue ─────────────────────────────────────
console.log('\n═══ One catalogue behind every surface ═══')

check('every module sits in a real category',
  FEATURE_MODULES.every(m => m.category in MODULE_CATEGORIES))
check('every category is in the render order',
  Object.keys(MODULE_CATEGORIES).every(c => CATEGORY_ORDER.includes(c as never)),
  'a category missing from CATEGORY_ORDER renders nowhere — its modules would silently vanish from the sidebar')
check('every category actually holds something',
  CATEGORY_ORDER.every(c => FEATURE_MODULES.some(m => m.category === c)),
  'an empty heading is a promise of features that do not exist')

// ⭐ Setup last. The whole point of the group is that plumbing you configure once
// must not carry the same weight as the work you do every morning.
eq('Setup is the last group', CATEGORY_ORDER[CATEGORY_ORDER.length - 1], 'admin')
eq('the API/webhooks module lives in Setup', moduleByKey('integrations')?.category, 'admin')
// A property is a customer's site, not an operations tool.
eq('properties sit with customers', moduleByKey('properties')?.category, 'customers')

// The sidebar must RENDER from the registry, grouped — not from a second list.
const sidebar = read('src/components/layout/Sidebar.tsx')
check('the sidebar renders from the registry',
  sidebar.includes('useModules') && sidebar.includes('CATEGORY_ORDER') && sidebar.includes('MODULE_CATEGORIES'),
  'a hand-kept nav list is how the sidebar, Marketplace and Modules manager start disagreeing')
check('home is rendered outside the groups',
  /filter\(m => m\.href === '\/dashboard'\)/.test(sidebar),
  'Dashboard is where you land, not a category member')

// ── 2. Primary nav is daily work only ────────────────────────────────────────
console.log('\n═══ Settings does not compete with the work ═══')

// Nothing under /dashboard/settings may appear in the primary nav BODY. (The
// footer's own Settings + Help links are the deliberate exception, and are
// matched exactly rather than by prefix.)
const navHrefs = [...sidebar.matchAll(/href="(\/dashboard[^"]*)"/g)].map(m => m[1])
const settingsInNav = navHrefs.filter(h => h.startsWith('/dashboard/settings/'))
check('no settings sub-page is promoted into the sidebar', settingsInNav.length === 0,
  `${settingsInNav.join(', ')} — a settings page in primary nav ranks admin beside daily work; link it from Settings instead`)

// …and having removed one, it must still be reachable from Settings.
const settings = read('src/app/dashboard/settings/page.tsx')
check('Settings links Service templates',
  settings.includes('/dashboard/settings/templates'),
  'removing it from the sidebar without a home in Settings would orphan the page')

// Moving a navigation door must not uninstall its module, remove it from search,
// or strand it when another optional module (Grow) is disabled.
const keys = (modules: ReturnType<typeof visibleModules>) => modules.map(m => m.key)
const enabled = visibleModules(null)
const enabledBefore = keys(enabled)
const advancedKeys = ['activity', 'automation', 'integrations']
const movedKeys = [...advancedKeys, 'sales']
eq('daily navigation omits only the four tools that now have another home',
  keys(modulesForNavigation(enabled, 'sidebar')), enabledBefore.filter(k => !movedKeys.includes(k)))
eq('Settings carries every enabled advanced tool',
  keys(modulesForNavigation(enabled, 'settings')), advancedKeys)
eq('Grow carries Sales reporting', keys(modulesForNavigation(enabled, 'grow')), ['sales'])
eq('grouping does not change the visible modules consumed by search', keys(enabled), enabledBefore)
eq('all four moved modules remain in the enabled list', keys(enabled).filter(k => movedKeys.includes(k)),
  ['activity', 'sales', 'automation', 'integrations'])
eq('disabling optional modules leaves only core navigation',
  keys(modulesForNavigation(visibleModules([]), 'sidebar')), FEATURE_MODULES.filter(m => m.core).map(m => m.key))
for (const home of ['settings', 'grow'] as const) {
  eq(`${home} does not display disabled modules`, keys(modulesForNavigation(visibleModules([]), home)), [])
}
eq('Advanced tools respects a partially enabled selection',
  keys(modulesForNavigation(visibleModules(['activity', 'integrations']), 'settings')), ['activity', 'integrations'])
check('Sales remains in the sidebar when Grow is off',
  modulesForNavigation(visibleModules(['sales', 'quotes', 'customers']), 'sidebar').some(m => m.key === 'sales'))
check('enabling Grow does not enable Sales reporting',
  !modulesForNavigation(visibleModules(['grow']), 'grow').some(m => m.key === 'sales'))
eq('Sales retains its real dependency on Quotes, with no new Grow dependency', moduleByKey('sales')?.requires, ['quotes'])
eq('Sales keeps its stable report route', moduleByKey('sales')?.href, '/dashboard/sales')
const commandPalette = read('src/components/command/CommandPalette.tsx')
check('command palette still builds navigation from the full enabled module list',
  commandPalette.includes('visible: moduleNav') && commandPalette.includes('moduleNav.map(') &&
  !commandPalette.includes('modulesForNavigation'))
const advanced = read('src/components/settings/AdvancedTools.tsx')
check('Settings exposes the Advanced tools tab and renders its destinations',
  settings.includes("key: 'advanced'") && settings.includes('<AdvancedTools />') &&
  advanced.includes("modulesForNavigation(visible, 'settings')") && advanced.includes('href={href}'))

// ── 3. No dead ends ──────────────────────────────────────────────────────────
// Every top-level /dashboard route must be reachable without typing a URL:
// from the registry (sidebar), a hub, the command palette, or as a redirect.
console.log('\n═══ Every page has a way in ═══')

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(p)) out.push(p)
  }
  return out
}
const allFiles = walk(SRC).map(p => ({ path: p.slice(SRC.length + 1).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }))

const DASH = join(SRC, 'app', 'dashboard')
const routes = readdirSync(DASH)
  .filter(e => statSync(join(DASH, e)).isDirectory() && !e.startsWith('[') && !e.startsWith('('))
check('the route scan found the app', routes.length > 20, `only ${routes.length} routes`)

const registryHrefs = new Set(FEATURE_MODULES.map(m => m.href))
const unreachable: string[] = []
for (const r of routes) {
  const href = `/dashboard/${r}`
  if (registryHrefs.has(href)) continue                                    // in the sidebar
  // A redirect stub exists to keep old links working — reachable by definition.
  const page = allFiles.find(f => f.path === `app/dashboard/${r}/page.tsx`)
  if (page && /redirect\(/.test(page.text) && page.text.length < 800) continue
  // Linked from anywhere else that is not itself.
  const linked = allFiles.some(f =>
    !f.path.startsWith(`app/dashboard/${r}/`) &&
    (f.text.includes(`"${href}"`) || f.text.includes(`'${href}'`) || f.text.includes(`${href}?`) || f.text.includes(`${href}#`)))
  if (!linked) unreachable.push(href)
}
check('no dashboard page is a dead end', unreachable.length === 0,
  `${unreachable.join(', ')} — reachable only by typing the URL. Link it from its hub, or delete it.`)

// The Grow hub is what keeps the sidebar short; it has to actually carry the
// analytics leaves that are not in the nav.
const grow = read('src/app/dashboard/grow/page.tsx')
check('Grow renders its enabled reporting destinations',
  grow.includes("modulesForNavigation(visible, 'grow')") && grow.includes('tools={[...reportingTools, ...LOOK]}'))
const GROW_LEAVES = ['intelligence', 'revenue-intelligence', 'profitability', 'saturation',
                     'neighbors', 'reactivation', 'review', 'reports', 'pricing-recovery', 'data-quality']
for (const leaf of GROW_LEAVES) {
  check(`Grow carries /${leaf}`, grow.includes(`/dashboard/${leaf}`),
    'it is not in the sidebar, so the hub is its only door')
}

// A page that lights up a sidebar item must be reachable from that item's hub —
// otherwise the nav highlights a section the page cannot be found in.
const sectionOf = [...sidebar.matchAll(/'(\/dashboard\/[a-z-/]+)':\s*'(\/dashboard\/[a-z-]+)'/g)]
check('the section map is populated', sectionOf.length >= 10)
for (const [, leaf, parent] of sectionOf) {
  const hub = parent === '/dashboard/grow' ? grow
    : parent === '/dashboard/schedule' ? read('src/app/dashboard/schedule/page.tsx')
    : null
  if (!hub) continue
  const linked = hub.includes(leaf) || allFiles.some(f => f.path.startsWith('components/') && f.text.includes(leaf))
  check(`${leaf} is reachable from ${parent}`, linked,
    'the sidebar highlights that hub while on this page, so the hub must be able to reach it')
}

// ── 4. Vocabulary ────────────────────────────────────────────────────────────
// The Grow hub speaks plainly ("Make more money", "Get more customers"). Two
// cards on it used to say "Business Intelligence" and "Revenue Intelligence" —
// software words on a screen otherwise written for a contractor.
console.log('\n═══ Plain service-business language ═══')
check('the Grow hub carries no "Intelligence" card titles',
  !/title="[^"]*Intelligence[^"]*"/.test(grow),
  'the hub\'s other headings are plain English; these two were not')

console.log('\n── Summary ────────────────────────────────────────────────────')
if (failures) {
  console.log(`\n❌ verify:navigation — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:navigation — grouped nav, no dead ends, settings out of the way\n')
