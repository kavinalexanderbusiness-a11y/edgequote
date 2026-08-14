// ── Baseline generator — `npm run schema:baseline` ───────────────────────────
//
// Reads the machine-readable production contract in supabase/contract/*.json and
// emits ONE ordered, runnable file: supabase/migrations/<version>_baseline.sql
//
// WHY THIS EXISTS. Until 2026-08-14 the repo could not rebuild production. The
// build path was "schema.sql (a 2026-06-25 snapshot) + 120 RUN-*.sql in filename
// order + CANONICAL-*.sql last", and every part of that was a trap: the snapshot
// silently produced a schema weeks behind, the RUN files were not a complete
// history, and "canonical last" meant a stale file could roll production BACKWARD
// with no error — on 2026-08-14 that file was missing the `change_orders` projection
// production had been serving for hours, so running it as documented would have
// deleted a customer-facing feature from the live portal.
//
// The baseline replaces all of it. It is generated FROM the live catalogue, so it
// cannot drift from production by construction, and it is a CONSOLIDATION, not a
// rewritten history: everything that ever ran is preserved under supabase/archive/
// for provenance and is never re-run.
//
// WHAT IT DOES NOT CONTAIN — and must never be claimed to:
//   · no rows. This rebuilds the SCHEMA. Customer data comes from a backup restore.
//   · nothing in auth.*, realtime.*, vault.* — the platform owns those.
//   · storage BUCKETS and their policies are here; the OBJECTS in them are not.
//
// Ordering is chosen so the file runs top-to-bottom on an empty database with no
// forward references: extensions → tables (columns only) → FUNCTIONS → constraints
// (PK/UNIQUE/CHECK first, then every FK once all tables exist) → triggers → indexes
// → RLS + policies → grants → comments → realtime → storage.
//
// Functions come BEFORE constraints because a CHECK constraint can call one, and
// Postgres resolves that when the constraint is added. Getting this wrong produced a
// baseline that applied fine to an existing database and failed from zero — which is
// precisely the failure a rebuild test exists to catch, and did.
//
// Regenerating: safe and idempotent. `npm run schema:contract` re-reads production
// into supabase/contract/, then this rewrites the baseline. Both are read-only
// against production.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const CONTRACT = join('supabase', 'contract')

// The baseline's version is DERIVED, never hand-set: it is one tick after the newest
// migration in the capture it was generated from.
//
// Why derived. The version must sort AFTER everything the baseline absorbed (or a
// rebuild replays history on top of itself) and BEFORE everything shipped later (or
// new migrations sort above it and never run). A hardcoded constant satisfies both
// only until the next migration lands — and during this work production took eleven
// more across four parallel sessions, twice within twenty seconds. A constant would
// have to be bumped by hand every time, and the one time it was not would be silent.
//
// Computed after the contract loads; see BASELINE_VERSION below.

const read = <T>(f: string): T => JSON.parse(readFileSync(join(CONTRACT, f), 'utf8'))

type Col = { name: string; type: string; notnull: boolean; default: string | null; generated: string; identity: string }
type Table = { relname: string; rls: boolean; force_rls: boolean; acl: string | null; cols: Col[] }
type Constraint = { tbl: string; conname: string; contype: string; def: string; convalidated: boolean }
type Index = { tbl: string; indexname: string; indexdef: string; backs_constraint: boolean }
type Policy = { schemaname: string; tablename: string; policyname: string; permissive: string; roles: string; cmd: string; qual: string | null; with_check: string | null }
type Trigger = { tbl: string; tgname: string; def: string; tgenabled: string }
type Fn = { proname: string; args: string; def: string; acl: string | null; owner: string }

const tables = read<Table[]>('tables.json')
const constraints = read<Constraint[]>('constraints.json')
const indexes = read<Index[]>('indexes.json')
const policies = read<Policy[]>('policies.json')
const triggers = read<Trigger[]>('triggers.json')
const functions = read<Fn[]>('functions.json')
const extObjects = read<{ ext: string; kind: string; name: string }[]>('extension-objects.json')
const misc = read<any>('misc.json')
const misc2 = read<any>('misc2.json')
const comments = read<any>('comments.json')

