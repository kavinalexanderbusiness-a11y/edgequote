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
import { FEATURE_MODULES, CATEGORY_ORDER, moduleByKey, visibleModules, readMeta } from '../src/lib/modules'
// esbuild is tsx's own compiler and this guard runs under tsx, so it is always
// installed alongside the runner. Used only to erase types from lifted source.
import { transformSync } from 'esbuild'
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
// ── 6b. …and a read that FAILED still draws navigation OPEN ─────────────────
//
// ⛔⛔ WHY THIS IS EXECUTED AND NOT MATCHED. This check used to pin one literal:
//     store = store ?? { enabled: null, meta: {}, unknown: true }
// The account-isolation work legitimately rewrote that line to
//     store = storeOwner === uid && store ? store : { enabled: null, meta: {}, unknown: true }
// — retain OUR last good snapshot, not ANY account's — and CI went red on a
// behaviour that had NOT changed. That was a stale pin, not a defect, and the
// repair is not a looser regex: a regex could not tell the two apart on the one
// thing the check is actually about, which is what NAVIGATION DRAWS. So the
// hook's own store and loader are lifted verbatim out of the file already read
// above and driven against a fake client, and every answer is read through the
// REAL `visibleModules()` — the same projection the sidebar uses.
//
// ⭐ Offline and synthetic: no auth, no session, no network, no business data,
// no write. The only injected parts are the client and WHEN it answers.
const src6b = hook.replace(/\r\n/g, '\n')

function balanced6b(s: string, from: number): string {
  let depth = 0
  for (let i = s.indexOf('{', from); i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}' && --depth === 0) return s.slice(from, i + 1)
  }
  throw new Error('unbalanced braces')
}

interface Store6b {
  loadModules: () => Promise<void>
  persist: (e: string[] | null, m: Record<string, unknown>) => Promise<string | null>
  served: () => { enabled?: unknown; unknown?: boolean } | null
  raw: () => { enabled?: unknown; unknown?: boolean } | null
  ensureAuthWatch: () => void
}

/** Compile the hook's own statements into a fresh module scope. */
function liftStore(create: () => unknown, mutate?: (s: string) => string): Store6b {
  const top = src6b.indexOf('let store')
  const loadAt = src6b.indexOf('function loadModules')
  const persistAt = src6b.indexOf('const persist = useCallback(')
  if (top < 0 || loadAt < 0 || persistAt < 0) throw new Error('useModules was restructured — the lift failed')
  let body = src6b.slice(top, loadAt) + balanced6b(src6b, loadAt)
  let persistFn = balanced6b(src6b, src6b.indexOf('async (', persistAt))
  if (mutate) { body = mutate(body); persistFn = mutate(persistFn) }
  const code = [
    'const __factory = function (createClient, readMeta, window) {',
    body.replace(/^export /gm, ''),
    'const persist = ' + persistFn + ';',
    // `served` is what a RENDER would get; `raw` is the stored snapshot itself.
    'return { loadModules, persist, ensureAuthWatch, served: getSnapshot, raw: () => store }',
    '}',
  ].join('\n')
  const js = transformSync(code, { loader: 'ts' }).code
  return (new Function(js + '\nreturn __factory')() as
    (c: unknown, r: unknown, w: unknown) => Store6b)(create, readMeta, { dispatchEvent() {} })
}

/** A fake Supabase client that answers only when the test says so. */
function fake6b() {
  let session: { user: { id: string } } | null = null
  let onAuth: ((e: string, s: unknown) => void) | null = null
  const reads: ((v: { data: unknown; error: unknown }) => void)[] = []
  const writes: ((v: { error: unknown }) => void)[] = []
  const defer = <T,>(sink: ((v: T) => void)[]) =>
    new Promise<T>(res => { sink.push(res) })
  const client = {
    auth: {
      getSession: async () => ({ data: { session } }),
      onAuthStateChange: (cb: (e: string, s: unknown) => void) => {
        onAuth = cb
        return { data: { subscription: { unsubscribe() {} } } }
      },
    },
    from: () => {
      const q: Record<string, unknown> = {}
      q.select = () => q; q.eq = () => q
      q.maybeSingle = () => defer<{ data: unknown; error: unknown }>(reads)
      q.upsert = () => defer<{ error: unknown }>(writes)
      return q
    },
  }
  return {
    create: () => client,
    /** Deliver the auth event the app delivers, through the hook's own listener. */
    signIn(uid: string | null) {
      session = uid ? { user: { id: uid } } : null
      onAuth?.(uid ? 'SIGNED_IN' : 'SIGNED_OUT', session)
    },
    answer: (v: { data: unknown; error: unknown }) => reads.shift()?.(v),
    answerWrite: (v: { error: unknown }) => writes.shift()?.(v),
  }
}

