/**
 * verify-attribution — lead source + conversion attribution V1.
 *
 * Run: npx tsx scripts/verify-attribution.ts   ·   npm run verify:attribution
 *
 * `customers.acquisition_source` is ONE column that FOUR vocabularies write into:
 * the owner's dropdown (ACQUISITION_SOURCES), the public booking page's dropdown
 * (HEAR_ABOUT_OPTIONS), the intake door labels ('Website' / 'Formspree' /
 * 'Online Booking' / 'webhook'), and — off a public URL — `utm_source`. That is
 * exactly how a book ends up with Facebook, FB, facebook ad and Meta as four
 * different sources, and how a hand-edited link poisons the report.
 *
 * The whole design rests on claims that are cheap to break and invisible when
 * broken, so they are asserted here rather than trusted:
 *
 *   1. ONE mapping. Every value any real door can write resolves to a canonical
 *      category, and the residuals keep their raw text instead of vanishing.
 *   2. UNKNOWN STAYS UNKNOWN. No blank ever becomes a channel. This is the rule
 *      most likely to be "helpfully" broken by a later default.
 *   3. PUBLIC INPUT IS BOUNDED, in the app AND in SQL (the RPC is granted to
 *      `anon`, so the database is the boundary that actually holds).
 *   4. FIRST KNOWN TOUCH WINS — the seam fills a blank and never overwrites.
 *   5. NOBODY IS COUNTED TWICE. The funnel counts CUSTOMERS, so five won quotes
 *      and nine visits for one person is still one.
 *   6. A FAILED READ IS NOT A ZERO. "Facebook: 37 customers, 0 won" produced by a
 *      dead connection is a confident lie about the owner's marketing.
 *   7. NO MONEY. Source-level revenue is deliberately out of V1; this pins the
 *      refusal so it can't drift back in without someone deleting a check.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SOURCE_CATEGORIES, HEAR_ABOUT_OPTIONS, MAX_SOURCE_LEN, MIN_SAMPLE_FOR_RATE,
  normalizeSource, describeSource, sanitizeSourceInput, sourceLabel,
  buildAcquisitionFunnel,
  type SourceCategory,
} from '../src/lib/attribution'
import { ACQUISITION_SOURCES } from '../src/types'
import { WIDGETS } from '../src/lib/analytics/layout'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`) }
}
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  check(name, a === e, `expected ${e}, got ${a}`)
}

const ROOT = join(__dirname, '..')

/**
 * Read a source file with its line endings normalised to \n.
 *
 * ⚠️ NOT cosmetic. Git hands these files to a Windows checkout as CRLF, and a lone
 * `\r` silently disarms this guard in two ways at once:
 *
 *   • `.` does not match `\r`, so `codeOnly`'s `^\s*(\/\/|--).*$` stops matching and
 *     strips NOTHING. Every absence check below then reads the header comments that
 *     quote the old code — and fails on the explanation of the very fix it is
 *     checking for (the trap `codeOnly` exists to avoid, arriving by the back door).
 *   • Every `[\s\S]{0,N}` window silently loses budget to the extra characters.
 *
 * The effect is a suite that is green on one machine and red on another for reasons
 * that have nothing to do with the code under test. Normalising at the ONE boundary
 * where bytes enter the guard is the fix; nothing downstream has to think about it.
 */
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n?/g, '\n')

const LIB = read('src/lib/attribution.ts')
const SQL = read('supabase/archive/run/RUN-2026-08-11-source-attribution.sql')
const INTAKE = read('src/lib/intake.ts')
const BOOKING = read('src/app/book/[token]/BookingClient.tsx')
const PAGE = read('src/app/dashboard/intelligence/page.tsx')
const FORM = read('src/components/customers/CustomerForm.tsx')
const PROFILE = read('src/app/dashboard/customers/[id]/page.tsx')
// Capture at every door (session 29) — the app-side creators of customer rows.
const CUSTOMERS = read('src/lib/customers.ts')
const BUILDER = read('src/components/quotes/QuoteBuilder.tsx')
const QNEW = read('src/app/dashboard/quotes/new/page.tsx')
const QEDIT = read('src/app/dashboard/quotes/[id]/page.tsx')
const NEIGHBORS = read('src/app/dashboard/neighbors/page.tsx')
const IMPORT = read('src/app/dashboard/customers/import/page.tsx')
// The importer's rules moved into the engine; the page is now the surface only.
const IMPORT_LIB = read('src/lib/customerImport.ts')
const TYPES = read('src/types/index.ts')
const BACKFILL = read('supabase/archive/run/RUN-2026-08-11-backfill-lead-source.sql')

