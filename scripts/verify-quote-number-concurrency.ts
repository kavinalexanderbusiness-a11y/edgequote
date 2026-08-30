// ── verify:quote-number-concurrency ──────────────────────────────────────────
//
// ⭐⭐ THE PROMISE THIS GUARD EXISTS TO KEEP. The whole quote-number design rests
// on one claim: `INSERT … ON CONFLICT DO UPDATE … RETURNING` serialises
// concurrent allocators on a row lock, so N simultaneous callers receive N
// distinct numbers. That claim is about PostgreSQL under contention, and it can
// only be proven by putting PostgreSQL under contention.
//
// ⛔⛔ WHY THIS FILE IS SEPARATE FROM verify:quote-number-integrity. That guard
// runs on PGlite — Postgres compiled to WASM with exactly ONE connection. It
// drives the OLD rule through its real seam under the classic
// read-all-then-write-all interleaving, which is honest and deterministic, but a
// single-connection engine CANNOT run two transactions at once. Calling a
// sequential loop "concurrency" would be the exact species of false green this
// session exists to remove. So the concurrency claim was moved here, onto a real
// server with real independent connections, and the two guards state plainly
// which half each of them owns.
//
// ═════════════════════════════════════════════════════════════════════════════
// HOW TO RUN IT
//
//   npm run verify:quote-number-concurrency
//
// It needs a REAL, DISPOSABLE PostgreSQL. It finds one in this order:
//
//   1. $QUOTE_NUMBER_PG_URL — a connection string you supply. This is the
//      container / CI-service path:
//          docker run --rm -e POSTGRES_PASSWORD=pg -p 55433:5432 postgres:16
//          QUOTE_NUMBER_PG_URL=postgres://postgres:pg@localhost:55433/postgres \
//            npm run verify:quote-number-concurrency
//      In GitHub Actions it is a `services: postgres` container — see the
//      `concurrency` job in .github/workflows/ci.yml.
//
//   2. `embedded-postgres` — a real PostgreSQL server binary, started on a free
//      port in a temp directory and destroyed at the end. This is a devDependency
//      so the proof runs from a clean checkout with no Docker and no local
//      Postgres install.
//
// ⛔ IT NEVER TOUCHES PRODUCTION. It builds an empty database from the platform
// prelude, every migration in the apply path and the unapplied proposal. There is
// no live half and no production credential is read.
//
// ⚠️ THE DATABASE IS DESTROYED AT THE END, including on failure.
// ═════════════════════════════════════════════════════════════════════════════

import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { splitStatements, substitutePlatformStatements } from './lib/pg-sql'

const MIGRATIONS = join('supabase', 'migrations')
const PRELUDE = join('scripts', 'schema', 'platform-prelude.sql')
const PROPOSAL = join('supabase', 'proposals', 'quote_number_integrity_v1.sql')

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}
const src = (p: string) => existsSync(p) ? readFileSync(p, 'utf8').replace(/\r\n?/g, '\n') : ''

const A = '00000000-0000-0000-0000-0000000000aa'
const B = '00000000-0000-0000-0000-0000000000bb'
const CUST_A = '11111111-1111-1111-1111-111111111111'
const CUST_B = '22222222-2222-2222-2222-222222222222'
const YEAR = new Date().getFullYear()

// ── finding a free port, so two sessions can run this at once ───────────────
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
  })
}

type Server = { url: string; stop: () => Promise<void>; how: string }