const settle = () => new Promise(r => setTimeout(r, 0))

// ⛔⛔ THE EXIT CODE IS WHAT CI READS, AND AN ASYNC SECTION CAN SKIP IT.
// A promise that never settles does NOT hold the event loop open: Node drains,
// runs no more of the async body, and exits 0 — with ✗ lines already on screen.
// This guard measured exactly that during its own repair. So completion is
// asserted, not assumed: anything that ends the process before the summary is a
// FAILURE, never a silent pass.
let sectionFinished = false
process.on('exit', code => {
  if (!sectionFinished && code === 0) {
    console.log('\n❌ verify:advanced-setup — the navigation section did not finish (the event loop drained before the summary). Treating as FAILURE.\n')
    process.exitCode = 1
  }
})
const ALL = FEATURE_MODULES.length
const ONE_NON_CORE = FEATURE_MODULES.filter(m => !m.core)[0].key
const good = (keys: string[] | null) =>
  ({ data: { enabled_modules: keys, module_meta: {} }, error: null })
const blipped = { data: null, error: { message: 'read failed' } }
/** How many modules navigation would draw for what a render is served. */
const drawn = (s: Store6b) => visibleModules(s.served()?.enabled ?? null).length

async function navigationCases(mutate?: (s: string) => string) {
  const out: Record<string, string | number | boolean | null> = {}

  // A read that FAILS with nothing cached — the case the old literal guarded.
  {
    const w = fake6b(); const s = liftStore(w.create, mutate)
    s.ensureAuthWatch(); w.signIn('acct-A'); await settle()
    w.answer(blipped); await settle()
    out.failOpenDrawn = drawn(s)
    out.failOpenMarked = s.raw()?.unknown === true
    // ⛔ Do NOT `await` this bare. With the guess flag present, persist refuses
    // before it touches the client. With the flag MISSING (the mutation below)
    // it goes on to upsert — and an unanswered request would leave this await
    // pending forever, which in CommonJS lets the event loop drain and Node
    // exit 0 with failures already printed. Answering it makes "the write was
    // allowed" observable instead of invisible.
    const refusal = s.persist([ONE_NON_CORE], {})
    await settle()
    w.answerWrite({ error: null })
    out.failOpenWriteRefused = await refusal
    out.failOpenStoreAfterWrite = JSON.stringify(s.raw()?.enabled ?? null)
  }

  // A read that FAILS after a GOOD one for the SAME account — last good is kept.
  {
    const w = fake6b(); const s = liftStore(w.create, mutate)
    s.ensureAuthWatch(); w.signIn('acct-A'); await settle()
    w.answer(good([ONE_NON_CORE])); await settle()
    out.goodDrawn = drawn(s)
    void s.loadModules(); await settle()
    w.answer(blipped); await settle()
    out.retainedEnabled = JSON.stringify(s.served()?.enabled ?? null)
    out.retainedNotGuess = s.raw()?.unknown === undefined
  }

  // A FOREIGN snapshot is never served — and the fallback is still fail-OPEN.
  {
    const w = fake6b(); const s = liftStore(w.create, mutate)
    s.ensureAuthWatch(); w.signIn('acct-A'); await settle()
    w.answer(good([ONE_NON_CORE])); await settle()
    w.signIn('acct-B'); await settle()
    out.foreignServed = s.served() === null
    out.foreignDrawn = drawn(s)
  }
  return out
}


