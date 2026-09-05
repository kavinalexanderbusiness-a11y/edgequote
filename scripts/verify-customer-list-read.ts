// ── verify:customer-list-read — a failed list read is not an empty book ──────
//
//   npm run verify:customer-list-read
//
// THE DEFECT THIS PINS, reproduced before it was fixed. The customers list did
//
//     setCustomers(activeRes.data || [])
//
// with no inspection of `res.error`. PostgREST answers a failed read with
// `{ data: null, error: {...} }`, so a dropped connection became an empty array,
// and CustomerList renders an empty array as
//
//     "No customers yet — Add your first customer, or import your existing list…"
//
// in front of a business with hundreds of them. It then wrote that empty array
// to the session cache, and the cache read is `if (cached)` — an empty array is
// truthy — so the next visit painted the same wrong answer instantly, with no
// skeleton, before the network was even consulted.
//
// ⭐ Everything here is offline and synthetic: hand-built PostgREST-shaped
// results. No credential, no network, no real record, no rendering.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listRead, readCachedCustomers, type ListRead } from '../src/lib/customers'

const ROOT = join(__dirname, '..')
let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}
const H = (t: string) => console.log(`\n── ${t} ──\n`)
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

type Row = { id: string; name: string }
const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: `ZZ Synthetic ${i}` }))
const FALLBACK = 'Could not load your customers.'
/** The refusal message, or null when the read produced rows. */
const msgOf = (r: ListRead<Row>): string | null => (r.ok ? null : r.message)
const rowsOf = (r: ListRead<Row>): Row[] | null => (r.ok ? r.rows : null)

function section1() {
  H('1 · the three PostgREST shapes, told apart')

  check('a SMALL list of rows reads as rows',
    rowsOf(listRead<Row>({ data: rows(3), error: null }, FALLBACK))?.length === 3)

  check('a LARGE list reads as rows, unmodified and untruncated', (() => {
    const got = rowsOf(listRead<Row>({ data: rows(5000), error: null }, FALLBACK))
    return got?.length === 5000 && got[4999].id === 'c4999'
  })())

  check('a GENUINELY EMPTY book reads as zero rows — not as an error',
    rowsOf(listRead<Row>({ data: [], error: null }, FALLBACK))?.length === 0)

  check('⛔ an ERROR reads as an error, never as an empty list',
    msgOf(listRead<Row>({ data: null, error: { message: 'network' } }, FALLBACK)) === 'network')

  // A real shape (aborted fetch, HEAD/count request). `|| []` cannot tell this
  // from an empty book, which is exactly how the defect stayed invisible.
  check('⛔ {data:null, error:null} — "no answer" — is an error, not zero rows',
    msgOf(listRead<Row>({ data: null, error: null }, FALLBACK)) === FALLBACK)

  check('an error with no message still says something a human can read',
    msgOf(listRead<Row>({ data: null, error: {} }, FALLBACK)) === FALLBACK)

  check('[negative control] rows and the empty book are NOT conflated', (() => {
    const a = rowsOf(listRead<Row>({ data: rows(1), error: null }, FALLBACK))
    const b = rowsOf(listRead<Row>({ data: [], error: null }, FALLBACK))
    return a?.length === 1 && b?.length === 0
  })())
}

// The list loader awaits Promise.all over two reads. A slow failure must not be
// mistaken for a slow success.
const delayed = <T,>(v: T, ms: number) => new Promise<T>(r => setTimeout(() => r(v), ms))
type Res = { data: Row[] | null; error: { message?: string | null } | null }

async function section2() {
  H('2 · a DELAYED failure still resolves to an error, not to rows')
  const [okRes, errRes] = await Promise.all([
    delayed<Res>({ data: rows(2), error: null }, 5),
    delayed<Res>({ data: null, error: { message: 'timeout after 30s' } }, 15),
  ])
  const a = listRead<Row>(okRes, FALLBACK)
  const b = listRead<Row>(errRes, FALLBACK)
  check('the fast success is rows', rowsOf(a)?.length === 2)
  check('⛔ the slow failure is an error', msgOf(b) === 'timeout after 30s')
  check('either half failing is enough to refuse the whole read', !(a.ok && b.ok))
}

