// ── Global search regression suite — `npm run verify:global-search` ──────────
//
// Global search is the one box an owner uses when they have forgotten which module
// a record lives in. Three of its failure modes are invisible to tsc and to a
// glance at the screen, and all three end with the owner believing something false:
//
//   · a dropped read rendered as "No results"      → "that customer was deleted"
//   · a stale response overwriting a newer one     → the wrong customer's invoice
//   · a tenant predicate lost from one branch      → another business's records
//
// So this suite proves the CONTRACT, not the plumbing: the pure engine
// (src/lib/globalSearch) runs for real, and the SQL and the palette are read off
// disk and asserted against. No network, no mocks, deterministic.
//
// Line endings: every file is normalised to \n before matching. A CRLF checkout
// makes `.` stop matching at \r, which silently turns a comment stripper into a
// no-op and inverts every absence check in here.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MIN_QUERY_LENGTH, SEARCH_LIMIT, hrefForRecord, toSearchRecords,
  invoiceMoneyContext, isSearchable, KIND_LABEL,
  type SearchRow, type RecordKind,
} from '../src/lib/globalSearch'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const H = (t: string) => console.log(`\n── ${t} ──`)

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const SQL = read('supabase/archive/run/RUN-2026-08-11-global-search.sql')
const PALETTE = read('src/components/command/CommandPalette.tsx')
const SCHEDULE = read('src/app/dashboard/schedule/page.tsx')
const INVOICES = read('src/app/dashboard/invoices/page.tsx')

// Comment-free views. Asserting "this file does not contain X" against a file whose
// comments explain X reports the cure as the disease.
const stripSql = (s: string) => s.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
const stripTs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const SQL_CODE = stripSql(SQL)
const PALETTE_CODE = stripTs(PALETTE)

const money = (n: number) => `$${n.toFixed(2)}`
const row = (over: Partial<SearchRow> & Pick<SearchRow, 'kind' | 'id'>): SearchRow => ({
  label: 'X', sub: null, rank: 30, customer_id: null, created_at: '2026-08-01T00:00:00Z',
  extra: {}, ...over,
})

// ═══════════════════════════════════════════════════════════════════════════
H('1. Tenancy — the boundary is server-side, on every source, and fails closed')