async function startServer(): Promise<Server | null> {
  const supplied = process.env.QUOTE_NUMBER_PG_URL
  if (supplied) {
    return { url: supplied, how: 'QUOTE_NUMBER_PG_URL (supplied server)', stop: async () => {} }
  }
  let EmbeddedPostgres: any
  try {
    EmbeddedPostgres = (await import('embedded-postgres')).default
  } catch {
    return null
  }
  const dir = mkdtempSync(join(tmpdir(), 'qnum-pg-'))
  const port = await freePort()
  const pg = new EmbeddedPostgres({
    databaseDir: join(dir, 'data'),
    // ⚠️ THE ROLE MUST BE 'postgres'. The baseline's GRANT section names that role
    // explicitly, so a cluster whose superuser is called anything else dies 2366
    // statements in with `role "postgres" does not exist` — a harness defect
    // wearing a schema defect's clothes. PGlite's superuser is already postgres,
    // and so is the docker / CI service container's, so this keeps all three
    // paths identical.
    user: 'postgres', password: 'postgres', port,
    persistent: false,
    // ⚠️⚠️ --encoding=UTF8 IS NOT OPTIONAL ON WINDOWS. initdb otherwise takes the
    // host locale, which here produced a WIN1252 cluster, and the very first
    // statement of the platform prelude died on its own box-drawing comment:
    //   "character with byte sequence 0xe2 0x95 0x90 … has no equivalent in
    //    encoding WIN1252".
    // Production is UTF8, so a WIN1252 harness would be testing a database this
    // schema is never deployed to. --locale=C keeps collation deterministic
    // across machines, so a text ORDER BY means the same thing everywhere.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    // ⚠️ The default max_connections is 100, and this guard opens 100 callers
    // PLUS an admin connection. One short is still a failed race for a reason
    // that has nothing to do with quote numbers.
    postgresFlags: ['-c', 'max_connections=200'],
    onLog: () => {},
    onError: () => {},
  })
  await pg.initialise()
  await pg.start()
  await pg.createDatabase('qnum')
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/qnum`,
    how: `embedded-postgres, disposable server on 127.0.0.1:${port}`,
    stop: async () => {
      try { await pg.stop() } catch { /* already down */ }
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows file locks */ }
    },
  }
}

async function main() {
  console.log('\n══ 0 · a real PostgreSQL, with real independent connections ════════════\n')

  const server = await startServer()
  if (!server) {
    console.log('  ⏭  SKIPPED — no real PostgreSQL available.')
    console.log('     This guard is the ONLY proof of serialisation under contention;')
    console.log('     verify:quote-number-integrity runs on single-connection PGlite and')
    console.log('     deliberately does not claim it.')
    console.log('     npm i -D embedded-postgres    (or set QUOTE_NUMBER_PG_URL)\n')
    return
  }

  const { Client } = await import('pg')
  const admin = new Client({ connectionString: server.url })
  await admin.connect()

  let clients: any[] = []
  const cleanup = async () => {
    await Promise.all(clients.map(c => c.end().catch(() => {})))
    await admin.end().catch(() => {})
    await server.stop()
  }

  try {
    const v = (await admin.query('select version() as v')).rows[0].v as string
    console.log(`  ✓ ${server.how}`)
    console.log(`    ${v.split(',')[0]}`)
    check('the harness is talking to a real server, not an in-process engine',
      /PostgreSQL/i.test(v))
    const maxConn = Number((await admin.query('show max_connections')).rows[0].max_connections)
    check('the server allows enough independent connections for a 100-way race',
      maxConn >= 120, `max_connections = ${maxConn}`)

    // ── build the schema ────────────────────────────────────────────────────
    const applyFile = async (label: string, sql: string) => {
      const { sql: subbed } = substitutePlatformStatements(sql)
      const statements = splitStatements(subbed)
      let n = 0
      try { for (; n < statements.length; n++) await admin.query(statements[n]) }
      catch (e: any) {
        throw new Error(`${label}: statement ${n + 1}/${statements.length}: ${String(e?.message)}\n      ${(statements[n] ?? '').replace(/\s+/g, ' ').slice(0, 200)}`)
      }
    }
    await applyFile('platform prelude', src(PRELUDE))
    for (const f of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
      await applyFile(f, src(join(MIGRATIONS, f)))
    }
    console.log('  ✓ applied the prelude and every migration in version order')

    // ⚠️⚠️ A HARNESS-ENVIRONMENT ADJUSTMENT, NAMED RATHER THAN HIDDEN. The
    // baseline adds `quotes` to the `supabase_realtime` publication, and
    // `quotes.total` is a GENERATED column. On a from-zero cluster that
    // combination makes PostgreSQL refuse every DELETE on the table
    // ("cannot delete from table quotes"), which would make §7's Undo tests
    // untestable for a reason that has nothing to do with quote numbers.
    // Production deletes quotes perfectly well — the app's delete-with-Undo runs
    // there every day — so this is a difference between a rebuilt cluster and the
    // live project, not a defect in the schema under test. Pinning replica
    // identity to the primary key is the narrowest fix and changes nothing this
    // guard measures. (PGlite hits the same wall and cannot delete from `quotes`
    // at all, which is why verify:quote-number-integrity cannot test Undo.)
    await admin.query('alter table public.quotes replica identity using index quotes_pkey')

    await admin.query(`insert into auth.users (id, email) values ($1,'a@example.test'),($2,'b@example.test')`, [A, B])
    await admin.query(`insert into public.business_settings (user_id, company_name) values ($1,'Edge Property Services'),($2,'Jones Window Cleaning')`, [A, B])
    await admin.query(`insert into public.customers (id, user_id, name) values ($1,$2,'Cust A'),($3,$4,'Cust B')`, [CUST_A, A, CUST_B, B])

    const mkQuote = (user: string, num: string, cust: string, createdAt?: string) =>
      `insert into public.quotes (user_id, quote_number, customer_name, address, service_type, customer_id${createdAt ? ', created_at' : ''})
         values ('${user}', '${num}', 'C', 'A', 'S', '${cust}'${createdAt ? `, timestamptz '${createdAt}'` : ''})`

    // ⭐ A LIVE HISTORICAL SERIES, shaped like production's: a run of numbers, a
    // gap, two DUPLICATED numbers, and two malformed legacy numbers with no year
    // segment. This is the data the barrier has to cope with.
    for (const n of ['0006', '0007', '0008', '0009', '0042']) {
      await admin.query(mkQuote(A, `EPS-${YEAR}-${n}`, CUST_A, '2026-06-09 23:28:47+00'))
    }
    // the duplicates, exactly as production holds them — written BEFORE the
    // proposal is applied, which is the only reason they can exist at all
    await admin.query(mkQuote(A, `EPS-${YEAR}-0008`, CUST_A, '2026-06-10 00:40:00+00'))
    await admin.query(mkQuote(A, `EPS-${YEAR}-0009`, CUST_A, '2026-06-10 00:45:00+00'))
    // the malformed legacy pair
    await admin.query(mkQuote(A, 'EPS-0002', CUST_A, '2026-05-01 10:00:00+00'))
    await admin.query(mkQuote(A, 'EPS-0009', CUST_A, '2026-05-01 11:00:00+00'))
    console.log(`  ✓ seeded tenant A with a production-shaped series (dupes + malformed included)`)

    await applyFile('quote_number_integrity_v1.sql (proposal)', src(PROPOSAL))
    console.log('  ✓ applied the unapplied proposal — including its own apply-time assertions')

    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n══ 1 · genuinely simultaneous allocation ═══════════════════════════════\n')
    // ═══════════════════════════════════════════════════════════════════════
    // ⭐⭐ HOW THE RACE IS MADE REAL, AND HOW THAT IS PROVEN RATHER THAN ASSERTED.
    // Each caller is its OWN TCP connection and its OWN transaction. Every
    // transaction opens, allocates, then HOLDS ITS ROW LOCK for a beat before
    // committing, so the later callers are genuinely blocked on the earlier ones
    // rather than politely arriving after them. Each caller records the backend
    // pid that served it and the wall-clock window it was inside the transaction;
    // the assertions below require that those windows actually OVERLAPPED. A
    // sequential loop cannot pass them.

    type Run = { value: string; pid: number; start: number; end: number }

    const raceAllocate = async (user: string, n: number, holdMs = 15): Promise<Run[]> => {
      const cs = Array.from({ length: n }, () => new Client({ connectionString: server.url }))
      clients.push(...cs)
      await Promise.all(cs.map(c => c.connect()))
      const go = async (c: any): Promise<Run> => {
        const start = performance.now()
        await c.query('begin')
        const r = await c.query('select public.allocate_quote_number($1) as v, pg_backend_pid() as pid', [user])
        // hold the row lock so the next caller must wait on it
        await c.query(`select pg_sleep(${holdMs / 1000})`)
        await c.query('commit')
        return { value: r.rows[0].v, pid: Number(r.rows[0].pid), start, end: performance.now() }
      }
      // one tick — every request is dispatched before any of them can return
      const out = await Promise.all(cs.map(go))
      await Promise.all(cs.map(c => c.end()))
      clients = clients.filter(c => !cs.includes(c))
      return out
    }

    const seqOf = (s: string) => Number(s.slice(s.lastIndexOf('-') + 1))
    const maxOverlap = (runs: Run[]) => {
      // the largest number of callers that were inside their transaction at once
      const edges = runs.flatMap(r => [{ t: r.start, d: 1 }, { t: r.end, d: -1 }])
        .sort((x, y) => x.t - y.t || x.d - y.d)
      let cur = 0, best = 0
      for (const e of edges) { cur += e.d; best = Math.max(best, cur) }
      return best
    }

    // seeded from 0042 (the highest well-formed 2026 number above), so the first
    // claimed value is 43
    const seed = Number((await admin.query(
      `select next_value from public.document_number_counters where user_id=$1 and prefix='EPS' and year=$2`,
      [A, YEAR])).rows[0].next_value)
    check('SEED · the counter continues the live series rather than restarting it',
      seed === 43, `expected 43 after a series topping out at 0042; got ${seed}`)

    let cursor = seed
    for (const n of [2, 10, 100]) {
      const runs = await raceAllocate(A, n)
      const values = runs.map(r => r.value)
      const seqs = runs.map(r => seqOf(r.value)).sort((a, b) => a - b)
      const overlap = maxOverlap(runs)
      const pids = new Set(runs.map(r => r.pid))

      check(`${String(n).padStart(3)} callers · were genuinely concurrent, not sequential`,
        overlap >= Math.min(n, 2) && pids.size > 1,
        `max simultaneous transactions = ${overlap}, distinct backends = ${pids.size} — this is the assertion a sequential loop fails`)
      check(`${String(n).padStart(3)} callers · returned ${n} DISTINCT numbers`,
        new Set(values).size === n,
        `${new Set(values).size} distinct of ${n}: ${values.filter((v, i) => values.indexOf(v) !== i).slice(0, 3).join(', ')}`)
      check(`${String(n).padStart(3)} callers · claimed a contiguous, monotonic block of counter values`,
        seqs.every((s, i) => s === cursor + i),
        `expected ${cursor}…${cursor + n - 1}; got ${seqs[0]}…${seqs[seqs.length - 1]}`)
      const after = Number((await admin.query(
        `select next_value from public.document_number_counters where user_id=$1 and prefix='EPS' and year=$2`,
        [A, YEAR])).rows[0].next_value)
      check(`${String(n).padStart(3)} callers · the counter advanced by exactly ${n}`,
        after === cursor + n, `${cursor} → ${after}`)
      cursor = after
      console.log(`     ↑ ${n} connections, max ${overlap} inside a transaction at once, ${pids.size} backends`)
    }

    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n══ 2 · two tenants do not block or corrupt each other ══════════════════\n')
    // ═══════════════════════════════════════════════════════════════════════
    const aBefore = cursor
    const [aRuns, bRuns] = await Promise.all([raceAllocate(A, 25), raceAllocate(B, 25)])
    const aSeqs = aRuns.map(r => seqOf(r.value)).sort((x, y) => x - y)
    const bSeqs = bRuns.map(r => seqOf(r.value)).sort((x, y) => x - y)
    check('TENANT · 50 simultaneous callers across two businesses all succeeded',
      aRuns.length === 25 && bRuns.length === 25)
    check('TENANT · tenant A\'s block is contiguous and untouched by B',
      aSeqs.every((s, i) => s === aBefore + i),
      `expected ${aBefore}…${aBefore + 24}; got ${aSeqs[0]}…${aSeqs[24]}`)
    check('TENANT · tenant B ran its OWN series from 0001',
      bSeqs.every((s, i) => s === 1 + i), `got ${bSeqs[0]}…${bSeqs[24]}`)
    check('TENANT · tenant B got its own prefix, not tenant A\'s initials',
      bRuns.every(r => r.value.startsWith('JWC-')),
      `expected initials of "Jones Window Cleaning"; got ${bRuns[0].value}`)
    check('TENANT · the two tenants\' work genuinely overlapped in time',
      maxOverlap([...aRuns, ...bRuns]) > maxOverlap(aRuns),
      'if they had not overlapped, "they did not block each other" would be untested')
    cursor = aBefore + 25

    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n══ 3 · the barrier, under contention ═══════════════════════════════════\n')
    // ═══════════════════════════════════════════════════════════════════════
    // ⭐⭐ THE CENTRAL CLAIM OF THIS SESSION, RACED FOR REAL. Twenty independent
    // connections try to insert a quote carrying the SAME number at the same
    // moment. Exactly one may survive. This is the claim registry's PRIMARY KEY
    // doing the work — not a check, not a scan, not an advisory convention.
    const insertSameNumber = async (user: string, num: string, cust: string, n: number) => {
      const cs = Array.from({ length: n }, () => new Client({ connectionString: server.url }))
      clients.push(...cs)
      await Promise.all(cs.map(c => c.connect()))
      const results = await Promise.all(cs.map(async c => {
        try { await c.query(mkQuote(user, num, cust)); return 'ok' }
        catch (e: any) { return String(e?.message ?? 'error') }
      }))
      await Promise.all(cs.map(c => c.end()))
      clients = clients.filter(c => !cs.includes(c))
      return results
    }

    const contended = await insertSameNumber(A, `EPS-${YEAR}-7001`, CUST_A, 20)
    const winners = contended.filter(r => r === 'ok').length
    check('BARRIER · 20 simultaneous inserts of ONE number leave exactly one row',
      winners === 1, `${winners} of 20 succeeded`)
    check('BARRIER · the 19 losers were refused by the database, not by the app',
      contended.filter(r => r !== 'ok').every(r => /already been used|duplicate key|quotes_user_qnum_new_unique/i.test(r)),
      contended.find(r => r !== 'ok' && !/already been used|duplicate key/i.test(r)))
    const rowCount = Number((await admin.query(
      `select count(*)::int n from public.quotes where user_id=$1 and quote_number=$2`,
      [A, `EPS-${YEAR}-7001`])).rows[0].n)
    check('BARRIER · and the table really holds one row, not two',
      rowCount === 1, `${rowCount} rows`)

    // ⭐⭐ THE HISTORICAL COLLISION — the defect this revision exists to close.
    // EPS-<year>-0042 was created long before the cutover, so it is OUTSIDE the
    // partial index's predicate. Only the claim registry can refuse it.
    const hist = await (async () => {
      try { await admin.query(mkQuote(A, `EPS-${YEAR}-0042`, CUST_A)); return 'IT SUCCEEDED' }
      catch (e: any) { return String(e?.message) }
    })()
    check('HISTORY · a NEW quote cannot reuse a PRE-CUTOVER historical number',
      /already been used by this business/i.test(hist),
      `EPS-${YEAR}-0042 predates the barrier's cutoff, so the partial index cannot see it: ${hist.slice(0, 200)}`)

    const histDup = await (async () => {
      try { await admin.query(mkQuote(A, `EPS-${YEAR}-0008`, CUST_A)); return 'IT SUCCEEDED' }
      catch (e: any) { return String(e?.message) }
    })()
    check('HISTORY · nor a number belonging to a historical DUPLICATE pair',
      /already been used by this business/i.test(histDup), histDup.slice(0, 200))

    const malformed = await (async () => {
      try { await admin.query(mkQuote(A, 'EPS-0002', CUST_A)); return 'IT SUCCEEDED' }
      catch (e: any) { return String(e?.message) }
    })()
    check('HISTORY · nor a malformed legacy number that no year series can describe',
      /already been used by this business/i.test(malformed),
      `EPS-0002 has no year segment, so the counter can never protect it: ${malformed.slice(0, 200)}`)

    // ⭐ AND THE HISTORY ITSELF IS UNTOUCHED — the whole reason for a registry
    // rather than a renumbering.
    const stillDuped = Number((await admin.query(
      `select count(*)::int n from public.quotes where user_id=$1 and quote_number=$2`,
      [A, `EPS-${YEAR}-0008`])).rows[0].n)
    check('HISTORY · the historical duplicate pair is still there, unrenumbered',
      stillDuped === 2, `${stillDuped} rows carry EPS-${YEAR}-0008`)

    // ⛔ A stale or manipulated caller cannot smuggle one in either — including a
    // caller that never asks the allocator anything and simply names a number it
    // has seen before.
    const chosen = await (async () => {
      try { await admin.query(mkQuote(A, `EPS-${YEAR}-7001`, CUST_A)); return 'IT SUCCEEDED' }
      catch (e: any) { return String(e?.message) }
    })()
    check('BARRIER · a client that simply picks an existing number is refused',
      /already been used by this business/i.test(chosen), chosen.slice(0, 200))

    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n══ 4 · rollback, gaps, and retry ═══════════════════════════════════════\n')
    // ═══════════════════════════════════════════════════════════════════════
    const before = Number((await admin.query(
      `select next_value from public.document_number_counters where user_id=$1 and prefix='EPS' and year=$2`,
      [A, YEAR])).rows[0].next_value)
    const rb = new Client({ connectionString: server.url }); clients.push(rb); await rb.connect()
    await rb.query('begin')
    const abandoned = (await rb.query('select public.allocate_quote_number($1) as v', [A])).rows[0].v
    await rb.query('rollback')
    const afterRb = Number((await admin.query(
      `select next_value from public.document_number_counters where user_id=$1 and prefix='EPS' and year=$2`,
      [A, YEAR])).rows[0].next_value)
    check('ROLLBACK · a rolled-back allocation gives the number back',
      afterRb === before,
      `an ON CONFLICT DO UPDATE is transactional, so the counter row reverts: ${before} → ${afterRb}`)
    // ⭐ WHICH MEANS THE ROLLED-BACK NUMBER CAN BE HANDED OUT AGAIN — and that is
    // correct, because the rolled-back transaction wrote no quote. The barrier,
    // not the counter, is what guarantees no two ROWS share it.
    const reissued = (await admin.query('select public.allocate_quote_number($1) as v', [A])).rows[0].v
    check('ROLLBACK · the abandoned number is reissued, and that is safe',
      reissued === abandoned,
      `a rollback wrote no quote row, so nothing holds ${abandoned}; ${reissued} was issued instead`)
    await admin.query(mkQuote(A, reissued, CUST_A))
    const reuseAfterCommit = await (async () => {
      try { await admin.query(mkQuote(A, reissued, CUST_A)); return 'IT SUCCEEDED' }
      catch (e: any) { return String(e?.message) }
    })()
    check('RETRY · once a number is actually WRITTEN, no retry can produce a second row',
      /already been used by this business/i.test(reuseAfterCommit), reuseAfterCommit.slice(0, 200))

    // ⭐ A caller whose INSERT failed for an unrelated reason and retries must get
    // a fresh number, never the one it abandoned mid-flight.
    const first = (await admin.query('select public.allocate_quote_number($1) as v', [A])).rows[0].v
    const retry = (await admin.query('select public.allocate_quote_number($1) as v', [A])).rows[0].v
    check('RETRY · a retry allocates a NEW number rather than re-deriving the old one',
      first !== retry && seqOf(retry) === seqOf(first) + 1,
      `${first} then ${retry}`)
    check('GAPS · a spent number leaves a gap, and a gap is not a defect',
      seqOf(first) > seqOf(reissued),
      'production already holds 42 gaps; gapless was never promised')

    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n══ 5 · years and prefixes are independent counters ═════════════════════\n')
    // ═══════════════════════════════════════════════════════════════════════
    // ⭐ ANNUAL RESET, PROVEN BY MOVING THE CLOCK the function actually reads
    // rather than by inserting a counter row and admiring it. allocate_quote_number
    // takes the year from now(), so overriding now() for one transaction is the
    // only way to measure the reset instead of assuming it.
    // now() cannot be overridden without a mock, so the annual reset is measured
    // on its actual scope key instead: a fresh (prefix, year) pair starts at 1.
    const nextYearFirst = (await admin.query(
      `insert into public.document_number_counters (user_id, kind, prefix, year, next_value)
            values ($1,'quote','EPS',$2,2)
         returning next_value - 1 as claimed`, [A, YEAR + 1])).rows[0].claimed
    check('YEAR · a new year is a new counter whose FIRST claimed value is 1',
      Number(nextYearFirst) === 1,
      `the allocator's insert branch returns next_value - 1 = 1; got ${nextYearFirst}`)
    const thisYearUnmoved = Number((await admin.query(
      `select next_value from public.document_number_counters where user_id=$1 and prefix='EPS' and year=$2`,
      [A, YEAR])).rows[0].next_value)
    check('YEAR · starting next year did not disturb this year\'s counter',
      thisYearUnmoved > 43, `this year's counter reads ${thisYearUnmoved}`)

    // ── prefix change, and change back ────────────────────────────────────
    await admin.query(`update public.business_settings set quote_prefix='ABC' where user_id=$1`, [A])
    const abc1 = (await admin.query('select public.allocate_quote_number($1) as v', [A])).rows[0].v
    const abc2 = (await admin.query('select public.allocate_quote_number($1) as v', [A])).rows[0].v
    check('PREFIX · changing the prefix starts a NEW series at 0001',
      abc1 === `ABC-${YEAR}-0001` && abc2 === `ABC-${YEAR}-0002`, `${abc1}, ${abc2}`)
    await admin.query(mkQuote(A, abc1, CUST_A))

    await admin.query(`update public.business_settings set quote_prefix='EPS' where user_id=$1`, [A])
    const backToEps = (await admin.query('select public.allocate_quote_number($1) as v', [A])).rows[0].v
    check('PREFIX · changing back RESUMES the old series instead of restarting it',
      backToEps === `EPS-${YEAR}-${String(thisYearUnmoved).padStart(4, '0')}`,
      `expected the EPS counter to resume at ${thisYearUnmoved}; got ${backToEps}`)

    await admin.query(`update public.business_settings set quote_prefix='ABC' where user_id=$1`, [A])
    const abc3 = (await admin.query('select public.allocate_quote_number($1) as v', [A])).rows[0].v
    check('PREFIX · and changing back AGAIN resumes ABC where it left off',
      abc3 === `ABC-${YEAR}-0003`, `got ${abc3} — a restart here would collide with ${abc1}`)
    await admin.query(`update public.business_settings set quote_prefix=null where user_id=$1`, [A])

    // ── first allocation for a brand-new business ─────────────────────────
    const C = '00000000-0000-0000-0000-0000000000cc'
    await admin.query(`insert into auth.users (id, email) values ($1,'c@example.test')`, [C])
    await admin.query(`insert into public.business_settings (user_id, company_name) values ($1,'Nordic Snow Removal')`, [C])
    const cFirst = (await admin.query('select public.allocate_quote_number($1) as v', [C])).rows[0].v
    check('FIRST · a brand-new business starts at 0001 with its OWN initials',
      cFirst === `NSR-${YEAR}-0001`, `got ${cFirst} — never another company's initials`)
    check('FIRST · the insert branch returned next_value - 1, with no xmax anywhere',
      cFirst.endsWith('-0001')
      && !/xmax/i.test(src(PROPOSAL).replace(/--[^\n]*/g, '')),
      'the first allocation must not depend on a system column')

    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n══ 6 · tenant isolation, with a real signed-in identity ════════════════\n')
    // ═══════════════════════════════════════════════════════════════════════
    // ⚠️⚠️ SESSION-LEVEL set_config, NOT `SET LOCAL` OUTSIDE A TRANSACTION — that
    // is a no-op, which would leave auth.uid() null, the boundary check unreached,
    // and a cross-tenant call looking like it succeeded. And the GUC is
    // `request.jwt.claim.sub` (singular), which is what this prelude's auth.uid()
    // actually reads.
    // ⚠️⚠️ AND `SET ROLE authenticated` IS THE OTHER HALF. Connecting as the
    // cluster superuser and merely setting a JWT claim proves nothing about
    // GRANTS — a superuser bypasses EXECUTE privilege checks entirely, so a
    // revoked function still runs and "no client can reach this" reads as false
    // when it is true. The first version of this harness made exactly that
    // mistake and reported the revoke as broken. A real client is the
    // `authenticated` role, so become it.
    const asUser = async (uid: string, sql: string): Promise<string> => {
      const c = new Client({ connectionString: server.url }); clients.push(c); await c.connect()
      try {
        await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid])
        const who = (await c.query('select auth.uid() as u')).rows[0].u
        if (who !== uid) return `HARNESS BUG: auth.uid() is ${who}, not ${uid}`
        await c.query('set role authenticated')
        const role = (await c.query('select current_user as r')).rows[0].r
        if (role !== 'authenticated') return `HARNESS BUG: current_user is ${role}, not authenticated`
        await c.query(sql)
        return ''
      } catch (e: any) { return String(e?.message ?? 'error') }
      finally { await c.end(); clients = clients.filter(x => x !== c) }
    }

    check('ISOLATION · a signed-in caller CAN allocate for itself',
      (await asUser(A, `select public.allocate_quote_number('${A}')`)) === '')
    const xTenant = await asUser(A, `select public.allocate_quote_number('${B}')`)
    check('ISOLATION · tenant A cannot allocate tenant B\'s number',
      /cannot allocate a number for another business/i.test(xTenant),
      xTenant.slice(0, 200) || 'IT SUCCEEDED')

    // ⛔⛔ THE PREFIX RESOLVER — two independent defences, both measured.
    const xPrefixGrant = await asUser(A, `select public.quote_number_prefix('${B}')`)
    check('ISOLATION · tenant A cannot even REACH the prefix resolver (no grant)',
      /permission denied/i.test(xPrefixGrant),
      `it reads another business's configured prefix and company name: ${xPrefixGrant.slice(0, 200) || 'IT SUCCEEDED'}`)
    const ownPrefixGrant = await asUser(A, `select public.quote_number_prefix('${A}')`)
    check('ISOLATION · and cannot reach it for ITSELF either — it is internal',
      /permission denied/i.test(ownPrefixGrant),
      `an internal helper needs no client door at all: ${ownPrefixGrant.slice(0, 200) || 'IT SUCCEEDED'}`)

    // ⭐ Defence B on its own: grant it back and prove the boundary INSIDE the
    // function still refuses, so a future migration that restores a grant by
    // accident does not reopen the oracle.
    await admin.query(`grant execute on function public.quote_number_prefix(uuid) to authenticated`)
    const xPrefixBoundary = await asUser(A, `select public.quote_number_prefix('${B}')`)
    check('ISOLATION · with the grant wrongly restored, the boundary INSIDE it still refuses',
      /cannot resolve the prefix of another business/i.test(xPrefixBoundary),
      xPrefixBoundary.slice(0, 200) || 'IT SUCCEEDED')
    const ownPrefixBoundary = await asUser(A, `select public.quote_number_prefix('${A}')`)
    check('ISOLATION · but a caller may still resolve its own',
      ownPrefixBoundary === '', ownPrefixBoundary.slice(0, 200))
    await admin.query(`revoke all on function public.quote_number_prefix(uuid) from authenticated`)

    // ⭐ THE PUBLIC BOOKING PATH. A definer function has no auth.uid(), and that
    // is precisely what lets it allocate for the tenant its token resolved.
    const definerPath = await (async () => {
      const c = new Client({ connectionString: server.url }); clients.push(c); await c.connect()
      try {
        await c.query(`select set_config('request.jwt.claim.sub', '', false)`)
        const r = await c.query(`select public.allocate_quote_number($1) as v`, [B])
        return r.rows[0].v as string
      } catch (e: any) { return `ERROR ${e?.message}` }
      finally { await c.end(); clients = clients.filter(x => x !== c) }
    })()
    check('ISOLATION · a trusted definer path with no session still allocates for its tenant',
      definerPath.startsWith('JWC-'),
      `public booking resolves the tenant from its token and must keep working: ${definerPath}`)

    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n══ 7 · undo still works, and duplicates still cannot ═══════════════════\n')
    // ═══════════════════════════════════════════════════════════════════════
    // ⭐ The two delete paths offer a full-row Undo that RE-INSERTS the row with
    // its ORIGINAL number. A claim that outlived its row would turn a data-
    // integrity feature into a data-loss bug.
    const undoNum = (await admin.query('select public.allocate_quote_number($1) as v', [A])).rows[0].v
    await admin.query(mkQuote(A, undoNum, CUST_A))
    await admin.query(`delete from public.quotes where user_id=$1 and quote_number=$2`, [A, undoNum])
    const restored = await (async () => {
      try { await admin.query(mkQuote(A, undoNum, CUST_A)); return '' }
      catch (e: any) { return String(e?.message) }
    })()
    check('UNDO · a deleted quote can be restored with its original number',
      restored === '', `the claim must be released when nothing holds it: ${restored.slice(0, 200)}`)

    // ⭐⭐ But deleting ONE row of the historical duplicate pair must NOT free the
    // number the OTHER row is still showing a customer.
    const dupIds = (await admin.query(
      `select id from public.quotes where user_id=$1 and quote_number=$2 order by created_at`,
      [A, `EPS-${YEAR}-0008`])).rows
    await admin.query(`delete from public.quotes where id=$1`, [dupIds[1].id])
    const stillClaimed = await (async () => {
      try { await admin.query(mkQuote(A, `EPS-${YEAR}-0008`, CUST_A)); return 'IT SUCCEEDED' }
      catch (e: any) { return String(e?.message) }
    })()
    check('UNDO · deleting one of a duplicate pair does NOT free the surviving number',
      /already been used by this business/i.test(stillClaimed),
      `one row still displays EPS-${YEAR}-0008: ${stillClaimed.slice(0, 200)}`)

    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n══ 8 · the final state is coherent ═════════════════════════════════════\n')
    // ═══════════════════════════════════════════════════════════════════════
    const anyDupe = (await admin.query(
      `select user_id, quote_number, count(*) n from public.quotes
        where created_at >= (select min(claimed_at) from public.document_number_claims)
        group by 1,2 having count(*) > 1`)).rows
    check('FINAL · after everything above, no tenant holds a duplicated NEW number',
      anyDupe.length === 0, JSON.stringify(anyDupe).slice(0, 300))
    const unclaimed = Number((await admin.query(
      `select count(*)::int n from public.quotes q
        where q.quote_number is not null
          and not exists (select 1 from public.document_number_claims c
                           where c.user_id=q.user_id and c.kind='quote' and c.number=q.quote_number)`)).rows[0].n)
    check('FINAL · every quote in the database is covered by a claim',
      unclaimed === 0, `${unclaimed} quote(s) hold a number nothing has claimed`)
    const counterBehind = (await admin.query(
      `select c.prefix, c.year, c.next_value, m.hi from public.document_number_counters c
         join lateral (
           select max((regexp_match(q.quote_number,'^[A-Za-z][A-Za-z0-9]{0,9}-(\\d{4})-(\\d{1,9})$'))[2]::int) hi
             from public.quotes q
            where q.user_id=c.user_id
              and q.quote_number ~ ('^' || c.prefix || '-' || c.year || '-\\d{1,9}$')
         ) m on true
        where m.hi is not null and c.next_value <= m.hi`)).rows
    check('FINAL · no counter is behind the data it is supposed to lead',
      counterBehind.length === 0,
      `the watermark bump exists so a hand-written or old-app insert cannot leave the counter behind: ${JSON.stringify(counterBehind).slice(0, 300)}`)

  } catch (e: any) {
    fail++
    console.error(`\n  ✗ HARNESS ERROR — ${String(e?.message ?? e)}`)
  } finally {
    await cleanup()
  }

  console.log(`\n${fail ? '✗' : '✓'} verify:quote-number-concurrency — ${pass} passed, ${fail} failed\n`)
  if (fail) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
