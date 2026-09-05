// ── verify:modules-owner — a module snapshot is served only to the account it belongs to
//
//   npm run verify:modules-owner
//
// THE DEFECT THIS PINS. `useModules` keeps its snapshot in a module-level
// variable. Sign-out (`Sidebar.tsx` → `router.push('/login')`) and sign-in
// (`login/page.tsx` → `router.push` + `router.refresh()`) are both CLIENT
// transitions, so that variable survives an account switch, and nothing in
// `src/` subscribes to `onAuthStateChange`. B's first render therefore read A's
// composition out of memory — independent of any persistent cache.
//
// ⛔ WHY AN OWNER TAG ALONE WAS NOT ENOUGH. `getSnapshot` is SYNCHRONOUS —
// useSyncExternalStore calls it during render — while every way of asking who is
// signed in is async. A tag says "this is A's"; nothing says "the session is now
// B". Identity has to be resolved and held BEFORE a snapshot can be served, which
// is what the auth subscription is for.
//
// ⭐ Everything here is offline and synthetic. Three levels of evidence, kept
// distinct on purpose: the exported rule is EXECUTED directly (§1); the
// ordering rules are EXECUTED against statements lifted verbatim out of the
// hook (§7, §8); everything that genuinely needs a renderer — getSnapshot
// running during render, the mount effect — is PINNED AS SOURCE (§2-6) and is
// not claimed as a runtime proof. No auth, no session, no network, no business
// data.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// esbuild is tsx's own compiler, and this guard runs under tsx — so it is always
// installed alongside the runner. Used only to erase types from lifted source.
import { transformSync } from 'esbuild'
import { mayServeOwner } from '../src/hooks/useModules'

const ROOT = join(__dirname, '..')
let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}
const H = (t: string) => console.log(`\n── ${t} ──\n`)
const src = readFileSync(join(ROOT, 'src/hooks/useModules.ts'), 'utf8').replace(/\r\n/g, '\n')

H('1 · the ownership rule itself (executed)')

const A = 'user-a', B = 'user-b'
check('⛔ identity NOT established → nothing is served, whoever the snapshot belongs to',
  !mayServeOwner(false, A, A) && !mayServeOwner(false, A, B) && !mayServeOwner(false, null, null),
  'this is the first-render case an owner tag alone cannot cover')
check('known + same owner → served', mayServeOwner(true, A, A))
check('⛔ known + DIFFERENT owner → not served', !mayServeOwner(true, A, B))
check('⛔ A snapshot with nobody signed in → not served', !mayServeOwner(true, A, null))
check('signed out (nobody/nobody) → served, so the fail-open default still paints',
  mayServeOwner(true, null, null))
check('[negative control] the rule is not constantly false',
  mayServeOwner(true, B, B) && mayServeOwner(true, null, null))

H('2 · the reader uses that rule, and fails OPEN')

