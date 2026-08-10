// ── Verify: the advanced tools stay ranked, honest, and singular ─────────────
//   npm run verify:advanced-setup
//
// WHY THIS SCRIPT EXISTS
// EdgeQuote has real depth — an automation engine, a REST/webhook platform, a
// composable feature registry. None of it is what a service-business owner opens
// EdgeQuote to do, and all three had drifted into the foreground:
//
//   • Automation sat in the Growth group beside Grow, pitched as rules that
//     "act (or ask) on your behalf" — while every rule is `suggest`, the
//     dispatcher map is empty by design, and production had never recorded a
//     single signal, run or heartbeat.
//   • Integrations opened on API-key statistics under a subtitle beginning
//     "REST API, signed webhooks".
//   • Feature management had TWO surfaces: a Settings tab, and an app-store page
//     selling fifteen first-party features that are free and already on.
//
// This guard pins the corrections that are easy to undo by accident: where these
// live, that their copy still matches what the code will actually do, that there
// is one door to each, and that a read which FAILED is never drawn as a tidy
// empty state.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { FEATURE_MODULES, CATEGORY_ORDER, moduleByKey } from '../src/lib/modules'
import { AUTOMATION_RULES } from '../src/lib/automation/rules'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const has = (p: string) => existsSync(join(ROOT, p))
const stripComments = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// ── 1. Ranked as setup, not as daily work ────────────────────────────────────
console.log('\n═══ Advanced tools sit in Setup ═══')

const SETUP = CATEGORY_ORDER[CATEGORY_ORDER.length - 1]
check('Setup is still the last group', SETUP === 'admin',
  'the whole point of the group is that it comes after the work')
for (const key of ['automation', 'integrations']) {
  const m = moduleByKey(key)
  check(`${key} is in Setup`, m?.category === SETUP,
    `found "${m?.category}" — an engine console beside Schedule and Grow ranks plumbing as daily work`)
}
// `featured` promotes a module into a highlighted block. Neither of these should
// be sold to anyone; they are things you look in on.
for (const key of ['automation', 'integrations']) {
  check(`${key} is not "featured"`, moduleByKey(key)?.featured !== true,
    'nothing in Setup should be advertised above the features an owner actually runs the day on')
}

// ── 2. Copy that cannot outrun the engine ────────────────────────────────────
// The strongest claim on these surfaces is a NEGATIVE one — "it never contacts
// anyone on its own" — and it is only true while every rule is `suggest`. Tying
// the assertion to the registry means promoting a rule fails HERE, at the copy,
// instead of shipping a page that quietly lies to the owner about their customers.
console.log('\n═══ What the pages promise is what the engine does ═══')

const allSuggest = AUTOMATION_RULES.every(r => r.mode === 'suggest')
const autoPage = read('src/app/dashboard/automation/page.tsx')
const autoDesc = moduleByKey('automation')?.description ?? ''
const disclaims = /never (contacts|messages|texts)/i
check('every registered rule is still watch-only', allSuggest,
  'not a failure in itself — but the copy below now has to change with it')
if (allSuggest) {
  check('the module pitch says it will not act', disclaims.test(autoDesc),
    `"${autoDesc}" — the previous pitch promised rules that "act on your behalf", which the engine refuses to do`)
  check('the page lede says it will not act', disclaims.test(autoPage))
} else {
  check('a promoted rule has had the disclaimers removed',
    !disclaims.test(autoDesc) && !disclaims.test(autoPage),
    'a rule can now act — "it never contacts anyone" is no longer true and must not still be on screen')
}
// The pitch also must not resurrect the word that started it.
check('the module pitch no longer opens on REST/webhooks',
  !/REST API|signed webhook/i.test(moduleByKey('integrations')?.description ?? ''),
  'that sentence is the answer to a question almost no owner is asking')

// ── 3. One door to feature management ────────────────────────────────────────
console.log('\n═══ Features are managed in exactly one place ═══')

check('the app-store page is gone', !has('src/components/marketplace/ModuleListing.tsx'),
  'two surfaces over one registry is how they start disagreeing about what exists')
const stub = read('src/app/dashboard/marketplace/page.tsx')
check('…and its URL still resolves', /redirect\('\/dashboard\/settings#modules'\)/.test(stub),
  'old links and bookmarks must land somewhere real — verify:navigation also treats a thin stub as reachable')
check('the stub stayed thin', stub.length < 800,
  'a redirect that grows a body is a second surface again')

const manager = read('src/components/settings/ModuleManager.tsx')
check('the manager does not talk like a store',
  !/marketplace|Compose your EdgeQuote/i.test(stripComments(manager)),
  'fifteen included, always-on features are not a kit to assemble')
check('it says switching off is reversible and non-destructive',
  /nothing is deleted/i.test(manager),
  'the one thing an owner needs to believe before touching a toggle')

