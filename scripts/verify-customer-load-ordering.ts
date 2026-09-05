// ── verify:customer-load-ordering — one full load owns the customer detail screen ──
//   npx tsx scripts/verify-customer-load-ordering.ts
//
// The customer detail page's full load (a useEffect on [id, tick]) had no
// in-flight guard: reload() — the realtime `customers`-row / tab-wake burst,
// Retry, Try again, the timeline's retry, the edit save — re-ran it while a
// previous run was still awaiting, and whichever run finished LAST wrote the
// screen and the prefetch cache. A slow first read resolving after a fresh
// retry overwrote newer rows (and cached them); a slow first read that FAILED
// raised its "could not load" banner over a successful retry. Same customer
// throughout — an id change unmounts the instance (Next keys the [id] segment
// subtree by its value), so this is about ORDER, not identity.
//
// §1 SOURCE: the effect retires itself through its cleanup (`let active`,
//    `return () => { active = false }`) and checks after each of its three
//    awaits; every full run advances `loadGen`; a narrow refetch captures it and
//    writes only while no newer full run has begun; the readMissing /
//    partial-cache / lease logic is unchanged.
// §2 EXECUTED, not modelled: the effect's and narrowRefetch's REAL source text is
//    lifted from the page, transpiled (esbuild), and run with a chainable fake
//    Supabase client whose reads resolve only when the case says so. Cases:
//    a run alone applies everything (positive control); a run retired at each
//    of its three awaits applies nothing afterwards — no state, no banner, no
//    cache write — while the newer run lands; a retired run's FAILED read
//    raises no banner; a narrow refetch retired by a newer full load writes no
//    slice; a narrow refetch alone writes its slice (positive control).
//    Limit, stated: a narrow refetch that starts DURING a full load is not
//    retired by it; the older full run may still overwrite that slice. No
//    browser, no renderer, no session, no data.
import { readFileSync } from 'node:fs'
import { transform } from 'esbuild'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}
const info = (s: string) => console.log(`  ℹ ${s}`)
const PAGE = 'src/app/dashboard/customers/[id]/page.tsx'
const raw = readFileSync(PAGE, 'utf8').replace(/\r\n/g, '\n')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// ── lift the two real bodies ────────────────────────────────────────────────
function lift(): { effect: string; narrow: string } {
  const loadAt = raw.indexOf('async function load()')
  const effStart = raw.lastIndexOf('useEffect(() => {', loadAt)
  const effEnd = raw.indexOf('}, [id, tick])', loadAt)
  const nStart = raw.indexOf('const narrowRefetch = useCallback(async (scopes: Set<string>) => {')
  const nEnd = raw.indexOf('}, [supabase, id])', nStart)
  if ([loadAt, effStart, effEnd, nStart, nEnd].some(i => i < 0)) throw new Error('could not locate the effect / narrowRefetch in the page')
  return {
    effect: raw.slice(effStart + 'useEffect(() => {'.length, effEnd),
    narrow: raw.slice(nStart + 'const narrowRefetch = useCallback(async (scopes: Set<string>) => {'.length, nEnd),
  }
}
const { effect, narrow } = lift()
const effectSrc = strip(effect), narrowSrc = strip(narrow)

// ── §1 source ───────────────────────────────────────────────────────────────
console.log('\n── §1 the effect retires itself; narrow refetches yield to a newer full load; nothing else moved ──')
check('the effect declares its ownership flag and retires it in the cleanup', /let active = true/.test(effectSrc) && /return \(\) => \{ active = false \}/.test(effectSrc))
check('every run advances the generation', /loadGen\.current \+= 1/.test(effectSrc))
check('the session read is followed by the retirement check before anything else', /await supabase\.auth\.getSession\(\)\s*if \(!active\) return\s*const user = session\?\.user/.test(effectSrc))
check('both Promise.all batches are followed by the retirement check', (effectSrc.match(/\]\)\s*if \(!active\) return/g) || []).length === 2)
check('exactly three retirement checks — one per await', (effectSrc.match(/if \(!active\) return/g) || []).length === 3)
check('readMissing / partial-cache / lease logic unchanged: failed slices named, clean-only cache write under the fetch lease',
  /setReadMissing\(failedSlices\)/.test(effectSrc) && /if \(cust && failedSlices\.length === 0\) writeCache<CustomerPrefetch>\(custCacheKey\(id\), \{/.test(effectSrc) && /\}, \{ lease \}\)/.test(effectSrc) && /const lease = cacheLease\(\)/.test(effectSrc))
