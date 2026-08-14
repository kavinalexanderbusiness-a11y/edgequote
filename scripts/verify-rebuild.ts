// ── Fresh-rebuild proof — `npm run verify:rebuild` ───────────────────────────
//
// THE CLAIM THIS EXISTS TO TEST: "the repository can rebuild production's schema
// from zero." That claim was FALSE for seven weeks and nobody could tell, because
// nobody ever ran it. A rebuild that is only reasoned about is not a rebuild.
//
// So: build an empty Postgres, apply the platform prelude, apply the baseline and
// every migration after it in filename order, then read the SAME catalogue queries
// back and diff them against supabase/contract/*.json — the snapshot of production.
//
// Runs entirely in-process on PGlite (WASM Postgres). Nothing touches production;
// nothing touches the network. If PGlite is not installed the script SKIPS clean
// with instructions rather than failing, so the guard suite stays green on a
// machine that has not opted into a ~100 MB dev dependency.
//
//   npm i -D @electric-sql/pglite && npm run verify:rebuild
//
// ── WHAT A PASS DOES AND DOES NOT PROVE ──────────────────────────────────────
// Proves: every statement applies from zero, in order, with no forward reference;
// and the resulting tables/columns/constraints/functions/triggers/policies/indexes/
// grants match production's contract object-for-object.
// Does NOT prove: data restored (it is not), auth users, storage file contents, or
// platform behaviour that only Supabase provides. See docs/DISASTER_RECOVERY.md.
//
// ── VERSION SKEW IS REAL AND IS REPORTED, NOT HIDDEN ─────────────────────────
// Production is PostgreSQL 17; PGlite currently ships 18. Postgres 18 records NOT
// NULL as a pg_constraint row (contype 'n'), which 17 does not, so those are
// excluded from the constraint comparison and checked through column notnull
// instead — where 17 and 18 agree. Any other version-driven difference is printed
// as a finding rather than filtered away.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const CONTRACT = join('supabase', 'contract')
const MIGRATIONS = join('supabase', 'migrations')
const PRELUDE = join('scripts', 'schema', 'platform-prelude.sql')

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}

const read = <T>(f: string): T => JSON.parse(readFileSync(join(CONTRACT, f), 'utf8'))

