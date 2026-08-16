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

// ═══════════════════════════════════════════════════════════════════════════
H('3. THE CLASS — welds that still need doing, counted so it cannot be forgotten')

// Every single-column FK between two tenant-owned tables is the same latent shape.
// This does not fail the build; it reports, so the number cannot quietly grow.
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
console.log(`  ℹ ${cls.rows[0].n} single-column tenant→tenant foreign keys remain unwelded.`)
console.log('    Not a failure: only the three with a demonstrated exploit path were in scope.')
console.log('    They are the same latent shape and are recorded in the readiness report.')

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? '✅' : '❌'} verify:tenant-weld — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
