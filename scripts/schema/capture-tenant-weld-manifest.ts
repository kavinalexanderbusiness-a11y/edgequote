// ── Regenerate scripts/schema/tenant-weld-manifest.json ──────────────────────
//
//   npx tsx scripts/schema/capture-tenant-weld-manifest.ts
//
// Builds the schema from supabase/migrations/ in PGlite — the same apply path
// verify:tenant-weld uses — and records three things the guard then ratchets on:
//
//   welds            every composite (user_id, …) tenant foreign key
//   unweldedMax      how many single-column tenant→tenant FKs remain
//   securityDefiners every SECURITY DEFINER function in public
//
// ⛔ Run this when you have DELIBERATELY changed that surface, and say why in the
//    commit. Running it to clear a red is how the protection dies: the guard's
//    whole job is to notice exactly the drift this file would then bless.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { splitStatements, loadPGlite, substitutePlatformStatements } from '../lib/pg-sql'

const ROOT = join(__dirname, '..', '..')
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')
const OUT = join(ROOT, 'scripts', 'schema', 'tenant-weld-manifest.json')

async function main() {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
  const pglite = await loadPGlite()
  if (!pglite) { console.error('PGlite is not installed — npm i -D @electric-sql/pglite'); process.exit(1) }
  const { PGlite, contribs } = pglite
  const db = await PGlite.create({ extensions: Object.fromEntries(Object.entries(contribs).filter(([, v]) => v)) })
  for (const [label, raw] of [
    ['platform prelude', readFileSync(join(ROOT, 'scripts', 'schema', 'platform-prelude.sql'), 'utf8')] as const,
    ...files.map(f => [f, readFileSync(join(MIGRATIONS, f), 'utf8')] as const),
  ]) {
    const { sql } = substitutePlatformStatements(raw)
    for (const s of splitStatements(sql)) {
      try { await db.exec(s + ';') } catch (e: any) {
        console.error(`failed applying ${label}: ${String(e.message).slice(0, 200)}`); process.exit(1)
      }
    }
  }
  const welds = ((await db.query(`
    select con.conname from pg_constraint con
      join pg_class ch on ch.oid = con.conrelid
      join pg_namespace n on n.oid = ch.relnamespace
     where con.contype = 'f' and array_length(con.conkey, 1) = 2 and n.nspname = 'public'
       and exists (select 1 from pg_attribute a
                    where a.attrelid = ch.oid and a.attname = 'user_id' and a.attnum = any(con.conkey))
     order by 1`)).rows as any[]).map(r => r.conname as string)
  const definers = ((await db.query(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef group by p.proname order by 1`)).rows as any[]).map(r => r.proname as string)
  const cls = await db.query(`
    with tenant_tables as (
      select c.oid from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id' and a.attnum > 0
       where n.nspname = 'public' and c.relkind = 'r')
    select count(*)::int as n
      from pg_constraint con
      join tenant_tables ch on ch.oid = con.conrelid
      join tenant_tables pa on pa.oid = con.confrelid
     where con.contype = 'f' and array_length(con.conkey, 1) = 1 and ch.oid <> pa.oid`)
  const existing = JSON.parse(readFileSync(OUT, 'utf8'))
  writeFileSync(OUT, JSON.stringify({
    _readme: existing._readme,
    welds,
    unweldedMax: cls.rows[0].n as number,
    securityDefiners: definers,
  }, null, 2) + '\n')
  console.log(`captured ${welds.length} welds · unweldedMax ${cls.rows[0].n} · ${definers.length} SECURITY DEFINER functions`)
}
main().catch(err => { console.error(err); process.exit(1) })