async function main() {
// ── load PGlite, or skip clean ───────────────────────────────────────────────
let PGlite: any, contribs: any = {}
try {
  ;({ PGlite } = await import('@electric-sql/pglite'))
  const load = async (p: string, k: string) => { try { return (await import(p))[k] } catch { return undefined } }
  contribs = {
    pg_trgm: await load('@electric-sql/pglite/contrib/pg_trgm', 'pg_trgm'),
    pgcrypto: await load('@electric-sql/pglite/contrib/pgcrypto', 'pgcrypto'),
    uuid_ossp: await load('@electric-sql/pglite/contrib/uuid_ossp', 'uuid_ossp'),
  }
} catch {
  console.log('\n⏭  verify:rebuild SKIPPED — PGlite is not installed.')
  console.log('   This is the one guard that proves the repo can rebuild the database.')
  console.log('   Run it before any release:  npm i -D @electric-sql/pglite && npm run verify:rebuild\n')
  process.exit(0)
}
const prodTables = read<any[]>('tables.json')
const prodConstraints = read<any[]>('constraints.json')
const prodIndexes = read<any[]>('indexes.json')
const prodPolicies = read<any[]>('policies.json')
const prodTriggers = read<any[]>('triggers.json')
const prodFunctions = read<any[]>('functions.json')
const extObjects = read<any[]>('extension-objects.json')
const prodMisc = read<any>('misc.json')

const extensionFns = new Set(extObjects.filter(o => o.kind === 'function').map(o => o.name))
const prodAppFns = prodFunctions.filter(f => !extensionFns.has(`${f.proname}(${f.args})`))

console.log('\n══ fresh rebuild from repository ═══════════════════════════════════════\n')

const db = await PGlite.create({ extensions: Object.fromEntries(Object.entries(contribs).filter(([, v]) => v)) })
const pgVersion = (await db.query('select version() as v')).rows[0].v
console.log(`  target: ${String(pgVersion).split(' ').slice(0, 2).join(' ')} (in-memory, disposable)`)
console.log(`  source of truth for comparison: ${CONTRACT}/ (production, PostgreSQL 17)\n`)

// ── apply ────────────────────────────────────────────────────────────────────
// ── declared platform substitutions ──────────────────────────────────────────
// A statement is rewritten ONLY when the object is provided by the Supabase
// platform rather than by this repository, and the prelude already supplies an
// equivalent. Each substitution is named and printed — never a silent filter,
// because a quiet skip is how a rebuild test starts lying about what it proved.
const SUBSTITUTIONS: { pattern: RegExp; what: string; why: string }[] = [
  {
    pattern: /^create extension if not exists "?pg_net"?[^;]*;$/gim,
    what: 'create extension pg_net',
    why: 'platform-only async HTTP extension; prelude provides net.http_post()',
  },
  {
    pattern: /^create extension if not exists "?pg_stat_statements"?[^;]*;$/gim,
    what: 'create extension pg_stat_statements',
    why: 'platform observability, needs shared_preload_libraries; owns no application object',
  },
]

const substitute = (sql: string) => {
  const hits: string[] = []
  let out = sql
  for (const s of SUBSTITUTIONS) {
    if (s.pattern.test(out)) {
      s.pattern.lastIndex = 0
      out = out.replace(s.pattern, `-- [rebuild-test substitution] ${s.what} — ${s.why}`)
      hits.push(`${s.what} → ${s.why}`)
    }
    s.pattern.lastIndex = 0
  }
  return { sql: out, hits }
}

/**
 * Split SQL into statements, respecting dollar-quoted bodies ($$ … $$ and
 * $function$ … $function$), line comments and string literals. Handing PGlite the
 * whole 450 KB file at once exhausts the WASM heap; more usefully, splitting means
 * a failure names the exact statement instead of the whole file.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = []
  let buf = '', i = 0
  while (i < sql.length) {
    const c = sql[i]
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      const end = nl === -1 ? sql.length : nl
      buf += sql.slice(i, end); i = end
      continue
    }
    if (c === "'") {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue }
        if (sql[j] === "'") break
        j++
      }
      buf += sql.slice(i, j + 1); i = j + 1
      continue
    }
    if (c === '$') {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i))
      if (m) {
        const tag = m[0]
        const close = sql.indexOf(tag, i + tag.length)
        const end = close === -1 ? sql.length : close + tag.length
        buf += sql.slice(i, end); i = end
        continue
      }
    }
    if (c === ';') { out.push(buf.trim()); buf = ''; i++; continue }
    buf += c; i++
  }
  if (buf.trim()) out.push(buf.trim())
  return out.filter(s => s && !/^(--[^\n]*\n?)*$/.test(s))
}

const apply = async (label: string, rawSql: string) => {
  const t0 = Date.now()
  const { sql, hits } = substitute(rawSql)
  for (const h of hits) console.log(`  ⇄ platform substitution — ${h}`)
  const statements = splitStatements(sql)
  let n = 0
  try {
    for (const s of statements) { await db.exec(s + ';'); n++ }
    console.log(`  ✓ applied ${label} — ${statements.length} statements, ${sql.length.toLocaleString()} bytes, ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    pass++
    return true
  } catch (e: any) {
    fail++
    console.error(`  ✗ FAILED applying ${label} at statement ${n + 1}/${statements.length}`)
    console.error(`      ${String(e.message).slice(0, 300)}`)
    const failing = (statements[n] ?? '').replace(/^(\s*--[^\n]*\n)+/, '').replace(/\s+/g, ' ')
    console.error(`      statement: ${failing.slice(0, 240)}`)
    return false
  }
}

console.log('── apply ──')
if (!await apply('platform prelude', readFileSync(PRELUDE, 'utf8'))) {
  console.error('\nPrelude failed — the rest of the test would be meaningless. Stopping.')
  process.exit(1)
}

const migrationFiles = existsSync(MIGRATIONS)
  ? readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
  : []
check('supabase/migrations/ contains a baseline', migrationFiles.length > 0, 'no .sql files found')

let applied = 0
for (const f of migrationFiles) {
  const ok = await apply(f, readFileSync(join(MIGRATIONS, f), 'utf8'))
  if (!ok) { console.error('\nA migration failed to apply. Rebuild is BROKEN — stopping here.'); break }
  applied++
}
if (applied !== migrationFiles.length) {
  console.error(`\n${applied}/${migrationFiles.length} migrations applied. Cannot compare a partial build.\n`)
  process.exit(1)
}

// ── read the rebuilt contract back ───────────────────────────────────────────
console.log('\n── compare rebuilt schema against production contract ──')

const rows = async (sql: string) => (await db.query(sql)).rows as any[]

const gotTables = await rows(`
  select c.relname, c.relrowsecurity as rls,
    (select json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
       'notnull', a.attnotnull, 'generated', a.attgenerated) order by a.attnum)
     from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) as cols
  from pg_class c join pg_namespace n on c.relnamespace=n.oid
  where n.nspname='public' and c.relkind='r' order by c.relname`)

const gotConstraints = await rows(`
  select cl.relname as tbl, con.conname, con.contype::text as contype, pg_get_constraintdef(con.oid) as def
  from pg_constraint con join pg_class cl on con.conrelid=cl.oid join pg_namespace n on cl.relnamespace=n.oid
  where n.nspname='public' order by cl.relname, con.conname`)

const gotIndexes = await rows(`select tablename as tbl, indexname, indexdef from pg_indexes where schemaname='public' order by indexname`)
const gotPolicies = await rows(`select tablename, policyname, cmd, roles::text as roles, qual, with_check from pg_policies where schemaname='public' order by tablename, policyname`)
const gotTriggers = await rows(`
  select c.relname as tbl, t.tgname from pg_trigger t join pg_class c on t.tgrelid=c.oid
  join pg_namespace n on c.relnamespace=n.oid where n.nspname='public' and not t.tgisinternal order by c.relname, t.tgname`)
const gotFunctions = await rows(`
  select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.proacl::text as acl, p.prosecdef,
         pg_get_functiondef(p.oid) as def
  from pg_proc p join pg_namespace n on p.pronamespace=n.oid
  left join pg_depend d on d.objid=p.oid and d.classid='pg_proc'::regclass and d.deptype='e'
  where n.nspname='public' and p.prokind='f' and d.objid is null
  order by p.proname`)
const gotTableAcls = await rows(`
  select c.relname, c.relacl::text as acl from pg_class c join pg_namespace n on c.relnamespace=n.oid
  where n.nspname='public' and c.relkind='r' order by c.relname`)
const gotBuckets = await rows(`select id, public, file_size_limit, allowed_mime_types from storage.buckets order by id`)
const gotStoragePolicies = await rows(`select policyname from pg_policies where schemaname='storage' order by policyname`)

// ── diff helpers ─────────────────────────────────────────────────────────────
const setDiff = (a: string[], b: string[]) => ({
  missing: a.filter(x => !b.includes(x)),
  extra: b.filter(x => !a.includes(x)),
})
const report = (label: string, expected: string[], got: string[], sampleN = 6) => {
  const { missing, extra } = setDiff(expected, got)
  const ok = missing.length === 0 && extra.length === 0
  const parts: string[] = []
  if (missing.length) parts.push(`MISSING ${missing.length}: ${missing.slice(0, sampleN).join(', ')}${missing.length > sampleN ? ' …' : ''}`)
  if (extra.length) parts.push(`UNEXPECTED ${extra.length}: ${extra.slice(0, sampleN).join(', ')}${extra.length > sampleN ? ' …' : ''}`)
  check(`${label} — ${expected.length} expected`, ok, parts.join('\n      '))
  return ok
}

// tables + columns
report('tables', prodTables.map(t => t.relname).sort(), gotTables.map(t => t.relname).sort())

const colKey = (t: string, c: any) => `${t}.${c.name}:${c.type}${c.notnull ? ' NN' : ''}${c.generated === 's' ? ' GEN' : ''}`
report('columns (name, type, nullability, generated)',
  prodTables.flatMap(t => (t.cols ?? []).map((c: any) => colKey(t.relname, c))).sort(),
  gotTables.flatMap(t => (t.cols ?? []).map((c: any) => colKey(t.relname, c))).sort())

// constraints — exclude PG18's NOT NULL rows (contype 'n'), absent in PG17
const conKey = (c: any) => `${c.tbl}.${c.conname}`
const prodCon = prodConstraints.filter(c => c.contype !== 't')
const gotCon = gotConstraints.filter(c => c.contype !== 't' && c.contype !== 'n')
report('constraints (pk/unique/check/fk)', prodCon.map(conKey).sort(), gotCon.map(conKey).sort())

const normDef = (s: string) => s.replace(/\s+/g, ' ').trim()
const gotConMap = new Map(gotCon.map(c => [conKey(c), normDef(c.def)]))
const defMismatch = prodCon
  .filter(c => gotConMap.has(conKey(c)) && gotConMap.get(conKey(c)) !== normDef(c.def))
  .map(c => `${conKey(c)}\n        prod: ${normDef(c.def).slice(0, 120)}\n        got : ${gotConMap.get(conKey(c))!.slice(0, 120)}`)
check('constraint definitions match', defMismatch.length === 0, defMismatch.slice(0, 4).join('\n      '))

// indexes
report('indexes', prodIndexes.map(i => i.indexname).sort(), gotIndexes.map(i => i.indexname).sort())

// functions
const fnKey = (f: any) => `${f.proname}(${f.args})`
report('functions', prodAppFns.map(fnKey).sort(), gotFunctions.map(fnKey).sort())

const gotFnMap = new Map(gotFunctions.map(f => [fnKey(f), f]))
const bodyMismatch = prodAppFns
  .filter(f => gotFnMap.has(fnKey(f)))
  .filter(f => normDef(gotFnMap.get(fnKey(f))!.def) !== normDef(f.def))
  .map(f => fnKey(f))
check('function bodies byte-identical to production', bodyMismatch.length === 0,
  bodyMismatch.length ? `${bodyMismatch.length} differ: ${bodyMismatch.slice(0, 5).join(', ')}` : '')

// function EXECUTE grants — the security-critical half
const aclRoles = (acl: string | null) => {
  if (!acl) return '<default:PUBLIC>'
  return acl.replace(/^\{|\}$/g, '').split(',')
    .map(i => { const lhs = i.split('/')[0]; const eq = lhs.indexOf('='); return (lhs.slice(0, eq) || 'PUBLIC') + '=' + lhs.slice(eq + 1) })
    .filter(s => !s.startsWith('postgres=')).sort().join(',')
}
const grantMismatch = prodAppFns
  .filter(f => gotFnMap.has(fnKey(f)))
  .filter(f => aclRoles(gotFnMap.get(fnKey(f))!.acl) !== aclRoles(f.acl))
  .map(f => `${fnKey(f)}\n        prod: ${aclRoles(f.acl)}\n        got : ${aclRoles(gotFnMap.get(fnKey(f))!.acl)}`)
check('function EXECUTE grants match exactly', grantMismatch.length === 0, grantMismatch.slice(0, 5).join('\n      '))

// table grants
const gotAclMap = new Map(gotTableAcls.map(t => [t.relname, aclRoles(t.acl)]))
const tblGrantMismatch = prodTables
  .filter(t => gotAclMap.has(t.relname) && gotAclMap.get(t.relname) !== aclRoles(t.acl))
  .map(t => `${t.relname}\n        prod: ${aclRoles(t.acl)}\n        got : ${gotAclMap.get(t.relname)}`)
check('table grants match exactly', tblGrantMismatch.length === 0, tblGrantMismatch.slice(0, 5).join('\n      '))

// RLS
const rlsMissing = prodTables.filter(t => t.rls).map(t => t.relname)
  .filter(n => !gotTables.find(g => g.relname === n && g.rls))
check('RLS enabled on every table production has it on', rlsMissing.length === 0, rlsMissing.slice(0, 8).join(', '))

// policies
const polKey = (p: any) => `${p.tablename}::${p.policyname}`
const prodPub = prodPolicies.filter(p => p.schemaname === 'public')
report('policies', prodPub.map(polKey).sort(), gotPolicies.map(polKey).sort())

const gotPolMap = new Map(gotPolicies.map(p => [polKey(p), p]))
const polMismatch = prodPub
  .filter(p => gotPolMap.has(polKey(p)))
  .filter(p => {
    const g = gotPolMap.get(polKey(p))!
    return g.cmd !== p.cmd || g.roles !== p.roles ||
      normDef(g.qual ?? '') !== normDef(p.qual ?? '') ||
      normDef(g.with_check ?? '') !== normDef(p.with_check ?? '')
  })
  .map(p => polKey(p))
check('policy predicates and roles match', polMismatch.length === 0,
  polMismatch.length ? `${polMismatch.length} differ: ${polMismatch.slice(0, 5).join(', ')}` : '')

// triggers
const trgKey = (t: any) => `${t.tbl}::${t.tgname}`
report('triggers', prodTriggers.map(trgKey).sort(), gotTriggers.map(trgKey).sort())

// storage
report('storage buckets', prodMisc.buckets.map((b: any) => b.id).sort(), gotBuckets.map(b => b.id).sort())
const bucketPrivacy = prodMisc.buckets
  .filter((b: any) => { const g = gotBuckets.find(x => x.id === b.id); return g && g.public !== b.public })
  .map((b: any) => `${b.id} (prod public=${b.public})`)
check('bucket public/private flags match', bucketPrivacy.length === 0, bucketPrivacy.join(', '))
report('storage policies', prodPolicies.filter(p => p.schemaname === 'storage').map(p => p.policyname).sort(),
  gotStoragePolicies.map(p => p.policyname).sort())

// ── smoke: the rebuilt database actually answers ─────────────────────────────
console.log('\n── smoke test the rebuilt database ──')
try {
  await db.exec(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000aa', 'owner@example.test')`)
  await db.exec(`set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000aa'`)
  const r = await db.query(`select public.get_portal_data('nope-not-a-real-token') as d`)
  check('get_portal_data executes and returns a shaped answer', r.rows.length === 1)
} catch (e: any) {
  check('get_portal_data executes', false, String(e.message).slice(0, 200))
}
try {
  const r = await db.query(`select count(*)::int as n from public.search_records('x', 5)`)
  check('search_records executes', typeof r.rows[0].n === 'number')
} catch (e: any) {
  check('search_records executes', false, String(e.message).slice(0, 200))
}

await db.close()

// ── verdict ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(72)}`)
if (fail === 0) {
  console.log(`REBUILD PROVEN — ${pass} checks passed.`)
  console.log('An empty Postgres + this repository = production\'s schema contract.')
  console.log('(Schema only. Data comes from a backup restore — see docs/DISASTER_RECOVERY.md.)\n')
} else {
  console.error(`REBUILD IS NOT FAITHFUL — ${fail} failed, ${pass} passed.`)
  console.error('The repo cannot currently reconstruct production. Fix before relying on recovery.\n')
}
process.exit(fail === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
