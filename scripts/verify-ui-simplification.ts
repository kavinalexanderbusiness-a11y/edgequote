// ── Verify: the simplification pass stays simplified ─────────────────────────
//   npm run verify:ui-simplification
//
// Session 112's surface work, pinned so it cannot quietly rot:
//
//   • the product says EdgeHQ everywhere a person reads (106 files said
//     EdgeQuote — the LOGIN SCREEN said EdgeQuote — while production answered
//     on app.edgehq.ca);
//   • every module page opens with the shared PageHeader anatomy, with a short
//     allowlist of pages whose different header is a decision, not drift;
//   • Settings' ten tabs stay clustered by owner question, with their keys
//     frozen (hash links, bookmarks, and every in-app #door depend on them);
//   • the Edit Service form's folded sections stay optional — a `required`
//     field inside a collapsed section is a submit that fails invisibly;
//   • the two view switchers this session raised to 40px stay raised
//     (.tap-target is pointer:coarse-gated and does nothing at narrow desktop
//     widths — the height must be explicit).

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

// ── 1. One product name ──────────────────────────────────────────────────────
console.log('\n═══ The product is called EdgeHQ ═══')

// Wire identifiers deliberately kept: consumers may match on them, and no
// human reads them. Everything else in src/ + public/ must say EdgeHQ.
const KEEP = ['EdgeQuote-Webhooks/1.0']
const offenders: string[] = []
for (const dir of ['src', 'public']) {
  for (const p of walk(join(ROOT, dir))) {
    if (!/\.(tsx?|jsx?|json|webmanifest|html|css|mjs)$/.test(p)) continue
    let t = readFileSync(p, 'utf8')
    for (const k of KEEP) t = t.split(k).join('')
    if (t.includes('EdgeQuote')) offenders.push(p.slice(ROOT.length + 1))
  }
}
check('no EdgeQuote outside the wire allowlist', offenders.length === 0,
  `${offenders.slice(0, 6).join(', ')}${offenders.length > 6 ? ` +${offenders.length - 6} more` : ''} — ` +
  'the old name on a person-facing surface reads as a different product')

check('the login screen greets with the real product name',
  read('src/app/login/page.tsx').includes('EdgeHQ') && !read('src/app/login/page.tsx').includes('EdgeHQ AI'),
  'first screen, first impression')
check('the installed app names itself EdgeHQ, not one tenant',
  read('public/manifest.webmanifest').includes('"EdgeHQ — Field Service Platform"'),
  'the PWA manifest is the name on the phone home screen — platform name, no baked-in tenant')

// ── 2. Shared page anatomy ───────────────────────────────────────────────────
console.log('\n═══ Every module page opens the same way ═══')

// Top-level dashboard pages must use the shared PageHeader — directly, or via a
// shell that does. Exceptions are DECISIONS, each with its reason:
const HEADER_EXCEPTIONS: Record<string, string> = {
  'labor-intelligence': 'redirect stub — no page to head',
  'marketplace': 'redirect stub — no page to head',
}
const DASH = join(ROOT, 'src', 'app', 'dashboard')
const missing: string[] = []
for (const e of readdirSync(DASH)) {
  const dir = join(DASH, e)
  if (!statSync(dir).isDirectory() || e.startsWith('[') || e.startsWith('(')) continue
  if (e in HEADER_EXCEPTIONS) continue
  const pagePath = join(dir, 'page.tsx')
  if (!existsSync(pagePath)) continue
  const page = readFileSync(pagePath, 'utf8')
  // The page itself, or a component it delegates its frame to (hub clients,
  // report shells), must render PageHeader.
  if (page.includes('PageHeader')) continue
  const delegates = [...page.matchAll(/from '@\/components\/([a-zA-Z/-]+)'/g)]
    .map(m => join(ROOT, 'src', 'components', m[1]))
    .some(base => ['.tsx', '/index.tsx'].some(sfx => {
      const p = base + sfx
      return existsSync(p) && readFileSync(p, 'utf8').includes('PageHeader')
    }))
  if (!delegates) missing.push(`/dashboard/${e}`)
}
check('every top-level dashboard page carries the shared PageHeader', missing.length === 0,
  `${missing.join(', ')} — hand-rolled headers are how pages drift apart; use PageHeader, or add a reasoned exception here`)