/**
 * Strip comments before asserting that something is ABSENT.
 *
 * Every file here documents the shape it replaced — the SQL header quotes the old
 * `v_source :=` line, the customer profile names the regex it retired, and
 * lib/attribution says out loud that it has no ROAS. A naive `!src.includes(x)`
 * then fails on the EXPLANATION of the very fix it is checking for, and the only
 * way to make it pass is to delete the explanation. That is a guard training the
 * code to be less clear (the same trap verify:public-edge hit, reporting the cure
 * as the disease), so every absence claim below is made against CODE.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')           // block comments
    .split('\n')
    .map(l => l.replace(/^\s*(\/\/|--).*$/, '')) // whole-line // and SQL --
    .join('\n')
}
const LIB_CODE = codeOnly(LIB)
const SQL_CODE = codeOnly(SQL)
const PROFILE_CODE = codeOnly(PROFILE)

// ─────────────────────────────────────────────────────────────────────────────
H('0 · this guard\'s own instruments')

// Every absence claim below is made against `codeOnly(...)`. If the stripper stops
// stripping, those claims invert — they start failing on the comments that explain
// the fix — so the stripper is tested before it is trusted.
check('codeOnly removes a whole-line // comment', !codeOnly('// roas here\nconst a = 1\n').includes('roas'))
check('codeOnly removes a whole-line -- comment', !codeOnly('-- roas here\nselect 1\n').includes('roas'))
check('codeOnly removes a block comment', !codeOnly('/* roas\n here */\nselect 1\n').includes('roas'))
check('…and keeps the code', codeOnly('-- roas here\nselect 1\n').includes('select 1'))
check('every file read is normalised to \\n, so a CRLF checkout cannot change a verdict',
  ![LIB, SQL, INTAKE, BOOKING, PAGE, FORM, PROFILE,
    CUSTOMERS, BUILDER, QNEW, QEDIT, NEIGHBORS, IMPORT, IMPORT_LIB, TYPES, BACKFILL].some(s => s.includes('\r')),
  '`.` does not match \\r — one CRLF file makes codeOnly strip nothing at all')

// ─────────────────────────────────────────────────────────────────────────────
H('1 · one vocabulary, one mapping')

const keys = SOURCE_CATEGORIES.map(c => c.key)
check('category keys are unique', new Set(keys).size === keys.length, keys.join(','))
check('every category has a label and a hint', SOURCE_CATEGORIES.every(c => !!c.label && !!c.hint))
check('`unknown` is listed LAST — the residual is never ranked above a real channel',
  keys[keys.length - 1] === 'unknown', keys.join(','))
check('`other` sits immediately before it', keys[keys.length - 2] === 'other')
check('sourceLabel() answers for every category', keys.every(k => !!sourceLabel(k)))

// THE point of the file: every value a real door can write must land somewhere
// real. A door writing a value that falls through to `other` is a vocabulary that
// has drifted from its normalizer.
for (const s of ACQUISITION_SOURCES) {
  const c = normalizeSource(s)
  check(`owner dropdown "${s}" → ${c}`, s === 'Other' ? c === 'other' : (c !== 'unknown' && c !== 'other'))
}
for (const s of HEAR_ABOUT_OPTIONS) {
  const c = normalizeSource(s)
  check(`booking dropdown "${s}" → ${c}`, s === 'Other' ? c === 'other' : (c !== 'unknown' && c !== 'other'))
}
// The intake doors label themselves; those labels are values too.
for (const s of ['Website', 'Website Booking', 'Online Booking', 'Formspree', 'webhook', 'zapier'])
  eq(`intake door label "${s}" → online_form`, normalizeSource(s), 'online_form')

eq('HEAR_ABOUT_OPTIONS is the same eight strings that shipped on the booking page',
  [...HEAR_ABOUT_OPTIONS],
  ['Website', 'Google Business Profile', 'QR code', 'Facebook', 'Nextdoor',
    'Referral from a friend', 'Drove by / yard sign', 'Other'])