function section3() {
  H('3 · the customers page actually uses it')
  const page = read('src/app/dashboard/customers/page.tsx')

  check('⛔ no `|| []` coercion survives on the list read',
    !/set(Customers|Archived)\([^)]*\.data \|\| \[\]\)/.test(page),
    'a `.data || []` on a list read is the defect itself')
  check('the page keeps a loadError, like the properties page beside it',
    /const \[loadError, setLoadError\] = useState<string \| null>\(null\)/.test(page))
  check('the loader returns EARLY on a failed read, before any setCustomers', (() => {
    const guard = page.indexOf('if (!active.ok || !arch.ok)')
    const setRows = page.indexOf('setCustomers(active.rows)')
    return guard > -1 && setRows > -1 && guard < setRows
  })())
  check('⛔ nothing is written to the cache on a failed read', (() => {
    const guard = page.indexOf('if (!active.ok || !arch.ok)')
    const cache = page.indexOf("writeCache('customers-list'")
    return guard > -1 && cache > -1 && guard < cache
  })(), 'a bad answer must not outlive the request that produced it')
  check('a successful read CLEARS a previous error', /setLoadError\(null\)/.test(page))
}

function section4() {
  H('4 · a recoverable failure does not cost the owner their filters')
  const page = read('src/app/dashboard/customers/page.tsx')
  check('⭐ the error card replaces the list ONLY when there are no rows to show',
    /loadError && customers\.length === 0 \?/.test(page),
    "search and the consent filter are CustomerList's own useState — unmounting it discards them")
  check('refresh errors remain visible even when cached rows exist',
    /\{loadError && \(/.test(page) && /role="alert"/.test(page))
  check('retry does not unmount existing customer filters behind a skeleton',
    !/onClick=\{[^\n]*setLoading\(true\)[^\n]*fetchCustomers/.test(page))
  check('a failed first read does not claim there are zero customers',
    /description=\{loadError \?/.test(page))
  check('the error state offers a retry rather than dead-ending',
    /Try again/.test(page) && /void fetchCustomers\(\)/.test(page))
}

function section5() {
  H('5 · the genuinely-empty book still says so')
  // ⚠️ SOURCE, not a render. verify-all runs plain `tsx scripts/<name>.ts` and the
  // repo tsconfig is `jsx: preserve`, so a component cannot be transpiled here.
  // The RENDERED proof was run separately as the pre-fix reproduction and is
  // recorded in outputs/s123-customer-property-list-reliability.md; this pins the
  // branch that produced it.
  const list = read('src/components/customers/CustomerList.tsx')
  check('an empty list still says "No customers yet" — correct copy WHEN TRUE',
    /customers\.length === 0 \?/.test(list) && /No customers yet/.test(list))
  check('…and still offers the first action', /Add your first customer/.test(list))
  check('⛔ the empty state carries no error wording, so the two states stay distinct',
    !/could not load|couldn.t load/i.test(list))
}

function section6() {
  H('6 · a CACHED PREFIX is not the book')
  // S111 v5 review, finding 1. The session cache holds the first 100 active
  // customers. A revisit paints them with loading=false, and three surfaces then
  // presented that prefix as the whole book:
  //
  //   header   "100 customers in your database"      for a book of 240
  //   footer   "100 customers"                       (RENDER_CAP is also 100, so
  //                                                   the "showing N of M" branch
  //                                                   never fires at exactly 100)
  //   search   "No customers match “Nguyen”"         about a real customer who is
  //                                                   simply row 140
  //
  // The third is the one that changes what the owner DOES. It is reachable with a
  // book over 100, a revisit inside the 2-minute TTL, and a refresh that fails —
  // and it is on screen from the cached paint onward, including while the
  // background refresh is still pending.

  // ── the derivation, EXECUTED (not a regex over the page) ─────────────────
  const p = <T,>(raw: unknown) => readCachedCustomers<T>(raw)

  check('the current shape reports the prefix AND the real total', (() => {
    const got = p<Row>({ rows: rows(100), total: 240 })
    return got?.rows.length === 100 && got.partial?.shown === 100 && got.partial?.total === 240
  })())

  check('⭐ a book of EXACTLY 100 is complete, not partial', (() => {
    const got = p<Row>({ rows: rows(100), total: 100 })
    return got?.rows.length === 100 && got.partial === null
  })(), 'the row count alone cannot tell these apart — that is why the total is cached')

  check('a small book is complete', p<Row>({ rows: rows(7), total: 7 })?.partial === null)

  check('[anti-vacuity] the same 100 rows read differently by total alone', (() => {
    const a = p<Row>({ rows: rows(100), total: 240 })
    const b = p<Row>({ rows: rows(100), total: 100 })
    return a?.rows.length === b?.rows.length && !!a?.partial !== !!b?.partial
  })())

  check('a LEGACY bare-array entry still yields its rows', p<Row>(rows(40))?.rows.length === 40)
  check('…a short legacy entry is complete', p<Row>(rows(40))?.partial === null)
  check('⭐ …a FULL legacy entry is reported partial with an unknown total', (() => {
    const got = p<Row>(rows(100))
    return got?.partial?.shown === 100 && got.partial.total === null
  })(), 'over-qualifying is honest; a false "complete" is not')

  check('no entry is no answer', p<Row>(null) === null && p<Row>(undefined) === null)
  check('a shape this module did not write is refused, not coerced', (() => (
    p<Row>('x') === null && p<Row>(42) === null && p<Row>({}) === null &&
    p<Row>({ rows: rows(3) }) === null && p<Row>({ rows: 'no', total: 3 }) === null &&
    p<Row>({ rows: rows(3), total: Number.NaN }) === null
  ))(), 'a half-written entry must read as "no cache", never as a complete book')

  // ── the surfaces, pinned in source ───────────────────────────────────────
  const page = read('src/app/dashboard/customers/page.tsx')
  const list = read('src/components/customers/CustomerList.tsx')

  check('the page carries the partial status as state',
    /const \[partial, setPartial\] = useState<PartialList \| null>\(null\)/.test(page))
  check('⛔ …set from the CACHE read, so it is true while the refresh is still pending',
    /setCustomers\(cached\.rows\); setPartial\(cached\.partial\)/.test(page),
    'qualifying only on the error path would leave the pending window lying')
  check('…and cleared only by a successful read', /setPartial\(null\)/.test(page) && (() => {
    const ok = page.indexOf('setLoadError(null)')
    const clear = page.indexOf('setPartial(null)')
    return ok > -1 && clear > ok
  })())
  check('the cache write carries the total beside the slice',
    /writeCache\('customers-list', \{ rows: active\.rows\.slice\(0, CUSTOMER_CACHE_ROWS\), total: active\.rows\.length \}, \{ lease \}\)/.test(page))
  check('⛔ the cache still holds a SCREENFUL — the fix is not "cache the whole book"',
    /slice\(0, CUSTOMER_CACHE_ROWS\)/.test(page) && !/writeCache\('customers-list', active\.rows\)/.test(page))
  check('⛔ the header states no bare count while the rows are a prefix',
    /: partial \? \(partial\.total/.test(page) && /First \$\{partial\.shown\} of/.test(page))
  check('the error card names the prefix rather than "the last loaded customers"',
    /Showing the first \$\{partial\.shown\} of \$\{partial\.total\.toLocaleString\(\)\} customers from your last visit\./.test(page))
  check('the status reaches the list', /incomplete=\{partial\}/.test(page))

  check('⛔ the search empty state no longer claims the whole book has no match',
    /No \{incomplete \? 'match' : 'customers match'\}/.test(list) &&
    /in the first \{incomplete\.shown\} loaded/.test(list),
    'a false negative about a real customer is the finding this section exists for')
  check('…and it says how many are still missing', /customers haven’t loaded yet\./.test(list))
  check('…and offers loading the rest, beside Clear', /Load the rest/.test(list) && /void onRefresh\(\)/.test(list))
  check('⛔ the footer count is qualified while incomplete',
    /: incomplete\n/.test(list) && /of the first \{incomplete\.shown\} loaded/.test(list) &&
    /\{incomplete\.shown\} of \{incomplete\.total\.toLocaleString\(\)\} customers loaded/.test(list))
  check('the complete-book copy is untouched for a complete book',
    /\{filtered\.length\.toLocaleString\(\)\} customer\{filtered\.length !== 1 \? 's' : ''\}/.test(list) &&
    /No customers yet/.test(list))
  check('⭐ search, the consent filter and Try again are still the list\'s own state',
    /const \[search, setSearch\] = useState\(''\)/.test(list) &&
    /const \[consentFilter, setConsentFilter\] = useState<ConsentFilter>\(''\)/.test(list) &&
    /Try again/.test(page),
    'the repair must not cost the owner their filters — §4 is what that protects')
}

async function main() {
  section1()
  await section2()
  section3()
  section4()
  section5()
  section6()
  console.log(fail === 0
    ? `\n✓ customer-list-read: ${pass} checks passed\n`
    : `\n✗ customer-list-read: ${fail} failed, ${pass} passed\n`)
  process.exit(fail === 0 ? 0 : 1)
}
main()