const latest = misc.latest_migration as string | undefined
if (!latest || !/^\d{14}$/.test(latest)) {
  console.error(`\n✗ REFUSING to generate: the capture has no usable latest_migration (${latest ?? 'absent'}).`)
  console.error('  Without it the baseline cannot be ordered against the history it contains.')
  console.error('  Re-capture with: npm run schema:contract\n')
  process.exit(1)
}

/**
 * One tick past the newest migration this capture contains.
 *
 * Plain Number, not BigInt: a 14-digit version maxes out at 1e14, comfortably inside
 * Number.MAX_SAFE_INTEGER (~9e15), so the arithmetic is exact — and BigInt literals
 * are not available at this repo's tsconfig target, which `next build` enforces even
 * though `tsc --noEmit` let it pass.
 */
const BASELINE_VERSION = String(Number(latest) + 1).padStart(14, '0')
const OUT = join('supabase', 'migrations', `${BASELINE_VERSION}_baseline.sql`)

// Belt and braces — the arithmetic above cannot fail, but the ordering invariant is
// load-bearing enough to assert rather than trust.
if (BASELINE_VERSION <= latest) {
  console.error(`\n✗ REFUSING to generate: baseline ${BASELINE_VERSION} does not sort after ${latest}.\n`)
  process.exit(1)
}

// Extension-owned functions belong to `create extension`, never to the baseline body.
const extensionFns = new Set(extObjects.filter(o => o.kind === 'function').map(o => o.name))
const appFunctions = functions.filter(f => !extensionFns.has(`${f.proname}(${f.args})`))

// ── ACL helpers ──────────────────────────────────────────────────────────────
// Postgres stores privileges as an aclitem array, e.g.
//   {postgres=arwdDxtm/postgres,anon=r/postgres,=X/postgres}
// An EMPTY role name is PUBLIC. Absence of a role is how a REVOKE is recorded, so
// the baseline must revoke-then-grant rather than grant-only: a fresh Supabase
// project hands anon/authenticated/service_role full privileges on new objects via
// ALTER DEFAULT PRIVILEGES, and grant-only would silently leave those in place.
// That is exactly the hole the crew-mode lockdown closed.
const PRIV: Record<string, string> = {
  a: 'INSERT', r: 'SELECT', w: 'UPDATE', d: 'DELETE', D: 'TRUNCATE',
  x: 'REFERENCES', t: 'TRIGGER', X: 'EXECUTE', U: 'USAGE', C: 'CREATE',
  c: 'CONNECT', T: 'TEMPORARY', m: 'MAINTAIN',
}
const TABLE_ALL = 'arwdDxtm'

/** Parse an aclitem[] rendering into [{ role, privs }], PUBLIC surfacing as 'public'. */
function parseAcl(acl: string | null): { role: string; privs: string }[] {
  if (!acl) return []
  return acl.replace(/^\{|\}$/g, '').split(',').filter(Boolean).map(item => {
    const [lhs] = item.split('/')
    const eq = lhs.indexOf('=')
    const role = lhs.slice(0, eq)
    return { role: role === '' ? 'public' : role, privs: lhs.slice(eq + 1) }
  })
}

const GRANTEES = ['public', 'anon', 'authenticated', 'service_role']

