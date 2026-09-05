// ── verify:client-cache-isolation — the client cache answers to one account ──
//   npx tsx scripts/verify-client-cache-isolation.ts
//   VERIFY_CLIENT_CACHE=<path/to/other/clientCache.ts> npx tsx scripts/verify-client-cache-isolation.ts
//     → §2 against another implementation (negative control: a copy of an
//       earlier module must FAIL the cases it did not hold — that run IS the
//       reproduction, on the real code, with synthetic storage).
//
// What is being guarded. lib/clientCache keeps reports, lists, business memory
// and the persisted field bundle in sessionStorage / localStorage under
// `eq:<key>` keys. Two findings, both reproduced on real code with synthetic
// Storage: (1) nothing stamped or cleared them, so on ONE device the next
// account's first paint could be the previous account's data — same tab within
// TTL, the persisted bundle across an app kill, offline included; (2) a stamp
// taken at WRITE time certifies who is signed in when a slow fetch lands, not
// whose data it is — a fetch started by A that lands after B signed in stamped
// A's numbers as B's. Not a remote exploit; a shared-device information boundary.
//
// §1 SOURCE: entries are stamped with the LEASE's owner and read only for the
//    owner; a write needs a lease that is still current (owner AND generation);
//    the generation advances on every owner change; the dashboard layout names
//    the owner FIRST; CacheOwner adopts during render and again in its effect
//    (StrictMode) and clears on unmount; adopt is a no-op on the server; the
//    sidebar's sign-out empties the namespace before ending the session; every
//    writer captures its lease at fetch start and passes it — the two customer
//    pages excepted by name (deferred to their owner; they cache nothing until
//    threaded, which fails closed); the module never calls Storage.clear().
// §2 BEHAVIOUR against synthetic Storage (no browser, no network, no real data):
//    the same account keeps its entries; another account — same tab without
//    sign-out, or a cold start on the same device — reads nothing and the
//    foreign entry is dropped; explicit sign-out removes exactly this module's
//    entries; the device marker; legacy entries; unknown owner; TTL; a throwing
//    store; THE LATE WRITE (a fetch started by A landing after B adopted writes
//    nothing, in every ordering); the StrictMode lifecycle keeps the owner and
//    refuses leases from before the cleanup; SSR sets no owner.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import type { CacheLease } from '../src/lib/clientCache'

type CacheModule = typeof import('../src/lib/clientCache')

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}
const info = (s: string) => console.log(`  ℹ ${s}`)
const read = (p: string) => readFileSync(p, 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '')
const tick = () => new Promise<void>(r => setTimeout(r, 0))

// ── synthetic browser ────────────────────────────────────────────────────────
class FakeStorage {
  private m = new Map<string, string>()
  clears = 0
  throwing = false
  get length() { return this.m.size }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  getItem(k: string) { if (this.throwing) throw new Error('SecurityError'); return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { if (this.throwing) throw new Error('QuotaExceededError'); this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.clears++; this.m.clear() }
  keys() { return [...this.m.keys()] }
}
const g = globalThis as unknown as { sessionStorage?: FakeStorage; localStorage?: FakeStorage; window?: unknown }
g.window = globalThis // a browser tab, as far as the module can tell (adopt is a no-op without it)
function freshStores() { g.sessionStorage = new FakeStorage(); g.localStorage = new FakeStorage(); return { s: g.sessionStorage, l: g.localStorage } }

async function loadModule(): Promise<CacheModule> {
  const p = process.env.VERIFY_CLIENT_CACHE
  if (!p) return import('../src/lib/clientCache')
  const abs = resolve(p)
  const unwrap = (m: CacheModule & { default?: CacheModule }) => (typeof m.readCache === 'function' ? m : m.default!)
  try { return unwrap(await import(pathToFileURL(abs).href)) } catch { return unwrap(createRequire(resolve('package.json'))(abs) as CacheModule) }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e)) out.push(p)
  }
  return out
}

