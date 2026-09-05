// ── verify:client-cache-isolation — the client cache answers to one account ──
//   npx tsx scripts/verify-client-cache-isolation.ts
//   VERIFY_CLIENT_CACHE=<path/to/other/clientCache.ts> npx tsx scripts/verify-client-cache-isolation.ts
//     → §2 against another implementation (negative control: a copy of the
//       pre-fix module must FAIL the isolation cases — that run IS the
//       reproduction of the finding, on the real code, with synthetic storage).
//
// What is being guarded. lib/clientCache keeps reports, lists, business memory
// and the persisted field bundle in sessionStorage / localStorage under bare
// `eq:<key>` keys. Nothing cleared them at sign-out and nothing stamped them, so
// on ONE device the next account's first paint could be the previous account's
// data (same tab within TTL; the persisted bundle across an app kill, offline
// included). Not a remote exploit; a shared-device information boundary.
//
// §1 SOURCE: entries are stamped with the owner and read only for the owner;
//    nothing is written before an owner is known; the dashboard layout names the
//    owner FIRST (before the sidebar and the page); CacheOwner sets it during
//    render and clears it on unmount; the sidebar's sign-out empties the `eq:`
//    namespace before ending the session; no file outside the module touches
//    `eq:` keys directly; the module never calls Storage.clear().
// §2 BEHAVIOUR against synthetic Storage (no browser, no network, no real data):
//    the same account keeps its entries (persisted included); another account —
//    same tab without sign-out, or a cold start on the same device — reads
//    nothing and the foreign entry is dropped; explicit sign-out removes exactly
//    the `eq:` keys and nothing else; legacy unstamped entries are rejected;
//    with no owner known nothing is written and nothing is dropped; TTL still
//    applies; a throwing store is a "no cache", never an error.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

type CacheModule = typeof import('../src/lib/clientCache')

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}
const read = (p: string) => readFileSync(p, 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '')

