// ── Verify: a failed Growth refresh says so, keeps the last figures labelled stale, offers retry ──
//   npm run verify:growth-refresh
//
// What the data layer hands the page, proven through the REAL loadRevenueIntel
// with a stub client: an object when every read succeeds, NULL when any read
// errors (its honesty gate), a THROW when a read rejects (dropped connection).
// The page used to handle only the first: `if (res) {…}` with no else and a
// try/finally with no catch, so a failed refresh left the previous figures on
// screen as if current — nothing said, nothing dated, no retry — and a refresh
// that emptied the selected kind hid its filter pill while the filter still
// applied, leaving "No opportunities in this view yet" under no visible filter.
//
// ⛔ FIXTURE DATA ONLY. No database, no network, no browser.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadRevenueIntel } from '../src/lib/revenueIntelligence'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, c: boolean, d = '') => (c ? ok(n) : fail(n, d))

// A stub Supabase client: every table read answers; one table per run can
// error or reject. Enough of the builder chain for loadRevenueIntel's calls.
type Row = Record<string, unknown>
function stubClient(opts: { failTable?: string; rejectTable?: string }) {
  const tables: Record<string, Row[]> = {
    jobs: [], quotes: [], job_recurrences: [], properties: [],
    customers: [{ id: 'c1', name: 'Customer One', created_at: '2025-01-01', referred_by_customer_id: null }],
    invoices: [], job_line_items: [], business_settings: [], revenue_recommendations: [],
  }
  const builder = (table: string) => {
    const result = () => {
      if (opts.rejectTable === table) return Promise.reject(new TypeError('fetch failed'))
      if (opts.failTable === table) return Promise.resolve({ data: null, error: { message: 'stub: read failed', code: 'XX000' } })
      return Promise.resolve({ data: tables[table] ?? [], error: null })
    }
    const chain: Record<string, unknown> = {
      select: () => chain, eq: () => chain,
      maybeSingle: () => result().then((r: { data: unknown; error: unknown }) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data })),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => result().then(res, rej),
    }
    return chain
  }
  return {
    auth: { getSession: async () => ({ data: { session: { user: { id: '11111111-1111-4111-8111-111111111111' } } } }) },
    from: builder,
  } as unknown as Parameters<typeof loadRevenueIntel>[0]
}

async function main() {
  console.log('\n── 1. What the loader hands the page on failure (real loadRevenueIntel, stub reads) ──')
  const okRes = await loadRevenueIntel(stubClient({}))
  check('every read ok → an object with a report', !!okRes && Array.isArray(okRes.report.opportunities), '')
  check('one read errors (invoices) → null, the honesty gate, not a partial report', (await loadRevenueIntel(stubClient({ failTable: 'invoices' }))) === null, '')
  let threw = false
  try { await loadRevenueIntel(stubClient({ rejectTable: 'customers' })) } catch { threw = true }
  check('one read rejects (dropped connection) → the loader THROWS', threw, '')

  console.log('\n── 2. The page handles both — and keeps, labels and dates what it already has ──')
  const src = readFileSync(join(process.cwd(), 'src/app/dashboard/revenue-intelligence/page.tsx'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n\r]*/g, ' ')
  const loadFn = (code.match(/async function load\(\) \{[\s\S]*?\n  \}/) || [''])[0]
  check('load() has a null branch that records the failure', /else setRefreshError\(/.test(loadFn), loadFn.slice(0, 200))
  check('…and a catch that records a throw', /catch[\s\S]{0,40}setRefreshError\(/.test(loadFn), '')
  check('…and never clears the report on failure', !/setReport\(null\)/.test(code), '')
  check('…and marks the refresh in progress (spinner + aria-busy), clearing the error when retried',
    /setLoading\(true\)/.test(loadFn) && /setRefreshError\(null\)/.test(loadFn) && /aria-busy=\{loading\}/.test(code) && /animate-spin/.test(code), '')
  // Anchored to the closing </p>: a lazy match to the first `)}` stops inside
  // `toISOString())}` and truncates the block before the words under test.
  const staleLine = (code.match(/\{refreshError && \([\s\S]*?<\/p>\s*\)\}/) || [''])[0]
  check('a failed refresh renders ONE alert line that says it failed and that the figures shown are older',
    /role="alert"/.test(staleLine) && /\{refreshError\}/.test(staleLine) && /out of date/.test(staleLine), staleLine.slice(0, 160))
  check('…dating them from the last successful load (or "earlier results" for the session cache)',
    /timeAgo\(new Date\(loadedAt\)/.test(staleLine) && /earlier results/.test(staleLine), '')
  check('…with a Retry that calls load()', /onClick=\{load\}[^>]*>Retry</.test(staleLine), '')
  check('the no-data error state retries in place rather than reloading the whole page',
    /onClick=\{load\}[^>]*>try again</.test(code) && !/window\.location\.reload/.test(code), '')

  console.log('\n── 3. Filters survive a refresh, visibly ──')
  check('the selected kind\'s pill stays visible when its count drops to zero', /n === 0 && filter !== k\) return null/.test(code), '')
  check('filter state lives outside the report (a refresh cannot reset it)', /useState<OppKind \| 'all'>\('all'\)/.test(code) && !/setFilter\('all'\)\s*$/m.test(loadFn), '')

  console.log(failures === 0 ? '\n✅ growth refresh: a failed refresh is said, dated, retryable — and never a silent "no opportunities"\n' : `\n❌ ${failures} check(s) failed\n`)
  process.exit(failures === 0 ? 0 : 1)
}
main()
