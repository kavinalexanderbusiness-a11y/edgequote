// ── Verify: a name is not an identifier, and a warning is not an action ──────
//   npm run verify:workforce-identity
//
// WHERE THIS CAME FROM. A read-only hygiene pass found two pairs of worker rows
// on a live roster that LOOKED like the same person — an active row and an
// archived row sharing a name, the shape a rehire leaves. That observation was
// reported and deliberately not acted on, because the rows underneath carry
// `time_entries`, `wage_history`, `pay_run_lines` and `pto_entries`: statutory
// records kept for years. `technicians.archived_at`'s own schema comment says a
// delete used to CASCADE all three away.
//
// ⛔⛔ THE TWO RULES THIS GUARD EXISTS FOR
//
//   1. NEVER BY NAME ALONE. A name is the least reliable field on the row, it is
//      routinely shared, and two workers really are both called John Smith.
//      §2 is the adversarial half: same-name pairs that must NOT be called
//      duplicates, no matter what else is true of them.
//
//   2. NOTHING ACTS. The engine is pure and the data module is read-only; there
//      is no merge, no delete, no archive and no row-rewriting helper anywhere
//      in this seam. §6 asserts that by reading the files, because a detector
//      that COULD act is one bug away from moving somebody's paid hours onto
//      another person's record.
//
// ⭐ The confidence ladder is shaped for a WORKFORCE, not a customer book: crews
// are routinely issued one company handset, so a shared phone is ordinary rather
// than damning. §3 pins that shape.
//
// OFFLINE by construction — it opens no database connection, so it runs
// identically in CI and locally and can never be the reason a suite skips.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONFIDENCE_LABEL, CONFIDENCE_MEANING, EVIDENCE_LABEL, EVIDENCE_STRENGTH,
  confidenceFor, hasPayrollHistory, identityEvidence, isRehireShaped,
  mergeBlockedReason, missingIdentifierSentence, scanWorkerIdentities,
  totalHistoryRows, EMPTY_HISTORY,
  type WorkerIdentityLike,
} from '../src/lib/workforceIdentity'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// ⚠️⚠️ CR-or-LF split: every file here is CRLF, `.` does not match a carriage
// return, and an unanchored `$` will not match before one — so the obvious
// newline-only split yields a stripper that removes NOTHING and every assertion
// made through it passes over raw source. Asserted alive in §6.
const strip = (s: string) => s.split(/\r?\n/).map(l => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n')
const stripperAlive = (s: string) => { const t = strip(s); return t.length > s.length * 0.2 && t.length < s.length * 0.99 }

const T = 'tenant-a'
const W = (over: Partial<WorkerIdentityLike> & { id: string }): WorkerIdentityLike => ({
  user_id: T, name: 'Unnamed', email: null, phone: null, auth_user_id: null,
  invite_code: null, is_active: true, archived_at: null, hired_on: null, ended_on: null,
  ...over,
})

// ── 1. The four synthetic cases the brief names ──────────────────────────────
console.log('\n═══ The cases this was built for ═══')

// (a) SAME NAME, DIFFERENT PEOPLE → not a duplicate.
{
  const a = W({ id: 'a', name: 'John Smith', email: 'john.smith@example.test', phone: '403-555-0100' })
  const b = W({ id: 'b', name: 'John Smith', email: 'j.smith2@example.test', phone: '403-555-0199' })
  const r = scanWorkerIdentities([a, b])
  check('⭐⭐ same name, different contact details → NOT a duplicate finding',
    r.findings.length === 0,
    'a name match must never produce a verdict — two workers really are both called John Smith')
  check('…it surfaces as UNCHECKABLE instead, with no verdict attached',
    r.uncheckable.length === 1 && r.uncheckable[0].sharedName === 'John Smith')
  check('…and the sentence never calls them duplicates',
    !/duplicat/i.test(missingIdentifierSentence(r.uncheckable[0].missing)))
}

// (b) REHIRE: active + archived, same verified identity → possible duplicate.
{
  const past = W({
    id: 'p', name: 'Dana Okafor', email: 'dana@example.test',
    is_active: false, archived_at: '2025-11-01T00:00:00Z',
    hired_on: '2024-03-01', ended_on: '2025-10-31',
  })
  const now = W({ id: 'n', name: 'Dana Okafor', email: 'dana@example.test', hired_on: '2026-04-01' })
  const r = scanWorkerIdentities([past, now])
  check('⭐ rehire — archived + active sharing a verified email → a finding',
    r.findings.length === 1)
  check('…the rehire shape is RECOGNISED and reported',
    r.findings[0]?.rehireShaped === true
    && r.findings[0].reasons.some(x => /rehire/i.test(x)))
  check('…and it lifts a single-channel match from possible to PROBABLE',
    r.findings[0]?.confidence === 'probable',
    `got ${r.findings[0]?.confidence}`)
}

// (c) MISSING IDENTIFIERS → uncertain, never a guess.
{
  const a = W({ id: 'a', name: 'Sam Rivera' })
  const b = W({ id: 'b', name: 'Sam Rivera' })
  const r = scanWorkerIdentities([a, b])
  check('⭐ no identifiers at all → NO finding, only "we cannot tell"',
    r.findings.length === 0 && r.uncheckable.length === 1)
  check('…and it names every identifier that would settle it',
    ['account', 'email', 'phone'].every(m => r.uncheckable[0].missing.includes(m as never)))
  check('…in a sentence that asks for data rather than implying an answer',
    /Adding .* would answer it/.test(missingIdentifierSentence(r.uncheckable[0].missing)))
}

// (d) PAYROLL ON BOTH SIDES → never auto-merge.
{
  const withPay = { ...EMPTY_HISTORY, timeEntries: 40, payRunLines: 6, wageHistory: 2 }
  check('⭐⭐ payroll history on both records is always a refusal',
    /statutory payroll record/i.test(mergeBlockedReason(withPay, withPay)))
  check('⛔ …and there is NO argument for which merging is offered',
    mergeBlockedReason(null, null).length > 20
    && mergeBlockedReason(withPay, EMPTY_HISTORY).length > 20,
    'this phase has no merge at all — the function must never return null')
  check('hasPayrollHistory counts paid time, pay lines and wages — not visits',
    hasPayrollHistory({ ...EMPTY_HISTORY, timeEntries: 1 })
    && hasPayrollHistory({ ...EMPTY_HISTORY, payRunLines: 1 })
    && hasPayrollHistory({ ...EMPTY_HISTORY, wageHistory: 1 })
    && !hasPayrollHistory({ ...EMPTY_HISTORY, jobs: 99 }))
}

// ── 2. ⛔ THE ADVERSARIAL HALF: a name may never decide anything ─────────────
console.log('\n═══ A name is not an identifier ═══')
const NAME_ONLY_CASES: Array<[string, WorkerIdentityLike, WorkerIdentityLike]> = [
  ['identical names, nothing else',
    W({ id: '1', name: 'Maria Garcia' }), W({ id: '2', name: 'Maria Garcia' })],
  ['identical names, one archived (the rehire SHAPE without the evidence)',
    W({ id: '3', name: 'Chen Wei', is_active: false, archived_at: '2025-01-01T00:00:00Z', ended_on: '2024-12-31' }),
    W({ id: '4', name: 'Chen Wei', hired_on: '2025-06-01' })],
  ['identical names + different emails',
    W({ id: '5', name: 'Alex Kim', email: 'alex@a.test' }), W({ id: '6', name: 'Alex Kim', email: 'alex@b.test' })],
  ['identical names + different phones',
    W({ id: '7', name: 'Priya Patel', phone: '5875550111' }), W({ id: '8', name: 'Priya Patel', phone: '5875550222' })],
  ['identical names + different sign-in accounts',
    W({ id: '9', name: 'Tom Lee', auth_user_id: 'auth-1' }), W({ id: '10', name: 'Tom Lee', auth_user_id: 'auth-2' })],
]
for (const [label, a, b] of NAME_ONLY_CASES) {
  const r = scanWorkerIdentities([a, b])
  check(`⛔ ${label} → no duplicate finding`, r.findings.length === 0,
    `produced ${r.findings.length} finding(s) — a name must never be evidence`)
}
// ⭐ The rehire SHAPE alone must not manufacture a finding either.
check('⛔ the rehire shape ALONE (no shared identifier) creates nothing',
  scanWorkerIdentities([
    W({ id: 'x', name: 'A One', is_active: false, archived_at: '2025-01-01T00:00:00Z', ended_on: '2024-12-31' }),
    W({ id: 'y', name: 'B Two', hired_on: '2025-06-01' }),
  ]).findings.length === 0,
  '"somebody left and somebody started" describes two different people perfectly well')
check('…and confidenceFor refuses to rate an empty evidence list',
  confidenceFor([], true) === null && confidenceFor([], false) === null)

// ── 3. The ladder, and why it is shaped for a workforce ──────────────────────
console.log('\n═══ The confidence ladder ═══')
const ev = (a: WorkerIdentityLike, b: WorkerIdentityLike) => identityEvidence(a, b)

{
  const a = W({ id: 'a', name: 'One Person', auth_user_id: 'auth-same' })
  const b = W({ id: 'b', name: 'Totally Different Name', auth_user_id: 'auth-same' })
  const e = ev(a, b)
  check('⭐⭐ the same sign-in account is CONFIRMED — the database already said so',
    e.some(x => x.kind === 'auth_account') && confidenceFor(e, false) === 'confirmed')
  check('…and it works across DIFFERENT names, because the account is the identity',
    scanWorkerIdentities([a, b]).findings[0]?.confidence === 'confirmed')
}
{
  const e = ev(W({ id: 'a', phone: '4035550100' }), W({ id: 'b', phone: '+1 403 555 0100' }))
  check('⚠️ a shared phone ALONE is only POSSIBLE — a crew shares one handset',
    e.length === 1 && e[0].kind === 'shared_phone' && confidenceFor(e, false) === 'possible')
  check('⛔ …and the rehire shape does NOT lift it, because that fits colleagues too',
    confidenceFor(e, true) === 'possible')
  check('…the canonical last-ten-digit rule is what matched it',
    e[0].kind === 'shared_phone',
    'reusing lib/customers.phoneMatches is what keeps two doors from disagreeing about identity')
}
{
  const e = ev(W({ id: 'a', email: 'x@y.test' }), W({ id: 'b', email: '  X@Y.TEST ' }))
  check('a shared email alone is POSSIBLE, and normalises case and whitespace',
    e.length === 1 && e[0].kind === 'shared_email' && confidenceFor(e, false) === 'possible')
}
{
  const e = ev(W({ id: 'a', email: 'x@y.test', phone: '4035550100' }),
               W({ id: 'b', email: 'x@y.test', phone: '4035550100' }))
  check('⭐ TWO independent channels agreeing is PROBABLE — one handset explains one, not both',
    e.length === 2 && confidenceFor(e, false) === 'probable')
}
{
  const e = ev(W({ id: 'a', invite_code: 'inv-1' }), W({ id: 'b', invite_code: 'inv-1' }))
  check('one invitation behind two rows is PROBABLE — nothing shares a machine-minted code',
    e.length === 1 && e[0].kind === 'shared_invite' && confidenceFor(e, false) === 'probable')
}
check('evidence is returned strongest-first, from ONE declared order',
  ev(W({ id: 'a', auth_user_id: 'u', email: 'e@x.test', phone: '4035550100' }),
     W({ id: 'b', auth_user_id: 'u', email: 'e@x.test', phone: '4035550100' }))
    .map(e => e.kind).join() === 'auth_account,shared_email,shared_phone')
check('every evidence kind has a rank, a label and a strength entry',
  EVIDENCE_STRENGTH.every(k => !!EVIDENCE_LABEL[k])
  && new Set(EVIDENCE_STRENGTH).size === EVIDENCE_STRENGTH.length)
check('every confidence has a label AND a sentence saying what it means',
  (['confirmed', 'probable', 'possible'] as const)
    .every(c => CONFIDENCE_LABEL[c].length > 3 && CONFIDENCE_MEANING[c].length > 25))

// ── 4. ⛔⛔ The empty-value trap, and cross-tenant isolation ─────────────────
console.log('\n═══ Empty is not a match, and another tenant is not comparable ═══')
check('⛔⛔ two rows with NO email do not "share an email"',
  ev(W({ id: 'a', email: null }), W({ id: 'b', email: '' })).length === 0,
  'the empty-string trap would pair every under-filled row on the roster with every other')
check('⛔ …the same for phone, account and invite',
  ev(W({ id: 'a' }), W({ id: 'b' })).length === 0
  && ev(W({ id: 'a', auth_user_id: '' }), W({ id: 'b', auth_user_id: null })).length === 0
  && ev(W({ id: 'a', invite_code: '  ' }), W({ id: 'b', invite_code: '' })).length === 0)
check('⛔ a whitespace-only phone is not a phone',
  ev(W({ id: 'a', phone: '   ' }), W({ id: 'b', phone: '' })).length === 0)
check('⛔ a too-short phone fragment cannot link two people',
  ev(W({ id: 'a', phone: '555' }), W({ id: 'b', phone: '555' })).length === 0,
  'the canonical rule floors at 7 digits precisely so a stray partial cannot')

// ⛔⛔ CROSS-TENANT. Identical everything, different tenant.
{
  const a = W({ id: 'a', user_id: 'tenant-a', name: 'Same Person', email: 'same@x.test', auth_user_id: 'auth-1' })
  const b = W({ id: 'b', user_id: 'tenant-b', name: 'Same Person', email: 'same@x.test', auth_user_id: 'auth-1' })
  check('⛔⛔ identical rows in DIFFERENT tenants produce no evidence at all',
    ev(a, b).length === 0)
  const r = scanWorkerIdentities([a, b])
  check('⛔⛔ …and the scanner never forms the pair',
    r.findings.length === 0 && r.uncheckable.length === 0,
    'tenants are bucketed BEFORE comparison — a cross-tenant pair is never formed, not filtered late')
  // And the same rows, same tenant, DO pair — or the check above proves nothing.
  const same = scanWorkerIdentities([a, { ...b, user_id: 'tenant-a' }])
  check('…proven non-vacuous: the identical pair DOES flag inside one tenant',
    same.findings.length === 1 && same.findings[0].confidence === 'confirmed')
}
check('a row compared with itself is never a duplicate of itself',
  ev(W({ id: 'a', email: 'x@y.test' }), W({ id: 'a', email: 'x@y.test' })).length === 0)
check('malformed rows are skipped rather than crashing the roster',
  scanWorkerIdentities([
    { id: '', user_id: T, name: 'x' } as WorkerIdentityLike,
    W({ id: 'ok' }),
  ]).findings.length === 0 && scanWorkerIdentities([]).findings.length === 0)

// ── 5. The rehire predicate ──────────────────────────────────────────────────
console.log('\n═══ Rehire is corroboration, and unknown dates are not "no overlap" ═══')
const archived = (o: Partial<WorkerIdentityLike>) => W({ id: 'p', is_active: false, archived_at: '2025-01-01T00:00:00Z', ...o })
check('archived + active with non-overlapping dates IS rehire-shaped',
  isRehireShaped(archived({ ended_on: '2024-12-31' }), W({ id: 'n', hired_on: '2025-06-01' })))
check('⚠️ MISSING dates answer false — unknown is not "no overlap"',
  !isRehireShaped(archived({ ended_on: null }), W({ id: 'n', hired_on: '2025-06-01' }))
  && !isRehireShaped(archived({ ended_on: '2024-12-31' }), W({ id: 'n', hired_on: null })))
check('OVERLAPPING employment is not a rehire — they worked together',
  !isRehireShaped(archived({ ended_on: '2025-12-31' }), W({ id: 'n', hired_on: '2025-06-01' })))
check('two ACTIVE rows are not rehire-shaped', !isRehireShaped(W({ id: 'a' }), W({ id: 'b' })))
check('two ARCHIVED rows are not rehire-shaped',
  !isRehireShaped(archived({ id: 'a', ended_on: '2024-01-01' }), archived({ id: 'b', ended_on: '2024-06-01' })))
check('is_active=false counts as archived even with no archived_at',
  isRehireShaped(W({ id: 'a', is_active: false, ended_on: '2024-12-31' }), W({ id: 'b', hired_on: '2025-01-01' })))

// ── 6. ⛔⛔ NOTHING IN THIS SEAM CAN ACT ─────────────────────────────────────
console.log('\n═══ A detector that could act is one bug from rewriting payroll ═══')
const ENGINE_SRC = read('src/lib/workforceIdentity.ts')
const DATA_SRC = read('src/lib/workforceIdentityData.ts')
const UI_SRC = read('src/components/workforce/WorkerIdentityWarnings.tsx')
for (const [n, s] of [['engine', ENGINE_SRC], ['data', DATA_SRC], ['ui', UI_SRC]] as const) {
  check(`the comment stripper is alive on the ${n}`, stripperAlive(s))
}
const ENGINE = strip(ENGINE_SRC), DATA = strip(DATA_SRC), UI = strip(UI_SRC)

const WRITES = /\.(insert|update|upsert|delete|rpc)\s*\(/
check('⛔⛔ the ENGINE performs no write and holds no database client',
  !WRITES.test(ENGINE) && !/createClient|SupabaseClient|from\(/.test(ENGINE),
  'it is pure: rows in, findings out')
check('⛔⛔ the DATA module performs no write',
  !/\.(insert|update|upsert|delete|rpc)\s*\(/.test(DATA),
  'counts are the only thing it is allowed to learn')
check('⛔⛔ the WARNING SURFACE performs no write',
  !WRITES.test(UI),
  'every control either expands something or opens the existing worker editor')
// ⚠️ Asserted STRUCTURALLY, not by word. An earlier version of this check
// searched for a function NAMED merge-something and duly flagged
// `mergeBlockedReason` — the refusal itself. The rule that actually matters is
// that only ONE function in this seam can reach the database at all, and it
// counts rows.
const clientTakers = [...[ENGINE, DATA, UI].join('\n')
  .matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g)]
  .filter(m => /Supabase(Client)?|createClient/.test(m[2]))
  .map(m => m[1])
check('⛔⛔ exactly ONE function in the seam can reach the database, and it COUNTS',
  clientTakers.length === 1 && clientTakers[0] === 'loadWorkerHistoryCounts',
  `functions taking a client: ${clientTakers.join(', ') || 'none'} — anything else here could act`)
check('⛔ mergeBlockedReason cannot perform a merge — it returns a string, always',
  /export function mergeBlockedReason\([\s\S]{0,400}?\): string \{/.test(ENGINE)
  && typeof mergeBlockedReason(null, null) === 'string',
  'it is the absence of a merge, written down so a later phase has to delete it deliberately')
check('⛔ nothing reassigns a technician_id, which is how history would move',
  ![ENGINE, DATA, UI].some(s => /technician_id\s*:/.test(s)))
check('⛔ nothing writes archived_at or is_active',
  ![ENGINE, DATA, UI].some(s => /(archived_at|is_active)\s*:\s*(true|false|new Date|null)/.test(s)))

console.log('\n═══ Tenant scoping is a PREDICATE, not a post-filter ═══')
// Every read in the data module must carry BOTH scopes in its own chain.
const chains = DATA.split(/\.from\(/).slice(1)
check('the data module makes the reads it claims to', chains.length >= 1, `${chains.length} chains`)
check('⛔⛔ every read is scoped by user_id AND technician_id in its own chain',
  chains.every(c => {
    const head = c.slice(0, 320)
    return /\.eq\('user_id', userId\)/.test(head) && /\.eq\('technician_id', id\)/.test(head)
  }),
  'another tenant’s row must never be in memory, not merely filtered out afterwards')
check('all six history tables are counted, from one declared list',
  ['time_entries', 'pay_run_lines', 'wage_history', 'pto_entries', 'jobs', 'technician_crew_history']
    .every(t => DATA.includes(`'${t}'`)))
check('⚠️ an unreadable count is reported as UNREADABLE, never as zero',
  /unreadable/.test(DATA) && /if \(error\) \{ unreadable\.add\(table\); return \}/.test(DATA),
  '"nothing points at this record" is the reading that would make a deletion look safe')
check('…and the surface SAYS so when a count could not be read',
  /could not be checked/.test(UI_SRC) && /incomplete/.test(UI_SRC))

console.log('\n═══ The surface promises nothing it cannot do ═══')
check('it renders NOTHING when there is nothing to say',
  /if \(!findings\.length && !uncheckable\.length\) return null/.test(UI),
  'an empty warning card teaches an owner to scroll past where warnings appear')
// ⚠️ Asserted over what the CONTROLS DO, not over words on the page. An earlier
// version searched the file for "merge"/"archive" and matched a JSX comment
// explaining why there is no merge button, plus `t.archived_at` — a READ. The
// rule is about handlers: every interactive element must call something from a
// known-safe set.
const HANDLERS_ALLOWED = /^(onOpen|expand|setOpenPair|setShowUncheckable)\b/
const handlers = [...UI.matchAll(/onClick=\{\(\)\s*=>\s*([\s\S]*?)\}/g)].map(m => m[1].trim())
check('the handler extractor found the surface’s real controls',
  handlers.length >= 4, `found ${handlers.length}`)
check('⛔⛔ EVERY control either expands something or opens the existing editor',
  handlers.every(h => HANDLERS_ALLOWED.test(h.replace(/^v\s*=>\s*/, ''))),
  `offending: ${handlers.filter(h => !HANDLERS_ALLOWED.test(h.replace(/^v\s*=>\s*/, ''))).join(' | ')}`)
check('…and Review is the word used for it',
  /Review \{a\.name\}/.test(UI) && /Review \{b\.name\}/.test(UI),
  'no destructive action exists in this phase')
check('⛔ the uncheckable section never calls those records duplicates',
  /not enough information to tell/.test(UI_SRC),
  'a shared name is the roster saying it lacks an identifier, not an accusation')
check('each finding shows WHY it was flagged, and each record’s standing',
  /EVIDENCE_LABEL\[e\.kind\]/.test(UI) && /standing\(a\)/.test(UI) && /standing\(b\)/.test(UI))
check('…and the linked history counts, which are the reason there is no merge',
  /totalHistoryRows\(/.test(UI) && /payRunLines/.test(UI) && /wageHistory/.test(UI))
check('the surface reads the roster INCLUDING archived rows',
  /archived included/.test(UI_SRC) || /archived_at/.test(UI_SRC),
  'a rehire is exactly one archived row beside one active one')

console.log('\n═══ The identity rule is reused, never re-implemented ═══')
check('⭐ the engine imports the canonical contact rules from lib/customers',
  /from '@\/lib\/customers'/.test(ENGINE)
  && /normalizeEmail/.test(ENGINE) && /phoneMatches/.test(ENGINE),
  'two doors deciding "same person?" differently is how one person becomes two records')
check('⛔ it does not re-implement phone or email normalisation',
  !/replace\(\/\\D\/g/.test(ENGINE) && !/toLowerCase\(\)\s*$/m.test(ENGINE))

// Totals helper, so the surface cannot quietly under-report what is at stake.
check('totalHistoryRows counts every category',
  totalHistoryRows({ timeEntries: 1, payRunLines: 2, wageHistory: 3, ptoEntries: 4, jobs: 5, crewHistory: 6 }) === 21
  && totalHistoryRows(null) === 0)

console.log('\n── Summary ────────────────────────────────────────────────────')
console.log(failures === 0
  ? '\n✅ verify:workforce-identity — a name decides nothing, evidence only warns, and nothing in this seam can move a payroll record\n'
  : `\n❌ verify:workforce-identity — ${failures} contract${failures === 1 ? '' : 's'} broken\n`)
process.exit(failures === 0 ? 0 : 1)
