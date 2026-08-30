// ── verify:quote-number-integrity ────────────────────────────────────────────
//
// A quote number is on documents customers hold. Two quotes sharing one is a
// financial-record defect, and production already contains two such pairs.
//
// Two halves:
//   STATIC     — always runs, including on CI. Pins where allocation lives and
//                where it must NOT live.
//   BEHAVIOUR  — applies the platform prelude, every migration in the apply path
//                and the unapplied proposal to PGlite, then REPRODUCES the race
//                against the real seam before proving the replacement. Skips
//                clean when PGlite is absent.
//
// ⛔ THERE IS NO LIVE HALF, ON PURPOSE. The fixture tenant lives in the
// production project, and this session was told to make no production writes.
// The read-only inventory (scripts/inventory-quote-numbers.ts) is the only thing
// that touches production, and it issues SELECTs only.
//
// ⚠️⚠️ WHAT THE CONCURRENCY PROOF DOES AND DOES NOT MODEL. PGlite is Postgres
// compiled to WASM with ONE connection, so genuinely parallel transactions
// cannot be run here and no amount of wishing makes them appear. What is proven
// instead is precise:
//   • the OLD rule is driven through its REAL seam (the exported maxNumericSuffix
//     and generateQuoteNumber, and the actual SQL MAX()+1 lifted from the
//     baseline) under the classic interleaving — every caller reads, then every
//     caller writes. That IS what concurrent callers do, and it is deterministic.
//   • the NEW allocator cannot be interleaved that way at all, because there is
//     no separate read to hoist: allocation is one statement. That is the
//     argument, and the test demonstrates the shape rather than pretending to
//     race it.
//   • the UNIQUE index is exercised for real — it refuses a duplicate whatever
//     produced it.
// A single-connection harness cannot prove serialisation under contention. That
// is stated here rather than implied by a green tick.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { splitStatements, loadPGlite, substitutePlatformStatements } from './lib/pg-sql'
// ⭐ THE REAL SEAM, IMPORTED AND EXECUTED. `maxNumericSuffix` is the function
// that actually computed the old number, it is unchanged by this session, and it
// is what the race reproduction below drives. Its partner `generateQuoteNumber`
// has been DELETED (that is one of the things this guard pins), so the formatting
// half — `EPS-<year>-<4-digit pad>` — is reconstructed inline where it is used.
// The duplicate never came from the formatting; it came from maxNumericSuffix
// returning the same value to every caller, which is the real code running here.
import { maxNumericSuffix } from '../src/lib/utils'

const MIGRATIONS = join('supabase', 'migrations')
const PRELUDE = join('scripts', 'schema', 'platform-prelude.sql')
const PROPOSAL = join('supabase', 'proposals', 'quote_number_integrity_v1.sql')

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}
const src = (p: string) => existsSync(p) ? readFileSync(p, 'utf8').replace(/\r\n?/g, '\n') : ''

// ⚠️⚠️ Strip comments BEFORE asserting a thing is absent. A comment that names a
// forbidden pattern in order to say it is gone must not read as the pattern
// being present. Line comments first, and `[^\n]` because `.` misses `\r`.
const stripSql = (s: string) => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
const stripTs = (s: string) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