check('the narrow refetch captures the generation and writes only while it is still current',
  /const gen = loadGen\.current\s*const live = \(\) => gen === loadGen\.current/.test(narrowSrc) && (narrowSrc.match(/if \(!live\(\)\) return/g) || []).length === 6)
check('the page comment keeps the identity fact straight: an id change unmounts the instance (segment keyed by value)', /an id change already unmounts this instance/.test(effect) && /keyed by/.test(effect))
check('no in-flight abort or sequence machinery beyond the flag and the generation (minimal)', !/AbortController|loadSeq|generation counter/.test(effectSrc))

// ── the synthetic browser side ──────────────────────────────────────────────
interface Deferred { chain: string[]; run: string; resolve: (v: unknown) => void; settled: boolean }
const pending: Deferred[] = []
let currentRun = 'none'
const calls: { run: string; name: string; arg: unknown }[] = []
const writes: { run: string; key: string; lease: unknown }[] = []
const g = globalThis as unknown as Record<string, unknown>

function chain(parts: string[]): unknown {
  const target = function () {}
  return new Proxy(target, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'then') {
        const d: Deferred = { chain: parts, run: currentRun, resolve: () => {}, settled: false }
        const promise = new Promise<unknown>(res => { d.resolve = (v: unknown) => { d.settled = true; res(v) } })
        pending.push(d)
        return (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => promise.then(onF, onR)
      }
      if (prop === 'catch') return (onR: (e: unknown) => unknown) => Promise.resolve(undefined).catch(onR)
      return chain([...parts, String(prop)])
    },
    apply() { return chain(parts) },
  })
}
const resultFor = (d: Deferred, fail?: { table: string }) => {
  const last = d.chain[d.chain.length - 1]
  if (d.chain[0] === 'auth') return { data: { session: { user: { id: 'user-1' } } } }
  const table = d.chain[1]
  if (fail && table === fail.table) return { data: null, error: { code: 'NET', message: 'connection reset' } }
  if (last === 'single' || last === 'maybeSingle') return { data: { id: 'c1', name: `customer as of ${d.run}`, notes: '', referred_by_customer_id: null }, error: null }
  return { data: [{ id: `${table}-row of ${d.run}` }], error: null }
}
/** Resolve every unsettled read the given run has issued so far, attributing what follows to that run. */
async function settle(run: string, fail?: { table: string }) {
  currentRun = run
  const mine = pending.filter(d => d.run === run && !d.settled)
  for (const d of mine) d.resolve(resultFor(d, fail))
  for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0))
}
const issued = (run: string) => pending.filter(d => d.run === run).length
const applied = (run: string, name: string) => calls.filter(c => c.run === run && c.name === name).length
// How many client reads the first batch issues — counted from the lifted source
// (the batch also carries two helper calls that are stubs here, not reads).
const batch1Text = effectSrc.slice(effectSrc.indexOf('] = await Promise.all(['), effectSrc.indexOf('])', effectSrc.indexOf('] = await Promise.all([')))
const BATCH1 = (batch1Text.match(/supabase\./g) || []).length
const AFTER_BATCH1 = 1 + BATCH1

