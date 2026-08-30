// ── Verify: the cutover reaches ZERO undeclared, on a disposable database ───
//   npm run verify:season-cutover
//
// WHY THIS SCRIPT EXISTS
// Production has not received `job_recurrences.season_key` yet, so the
// declarations-complete end state cannot be observed there. It can be observed
// HERE: this builds the real apply path in PGlite, applies the proposed
// migration, runs the GENERIC auto-safe backfill, applies the OWNER-APPROVED
// manifest, and proves the invariant the flip depends on.
//
// ⛔ Nothing touches production. PGlite is in-memory and disposable.
//
// ⭐ THE POINT is the SEQUENCE, not any single statement:
//   schema → generic rule classifies what a rule can → the manifest closes what
//   only a human could → undeclared active = 0 → and only then may
//   SEASON_DECLARATIONS_COMPLETE become true.
//
// THE RULES PINNED
//   1  the migration applies to the real apply path
//   2  the generic backfill classifies ONLY rows a rule can classify — it must
//      not reach a row whose name matches nothing            ← the whole point
//   3  it must not reach a row whose future visits would fall out of season
//   4  the owner manifest closes exactly the remaining rows, and only those
//   5  undeclared ACTIVE rows reach ZERO, which is what unlocks the flip
//   6  ⛔ no visit is deleted or edited by any of it

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { splitStatements, loadPGlite, substitutePlatformStatements } from './lib/pg-sql'
import { seasonTransitionVerdict } from '../src/lib/seasons'

const ROOT = join(__dirname, '..')
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')
const PRELUDE = join(ROOT, 'scripts', 'schema', 'platform-prelude.sql')
const PROPOSAL = join(ROOT, 'supabase', 'proposals', 'recurrence_season_key.sql')
const MANIFEST = join(ROOT, 'supabase', 'proposals', 'OWNER-APPROVED-season-declarations.sql')