/** Render the privilege list, collapsing a complete set to ALL for readability. */
function privList(privs: string, all: string): string {
  const letters = [...new Set(privs.replace(/\*/g, '').split(''))]
  if (all === TABLE_ALL && letters.length === all.length && [...all].every(l => letters.includes(l))) return 'ALL'
  if (all === 'X' && letters.includes('X')) return 'EXECUTE'
  return letters.map(l => PRIV[l]).filter(Boolean).join(', ')
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`

const out: string[] = []
const S = (s = '') => out.push(s)
const section = (title: string, note?: string) => {
  S(); S('-- ' + '═'.repeat(74))
  S(`-- ${title}`)
  if (note) note.split('\n').forEach(l => S(`-- ${l}`))
  S('-- ' + '═'.repeat(74)); S()
}

// ── header ───────────────────────────────────────────────────────────────────
S(`-- ═══════════════════════════════════════════════════════════════════════════
-- EdgeQuote — SCHEMA BASELINE
--
-- Generated from the live production catalogue on 2026-08-13 by
-- scripts/schema/generate-baseline.ts. DO NOT EDIT BY HAND: regenerate instead
-- (npm run schema:contract && npm run schema:baseline), or the next regeneration
-- silently discards your edit.
--
-- This file is the ONE starting point for a database. Applying it to an empty
-- Postgres 17 database produces the production schema contract:
--   ${tables.length} tables · ${appFunctions.length} functions · ${triggers.length} triggers · ${policies.filter(p => p.schemaname === 'public').length} policies
--   ${constraints.filter(c => c.contype !== 't').length} constraints · ${indexes.filter(i => !i.backs_constraint).length} standalone indexes · ${misc.buckets.length} storage buckets
--
-- IT DOES NOT RESTORE DATA. Not one row. Rebuilding a working production system
-- is: this file, THEN a backup restore, THEN storage objects, THEN env config.
-- See docs/DISASTER_RECOVERY.md — do not improvise the order.
--
-- Migrations that ship after this file live beside it in supabase/migrations/ and
-- are applied in filename order. Everything that ran BEFORE it is history and
-- lives in supabase/archive/ — never re-run those; several are older copies of
-- objects this file defines, and re-running one rolls production backward.
-- ═══════════════════════════════════════════════════════════════════════════

-- The extensions schema must be on the search_path BEFORE the tables are created:
-- 73 column defaults call uuid_generate_v4() unqualified and resolve through it. Production
-- gets this from a role setting on postgres; stating it here is what makes the file
-- runnable anywhere, including as a different role.
set search_path to public, extensions;
set check_function_bodies = off;
`)

// ── extensions ───────────────────────────────────────────────────────────────
section('1 · EXTENSIONS',
  'Schema placement is load-bearing: pgcrypto/uuid-ossp live in `extensions`,\n' +
  'and gen_random_uuid() defaults resolve through it.')
S('create schema if not exists extensions;')
for (const e of misc.extensions) {
  if (e.name === 'plpgsql') continue
  if (e.name === 'supabase_vault') { S(`-- supabase_vault ${e.version} — platform-managed, not created here`); continue }
  S(`create extension if not exists ${q(e.name)} with schema ${e.schema};`)
}

// ── tables ───────────────────────────────────────────────────────────────────
section('2 · TABLES',
  'Columns only. Every constraint is added in section 3 so that foreign keys can\n' +
  'be declared after all tables exist, regardless of dependency order.')
for (const t of [...tables].sort((a, b) => a.relname.localeCompare(b.relname))) {
  const cols = t.cols.map(c => {
    let d = `  ${q(c.name)} ${c.type}`
    if (c.generated === 's') d += ` generated always as (${c.default}) stored`
    else if (c.identity) d += ` generated ${c.identity === 'a' ? 'always' : 'by default'} as identity`
    else if (c.default !== null) d += ` default ${c.default}`
    if (c.notnull && c.generated !== 's') d += ' not null'
    return d
  })
  S(`create table if not exists public.${q(t.relname)} (`)
  S(cols.join(',\n'))
  S(');')
}

// ── functions ────────────────────────────────────────────────────────────────
// BEFORE constraints, and that ordering is load-bearing. A CHECK constraint may
// CALL a function — production has `service_requests_photos_check` calling
// `portal_request_photos_ok(text[])` — and Postgres resolves that at ADD CONSTRAINT
// time, not lazily. Emitting constraints first made the baseline unappliable from
// zero with "function ... does not exist". The rebuild test caught it; nothing else
// would have, because against an ALREADY-BUILT database every order works.
section('3 · FUNCTIONS',
  `${appFunctions.length} application functions, verbatim from pg_get_functiondef.\n` +
  'Emitted BEFORE constraints: a CHECK constraint can call one, and the dependency\n' +
  'is resolved when the constraint is added.\n' +
  'SECURITY DEFINER + `set search_path` is not decoration here: these functions are\n' +
  'the ONLY door a crew session or a portal token has to the data. Section 8 revokes\n' +
  'and re-grants EXECUTE explicitly — a function is not safe merely by being defined.')
for (const f of [...appFunctions].sort((a, b) => a.proname.localeCompare(b.proname) || a.args.localeCompare(b.args))) {
  S(f.def.trimEnd().endsWith(';') ? f.def.trimEnd() : f.def.trimEnd() + ';')
  S()
}

// ── constraints ──────────────────────────────────────────────────────────────
// contype 't' is a CONSTRAINT TRIGGER: it is emitted in section 5 from
// pg_get_triggerdef, never here (pg_get_constraintdef renders it as "TRIGGER").
const CONSTRAINT_ORDER = ['p', 'u', 'c', 'f']
section('4 · CONSTRAINTS',
  'Primary keys, then unique, then check, then EVERY foreign key last.\n' +
  'Composite (user_id, id) foreign keys are deliberate — they are what stops one\n' +
  'tenant attaching a child row to another tenant\'s parent. Do not "simplify".')
for (const type of CONSTRAINT_ORDER) {
  const group = constraints.filter(c => c.contype === type).sort((a, b) => a.tbl.localeCompare(b.tbl) || a.conname.localeCompare(b.conname))
  if (!group.length) continue
  S(`-- ${{ p: 'primary keys', u: 'unique', c: 'check', f: 'foreign keys' }[type]} (${group.length})`)
  for (const c of group) {
    S(`alter table public.${q(c.tbl)} add constraint ${q(c.conname)} ${c.def}${c.convalidated ? '' : ' not valid'};`)
  }
  S()
}

// ── triggers ─────────────────────────────────────────────────────────────────
section('5 · TRIGGERS', `${triggers.length} triggers, including the two DEFERRABLE constraint triggers that\nenforce quote-option/quote-service shape at commit time.`)
for (const t of triggers) {
  S(`drop trigger if exists ${q(t.tgname)} on public.${q(t.tbl)};`)
  S(`${t.def};`)
  if (t.tgenabled !== 'O') S(`alter table public.${q(t.tbl)} disable trigger ${q(t.tgname)};`)
}

// ── indexes ──────────────────────────────────────────────────────────────────
const standalone = indexes.filter(i => !i.backs_constraint).sort((a, b) => a.tbl.localeCompare(b.tbl) || a.indexname.localeCompare(b.indexname))
section('6 · INDEXES',
  `${standalone.length} standalone indexes. Constraint-backing indexes are omitted on purpose —\n` +
  'section 4 already created them; declaring both would fail or duplicate.\n' +
  'The partial UNIQUE indexes are correctness, not speed: they are what stops a\n' +
  'second open shift per technician and a duplicate invoice number.')
for (const i of standalone) S(`${i.indexdef.replace(/^CREATE (UNIQUE )?INDEX /, (m, u) => `create ${u ? 'unique ' : ''}index if not exists `)};`)

// ── RLS + policies ───────────────────────────────────────────────────────────
const publicPolicies = policies.filter(p => p.schemaname === 'public')
section('7 · ROW LEVEL SECURITY',
  `RLS enabled on all ${tables.filter(t => t.rls).length} tables, then ${publicPolicies.length} policies.\n` +
  'Every table carries RLS. The tenant boundary audit found the holes were always\n' +
  'RLS being OFF, never a policy being wrong — so enabling is emitted for every\n' +
  'table unconditionally, before any policy.')
for (const t of [...tables].sort((a, b) => a.relname.localeCompare(b.relname))) {
  if (t.rls) S(`alter table public.${q(t.relname)} enable row level security;`)
  if (t.force_rls) S(`alter table public.${q(t.relname)} force row level security;`)
}
S()
for (const p of publicPolicies) {
  const roles = p.roles.replace(/^\{|\}$/g, '').split(',').filter(Boolean).join(', ')
  let s = `create policy ${q(p.policyname)} on public.${q(p.tablename)}`
  s += ` as ${p.permissive.toLowerCase()}`
  s += ` for ${p.cmd.toLowerCase()}`
  s += ` to ${roles}`
  if (p.qual !== null) s += `\n  using (${p.qual})`
  if (p.with_check !== null) s += `\n  with check (${p.with_check})`
  S(`drop policy if exists ${q(p.policyname)} on public.${q(p.tablename)};`)
  S(s + ';')
}

// ── grants ───────────────────────────────────────────────────────────────────
section('8 · GRANTS',
  'REVOKE-then-GRANT, per object, always. A fresh Supabase project grants\n' +
  'anon/authenticated/service_role everything on new objects through ALTER DEFAULT\n' +
  'PRIVILEGES, so a grant-only baseline would quietly reproduce none of the\n' +
  'lockdowns: crew tables that must be RPC-only, and the ~33 functions whose EXECUTE\n' +
  'is revoked from every client role.')

S('-- platform default privileges (already true on a fresh Supabase project; a no-op there,')
S('-- and required on any other Postgres target so future objects inherit the same shape)')
for (const d of misc2.default_acls ?? []) {
  if (d.role !== 'postgres' || d.schema !== 'public') continue
  const kind = { r: 'tables', S: 'sequences', f: 'functions' }[d.objtype as string]
  if (!kind) continue
  for (const { role, privs } of parseAcl(d.acl)) {
    if (role === 'postgres') continue
    const all = d.objtype === 'r' ? TABLE_ALL : d.objtype === 'f' ? 'X' : 'rwU'
    S(`alter default privileges for role postgres in schema public grant ${privList(privs, all)} on ${kind} to ${role};`)
  }
}

S()
S('-- tables')
for (const t of [...tables].sort((a, b) => a.relname.localeCompare(b.relname))) {
  S(`revoke all on table public.${q(t.relname)} from ${GRANTEES.join(', ')};`)
  for (const { role, privs } of parseAcl(t.acl)) {
    if (role === 'postgres' || !GRANTEES.includes(role)) continue
    const p = privList(privs, TABLE_ALL)
    if (p) S(`grant ${p} on table public.${q(t.relname)} to ${role};`)
  }
}

const colAcls = misc2.column_acls ?? []
if (colAcls.length) {
  S()
  S('-- column-level grants (narrower than the table grant on purpose)')
  for (const c of colAcls) {
    for (const { role, privs } of parseAcl(c.acl)) {
      if (role === 'postgres' || !GRANTEES.includes(role)) continue
      const p = privList(privs, TABLE_ALL)
      if (p) S(`grant ${p} (${q(c.col)}) on table public.${q(c.tbl)} to ${role};`)
    }
  }
}

S()
S('-- sequences')
for (const s of misc.seq_acls ?? []) {
  S(`revoke all on sequence public.${q(s.name)} from ${GRANTEES.join(', ')};`)
  for (const { role, privs } of parseAcl(s.acl)) {
    if (role === 'postgres' || !GRANTEES.includes(role)) continue
    const p = privList(privs, 'rwU')
    if (p) S(`grant ${p} on sequence public.${q(s.name)} to ${role};`)
  }
}

S()
S('-- functions — the security-critical half of this section')
for (const f of [...appFunctions].sort((a, b) => a.proname.localeCompare(b.proname) || a.args.localeCompare(b.args))) {
  const sig = `public.${q(f.proname)}(${f.args})`
  S(`revoke all on function ${sig} from ${GRANTEES.join(', ')};`)
  for (const { role, privs } of parseAcl(f.acl)) {
    if (role === 'postgres' || !GRANTEES.includes(role)) continue
    if (privs.includes('X')) S(`grant execute on function ${sig} to ${role};`)
  }
}

// ── comments ─────────────────────────────────────────────────────────────────
section('9 · COMMENTS',
  'These are not documentation garnish. Several encode rules that cost real money\n' +
  'to relearn — which columns are customer-visible, which must never be, and why a\n' +
  'figure is derived rather than stored. They ship with the schema deliberately.')
for (const c of comments.table_comments ?? []) S(`comment on table public.${q(c.tbl)} is ${lit(c.comment)};`)
S()
for (const c of comments.column_comments ?? []) S(`comment on column public.${q(c.tbl)}.${q(c.col)} is ${lit(c.comment)};`)
S()
for (const c of comments.fn_comments ?? []) S(`comment on function public.${q(c.fn)}(${c.args}) is ${lit(c.comment)};`)

// ── realtime ─────────────────────────────────────────────────────────────────
const pubTables = (misc.publication_tables ?? []).filter((t: string) => t.startsWith('public.'))
section('10 · REALTIME',
  `${pubTables.length} tables published to supabase_realtime, and the ${(misc2.replica_identity ?? []).length} tables set to\n` +
  'REPLICA IDENTITY FULL so an UPDATE payload carries the old row.')
S(`do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;`)
S()
for (const t of pubTables) {
  const name = t.replace(/^public\./, '')
  S(`do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=${lit(name)}) then
    alter publication supabase_realtime add table public.${q(name)};
  end if;
end $$;`)
}
S()
for (const r of misc2.replica_identity ?? []) {
  if (r.ident === 'f') S(`alter table public.${q(r.tbl)} replica identity full;`)
}

// ── storage ──────────────────────────────────────────────────────────────────
const storagePolicies = policies.filter(p => p.schemaname === 'storage')
section('11 · STORAGE',
  `${misc.buckets.length} buckets and ${storagePolicies.length} storage policies.\n` +
  'public=false is a security decision, not a default: crew-media is private because\n' +
  'job-photos being public is what made a private bucket necessary in the first place.\n' +
  'Buckets are created empty — the FILES in them are a separate restore.')
for (const b of misc.buckets) {
  S(`insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types, avif_autodetection)`)
  S(`values (${lit(b.id)}, ${lit(b.name)}, ${b.public}, ${b.file_size_limit ?? 'null'}, ${b.allowed_mime_types ? `array[${b.allowed_mime_types.map(lit).join(', ')}]::text[]` : 'null'}, ${b.avif_autodetection})`)
  S(`on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;`)
}
S()
for (const p of storagePolicies) {
  const roles = p.roles.replace(/^\{|\}$/g, '').split(',').filter(Boolean).join(', ')
  let s = `create policy ${q(p.policyname)} on storage.${q(p.tablename)}`
  s += ` as ${p.permissive.toLowerCase()} for ${p.cmd.toLowerCase()} to ${roles}`
  if (p.qual !== null) s += `\n  using (${p.qual})`
  if (p.with_check !== null) s += `\n  with check (${p.with_check})`
  S(`drop policy if exists ${q(p.policyname)} on storage.${q(p.tablename)};`)
  S(s + ';')
}

S()
S('-- ── end of baseline ─────────────────────────────────────────────────────────')

mkdirSync(join('supabase', 'migrations'), { recursive: true })
// Exactly one baseline may exist. The version moves with each capture, so a stale
// one left behind would be applied first and then contradicted by the new one.
for (const f of readdirSync(join('supabase', 'migrations'))) {
  if (/_baseline\.sql$/.test(f) && f !== `${BASELINE_VERSION}_baseline.sql`) {
    rmSync(join('supabase', 'migrations', f))
    console.log(`  removed superseded ${f}`)
  }
}
writeFileSync(OUT, out.join('\n').replace(/\n{4,}/g, '\n\n\n') + '\n')

const bytes = readFileSync(OUT).length
console.log(`wrote ${OUT}`)
console.log(`  ${tables.length} tables · ${constraints.filter(c => c.contype !== 't').length} constraints · ${appFunctions.length} functions · ${triggers.length} triggers`)
console.log(`  ${standalone.length} indexes · ${publicPolicies.length} policies · ${misc.buckets.length} buckets · ${storagePolicies.length} storage policies`)
console.log(`  ${(bytes / 1024).toFixed(0)} KB`)
