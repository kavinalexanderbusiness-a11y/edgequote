// ── Client privileges — `npm run verify:client-privileges` ───────────────────
//
// THE INVARIANT: the browser-facing roles (`anon`, `authenticated`) may read and
// write ROWS, and nothing else. They must never hold TRUNCATE, TRIGGER or
// REFERENCES on a table in `public`.
//
// ⛔⛔ WHY RLS DOES NOT COVER THIS. Every one of the 115 public tables has RLS
// enabled, and not one of those policies constrains TRUNCATE — a policy decides
// which ROWS an operation may touch, and TRUNCATE is not a row operation. A role
// holding it empties the table outright, policies and all. Measured on production
// on 2026-08-28, BEFORE the fix:
//
//     anon          held TRUNCATE on  90 of 115 tables
//     authenticated held TRUNCATE on 101 (99 of them tenant-owned)
//     only 14 tables were correctly shaped
//
// `customers`, `invoices`, `api_keys` and `customer_portal_tokens` were all in
// that set. Nobody granted it per table: Supabase's create-time default
// privileges hand `arwdDxtm` to both roles for every new table in `public`, so
// each one inherited the full set — and every future table would have too.
//
// ⚖️ This guard exists for the LAST LINE, not for an open door. At the same
// measurement there were zero functions naming TRUNCATE, zero client-executable
// SECURITY INVOKER paths that would use the caller's grant, zero client-callable
// dynamic SQL, and PostgREST has no HTTP verb that becomes TRUNCATE. The grant
// was not reachable — it was simply the thing that would make the next mistake
// unrecoverable, so it should not exist.
//
// TWO HALVES, and the offline one is the one CI runs:
//   1. THE APPLY PATH must revoke all three from both roles, and must fix the
//      DEFAULT privileges too — revoking only what exists today means the next
//      `create table` silently re-opens it.
//   2. LIVE (skipped without credentials): production must actually agree.
//
// ⭐ CRUD IS NOT THE TARGET. select/insert/update/delete must survive untouched —
// a guard that pushed toward revoking those would be arguing for a broken app.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const ROOT = process.cwd()
let pass = 0, fail = 0, skipped = 0
const ok = (n: string) => { pass++; console.log(`  ✅ ${n}`) }
const bad = (n: string, d = '') => { fail++; console.log(`  ❌ ${n}${d ? `\n     ${d}` : ''}`) }
const check = (n: string, c: boolean, d = '') => (c ? ok(n) : bad(n, d))

const DDL_PRIVS = ['truncate', 'trigger', 'references'] as const
const CLIENT_ROLES = ['anon', 'authenticated'] as const

console.log('\n══ client privileges ════════════════════════════════════════════════════\n')

// ── 1. The apply path ────────────────────────────────────────────────────────
console.log('── the apply path revokes them, and fixes the default ──')
const MIG = join(ROOT, 'supabase', 'migrations')
const applyPath = readdirSync(MIG).filter(f => f.endsWith('.sql')).sort()
  .map(f => readFileSync(join(MIG, f), 'utf8')).join('\n')
  // Comments explain the very grants this forbids, so a raw scan would match the
  // explanation and report the fix as the defect.
  .split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

for (const role of CLIENT_ROLES) {
  // One revoke may name several privileges, so match a statement that reaches
  // this role and check the privileges inside it rather than demanding a
  // particular spelling or ordering.
  const stmts = applyPath.split(';').filter(s =>
    /\brevoke\b/i.test(s) && /\ball tables in schema public\b/i.test(s) && new RegExp(`\\b${role}\\b`).test(s))
  const named = stmts.join(' ').toLowerCase()
  for (const priv of DDL_PRIVS) {
    check(`${role} is revoked ${priv.toUpperCase()} on all tables in public`,
      stmts.length > 0 && named.includes(priv),
      `no REVOKE … ON ALL TABLES IN SCHEMA public FROM ${role} naming ${priv}`)
  }
  // The default privileges are the reason this recurs: fix only the existing
  // tables and the next migration re-grants everything on its new one.
  const defaults = applyPath.split(';').filter(s =>
    /alter\s+default\s+privileges/i.test(s) && /\brevoke\b/i.test(s) && new RegExp(`\\b${role}\\b`).test(s))
  const defNamed = defaults.join(' ').toLowerCase()
  check(`future tables will not grant ${role} these privileges`,
    defaults.length > 0 && DDL_PRIVS.every(p => defNamed.includes(p)),
    'ALTER DEFAULT PRIVILEGES … REVOKE must cover truncate, trigger and references')
  // Production carries default ACLs from BOTH grantors; fixing one leaves the
  // other still handing them out on every new table.
  check(`…for both the postgres and supabase_admin grantors (${role})`,
    /for\s+role\s+postgres/i.test(defaults.join(' ')) && /for\s+role\s+supabase_admin/i.test(defaults.join(' ')),
    'default ACLs exist for both roles in this project; revoking one is half a fix')
}

// ⭐ The other direction: this must not become an argument for removing CRUD.
const revokedCrud = applyPath.split(';').filter(s =>
  /\brevoke\b/i.test(s) && /all tables in schema public/i.test(s) &&
  /\b(select|insert|update|delete)\b/i.test(s) && /\b(anon|authenticated)\b/i.test(s))
check('CRUD is never revoked wholesale from the client roles', revokedCrud.length === 0,
  `a blanket REVOKE of row operations would break every screen:\n     ${revokedCrud.join('\n     ').slice(0, 300)}`)

// ── 2. Live ──────────────────────────────────────────────────────────────────
console.log('\n── production agrees (live) ──')
for (const line of (() => { try { return readFileSync(join(ROOT, '.env.local'), 'utf8').split(/\r?\n/) } catch { return [] } })()) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

async function live() {
  if (!url || !key || url.includes('placeholder')) {
    skipped++
    console.log('  ⏭ SKIPPED — no service-role credentials, so production was never asked.')
    console.log('     The apply-path half above still ran. A guard that cannot run proves nothing,')
    console.log('     so resolve this before a release rather than reading the skip as a pass.')
    return
  }
  const db = createClient(url, key, { auth: { persistSession: false } })
  const { data, error } = await db.rpc('schema_contract')
  if (error) { bad('could not read production privileges', error.message); return }
  const grants = (data as { table_grants?: { table_name: string; grantee: string; privilege_type: string }[] })?.table_grants
  if (!grants) { skipped++; console.log('  ⏭ contract carried no table_grants section'); return }
  for (const role of CLIENT_ROLES) {
    for (const priv of DDL_PRIVS) {
      const held = grants.filter(g => g.grantee === role && g.privilege_type.toLowerCase() === priv)
      check(`live: ${role} holds ${priv.toUpperCase()} on no public table`, held.length === 0,
        `${held.length} table(s), e.g. ${held.slice(0, 5).map(g => g.table_name).join(', ')}`)
    }
  }
}

// tsx compiles this file to CJS, where top-level await is a syntax error.
live().then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} verify:client-privileges — ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}\n`)
  process.exit(fail === 0 ? 0 : 1)
})
