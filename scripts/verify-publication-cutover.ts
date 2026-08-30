// ── Prove the publication cutover FROM ZERO, in memory ───────────────────────
//   npm run verify:publication-cutover
//
// ⭐ Registered as a GUARD, not left as a one-off script, because a proof that
// only runs when somebody remembers to run it is the dead safety the verify-all
// parity contract exists to prevent. It SKIPS clean when PGlite is absent, the
// same way verify:rebuild does, so CI is unaffected.
//
// ⭐⭐ WHY THIS EXISTS. The four-way behaviour the cutover depends on —
// PUBLISHED appears / INTERNAL does not / INACTIVE does not / FIXTURE does not —
// cannot be proven against production, because `published_at` does not exist
// there yet and the schema-bearing landing is deliberately unapplied until S106
// owns the cutover. Proving it by reading the SQL would be asserting that a
// migration does what its own comments say.
//
// So it is proven the only honest way available: build the schema FROM ZERO on
// PGlite (WASM Postgres, in-process), apply every migration in the real apply
// order including 20260830130000, seed four services covering the four states,
// and call `public_services()` — the actual anonymous door — to see which ones
// come back.
//
// ⛔ NOTHING TOUCHES PRODUCTION. No network, no Supabase, no credentials. This is
// step 5 of the cutover plan ("prove migration from zero") executed rather than
// promised.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { splitStatements, loadPGlite, substitutePlatformStatements } from './lib/pg-sql'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)

const MIGRATIONS = join('supabase', 'migrations')