check('getSnapshot decides through mayServeOwner, not by returning the store',
  /function getSnapshot\(\)[^{]*\{\s*return mayServeOwner\(ownerKnown, storeOwner, currentOwner\) \? store : null/.test(src),
  'a bare `return store` is the defect')
check('a foreign or unknown owner yields null — the documented pre-load state',
  /: null\n\}/.test(src) && /pre-load state is null/.test(src))
check('signed out still sets the fail-open default (enabled: null), not a wipe',
  /store = \{ enabled: null, meta: \{\} \}\n\s*storeOwner = null/.test(src),
  'navigation must keep showing everything when nobody is signed in')

H('3 · the writer fails CLOSED')

check('⛔ persist refuses before writing when the owner is unknown or mismatched',
  /if \(owner === null \|\| !mayServeOwner\(ownerKnown, storeOwner, owner\)\) \{/.test(src))
check('…and the refusal comes BEFORE the optimistic store write', (() => {
  const guard = src.indexOf('!mayServeOwner(ownerKnown, storeOwner, owner)')
  const optimistic = src.indexOf('store = { enabled: nextEnabled, meta: nextMeta }')
  return guard > -1 && optimistic > -1 && guard < optimistic
})(), 'install/uninstall compute the next set FROM the current one')
check('…and before the upsert', (() => {
  const guard = src.indexOf('!mayServeOwner(ownerKnown, storeOwner, owner)')
  // ⚠️ Anchor on `.upsert(`, not on `.from('business_settings')` — the SELECT in
  // loadModules matches that first and sits above the writer entirely.
  const write = src.indexOf('.upsert(')
  return guard > -1 && write > -1 && guard < write
})())
check('the session is re-checked against the captured owner at write time',
  /if \(!uid \|\| uid !== owner\)/.test(src))
check('the pre-existing guess refusal is preserved', /if \(prev\?\.unknown\) return/.test(src))

H('4 · per-owner dedupe, and late completions rejected')

check('⛔ in-flight sharing is per owner, not global',
  /if \(inFlight && inFlightOwner === currentOwner\) return inFlight/.test(src),
  'a bare `if (inFlight)` hands A\'s round-trip to B')
check('the load records which owner it was started for', /inFlightOwner = startedFor/.test(src))
check('⛔ a READ that lands after a switch is dropped', (() => {
  const query = src.indexOf(".from('business_settings').select('enabled_modules")
  const reject = src.indexOf('if (uid !== currentOwner) return', query)
  const write = src.indexOf('storeOwner = uid', query)
  return query > -1 && reject > query && write > reject
})(), 'the check must sit between the await and any store write')
check('⛔ a WRITE that lands after a switch touches neither store nor notice',
  /if \(currentOwner !== owner \|\| ownerEpoch !== epoch\) return error \? error\.message : null/.test(src),
  'the epoch is what makes A -> B -> A visible; an owner comparison alone cannot')
check('a switch orphans anything already in flight',
  /inFlight = null\n\s*inFlightOwner = null/.test(src))

H('5 · identity is established, and the public shape is unchanged')

check('an auth subscription maintains the current owner',
  /onAuthStateChange\(/.test(src) && /ownerKnown = true/.test(src))
check('it is installed once, from the mount effect',
  /if \(authWatch\) return/.test(src) && /ensureAuthWatch\(\)\n\s*loadModules\(\)/.test(src))
check('the hook still returns exactly the same keys', (() => {
  const want = ['all', 'visible', 'installed', 'enabled', 'meta', 'loaded', 'install', 'uninstall', 'acknowledgeUpdate', 'wouldInstall']
  const tail = src.slice(src.lastIndexOf('  return {'))
  return want.every(k => new RegExp(`\\n\\s*${k}[,:]`).test(tail))
})(), 'four consumers of this hook depend on the shape')

H('6 · the neighbouring lanes are not touched')

check('this repair does not import or modify clientCache', !/clientCache/.test(src),
  'the persistent envelope is S97\'s lane')
check('…and says nothing about useBusinessData\'s store', !/useBusinessData\./.test(src))

// ═══════════════════════════════════════════════════════════════════════════
// 7 · EXECUTED — response ordering under A → B → A
//
// Sections 1-6 pin the hook as SOURCE, which is a real limit (no jsdom, no test
// renderer in this repo). This section removes that limit for the ordering
// rules: the module-level block, `loadModules` and the body of `persist` are
// LIFTED VERBATIM out of src/hooks/useModules.ts and driven with an injected
// fake client. Nothing is re-implemented, so a green result here is about the
// shipped source rather than about a copy of it.
//
// ⭐ Technique borrowed from S122's review harness for this branch, which used
// the same lift to prove the residual these checks now close.
//
// Owner changes are delivered through the REAL `ensureAuthWatch` callback — the
// harness captures it from `onAuthStateChange` and invokes it — so the switch
// bookkeeping under test is the hook's own, not a mirror of it. The only thing
// the harness decides is WHEN each round-trip answers.
//
// ⛔ Still offline and synthetic: no React, no auth, no session, no network, no
// storage, no business data, no write.

type Settled<T> = { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T>(): Settled<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

type Row = { data: unknown; error: unknown }
type Snap = { enabled?: unknown; meta?: unknown; unknown?: boolean } | null

/** The fake Supabase client: it answers only when a test says so. */
function fakeClient() {
  let session: { user: { id: string } } | null = null
  let onAuth: ((e: string, s: unknown) => void) | null = null
  const selects: Settled<Row>[] = []
  const upserts: Settled<{ error: unknown }>[] = []
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
      q.select = () => q
      q.eq = () => q
      q.maybeSingle = () => { const d = deferred<Row>(); selects.push(d); return d.promise }
      q.upsert = () => { const d = deferred<{ error: unknown }>(); upserts.push(d); return d.promise }
      return q
    },
  }
  return {
    create: () => client,
    selects,
    upserts,
    /** Deliver the auth event the app would deliver. */
    signIn(uid: string | null) {
      session = uid ? { user: { id: uid } } : null
      if (!onAuth) throw new Error('ensureAuthWatch never subscribed')
      onAuth(uid ? 'SIGNED_IN' : 'SIGNED_OUT', session)
    },
  }
}

interface Lifted {
  ensureAuthWatch: () => void
  persist: (e: string[] | null, m: Record<string, unknown>) => Promise<string | null>
  peek: () => Snap
  owner: () => string | null
}

function balanced(s: string, from: number): string {
  let depth = 0
  for (let i = s.indexOf('{', from); i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}' && --depth === 0) return s.slice(from, i + 1)
  }
  throw new Error('unbalanced braces')
}

/** Compile the hook's own statements into a fresh module scope. */
function lift(create: () => unknown, mutate?: (s: string) => string): Lifted {
  const top = src.indexOf('let store')
  const loadAt = src.indexOf('function loadModules')
  const persistAt = src.indexOf('const persist = useCallback(')
  if (top < 0 || loadAt < 0 || persistAt < 0) throw new Error('the hook was restructured — lift failed')
  let body = src.slice(top, loadAt) + balanced(src, loadAt)
  let persistFn = balanced(src, src.indexOf('async (', persistAt))
  if (mutate) { body = mutate(body); persistFn = mutate(persistFn) }
  const code = [
    'const __factory = function (createClient, readMeta, window) {',
    body.replace(/^export /gm, ''),
    'const persist = ' + persistFn + ';',
    'return { ensureAuthWatch, persist, peek: () => store, owner: () => storeOwner }',
    '}',
  ].join('\n')
  const js = transformSync(code, { loader: 'ts' }).code
  const make = new Function(js + '\nreturn __factory')() as
    (c: unknown, r: unknown, w: unknown) => Lifted
  return make(create, (m: unknown) => (m ?? {}), { dispatchEvent() {} })
}

const tick = () => new Promise(r => setTimeout(r, 0))
const enabledOf = (l: Lifted) => JSON.stringify(l.peek()?.enabled ?? null)
const row = (...keys: string[]): Row => ({ data: { enabled_modules: keys, module_meta: {} }, error: null })
const failedRead = (message: string): Row => ({ data: null, error: { message } })

/** One pass over every ordering scenario. `mutate` lets a guard be removed. */
async function scenarios(mutate?: (s: string) => string) {
  const out: Record<string, string> = {}

  // ── the residual, on the SUCCESS path ───────────────────────────────────
  {
    const w = fakeClient()
    const l = lift(w.create, mutate)
    l.ensureAuthWatch()
    w.signIn('A'); await tick()          // L1 issued for A, left unanswered
    w.signIn('B'); await tick()          // the switch orphans L1
    w.signIn('A'); await tick()          // back to A — a SECOND load starts
    w.selects[2].resolve(row('A-NEW')); await tick()
    out.setup = enabledOf(l)
    w.selects[0].resolve(row('A-OLD')); await tick()   // L1 finally answers
    out.successPath = enabledOf(l)
  }

  // ── and on the LATE ERROR path, which writes the store too ──────────────
  {
    const w = fakeClient()
    const l = lift(w.create, mutate)
    l.ensureAuthWatch()
    w.signIn('A'); await tick()          // L1 for A, unanswered
    w.signIn('B'); await tick()
    w.selects[1].resolve(row('B-SET')); await tick()   // B's own load commits
    w.signIn('A'); await tick()          // A's new load is still out
    w.selects[0].resolve(failedRead('late failure')); await tick()
    out.errorPath = enabledOf(l) + '|' + l.owner() + '|unknown=' + String(l.peek()?.unknown)
  }

  // ── negative controls: the CURRENT load must still work, both ways ──────
  {
    const w = fakeClient()
    const l = lift(w.create, mutate)
    l.ensureAuthWatch()
    w.signIn('A'); await tick()
    w.selects[0].resolve(row('A-ONLY')); await tick()
    out.currentCommits = enabledOf(l)
  }
  {
    const w = fakeClient()
    const l = lift(w.create, mutate)
    l.ensureAuthWatch()
    w.signIn('A'); await tick()
    w.selects[0].resolve(failedRead('boom')); await tick()
    out.currentFailure = String(l.peek()?.unknown)
  }

  // ── persist: same shape, keyed on the epoch instead of an in-flight slot ─
  {
    const w = fakeClient()
    const l = lift(w.create, mutate)
    l.ensureAuthWatch()
    w.signIn('A'); await tick()
    w.selects[0].resolve(row('A-BASE')); await tick()
    void l.persist(['SAVED'], {}); await tick()        // upsert now in flight
    out.optimistic = enabledOf(l)
    w.signIn('B'); await tick()
    w.signIn('A'); await tick()                        // A -> B -> A during the save
    w.selects[2].resolve(row('A-FRESH')); await tick()
    w.upserts[0].resolve({ error: { message: 'late save failure' } }); await tick()
    out.lateSave = enabledOf(l)
  }
  {
    const w = fakeClient()
    const l = lift(w.create, mutate)
    l.ensureAuthWatch()
    w.signIn('A'); await tick()
    w.selects[0].resolve(row('A-BASE')); await tick()
    void l.persist(['SAVED'], {}); await tick()
    w.upserts[0].resolve({ error: { message: 'refused' } }); await tick()
    out.currentSaveFailure = enabledOf(l)
  }
  return out
}

async function section7() {
  H('7 · EXECUTED — response ordering under A → B → A')
  const r = await scenarios()

  check('setup · the SECOND A load has landed', r.setup === '["A-NEW"]', r.setup)
  check('⛔ the ORPHANED first A read cannot overwrite the newer one',
    r.successPath === '["A-NEW"]', 'store is ' + r.successPath)
  check('⛔ an ORPHANED read that FAILS cannot install a guess either',
    r.errorPath === '["B-SET"]|B|unknown=undefined', r.errorPath)
  check('[negative control] the CURRENT read still commits',
    r.currentCommits === '["A-ONLY"]', r.currentCommits)
  check('[negative control] the CURRENT read failing still records the guess',
    r.currentFailure === 'true', 'unknown=' + r.currentFailure)
  check('setup · the save is optimistic', r.optimistic === '["SAVED"]', r.optimistic)
  check('⛔ a save that FAILS after A → B → A does not revert the fresh store',
    r.lateSave === '["A-FRESH"]', 'store is ' + r.lateSave)
  check('[negative control] a CURRENT save failure still reverts',
    r.currentSaveFailure === '["A-BASE"]', r.currentSaveFailure)

  H('8 · EXECUTED — mutation: each ordering guard is load-bearing')

  const noIdentity = await scenarios(s => s.replace('if (inFlight !== self.p) return', ''))
  check('⛔ WITHOUT `inFlight !== self.p` the stale A read wins',
    noIdentity.successPath === '["A-OLD"]',
    'expected the defect to reappear, got ' + noIdentity.successPath)
  check('⛔ WITHOUT it an orphaned FAILURE installs a guess over B’s data',
    noIdentity.errorPath === 'null|A|unknown=true',
    'expected the defect to reappear, got ' + noIdentity.errorPath)
  check('…and the negative controls stay green without it — they test the guard, not the harness',
    noIdentity.currentCommits === '["A-ONLY"]' && noIdentity.currentFailure === 'true')

  const noEpoch = await scenarios(s => s.replace(' || ownerEpoch !== epoch', ''))
  check('⛔ WITHOUT the epoch the late save failure reverts the fresh store',
    noEpoch.lateSave === '["A-BASE"]',
    'expected the defect to reappear, got ' + noEpoch.lateSave)
  check('…and a CURRENT save failure still reverts without it — that control is independent',
    noEpoch.currentSaveFailure === '["A-BASE"]')
}

void section7().then(() => {
  console.log(fail === 0
    ? `\n✓ modules-owner: ${pass} checks passed\n`
    : `\n✗ modules-owner: ${fail} failed, ${pass} passed\n`)
  process.exit(fail === 0 ? 0 : 1)
})