// Not `!/const HEAR_OPTIONS =/` — that pins one identifier, and the regression is a
// second copy of the VOCABULARY under any name at all. Re-declaring the list means
// writing the strings again, so assert on the strings: none of the eight may appear
// as a literal in BookingClient, which today imports them and nothing else.
check('BookingClient consumes the shared list instead of declaring its own',
  /import \{[^}]*\bHEAR_ABOUT_OPTIONS\b[^}]*\} from '@\/lib\/attribution'/.test(BOOKING) &&
  !HEAR_ABOUT_OPTIONS.some(o => codeOnly(BOOKING).includes(`'${o}'`)),
  'the public funnel\'s vocabulary must live in ONE file or the two copies drift')
check('the customer profile no longer runs its own source regex',
  PROFILE.includes('describeSource(') && !/\.test\(src\)/.test(PROFILE_CODE))

// ─────────────────────────────────────────────────────────────────────────────
H('2 · unknown stays unknown')

for (const v of [null, undefined, '', '   ', '\n\t ', 0 as unknown as string, {} as unknown as string])
  eq(`${JSON.stringify(v)} → unknown`, normalizeSource(v as string | null | undefined), 'unknown')
check('a blank NEVER becomes a channel',
  ![null, undefined, '', '  '].some(v => {
    const c = normalizeSource(v as string | null)
    return c !== 'unknown'
  }))
eq('an unknown source carries no invented detail', describeSource(null).detail, null)
eq('an unknown source is labelled as a gap, not a channel', describeSource(null).label, 'Not recorded')
check('no NON-empty string is ever reported as unknown',
  ['x', 'Aliens', '???', 'utm_source', '1'].every(s => normalizeSource(s) !== 'unknown'))

// ─────────────────────────────────────────────────────────────────────────────
H('3 · the mess the brief names (Facebook / FB / facebook ad / Meta)')

const CASES: [string, SourceCategory][] = [
  ['Facebook', 'facebook'], ['FB', 'facebook'], ['fb', 'facebook'], ['facebook ad', 'facebook'],
  ['Meta', 'facebook'], ['FB Ads', 'facebook'], ['Facebook Marketplace', 'facebook'],
  ['Instagram', 'instagram'], ['IG', 'instagram'], ['insta', 'instagram'],
  // Ambiguous by construction — pinned so the answer is a decision, not an accident.
  ['Instagram/Facebook', 'instagram'],
  ['Nextdoor', 'nextdoor'], ['next door', 'nextdoor'], ['NEXTDOOR', 'nextdoor'],
  ['Door Knocking', 'door_knock'], ['door-to-door', 'door_knock'], ['we knocked', 'door_knock'],
  ['Google', 'google'], ['google', 'google'], ['Google Business Profile', 'google'],
  ['GBP', 'google'], ['organic google', 'google'], ['google maps', 'google'], ['Bing', 'google'],
  ['Referral', 'referral'], ['Referral from a friend', 'referral'], ['word of mouth', 'referral'],
  ['referred by a neighbour', 'referral'],
  ['Repeat Customer', 'repeat'], ['returning customer', 'repeat'],
  ['Truck Signage', 'signage'], ['Drove by / yard sign', 'signage'], ['saw your truck', 'signage'],
  ['Flyer / Mailout', 'print'], ['QR code', 'print'], ['flyer', 'print'], ['postcard', 'print'],
  ['Website', 'online_form'], ['our web site', 'online_form'],
  ['Other', 'other'], ['Aliens', 'other'], ['🙂', 'other'],
]
for (const [input, expected] of CASES) eq(`"${input}" → ${expected}`, normalizeSource(input), expected)

check('Nextdoor is NOT door knocking — the word "door" is in both',
  normalizeSource('Nextdoor') !== 'door_knock')
check('normalizeSource is deterministic', CASES.every(([i]) => normalizeSource(i) === normalizeSource(i)))
eq('an unrecognised value keeps its words instead of vanishing into "Other"',
  describeSource('TikTok livestream').detail, 'TikTok livestream')
eq('…and is still bucketed', describeSource('TikTok livestream').category, 'other')
eq('a raw value that already IS the label carries no redundant detail',
  describeSource('Facebook').detail, null)
eq('a raw value that says MORE than the label keeps it',
  describeSource('Google Business Profile').detail, 'Google Business Profile')

// ─────────────────────────────────────────────────────────────────────────────
H('4 · public input is bounded — in the app AND in SQL')

