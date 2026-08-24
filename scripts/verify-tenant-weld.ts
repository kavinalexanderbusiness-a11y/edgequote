// ── Tenant welds — npm run verify:tenant-weld ────────────────────────────────
//
// THE invariant this pins: a child row's tenant and its parent row's tenant are the
// SAME tenant, enforced by the database, not by the code that happens to write it.
//
// The defects it was written for (all three live in production on 2026-08-16, all
// three the same shape):
//
//   B1  customer_portal_tokens.customer_id -> customers(id)
//       "portal_tokens: insert own" validates only (auth.uid() = user_id), so a
//       signed-in tenant could mint a WORKING portal token for another tenant's
//       customer and then read their PII through get_portal_data and act on it
//       through portal_remove_card / portal_accept_quote / portal_respond_change_order.
//
//   B2  payments.invoice_id -> invoices(id)
//       Same shape on the money ledger. The SECURITY DEFINER trigger
//       recompute_invoice_paid_for sums payments by invoice_id and writes
//       amount_paid / status / paid_at, so an attacker-controlled invoice_id moved
//       another tenant's invoice to "paid" — invisibly, because payments are
//       read-scoped to their owner.
//       Note the tell: payments_quote_tenant_fkey on the line BELOW it was already
//       welded. The quote leg was done; the invoice leg was missed.
//
//   B3  storage "booking-uploads: read own" was bucket-wide for `authenticated`.
//       Object paths start with the raw booking token, so LISTING the bucket
//       handed over every tenant's booking credential.
//
// ⚠️ WHY THIS GUARD IS DIFFERENT FROM ITS PREDECESSORS. verify:tenant-boundary and
// verify:beta-signup assert against supabase/archive/, which is NEVER applied to any
// database — they have been testing a historical document. This one reads
// supabase/migrations/ (THE apply path) and then, more importantly, stops asserting
// about text at all: it builds the schema from zero in PGlite and runs the actual
// attacks. A regex can be satisfied by a comment. A refused INSERT cannot.

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
H('1. THE APPLY PATH — assertions read supabase/migrations/, never archive/')

const migrationFiles = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
const applyPath = migrationFiles.map(f => readFileSync(join(MIGRATIONS, f), 'utf8')).join('\n')
ok('supabase/migrations/ is non-empty (the guard has something to read)', migrationFiles.length > 0,
  `files: ${migrationFiles.join(', ')}`)

// Strip line comments before matching: this codebase has been bitten by a regex
// that matched a COMMENTED-OUT line and reported a property that did not exist.
const code = applyPath.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

// These assert the STATE the apply path produces, not one particular spelling of
// it. The apply path is a hand-written migration while a change is in flight and a
// GENERATED baseline once it is folded in, and the generator quotes identifiers and
// drops the `public.` qualifier. A guard that only matched the hand-written form
// would go green today and silently stop checking after the next resync.
const weld = (constraint: string, cols: string, parent: string) =>
  new RegExp(
    `add constraint "?${constraint}"?\\s+foreign key \\(${cols}\\)\\s+references (?:public\\.)?${parent}\\s*\\(user_id, id\\)`,
    'i',
  ).test(code)

ok('the portal-token weld is on the apply path',
  weld('customer_portal_tokens_customer_same_owner', 'user_id, customer_id', 'customers'))
ok('the invoice composite key is on the apply path',
  /add constraint "?invoices_user_id_id_key"?\s+unique \(user_id, id\)/i.test(code))
ok('the payment->invoice weld is on the apply path',
  weld('payments_invoice_tenant_fkey', 'user_id, invoice_id', 'invoices'))
ok('the payment->customer weld is on the apply path',
  weld('payments_customer_tenant_fkey', 'user_id, customer_id', 'customers'))
// The bucket-wide policy is gone. In a migration that reads as a DROP; in the
// generated baseline it simply is not there. Absence is the invariant either way —
// and it is the one that matters, because a re-added policy would reopen it.
ok('no SELECT policy over booking-uploads exists on the apply path',
  !/create policy "booking-uploads: read own"/i.test(code))