// ⚠️ Wrapped in main() for the same reason verify-rebuild.ts is: esbuild refuses
// top-level await when it emits CJS, and this file must run under plain `tsx`.
async function main() {

  const pglite = await loadPGlite()
  if (!pglite) {
    console.log('\n… SKIPPED — PGlite is not installed (npm i -D @electric-sql/pglite)\n')
    process.exit(0)
  }
  // ⭐ The SAME bootstrap verify:rebuild uses. Supabase supplies auth/extensions/
  // roles that no migration creates, so a build without the prelude produces a
  // schema in which every migration “succeeds” and nothing exists.
  const { PGlite, contribs } = pglite
  const db = await PGlite.create({ extensions: Object.fromEntries(Object.entries(contribs).filter(([, v]) => v)) })
  const PRELUDE = join('scripts', 'schema', 'platform-prelude.sql')
  for (const st of splitStatements(substitutePlatformStatements(readFileSync(PRELUDE, 'utf8')).sql)) await db.exec(st + ';')

  console.log('\n═══ Building the schema FROM ZERO, in memory ═══')
  const files = existsSync(MIGRATIONS) ? readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort() : []
  check('the apply path carries migrations', files.length > 0)
  check('⭐ the publication migration is IN the apply order, not beside it',
    files.some(f => f.includes('service_publication')),
    `apply order: ${files.join(', ')}`)

  let applied = 0
  for (const f of files) {
    const { sql } = substitutePlatformStatements(readFileSync(join(MIGRATIONS, f), 'utf8'))
    try {
      for (const s of splitStatements(sql)) await db.exec(s + ';')
      applied++
    } catch (e) {
      fail(`applying ${f}`, String((e as Error)?.message ?? e))
      break
    }
  }
  check(`every migration applied from zero (${applied}/${files.length})`, applied === files.length)
  if (applied !== files.length) {
    console.log('\n❌ cannot prove the cutover on a partial build\n')
    process.exit(1)
  }

  // ── The column, exactly as the model requires ───────────────────────────────
  console.log('\n═══ The column ═══')
  const col = await (db.query as (q: string) => Promise<{ rows: any[] }>)(
    `select is_nullable, column_default, data_type from information_schema.columns
      where table_schema='public' and table_name='service_templates' and column_name='published_at'`)
  check('published_at exists on service_templates', col.rows.length === 1)
  check('⛔ it is NULLABLE with NO default — NULL *is* the internal state',
    col.rows[0]?.is_nullable === 'YES' && col.rows[0]?.column_default === null,
    `nullable=${col.rows[0]?.is_nullable} default=${col.rows[0]?.column_default}`)

  // ── Seed the four states ────────────────────────────────────────────────────
  console.log('\n═══ Four services, four states, one anonymous door ═══')
  const OWNER = '00000000-0000-0000-0000-0000000000aa'
  await db.exec(`insert into auth.users (id, email) values ('${OWNER}', 'owner@example.test')`)
  await db.exec(`
    insert into public.business_settings (user_id, company_name, booking_token, booking_enabled)
    values ('${OWNER}', 'Proof Co', 'proof-token', true)`)

  // ⭐ Written the way the APPLICATION writes them: the builder cannot set
  // published_at (lib/quoteAddons' sibling rule — addonRowsFor's equivalent here is
  // that publishing is its own explicit act), so PUBLISHED is a second statement.
  await db.exec(`
    insert into public.service_templates (user_id, name, category, default_rate, is_active, sort_order) values
      ('${OWNER}', 'Published Service',  'General', 120, true,  0),
      ('${OWNER}', 'Internal Service',   'General', 130, true,  1),
      ('${OWNER}', 'Inactive Service',   'General', 140, false, 2),
      ('${OWNER}', 'ZZ-FIXTURE Service', 'General',   1, true,  3)`)

  const before = await (db.query as (q: string) => Promise<{ rows: any[] }>)(`select public.public_services('proof-token') as services`)
  const beforeNames = (((before.rows[0]?.services as { services?: Array<{ name: string }> })?.services) ?? []).map(s => s.name)
  // ⭐⭐ THE SAFE DEFAULT, demonstrated rather than described: immediately after the
  // migration, with four active-ish services present, the public door returns NONE.
  check('⭐⭐ immediately after the migration the public catalogue is EMPTY',
    beforeNames.length === 0,
    `returned: ${beforeNames.join(', ')} — the default must be closed, or the cutover republishes fixtures`)

  // ── The cutover: publish ONLY an explicit id ────────────────────────────────
  // ⛔ BY ID. Never `set published_at = now() where is_active` — that statement is
  // what would put the fixture row back on the public website.
  const target = await (db.query as (q: string) => Promise<{ rows: any[] }>)(
    `select id from public.service_templates where user_id='${OWNER}' and name='Published Service'`)
  await db.exec(`update public.service_templates set published_at = now() where id = '${target.rows[0].id}'`)

  const after = await (db.query as (q: string) => Promise<{ rows: any[] }>)(`select public.public_services('proof-token') as services`)
  const names = (((after.rows[0]?.services as { services?: Array<{ name: string }> })?.services) ?? []).map(s => s.name)

  check('⭐ PUBLISHED service APPEARS on the public catalogue', names.includes('Published Service'))
  check('⛔ INTERNAL service does NOT appear', !names.includes('Internal Service'))
  check('⛔ INACTIVE service does NOT appear', !names.includes('Inactive Service'))
  check('⛔ Tier-1 FIXTURE service does NOT appear', !names.includes('ZZ-FIXTURE Service'))
  check('…and the catalogue is EXACTLY the published set, nothing more',
    names.length === 1 && names[0] === 'Published Service', `returned: ${names.join(', ')}`)

  // ── Publishing then deactivating must remove it ─────────────────────────────
  await db.exec(`update public.service_templates set is_active = false where id = '${target.rows[0].id}'`)
  const off = await (db.query as (q: string) => Promise<{ rows: any[] }>)(`select public.public_services('proof-token') as services`)
  const offNames = (((off.rows[0]?.services as { services?: Array<{ name: string }> })?.services) ?? []).map(s => s.name)
  check('⭐ a PUBLISHED service that is then switched OFF leaves the catalogue',
    !offNames.includes('Published Service'),
    'is_active must win over published_at, or unpublishing would take two taps and one would be forgotten')
  await db.exec(`update public.service_templates set is_active = true where id = '${target.rows[0].id}'`)

  // ── The PORTAL door, same question ──────────────────────────────────────────
  console.log('\n═══ The portal door answers the same way ═══')
  const portalSrc = await (db.query as (q: string) => Promise<{ rows: any[] }>)(
    `select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='get_portal_data'`)
  const def = portalSrc.rows[0]?.def ?? ''
  check('get_portal_data filters its services on published_at',
    /is_active and published_at is not null/.test(def))
  // ⛔ The clauses this transform had to preserve, checked on the REBUILT function
  // rather than on the migration text that claims to preserve them.
  check('⛔ …and the transform kept the draft-privacy predicate', /status <> 'draft'/.test(def))
  check('⛔ …kept the change_orders projection', /change_orders/.test(def))
  check('⛔ …kept the quote add-ons projection', /addons/.test(def))

  // ── The universal-product half ──────────────────────────────────────────────
  console.log('\n═══ book_service no longer stamps a trade on a stranger’s quote ═══')
  const bookSrc = await (db.query as (q: string) => Promise<{ rows: any[] }>)(
    `select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='book_service'`)
  const bdef = bookSrc.rows[0]?.def ?? ''
  check('⛔ the hardcoded trade fallback is gone', !/Lawn Mowing/.test(bdef))
  check('⭐ the fallback resolves from the owner’s own PUBLISHED catalogue', /v_fallback_service/.test(bdef))
  check('…and the rate limiter and ADR-002 provenance survived the transform',
    /rate_limited/.test(bdef) && /template_rate/.test(bdef))

  // Prove it end to end: a booking with no service named must NOT say "Lawn Mowing".
  await db.exec(`update public.service_templates set published_at = now()
                  where user_id='${OWNER}' and name='Published Service'`)
  const booked = await (db.query as (q: string) => Promise<{ rows: any[] }>)(
    `select public.book_service('proof-token', '{"name":"A Stranger","email":"s@example.test","address":"1 Way"}'::jsonb) as r`)
  const q = await (db.query as (q: string) => Promise<{ rows: any[] }>)(
    `select service_type from public.quotes where user_id='${OWNER}' order by created_at desc limit 1`)
  check('⭐⭐ an un-named booking is labelled from CONFIGURATION, not a hardcoded trade',
    q.rows[0]?.service_type === 'Published Service',
    `got "${q.rows[0]?.service_type}" — expected the owner's own published service name`)
  void booked

  console.log('\n── Summary ────────────────────────────────────────────────────')
  console.log(failures === 0
    ? '\n✅ cutover proven from zero: the default is closed, publishing by id opens exactly one door, and nothing else reaches a customer\n'
    : `\n❌ ${failures} check(s) failed\n`)
  // ⚠️⚠️ reallyExit, not exit. Node 24 on Windows aborts the runtime
  // (“UV_HANDLE_CLOSING”, exit 127) when it tears down with a PGlite WASM async
  // handle still open — AFTER the summary prints. A passing run therefore
  // reported a crash, which is the confident-lie shape: the output says green
  // and the shell says 127. reallyExit ends the process without running the
  // teardown that aborts, so the exit code is the RESULT again.
  // (scripts/lib/shutdown.ts documents the undici variant of the same class.)
  await db.close().catch(() => {})
  await new Promise(r => setTimeout(r, 150))
  process.exit(failures === 0 ? 0 : 1)

}

main().catch(err => { console.error(err); process.exit(1) })