// ── 3. Settings stays clustered, keys stay frozen ────────────────────────────
console.log('\n═══ Settings tabs: clustered, keys frozen ═══')

const settings = read('src/app/dashboard/settings/page.tsx')
const tabKeys = [...settings.matchAll(/\{ key: '([a-z-]+)', label: '[^']+', icon: \w+, group: '([a-z]+)' \}/g)]
check('all ten settings tabs carry a cluster', tabKeys.length === 10,
  `found ${tabKeys.length} grouped tabs — a tab without a group renders outside every cluster`)
const KEYS = ['business', 'scheduling', 'pricing', 'payroll', 'messaging', 'notifications', 'booking', 'modules', 'custom-fields', 'data']
check('the tab KEYS are exactly the frozen ten',
  JSON.stringify([...tabKeys].map(m => m[1]).sort()) === JSON.stringify([...KEYS].sort()),
  'renaming a key silently breaks every /dashboard/settings#key door and bookmark in the product')
check('clusters are contiguous (a group never restarts)', (() => {
  const groups = tabKeys.map(m => m[2])
  const seen = new Set<string>()
  let prev = ''
  for (const g of groups) {
    if (g !== prev && seen.has(g)) return false
    seen.add(g); prev = g
  }
  return true
})(), 'a group split across the rail draws two seams around nothing')

// ── 4. Folded form sections stay optional ────────────────────────────────────
console.log('\n═══ Progressive disclosure hides nothing required ═══')

const templates = read('src/app/dashboard/settings/templates/page.tsx')
check('the service editor folds cost, delivery and notes',
  ["title=\"Cost & margin\"", "title=\"Delivery\"", "title=\"Internal notes\""].every(s => templates.includes(s)),
  'the fold is the feature — without it the form is one long wall again')
for (const f of ['unit_cost', 'material_cost', 'recurrence', 'form_template_id', 'notes']) {
  const re = new RegExp(`register\\('${f}',\\s*\\{[^}]*required`, 's')
  check(`folded field ${f} carries no required rule`, !re.test(templates),
    'a required field inside a closed section fails submits with the reason hidden')
}
check('folded sections re-seed per service (keyed remount)',
  ['key={`cost-${editing?.id', 'key={`delivery-${editing?.id', 'key={`notes-${editing?.id'].every(s => templates.includes(s)),
  'without the key, switching services keeps the previous service\'s open/closed state and defaultOpen never re-evaluates')
check('sections open themselves where the service already uses them',
  templates.includes('defaultOpen={cost != null}') &&
  templates.includes('defaultOpen={!!(editing?.recurrence || editing?.form_template_id)}') &&
  templates.includes('defaultOpen={!!editing?.notes}'),
  'hiding CONFIGURED state behind a closed fold makes the owner hunt for their own settings')

// ── 5. The raised tap targets stay raised ────────────────────────────────────
console.log('\n═══ View switchers stay thumb-sized ═══')

const schedule = read('src/app/dashboard/schedule/page.tsx')
const dispatch = read('src/app/dashboard/dispatch/page.tsx')
check('schedule Month/Week/Day buttons are ≥40px',
  /viewButtons\.map[\s\S]{0,400}min-h-\[40px\]/.test(schedule),
  'they were 32px — measured, on main, at 375/390/430')
check('dispatch Board/Map pills are ≥40px',
  (dispatch.match(/FilterPill className="min-h-\[40px\]"/g) ?? []).length === 2,
  'they were 30px — FilterPill\'s resting size is a filter-row density, not a view switch')
check('the dispatch toolbar group wraps instead of overflowing',
  /ml-auto flex items-center gap-1\.5 flex-wrap/.test(dispatch),
  'this exact group overflowed 375–430px viewports — measured before the fix')
check('the dispatch lane grid can shrink (grid-cols-1 at base)',
  /grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3/.test(dispatch),
  'a bare `grid` track floors at min-content — one wide crew card held every lane ' +
  'at 628px inside a 375px phone (measured); grid-cols-1 = minmax(0,1fr) lets lanes shrink')

console.log('\n── Summary ────────────────────────────────────────────────────')
if (failures) {
  console.log(`\n❌ verify:ui-simplification — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:ui-simplification — one name, one anatomy, nothing required is hidden\n')