// Section 6b is asynchronous, so the summary — and the EXIT CODE CI reads —
// must run after it. Anything thrown inside fails the guard rather than
// resolving quietly to a green exit 0.
void (async () => {
  console.log('\n═══ A read that failed still draws navigation OPEN ═══')

  const nav = await navigationCases()

  check('a FAILED read draws every module — navigation fails OPEN',
    nav.failOpenDrawn === ALL,
    `hiding a page because a query blipped is worse than showing one too many — drew ${nav.failOpenDrawn} of ${ALL}`)
  check('…and the snapshot is marked a guess', nav.failOpenMarked === true)
  check('…so the WRITE fails CLOSED on that guess',
    typeof nav.failOpenWriteRefused === 'string' && nav.failOpenWriteRefused.length > 0
    && nav.failOpenStoreAfterWrite === 'null',
    'install/uninstall compute the next set FROM the current one, so saving on top of a failed read re-installs everything the owner switched off')
  check('a failed read after a GOOD one keeps OUR last good composition',
    nav.retainedEnabled === JSON.stringify([ONE_NON_CORE]) && nav.retainedNotGuess === true,
    'the account-isolation rewrite kept this; it only stopped retaining ANOTHER account\'s snapshot')
  check('⛔ a snapshot belonging to another account is never served',
    nav.foreignServed === true)
  check('…and that fallback is fail-OPEN too, not an empty nav',
    nav.foreignDrawn === ALL, `drew ${nav.foreignDrawn} of ${ALL}`)
  check('[positive control] a GOOD read narrows navigation, so "all" is not constant',
    typeof nav.goodDrawn === 'number' && nav.goodDrawn < ALL && nav.goodDrawn > 0,
    `a successful read drew ${nav.goodDrawn} of ${ALL}`)

  // ── the three ways this could regress, each executed ────────────────────────
  //
  // ⛔ THE FAULTS ARE INJECTED BY SHAPE, NOT BY LITERAL — this is the same
  // mistake that produced the CI failure being repaired. An injector anchored on
  // one exact spelling silently does nothing the next time that line is reworded,
  // and a mutation that does nothing makes its own check vacuous: the "mutated"
  // run equals the clean run, so the check reports a problem that is really just
  // a moved anchor. So each injection is counted, and a miss is its own failure.
  const injected: Record<string, number> = {}
  const inject = (label: string, re: RegExp, repl: string) => (s: string) => {
    const out = s.replace(re, repl)
    if (out !== s) injected[label] = (injected[label] ?? 0) + 1
    return out
  }

  // Matches both the pre-isolation `store = store ?? { … }` and the current
  // `store = storeOwner === uid && store ? store : { … }`.
  const closedOnFail = await navigationCases(inject('empty-nav',
    /store = [^\n]*\{ enabled: null, meta: \{\}, unknown: true \}/,
    'store = { enabled: [], meta: {}, unknown: true }'))
  check('[mutation] drawing an EMPTY nav on a failed read is caught',
    closedOnFail.failOpenDrawn !== ALL,
    'the fail-open check would not have noticed the regression')

  const noGuessFlag = await navigationCases(inject('no-guess-flag',
    /, unknown: true \}/, ' }'))
  check('[mutation] forgetting to mark the guess is caught',
    noGuessFlag.failOpenMarked !== true || noGuessFlag.failOpenWriteRefused === null,
    'a write would then be allowed on top of a failed read')

  const bareSnapshot = await navigationCases(inject('bare-snapshot',
    /return mayServeOwner\([^)]*\) \? store : null/, 'return store'))
  check('[mutation] serving the store without checking the owner is caught',
    bareSnapshot.foreignServed !== true,
    'this is the account-isolation property the rewrite exists for')

  check('every fault above actually reached the source — no vacuous mutation',
    ['empty-nav', 'no-guess-flag', 'bare-snapshot'].every(k => (injected[k] ?? 0) > 0),
    `injected: ${JSON.stringify(injected)} — a missing key means the anchor moved and that check proved nothing`)

  sectionFinished = true
  console.log('\n── Summary ────────────────────────────────────────────────────')
  if (failures) {
    console.log(`\n❌ verify:advanced-setup — ${failures} failure${failures === 1 ? '' : 's'}\n`)
    process.exit(1)
  }
  console.log(`\n✅ verify:advanced-setup — ${FEATURE_MODULES.length} modules, advanced tools ranked as setup and honest about it\n`)
})().catch(err => { console.error(err); process.exit(1) })