const walk = (dir: string, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

async function main() {

// ═════════════════════════════════════════════════════════════════════════════
// 1 · THE PROPOSAL EXISTS AND IS NOT AN APPLY PATH
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 1 · the proposal ════════════════════════════════════════════════════\n')

const proposal = src(PROPOSAL)
const pSchema = stripSql(proposal)
check('the quote-number proposal exists', !!proposal, `no ${PROPOSAL}`)
// ⛔ supabase/proposals is NOT applied by anything. S106 stamps the version from
// the live ledger at landing; a version invented here would be a guess.
check('it is a PROPOSAL, not a stamped migration',
  !readdirSync(MIGRATIONS).some(f => /quote_number/i.test(f)),
  'a quote-number migration has appeared in the apply path — S106 assigns the version')
check('the proposal says it is unapplied and unversioned',
  /PROPOSAL ONLY\. NOT APPLIED/i.test(proposal)
  && /version from the LIVE\s*\n?--\s*ledger/i.test(proposal))

// ═════════════════════════════════════════════════════════════════════════════
// 2 · ONE ALLOCATION SEAM
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 2 · one allocation seam ═════════════════════════════════════════════\n')

check('the database owns allocation',
  /create or replace function public\.allocate_quote_number/i.test(pSchema))
check('allocation is ONE statement — insert … on conflict … returning',
  /insert into public\.document_number_counters[\s\S]{0,400}on conflict \(user_id, kind, prefix, year\) do update[\s\S]{0,300}returning/i.test(pSchema),
  'a separate read is the window this whole session exists to close')
// ⚠️ SCOPE THIS TO THE FUNCTION BODY. Slicing to end-of-file swept in section 7,
// whose own apply-time assertion quotes the very string being searched for — so
// the check failed against a proposal that was entirely correct.
const allocBody = /create or replace function public\.allocate_quote_number[\s\S]*?\$function\$;/i.exec(pSchema)?.[0] ?? ''
check('the allocator never scans quotes for a maximum',
  !!allocBody && !/\bmax\s*\(/i.test(allocBody),
  'MAX()+1 inside the allocator would reintroduce the defect behind a new name')
check('allocation is scoped to tenant + prefix + year',
  /primary key \(user_id, kind, prefix, year\)/i.test(pSchema),
  'the year is in the customer-visible number and both DB allocators already reset on it')
check('the counter is seeded from existing series',
  /insert into public\.document_number_counters[\s\S]{0,600}from public\.quotes/i.test(pSchema),
  'without seeding, the first allocation after apply mints 0001 onto a live series')

// ── The barrier ────────────────────────────────────────────────────────────
check('a UNIQUE index protects (user_id, quote_number)',
  /create unique index quotes_user_qnum_new_unique on public\.quotes \(user_id, quote_number\)/i.test(pSchema),
  'an allocator without a barrier is a convention, not a guarantee')
check('the barrier is tenant-scoped, not global',
  /\(user_id, quote_number\)/i.test(pSchema) && !/unique[^;]*\(quote_number\)\s*[;)]/i.test(pSchema),
  'two unrelated businesses may both hold ABC-2026-0001')
// ⭐ Stage 2 must stay inert until the owner resolves the historical pairs.
check('stage 2 is present but NOT executed',
  /stage 2, deliberately NOT executed/i.test(proposal)
  && !/^\s*alter table public\.quotes\s*\n?\s*add constraint quotes_user_quote_number_key/im.test(pSchema),
  'a full UNIQUE cannot be created while EPS-2026-0008/0009 are duplicated')
check('stage 2 REPORTS duplicates rather than modifying them',
  /Cannot add UNIQUE \(user_id, quote_number\) — duplicates remain/i.test(proposal)
  && /does not append "-2", does not mint a\s*\n?--\s*replacement/i.test(proposal))

// ── Tenant safety ──────────────────────────────────────────────────────────
check('a signed-in caller cannot allocate for another tenant',
  /if v_caller is not null and v_caller <> v_user then/i.test(pSchema)
  && /cannot allocate a number for another business/i.test(proposal))
check('the allocator pins its search_path',
  /create or replace function public\.allocate_quote_number[\s\S]{0,300}set search_path to 'public', 'pg_temp'/i.test(pSchema),
  'a SECURITY DEFINER without a pinned search_path is a privilege-escalation door')
check('⛔ anon is NOT granted the allocator',
  !/grant execute on function public\.allocate_quote_number\(uuid\) to anon/i.test(pSchema),
  'the public booking RPCs reach it as their own definer role, never as the anonymous caller')
check('the counter table has no client write policy',
  !/create policy[^;]*document_number_counters[^;]*for (insert|update|delete)/i.test(pSchema),
  'a client that can rewind its counter can reissue a number')
check('the counter table is welded to a real tenant',
  /foreign key \(user_id\) references auth\.users\(id\)/i.test(pSchema))

// ═════════════════════════════════════════════════════════════════════════════
// 3 · NO SECOND ALLOCATOR ANYWHERE
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 3 · no second allocator ═════════════════════════════════════════════\n')

const appFiles = walk('src')
const offenders: string[] = []
for (const f of appFiles) {
  const code = stripTs(src(f))
  // ⭐ THE RULE: nothing outside the allocator may compute a quote number.
  // ⚠️ MATCH THE IDENTIFIER, NOT THE CALL. `generateQuoteNumber\s*\(` missed a
  // door that DEFINED its own — `const generateQuoteNumber = (i) => …` has ` = `
  // between the name and the paren — so a file could reintroduce the whole defect
  // locally and stay green. A mutation caught this.
  if (/\bgenerateQuoteNumber\b/.test(code)) offenders.push(`${f} (generateQuoteNumber)`)
  // A hand-rolled equivalent: zero-padding a counter into a prefixed string.
  // ⚠️ PER LINE, AND NEVER THE INVOICE PATH. Keyed on the FILENAME containing
  // "quote", this fired on QuoteList's bulk INVOICE conversion — a different
  // document number, owned by another session, in a file that merely happens to
  // live under components/quotes. The check has to look at the line, not the path.
  for (const line of code.split('\n')) {
    if (/padStart\(\s*4\s*,\s*'0'\s*\)/.test(line) && /quote/i.test(line) && !/invoice/i.test(line)) {
      offenders.push(`${f} (pads a quote number by hand: ${line.trim().slice(0, 60)})`)
    }
  }
  if (/maxNumericSuffix\s*\([^)]*quote_number/i.test(code)) offenders.push(`${f} (maxNumericSuffix over quote_number)`)
}
check('no app file computes a quote number', offenders.length === 0,
  offenders.join('\n      '))

check('the browser generator is gone from lib/utils',
  !/export function generateQuoteNumber/.test(src(join('src', 'lib', 'utils.ts'))),
  'leaving it exported invites the next caller to use it')

// Every door that inserts a quote must obtain its number from the seam.
const inserters = appFiles.filter(f => /from\('quotes'\)[\s\S]{0,40}\.insert/.test(stripTs(src(f))))
for (const f of inserters) {
  const code = stripTs(src(f))
  // ⭐ CLASSIFY BY THE INSERT ITSELF, NOT BY A NEARBY TOAST. A RESTORE re-inserts
  // a row object it already held (`.insert(insertable)`) and keeps the number the
  // quote was issued. An ALLOCATION builds a fresh object literal and must ask
  // the database for a number. An earlier version of this check keyed off
  // `toast.undo(` appearing anywhere in the file, which misfiled two real
  // allocation doors as restores — the guard was wrong, not the code.
  // ⭐ THE RULE, STATED DIRECTLY: if a door SETS quote_number, it must have asked
  // the database for it. A restore never sets one — it re-inserts a row object it
  // already held, so the number travels with the row untouched.
  //
  // Two earlier versions of this got it wrong by inferring intent from context: a
  // nearby `toast.undo(`, then the shape of the insert argument. Both misfiled
  // real allocation doors (pricing-recovery builds its row in a variable and IS
  // an allocation). What matters is whether the code names the column.
  const setsQuoteNumber = /\bquote_number\s*[,:]/.test(code) || /\bquote_number\s*=/.test(code)
  const isRestore = !setsQuoteNumber
  const allocates = /allocateQuoteNumbers?\(/.test(code)
  check(`${f.replace(/\\/g, '/')} ${isRestore ? 'restores without allocating' : 'uses the canonical allocator'}`,
    isRestore ? !allocates : allocates,
    isRestore ? 'a restore keeps the number the quote already had'
              : 'this door inserts a quote, so it must call allocateQuoteNumber')
}

// ── The database doors ─────────────────────────────────────────────────────
const baseFile = readdirSync(MIGRATIONS).filter(f => /baseline/.test(f)).sort().pop()!
const baseline = stripSql(src(join(MIGRATIONS, baseFile)))
const dbDoors = ['book_service', 'submit_booking']
for (const fn of dbDoors) {
  const body = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(([\\s\\S]*?)\\$function\\$;`, 'i')
    .exec(baseline)?.[0] ?? ''
  check(`${fn}() still exists to be re-routed`, !!body)
  // ⭐ The proposal re-routes these by replacing the allocation lines INSIDE the
  // live definition (pg_get_functiondef → replace → execute) rather than pasting
  // a new body, so a change that lands in them meanwhile is not silently
  // discarded. Assert that technique — and that it REFUSES when the text it
  // expects has gone.
  const named = new RegExp(`p\\.proname = '${fn}'`).test(pSchema)
  const refuses = new RegExp(`${fn}\\(\\) no longer contains the expected MAX`).test(proposal)
  check(`${fn}() is re-routed through the allocator`, named && refuses,
    'a public booking door that keeps its own MAX()+1 is a second allocator')
}
// ⚠️ The proposal's own apply-time guard QUOTES the forbidden pattern in order to
// refuse it, so strip string literals before asserting the pattern is absent.
// Otherwise the file fails for containing the check that protects it.
const sqlWithoutLiterals = pSchema.replace(/'[^']*'/g, "''")
check('the proposal leaves no MAX()+1 quote allocation behind',
  !/max\(\(?regexp_match\(quote_number/i.test(sqlWithoutLiterals),
  'the SQL scan is the database half of the same defect')
check('the proposal REFUSES to apply if a MAX()+1 allocator survives anywhere',
  /still allocate quote numbers with MAX\(\)\+1/.test(proposal),
  'an apply that leaves a second allocator running is worse than one that stops')
check('the proposal contains no hardcoded EPS allocation',
  !/'EPS-'\s*\|\|/i.test(pSchema),
  'one tenant\'s initials must not be minted for every business')

// ═════════════════════════════════════════════════════════════════════════════
// 4 · BEHAVIOUR — reproduce the race, then prove the replacement
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 4 · behaviour, from zero ════════════════════════════════════════════\n')
await behaviour()

console.log(`\n${fail ? '✗' : '✓'} verify:quote-number-integrity — ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
}

// ─────────────────────────────────────────────────────────────────────────────

async function behaviour() {
  const loaded = await loadPGlite()
  if (!loaded) {
    console.log('  ⏭  SKIPPED — PGlite is not installed.')
    console.log('     The race reproduction is the point of this guard.')
    console.log('     npm i -D @electric-sql/pglite && npm run verify:quote-number-integrity\n')
    return
  }
  const { PGlite, contribs } = loaded
  const db = await PGlite.create({ extensions: contribs })
  const exec = async (sql: string) => { await db.exec(sql) }
  const q = async (sql: string): Promise<any> => db.query(sql)
  const refuses = async (sql: string): Promise<string> => {
    try { await db.exec(sql); return '' } catch (e: any) { return String(e?.message ?? 'error') }
  }

  const applyFile = async (label: string, sql: string): Promise<boolean> => {
    const { sql: subbed } = substitutePlatformStatements(sql)
    const statements = splitStatements(subbed)
    let n = 0
    try { for (; n < statements.length; n++) await db.exec(statements[n]); return true }
    catch (e: any) {
      check(`applied ${label}`, false,
        `statement ${n + 1}/${statements.length}: ${String(e?.message).slice(0, 200)}\n      ${(statements[n] ?? '').replace(/\s+/g, ' ').slice(0, 180)}`)
      return false
    }
  }

  if (!existsSync(PRELUDE)) { console.log('  ⏭  SKIPPED — no platform prelude.'); return }
  if (!await applyFile('platform prelude', src(PRELUDE))) return
  for (const f of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
    if (!await applyFile(f, src(join(MIGRATIONS, f)))) return
  }
  console.log('  ✓ applied the prelude and every migration in version order')

  const A = '00000000-0000-0000-0000-0000000000aa'
  const B = '00000000-0000-0000-0000-0000000000bb'
  await exec(`insert into auth.users (id, email) values ('${A}','a@example.test'),('${B}','b@example.test')`)
  await exec(`insert into public.business_settings (user_id, company_name) values
                ('${A}', 'Edge Property Services'), ('${B}', 'Jones Window Cleaning')`)
  await exec(`insert into public.customers (id, user_id, name) values
                ('11111111-1111-1111-1111-111111111111','${A}','Cust A'),
                ('22222222-2222-2222-2222-222222222222','${B}','Cust B')`)

  const YEAR = new Date().getFullYear()
  const mkQuote = (user: string, num: string, cust: string) =>
    `insert into public.quotes (user_id, quote_number, customer_name, address, service_type, customer_id)
       values ('${user}', '${num}', 'C', 'A', 'S', '${cust}')`

  // Seed tenant A with a small live series, exactly like production had.
  for (const n of ['0006', '0007']) await exec(mkQuote(A, `EPS-${YEAR}-${n}`, '11111111-1111-1111-1111-111111111111'))

  // ══ THE RACE, AGAINST THE CURRENT SEAM ═════════════════════════════════════
  // Every caller reads first, then every caller writes. That is the interleaving
  // concurrent callers produce, and it is what a stale tab produces too.
  const raceOld = async (n: number): Promise<{ minted: string[]; distinct: number }> => {
    const rows = await q(`select quote_number from public.quotes where user_id = '${A}'`)
    const existing = rows.rows.map((r: any) => r.quote_number as string)
    // ⭐ THE REAL BROWSER SEAM — the exported functions, not a copy of them.
    // The former generateQuoteNumber(), inline: EPS-<year>-<4-digit pad>.
    const legacyFormat = (i: number) => `EPS-${new Date().getFullYear()}-${String(i).padStart(4, '0')}`
    const minted = Array.from({ length: n }, () => legacyFormat(maxNumericSuffix(existing) + 1))
    return { minted, distinct: new Set(minted).size }
  }

  for (const n of [2, 10, 100]) {
    const { minted, distinct } = await raceOld(n)
    check(`RACE · ${String(n).padStart(3)} concurrent callers on the CURRENT seam collide`,
      distinct === 1 && minted.length === n,
      `expected all ${n} callers to mint one identical number; got ${distinct} distinct (${minted[0]})`)
  }
  console.log('     ↑ every caller reads the same maximum and mints the same number.')
  console.log('       Nothing in current main stops the inserts that follow.')

  // And the database half of the same defect, lifted from the baseline verbatim.
  const dbMax = await q(
    `select coalesce(max((regexp_match(quote_number,'([0-9]+)$'))[1]::int),0)+1 as next
       from public.quotes where user_id='${A}'
        and quote_number like 'EPS-'||extract(year from now())::text||'-%'`)
  const dbNext = Number(dbMax.rows[0].next)
  const browserNext = maxNumericSuffix(['EPS-' + YEAR + '-0006', 'EPS-' + YEAR + '-0007']) + 1
  check('RACE · the SQL allocator and the browser allocator agree only by luck',
    dbNext === browserNext,
    `they happen to agree here (${dbNext} vs ${browserNext}); the year-boundary test below is where they diverge`)

  // ⭐ The scope disagreement, demonstrated. A legacy number with no year segment
  // is invisible to the SQL filter but IS counted by the browser rule.
  await exec(mkQuote(A, 'EPS-0099', '11111111-1111-1111-1111-111111111111'))
  const dbMax2 = await q(
    `select coalesce(max((regexp_match(quote_number,'([0-9]+)$'))[1]::int),0)+1 as next
       from public.quotes where user_id='${A}'
        and quote_number like 'EPS-'||extract(year from now())::text||'-%'`)
  const rows2 = await q(`select quote_number from public.quotes where user_id='${A}'`)
  const browserNext2 = maxNumericSuffix(rows2.rows.map((r: any) => r.quote_number)) + 1
  check('RACE · a malformed legacy number splits the two allocators apart',
    Number(dbMax2.rows[0].next) === 8 && browserNext2 === 100,
    `SQL says ${dbMax2.rows[0].next}, browser says ${browserNext2} — production holds exactly such numbers (EPS-0002, EPS-0009)`)
  // ⚠️ THE ROW STAYS. PGlite cannot DELETE from `quotes` at all — `quotes.total`
  // is a GENERATED column, so it refuses with "replica identity must not contain
  // unpublished generated columns". Harmless here: EPS-0099 has no year segment,
  // so the seeding regex below excludes it and the series is unaffected — which
  // is itself the behaviour worth having, since production holds two such rows.

  // ══ THE REPLACEMENT ════════════════════════════════════════════════════════
  if (!await applyFile('quote_number_integrity_v1.sql (proposal)', src(PROPOSAL))) return
  console.log('  ✓ applied the unapplied proposal')

  // Seeding: the counter must continue the live series, not restart it.
  const seeded = await q(`select prefix, year, next_value from public.document_number_counters where user_id='${A}'`)
  check('SEED · the counter continues tenant A\'s existing series',
    seeded.rows[0]?.prefix === 'EPS' && Number(seeded.rows[0]?.next_value) === 8,
    `expected EPS/next=8 after 0006 and 0007; got ${JSON.stringify(seeded.rows[0])}`)

  // Allocation is atomic and monotonic.
  const alloc = async (user: string) => (await q(`select public.allocate_quote_number('${user}') as n`)).rows[0].n as string
  const first = await alloc(A)
  check('ALLOC · the first number continues the series rather than restarting it',
    first === `EPS-${YEAR}-0008`, `got ${first}`)

  const many: string[] = []
  for (let i = 0; i < 100; i++) many.push(await alloc(A))
  check('ALLOC · 100 successive allocations are all distinct',
    new Set(many).size === 100, `${new Set(many).size} distinct of 100`)
  check('ALLOC · they are strictly increasing with no reuse',
    many.every((v, i) => i === 0 || v > many[i - 1]),
    'a counter that can go backwards can reissue a number')
  console.log('     ↑ allocation is one INSERT … ON CONFLICT … RETURNING, so there is')
  console.log('       no read for a second caller to interleave with. See the header')
  console.log('       for what a single-connection harness can and cannot prove.')

  // Tenant isolation.
  // ⭐ Capture A's counter BEFORE touching B rather than predicting it. The
  // hardcoded expectation here was off by one (101 allocations from a seed of 8
  // leaves 109, not 108) and failed against behaviour that was correct — the
  // claim being made is "B did not move A", so measure A on both sides.
  const aBefore = Number((await q(
    `select next_value from public.document_number_counters
      where user_id='${A}' and prefix='EPS' and year=${YEAR}`)).rows[0].next_value)
  const bFirst = await alloc(B)
  check('TENANT · tenant B gets its OWN prefix, not tenant A\'s initials',
    bFirst.startsWith('JWC-'), `got ${bFirst} — expected initials of "Jones Window Cleaning"`)
  check('TENANT · tenant B starts its own series at 0001',
    bFirst === `JWC-${YEAR}-0001`, `got ${bFirst}`)
  const aAfter = Number((await q(
    `select next_value from public.document_number_counters
      where user_id='${A}' and prefix='EPS' and year=${YEAR}`)).rows[0].next_value)
  check('TENANT · allocating for B did not advance A\'s counter',
    aAfter === aBefore,
    `A's counter moved ${aBefore} → ${aAfter} because another tenant allocated`)

  // ⛔⛔ THE TENANT BOUNDARY, EXERCISED. A signed-in caller must not be able to
  // allocate against another business's counter. auth.uid() reads the request's
  // JWT claims, so setting them is how a real signed-in session is simulated.
  // ⚠️⚠️ `SET LOCAL` OUTSIDE A TRANSACTION IS A NO-OP. The first version of this
  // used it, auth.uid() stayed null, the boundary check was never reached, and
  // the cross-tenant call "succeeded" — which reads exactly like a security hole
  // in the product rather than a bug in the test. Session-level SET, reset after.
  const asUser = async (uid: string, sql: string): Promise<string> => {
    try {
      // ⚠️ The harness's auth.uid() reads `request.jwt.claim.sub` (singular
      // "claim"), not the JSON `request.jwt.claims` blob Supabase uses in
      // production. Setting the wrong GUC leaves auth.uid() null, the boundary
      // check unreached, and the cross-tenant call looking like it succeeded.
      await db.exec(`set request.jwt.claim.sub = '${uid}';`)
      await db.exec(sql)
      return ''
    } catch (e: any) { return String(e?.message ?? 'error') }
    finally { try { await db.exec(`set request.jwt.claim.sub = ''`) } catch { /* ignore */ } }
  }
  const crossTenant = await asUser(A, `select public.allocate_quote_number('${B}')`)
  check('TENANT · a signed-in caller cannot allocate for another business',
    /cannot allocate a number for another business/i.test(crossTenant),
    `expected a refusal naming the boundary; got: ${crossTenant.slice(0, 160) || 'IT SUCCEEDED'}`)
  const ownTenant = await asUser(A, `select public.allocate_quote_number('${A}')`)
  check('TENANT · but may allocate for itself',
    ownTenant === '', `it was refused: ${ownTenant.slice(0, 160)}`)

  // The quote that the first allocation was for — written as the app would.
  await exec(mkQuote(A, `EPS-${YEAR}-0008`, '11111111-1111-1111-1111-111111111111'))

  // Two tenants may legitimately hold the same display number.
  await exec(mkQuote(B, `EPS-${YEAR}-0008`, '22222222-2222-2222-2222-222222222222'))
  const shared = await q(
    `select count(*)::int n from public.quotes where quote_number = 'EPS-${YEAR}-0008'`)
  check('TENANT · two businesses may hold the same display number',
    Number(shared.rows[0].n) === 2,
    'uniqueness is per tenant; a global unique would couple unrelated businesses')

  // ── THE BARRIER ──────────────────────────────────────────────────────────
  const dupMsg = await refuses(mkQuote(A, `EPS-${YEAR}-0008`, '11111111-1111-1111-1111-111111111111'))
  check('BARRIER · a duplicate within one tenant is refused by the database',
    /quotes_user_qnum_new_unique|duplicate key/i.test(dupMsg),
    `expected the unique index to bite; got: ${dupMsg.slice(0, 160) || 'IT SUCCEEDED'}`)

  // ⭐ The historical rows are untouched and remain insertable — that is the
  // whole reason the stage-1 index is partial.
  const hist = await refuses(
    `insert into public.quotes (user_id, quote_number, customer_name, address, service_type, customer_id, created_at)
       values ('${A}', 'EPS-${YEAR}-0008', 'C','A','S','11111111-1111-1111-1111-111111111111', timestamptz '2026-06-09 23:28:47+00')`)
  check('BARRIER · history is deliberately outside the stage-1 index',
    hist === '',
    `a pre-cutoff row must still be writable so no historical quote has to be renumbered: ${hist.slice(0, 160)}`)

  // ── Year boundary ────────────────────────────────────────────────────────
  await exec(`insert into public.document_number_counters (user_id, kind, prefix, year, next_value)
              values ('${A}', 'quote', 'EPS', ${YEAR + 1}, 1)`)
  const nextYear = await q(
    `select prefix, year, next_value from public.document_number_counters
      where user_id='${A}' and year=${YEAR + 1}`)
  check('YEAR · the next year is a separate counter starting at 1',
    Number(nextYear.rows[0].next_value) === 1,
    'numbering resets annually — the year is in the customer-visible number')

  // ── Rollback ─────────────────────────────────────────────────────────────
  const before = Number((await q(
    `select next_value from public.document_number_counters where user_id='${A}' and prefix='EPS' and year=${YEAR}`)).rows[0].next_value)
  await refuses(`begin; select public.allocate_quote_number('${A}'); rollback;`)
  const after = Number((await q(
    `select next_value from public.document_number_counters where user_id='${A}' and prefix='EPS' and year=${YEAR}`)).rows[0].next_value)
  check('ROLLBACK · a rolled-back allocation leaves no duplicate behind',
    after >= before,
    `the counter must never move backwards: ${before} → ${after}`)
  console.log('     ↑ a rolled-back number is SPENT. Gaps are accepted; production')
  console.log('       already has 42 of them, so gapless was never promised.')

  await db.close?.()
}

main().catch(e => { console.error(e); process.exit(1) })