const HOSTILE = 'spam '.repeat(60) + '\n<script>alert(1)</script>'
const cleaned = sanitizeSourceInput(HOSTILE) || ''
check(`a ${HOSTILE.length}-char hostile source is bounded to ${MAX_SOURCE_LEN}`, cleaned.length <= MAX_SOURCE_LEN, `${cleaned.length}`)
// eslint-disable-next-line no-control-regex
check('control characters are stripped', !/[\u0000-\u001F\u007F-\u009F]/.test(cleaned))
eq('whitespace runs collapse', sanitizeSourceInput('  Google   Business \t Profile '), 'Google Business Profile')
eq('a blank is null, not an empty source', sanitizeSourceInput('   '), null)
eq('a non-string is null', sanitizeSourceInput(42 as unknown as string), null)
eq('a real value passes through untouched', sanitizeSourceInput('Facebook'), 'Facebook')
check('bounding never leaves a trailing space', (sanitizeSourceInput('a'.repeat(59) + ' bbb') || '').endsWith('a'))
check('however hostile, the bounded value still lands in a bucket — cardinality cannot explode',
  SOURCE_CATEGORIES.some(c => c.key === normalizeSource(cleaned)))

check('lib/intake sanitises the source it sends to the RPC',
  /p_source: (?:\w+ \|\| )*sanitizeSourceInput\(opts\.source\)/.test(INTAKE),
  'the /api/intake route is CORS-open and reads `source` from the request body — ' +
  'every candidate in the evidence chain must pass the bound (10e pins the chain itself)')