async function main() {
  const js = (await transform(`function __effect() {${effect}}\nasync function __narrow(scopes) {${narrow}}`, { loader: 'ts', target: 'es2020' })).code
  // Everything the two bodies reach for, as recorders / stubs on the global scope.
  const setters = [...new Set([...effect.matchAll(/\bset[A-Z]\w*/g), ...narrow.matchAll(/\bset[A-Z]\w*/g)].map(m => m[0]))]
  const stubs: Record<string, unknown> = {
    id: 'c1',
    supabase: chain([]),
    cacheLease: () => ({ owner: 'acct-a', gen: 7 }),
    custCacheKey: (i: string) => `cust:${i}`,
    writeCache: (key: string, _data: unknown, opts: { lease?: unknown }) => { writes.push({ run: currentRun, key, lease: opts?.lease }) },
    loadBusinessShape: () => Promise.resolve('shape'),
    SHAPE_LOADING: 'shape-loading',
    loadCustomerTimelineSources: () => Promise.resolve({ sources: {}, missing: [] }),
    loadJobTimelineSources: () => Promise.resolve({ sources: {}, missing: [] }),
    settingsToSeasons: () => null,
    sumQuoteAmounts: () => ({ total: 0 }),
    isWon: () => false,
    editingNotesRef: { current: false },
    loadGen: { current: 0 },
  }
  for (const s of setters) stubs[s] = (arg: unknown) => { calls.push({ run: currentRun, name: s, arg }) }
  const installed = Object.keys(stubs)
  for (const k of installed) g[k] = stubs[k]
  const fns = new Function(`${js}\nreturn { __effect, __narrow }`)() as { __effect: () => () => void; __narrow: (scopes: Set<string>) => Promise<void> }
  const reset = () => { pending.length = 0; calls.length = 0; writes.length = 0; (stubs.loadGen as { current: number }).current = 0 }
  const runEffect = (run: string) => { currentRun = run; return fns.__effect() }

  console.log('\n── §2 executed against the real effect text ──')
  // Positive control: one run, three rounds, everything lands, in order.
  reset()
  const c1 = runEffect('run1')
  check('a run issues exactly one read before its first await (the session)', issued('run1') === 1 && pending[0].chain.join('.') === 'auth.getSession')
  await settle('run1')
  check(`…then the first batch (${BATCH1} client reads, counted from the source)`, BATCH1 >= 8 && issued('run1') === AFTER_BATCH1, `issued=${issued('run1')}`)
  await settle('run1')
  check('…the batch applies: customer, slices, readMissing, one clean cache write under the fetch lease',
    applied('run1', 'setCustomer') === 1 && applied('run1', 'setQuotes') === 1 && applied('run1', 'setReadMissing') === 1 && writes.length === 1 && writes[0].key === 'cust:c1' && JSON.stringify(writes[0].lease) === '{"owner":"acct-a","gen":7}', JSON.stringify({ calls: calls.map(c => c.name), writes }))
  await settle('run1')
  check('…and the tail lands last: timeline sources, then loading=false', applied('run1', 'setTlSources') === 1 && calls[calls.length - 1].name === 'setLoading' && calls[calls.length - 1].arg === false)
  c1()
  check('cleanup after completion is inert (nothing further recorded)', calls.length === calls.length)

  // Retired at await 1: the reviewed ordering — reload() before the first read answers.
  reset()
  const c2a = runEffect('run1'); c2a()          // React: cleanup of run1 …
  runEffect('run2')                            // … then the re-run
  await settle('run2'); await settle('run2'); await settle('run2')
  check('run2 (the later run) lands fully', applied('run2', 'setLoading') === 1 && writes.filter(w => w.run === 'run2').length === 1)
  const before = { calls: calls.length, writes: writes.length, reads: issued('run1') }
  await settle('run1')                         // run1's session read finally answers
  check('run1, retired before its session read answered, issues no batch and applies nothing', issued('run1') === before.reads && calls.length === before.calls && writes.length === before.writes,
    `reads +${issued('run1') - before.reads}, calls +${calls.length - before.calls}, writes +${writes.length - before.writes}`)

  // Retired at await 2: run1 had issued its batch; it answers after run2 landed.
  reset()
  const c3a = runEffect('run1'); await settle('run1')
  check('setup: run1 is awaiting its batch (all first-batch reads issued, nothing applied)', issued('run1') === AFTER_BATCH1 && applied('run1', 'setCustomer') === 0, `issued=${issued('run1')}`)
  c3a(); runEffect('run2')
  await settle('run2'); await settle('run2'); await settle('run2')
  const b3 = { calls: calls.length, writes: writes.length }
  await settle('run1')
  check('run1\'s batch answering after run2 landed applies NO state, writes NO cache, issues NO tail read (older rows never overwrite newer)', calls.length === b3.calls && writes.length === b3.writes && issued('run1') === AFTER_BATCH1,
    `calls +${calls.length - b3.calls}: ${calls.slice(b3.calls).map(c => `${c.run}:${c.name}`).join(',')}; writes +${writes.length - b3.writes}`)
  check('…the screen still shows run2\'s customer', String((calls.filter(c => c.name === 'setCustomer').pop()?.arg as { name?: string })?.name).includes('run2'))

  // Retired at await 2 with a FAILED customer read: the stale banner must not rise over the fresh retry.
  reset()
  const c4a = runEffect('run1'); await settle('run1')
  c4a(); runEffect('run2')
  await settle('run2'); await settle('run2'); await settle('run2')
  const b4 = applied('run1', 'setLoadError') + applied('run2', 'setLoadError')
  await settle('run1', { table: 'customers' })
  check('a retired run whose customer read FAILS raises no banner (setLoadError untouched) and does not stop loading', applied('run1', 'setLoadError') === 0 && applied('run1', 'setLoading') === 0 && applied('run2', 'setLoadError') === 1 && b4 === 1,
    `run1 setLoadError=${applied('run1', 'setLoadError')} run2 setLoadError=${applied('run2', 'setLoadError')}`)
  check('…and the last banner call on record is run2\'s clearing one (null)', (calls.filter(c => c.name === 'setLoadError').pop() as { arg: unknown })?.arg === null)

  // Retired at await 3: run1 applied its batch while current (legitimately), then its tail answers after run2.
  reset()
  const c5a = runEffect('run1'); await settle('run1'); await settle('run1')
  check('setup: run1 applied its batch while it was the current run', applied('run1', 'setCustomer') === 1 && writes.filter(w => w.run === 'run1').length === 1)
  c5a(); runEffect('run2')
  await settle('run2'); await settle('run2'); await settle('run2')
  const b5 = { tl: applied('run1', 'setTlSources'), loading: applied('run1', 'setLoading'), ref: applied('run1', 'setReferrer') }
  await settle('run1')
  check('run1\'s tail answering after run2 applies nothing (no timeline sources, no loading=false, no referrer)', applied('run1', 'setTlSources') === b5.tl && applied('run1', 'setLoading') === b5.loading && applied('run1', 'setReferrer') === b5.ref)
  check('…and loading=false on record came from run2', (calls.filter(c => c.name === 'setLoading' && c.arg === false).pop() as { run: string })?.run === 'run2')

  // Unmount (cleanup with no re-run): the pending run applies nothing.
  reset()
  const c6 = runEffect('run1'); await settle('run1'); c6()
  const b6 = calls.length
  await settle('run1')
  check('after unmount (cleanup, no re-run) a pending run applies nothing', calls.length === b6 && writes.length === 0)

  // Narrow refetch: alone it writes its slice; retired by a newer full load it writes nothing.
  reset()
  currentRun = 'narrow1'; const n1 = fns.__narrow(new Set(['quotes']))
  await settle('narrow1'); await n1
  check('positive control: a narrow refetch alone writes its slice and clears its name', applied('narrow1', 'setQuotes') === 1 && applied('narrow1', 'setReadMissing') === 1)
  reset()
  currentRun = 'narrow2'; const n2 = fns.__narrow(new Set(['quotes', 'jobs', 'invoices', 'payments']))
  check('setup: the narrow refetch has issued its reads', issued('narrow2') >= 3)
  runEffect('run3')                            // a full load starts AFTER the narrow refetch → it is superseded
  await settle('narrow2'); await settle('narrow2'); await n2
  check('a narrow refetch retired by a newer full load writes NO slice, names nothing, touches no timeline source', applied('narrow2', 'setQuotes') === 0 && applied('narrow2', 'setJobs') === 0 && applied('narrow2', 'setInvoices') === 0 && applied('narrow2', 'setReadMissing') === 0 && applied('narrow2', 'setTlSources') === 0 && applied('narrow2', 'setLoaderMissing') === 0,
    calls.filter(c => c.run === 'narrow2').map(c => c.name).join(','))
  info('limit (by design, not proven otherwise): a narrow refetch that starts DURING a full load is not retired by it; that older full run may still overwrite the slice the narrow refetch wrote. The realtime subscription stays live and the next event corrects it.')

  for (const k of installed) delete g[k]
}

main().then(() => {
  console.log(`\n${fail ? '✗' : '✅'} verify:customer-load-ordering — one full load owns the customer screen: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}).catch(e => { console.error(e); process.exit(1) })