// auth.uid() is READ, never accepted. A p_user_id parameter would let any caller
// name the business whose records they want.
check('the function takes only a query and a limit',
  /create or replace function public\.search_records\(\s*p_query text,\s*p_limit int/i.test(SQL_CODE))
check('no caller-supplied user/business/tenant parameter',
  !/p_(user|business|tenant|owner)_?id/i.test(SQL_CODE))
check('the tenant comes from auth.uid()', /v_user\s+uuid\s*:=\s*auth\.uid\(\)/.test(SQL_CODE))

// Every source table must carry the predicate. Counted, not spot-checked: the way
// this breaks is one branch being added later without it.
const SOURCES = ['customers', 'properties', 'quotes', 'invoices', 'jobs']
const tenantPredicates = (SQL_CODE.match(/\.user_id\s*=\s*v_user/g) || []).length
check(`all ${SOURCES.length} branches carry user_id = v_user (found ${tenantPredicates})`,
  tenantPredicates === SOURCES.length, `expected ${SOURCES.length}`)
for (const t of SOURCES) {
  const re = new RegExp(`from public\\.${t}\\s+(\\w+)\\s+where\\s+\\1\\.user_id = v_user`, 'i')
  check(`${t}: scoped in the same statement it is read from`, re.test(SQL_CODE))
}

check('a null session returns [] before any table is touched',
  /if v_user is null then return '\[\]'::json; end if;/.test(SQL_CODE))
check('SECURITY DEFINER (so the predicates above ARE the boundary)',
  /security definer/i.test(SQL_CODE))
check('search_path is pinned', /set search_path to 'public'/i.test(SQL_CODE))

// A revoke from anon alone leaves the PUBLIC grant every role inherits.
check('execute revoked from PUBLIC', /revoke all on function public\.search_records\(text, int\) from public;/i.test(SQL_CODE))
check('execute revoked from anon', /revoke all on function public\.search_records\(text, int\) from anon;/i.test(SQL_CODE))
check('execute granted to authenticated only',
  /grant execute on function public\.search_records\(text, int\) to authenticated;/i.test(SQL_CODE))

// The client must not re-implement scoping — or worse, fetch broadly and filter in
// React. Four of the five record tables must be unreachable from the palette;
// `customers` stays only because the call/text VERB reads it (a command, not a
// record search), and that read carries its own .eq('user_id', uid).
for (const t of ['properties', 'quotes', 'invoices', 'jobs']) {
  check(`the palette never queries ${t} directly`, !PALETTE_CODE.includes(`from('${t}')`))
}
check('the one direct customers read (the call/text verb) is still tenant-scoped',
  !PALETTE_CODE.includes("from('customers')")
  || /from\('customers'\)[\s\S]{0,200}?\.eq\('user_id', uid\)/.test(PALETTE_CODE))

H('2. Query is data, not pattern syntax')
// String containment, not regex: the subject here IS backslash escaping, and
// writing it as a pattern is how the assertion ends up testing its own quoting.
check('backslash escaped first (before the escapes it introduces)',
  SQL_CODE.includes(String.raw`replace(replace(replace(v_raw, '\', '\\')`))
check("'%' escaped — otherwise one character returns the entire book",
  SQL_CODE.includes(String.raw`'%', '\%'`))
check("'_' escaped — otherwise it matches any single character",
  SQL_CODE.includes(String.raw`'_', '\_'`))

H('3. Minimum query — one floor, stated in both places')
check(`the engine's floor is ${MIN_QUERY_LENGTH}`, MIN_QUERY_LENGTH === 2)
check('the SQL applies the identical floor',
  new RegExp(`if length\\(v_raw\\) < ${MIN_QUERY_LENGTH} then return '\\[\\]'::json`).test(SQL_CODE))
check('isSearchable rejects one character', !isSearchable('a'))
check('isSearchable rejects whitespace padding around one character', !isSearchable('  a  '))
check('isSearchable accepts two', isSearchable('sa'))
check('the palette gates on MIN_QUERY_LENGTH before spending a request',
  /query\.length < MIN_QUERY_LENGTH/.test(PALETTE_CODE))
check('the limit the client asks for is within the RPC clamp', SEARCH_LIMIT <= 25)

H('4. Ranking — deterministic, and the identifier wins')
// The rank ladder must exist as literal integers, ordered, with a total tie-break.
for (const [rank, meaning] of [['0', 'exact identifier'], ['10', 'exact phone/email'],
  ['20', 'prefix'], ['30', 'partial']] as const) {
  check(`rank ${rank} (${meaning}) is assigned`, new RegExp(`then ${rank}\\b`).test(SQL_CODE))
}
// 40 is the fall-through: matched the WHERE clause on a secondary field.
check('rank 40 (secondary) is the fall-through on every branch',
  (SQL_CODE.match(/else 40\b/g) || []).length === SOURCES.length)
check('results are ordered by rank first', /order by\s+rank,/.test(SQL_CODE))
check('ties break to a total order (type, recency, id)',
  /h\.created_at desc, h\.id/.test(SQL_CODE) && /r\.created_at desc, r\.id/.test(SQL_CODE))
check('no fuzzy/similarity/AI relevance', !/similarity\(|<->|word_similarity|ts_rank|embedding/i.test(SQL_CODE))
check('an identifier match is checked on BOTH document types',
  (SQL_CODE.match(/= v_ident then 0/g) || []).length === 2)
check('a bare number matches a padded identifier on both types',
  (SQL_CODE.match(/= v_bare then 0/g) || []).length === 2)

H('5. Phone — formatting must never prevent a match')
// Same rule as lib/customers.phoneSearchDigits, restated in SQL.
check('letters or @ disqualify a phone read ("Rose 403" is a name)',
  /if v_raw ~ '\[A-Za-z@\]' then v_digits := ''/.test(SQL_CODE))
check('under 3 digits is not a phone query', /if length\(v_digits\) < 3 then v_digits := ''/.test(SQL_CODE))
check('matches the canonical generated column, not the formatted one',
  /c\.phone_digits/.test(SQL_CODE))
check('a raw-phone fallback still exists for non-phone-shaped queries',
  /v_digits =\s+'' and coalesce\(c\.phone, ''\) ilike v_like/.test(SQL_CODE))
check('an exact number outranks a partial one', /coalesce\(c\.phone_digits, ''\) = v_digits then 10/.test(SQL_CODE))
check('a long number matches on the last 10 digits (country-code tolerant)',
  /right\(coalesce\(c\.phone_digits, ''\), 10\) = right\(v_digits, 10\)/.test(SQL_CODE))

H('6. Address — the place and its customer both answer')
check('properties match on address', /p\.address ilike v_like/.test(SQL_CODE))
check('customers match on their own address, so both arrive together',
  /c\.address ilike v_like/.test(SQL_CODE))
check('property identity is not duplicated onto the customer row',
  !/properties.*join.*customers|customers.*join.*properties/i.test(SQL_CODE))

H('7. Deep links — every result opens the record, not a list')
const LINKS: [RecordKind, string, string][] = [
  ['customer', 'c1', '/dashboard/customers/c1'],
  ['property', 'p1', '/dashboard/properties/p1'],
  ['quote',    'q1', '/dashboard/quotes/q1'],
  ['job',      'j1', '/dashboard/schedule?job=j1'],
]
for (const [kind, id, want] of LINKS) {
  check(`${kind} → ${want}`, hrefForRecord({ kind, id }) === want, hrefForRecord({ kind, id }))
}
check('invoice → the ?invoice= focus seam',
  hrefForRecord({ kind: 'invoice', id: 'i1', ref: 'INV-0069' }) === '/dashboard/invoices?invoice=INV-0069')
check('an invoice number is URL-encoded',
  hrefForRecord({ kind: 'invoice', id: 'i1', ref: 'INV/69 A' }) === '/dashboard/invoices?invoice=INV%2F69%20A')
check('a numberless invoice falls back to the list rather than focusing nothing',
  hrefForRecord({ kind: 'invoice', id: 'i1', ref: null }) === '/dashboard/invoices')

// A deep link is only real if the destination reads it. These are the two seams
// that make the links above land somewhere.
check('the invoices page reads ?invoice=', /\.get\('invoice'\)/.test(INVOICES))
check('…and focuses the matching invoice by number',
  /i\.invoice_number === focus\.invoice/.test(INVOICES))
check('the schedule page reads ?job=', /searchParams\.get\('job'\)/.test(SCHEDULE))
check('?job= jumps the board to that visit and opens it',
  /const target = jobs\.find\(j => j\.id === jobParam\)/.test(SCHEDULE)
  && /setCursor\(parseISO\(target\.scheduled_date/.test(SCHEDULE)
  && /setEditing\(target\)/.test(SCHEDULE))
// ?customer= on the schedule is a CREATE door; routing a found visit through it
// would answer "here is the visit" with a blank form.
check('a visit result does not route through the create door',
  !/schedule\?customer=/.test(stripTs(read('src/lib/globalSearch.ts'))))

H('8. Every result states its type')
for (const k of ['customer', 'property', 'quote', 'invoice', 'job'] as RecordKind[]) {
  check(`${k} has a human label ("${KIND_LABEL[k]}")`, !!KIND_LABEL[k])
}
check('a visit is called a Visit, not a Job', KIND_LABEL.job === 'Visit')
check('the palette renders the type on the row', /KIND_LABEL\[item\.kind\]/.test(PALETTE_CODE))
check('records render as ONE ranked list, not per-type sections',
  /title: 'Results'/.test(PALETTE_CODE))

H('9. Money — canonical state only, never recomputed')
check('the SQL computes no balance', !/amount\s*-\s*amount_paid|balance/i.test(SQL_CODE))
check('the engine reads the canonical ledger',
  /from '@\/lib\/payments\/ledger'/.test(read('src/lib/globalSearch.ts')))

const INV = { amount: 100, amount_paid: 0, discount_type: null, discount_value: null,
  status: 'unpaid', due_date: '2026-12-31', viewed_at: null }
check('an open invoice quotes the balance',
  invoiceMoneyContext(INV, {}, '2026-08-11', money) === '$100.00 balance')
check('past its due date it says so',
  invoiceMoneyContext({ ...INV, due_date: '2026-01-01' }, {}, '2026-08-11', money) === '$100.00 balance · Overdue')
check('a part-paid invoice quotes what is LEFT',
  invoiceMoneyContext({ ...INV, amount_paid: 30 }, {}, '2026-08-11', money) === '$70.00 balance')
// A stored status can outlive the ledger. The balance is the truth.
check('fully paid but still stored "unpaid" reads Paid, not a balance',
  invoiceMoneyContext({ ...INV, amount_paid: 100 }, {}, '2026-08-11', money) === 'Paid')
// A cancelled invoice keeps its full balance in the columns.
check('a cancelled invoice never quotes money owing',
  invoiceMoneyContext({ ...INV, status: 'cancelled' }, {}, '2026-08-11', money) === 'Cancelled')
check('no money at all rather than a guessed figure when the amount is missing',
  invoiceMoneyContext({ status: 'unpaid' }, {}, '2026-08-11', money) === null)

// Settings gate: the balance engine needs fee/GST settings. Without them, silence.
const invRow = row({ kind: 'invoice', id: 'i1', label: 'INV-0069', sub: 'Sarah Brown',
  extra: { ref: 'INV-0069', ...INV } })
const withSettings = toSearchRecords([invRow], { settings: {}, todayISO: '2026-08-11', formatCurrency: money, settingsLoaded: true })
const without = toSearchRecords([invRow], { settings: null, todayISO: '2026-08-11', formatCurrency: money, settingsLoaded: false })
// Money LEADS the line. Measured at 390px: with the customer first, CSS truncated
// "…· $3,295.00 balan…" — and a bare figure on a money surface reads as the invoice
// TOTAL. Leading with it means the service type is what gets cut instead.
check('money leads the line so truncation cannot eat the qualifier',
  withSettings[0].sub === '$100.00 balance · Sarah Brown', withSettings[0].sub)
check('…and is withheld, not guessed, until settings have loaded', without[0].sub === 'Sarah Brown')

check('a quote shows its GENERATED total, also first',
  toSearchRecords([row({ kind: 'quote', id: 'q1', label: 'Q-1042', sub: 'Sarah Brown',
    extra: { total: 725 } })], { settings: {}, todayISO: '2026-08-11', formatCurrency: money, settingsLoaded: true })[0].sub
  === '$725.00 · Sarah Brown')

H('10. Failure is not emptiness')
check('the palette branches on the RPC error', /if \(rpcErr\)/.test(PALETTE_CODE))
// Anchored INSIDE the rpcErr block. Asserting "setError(FAILED_READ) appears
// somewhere in the file" passes while the record search silently renders a dropped
// read as an empty book, because the call/text verb below it also sets it.
const rpcErrBlock = (PALETTE_CODE.match(/if \(rpcErr\) \{([\s\S]*?)\n      \}/) || [])[1] ?? ''
check('the rpcErr branch was located', rpcErrBlock.length > 0)
check('a failed RECORD SEARCH sets the error state', /setError\(FAILED_READ\)/.test(rpcErrBlock))
check('…does NOT leave stale rows on screen', /setResults\(\[\]\)/.test(rpcErrBlock))
check('…and stops the spinner', /setLoading\(false\)/.test(rpcErrBlock))
check('…and returns rather than falling through to render results',
  /\breturn\b/.test(rpcErrBlock))
check('the failure message never says "no results"', !/no results/i.test(
  (PALETTE.match(/const FAILED_READ = '[^']*'/) || [''])[0]))
check('the error state renders before the empty state',
  PALETTE_CODE.indexOf('{error ? (') < PALETTE_CODE.indexOf('flat.length === 0 ?'))
check('the error state offers a retry', /setRetryTick\(t => t \+ 1\)/.test(PALETTE_CODE))
check('retry re-runs the search', /retryTick\]\)/.test(PALETTE_CODE))
check('the verb path is honest about a failed read too', /if \(verbErr\)/.test(PALETTE_CODE))
check('no result array is built from a discarded error',
  !/\(cust\.data|\(prop\.data|\(quo\.data|\(inv\.data|\(job\.data/.test(PALETTE_CODE))
// A settings read that fails must not take the search down with it.
check('a settings failure degrades to "no money line", not to an error',
  /if \(!sErr\) settingsRef\.current/.test(PALETTE_CODE))

H('11. Stale responses can never replace newer ones')
check('a ticket is taken synchronously, per query', /const myReq = \+\+reqRef\.current/.test(PALETTE_CODE))
// Anchored on the RPC call itself. An unanchored "some abortSignal is followed by
// a check" passes while the record search is unguarded, because the settings read
// below it also matches.
check('the RECORD SEARCH response checks its ticket before painting',
  /rpc\('search_records',[\s\S]{0,200}?\.abortSignal\(ctrl\.signal\)\s*\n\s*if \(myReq !== reqRef\.current\) return/
    .test(PALETTE_CODE))
check('superseded requests are aborted', /return \(\) => \{ clearTimeout\(handle\); ctrl\.abort\(\) \}/.test(PALETTE_CODE))
check('keystrokes are debounced', /\}, 180\)/.test(PALETTE_CODE))

// The self-cancelling search. An effect that aborts its own request in cleanup is
// only correct while its dependencies are STABLE — name a value that is rebuilt
// every render and each render's cleanup kills the request the previous render
// started, so the search never fires and the palette says "No matches" forever.
// It type-checks, it lints, and it looks right. NAV is exactly such a value:
// useModules() returns a fresh `visible` array on every render.
{
  const deps = (PALETTE_CODE.match(/return \(\) => \{ clearTimeout\(handle\); ctrl\.abort\(\) \}\s*\n\s*\}, \[([^\]]*)\]/) || [])[1]
  check('the search effect dependency list was located', typeof deps === 'string')
  for (const unstable of ['NAV', 'moduleNav', 'emptySections', 'baseSections', 'flat', 'sections', 'recents']) {
    check(`…does not depend on ${unstable} (rebuilt every render)`,
      !new RegExp(`\\b${unstable}\\b`).test(deps ?? ''))
  }
  check('…and "Go to" is filtered outside the effect instead',
    /const navSection = useMemo<Section \| null>/.test(PALETTE_CODE))
}
// EVERY state write that can happen after an await must sit behind a ticket check.
// The guard on the results is the famous one, but a stale response that only calls
// setLoading(false) is just as wrong: it stops the spinner while a newer request is
// still running, so the palette looks finished and shows the previous answer.
//
// Scanned rather than spot-checked, because this breaks by ADDITION — a new early
// return added later, below an await, without a guard. An await re-arms the
// requirement; a ticket check satisfies it until the next await.
{
  const body = PALETTE_CODE.slice(
    PALETTE_CODE.indexOf('const handle = setTimeout(async () => {'),
    PALETTE_CODE.indexOf('}, 180)'))
  check('the debounced search body was located', body.length > 500)
  const TICKET = /myReq (!==|===) reqRef\.current/
  const WRITES = /\bset(Results|Error|Loading|Sel)\(/
  let armed = false                       // an await has happened; a check is owed
  const unguarded: string[] = []
  for (const line of body.split('\n')) {
    if (TICKET.test(line)) {
      // A same-line guard covers that line's own writes.
      armed = false
      continue
    }
    if (armed && WRITES.test(line)) unguarded.push(line.trim())
    if (/\bawait\b/.test(line)) armed = true
  }
  check('no state write after an await escapes the ticket check',
    unguarded.length === 0, unguarded.join(' | '))
}

// The protocol itself, run for real: the exact race the brief names.
{
  let current = 0
  let painted: string | null = null
  const start = (q: string) => { const t = ++current; return (result: string) => { if (t !== current) return; painted = result } }
  const slow = start('Sarah')          // "Sarah" starts…
  const fast = start('Sarah Brown')    // …then "Sarah Brown" starts
  fast('BROWN-RESULTS')                // the fast one returns first
  slow('SARAH-RESULTS')                // the slow one returns after
  check('type "Sarah", then "Sarah Brown": the late "Sarah" answer is discarded',
    painted === 'BROWN-RESULTS', `painted ${painted}`)
}
{
  let current = 0
  let painted: string | null = null
  let errored = false
  const start = () => { const t = ++current; return { ok: (r: string) => { if (t !== current) return; painted = r }, err: () => { if (t !== current) return; errored = true } } }
  const slow = start()
  const fast = start()
  fast.ok('FRESH')
  slow.err()                            // the stale request FAILS after the fresh one succeeded
  check('a stale FAILURE cannot overwrite a fresh success with an error banner',
    painted === 'FRESH' && !errored)
}

H('12. Scope — a record locator, not a text search')
for (const forbidden of [
  ['notes', /\bnotes ilike\b/],
  ['message bodies', /\bbody ilike\b|from public\.messages\b/],
  ['photo captions', /\bcaption ilike\b|job_photos/],
  ['AI vision summaries', /property_intelligence/],
] as [string, RegExp][]) {
  check(`does not scan ${forbidden[0]}`, !forbidden[1].test(SQL_CODE))
}
check('archived customers stay out', /c\.archived_at is null/.test(SQL_CODE))
check('leads are not a separate source (a lead is a customer with a stage)',
  !/from public\.leads\b/.test(SQL_CODE))
check('exactly one search call in the palette',
  (PALETTE_CODE.match(/rpc\('search_records'/g) || []).length === 1)

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? '✅' : '❌'} global search — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