// ── §1 source ───────────────────────────────────────────────────────────────
console.log('\n── §1 one owner, leased writes, named first, cleared at sign-out ──')
{
  const cache = strip(read('src/lib/clientCache.ts'))
  const layout = strip(read('src/app/dashboard/layout.tsx'))
  const ownerCmp = strip(read('src/components/layout/CacheOwner.tsx'))
  const sidebar = strip(read('src/components/layout/Sidebar.tsx'))
  check('a write needs a lease that is still current: same owner AND same generation',
    /export function writeCache[\s\S]*?if \(!isCurrentLease\(lease\)\) return/.test(cache)
    && /export function isCurrentLease[\s\S]*?return !!lease && !!owner && lease\.owner === owner && lease\.gen === gen/.test(cache))
  {
    // The in-memory business snapshot (hooks/useBusinessData) is read BEFORE
    // the persistent cache, so it carries its own owner and serves only that one.
    const bd = strip(read('src/hooks/useBusinessData.ts'))
    check('useBusinessData: the memory snapshot carries its owner and is served only while the cache names that owner',
      /let storeOwner: string \| null = null/.test(bd) && /function owned\(\): boolean \{ return store !== null && storeOwner === getCacheOwner\(\) \}/.test(bd)
      && /useSyncExternalStore\(subscribe, peekBusinessData, \(\) => null\)/.test(bd))
    check('useBusinessData: a foreign snapshot is dropped before any load or hydrate; the in-flight fetch is reused only under its own lease',
      /function dropForeign\(\)/.test(bd) && /export function loadBusinessData[\s\S]*?dropForeign\(\)\s*if \(inFlight && !force && isCurrentLease\(inFlightLease\)\) return inFlight/.test(bd)
      && /export function ensureBusinessData[\s\S]*?dropForeign\(\)/.test(bd))
    check('useBusinessData: a completion whose lease is no longer current applies nothing, in memory or on disk',
      /if \(!isCurrentLease\(lease\)\) return snap/.test(bd) && /storeOwner = lease!\.owner/.test(bd) && /writeCache\(CACHE_KEY, snap, \{ lease \}\)/.test(bd))
  }
  check('every write is stamped with the LEASE\'s owner, never the current one', /JSON\.stringify\(\{ t: Date\.now\(\), data, o: lease!?\.owner \}/.test(cache) && !/o: owner \}/.test(cache))
  check('cacheLease() snapshots owner + generation, null when no owner', /export function cacheLease\(\)[\s\S]*?return owner \? \{ owner, gen \} : null/.test(cache))
  check('the generation advances on every owner change: set, adopt, and the sign-out clear',
    (cache.match(/gen\+\+/g) || []).length === 3 && /export function clearOwnedCaches\(\): void \{\s*gen\+\+/.test(cache))
  check('a read answers only for the stamped owner, and nothing without an owner', /if \(!owner \|\| c\.o !== owner\)/.test(cache))
  check('a foreign entry is dropped only when an owner is known', /if \(owner\) s\.removeItem\(PREFIX \+ key\)/.test(cache))
  check('adopt is a no-op on the server (client component renders there too)', /export function adoptCacheOwner\(id: string\): void \{\s*if \(typeof window === 'undefined'\) return/.test(cache))
  check('adopt is idempotent for the current owner', /if \(id === owner\) return/.test(cache))
  check('clearOwnedCaches removes only eq: keys whose value is this module\'s envelope; the module never calls Storage.clear()',
    /startsWith\(PREFIX\) && isEnvelope\(s\.getItem\(k\)\)/.test(cache) && /keys\.every\(k => k === 't' \|\| k === 'data' \|\| k === 'o'\)/.test(cache) && !/\.clear\(\)/.test(cache))
  check('adopting a different account than this device last served drops the namespace first (the marker lives outside eq:)',
    /const MARKER = 'eq-owner'/.test(cache) && /if \(last !== id\) \{\s*clearOwnedCaches\(\)/.test(cache))
  const cacheOwnerAt = layout.indexOf('<CacheOwner id={user.id} />')
  check('the dashboard layout names the owner from the server-verified user, FIRST',
    /import \{ CacheOwner \} from '@\/components\/layout\/CacheOwner'/.test(layout) && cacheOwnerAt > 0 && cacheOwnerAt < layout.indexOf('<Sidebar />') && cacheOwnerAt < layout.indexOf('{children}'))
  check('CacheOwner adopts during render AND in its effect (StrictMode), and clears on unmount',
    /if \(last\.current !== id\) \{ last\.current = id; adoptCacheOwner\(id\) \}/.test(ownerCmp)
    && /useEffect\(\(\) => \{ adoptCacheOwner\(id\); return \(\) => \{ setCacheOwner\(null\) \} \}, \[id\]\)/.test(ownerCmp))
  const so = sidebar.indexOf('async function handleSignOut')
  const clearAt = sidebar.indexOf('clearOwnedCaches()', so)
  const signOutAt = sidebar.indexOf("signOut({ scope: 'global' })", so)
  check('the sidebar\'s sign-out empties the namespace BEFORE ending the session',
    /import \{ clearOwnedCaches \} from '@\/lib\/clientCache'/.test(sidebar) && so > 0 && clearAt > so && signOutAt > clearAt)

  // Every writer threads its lease. The two customer pages are deferred BY NAME
  // to their owner (ROOT/S111 hold that surface); until threaded they write
  // nothing — fail closed — and this list is where that debt is recorded.
  const DEFERRED = ['src/app/dashboard/customers/page.tsx', 'src/app/dashboard/customers/[id]/page.tsx']
  // Discovery must see generic calls too — `writeCache<FieldBundle>(` — or the
  // schedule bundle, the prefetch and the second customer page vanish from the pin.
  const CALL = /writeCache(?:<[^>]*>)?\(/g
  const writers = walk('src').filter(f => !/[\\/]lib[\\/]clientCache\.ts$/.test(f)).map(f => f.replace(/\\/g, '/')).filter(f => CALL.test(strip(read(f))) && (CALL.lastIndex = 0, true))
  check('discovery sees every writer, generic calls included (14 files: 12 threaded + 2 deferred)', writers.length === 14, `found ${writers.length}: ${writers.join(', ')}`)
  const unleased = writers.filter(f => {
    const s = strip(read(f))
    return [...s.matchAll(/writeCache(?:<[^>]*>)?\(/g)].some(m => !/lease\s*\}\)/.test(s.slice(m.index!, m.index! + 900)))
  })
  const threaded = writers.filter(f => !unleased.includes(f))
  check(`every writer outside the deferred list captures a lease at fetch start and passes it (${threaded.length} files threaded)`,
    unleased.every(f => DEFERRED.includes(f)) && threaded.every(f => /const lease = cacheLease\(\)/.test(strip(read(f))) && /import \{ cacheLease,/.test(read(f))),
    `unleased outside the list: ${unleased.filter(f => !DEFERRED.includes(f)).join(', ') || 'none'}; threaded without capture: ${threaded.filter(f => !/const lease = cacheLease\(\)/.test(strip(read(f)))).join(', ') || 'none'}`)
  info(`deferred (cache OFF there until threaded): ${unleased.filter(f => DEFERRED.includes(f)).join(', ') || 'none — the list can be emptied'}`)
  const CACHE_KEYS = ['revintel', 'bi', 'labor', 'marketing', 'comms', 'acquisition', 'suggestions', 'customers-list', 'quotes-list', 'invoices-list',
    'schedule-field-bundle', 'business-data', 'analytics-core', 'business-memory', 'quote-pricing-model', 'travel-model', 'cust:']
  const direct = walk('src').filter(f => !/[\\/]lib[\\/]clientCache\.ts$/.test(f))
    .filter(f => { const s = strip(read(f)); return CACHE_KEYS.some(k => new RegExp(`(getItem|setItem)\\(\\s*['"\`]eq:${k.replace(/[-:]/g, m => '\\' + m)}`).test(s)) })
  check('no file outside the module reads or writes a cache key around the owner check', direct.length === 0, direct.join(', '))
}

// ── §2 behaviour ─────────────────────────────────────────────────────────────
async function main() {
  const mod = await loadModule()
  if (process.env.VERIFY_CLIENT_CACHE) console.log(`\n(§2 against ${resolve(process.env.VERIFY_CLIENT_CACHE)})`)
  const m = mod as CacheModule & { setCacheOwner?: (id: string | null) => void; clearOwnedCaches?: () => void; adoptCacheOwner?: (id: string) => void; cacheLease?: () => CacheLease | null }
  const setOwner = (id: string | null) => m.setCacheOwner?.(id)
  const clearOwned = () => m.clearOwnedCaches?.()
  const adopt = (id: string) => m.adoptCacheOwner?.(id)
  const leaseNow = (): CacheLease | null => m.cacheLease?.() ?? null
  const { readCache, CACHE_TTL } = mod
  // Writers take their lease at fetch start; these helpers do the same at call time.
  const W = <T,>(key: string, data: T, opts?: { persist?: boolean }) => mod.writeCache(key, data, { ...opts, lease: leaseNow() })
  const A = 'acct-a-0000', B = 'acct-b-1111'
  const REPORT = { total: 1234, opportunities: ['upsell: synthetic'] }
  const BUNDLE = { jobs: [{ id: 'j1', title: 'synthetic visit' }], settings: { company_name: 'Synthetic Co' } }
  const FIELD = { persist: true }

  console.log('\n── §2 the same account keeps its cache ──')
  let { s, l } = freshStores()
  adopt(A)
  W('revintel', REPORT)
  W('schedule-field-bundle', BUNDLE, FIELD)
  check('A reads its own report back (sessionStorage)', JSON.stringify(readCache('revintel', CACHE_TTL.medium)) === JSON.stringify(REPORT))
  check('A reads its own field bundle back (localStorage, persist)', JSON.stringify(readCache('schedule-field-bundle', CACHE_TTL.field, FIELD)) === JSON.stringify(BUNDLE))
  check('the stored entries carry A\'s stamp', (s.getItem('eq:revintel') || '').includes(`"o":"${A}"`) && (l.getItem('eq:schedule-field-bundle') || '').includes(`"o":"${A}"`),
    `raw=${(s.getItem('eq:revintel') || '').slice(0, 80)}`)

  console.log('\n── §2 same tab, no sign-out (session expired, another account signs in) ──')
  setOwner(B)
  const bReport = readCache('revintel', CACHE_TTL.medium)
  check('B does NOT read A\'s report', bReport === null, `B got: ${JSON.stringify(bReport)}`)
  const bBundle = readCache('schedule-field-bundle', CACHE_TTL.field, FIELD)
  check('B does NOT read A\'s persisted field bundle', bBundle === null, `B got: ${JSON.stringify(bBundle)?.slice(0, 80)}`)
  check('…and A\'s foreign entries are dropped from the device', s.getItem('eq:revintel') === null && l.getItem('eq:schedule-field-bundle') === null)
  W('revintel', { total: 9 })
  check('B writes and reads its own', JSON.stringify(readCache('revintel', CACHE_TTL.medium)) === '{"total":9}')
  setOwner(A)
  check('back as A: B\'s entry is not A\'s to read', readCache('revintel', CACHE_TTL.medium) === null)

  console.log('\n── §2 explicit sign-out empties exactly this module\'s entries ──')
  ;({ s, l } = freshStores())
  adopt(A)
  W('revintel', REPORT); W('customers-list', [{ id: 'c1' }]); W('cust:c1', { name: 'x' })
  W('schedule-field-bundle', BUNDLE, FIELD)
  l.setItem('eq:legacy-report', JSON.stringify({ t: Date.now(), data: REPORT }))
  s.setItem('eq-logo', '{"url":null}'); s.setItem('eq_measurement', '{}'); l.setItem('eq-theme', 'dark'); l.setItem('eq-draft-c1', 'hello'); l.setItem('eq-logo', '{"url":null}')
  l.setItem('eq:recents', '["customers","quotes"]'); l.setItem('eq:draft:quote:q1', JSON.stringify({ ts: 1, fields: { title: 'draft' } }))
  l.setItem('eq:upload-queue', JSON.stringify([{ id: 'u1' }])); l.setItem('eq:photo-ctx', JSON.stringify({ propertyId: 'p1', t: 5 }))
  const before = { s: s.length, l: l.length }
  clearOwned()
  setOwner(null)
  const envelopes = ['eq:revintel', 'eq:customers-list', 'eq:cust:c1'].map(k => s.getItem(k)).concat([l.getItem('eq:schedule-field-bundle'), l.getItem('eq:legacy-report')])
  check('after sign-out every entry this module wrote is gone from both stores (the legacy unstamped one too)', envelopes.every(v => v === null),
    `session=${s.keys().join(',')} local=${l.keys().join(',')}`)
  check('…and nothing else was touched: other modules\' eq:-prefixed keys (recents, drafts, upload queue, photo context) and eq-logo / eq-theme / handoffs survive',
    s.length === before.s - 3 && l.length === before.l - 2 && l.getItem('eq:recents') === '["customers","quotes"]' && l.getItem('eq:draft:quote:q1') !== null
    && l.getItem('eq:upload-queue') !== null && l.getItem('eq:photo-ctx') !== null && s.getItem('eq-logo') !== null && l.getItem('eq-theme') === 'dark' && l.getItem('eq-draft-c1') === 'hello',
    `session=${s.keys().join(',')} local=${l.keys().join(',')}`)
  check('sign-out never called Storage.clear()', s.clears === 0 && l.clears === 0)

  console.log('\n── §2 cold start on a shared device (localStorage survived, sessionStorage did not) ──')
  ;({ s, l } = freshStores())
  adopt(A); W('schedule-field-bundle', BUNDLE, FIELD); setOwner(null)
  g.sessionStorage = new FakeStorage()
  check('before the layout names anyone: nothing is served…', readCache('schedule-field-bundle', CACHE_TTL.field, FIELD) === null)
  check('…and nothing is dropped (it may be this account\'s, read too early)', l.getItem('eq:schedule-field-bundle') !== null)
  setOwner(B)
  check('the layout names B: A\'s bundle is not served', readCache('schedule-field-bundle', CACHE_TTL.field, FIELD) === null)
  check('…and is dropped', l.getItem('eq:schedule-field-bundle') === null)
  ;({ s, l } = freshStores())
  adopt(A); W('schedule-field-bundle', BUNDLE, FIELD); setOwner(null)
  g.sessionStorage = new FakeStorage()
  adopt(A)
  check('the layout names A again: A\'s offline bundle is still there for A', JSON.stringify(readCache('schedule-field-bundle', CACHE_TTL.field, FIELD)) === JSON.stringify(BUNDLE))

  console.log('\n── §2 the device marker: adoption after an account change drops the namespace ──')
  ;({ s, l } = freshStores())
  setOwner(null) // a fresh device: no owner yet (adopt is idempotent for the current owner and would not write the marker into fresh storage)
  adopt(A)
  W('revintel', REPORT); W('schedule-field-bundle', BUNDLE, FIELD); l.setItem('eq-theme', 'dark')
  setOwner(null); g.sessionStorage = new FakeStorage()
  adopt(A)
  check('the same account adopting again keeps its persisted bundle (offline access preserved)', JSON.stringify(readCache('schedule-field-bundle', CACHE_TTL.field, FIELD)) === JSON.stringify(BUNDLE))
  check('…and the marker names A', l.getItem('eq-owner') === A)
  setOwner(null)
  adopt(B)
  check('another account adopting drops A\'s namespace before B reads anything', l.getItem('eq:schedule-field-bundle') === null && readCache('schedule-field-bundle', CACHE_TTL.field, FIELD) === null,
    `local=${l.keys().join(',')}`)
  check('…the marker now names B, and unrelated storage is untouched', l.getItem('eq-owner') === B && l.getItem('eq-theme') === 'dark')
  l.setItem('eq:schedule-field-bundle', JSON.stringify({ t: Date.now(), data: BUNDLE, o: A }))
  setOwner(null); g.sessionStorage = new FakeStorage()
  adopt(A)
  check('an offline cold start on a stale shell naming A (marker says B) drops A\'s bundle instead of serving it',
    l.getItem('eq:schedule-field-bundle') === null && readCache('schedule-field-bundle', CACHE_TTL.field, FIELD) === null)
  setOwner(null)

  console.log('\n── §2 THE LATE WRITE: a fetch started by A that lands after B adopted writes nothing ──')
  ;({ s, l } = freshStores())
  adopt(A)
  const leaseA = leaseNow()
  check('A\'s fetch starts with A\'s lease', leaseA?.owner === A)
  clearOwned(); setOwner(null)   // A signs out: Sidebar clears, the layout unmounts
  adopt(B)                       // B signs in — a client navigation; this module survives
  mod.writeCache('revintel', REPORT, { lease: leaseA })  // A's report lands now
  check('the late write is REFUSED: nothing stored under B', s.getItem('eq:revintel') === null, `raw=${s.getItem('eq:revintel')}`)
  check('…so B reads no report', readCache('revintel', CACHE_TTL.medium) === null)
  mod.writeCache('schedule-field-bundle', BUNDLE, { persist: true, lease: leaseA })
  check('…the persisted bundle path refuses the same way', l.getItem('eq:schedule-field-bundle') === null)
  W('revintel', { total: 9 })
  check('a write under B\'s own current lease lands, stamped B (positive control)', JSON.stringify(readCache('revintel', CACHE_TTL.medium)) === '{"total":9}' && (s.getItem('eq:revintel') || '').includes(`"o":"${B}"`))
  ;({ s, l } = freshStores())
  adopt(A); const leaseA2 = leaseNow(); adopt(B)   // session expiry: no sign-out at all
  mod.writeCache('revintel', REPORT, { lease: leaseA2 })
  check('the session-expiry ordering (A → B with no sign-out) refuses the late write too', s.getItem('eq:revintel') === null)
  ;({ s, l } = freshStores())
  adopt(A); const leaseA3 = leaseNow(); setOwner(null); adopt(A)   // the same account, a new session of it
  mod.writeCache('revintel', REPORT, { lease: leaseA3 })
  check('the same account\'s NEW session refuses a lease from its previous one (generation, not just owner)', s.getItem('eq:revintel') === null)
  W('revintel', REPORT)
  check('…and a fresh lease lands', JSON.stringify(readCache('revintel', CACHE_TTL.medium)) === JSON.stringify(REPORT))
  ;({ s, l } = freshStores())
  adopt(A); const leaseA4 = leaseNow(); clearOwned()   // sign-out's clear, before the layout has unmounted
  mod.writeCache('revintel', REPORT, { lease: leaseA4 })
  check('the sign-out clear itself invalidates in-flight fetches (a late write cannot refill what was just cleared)', s.getItem('eq:revintel') === null)
  mod.writeCache('revintel', REPORT, { lease: null }); mod.writeCache('bi', REPORT)
  check('a write with no lease writes nothing (fail closed)', s.getItem('eq:revintel') === null && s.getItem('eq:bi') === null)
  setOwner(null)

  console.log('\n── §2 React StrictMode lifecycle: render → effect → cleanup → effect ──')
  ;({ s, l } = freshStores())
  adopt(A)                                   // render (first paint): adopted
  const lease1 = leaseNow()
  W('bi', REPORT)                            // a fetch that started from the first effect pass lands here
  adopt(A)                                   // effect: idempotent
  check('the effect\'s adopt is idempotent: owner kept, generation unchanged', m.getCacheOwner() === A && JSON.stringify(leaseNow()) === JSON.stringify(lease1))
  setOwner(null)                             // StrictMode cleanup
  check('the cleanup clears the owner', m.getCacheOwner() === null)
  adopt(A)                                   // effect re-run
  const lease2 = leaseNow()
  check('the effect re-run re-adopts: the cache is ON in development', m.getCacheOwner() === A && lease2 !== null && lease2.gen !== lease1!.gen)
  check('…and A\'s entry from before the cycle is still served (same account, marker unchanged, nothing cleared)', JSON.stringify(readCache('bi', CACHE_TTL.medium)) === JSON.stringify(REPORT))
  mod.writeCache('labor', REPORT, { lease: lease1 })
  check('a lease from before the cleanup is refused (that fetch is the duplicated one)', s.getItem('eq:labor') === null)
  W('labor', REPORT)
  check('a lease from after the re-run lands', JSON.stringify(readCache('labor', CACHE_TTL.medium)) === JSON.stringify(REPORT))
  setOwner(null)

  console.log('\n── §2 the server: no window, no Storage ──')
  {
    const savedWindow = g.window; const savedS = g.sessionStorage; const savedL = g.localStorage
    delete g.window; delete g.sessionStorage; delete g.localStorage
    let threw = false
    try { adopt(A); adopt(B) } catch { threw = true }
    check('adopt on the server does not throw and sets NO owner (a per-tab fact, never per-process)', !threw && m.getCacheOwner() === null && leaseNow() === null, `owner=${m.getCacheOwner()}`)
    check('…so a read answers "no cache" and a write writes nothing, without throwing', (() => { try { return readCache('revintel', CACHE_TTL.medium) === null && (mod.writeCache('revintel', REPORT, { lease: { owner: A, gen: 1 } }), true) } catch { return false } })())
    g.window = savedWindow; g.sessionStorage = savedS; g.localStorage = savedL
  }

  // ── §3 the in-memory business snapshot, through the REAL hook module ──────
  // The hook module is loaded through require so its `@/lib/supabase/client`
  // resolves to a stub (a fake session + three fake tables) and its
  // `@/lib/clientCache` resolves to the SAME instance the guard drives.
  if (!process.env.VERIFY_CLIENT_CACHE) {
    console.log('\n── §3 useBusinessData: the memory snapshot belongs to one account (real hook module, stubbed client) ──')
    const req = createRequire(resolve('package.json'))
    const clientPath = req.resolve('./src/lib/supabase/client')
    let fakeUser: string | null = null
    let fetches = 0
    // While `hold` is set every session read waits; release() resumes them all, in order.
    let hold = false
    const waiters: (() => void)[] = []
    const release = () => { hold = false; waiters.splice(0).forEach(r => r()) }
    const rows: Record<string, Record<string, unknown>> = {
      [A]: { company_name: 'A Co', owner_name: 'Alice', phone: '111' },
      [B]: { company_name: 'B Co', owner_name: 'Bob', phone: '222' },
    }
    const builder = (result: unknown) => {
      const b = { select: () => b, eq: () => b, order: () => Promise.resolve({ data: [] }), maybeSingle: () => Promise.resolve({ data: result }) }
      return b
    }
    const fakeClient = {
      auth: { getSession: async () => { fetches++; if (hold) await new Promise<void>(r => { waiters.push(r) }); return { data: { session: fakeUser ? { user: { id: fakeUser } } : null } } } },
      from: (table: string) => builder(table === 'business_settings' && fakeUser ? rows[fakeUser] : null),
    }
    req.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: { createClient: () => fakeClient } } as unknown as NodeJS.Module
    const cc = req('./src/lib/clientCache') as CacheModule
    const bd = req('./src/hooks/useBusinessData') as typeof import('../src/hooks/useBusinessData')
    check('§3 setup: the hook module and the guard share ONE clientCache instance', cc.getCacheOwner === (mod as CacheModule).getCacheOwner || cc.readCache === mod.readCache)
    const CC = cc.getCacheOwner === (mod as CacheModule).getCacheOwner ? mod : cc  // drive whichever instance the hook sees
    const drive = { adopt: (id: string) => CC.adoptCacheOwner(id), set: (id: string | null) => CC.setCacheOwner(id), clear: () => CC.clearOwnedCaches() }

    ;({ s, l } = freshStores())
    drive.set(null); drive.adopt(A); fakeUser = A
    await bd.loadBusinessData(); await tick()
    check('§3 A loads: the memory snapshot is A\'s and the persistent copy is stamped A',
      (bd.peekBusinessData()?.settings as { company_name?: string } | null)?.company_name === 'A Co' && (s.getItem('eq:business-data') || '').includes(`"o":"${A}"`),
      JSON.stringify(bd.peekBusinessData()?.settings))
    const fetchesAfterA = fetches
    bd.ensureBusinessData(); await tick()
    check('§3 the same account\'s fresh snapshot short-circuits the fetch (stale-while-revalidate kept)', fetches === fetchesAfterA)

    // S123's chain: A → B in one tab, no sign-out; B's first read happens BEFORE any fetch.
    drive.adopt(B); fakeUser = B
    check('§3 B\'s FIRST read after the owner changed is null — never A\'s settings (the reviewed 2-minute window is closed)', bd.peekBusinessData() === null, JSON.stringify(bd.peekBusinessData()?.settings))
    bd.ensureBusinessData()
    check('§3 …and B\'s mount does fetch (the freshness gate is per-account): +1 fetch', fetches === fetchesAfterA + 1)
    await tick(); await tick()
    check('§3 B\'s own snapshot lands', (bd.peekBusinessData()?.settings as { company_name?: string } | null)?.company_name === 'B Co')

    // A late completion: A's fetch is in flight when B adopts.
    ;({ s, l } = freshStores())
    drive.set(null); drive.adopt(A); fakeUser = A
    hold = true // every session read now waits: A's fetch is in flight when B adopts
    const pendingA = bd.loadBusinessData()
    await tick()
    drive.adopt(B); fakeUser = B
    check('§3 with A\'s fetch in flight, B reads null', bd.peekBusinessData() === null)
    const fetchesBeforeB = fetches
    const pendingB = bd.loadBusinessData()
    check('§3 B does not reuse A\'s in-flight fetch: a new one starts', fetches === fetchesBeforeB + 1)
    release() // A resumes first (FIFO), then B — A's completion lands while B is the owner
    await pendingA; await tick()
    check('§3 A\'s late completion applies nothing: memory is not A\'s and nothing is stamped', (bd.peekBusinessData()?.settings as { company_name?: string } | null)?.company_name !== 'A Co' && !(s.getItem('eq:business-data') || '').includes(`"o":"${A}"`))
    await pendingB; await tick()
    check('§3 B\'s completion lands (memory and persistent copy stamped B)', (bd.peekBusinessData()?.settings as { company_name?: string } | null)?.company_name === 'B Co' && (s.getItem('eq:business-data') || '').includes(`"o":"${B}"`))
    const fetchesBefore2 = fetches
    const p1 = bd.loadBusinessData(); const p2 = bd.loadBusinessData()
    check('§3 two loads for the same account share one fetch (dedupe kept)', p1 === p2 && fetches === fetchesBefore2 + 1)
    await p1; await tick()

    // Hydration from the persistent cache is owner-checked and re-tags memory.
    ;({ s, l } = freshStores())
    drive.set(null); drive.adopt(A); fakeUser = A
    await bd.loadBusinessData(); await tick()
    drive.set(null)                           // layout unmount (sign-out without the clear, or a route outside)
    check('§3 with no owner named, the snapshot is not served', bd.peekBusinessData() === null)
    drive.adopt(A)
    bd.ensureBusinessData()
    check('§3 the same account back: served again (memory re-owned or rehydrated from its own persistent copy)', (bd.peekBusinessData()?.settings as { company_name?: string } | null)?.company_name === 'A Co')
    await tick(); await tick()
    drive.set(null)
    fakeUser = null
  }

  console.log('\n── §2 legacy, unknown owner, TTL, throwing store ──')
  ;({ s, l } = freshStores())
  adopt(A)
  s.setItem('eq:revintel', JSON.stringify({ t: Date.now(), data: REPORT }))
  check('a legacy entry with no stamp is rejected…', readCache('revintel', CACHE_TTL.medium) === null)
  check('…and dropped', s.getItem('eq:revintel') === null)
  setOwner(null)
  W('revintel', REPORT)
  check('with no owner known, nothing is written', s.getItem('eq:revintel') === null)
  s.setItem('eq:revintel', JSON.stringify({ t: Date.now(), data: REPORT, o: A }))
  check('with no owner known, an owned entry is neither served nor dropped', readCache('revintel', CACHE_TTL.medium) === null && s.getItem('eq:revintel') !== null)
  adopt(A)
  s.setItem('eq:revintel', JSON.stringify({ t: Date.now() - 10 * 60_000, data: REPORT, o: A }))
  check('TTL still applies under the right owner (10 min old, 5 min TTL → null; 36 h TTL → data)',
    readCache('revintel', CACHE_TTL.medium) === null && JSON.stringify(readCache('revintel', CACHE_TTL.field)) === JSON.stringify(REPORT))
  s.throwing = true; l.throwing = true
  let threw = false
  try { W('revintel', REPORT); clearOwned(); if (readCache('revintel', CACHE_TTL.medium) !== null) threw = true } catch { threw = true }
  check('a throwing store is "no cache": no throw on read, write or sign-out clear', !threw)
  s.throwing = false; l.throwing = false
  setOwner(null)
}

// A promise that never settles drains the event loop and Node exits 0 with no
// summary — which once made this guard read as green while it had stopped
// halfway. Ending without the summary is a failure.
let finished = false
process.on('exit', code => {
  if (!finished) { console.log(`\n✗ verify:client-cache-isolation — ended before its summary (a promise never settled); ${pass} passed, ${fail} failed so far`); process.exitCode = code || 1 }
})
main().then(() => {
  finished = true
  console.log(`\n${fail ? '✗' : '✅'} verify:client-cache-isolation — the client cache answers to one account: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}).catch(e => { finished = true; console.error(e); process.exit(1) })