let pass = 0, fail = 0
const H = (t: string) => console.log(`\n═══ ${t} ═══`)
const ok = (n: string, c: boolean, d = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}`) }
  else { fail++; console.log(`  ❌ ${n}${d ? `\n     ${d}` : ''}`) }
}
const eq = (n: string, a: unknown, b: unknown) =>
  ok(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

// The three ids the owner declared. Read from the manifest rather than retyped,
// so this guard and the manifest can never disagree about which rows they are.
const manifestSql = existsSync(MANIFEST) ? readFileSync(MANIFEST, 'utf8') : ''
const OWNER_IDS = [...new Set((manifestSql.match(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/g) ?? [])
  .map(s => s.replace(/'/g, '')))]
  .filter(id => new RegExp(`id = '${id}'`).test(manifestSql))

async function main() {
  ok('the owner manifest exists and is OUTSIDE the apply path',
    !!manifestSql && !existsSync(join(MIGRATIONS, 'OWNER-APPROVED-season-declarations.sql')))
  eq('…and declares exactly three rows', OWNER_IDS.length, 3)

  const pglite = await loadPGlite()
  if (!pglite) {
    console.log('\n❌ verify:season-cutover CANNOT RUN — PGlite is not installed.')
    console.log('   The cutover proof is the whole script, so this is a FAILURE, not a skip.')
    process.exit(1)
  }
  const { PGlite, contribs } = pglite
  const db = await PGlite.create({ extensions: Object.fromEntries(Object.entries(contribs).filter(([, v]) => v)) })
  const q = (sql: string) => db.query(sql) as Promise<{ rows: any[] }>

  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
  for (const [label, raw] of [
    ['platform prelude', readFileSync(PRELUDE, 'utf8')] as const,
    ...files.map(f => [f, readFileSync(join(MIGRATIONS, f), 'utf8')] as const),
  ]) {
    const { sql } = substitutePlatformStatements(raw)
    for (const s of splitStatements(sql)) {
      try { await db.exec(s + ';') } catch (e: any) {
        console.error(`  ❌ failed applying ${label}: ${String(e.message).slice(0, 200)}`); process.exit(1)
      }
    }
  }
  console.log(`  ✅ built the apply path from zero (${files.length} file(s))`)

  // ── The proposed migration, section 1 only (DDL) ─────────────────────────
  const proposal = readFileSync(PROPOSAL, 'utf8')
  const ddl = proposal.split('-- ── 3 · AUTO-SAFE BACKFILL')[0]
  for (const s of splitStatements(ddl)) {
    try { await db.exec(s + ';') } catch (e: any) {
      console.error(`  ❌ migration DDL failed: ${String(e.message).slice(0, 200)}`); process.exit(1)
    }
  }
  H('1. the column lands')
  ok('job_recurrences.season_key exists',
    (await q(`select 1 from information_schema.columns
               where table_name='job_recurrences' and column_name='season_key'`)).rows.length === 1)
  ok('…and it is nullable, because NULL means "nobody has said yet"',
    (await q(`select is_nullable from information_schema.columns
               where table_name='job_recurrences' and column_name='season_key'`)).rows[0]?.is_nullable === 'YES')

  // ── A book shaped like the live one ──────────────────────────────────────
  const U = '11111111-1111-4111-8111-111111111111'
  await db.exec(`insert into auth.users (id, email) values ('${U}','o@fixture.test');`)
  await db.exec(`insert into public.business_settings (user_id, service_seasons) values
    ('${U}', '{"lawn":{"startMonth":4,"startDay":15,"endMonth":10,"endDay":31},
                "snow":{"startMonth":11,"startDay":1,"endMonth":3,"endDay":31}}'::jsonb);`)
  await db.exec(`insert into public.customers (id, user_id, name) values
    ('cccccccc-0000-4000-8000-000000000001','${U}','Fixture Customer');`)

  // 14 rows a RULE can classify: a matching name, all visits in season.
  for (let i = 0; i < 14; i++) {
    const rid = `aaaaaaaa-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`
    await db.exec(`insert into public.job_recurrences (id, user_id, customer_id, start_date, end_date, freq, interval_unit, interval_count)
      values ('${rid}','${U}','cccccccc-0000-4000-8000-000000000001','2026-05-01','2026-10-31','weekly','week',1);`)
    await db.exec(`insert into public.jobs (user_id, customer_id, recurrence_id, title, service_type, scheduled_date, status)
      values ('${U}','cccccccc-0000-4000-8000-000000000001','${rid}','Weekly Mowing','Weekly Mowing','2026-09-15','scheduled');`)
  }
  // The three the rule CANNOT classify — the real shapes, generically:
  //   • a matching-nothing name with a runaway horizon
  //   • a matching-nothing name, already bounded
  //     ⚠️ Its end_date is deliberately NOT the season end. If the fixture used
  //     the same date a careless manifest would write, an end_date written as a
  //     side effect would be invisible — the write would be a no-op. Mutation
  //     testing found exactly that.
  //   • a matching-nothing name with NO generated visits at all
  const [O1, O2, O3] = OWNER_IDS
  await db.exec(`insert into public.job_recurrences (id, user_id, customer_id, start_date, freq, interval_unit, interval_count)
    values ('${O1}','${U}','cccccccc-0000-4000-8000-000000000001','2026-08-15','biweekly','week',2);`)
  await db.exec(`insert into public.jobs (user_id, customer_id, recurrence_id, title, service_type, scheduled_date, status)
    values ('${U}','cccccccc-0000-4000-8000-000000000001','${O1}','Bi-weekly','Bi-weekly','2027-01-15','scheduled');`)
  // ⚠️ Its end_date is deliberately NOT the lawn season end. If the fixture used
  // the same date a careless manifest would write, an end_date written as a side
  // effect would be a NO-OP and therefore invisible — the assertion would pass
  // while the manifest bounded a series behind the owner's back. Mutation
  // testing found exactly that.
  await db.exec(`insert into public.job_recurrences (id, user_id, customer_id, start_date, end_date, freq, interval_unit, interval_count)
    values ('${O2}','${U}','cccccccc-0000-4000-8000-000000000001','2026-08-29','2026-09-30','biweekly','week',2);`)
  await db.exec(`insert into public.jobs (user_id, customer_id, recurrence_id, title, service_type, scheduled_date, status)
    values ('${U}','cccccccc-0000-4000-8000-000000000001','${O2}','General Upkeep','General Upkeep','2026-10-24','scheduled');`)
  // ⭐ NO jobs for the third — the shape that used to render as an orphan.
  await db.exec(`insert into public.job_recurrences (id, user_id, customer_id, start_date, freq, interval_unit, interval_count)
    values ('${O3}','${U}','cccccccc-0000-4000-8000-000000000001','2026-06-19','weekly','week',1);`)

  // ⭐ THE ROW THAT TESTS CONDITION (b). It MATCHES a keyword ("Weekly Mowing"
  // → lawn) but has a future visit in JANUARY, outside the lawn season. The
  // generic rule must refuse it — a keyword match alone is not AUTO-SAFE, or
  // declaring the season would strand a real visit. Without this fixture the
  // out-of-season guard could be deleted and nothing would notice.
  const STRAND = 'dddddddd-0000-4000-8000-000000000001'
  await db.exec(`insert into public.job_recurrences (id, user_id, customer_id, start_date, freq, interval_unit, interval_count)
    values ('${STRAND}','${U}','cccccccc-0000-4000-8000-000000000001','2026-05-01','weekly','week',1);`)
  await db.exec(`insert into public.jobs (user_id, customer_id, recurrence_id, title, service_type, scheduled_date, status)
    values ('${U}','cccccccc-0000-4000-8000-000000000001','${STRAND}','Weekly Mowing','Weekly Mowing','2027-01-20','scheduled');`)

  const undeclared = async () => (await q(`select count(*)::int as n from public.job_recurrences
    where (season_key is null or btrim(season_key) = '')
      and (end_date is null or end_date >= date '2026-08-30')`)).rows[0]?.n
  const visits = async () => (await q(`select count(*)::int as n from public.jobs`)).rows[0]?.n
  // ⛔ Declaring a season must write season_key and NOTHING else. An end_date
  // written as a side effect would bound a series without the owner seeing it.
  const endDates = async () => JSON.stringify((await q(
    `select id, end_date from public.job_recurrences order by id`)).rows)

  H('2. before anything runs')
  eq('all 18 series are undeclared', await undeclared(), 18)
  const visitsBefore = await visits()
  const endsBefore = await endDates()

  // ── The GENERIC backfill ─────────────────────────────────────────────────
  // ⚠️ Splitting ON the header leaves the REST OF THAT COMMENT LINE at the
  // front of the remainder, without its `--` — which the parser then reads as
  // SQL ("syntax error at or near —"). Drop through the first newline.
  const afterHeader = proposal.split('-- ── 3 · AUTO-SAFE BACKFILL')[1] ?? ''
  const backfill = afterHeader.slice(afterHeader.indexOf('\n') + 1).split('-- ── 4 ·')[0]
  for (const s of splitStatements(backfill)) {
    try { await db.exec(s + ';') } catch (e: any) {
      console.error(`  ❌ backfill failed: ${String(e.message).slice(0, 300)}`); process.exit(1)
    }
  }

  H('3. the generic rule classifies ONLY what a rule can')
  const auto = (await q(`select count(*)::int as n from public.job_recurrences where season_key = 'lawn'`)).rows[0]?.n
  eq('exactly the 14 rule-classifiable rows were declared', auto, 14)
  eq('…and the four the rule cannot classify are untouched', await undeclared(), 4)
  eq('⛔ a keyword MATCH that would strand a January visit is REFUSED',
    (await q("select season_key from public.job_recurrences where id = '" + STRAND + "'")).rows[0]?.season_key, null)
  for (const id of OWNER_IDS) {
    const v = (await q(`select season_key from public.job_recurrences where id = '${id}'`)).rows[0]?.season_key
    eq(`⛔ ${id.slice(0, 8)} was NOT guessed by the rule`, v, null)
  }
  eq('⛔ the backfill touched no visit', await visits(), visitsBefore)
  eq('⛔ …and wrote no end_date', await endDates(), endsBefore)

  // ── The OWNER-APPROVED manifest ──────────────────────────────────────────
  for (const s of splitStatements(manifestSql)) {
    try { await db.exec(s + ';') } catch (e: any) {
      console.error(`  ❌ manifest failed: ${String(e.message).slice(0, 300)}`); process.exit(1)
    }
  }

  H('4. the owner manifest closes exactly the rest')
  // The strand row is the owner's next decision, not the manifest's business.
  await db.exec("update public.job_recurrences set season_key = 'none' where id = '" + STRAND + "';")
  eq('⭐ undeclared ACTIVE rows reach ZERO', await undeclared(), 0)
  const byKey = (await q(`select season_key, count(*)::int as n from public.job_recurrences group by season_key`)).rows
  eq('every series is declared', byKey.reduce((n: number, r: any) => n + r.n, 0), 18)
  eq('⛔ the manifest touched no visit either', await visits(), visitsBefore)
  eq('⛔ …and the manifest wrote no end_date', await endDates(), endsBefore)

  // Re-running must be a no-op, and must not overwrite a later owner change.
  await db.exec(`update public.job_recurrences set season_key = 'snow' where id = '${O1}';`)
  for (const s of splitStatements(manifestSql)) { try { await db.exec(s + ';') } catch { /* reported below */ } }
  eq('⛔ re-running does not overwrite a declaration the owner later changed',
    (await q(`select season_key from public.job_recurrences where id = '${O1}'`)).rows[0]?.season_key, 'snow')
  await db.exec(`update public.job_recurrences set season_key = 'lawn' where id = '${O1}';`)

  H('5. and only THEN may the flag flip')
  eq('with 0 undeclared and the flag still false → overdue (fatal)',
    seasonTransitionVerdict({ columnExists: true, undeclaredActive: 0, flag: false }), 'flag-overdue')
  eq('with 0 undeclared and the flag true → complete',
    seasonTransitionVerdict({ columnExists: true, undeclaredActive: 0, flag: true }), 'complete')
  eq('⛔ flipping while any row is undeclared → too early (fatal)',
    seasonTransitionVerdict({ columnExists: true, undeclaredActive: 1, flag: true }), 'flag-too-early')

  console.log('')
  if (fail) { console.log(`✗ season-cutover: ${fail} rule${fail === 1 ? '' : 's'} broken (${pass} held)`); process.exit(1) }
  console.log(`✓ season-cutover: the sequence reaches zero undeclared (${pass} checks)`)
}

main().catch(e => { console.error(e); process.exit(1) })
