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

// ⚠️⚠️ ASSERT THE STATE, NOT THE REVOKE. The first version of this guard looked
// for `REVOKE … FROM authenticated` in the apply path, and went red the moment
// the migration was absorbed: production ran it, the baseline was regenerated,
// and the file moved to archive/ledger/ — which is never applied. A migration has
// two lives, and a guard that recognises only the first one fails on the very
// convergence that proves the fix landed.
//
// What must hold in EITHER life is the same, and it is a property of the whole
// apply path: nothing in it grants a DDL privilege to a browser-facing role.
// Before absorption the REVOKE produces that; after it, the generated baseline
// simply emits `grant INSERT, SELECT, UPDATE, DELETE, MAINTAIN … to anon`, with
// no TRUNCATE to remove. One rule, both spellings.
const statements = applyPath.split(';')
for (const role of CLIENT_ROLES) {
  for (const priv of DDL_PRIVS) {
    // Any GRANT that reaches this role and names this privilege, whether on a
    // table or as a default for future ones.
    const offenders = statements.filter(s =>
      /\bgrant\b/i.test(s) && new RegExp(`\\bto\\s+[^;]*\\b${role}\\b`, 'i').test(s) &&
      (new RegExp(`\\b${priv}\\b`, 'i').test(s) || /\bgrant\s+all\b/i.test(s)))
    check(`nothing in the apply path grants ${role} ${priv.toUpperCase()}`,
      offenders.length === 0,
      `${offenders.length} statement(s), e.g. ${offenders[0]?.trim().replace(/\s+/g, ' ').slice(0, 150)}`)
  }
  // The default privileges are why this recurs: correct only the existing tables
  // and the next `create table` re-grants everything on its new one.
  const tableDefaults = statements.filter(s =>
    /alter\s+default\s+privileges/i.test(s) && /\bon\s+tables\b/i.test(s) &&
    new RegExp(`\\b${role}\\b`).test(s))
  const bad = tableDefaults.filter(s => DDL_PRIVS.some(p => new RegExp(`\\b${p}\\b`, 'i').test(s)) || /\bgrant\s+all\b/i.test(s))
  check(`future tables will not grant ${role} these privileges`,
    tableDefaults.length > 0 && bad.length === 0,
    tableDefaults.length === 0
      ? 'no ALTER DEFAULT PRIVILEGES … ON TABLES for this role in the apply path at all'
      : `${bad.length} default-privilege statement(s) still hand out a DDL privilege`)
}

// ⭐ THE OTHER DIRECTION. This guard must never become an argument for removing
// row access: an apply path that granted the client roles nothing would satisfy
// every check above and break every screen in the product.
for (const role of CLIENT_ROLES) {
  const crud = statements.filter(s =>
    /\bgrant\b/i.test(s) && new RegExp(`\\bto\\s+[^;]*\\b${role}\\b`, 'i').test(s) &&
    /\b(select|insert|update|delete)\b/i.test(s))
  check(`${role} still holds row access somewhere in the apply path (${crud.length} grant(s))`,
    crud.length > 0,
    'revoking CRUD from a client role would break every screen — this is not that fix')
}

// ⛔ THE RESIDUAL, pinned so it cannot be forgotten. `postgres` is not superuser
// on Supabase and cannot alter `supabase_admin`'s default privileges (42501), so
// that second default ACL still hands out arwdDxtm for any table supabase_admin
// itself creates in `public`. Every table this project creates is created by
// postgres, so the reachable half is the one that governs us — but the entry is
// real and closing it needs a superuser.
console.log('  ⛔ RESIDUAL: supabase_admin\'s default privileges in `public` still include')
console.log('     TRUNCATE/TRIGGER/REFERENCES for anon and authenticated. postgres cannot')
console.log('     change them (not superuser, not a member, 42501 measured). Needs the')
console.log('     Supabase dashboard or support. Only affects tables supabase_admin creates.')

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