// ── synthetic Storage ────────────────────────────────────────────────────────
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
const g = globalThis as unknown as { sessionStorage: FakeStorage; localStorage: FakeStorage }
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
console.log('\n── §1 one owner, named first, cleared at sign-out ──')
{
  const cache = strip(read('src/lib/clientCache.ts'))
  const layout = strip(read('src/app/dashboard/layout.tsx'))
  const ownerCmp = strip(read('src/components/layout/CacheOwner.tsx'))
  const sidebar = strip(read('src/components/layout/Sidebar.tsx'))
  check('every write is stamped with the owner', /JSON\.stringify\(\{ t: Date\.now\(\), data, o: owner \}/.test(cache))
  check('a read answers only for the stamped owner, and nothing without an owner', /if \(!owner \|\| c\.o !== owner\)/.test(cache))
  check('a foreign entry is dropped only when an owner is known', /if \(owner\) s\.removeItem\(PREFIX \+ key\)/.test(cache))
  check('nothing is written before an owner is known', /export function writeCache[\s\S]*?\{\s*if \(!owner\) return/.test(cache))
  check('clearOwnedCaches removes only eq: keys whose value is this module\'s envelope; the module never calls Storage.clear()',
    /startsWith\(PREFIX\) && isEnvelope\(s\.getItem\(k\)\)/.test(cache) && /keys\.every\(k => k === 't' \|\| k === 'data' \|\| k === 'o'\)/.test(cache) && !/\.clear\(\)/.test(cache))
  const cacheOwnerAt = layout.indexOf('<CacheOwner id={user.id} />')
  check('the dashboard layout names the owner from the server-verified user',
    /import \{ CacheOwner \} from '@\/components\/layout\/CacheOwner'/.test(layout) && cacheOwnerAt > 0)
  check('…FIRST: before the Sidebar and before the page', cacheOwnerAt > 0 && cacheOwnerAt < layout.indexOf('<Sidebar />') && cacheOwnerAt < layout.indexOf('{children}'))
  check('CacheOwner adopts the owner during render (not in an effect) and clears it on unmount',
    /if \(last\.current !== id\) \{ last\.current = id; adoptCacheOwner\(id\) \}/.test(ownerCmp) && /useEffect\(\(\) => \(\) => \{ setCacheOwner\(null\) \}, \[\]\)/.test(ownerCmp))
  check('adopting a different account than this device last served drops the namespace first (the marker lives outside eq:)',
    /const MARKER = 'eq-owner'/.test(cache) && /if \(last !== id\) \{\s*clearOwnedCaches\(\)/.test(cache))
  const so = sidebar.indexOf('async function handleSignOut')
  const clearAt = sidebar.indexOf('clearOwnedCaches()', so)
  const signOutAt = sidebar.indexOf("signOut({ scope: 'global' })", so)
  check('the sidebar\'s sign-out empties the namespace BEFORE ending the session',
    /import \{ clearOwnedCaches \} from '@\/lib\/clientCache'/.test(sidebar) && so > 0 && clearAt > so && signOutAt > clearAt)
  // Other modules legitimately own `eq:`-prefixed keys of their own (drafts, the
  // upload queue, palette recents…). What must not exist is a second writer of
  // THIS module's envelope shape or a reader of its keys around the owner check.
  const CACHE_KEYS = ['revintel', 'bi', 'labor', 'marketing', 'comms', 'acquisition', 'suggestions', 'customers-list', 'quotes-list', 'invoices-list',
    'schedule-field-bundle', 'business-data', 'analytics-core', 'business-memory', 'quote-pricing-model', 'travel-model', 'cust:']
  const direct = walk('src').filter(f => !/[\\/]lib[\\/]clientCache\.ts$/.test(f))
    .filter(f => { const s = strip(read(f)); return CACHE_KEYS.some(k => new RegExp(`(getItem|setItem)\\(\\s*['"\`]eq:${k.replace(/[-:]/g, m => '\\' + m)}`).test(s)) })
  // (businessMemory / quoteLearning removeItem their own key directly to invalidate — a removal serves nothing, so it is not in scope here.)
  check('no file outside the module reads or writes a cache key around the owner check', direct.length === 0, direct.join(', '))
  const callers = ['src/app/dashboard/revenue-intelligence/page.tsx', 'src/app/dashboard/intelligence/page.tsx', 'src/app/dashboard/customers/page.tsx',
    'src/app/dashboard/quotes/page.tsx', 'src/app/dashboard/invoices/page.tsx', 'src/app/dashboard/schedule/page.tsx', 'src/hooks/useBusinessData.ts',
    'src/lib/analyticsData.ts', 'src/lib/businessMemory.ts', 'src/lib/quoteLearning.ts', 'src/lib/travelLearning.ts', 'src/lib/prefetch.ts', 'src/components/grow/SuggestionsCenter.tsx']
  const off = callers.filter(f => !/from '@\/lib\/clientCache'/.test(read(f)))
  check('every known caller still goes through the module (13 files)', off.length === 0, off.join(', '))
}

// ── §2 behaviour ─────────────────────────────────────────────────────────────
async function main() {
  const mod = await loadModule()
  if (process.env.VERIFY_CLIENT_CACHE) console.log(`\n(§2 against ${resolve(process.env.VERIFY_CLIENT_CACHE)})`)
  const m = mod as CacheModule & { setCacheOwner?: (id: string | null) => void; clearOwnedCaches?: () => void }
  const setOwner = (id: string | null) => m.setCacheOwner?.(id)
  const clearOwned = () => m.clearOwnedCaches?.()
  const adopt = (id: string) => (m as { adoptCacheOwner?: (id: string) => void }).adoptCacheOwner?.(id)
  const { readCache, writeCache, CACHE_TTL } = mod
  const A = 'acct-a-0000', B = 'acct-b-1111'
  const REPORT = { total: 1234, opportunities: ['upsell: synthetic'] }
  const BUNDLE = { jobs: [{ id: 'j1', title: 'synthetic visit' }], settings: { company_name: 'Synthetic Co' } }
  const FIELD = { persist: true }

  console.log('\n── §2 the same account keeps its cache ──')
  let { s, l } = freshStores()
  setOwner(A)
  writeCache('revintel', REPORT)
  writeCache('schedule-field-bundle', BUNDLE, FIELD)
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
  writeCache('revintel', { total: 9 })
  check('B writes and reads its own', JSON.stringify(readCache('revintel', CACHE_TTL.medium)) === '{"total":9}')
  setOwner(A)
  check('back as A: B\'s entry is not A\'s to read', readCache('revintel', CACHE_TTL.medium) === null)

  console.log('\n── §2 explicit sign-out empties exactly the eq: namespace ──')
  ;({ s, l } = freshStores())
  setOwner(A)
  writeCache('revintel', REPORT); writeCache('customers-list', [{ id: 'c1' }]); writeCache('cust:c1', { name: 'x' })
  writeCache('schedule-field-bundle', BUNDLE, FIELD)
  l.setItem('eq:legacy-report', JSON.stringify({ t: Date.now(), data: REPORT })) // an unstamped entry from before this change
  // Other modules' own eq:-prefixed keys — the same prefix, NOT this module's envelope. A sign-out must leave every one of them.
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
  setOwner(A); writeCache('schedule-field-bundle', BUNDLE, FIELD); setOwner(null)
  g.sessionStorage = new FakeStorage() // a new tab / app relaunch
  check('before the layout names anyone: nothing is served…', readCache('schedule-field-bundle', CACHE_TTL.field, FIELD) === null)
  check('…and nothing is dropped (it may be this account\'s, read too early)', l.getItem('eq:schedule-field-bundle') !== null)
  setOwner(B)
  check('the layout names B: A\'s bundle is not served', readCache('schedule-field-bundle', CACHE_TTL.field, FIELD) === null)
  check('…and is dropped', l.getItem('eq:schedule-field-bundle') === null)
  ;({ s, l } = freshStores())
  setOwner(A); writeCache('schedule-field-bundle', BUNDLE, FIELD); setOwner(null)
  g.sessionStorage = new FakeStorage()
  setOwner(A)
  check('the layout names A again: A\'s offline bundle is still there for A', JSON.stringify(readCache('schedule-field-bundle', CACHE_TTL.field, FIELD)) === JSON.stringify(BUNDLE))

  console.log('\n── §2 the device marker: adoption after an account change drops the namespace ──')
  ;({ s, l } = freshStores())
  adopt(A)
  writeCache('revintel', REPORT); writeCache('schedule-field-bundle', BUNDLE, FIELD); l.setItem('eq-theme', 'dark')
  setOwner(null); g.sessionStorage = new FakeStorage() // A's session expires; app relaunched
  adopt(A)
  check('the same account adopting again keeps its persisted bundle (offline access preserved)', JSON.stringify(readCache('schedule-field-bundle', CACHE_TTL.field, FIELD)) === JSON.stringify(BUNDLE))
  check('…and the marker names A', l.getItem('eq-owner') === A)
  setOwner(null)
  adopt(B) // B signs in on the same device without A ever signing out
  check('another account adopting drops A\'s namespace before B reads anything', l.getItem('eq:schedule-field-bundle') === null && readCache('schedule-field-bundle', CACHE_TTL.field, FIELD) === null,
    `local=${l.keys().join(',')}`)
  check('…the marker now names B, and unrelated storage is untouched', l.getItem('eq-owner') === B && l.getItem('eq-theme') === 'dark')
  // The offline shell case: the service worker serves a field shell whose HTML
  // still names A (cached while A was signed in) after B became the device's
  // account; A's stale bundle is still on disk. Adopting A against a marker of B
  // must drop it, not serve it.
  l.setItem('eq:schedule-field-bundle', JSON.stringify({ t: Date.now(), data: BUNDLE, o: A }))
  setOwner(null); g.sessionStorage = new FakeStorage()
  adopt(A)
  check('an offline cold start on a stale shell naming A (marker says B) drops A\'s bundle instead of serving it',
    l.getItem('eq:schedule-field-bundle') === null && readCache('schedule-field-bundle', CACHE_TTL.field, FIELD) === null)
  setOwner(null)

  console.log('\n── §2 legacy, unknown owner, TTL, throwing store ──')
  ;({ s, l } = freshStores())
  setOwner(A)
  s.setItem('eq:revintel', JSON.stringify({ t: Date.now(), data: REPORT }))
  check('a legacy entry with no stamp is rejected…', readCache('revintel', CACHE_TTL.medium) === null)
  check('…and dropped', s.getItem('eq:revintel') === null)
  setOwner(null)
  writeCache('revintel', REPORT)
  check('with no owner known, nothing is written', s.getItem('eq:revintel') === null)
  s.setItem('eq:revintel', JSON.stringify({ t: Date.now(), data: REPORT, o: A }))
  check('with no owner known, an owned entry is neither served nor dropped', readCache('revintel', CACHE_TTL.medium) === null && s.getItem('eq:revintel') !== null)
  setOwner(A)
  s.setItem('eq:revintel', JSON.stringify({ t: Date.now() - 10 * 60_000, data: REPORT, o: A }))
  check('TTL still applies under the right owner (10 min old, 5 min TTL → null; 36 h TTL → data)',
    readCache('revintel', CACHE_TTL.medium) === null && JSON.stringify(readCache('revintel', CACHE_TTL.field)) === JSON.stringify(REPORT))
  s.throwing = true; l.throwing = true
  let threw = false
  try { writeCache('revintel', REPORT); clearOwned(); if (readCache('revintel', CACHE_TTL.medium) !== null) threw = true } catch { threw = true }
  check('a throwing store is "no cache": no throw on read, write or sign-out clear', !threw)
  s.throwing = false; l.throwing = false
  setOwner(null)
}

main().then(() => {
  console.log(`\n${fail ? '✗' : '✅'} verify:client-cache-isolation — the client cache answers to one account: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}).catch(e => { console.error(e); process.exit(1) })