// Nothing may link the retired page except its own stub.
const linkers = ['src/components/command/CommandPalette.tsx', 'src/components/settings/ModuleManager.tsx',
  'src/components/layout/Sidebar.tsx', 'src/components/layout/BottomNav.tsx']
for (const f of linkers) {
  check(`${f.split('/').pop()} points at the surviving surface`,
    !stripComments(read(f)).includes('/dashboard/marketplace'),
    'link /dashboard/settings#modules instead')
}

// ── 4. The owner's half of Integrations comes first ──────────────────────────
console.log('\n═══ Integrations opens on the part that is not for developers ═══')

const intPage = read('src/app/dashboard/integrations/page.tsx')
const tabBlock = intPage.slice(intPage.indexOf('const TABS'), intPage.indexOf('type Tab ='))
const firstTab = /\{ key: '([a-z]+)'/.exec(tabBlock)?.[1]
check('"Connected apps" is the first tab', firstTab === 'apps',
  `found "${firstTab}" — the owner-facing tab was fifth, off-screen at 390px`)
check('…and the page opens on it', /const DEFAULT_TAB: Tab = 'apps'/.test(intPage))
check('the header no longer leads with REST/webhooks',
  !/description="Connect EdgeQuote to everything else — REST API/.test(intPage))
// Both indices must EXIST before comparing them — a missing <ConnectionsManager>
// gives -1, and -1 < anything is happily true. (Caught by negative-testing this
// very check: deleting the mount made the assertion pass.)
const iConn = intPage.indexOf('<ConnectionsManager')
const iZap = intPage.indexOf('Using Zapier or Make?')
check('the accounts list is above the Zapier note, not below it',
  iConn >= 0 && iZap >= 0 && iConn < iZap,
  'otherwise the owner-facing tab still opens with "API key" and "webhook URL"')

// ── 5. A read that failed is not an empty state ──────────────────────────────
console.log('\n═══ "Nothing here" must mean nothing is here ═══')

check('the integrations overview branches on its read errors',
  /const failed = keys\.error \?\? endpoints\.error/.test(intPage) && /setStatsError\(failed\.message\)/.test(intPage),
  'count ?? 0 turned five failed queries into four zeros — the exact shape of "Nothing connected yet"')
for (const [file, what] of [
  ['ApiKeysManager', 'API keys'], ['WebhooksManager', 'endpoints'], ['InboundHooksManager', 'inbound URLs'],
] as const) {
  const src = read(`src/components/integrations/${file}.tsx`)
  // Must CAPTURE the error, not merely mention the setter: `setLoadError(null)`
  // on the happy path satisfies a loose /setLoadError\(/ while the error branch
  // is gone. All three passed the loose version with that branch deleted — the
  // negative test is the only reason it was caught.
  const captures = /error\)[^\n]*\{ setLoadError\(/.test(src)
  check(`${file} says so when the list could not load`,
    captures && /\{loadError \? \(/.test(src),
    `an empty ${what} list invites a developer to mint a duplicate they already have`)
}
// The automation page's strongest claim is drawn from a null heartbeat.
check('a failed heartbeat read is not reported as "never ran"',
  /setSweepUnknown\(!!\(ssRes\.error \|\| esRes\.error\)\)/.test(autoPage)
  && /const neverRan = !loading && !sweepUnknown/.test(autoPage),
  'ran-and-found-nothing, never-ran and could-not-ask are THREE answers; the page had two')
check('…and it says which one it is',
  /Couldn’t read the heartbeat/.test(autoPage),
  'silently downgrading to the softer sentence is the same lie, quieter')

// ── 6. A write that failed is not a save ─────────────────────────────────────
console.log('\n═══ Turning a feature off actually stores it ═══')

const hook = read('src/hooks/useModules.ts')
check('the module composition is UPSERTed, never bare-updated',
  /from\('business_settings'\)\s*\n?\s*\.upsert\(/.test(hook)
  && !/from\('business_settings'\)\s*\n?\s*\.update\(/.test(hook),
  'on a business with no settings row .update() matches zero rows and returns NO error — the toggle looks saved, navigation changes, and the next reload puts it back')
check('the upsert is keyed on user_id', /onConflict: 'user_id'/.test(hook))
check('a save is refused when the current composition is unknown',
  /if \(prev\?\.unknown\) return/.test(hook),
  'install/uninstall both compute the next set FROM the current one — saving on top of a failed read re-installs everything the owner switched off')
check('a failed read still fails OPEN for navigation',
  /store = store \?\? \{ enabled: null, meta: \{\}, unknown: true \}/.test(hook),
  'hiding a page because a query blipped is worse than showing one too many')

console.log('\n── Summary ────────────────────────────────────────────────────')
if (failures) {
  console.log(`\n❌ verify:advanced-setup — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log(`\n✅ verify:advanced-setup — ${FEATURE_MODULES.length} modules, advanced tools ranked as setup and honest about it\n`)