check('BookingClient bounds every utm_* value at capture', /sanitizeSourceInput\(sp\.get\('utm_'/.test(BOOKING))

check('SQL: sanitize_source_input exists', /create or replace function public\.sanitize_source_input/.test(SQL))
check('SQL: it is IMMUTABLE and search_path-pinned', /immutable[\s\S]{0,80}set search_path = pg_catalog, pg_temp/.test(SQL))
check(`SQL: it bounds to the same ${MAX_SOURCE_LEN} characters as the app`, new RegExp(`\\b${MAX_SOURCE_LEN}\\)`).test(SQL))
check('SQL: it strips control characters', SQL.includes('[[:cntrl:]]'))
check('SQL: the PUBLIC grant is revoked, not just anon/authenticated',
  /revoke all on function public\.sanitize_source_input\(text\) from public/.test(SQL) &&
  /revoke all on function public\.sanitize_source_input\(text\) from anon, authenticated/.test(SQL),
  'a function in `public` is granted to PUBLIC by default — revoking anon alone leaves it open')
check('SQL: submit_booking bounds p_hear_about', /sanitize_source_input\(p_hear_about\)/.test(SQL))
check('SQL: submit_booking bounds utm_source', /sanitize_source_input\(p_utm->>'source'\)/.test(SQL))
check('SQL: no raw candidate survives into v_source',
  !/v_source := coalesce\(nullif\(trim\(p_hear_about\)/.test(SQL_CODE))
check('SQL: the raw hear_about/utm are still stored on the quote (nothing is lost, only bounded)',
  /'hear_about', p_hear_about, 'referral_code', p_referral_code, 'utm', p_utm/.test(SQL))
check('SQL: submit_booking keeps its 22-argument signature (grants ride on it)',
  /p_utm jsonb default null, p_photos text\[\] default null\)/.test(SQL))
check('SQL: submit_booking is still SECURITY DEFINER', /security definer set search_path to 'public'/.test(SQL))
check('SQL: resolve_intake_customer is still SECURITY INVOKER',
  !/create or replace function public\.resolve_intake_customer[\s\S]{0,400}security definer/.test(SQL))

// ─────────────────────────────────────────────────────────────────────────────
H('5 · first KNOWN touch wins — the seam fills a blank, never overwrites')

check('SQL: the matched branch fills only when the stored source is blank',
  /acquisition_source = coalesce\(nullif\(btrim\(acquisition_source\), ''\)/.test(SQL))
check('SQL: it never assigns the incoming source unconditionally',
  !/acquisition_source = public\.sanitize_source_input\(p_source\)\s*$/m.test(SQL),
  'a bare assignment in the UPDATE branch would make the LAST touch win')
check('SQL: the insert branch sanitises too (/api/intake is a second public door)',
  /acquisition_source, notes[\s\S]{0,400}public\.sanitize_source_input\(p_source\)/.test(SQL))
check('SQL: BK-1 match order (phone last-10 → email → address) is untouched',
  /right\(regexp_replace\(coalesce\(v_phone, ''\), '\\D', '', 'g'\), 10\)/.test(SQL) &&
  SQL.indexOf("lower(coalesce(email, '')) = v_email") < SQL.indexOf("lower(coalesce(address, '')) = lower(v_address)"))
check('SQL: phone/email are still blank-only backfills',
  /phone = coalesce\(phone, v_phone\)/.test(SQL) && /email = coalesce\(email, v_email\)/.test(SQL))

// ─────────────────────────────────────────────────────────────────────────────
H('6 · nobody is counted twice')

// Semicolons are load-bearing here, in a file that otherwise has none: each fixture
// below sits in a bare `{ … }` block to keep its names local, and `=> ({ … })`
// followed by an unterminated newline and a `{` makes the TypeScript parser reparse
// the object literal as an arrow parameter list and demand a `=>`. tsx/esbuild runs
// the file happily, so the guard goes GREEN while `tsc` and `next build` cannot
// parse it at all.
const C = (id: string, src: string | null) => ({ id, acquisition_source: src });
const Q = (customer_id: string | null, status: string) => ({ customer_id, status });
const J = (customer_id: string | null, status: string) => ({ customer_id, status });

// One customer, many rows. THE regression this guard exists for.
{
  const f = buildAcquisitionFunnel(
    [C('a', 'Facebook')],
    [Q('a', 'accepted'), Q('a', 'paid'), Q('a', 'completed'), Q('a', 'sent')],
    [J('a', 'completed'), J('a', 'completed'), J('a', 'scheduled')],
  )
  const r = f.rows[0]
  eq('one customer with 4 quotes and 3 visits is ONE customer', r.customers, 1)
  eq('…quoted once', r.quoted, 1)
  eq('…won once', r.won, 1)
  eq('…worked once', r.worked, 1)
  eq('…and the total agrees', f.customers, 1)
}

// Stage semantics.
{
  const f = buildAcquisitionFunnel(
    [C('a', 'Referral'), C('b', 'Referral'), C('c', 'Referral'), C('d', 'Referral')],
    [Q('a', 'draft'), Q('b', 'sent'), Q('c', 'declined'), Q('d', 'scheduled')],
    [J('d', 'completed'), J('c', 'cancelled')],
  )
  const r = f.rows[0]
  eq('a DRAFT quote is not a quote yet', r.quoted, 3)
  eq('declined counts as quoted but not won', r.won, 1)
  eq('a cancelled visit is not work done', r.worked, 1)
}

// Rows that must not create or move anything.
{
  const f = buildAcquisitionFunnel(
    [C('a', 'Facebook')],
    [Q(null, 'accepted'), Q('ghost', 'accepted')],
    [J(null, 'completed'), J('ghost', 'completed')],
  )
  eq('an orphan quote/job invents no source row', f.rows.length, 1)
  eq('…and does not credit anyone', f.rows[0].won, 0)
  eq('…nor inflate the customer count', f.customers, 1)
}

// Unknown is visible, last, and honest.
//
// ⭐ The fixture makes unknown the LARGEST cohort on purpose. That is the real shape
// of this book (most rows have no source), and it is the ONLY arrangement that
// actually tests the rule: with unknown tied or smaller, the size and label
// tiebreaks push it last on their own, so the sort's `unknown`-last clause could be
// deleted and every assertion here would still pass. Mutation-testing this guard is
// what surfaced that — the original fixture was 3 unknown vs 3 Facebook, and
// 'Facebook' < 'Not recorded' alphabetically was doing all the work.
{
  const rows = [
    C('a', null), C('b', ''), C('c', '   '), C('d', null), C('e', null), C('f', null),
    C('g', 'Facebook'), C('h', 'Facebook'),
  ]
  const f = buildAcquisitionFunnel(rows, [], [])
  eq('blank sources collapse into ONE unknown bucket', f.rows.filter(r => r.category === 'unknown').length, 1)
  eq('unknown holds all six', f.rows.find(r => r.category === 'unknown')!.customers, 6)
  eq('unknown is sorted LAST even though it is the LARGEST cohort',
    f.rows[f.rows.length - 1].category, 'unknown')
  eq('…and the real channel leads despite being smaller', f.rows[0].category, 'facebook')
  eq('known excludes unknown', f.known, 2)
  eq('unknown share is stated, not hidden', f.unknownPct, 75)
  eq('rows account for every customer', f.rows.reduce((n, r) => n + r.customers, 0), f.customers)
}

// Small samples: counts yes, percentages no.
{
  const few = Array.from({ length: MIN_SAMPLE_FOR_RATE - 1 }, (_, i) => C(`s${i}`, 'Google'))
  const enough = Array.from({ length: MIN_SAMPLE_FOR_RATE }, (_, i) => C(`b${i}`, 'Google'))
  eq(`a cohort of ${MIN_SAMPLE_FOR_RATE - 1} states no rate`,
    buildAcquisitionFunnel(few, [Q('s0', 'accepted')], []).rows[0].wonRate, null)
  eq(`a cohort of ${MIN_SAMPLE_FOR_RATE} does`,
    buildAcquisitionFunnel(enough, [Q('b0', 'accepted'), Q('b1', 'accepted')], []).rows[0].wonRate, 0.2)
  check('counts are present either way',
    buildAcquisitionFunnel(few, [Q('s0', 'accepted')], []).rows[0].won === 1)
}

// Raw detail survives the roll-up.
{
  const f = buildAcquisitionFunnel(
    [C('a', 'Google'), C('b', 'Google Business Profile'), C('c', 'GBP')], [], [])
  const g = f.rows.find(r => r.category === 'google')!
  eq('one Google row', g.customers, 3)
  eq('…with the distinct raw answers kept, sorted', g.details, ['GBP', 'Google Business Profile'])
}

eq('an empty book is empty, not broken', buildAcquisitionFunnel([], [], []).customers, 0)
eq('…and states no percentage of nothing', buildAcquisitionFunnel([], [], []).unknownPct, null)

// A later stage may legitimately exceed an earlier one (a job created without a
// quote). Pinned so nobody "fixes" it by clamping and inventing quotes.
{
  const f = buildAcquisitionFunnel([C('a', 'Referral')], [], [J('a', 'completed')])
  eq('work with no quote is still work', f.rows[0].worked, 1)
  eq('…and is not back-filled into a quote that never existed', f.rows[0].quoted, 0)
}

// ─────────────────────────────────────────────────────────────────────────────
H('7 · a failed read is not a zero, and every read is tenant-scoped')

const loader = LIB.slice(LIB.indexOf('export async function loadAcquisitionFunnel'))
check('the loader returns null when ANY of the three reads failed',
  /if \(cRes\.error \|\| qRes\.error \|\| jRes\.error\) return null/.test(loader),
  'a tolerant `|| []` on quotes would render "37 customers, 0 won" from a dead connection')
check('…and the error check comes BEFORE any coercion',
  loader.indexOf('return null') < loader.indexOf('|| []'))
check('the loader returns null when there is no session', /if \(!uid\) return null/.test(loader))
{
  // Window each read to the text before the NEXT `.from(` — never a fixed width.
  // A fixed-width lookahead bleeds into the following read, so a read that lost its
  // own `.eq('user_id', uid)` would borrow its neighbour's and this would still
  // pass. Mutation-testing caught exactly that: deleting the tenant filter from the
  // quotes read was invisible, because the jobs read sat 60 characters later.
  const froms = [...loader.matchAll(/\.from\('(\w+)'\)((?:(?!\.from\()[\s\S])*)/g)]
  eq('the loader reads exactly three tables', froms.map(m => m[1]), ['customers', 'quotes', 'jobs'])
  check('every read is scoped to the signed-in tenant',
    froms.every(m => m[2].includes(".eq('user_id', uid)")),
    'RLS is the floor, not the only lock — Business A must never see Business B')
}
check('the page distinguishes "loading" from "could not check"',
  PAGE.includes('acquisition === undefined') && PAGE.includes('acquisition === null'))
check('…and says so in words rather than rendering an empty board',
  /Couldn&apos;t check where your customers came from/.test(PAGE))
check('the page only caches a successful result', /if \(r\) writeCache\('acquisition', r\)/.test(PAGE))
check('a thrown loader lands as null, not as silence', /catch \{ setAcquisition\(null\) \}/.test(PAGE))

// ─────────────────────────────────────────────────────────────────────────────
H('8 · the money V1 deliberately refuses')

{
  const shapes = LIB.slice(LIB.indexOf('export interface SourceFunnelRow'), LIB.indexOf('export const MIN_SAMPLE_FOR_RATE'))
  const money = /\b(revenue|amount|total|profit|margin|price|paid|balance|value|invoice)\s*[?:]/i
  check('no money field on the funnel shapes', !money.test(shapes),
    'invoice total ≠ revenue; a payment is not attributable to acquisition; profit is another lane')
  check('the loader selects no money column',
    !/select\('[^']*\b(total|amount|price|paid)\b/.test(loader))
  check('the refusal is written down where the next person will look',
    /NO MONEY IN THIS SHAPE, ON PURPOSE/.test(LIB))
}
check('no ad-platform or ROAS machinery crept in',
  !/roas|ad_spend|adSpend|googleAds|google_ads|metaApi|meta_api|costPerLead/i.test(LIB_CODE))
check('the paid-vs-organic guess is refused out loud',
  /cannot tell paid from organic/i.test(LIB))

// ─────────────────────────────────────────────────────────────────────────────
H('9 · the surfaces')

const ids = WIDGETS.map(w => w.id)
check('`acquisition` is registered', ids.includes('acquisition'))
check('…and is appended LAST, so a saved layout gains it instead of reshuffling',
  ids[ids.length - 1] === 'acquisition', ids.join(','))
check('the intelligence page renders it', /<Section id="acquisition"/.test(PAGE))
check('counts are shown before any rate', PAGE.indexOf('>Customers<') < PAGE.indexOf('>Won rate<'))
check('the unknown share is surfaced as a data-quality fact',
  /have no source recorded/.test(PAGE))
check('the per-customer counting rule is stated to the owner',
  /counted once however many quotes or visits/.test(PAGE))
check('wide content scrolls inside its own box, not the page', /overflow-x-auto/.test(PAGE))

check('the customer form keeps a recorded source that is not in the owner dropdown',
  /!known\.includes\(current\)/.test(FORM),
  "8 live customers carry 'Website', which the dropdown never offered — a <select> with no matching <option> renders BLANK")
check('…without removing any existing option', /\.\.\.known\.map\(s => \(\{ value: s, label: s \}\)\)/.test(FORM))

// ─────────────────────────────────────────────────────────────────────────────
H('10 · capture at every door (session 29 — the 44% was avoidable)')

// At attribution's landing, 45 of 103 customers had no source, and the biggest
// APP-SIDE maker of them was ensureCustomerAndProperty: every quote saved for a
// brand-new person minted a source-less customer (measured live: both customers
// created on 2026-08-11 with no source came through app doors). The rules below
// pin the fix: every app-side creator can carry a source, every carried source is
// bounded by THE sanitizer, blanks are filled and never overwritten, and no door
// is ever REQUIRED to answer — unknown stays a legitimate state.

// 10a — the one find-or-create engine.
check('ensureCustomerAndProperty accepts an optional source', /source\?: string \| null/.test(CUSTOMERS))
check('…the INSERT branch writes it through THE sanitizer',
  /acquisition_source: sanitizeSourceInput\(input\.source\)/.test(CUSTOMERS),
  'an unbounded write here would bypass the boundary every other writer respects')
{
  const patches = [...codeOnly(CUSTOMERS).matchAll(/patch\.acquisition_source/g)]
  eq('exactly one matched-branch assignment exists', patches.length, 1)
  check('…and it fills ONLY a blank — first KNOWN touch wins, in the app as in SQL',
    /if \(!\(match\.customer\.acquisition_source \|\| ''\)\.trim\(\) && src\) patch\.acquisition_source = src/.test(CUSTOMERS),
    'an unconditional patch would let the LAST touch overwrite a recorded answer')
}

// 10b — the quote builder, the biggest manual door.
check('QuoteFormValues carries acquisition_source as OPTIONAL', /acquisition_source\?: string/.test(TYPES))
check('the builder asks only for a NEW person (inside the manual block)',
  BUILDER.indexOf("register('acquisition_source')") > BUILDER.indexOf('{showManualName && ('),
  'asking for a picked existing customer would invite overwriting a recorded source')
check('…with the shared vocabulary, not a second list',
  /options=\{ACQUISITION_SOURCES\.map\(s => \(\{ value: s, label: s \}\)\)\}/.test(BUILDER))
check('…never required — "Not sure" is the default and a real answer',
  /placeholder="Not sure"\n\s*options=\{ACQUISITION_SOURCES/.test(BUILDER) &&
  !/register\('acquisition_source',/.test(BUILDER),
  'a required source field forces the owner to lie to save a quote')
check('the create door passes it to the engine', /source: values\.acquisition_source/.test(QNEW))
check('the edit door passes it too (re-pointing a quote can create a customer)',
  /source: values\.acquisition_source/.test(QEDIT))

// 10c — neighbor-lead conversion. The add-field says "door knock, flyer,
// referral" — three channels, so the workflow is NOT deterministic evidence and
// the channel is asked, optionally, at the one moment the customer is minted.
check('neighbors conversion passes the picked source', /source: convertSource/.test(NEIGHBORS))
check('…offers the shared vocabulary', /ACQUISITION_SOURCES\.map\(s => <option key=\{s\}/.test(NEIGHBORS))
check('…and stays optional (first option is the blank)',
  /<option value="">Source\? \(optional\)<\/option>/.test(NEIGHBORS))
check('…without auto-stamping a channel the page cannot know',
  !/'(Door Knocking|Flyer \/ Mailout|Referral)'/.test(codeOnly(NEIGHBORS).replace(/ACQUISITION_SOURCES\.map[^\n]*/g, '')),
  'a neighbor lead can be door knock, flyer OR referral — hard-coding any one of them is a silent guess')

// 10d — CSV import (every imported customer used to land as "Not recorded").
//
// ⚠️ These four pinned the ORIGINAL importer's exact source text: a fixed
// `col('source')` lookup, one inline expression, and a raw <select>. Session 25
// rebuilt the importer around a confirmed column MAPPING (lib/customerImport),
// which keeps every rule below and expresses all of them differently. Re-aimed
// at the rules themselves — the same four things still fail if broken, and a
// header no longer has to be spelled "source" for the column to be read.
check('the CSV source column is read, under the canonical alias and its variants',
  /source: \['source', 'acquisition source'/.test(IMPORT_LIB) && /source: sanitizeSourceInput\(at\(m\.source\)\)/.test(IMPORT_LIB),
  'the importer must offer a source field and read whatever column the owner maps to it')
check('a row\'s own source beats the page default, and both are bounded',
  /r\.values\.source \?\? fallbackSource/.test(IMPORT_LIB)
  && /const fallbackSource = sanitizeSourceInput\(opts\.defaultSource\)/.test(IMPORT_LIB),
  'the default must fill only rows that carry nothing — never rewrite what the CSV said')
check('the page default is optional ("Not sure" imports as unrecorded)',
  /placeholder="Not sure"/.test(IMPORT),
  'the shared Select renders its placeholder as the empty-value option')
check('the owner is offered a source column to map',
  /\{ field: 'source', label: '[^']+'/.test(IMPORT_LIB))

// 10e — the website-lead door prefers evidence over its own label, exactly like
// the booking door: the customer's words, then the link's utm_source, then the
// door label. The full raw payload was already persisted (raw_submission), so
// this loses nothing and invents nothing.
check('lead door: hear_about (their words) is the strongest evidence',
  /saidSource \|\| utmSource \|\| sanitizeSourceInput\(opts\.source\) \|\| 'Website'/.test(INTAKE),
  'utm before hear_about would let a link parameter outrank what the customer said')
check('…hear_about aliases are read', /\['hear_about', 'hearAbout', 'how_did_you_hear', 'howDidYouHear'\]/.test(INTAKE))
check('…utm_source aliases are read', /\['utm_source', 'utmSource'\]/.test(INTAKE))
check('…both are sanitized at capture',
  /saidSource = sanitizeSourceInput\(leadField\(/.test(INTAKE) && /utmSource = sanitizeSourceInput\(leadField\(/.test(INTAKE))
check('…and the door label floor survives — a lead-door customer is never source-less',
  /\|\| 'Website'/.test(INTAKE))

// 10f — the ONE deterministic backfill, and the refusal around it.
check('backfill fills only blanks', /coalesce\(btrim\(c\.acquisition_source\), ''\) = ''/.test(BACKFILL))
check('…only for customers with a website_leads row (the deterministic evidence)',
  /exists \(select 1 from public\.website_leads wl where wl\.customer_id = c\.id\)/.test(BACKFILL))
check('…writes the door\'s own label, nothing fancier', /set acquisition_source = 'Website'\nwhere/.test(BACKFILL))
check('…touches no other column', ([...codeOnly(BACKFILL).matchAll(/\bset\b/g)].length === 1))
check('…and the refusal to guess the other 45 is written down',
  /DELIBERATELY NOT REPAIRED/.test(BACKFILL))
check('the production metric is stated where the repair lives', /known_pct/.test(BACKFILL))

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
