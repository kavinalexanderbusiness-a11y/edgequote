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
// ⭐ Everything here is offline and synthetic: the exported rule is exercised
// directly, and the parts that need a renderer are pinned as source. No auth, no
// session, no network, no business data.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  /if \(currentOwner !== owner\) return error \? error\.message : null/.test(src))
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

console.log(fail === 0
  ? `\n✓ modules-owner: ${pass} checks passed\n`
  : `\n✗ modules-owner: ${fail} failed, ${pass} passed\n`)
process.exit(fail === 0 ? 0 : 1)
