// ── Tenant deletion — npm run verify:tenant-deletion ─────────────────────────
//
// THE claim: a business can leave, nothing of it is left behind, and nothing of
// anyone else's is touched.
//
// The defect this exists for, measured on production 2026-08-17:
//
//   delete from auth.users where id = <tenant>
//     ERROR: insert or update on table "audit_events"
//            violates foreign key constraint "audit_events_user_id_fkey"
//
// The cascade reaches eight tables with audit DELETE triggers; each fires
// audit_log(), whose INSERT references the tenant while that tenant's auth row is
// disappearing. Deletion was not unbuilt — it was impossible.
//
// ⚠️⚠️ THE CLEANUP TRAP THIS GUARD REFUSES TO REPEAT. Session 75's fixture cleanup
// used `session_replication_role = replica`. That disables FK triggers too, so
// ON DELETE CASCADE never fired and every tenant row was left ORPHANED behind a
// deleted identity — and the residue check MISSED it, because it counted
//     where user_id in (select id from auth.users where email like …)
// a live subquery through identities that no longer existed, which returns zero
// vacuously. §5 below captures the uuids as LITERALS before anything is deleted
// and searches by those literals afterwards. It never reads auth.users to decide
// what to look for.
//
// §1 structural, over the apply path. §2–5 behavioural, against a database built
// from that apply path in PGlite, driving the real RPCs as real callers.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { splitStatements, loadPGlite, substitutePlatformStatements } from './lib/pg-sql'

