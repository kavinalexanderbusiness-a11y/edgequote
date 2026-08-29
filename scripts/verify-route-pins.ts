// ── Verify: the DURABLE pin model — npm run verify:route-pins ───────────────
//
// Session 110. `verify:pinned-route` pins the ENGINE (a pin is held, released,
// never a promise). This one pins the SCHEMA that would make a pin outlive the
// screen — supabase/proposals/route_pins_v1.sql, which is NOT in the apply path
// and which Session 106 owns the decision to land.
//
// ⭐ IT DOES NOT ASSERT ABOUT TEXT. It builds the real apply path in PGlite,
// applies the proposal on top, and then runs the attacks and the lifecycles.
// A regex can be satisfied by a comment; a refused INSERT cannot. This is the
// same method verify:tenant-weld uses, and for the same reason — the proposal's
// whole risk is tenancy, and tenancy is not a thing you can prove by reading.
//
// ⚠️ REVIEW AGAINST A GIT REF. This branch is based on a pre-convergence
// baseline, so `--from-git=origin/main` builds the apply path out of git rather
// than the working tree. That is what makes "reviewed against CURRENT main" a
// measurement instead of a claim.
//
//   npm run verify:route-pins
//   npx tsx scripts/verify-route-pins.ts --from-git=origin/main
//
// THE RULES PINNED
//   1  route_order and a pin are DIFFERENT FACTS, in different tables, with
//      different lifetimes — and neither writes the other        ← the point
//   2  both routable kinds are pinnable, and an estimate stays an estimate:
//      a pin grants a POSITION and nothing else
//   3  ⛔ CROSS-TENANT: a pin can only ever point at a stop its own tenant
//      owns — enforced by composite welds, not by the code that writes it
//   4  RLS separates two sessions; anon and PUBLIC hold nothing
//   5  deleting a stop takes its pin; deleting the tenant takes them all
//   6  a stop that MOVES DAY loses its pin, in the database, so a second
//      device sees the same cleanup
//   7  a pin's day IS the stop's day, and only a routable kind can be pinned
//   8  one pin per stop; many pins per day; unpin removes exactly one
//   9  a position is a real position (>= 1)
//  10  persistence is per TENANT, not per browser — a second session sees it

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { splitStatements, loadPGlite, substitutePlatformStatements } from './lib/pg-sql'

const ROOT = join(__dirname, '..')
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')
const PROPOSAL = join(ROOT, 'supabase', 'proposals', 'route_pins_v1.sql')
const PRELUDE = join(ROOT, 'scripts', 'schema', 'platform-prelude.sql')

const fromGit = (process.argv.find(a => a.startsWith('--from-git=')) || '').split('=')[1] || ''

let pass = 0, fail = 0
const H = (t: string) => console.log(`\n═══ ${t} ═══`)
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`) }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)

// ── The apply path, from the working tree or from a git ref ─────────────────
function applyPath(): { label: string; files: { name: string; sql: string }[] } {
  if (!fromGit) {
    const names = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    return { label: 'working tree', files: names.map(n => ({ name: n, sql: readFileSync(join(MIGRATIONS, n), 'utf8') })) }
  }
  const listing = execSync(`git ls-tree --name-only ${fromGit} supabase/migrations/`, { cwd: ROOT, encoding: 'utf8' })
  const names = listing.split('\n').map(s => s.trim()).filter(s => s.endsWith('.sql')).sort()
  return {
    label: fromGit,
    files: names.map(n => ({
      name: n.replace('supabase/migrations/', ''),
      sql: execSync(`git show ${fromGit}:${n}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
    })),
  }
}