ok('booking-uploads is bounded by size and MIME on the apply path',
  /'booking-uploads'[\s\S]{0,120}?\b\d{6,}\b[\s\S]{0,200}?array\['image\//i.test(code)
  || /update storage\.buckets[\s\S]{0,400}file_size_limit\s*=\s*\d+[\s\S]{0,400}allowed_mime_types/i.test(code))
ok('the paid-total recompute is tenant-filtered on the apply path',
  /p\.user_id = v_inv\.user_id/.test(code))

// -- The inventory / equipment welds ------------------------------------------
// Added after B1-B3, by classifying all 106 single-column tenant FKs on the only
// question that separates a latent shape from a live defect: does a SECURITY
// DEFINER path traverse the relation WITHOUT constraining user_id? Two did, and
// both reproduce B2 exactly. The stock one is worse than corruption, because
// recompute_part_stock REPLACES qty_on_hand rather than adjusting it.
ok('parts carries the composite key its weld references',
  /add constraint "?parts_user_id_id_key"?\s+unique \(user_id, id\)/i.test(code))
ok('equipment carries the composite key its weld references',
  /add constraint "?equipment_user_id_id_key"?\s+unique \(user_id, id\)/i.test(code))
ok('the part-movement -> part weld is on the apply path',
  weld('part_movements_part_tenant_fkey', 'user_id, part_id', 'parts'))
ok('the equipment-service -> equipment weld is on the apply path',
  weld('equipment_service_equipment_tenant_fkey', 'user_id, equipment_id', 'equipment'))

// ═══════════════════════════════════════════════════════════════════════════
H('2. THE ATTACKS — run against a database built from that apply path')

async function main() {
const pglite = await loadPGlite()
if (!pglite) {
  // ⚠️ A security guard must NEVER report green because its own dependency is
  // absent. Skipping here would mean "the attacks were not attempted", which is
  // not the same as "the attacks failed".
  console.log('\n❌ verify:tenant-weld CANNOT RUN — PGlite is not installed.')
  console.log('   The behavioural half of this guard is the half that matters, so this')
  console.log('   is a FAILURE, not a skip.  npm i -D @electric-sql/pglite\n')
  process.exit(1)
}

const { PGlite, contribs } = pglite
const db = await PGlite.create({ extensions: Object.fromEntries(Object.entries(contribs).filter(([, v]) => v)) })

// The prelude is what Supabase itself provides (the auth/storage schemas, the
// roles, the helper functions). Same file verify:rebuild uses, so both guards
// build on identical ground.
const PRELUDE = join(ROOT, 'scripts', 'schema', 'platform-prelude.sql')
for (const [label, raw] of [
  ['platform prelude', readFileSync(PRELUDE, 'utf8')] as const,
  ...migrationFiles.map(f => [f, readFileSync(join(MIGRATIONS, f), 'utf8')] as const),
]) {
  const { sql } = substitutePlatformStatements(raw)
  for (const s of splitStatements(sql)) {
    try { await db.exec(s + ';') } catch (e: any) {
      console.error(`  ✗ failed applying ${label}: ${String(e.message).slice(0, 200)}`)
      process.exit(1)
    }
  }
}
console.log(`  ✅ built a database from the prelude + ${migrationFiles.length} migration file(s)`)

// ── The schema AT REST, snapshotted before any attack mutates it ─────────────
// Section 2b deliberately DROPS customer_portal_tokens_customer_same_owner to
// prove the portal predicates hold on their own, and section 3 must not read
// that disposable damage as a regression. So the ratchets in section 3 measure
// what the APPLY PATH produced, captured here, not what survives the probes.
const weldsAtRest = new Set(((await db.query(`
  select con.conname from pg_constraint con
    join pg_class ch on ch.oid = con.conrelid
    join pg_namespace n on n.oid = ch.relnamespace
   where con.contype = 'f' and array_length(con.conkey, 1) = 2 and n.nspname = 'public'
     and exists (select 1 from pg_attribute a
                  where a.attrelid = ch.oid and a.attname = 'user_id' and a.attnum = any(con.conkey))
`)).rows as any[]).map(r => r.conname as string))

// Two tenants. auth.users is provided by the platform prelude, so seed it directly.
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
await db.exec(`insert into auth.users (id, email) values ('${A}', 'a@fixture.test'), ('${B}', 'b@fixture.test');`)
await db.exec(`
  insert into public.customers (id, user_id, name) values
    ('aaaaaaaa-0000-4000-8000-000000000001', '${A}', 'Tenant A customer'),
    ('bbbbbbbb-0000-4000-8000-000000000001', '${B}', 'Tenant B customer');
  insert into public.invoices (id, user_id, customer_id, customer_name, invoice_number, amount, status) values
    ('aaaaaaaa-0000-4000-8000-000000000009', '${A}', 'aaaaaaaa-0000-4000-8000-000000000001', 'Tenant A customer', 'INV-A1', 100, 'unpaid'),
    ('bbbbbbbb-0000-4000-8000-000000000009', '${B}', 'bbbbbbbb-0000-4000-8000-000000000001', 'Tenant B customer', 'INV-B1', 500, 'unpaid');
`)

async function refused(label: string, sql: string) {
  try { await db.exec(sql); ok(label, false, 'the database ACCEPTED it — the weld is not holding') }
  catch (e: any) {
    const msg = String(e.message)
    const isFk = /foreign key|violates/i.test(msg)
    ok(label, isFk, isFk ? '' : `rejected, but not by a constraint: ${msg.slice(0, 160)}`)
  }
}
async function accepted(label: string, sql: string) {
  try { await db.exec(sql); ok(label, true) }
  catch (e: any) { ok(label, false, `legitimate operation was REFUSED: ${String(e.message).slice(0, 200)}`) }
}

// ── B1 ───────────────────────────────────────────────────────────────────────
await refused('B1: tenant A cannot mint a portal token for tenant B\'s customer',
  `insert into public.customer_portal_tokens (token, user_id, customer_id)
     values ('forged-a-over-b', '${A}', 'bbbbbbbb-0000-4000-8000-000000000001');`)
await accepted('B1: tenant A CAN still mint a token for its own customer',
  `insert into public.customer_portal_tokens (token, user_id, customer_id)
     values ('legit-a', '${A}', 'aaaaaaaa-0000-4000-8000-000000000001');`)

// ── B2 ───────────────────────────────────────────────────────────────────────
await refused('B2: tenant A cannot attach a payment to tenant B\'s invoice',
  `insert into public.payments (user_id, invoice_id, amount, kind, status)
     values ('${A}', 'bbbbbbbb-0000-4000-8000-000000000009', 500, 'payment', 'paid');`)
await refused('B2: tenant A cannot attach a payment to tenant B\'s customer',
  `insert into public.payments (user_id, customer_id, amount, kind, status)
     values ('${A}', 'bbbbbbbb-0000-4000-8000-000000000001', 500, 'payment', 'paid');`)
await accepted('B2: tenant A CAN still record a payment against its own invoice',
  `insert into public.payments (user_id, invoice_id, customer_id, amount, kind, status)
     values ('${A}', 'aaaaaaaa-0000-4000-8000-000000000009',
             'aaaaaaaa-0000-4000-8000-000000000001', 100, 'payment', 'paid');`)

// The point of B2 was never the row — it was the invoice STATUS the row moves.
const bStatus = await db.query(`select status, amount_paid from public.invoices where id = 'bbbbbbbb-0000-4000-8000-000000000009'`)
ok('B2: tenant B\'s invoice was NOT moved by any of the above',
  bStatus.rows[0].status === 'unpaid' && Number(bStatus.rows[0].amount_paid ?? 0) === 0,
  `B's invoice reads status=${bStatus.rows[0].status} amount_paid=${bStatus.rows[0].amount_paid}`)
const aStatus = await db.query(`select status, amount_paid from public.invoices where id = 'aaaaaaaa-0000-4000-8000-000000000009'`)
ok('B2: …while tenant A\'s own invoice DID move (the trigger still works)',
  Number(aStatus.rows[0].amount_paid) === 100,
  `A's invoice reads status=${aStatus.rows[0].status} amount_paid=${aStatus.rows[0].amount_paid}`)

// ── B3 ───────────────────────────────────────────────────────────────────────
const pol = await db.query(`
  select count(*)::int as n from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and coalesce(qual, with_check, '') like '%booking-uploads%'
     and cmd = 'SELECT'`)
ok('B3: no SELECT policy exposes the booking-uploads bucket', pol.rows[0].n === 0,
  `${pol.rows[0].n} SELECT policy(ies) still reference the bucket`)

const bucket = await db.query(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'booking-uploads'`)
ok('B3: booking uploads are size-bounded', Number(bucket.rows[0]?.file_size_limit) > 0,
  `file_size_limit = ${bucket.rows[0]?.file_size_limit}`)
ok('B3: booking uploads are MIME-restricted to images',
  Array.isArray(bucket.rows[0]?.allowed_mime_types) && bucket.rows[0].allowed_mime_types.length > 0
    && bucket.rows[0].allowed_mime_types.every((m: string) => m.startsWith('image/')),
  `allowed_mime_types = ${JSON.stringify(bucket.rows[0]?.allowed_mime_types)}`)
// The public /book funnel depends on the anon INSERT. Removing it would be a
// different outage, so the guard pins that it SURVIVED.
const ins = await db.query(`
  select count(*)::int as n from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname = 'booking_uploads_public_insert'`)
ok('B3: the public booking upload path is preserved (anon INSERT still exists)', ins.rows[0].n === 1)

// -- B4 / B5: the inventory + equipment welds, proved by attack ---------------
// Seeded here rather than at the top because nothing above needs them, and a
// failed seed should read as a seed failure, not as a weld that let something in.
await db.exec(`
  insert into public.parts (id, user_id, name, qty_on_hand) values
    ('aaaaaaaa-0000-4000-8000-00000000000a', '${A}', 'A widget', 100),
    ('bbbbbbbb-0000-4000-8000-00000000000a', '${B}', 'B widget', 100);
  insert into public.equipment (id, user_id, name) values
    ('aaaaaaaa-0000-4000-8000-00000000000b', '${A}', 'A mower'),
    ('bbbbbbbb-0000-4000-8000-00000000000b', '${B}', 'B mower');
`)

await refused("B4: tenant A cannot move stock against tenant B's part",
  `insert into public.part_movements (user_id, part_id, kind, qty)
     values ('${A}', 'bbbbbbbb-0000-4000-8000-00000000000a', 'consume', -175);`)
await accepted('B4: tenant A CAN still move stock against its own part',
  `insert into public.part_movements (user_id, part_id, kind, qty)
     values ('${A}', 'aaaaaaaa-0000-4000-8000-00000000000a', 'restock', 5);`)

await refused("B5: tenant A cannot log service against tenant B's equipment",
  `insert into public.equipment_service (user_id, equipment_id, kind, service_date)
     values ('${A}', 'bbbbbbbb-0000-4000-8000-00000000000b', 'repair', '2099-01-01');`)
await accepted('B5: tenant A CAN still log service against its own equipment',
  `insert into public.equipment_service (user_id, equipment_id, kind, service_date)
     values ('${A}', 'aaaaaaaa-0000-4000-8000-00000000000b', 'repair', '2026-01-01');`)

// The consequence, not the row. recompute_part_stock REPLACES qty_on_hand from
// the movement ledger, so an accepted forged movement does not corrupt the number
// — it OVERWRITES it. B's stock must read exactly what it was seeded with.
const bPart = await db.query(`select qty_on_hand from public.parts where id = 'bbbbbbbb-0000-4000-8000-00000000000a'`)
ok("B4: tenant B's stock on hand was NOT moved by any of the above",
  Number(bPart.rows[0].qty_on_hand) === 100,
  `B's part reads qty_on_hand=${bPart.rows[0].qty_on_hand}, expected 100`)


// ═══════════════════════════════════════════════════════════════════════════
H('2b. THE PORTAL PROVES BOTH — every customer lookup also constrains the tenant')

// THE RULE the readiness review asked for: no portal function may resolve rows by
// customer alone. Read from the apply path, so it cannot be satisfied by a repo
// file production never applied.
// The apply path is applied IN ORDER, and `create or replace` means the LAST
// definition of a function is the one that ends up in the database. The baseline
// still carries the pre-patch bodies, so scanning every match would report a state
// that never exists at rest. Keep only the final definition of each function.
const finalBody = new Map<string, string>()
for (const [, name, body] of code.matchAll(
  /CREATE OR REPLACE FUNCTION public\.(get_portal_data|portal_[a-z_]+)\s*\([\s\S]*?\$function\$([\s\S]*?)\$function\$/gi,
)) {
  finalBody.set(name, body)   // later assignment wins, which is apply order
}
ok('the apply path actually contains the portal functions', finalBody.size > 0,
  `found ${finalBody.size} distinct portal function(s)`)

const unscoped: string[] = []
for (const [name, body] of finalBody) {
  for (const part of body.split(/(?=\bfrom public\.|\bupdate public\.|\bdelete from public\.)/i)) {
    const m = /^(?:from|update|delete from) public\.("?[a-z_]+"?)/i.exec(part)
    if (!m) continue
    const table = m[1].replace(/"/g, '')
    // The token lookup resolves BY TOKEN — that is the credential, not a customer.
    if (table === 'customer_portal_tokens') continue
    // 900, not 320: a multi-line UPDATE reaches its customer predicate well past
    // 320 characters, so a short window reads it as "no customer reference here" and
    // reports it clean. That exact blind spot let portal_respond_change_order through
    // the first pass.
    const clause = part.slice(0, 900)
    if (!/v_customer/.test(clause)) continue
    if (/user_id/.test(clause)) continue
    unscoped.push(`${name} → ${table}`)
  }
}
ok('no portal function resolves rows by customer without also constraining user_id',
  unscoped.length === 0,
  unscoped.length ? `unscoped:\n     ${unscoped.join('\n     ')}` : '')

// plpgsql compiles LAZILY: `create or replace function` accepts a body with a
// reference to a column that does not exist, and only fails when it first RUNS.
// So every patched function is executed, not merely created.
const PORTAL_CALLS: [string, string][] = [
  ['get_portal_data', `select public.get_portal_data('legit-a')`],
  ['portal_invoice_for_payment', `select public.portal_invoice_for_payment('legit-a', 'aaaaaaaa-0000-4000-8000-000000000009')`],
  ['portal_begin_setup', `select public.portal_begin_setup('legit-a')`],
  ['portal_mark_reviewed', `select public.portal_mark_reviewed('legit-a')`],
  ['portal_decline_review', `select public.portal_decline_review('legit-a')`],
  ['portal_add_contact', `select public.portal_add_contact('legit-a', '5875550000', null)`],
  ['portal_set_consent', `select public.portal_set_consent('legit-a', true, true)`],
  ['portal_set_autopay', `select public.portal_set_autopay('legit-a', false)`],
  ['portal_remove_card', `select public.portal_remove_card('legit-a')`],
  ['portal_accept_quote', `select public.portal_accept_quote('legit-a', '00000000-0000-4000-8000-000000000000', null, null)`],
  ['portal_set_scheduling_preference', `select public.portal_set_scheduling_preference('legit-a', '00000000-0000-4000-8000-000000000000', null, null, null, null)`],
  ['portal_submit_request', `select public.portal_submit_request('legit-a', 'service', 'probe', null, null)`],
]
// ⚠️ PGlite ships Postgres 18; production is 17. PG18 refuses an UPDATE on a table
// in a publication whose replica identity contains unpublished GENERATED columns
// ("cannot update table … Replica identity must not contain unpublished generated
// columns", 42P10) — a rule PG17 does not have, so this fires here and never in
// production. Realtime membership has nothing to do with tenant scoping, so it is
// dropped in this disposable database rather than left to mask the write paths.
await db.exec(`do $$
declare p record;
begin
  for p in select pubname from pg_publication loop
    execute format('drop publication if exists %I', p.pubname);
  end loop;
end $$;`)

let compiled = 0
const failedCalls: string[] = []
for (const [name, call] of PORTAL_CALLS) {
  try { await db.query(call); compiled++ }
  catch (e: any) {
    const msg = String(e.message)
    // A wrong-arity/absent-overload call is this guard being out of date, not the
    // function being broken. A column/variable error is the real failure mode.
    if (/does not exist|no function matches/i.test(msg) && !/column|record/i.test(msg)) { compiled++; continue }
    failedCalls.push(`${name}: ${msg.slice(0, 400)}`)
  }
}
ok('every patched portal function COMPILES AND RUNS (plpgsql compiles lazily)',
  failedCalls.length === 0,
  failedCalls.length ? failedCalls.join('\n     ') : `${compiled}/${PORTAL_CALLS.length} executed`)

// ── The second layer, proved on its own ──────────────────────────────────────
// Drop the composite FK in this disposable database and forge exactly the token
// the constraint normally makes impossible. If the predicates are real, the
// forged token still yields nothing of tenant B's.
await db.exec(`alter table public.customer_portal_tokens drop constraint customer_portal_tokens_customer_same_owner;`)
await db.exec(`insert into public.customer_portal_tokens (token, user_id, customer_id)
  values ('forged-defence-in-depth', '${A}', 'bbbbbbbb-0000-4000-8000-000000000001');`)
const forged = await db.query(`select public.get_portal_data('forged-defence-in-depth') as d`)
const payload = forged.rows[0]?.d
const leaked = payload && JSON.stringify(payload).includes('Tenant B customer')
ok('with the FK REMOVED, a forged token still leaks no tenant-B customer',
  !leaked,
  leaked ? 'get_portal_data returned tenant B PII — the predicates are not holding' : '')
// And the control: the honest token still works with the FK gone.
const honest = await db.query(`select public.get_portal_data('legit-a') as d`)
ok('…while the legitimate token still returns its own customer',
  !!honest.rows[0]?.d && JSON.stringify(honest.rows[0].d).includes('Tenant A customer'))

// ═══════════════════════════════════════════════════════════════════════════
H('3. THE CLASS — enforced, not merely counted')

// This section used to PRINT the number of unwelded single-column tenant FKs and
// pass regardless. That made it a report, not a guard: a weld could be dropped, a
// new latent relation could appear, or a new SECURITY DEFINER path could be opened
// over an existing one, and this file would still exit 0.
//
// It is now three ratchets against scripts/schema/tenant-weld-manifest.json. None
// is an enumerated list of things to check — each is a property of the WHOLE
// schema, so a relation nobody thought about is caught by default:
//
//   R1  every weld in the manifest still exists        (no silent REMOVAL)
//   R2  the unwelded tenant-FK count never rises       (no silent GROWTH)
//   R3  no unreviewed SECURITY DEFINER function exists (no silent NEW TRAVERSAL)
//
// R3 closes the hole R1+R2 cannot. Shape alone proves nothing — 102 of the 106
// single-column tenant FKs have an attacker-writable child row and are harmless.
// What turns a shape into a defect is a SECURITY DEFINER path that traverses it
// WITHOUT constraining user_id, because that is what runs as the table owner and
// escapes RLS. A new DEFINER function is therefore the exact event that can make
// any remaining relation exploitable, and it cannot land without a human adding
// its name here.
//
// ⛔ Widening the manifest to clear a red is how this protection dies. Each
//    failure below prints what to do instead.

const manifest = JSON.parse(readFileSync(join(ROOT, 'scripts', 'schema', 'tenant-weld-manifest.json'), 'utf8'))

// ── R1: no weld may disappear ────────────────────────────────────────────────
const liveWelds = weldsAtRest
const lostWelds = (manifest.welds as string[]).filter(w => !liveWelds.has(w))
ok(`R1: all ${manifest.welds.length} canonical tenant welds are still present`,
  lostWelds.length === 0,
  lostWelds.length
    ? `MISSING: ${lostWelds.join(', ')}\n     A weld was DROPPED. Restore it — do not delete it from the manifest.`
    : '')
// Growth is the healthy direction, so it is reported rather than failed.
const newWelds = [...liveWelds].filter(w => !(manifest.welds as string[]).includes(w))
if (newWelds.length) {
  console.log(`  ℹ ${newWelds.length} weld(s) exist that the manifest does not list: ${newWelds.join(', ')}`)
  console.log('    Welcome. Add them to the manifest so they become protected too.')
}

// ── R2: the latent class may not grow ────────────────────────────────────────
const cls = await db.query(`
  with tenant_tables as (
    select c.oid, c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id' and a.attnum > 0
     where n.nspname = 'public' and c.relkind = 'r')
  select count(*)::int as n
    from pg_constraint con
    join tenant_tables ch on ch.oid = con.conrelid
    join tenant_tables pa on pa.oid = con.confrelid
   where con.contype = 'f' and array_length(con.conkey, 1) = 1 and ch.oid <> pa.oid`)
const unwelded = cls.rows[0].n as number
ok(`R2: unwelded single-column tenant FKs did not grow (${unwelded} <= ${manifest.unweldedMax})`,
  unwelded <= manifest.unweldedMax,
  `${unwelded - manifest.unweldedMax} NEW tenant->tenant relation(s) landed unwelded.`
  + `\n     Either weld the new one with a composite (user_id, id) FK, or — if a DEFINER`
  + `\n     path provably cannot traverse it without user_id — raise unweldedMax and say why.`)
if (unwelded < manifest.unweldedMax) {
  console.log(`  ℹ the class SHRANK to ${unwelded}. Lower unweldedMax to ${unwelded} to keep the ratchet tight.`)
}

// ── R3: no unreviewed SECURITY DEFINER path ──────────────────────────────────
const liveDefiners = ((await db.query(`
  select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef group by p.proname`)).rows as any[]).map(r => r.proname as string)
const unreviewed = liveDefiners.filter(d => !(manifest.securityDefiners as string[]).includes(d))
ok(`R3: every SECURITY DEFINER function is reviewed (${liveDefiners.length} live)`,
  unreviewed.length === 0,
  unreviewed.length
    ? `UNREVIEWED: ${unreviewed.join(', ')}`
      + `\n     A DEFINER function runs as the table owner and escapes RLS, so it is the one`
      + `\n     thing that can make an unwelded tenant relation exploitable. Read each body:`
      + `\n     does it traverse a tenant relation WITHOUT constraining user_id? Fix it if so,`
      + `\n     then add the name to the manifest to record that someone looked.`
    : '')
const goneDefiners = (manifest.securityDefiners as string[]).filter(d => !liveDefiners.includes(d))
if (goneDefiners.length) {
  console.log(`  ℹ ${goneDefiners.length} reviewed DEFINER function(s) no longer exist: ${goneDefiners.join(', ')}`)
  console.log('    Removing a DEFINER path is safe. Prune them from the manifest when convenient.')
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? '✅' : '❌'} verify:tenant-weld — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