const ROOT = join(__dirname, '..')
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`) }
}

// ═══════════════════════════════════════════════════════════════════════════
H('1. THE DESIGN IS ON THE APPLY PATH')

const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
const applyPath = files.map(f => readFileSync(join(MIGRATIONS, f), 'utf8')).join('\n')
// Strip line comments before any ABSENCE assertion — this file documents the very
// things it forbids, and a comment must never satisfy a check.
const code = applyPath.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

ok('a lifecycle table exists with the three distinct states',
  /create table if not exists public\.tenant_lifecycle/i.test(code)
  && /'active'/.test(code) && /'deactivated'/.test(code) && /'deletion_requested'/.test(code))
ok('the tombstone has NO foreign key to auth.users',
  /create table if not exists public\.tenant_deletions[\s\S]*?tenant_user_id\s+uuid\s+not null(?![\s\S]{0,200}references auth\.users)/i.test(code),
  'it must outlive the identity it names')
ok('the tombstone is service_role only — no client reads the deletion ledger',
  /revoke all on table public\.tenant_deletions from public, anon, authenticated, service_role/i.test(code)
  && !/grant [^;]*on table public\.tenant_deletions to (anon|authenticated)/i.test(code))
ok('lifecycle is read-own and has NO client write policy',
  /create policy "tenant_lifecycle: select own"/i.test(code)
  && !/create policy "tenant_lifecycle: (insert|update|delete)/i.test(code),
  'every transition must go through an RPC')

// The three things the previous cleanup did wrong must not appear anywhere.
ok('nothing disables triggers globally', !/disable trigger/i.test(code))
ok('nothing touches session_replication_role', !/session_replication_role/i.test(code))
// Scoped to the deletion migration: the BASELINE legitimately contains constraint
// swaps (the S75 tenant welds replaced single-column FKs with composite ones), so
// scanning the whole apply path would fail on somebody else's correct work.
const deletionSql = readFileSync(join(MIGRATIONS, files.find(f => /tenant_deletion/.test(f)) ?? files[0]), 'utf8')
  .split(/\r?\n/).filter(l => !l.trimStart().startsWith('--')).join('\n')
ok('the deletion design drops no foreign key to make itself possible',
  !/alter table[^;]*drop constraint/i.test(deletionSql))

ok('the purge takes NO tenant parameter (there is nothing to forge)',
  /create or replace function public\.tenant_purge\(\)/i.test(code))
ok('every lifecycle RPC authorises on auth.uid()',
  (code.match(/auth\.uid\(\)/g) || []).length > 0
  && /tenant_purge\(\)[\s\S]{0,600}v_uid\s+uuid\s*:=\s*auth\.uid\(\)/i.test(code))
ok('the purge key is transaction-local',
  /set_config\('edgehq\.purging_tenant',\s*v_uid::text,\s*true\)/i.test(code),
  'a session-lifetime setting would outlive the transaction that justified it')
ok('both exceptions compare the key to the ROW\'S OWN tenant',
  /current_setting\('edgehq\.purging_tenant', true\), ''\) = p_tenant::text/i.test(code)
  && /current_setting\('edgehq\.purging_tenant', true\), ''\) = old\.user_id::text/i.test(code),
  'comparing to anything else would let one purge reach another tenant')
ok('immutability still raises for every other case',
  /audit_events_immutable\(\)[\s\S]*?raise exception/i.test(code))

// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  H('2. A DATABASE BUILT FROM THAT APPLY PATH')

  const pglite = await loadPGlite()
  if (!pglite) {
    // A security guard must never report green because its own engine is absent.
    console.log('\n❌ verify:tenant-deletion CANNOT RUN — PGlite is not installed.')
    console.log('   The behavioural half is the half that matters, so this is a FAILURE.')
    console.log('   npm i -D @electric-sql/pglite\n')
    process.exit(1)
  }
  const { PGlite, contribs } = pglite
  const db = await PGlite.create({ extensions: Object.fromEntries(Object.entries(contribs).filter(([, v]) => v)) })

  const PRELUDE = join(ROOT, 'scripts', 'schema', 'platform-prelude.sql')
  for (const [label, raw] of [
    ['platform prelude', readFileSync(PRELUDE, 'utf8')] as const,
    ...files.map(f => [f, readFileSync(join(MIGRATIONS, f), 'utf8')] as const),
  ]) {
    const { sql } = substitutePlatformStatements(raw)
    for (const s of splitStatements(sql)) {
      try { await db.exec(s + ';') } catch (e: any) {
        console.error(`  ✗ failed applying ${label}: ${String(e.message).slice(0, 200)}`)
        process.exit(1)
      }
    }
  }
  console.log(`  ✅ built from the prelude + ${files.length} migration file(s)`)

  // ⚠️ PGlite ships Postgres 18; production is 17. PG18 refuses a DELETE on a table
  // in a publication whose replica identity contains unpublished GENERATED columns
  // ("cannot delete from table … Replica identity must not contain unpublished
  // generated columns", 42P10) — a rule PG17 does not have, so it fires here and
  // never in production. Realtime membership is irrelevant to deletion, so it is
  // dropped in this disposable database rather than left to mask the purge.
  await db.exec(`do $$
  declare p record;
  begin
    for p in select pubname from pg_publication loop
      execute format('drop publication if exists %I', p.pubname);
    end loop;
  end $$;`)

  // ⭐ CAPTURED UUIDS. Literals, fixed here, before anything exists — never read
  // back from auth.users, which is the mistake §5 exists to prevent.
  const A = '11111111-1111-4111-8111-aaaaaaaaaaaa'   // the leaving business
  const B = '22222222-2222-4222-8222-bbbbbbbbbbbb'   // the bystander
  const W = '33333333-3333-4333-8333-cccccccccccc'   // A's worker

  // The prelude models PostgREST: auth.uid() reads request.jwt.claim.sub
  // (SINGULAR), while request.jwt.claims carries the role. Both must be set — a
  // guard that sets only `claims` leaves auth.uid() null and every RPC answers
  // "not-signed-in", which looks like a passing authorisation check and is not one.
  const as = async (uid: string | null) => {
    if (uid) {
      await db.exec(`set request.jwt.claim.sub = '${uid}'`)
      await db.exec(`set request.jwt.claims = '{"role":"authenticated","sub":"${uid}"}'`)
    } else {
      await db.exec(`set request.jwt.claim.sub = ''`)
      await db.exec(`set request.jwt.claims = '{"role":"anon"}'`)
    }
  }
  const one = async (sql: string) => (await db.query(sql)).rows[0] as any
  const val = async (sql: string) => Object.values((await one(sql)) ?? {})[0]

  await db.exec(`
    insert into auth.users (id, email) values
      ('${A}','leaving@fixture.test'), ('${B}','staying@fixture.test'), ('${W}','worker@fixture.test');
    insert into public.business_settings (user_id, company_name, booking_token) values
      ('${A}','Leaving Co','tok-a-0000'), ('${B}','Staying Co','tok-b-0000');
    insert into public.customers (id, user_id, name) values
      ('aaaa0000-0000-4000-8000-000000000001','${A}','A customer'),
      ('bbbb0000-0000-4000-8000-000000000001','${B}','B customer');
    insert into public.invoices (user_id, customer_id, customer_name, invoice_number, amount, status) values
      ('${A}','aaaa0000-0000-4000-8000-000000000001','A customer','A-INV-1',100,'unpaid'),
      ('${B}','bbbb0000-0000-4000-8000-000000000001','B customer','B-INV-1',200,'unpaid');
    insert into public.jobs (user_id, customer_id, title, scheduled_date) values
      ('${A}','aaaa0000-0000-4000-8000-000000000001','A visit','2026-09-01'),
      ('${B}','bbbb0000-0000-4000-8000-000000000001','B visit','2026-09-01');
    insert into public.technicians (user_id, name, auth_user_id) values ('${A}','A worker','${W}');
    insert into storage.objects (bucket_id, name, owner) values
      ('job-photos','${A}/photo-a.jpg','${A}'),
      ('job-photos','${B}/photo-b.jpg','${B}'),
      ('booking-uploads','tok-a-0000/lead-a.jpg', null),
      ('booking-uploads','tok-b-0000/lead-b.jpg', null);
  `)
  // Real audit rows, minted the way the app mints them.
  await as(A)
  await db.exec(`select public.audit_log('${A}','customer_added','customer','aaaa0000-0000-4000-8000-000000000001','A customer',null,null,null,null)`)
  await as(B)
  await db.exec(`select public.audit_log('${B}','customer_added','customer','bbbb0000-0000-4000-8000-000000000001','B customer',null,null,null,null)`)

  const auditA0 = await val(`select count(*)::int from public.audit_events where user_id = '${A}'`)
  const auditB0 = await val(`select count(*)::int from public.audit_events where user_id = '${B}'`)
  console.log(`  ✅ seeded: A and B each own data; audit rows A=${auditA0} B=${auditB0}`)

  // ── the original defect, reproduced ───────────────────────────────────────
  H('3. THE ORIGINAL DEFECT, AND THAT IT IS GONE')
  let blocked = false
  try { await db.exec(`delete from auth.users where id = '${A}'`) }
  catch (e: any) { blocked = /audit_events/.test(String(e.message)) }
  ok('a naive delete of the identity is still refused (the defect is real)', blocked,
    'if this passes trivially the fixture no longer reproduces the bug')

  // ── the attacks ───────────────────────────────────────────────────────────
  H('4. THE ATTACKS')

  // worker tries to delete the business they work for
  await as(W)
  const wReq = await val(`select public.tenant_request_deletion('worker attempt', 0)`)
  ok('a WORKER cannot request deletion of the business they work for',
    JSON.stringify(wReq).includes('no-business'), JSON.stringify(wReq))
  const wPurge = await val(`select public.tenant_purge()`)
  ok('…and cannot purge it', JSON.stringify(wPurge).includes('not-requested'), JSON.stringify(wPurge))

  // anon
  await as(null)
  const anonReq = await val(`select public.tenant_request_deletion('anon', 0)`)
  ok('an anonymous caller cannot request deletion',
    JSON.stringify(anonReq).includes('not-signed-in'), JSON.stringify(anonReq))

  // purge before requesting
  await as(A)
  const early = await val(`select public.tenant_purge()`)
  ok('purging without a request is refused', JSON.stringify(early).includes('not-requested'))

  // grace period is honoured
  const gReq = await val(`select public.tenant_request_deletion('changed my mind later', 7)`)
  ok('a deletion request opens a grace period', JSON.stringify(gReq).includes('deletion_requested'))
  const during = await val(`select public.tenant_purge()`)
  ok('…and the purge refuses while it is running',
    JSON.stringify(during).includes('grace-period'), JSON.stringify(during))

  // cancel restores
  const cancel = await val(`select public.tenant_cancel_deletion()`)
  ok('the request can be cancelled', JSON.stringify(cancel).includes('"ok": true') || JSON.stringify(cancel).includes('"ok":true'))
  ok('…and no open tombstone is left behind',
    (await val(`select count(*)::int from public.tenant_deletions where tenant_user_id = '${A}' and status = 'requested'`)) === 0)

  // deactivate is a different thing from deletion
  const deact = await val(`select public.tenant_set_active(false)`)
  ok('deactivate is a separate, reversible state', String(deact) === 'deactivated')
  await db.exec(`select public.tenant_set_active(true)`)

  // a foreign tenant cannot be named — and B cannot be reached by forging the key
  await as(B)
  await db.exec(`select public.tenant_request_deletion('B leaves too', 0)`)
  await as(A)
  let forged = false
  // A sets the key to B by hand, then tries to delete A's OWN audit rows. The key
  // says "purging B", the rows belong to A, so the per-row comparison must refuse.
  // The rollback is issued separately: the raise aborts the transaction, and a
  // rollback batched behind it in the same exec never runs, which would leave the
  // session wedged and every later check failing for the wrong reason.
  await db.exec(`begin`)
  try {
    await db.exec(`select set_config('edgehq.purging_tenant','${B}',true)`)
    await db.exec(`delete from public.audit_events where user_id = '${A}'`)
  } catch (e: any) { forged = /append-only/.test(String(e.message)) }
  await db.exec(`rollback`)
  ok('a forged purge key cannot delete a DIFFERENT tenant\'s audit rows', forged,
    'the exception must compare the key to each row, not merely to a session value')
  await as(B)
  await db.exec(`select public.tenant_cancel_deletion()`)

  // ── the real deletion ─────────────────────────────────────────────────────
  H('5. THE DELETION, AND RESIDUE BY CAPTURED UUID')

  await as(A)
  await db.exec(`select public.tenant_request_deletion('leaving for good', 0)`)
  const purge = await one(`select public.tenant_purge() as r`)
  const r = purge.r
  ok('the purge succeeds', r && r.ok === true, JSON.stringify(r).slice(0, 200))
  console.log(`     rows removed: ${r?.rows_deleted}, storage objects: ${r?.storage_objects_deleted}`)

  // ⭐ RESIDUE BY CAPTURED LITERAL — never `in (select id from auth.users …)`.
  const tenantTables = (await db.query(`
    select c.relname as t from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id' and a.attnum > 0
     where ns.nspname = 'public' and c.relkind = 'r' order by c.relname`)).rows as { t: string }[]

  let residue = 0
  const dirty: string[] = []
  for (const { t } of tenantTables) {
    const n = Number(await val(`select count(*)::int from public."${t}" where user_id = '${A}'`))
    if (n > 0) { residue += n; dirty.push(`${t}=${n}`) }
  }
  ok(`zero residue for the captured uuid across ${tenantTables.length} tenant tables`,
    residue === 0, dirty.join(', '))

  const storeA = await val(`select count(*)::int from storage.objects where owner = '${A}' or name like '${A}/%' or name like 'tok-a-0000/%'`)
  ok('storage objects are gone, including the booking-token-keyed ones', Number(storeA) === 0,
    `${storeA} objects remain`)

  const auditA = await val(`select count(*)::int from public.audit_events where user_id = '${A}'`)
  ok('the leaving tenant audit history is gone', Number(auditA) === 0)

  // ── the bystander is untouched ────────────────────────────────────────────
  const bRows = Number(await val(`select
      (select count(*) from public.customers where user_id = '${B}')
    + (select count(*) from public.invoices  where user_id = '${B}')
    + (select count(*) from public.jobs      where user_id = '${B}')
    + (select count(*) from public.business_settings where user_id = '${B}')`))
  ok('the OTHER tenant is entirely untouched', bRows === 4, `${bRows} of 4 rows survive`)
  ok('…including its audit history',
    Number(await val(`select count(*)::int from public.audit_events where user_id = '${B}'`)) === Number(auditB0))
  ok('…and its storage',
    Number(await val(`select count(*)::int from storage.objects where owner = '${B}' or name like 'tok-b-0000/%'`)) === 2)

  // ── the identity can now be removed — the whole point ─────────────────────
  let identityGone = false
  try {
    await db.exec(`delete from auth.users where id = '${A}'`)
    identityGone = Number(await val(`select count(*)::int from auth.users where id = '${A}'`)) === 0
  } catch (e: any) { identityGone = false; console.log('     delete error:', String(e.message).slice(0, 140)) }
  ok('the auth identity deletes cleanly AFTER the purge (the defect is closed)', identityGone)

  // ── replay / already deleted / partial retry ──────────────────────────────
  H('6. REPLAY, RETRY AND ALREADY-DELETED')

  await as(A)
  const replay = await val(`select public.tenant_purge()`)
  ok('replaying the purge is harmless (idempotent, no error)',
    JSON.stringify(replay).includes('not-requested'), JSON.stringify(replay))

  const tomb = await one(`select status, rows_deleted, storage_objects_deleted, executed_at
                            from public.tenant_deletions where tenant_user_id = '${A}'`)
  ok('a tombstone survives the tenant it describes', !!tomb && tomb.status === 'completed',
    JSON.stringify(tomb).slice(0, 160))
  ok('…and it still names the business after the identity is gone',
    !!(await one(`select company_name, owner_email from public.tenant_deletions where tenant_user_id = '${A}'`))?.company_name)

  // partial failure: a row arrives after a purge; requesting again must finish the job
  await db.exec(`insert into auth.users (id, email) values ('${A}','leaving@fixture.test')`)
  await db.exec(`insert into public.business_settings (user_id, company_name) values ('${A}','Leaving Co (retry)')`)
  await db.exec(`insert into public.customers (id, user_id, name) values ('aaaa0000-0000-4000-8000-000000000009','${A}','late arrival')`)
  await as(A)
  await db.exec(`select public.tenant_request_deletion('retry after interruption', 0)`)
  const retry = await one(`select public.tenant_purge() as r`)
  ok('an interrupted deletion completes on retry', retry.r && retry.r.ok === true, JSON.stringify(retry.r).slice(0, 160))
  let residue2 = 0
  for (const { t } of tenantTables) {
    residue2 += Number(await val(`select count(*)::int from public."${t}" where user_id = '${A}'`))
  }
  ok('…leaving zero residue again', residue2 === 0, `${residue2} rows remain`)

  // ── immutability is intact for everyone else ──────────────────────────────
  H('7. IMMUTABILITY IS NOT WEAKENED')

  await as(B)
  let stillImmutable = false
  try { await db.exec(`delete from public.audit_events where user_id = '${B}'`) }
  catch (e: any) { stillImmutable = /append-only/.test(String(e.message)) }
  ok('audit rows are still append-only outside a purge', stillImmutable)

  let updateRefused = false
  try { await db.exec(`update public.audit_events set action = 'rewritten' where user_id = '${B}'`) }
  catch (e: any) { updateRefused = /append-only/.test(String(e.message)) }
  ok('…and still cannot be edited', updateRefused)

  console.log(`\n${fail === 0 ? '✅' : '❌'} verify:tenant-deletion — ${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