async function main() {
  ok('the proposal exists and is OUTSIDE the apply path',
    existsSync(PROPOSAL) && !existsSync(join(MIGRATIONS, 'route_pins_v1.sql')),
    'the proposal is missing, or has been moved into supabase/migrations/')

  const pglite = await loadPGlite()
  if (!pglite) {
    // ⚠️ A security guard must NEVER report green because its own dependency is
    // absent. "The attacks were not attempted" is not "the attacks failed".
    console.log('\n❌ verify:route-pins CANNOT RUN — PGlite is not installed.')
    console.log('   The behavioural half is the half that matters, so this is a FAILURE.')
    console.log('   npm i -D @electric-sql/pglite\n')
    process.exit(1)
  }

  const { PGlite, contribs } = pglite
  const db = await PGlite.create({ extensions: Object.fromEntries(Object.entries(contribs).filter(([, v]) => v)) })
  const q = (sql: string, params?: any[]) => db.query(sql, params) as Promise<{ rows: any[] }>

  const path = applyPath()
  for (const [label, raw] of [
    ['platform prelude', readFileSync(PRELUDE, 'utf8')] as const,
    ...path.files.map(f => [f.name, f.sql] as const),
    ['PROPOSAL route_pins_v1.sql', readFileSync(PROPOSAL, 'utf8')] as const,
  ]) {
    const { sql } = substitutePlatformStatements(raw)
    for (const s of splitStatements(sql)) {
      try { await db.exec(s + ';') } catch (e: any) {
        console.error(`\n  ❌ failed applying ${label}: ${String(e.message).slice(0, 300)}`)
        console.error(`     statement: ${s.slice(0, 200)}`)
        process.exit(1)
      }
    }
  }
  console.log(`  ✅ built the apply path (${path.label}: ${path.files.length} file(s)) + the proposal, from zero`)

  // ── Two tenants, two days, both routable kinds ────────────────────────────
  const A = '11111111-1111-4111-8111-111111111111'
  const B = '22222222-2222-4222-8222-222222222222'
  const JA = 'aaaa0000-0000-4000-8000-00000000000a'   // tenant A visit, day 1
  const JA2 = 'aaaa0000-0000-4000-8000-00000000000b'  // tenant A visit, day 1
  const EA = 'aaaa0000-0000-4000-8000-00000000000e'   // tenant A estimate, day 1
  const RA = 'aaaa0000-0000-4000-8000-00000000000r'.replace('r', 'c') // tenant A reminder
  const JB = 'bbbb0000-0000-4000-8000-00000000000a'   // tenant B visit
  const EB = 'bbbb0000-0000-4000-8000-00000000000e'   // tenant B estimate
  const D1 = '2026-09-10', D2 = '2026-09-11'

  await db.exec(`insert into auth.users (id, email) values ('${A}','a@fixture.test'),('${B}','b@fixture.test');`)
  await db.exec(`
    insert into public.jobs (id, user_id, title, scheduled_date) values
      ('${JA}','${A}','A visit one','${D1}'),
      ('${JA2}','${A}','A visit two','${D1}'),
      ('${JB}','${B}','B visit','${D1}');
    insert into public.schedule_items (id, user_id, type, title, scheduled_date) values
      ('${EA}','${A}','estimate','A estimate','${D1}'),
      ('${RA}','${A}','reminder','A reminder','${D1}'),
      ('${EB}','${B}','estimate','B estimate','${D1}');
  `)

  const refused = async (label: string, sql: string, want = /violates|foreign key|route_pins:|duplicate|check constraint/i) => {
    try { await db.exec(sql); ok(label, false, 'the database ACCEPTED it') }
    catch (e: any) {
      const msg = String(e.message)
      ok(label, want.test(msg), `rejected, but not by the expected rule: ${msg.slice(0, 180)}`)
    }
  }
  const accepted = async (label: string, sql: string) => {
    try { await db.exec(sql); ok(label, true) }
    catch (e: any) { ok(label, false, `a legitimate operation was REFUSED: ${String(e.message).slice(0, 220)}`) }
  }
  const pinCount = async (where = '') =>
    (await q(`select count(*)::int as n from public.route_pins ${where}`)).rows[0]?.n ?? -1

  // ═════════════════════════════════════════════════════════════════════════
  H('1. route_order and a pin are DIFFERENT FACTS')

  {
    const cols = (await q(`select column_name from information_schema.columns
                            where table_schema='public' and table_name='route_pins'`)).rows.map(r => r.column_name).sort()
    eq('route_pins carries only what a position constraint needs',
      cols, ['created_at', 'date', 'id', 'job_id', 'position', 'schedule_item_id', 'updated_at', 'user_id'])
    ok('⛔ route_pins has no route_order column of its own', !cols.includes('route_order'))
    ok('⛔ and no money, status or completion column',
      !cols.some((c: string) => /price|amount|total|status|completed|invoice/.test(c)), cols.join(','))
  }

  {
    const si = (await q(`select column_name from information_schema.columns
                          where table_schema='public' and table_name='schedule_items' and column_name='route_order'`)).rows
    eq('⛔ the proposal does NOT give schedule_items a route_order', si.length, 0)
    const j = (await q(`select column_name from information_schema.columns
                         where table_schema='public' and table_name='jobs' and column_name='route_order'`)).rows
    eq('…and jobs.route_order is untouched', j.length, 1)
  }

  {
    // The two facts do not write each other.
    await db.exec(`update public.jobs set route_order = 3 where id = '${JA}';`)
    await db.exec(`insert into public.route_pins (user_id, date, "position", job_id)
                   values ('${A}','${D1}',1,'${JA}');`)
    const ro = (await q(`select route_order from public.jobs where id='${JA}'`)).rows[0]?.route_order
    eq('pinning a stop does not change its route_order', ro, 3)

    await db.exec(`update public.jobs set route_order = null where id = '${JA}';`)
    eq('…and clearing route_order does not delete the pin', await pinCount(`where job_id='${JA}'`), 1)

    await db.exec(`update public.jobs set route_order = 7 where id='${JA}';`)
    const stillOne = await pinCount(`where job_id='${JA}' and "position"=1`)
    eq('…and re-sequencing does not move the pin', stillOne, 1)
    await db.exec(`delete from public.route_pins;`)
  }

  ok('the day-move rule for route_order is still the one that was there',
    (await q(`select tgname from pg_trigger where tgname='trg_jobs_clear_route_order'`)).rows.length === 1,
    'trg_jobs_clear_route_order is missing — the proposal must not replace it')

  // ═════════════════════════════════════════════════════════════════════════
  H('2. both routable kinds — and an estimate stays an estimate')

  await accepted('a VISIT can be pinned',
    `insert into public.route_pins (user_id, date, "position", job_id) values ('${A}','${D1}',1,'${JA}');`)
  await accepted('an ESTIMATE APPOINTMENT can be pinned',
    `insert into public.route_pins (user_id, date, "position", schedule_item_id) values ('${A}','${D1}',2,'${EA}');`)

  {
    const jobs = (await q(`select count(*)::int as n from public.jobs where user_id='${A}'`)).rows[0]?.n
    eq('⛔ pinning an estimate did NOT create a job', jobs, 2)
    const si = (await q(`select type, status from public.schedule_items where id='${EA}'`)).rows[0]
    eq('…and the estimate is still an estimate', si?.type, 'estimate')
    eq('…with its own lifecycle untouched', si?.status, 'scheduled')
  }

  await refused('⛔ a non-routable schedule item cannot be pinned',
    `insert into public.route_pins (user_id, date, "position", schedule_item_id) values ('${A}','${D1}',3,'${RA}');`,
    /only an estimate appointment is routable/i)

  await refused('a pin must point at exactly one stop — not two',
    `insert into public.route_pins (user_id, date, "position", job_id, schedule_item_id)
       values ('${A}','${D1}',4,'${JA2}','${EA}');`, /one_stop|check constraint/i)
  await refused('…and not at nothing',
    `insert into public.route_pins (user_id, date, "position") values ('${A}','${D1}',4);`,
    /one_stop|check constraint/i)

  // ═════════════════════════════════════════════════════════════════════════
  H('3. ⛔ CROSS-TENANT — a pin cannot reach another business\'s stop')

  await refused('tenant A cannot pin tenant B\'s VISIT',
    `insert into public.route_pins (user_id, date, "position", job_id) values ('${A}','${D1}',5,'${JB}');`,
    /violates foreign key/i)
  await refused('tenant A cannot pin tenant B\'s ESTIMATE',
    `insert into public.route_pins (user_id, date, "position", schedule_item_id) values ('${A}','${D1}',6,'${EB}');`,
    /violates foreign key/i)
  await refused('…nor by claiming B\'s user_id on A\'s stop',
    `insert into public.route_pins (user_id, date, "position", job_id) values ('${B}','${D1}',7,'${JA}');`,
    /violates foreign key/i)
  await refused('an UPDATE cannot re-point a pin at another tenant\'s stop',
    `update public.route_pins set job_id='${JB}' where job_id='${JA}';`, /violates foreign key/i)

  {
    // The shape itself, so a future edit cannot quietly drop back to a
    // single-column FK that still passes every behavioural test above by luck.
    const welds = (await q(`
      select con.conname, array_length(con.conkey,1) as ncols
        from pg_constraint con join pg_class ch on ch.oid=con.conrelid
        join pg_namespace n on n.oid=ch.relnamespace
       where n.nspname='public' and ch.relname='route_pins' and con.contype='f'
         and exists (select 1 from pg_attribute a
                      where a.attrelid=ch.oid and a.attname='user_id' and a.attnum = any(con.conkey))
    `)).rows
    const two = welds.filter((w: any) => Number(w.ncols) === 2).map((w: any) => w.conname).sort()
    eq('both parent references are COMPOSITE welds carrying user_id',
      two, ['route_pins_item_tenant_fkey', 'route_pins_job_tenant_fkey'])
    ok('schedule_items carries the composite key the weld needs',
      (await q(`select 1 from pg_constraint where conname='schedule_items_id_user_key'`)).rows.length === 1,
      'schedule_items_id_user_key is missing — the weld cannot exist without it')
  }

  // ═════════════════════════════════════════════════════════════════════════
  H('4. RLS, and what anon holds')

  {
    const asUser = async (uid: string, sql: string) => {
      await q(`set local role authenticated`)
      await q(`select set_config('request.jwt.claim.sub', '${uid}', true)`)
      const r = await q(sql)
      await q(`reset role`)
      return r
    }
    await q('begin')
    const mine = await asUser(A, `select count(*)::int as n from public.route_pins`)
    const theirs = await asUser(B, `select count(*)::int as n from public.route_pins`)
    await q('commit')
    ok('an owner sees their own pins', (mine.rows[0]?.n ?? 0) > 0, JSON.stringify(mine.rows[0]))
    eq('…and another tenant sees none of them', theirs.rows[0]?.n, 0)

    await q('begin')
    let forged = false
    try {
      await q(`set local role authenticated`)
      await q(`select set_config('request.jwt.claim.sub', '${B}', true)`)
      await q(`insert into public.route_pins (user_id, date, "position", job_id) values ('${A}','${D1}',9,'${JA}')`)
      forged = true
    } catch { /* refused, as it must be */ }
    await q('rollback')
    ok('a forged user_id is refused by RLS', !forged, 'a session inserted a pin owned by somebody else')

    ok('row level security is ON', (await q(
      `select relrowsecurity from pg_class where relname='route_pins'`)).rows[0]?.relrowsecurity === true)
    eq('all four policies exist',
      (await q(`select count(*)::int as n from pg_policies where tablename='route_pins'`)).rows[0]?.n, 4)

    const grants = (await q(`select grantee, privilege_type from information_schema.role_table_grants
                              where table_schema='public' and table_name='route_pins'`)).rows
    const of = (g: string) => grants.filter((r: any) => r.grantee === g).map((r: any) => r.privilege_type).sort()
    eq('⛔ anon holds nothing', of('anon'), [])
    eq('⛔ PUBLIC holds nothing', of('PUBLIC'), [])
    // ⭐⭐ Not merely "no more than ALL": TRUNCATE bypasses RLS completely, so a
    // signed-in tenant holding it could empty every tenant's pins without a
    // single policy being consulted. The default-privileges grant is ALL, so
    // this only holds because the proposal revokes authenticated first.
    eq('authenticated holds exactly DML — no TRUNCATE, which would bypass RLS',
      of('authenticated'), ['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
    ok('service_role can still administer it', of('service_role').length > 0)
  }

  // ═════════════════════════════════════════════════════════════════════════
  H('5. cascade — deleting a stop, and deleting a tenant')

  {
    try { await q(`drop publication if exists supabase_realtime`) } catch { /* not present */ }
    eq('two pins exist before we start deleting', await pinCount(), 2)

    await db.exec(`delete from public.schedule_items where id='${EA}';`)
    eq('deleting an estimate appointment takes its pin', await pinCount(`where schedule_item_id is not null`), 0)

    await db.exec(`delete from public.jobs where id='${JA}';`)
    eq('deleting a visit takes its pin', await pinCount(), 0)

    // Cancelling is NOT deleting — and that is deliberate.
    await db.exec(`insert into public.route_pins (user_id, date, "position", job_id) values ('${A}','${D1}',1,'${JA2}');`)
    await db.exec(`update public.jobs set status='cancelled' where id='${JA2}';`)
    eq('⭐ CANCELLING a visit keeps the pin (cancellation is reversible)', await pinCount(), 1)

    await db.exec(`insert into public.jobs (id, user_id, title, scheduled_date) values ('${JA}','${A}','A visit one','${D1}');`)
    await db.exec(`update public.jobs set status='scheduled' where id='${JA2}';`)

    // Tenant deletion. First the catalog: the action is what a reviewer reads.
    const act = (await q(`select confdeltype from pg_constraint where conname='route_pins_user_id_fkey'`)).rows[0]?.confdeltype
    eq('the tenant reference is ON DELETE CASCADE', act, 'c')

    // ⚠️ HONEST GAP, stated rather than worked around. Deleting an auth.users
    // row cannot be exercised here: this schema's audit trail is append-only
    // AND audit_events.user_id references the very row being deleted, so the
    // delete raises before any cascade is observable. That is the structural
    // account-deletion block Session 75 recorded — a property of the schema,
    // not of the pin model, and not something this lane may change.
    //
    // So the tenant leg is proven by the CATALOG (above: confdeltype = 'c'),
    // and the CASCADE MECHANISM ITSELF is proven behaviourally by the two
    // parent legs, which use the same action and did fire.
    await db.exec(`insert into public.route_pins (user_id, date, "position", job_id) values ('${B}','${D1}',1,'${JB}');`)
    eq('tenant B has a pin, scoped to tenant B', await pinCount(`where user_id='${B}'`), 1)
    eq('…and tenant A still has exactly its own', await pinCount(`where user_id='${A}'`), 1)
    console.log('     ⚠️ the auth.users cascade is proven by catalog only — account deletion is')
    console.log('        structurally blocked by the append-only audit trail (S75), not by this model.')
    await db.exec(`delete from public.route_pins where user_id='${B}';`)
  }

  // ═════════════════════════════════════════════════════════════════════════
  H('6. work that MOVES DAY loses its pin — in the database')

  {
    await db.exec(`delete from public.route_pins;`)
    await db.exec(`insert into public.route_pins (user_id, date, "position", job_id) values ('${A}','${D1}',1,'${JA2}');`)
    await db.exec(`insert into public.route_pins (user_id, date, "position", job_id) values ('${A}','${D1}',2,'${JA}');`)
    eq('two visits are pinned on day one', await pinCount(), 2)

    await db.exec(`update public.jobs set scheduled_date='${D2}' where id='${JA2}';`)
    eq('moving a visit to another day drops ITS pin', await pinCount(`where job_id='${JA2}'`), 0)
    eq('…and leaves every other pin alone', await pinCount(), 1)

    // A no-op update must not be a cleanup event.
    await db.exec(`update public.jobs set scheduled_date='${D1}' where id='${JA}';`)
    eq('re-saving the SAME day keeps the pin', await pinCount(`where job_id='${JA}'`), 1)

    // The estimate half of the same rule.
    await db.exec(`insert into public.schedule_items (id, user_id, type, title, scheduled_date)
                   values ('${EA}','${A}','estimate','A estimate','${D1}');`)
    await db.exec(`insert into public.route_pins (user_id, date, "position", schedule_item_id) values ('${A}','${D1}',3,'${EA}');`)
    await db.exec(`update public.schedule_items set scheduled_date='${D2}' where id='${EA}';`)
    eq('moving an ESTIMATE to another day drops its pin too', await pinCount(`where schedule_item_id='${EA}'`), 0)
  }

  // ═════════════════════════════════════════════════════════════════════════
  H('7. a pin\'s day IS the stop\'s day')

  await refused('a pin dated on a day the stop is not on is refused',
    `insert into public.route_pins (user_id, date, "position", job_id) values ('${A}','${D2}',4,'${JA}');`,
    /is not the stop's day/i)
  await refused('…and it cannot be moved to a wrong day by UPDATE',
    `update public.route_pins set date='${D2}' where job_id='${JA}';`, /is not the stop's day/i)

  // ═════════════════════════════════════════════════════════════════════════
  H('8. one pin per stop · many per day · unpin')

  {
    await refused('a stop cannot be pinned twice',
      `insert into public.route_pins (user_id, date, "position", job_id) values ('${A}','${D1}',5,'${JA}');`,
      /duplicate key|unique/i)

    await db.exec(`update public.jobs set scheduled_date='${D1}' where id='${JA2}';`)
    await accepted('a second stop CAN be pinned on the same day',
      `insert into public.route_pins (user_id, date, "position", job_id) values ('${A}','${D1}',5,'${JA2}');`)
    eq('…so a day carries several pins', await pinCount(`where date='${D1}'`), 2)

    // ⭐ Two pins wanting one seat is ACCEPTED on purpose: lib/routePins
    // resolves it deterministically, and a database unique would make an
    // ordinary row-by-row swap fail in a client that opens no transaction.
    await db.exec(`update public.route_pins set "position"=5 where job_id='${JA}';`)
    eq('two stops may claim one seat — resolved in lib/routePins, not refused here',
      (await q(`select count(*)::int as n from public.route_pins where "position"=5`)).rows[0]?.n, 2)

    await db.exec(`delete from public.route_pins where job_id='${JA}';`)
    eq('unpin removes exactly one', await pinCount(`where date='${D1}'`), 1)
    eq('…and the other survives', await pinCount(`where job_id='${JA2}'`), 1)
  }

  // ═════════════════════════════════════════════════════════════════════════
  H('9. a position is a real position')

  await refused('position 0 is refused',
    `insert into public.route_pins (user_id, date, "position", job_id) values ('${A}','${D1}',0,'${JA}');`,
    /position_check|check constraint/i)
  await refused('a negative position is refused',
    `insert into public.route_pins (user_id, date, "position", job_id) values ('${A}','${D1}',-3,'${JA}');`,
    /position_check|check constraint/i)
  await accepted('position 1 is accepted',
    `insert into public.route_pins (user_id, date, "position", job_id) values ('${A}','${D1}',1,'${JA}');`)

  // ═════════════════════════════════════════════════════════════════════════
  H('10. persistence is per TENANT, not per browser')

  {
    // "Second device" is not a database concept — the honest test is that the
    // fact lives in a row keyed to the TENANT, so any session of that tenant
    // reads the same thing, and no session of another tenant reads it at all.
    const asUser = async (uid: string, sql: string) => {
      await q(`set local role authenticated`)
      await q(`select set_config('request.jwt.claim.sub', '${uid}', true)`)
      const r = await q(sql)
      await q(`reset role`)
      return r
    }
    await q('begin')
    const s1 = await asUser(A, `select job_id, "position" from public.route_pins where date='${D1}' order by "position"`)
    const s2 = await asUser(A, `select job_id, "position" from public.route_pins where date='${D1}' order by "position"`)
    await q('commit')
    eq('a second session of the same tenant reads the identical pin set',
      JSON.stringify(s1.rows), JSON.stringify(s2.rows))
    ok('…and it is not empty', s1.rows.length > 0)

    const idx = (await q(`select indexname from pg_indexes where tablename='route_pins'`)).rows.map((r: any) => r.indexname).sort()
    ok('the per-day read is indexed', idx.includes('route_pins_user_date_idx'), idx.join(', '))
  }

  console.log('')
  if (fail) { console.log(`✗ route-pins: ${fail} rule${fail === 1 ? '' : 's'} broken (${pass} held)`); process.exit(1) }
  console.log(`✓ route-pins: every rule holds (${pass} checks)`)
}

main().catch(e => { console.error(e); process.exit(1) })
