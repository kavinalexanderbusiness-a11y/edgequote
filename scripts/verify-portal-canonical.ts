// ── Canonical portal RPC guard — `npm run verify:portal-canonical` ───────────
//
// THE FAILURE THIS EXISTS TO STOP: get_portal_data is a live object that keeps
// evolving, and supabase/CANONICAL-get_portal_data.sql is a SNAPSHOT of it.
// DEPLOY_CHECKLIST step 3 runs CANONICAL-*.sql LAST, on purpose, so that the
// newest definition wins a reset — which means a stale snapshot does not fail
// loudly, it SILENTLY ROLLS PRODUCTION BACKWARD. No migration error, no stack
// trace; just fields quietly missing from a customer's screen, or a privacy
// predicate quietly gone.
//
// That is not hypothetical. INF-2 (2026-07-17) found NINE runnable copies of this
// function and collapsed them to one. Then on 2026-08-09 the surviving single file
// had already drifted by one line — and that line carried BOTH the draft-invoice
// privacy predicate (commit 06a50db, a confirmed data exposure) and the deposit
// fields. Re-running the file as documented would have re-opened the hole.
//
// A comment asking the next person to "query production first" did not survive two
// same-day changes. So this is the machine check that does.
//
// ── OFFLINE (always runs) ────────────────────────────────────────────────────
//   · exactly ONE runnable definition of get_portal_data exists in the repo
//   · every historical migration that once defined it still carries its tombstone
//   · the canonical body still contains the predicates/fields that must never go
//
// ── LIVE (only when credentials exist; skips clean otherwise) ────────────────
//   · the canonical file's projected shape still MATCHES the live function's —
//     the drift detector that would have fired on 2026-08-09
//
// Read-only. No writes, no DDL, no payment calls.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

for (const line of existsSync('.env.local') ? readFileSync('.env.local', 'utf8').split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
}

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const SUPA = 'supabase'
const CANONICAL = join(SUPA, 'CANONICAL-get_portal_data.sql')
const FN = 'get_portal_data'

// A runnable definition header, in any casing/spacing SQL permits.
const DEF_HEADER = /create\s+(or\s+replace\s+)?function\s+(public\.)?get_portal_data\s*\(/i
// The tombstone INF-2 left behind in every migration that used to define it.
const TOMBSTONE = /SUPERSEDED\s+—\s+DO\s+NOT\s+RESTORE\s+THIS\s+BODY|now has exactly ONE definition/i

const src = existsSync(CANONICAL) ? readFileSync(CANONICAL, 'utf8') : ''

console.log('\n── the canonical file is the only definition ──')
check('supabase/CANONICAL-get_portal_data.sql exists', src.length > 0)

// 1. Exactly one runnable definition in the whole repo, and it is the canonical file.
const sqlFiles = readdirSync(SUPA).filter(f => f.endsWith('.sql')).map(f => join(SUPA, f))
const definers = sqlFiles.filter(f => DEF_HEADER.test(readFileSync(f, 'utf8')))
check('exactly one file defines get_portal_data', definers.length === 1, definers.join(', ') || 'none')
check('… and it is the canonical file', definers[0] === CANONICAL, definers[0])

// 2. The migrations that ONCE held a runnable body must keep their tombstone.
//    Pinned by name rather than discovered, because a tombstone that has been
//    deleted is exactly what this check must catch — and a discovered set would
//    quietly shrink with it. Merely MENTIONING the function (a `grant execute`, a
//    comment, or the 2026-08-09 patch that reads the live body) is not a body and
//    needs no tombstone; requiring one there would be noise that trains people to
//    ignore this suite.
const TOMBSTONED = [
  'RUN-2026-06-25-autopay-website.sql',
  'RUN-2026-06-27-invoice-discounts.sql',
  'RUN-2026-06-27-payment-ledger.sql',
  'RUN-2026-07-07-portal-quote-services.sql',
  'RUN-2026-07-09-etransfer-email.sql',
  'RUN-2026-07-14-portal-service-plans.sql',
  'RUN-2026-07-15-portal-quote-expiry.sql',
  'RUN-2026-07-15-portal-services.sql',
  'RUN-2026-07-17-portal-property-identity.sql',
  'schema.sql',
]
const lostTombstone = TOMBSTONED.filter(f => {
  const p = join(SUPA, f)
  return !existsSync(p) || !TOMBSTONE.test(readFileSync(p, 'utf8'))
})
check(`all ${TOMBSTONED.length} migrations that once defined it keep their tombstone`,
  lostTombstone.length === 0, lostTombstone.join(', '))

// 3. THE CONTRACT. Each entry is something whose removal is a production incident,
//    not a style change. Anchored to its own clause so a match elsewhere can't
//    satisfy it — the draft predicate in particular must be on the INVOICES select,
//    which is exactly the distinction that was wrong before 06a50db.
console.log('\n── the contract the body must keep ──')
// ⚠️ Assert against EXECUTABLE SQL ONLY. Every `--` comment is stripped first,
// because the first draft of this guard did not do that and quietly passed a
// deliberately broken file: the header comment above documents the invoice
// projection by name, so a regex anchored on the first textual `'invoices',`
// swallowed the whole header and found `deposit_amount` in the PROSE. Documentation
// that describes the contract must never be able to satisfy it.
const sqlOnly = src.split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n')
const invoiceSelect = sqlOnly.match(/'invoices',[\s\S]*?from public\.invoices[^)]*\)/)?.[0] ?? ''
const quoteSelect = sqlOnly.match(/from public\.quotes qt[^)]*\)/)?.[0] ?? ''

check('invoices are filtered server-side: draft never leaves the DB',
  /from public\.invoices\s+where\s+customer_id\s*=\s*v_customer\s+and\s+status\s*<>\s*'draft'/.test(invoiceSelect),
  'the privacy predicate is missing from the INVOICES select')
check('quotes keep their own draft filter', /qt\.status\s*<>\s*'draft'/.test(quoteSelect))
for (const field of ['deposit_amount', 'deposit_requested_at']) {
  check(`invoice projection still carries ${field}`, invoiceSelect.includes(field))
}
// The 12 top-level keys. `services` is the one that has actually been dropped before
// (it renders an empty catalogue — "this business offers nothing" — without erroring).
const KEYS = ['customer', 'business', 'property', 'properties', 'quotes', 'invoices',
  'jobs', 'recurrences', 'photos', 'payments', 'payment_method', 'services']
const missingKeys = KEYS.filter(k => !new RegExp(`'${k}',`).test(sqlOnly))
check(`all ${KEYS.length} top-level payload keys are built`, missingKeys.length === 0, `missing: ${missingKeys.join(', ')}`)
check('still SECURITY DEFINER with a pinned search_path',
  /SECURITY DEFINER/i.test(sqlOnly) && /SET search_path/i.test(sqlOnly))
check('a revoked/unknown token still returns null before any data is read',
  /if v_customer is null then return null; end if;/i.test(sqlOnly))

async function live() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const email = process.env.PORTAL_RPC_OWNER_EMAIL
  const password = process.env.PORTAL_RPC_OWNER_PASSWORD
  if (!url || !anonKey || !email || !password) {
    console.log('\n  … live drift check SKIPPED — no credentials (see verify-portal-rpc.ts header)')
    return
  }
  console.log('\n── the file still matches the live function ──')
  const owner = createClient(url, anonKey, { auth: { persistSession: false } })
  const { error: e } = await owner.auth.signInWithPassword({ email, password })
  if (e) { check('owner sign-in', false, e.message); return }
  const { data: tok } = await owner.from('customer_portal_tokens').select('token, customer_id').eq('revoked', false)
  if (!tok?.length) { console.log('  … no portal token to sample; skipping drift check'); return }
  // Sample a customer who actually HAS invoices — the invoice projection is the one
  // that keeps gaining columns, so drift-checking an empty array proves nothing.
  const { data: withInv } = await owner.from('invoices').select('customer_id')
  const billed = new Set((withInv ?? []).map(r => r.customer_id))
  const token = (tok.find(t => billed.has(t.customer_id)) ?? tok[0]).token

  const anon = createClient(url, anonKey)
  const { data, error } = await anon.rpc(FN, { p_token: token })
  if (error || !data) { check('live payload sampled', false, error?.message ?? 'null payload'); return }
  const payload = data as Record<string, unknown>

  // Top-level keys: the file must build every key the live function returns. A key
  // that exists live but not here is precisely the drift that rots this file.
  const liveKeys = Object.keys(payload)
  const notInFile = liveKeys.filter(k => !new RegExp(`'${k}',`).test(sqlOnly))
  check('every key the LIVE function returns is built by this file', notInFile.length === 0,
    `live has ${notInFile.join(', ')} — this file is STALE, resync it from production`)

  // Invoice field-set: the projection most likely to gain columns (it just did, twice).
  const invoices = payload.invoices as Record<string, unknown>[] | undefined
  if (invoices && invoices.length > 0) {
    const liveFields = Object.keys(invoices[0])
    const missing = liveFields.filter(f => !invoiceSelect.includes(f))
    check(`every LIVE invoice field is in this file's projection (${liveFields.length} field(s))`,
      missing.length === 0, `live has ${missing.join(', ')} — this file is STALE`)
    // And the privacy predicate proven by behaviour, not just by text.
    check('no draft invoice is present in the sampled live payload',
      !invoices.some(i => i.status === 'draft'))
  } else {
    console.log('  … sampled customer has no invoices; field-set drift not checked this run')
  }
}

live()
  .then(() => {
    console.log(`\n${fail === 0 ? '✓' : '✗'} portal canonical checks: ${pass} passed, ${fail} failed`)
    if (fail > 0) {
      console.error('\n  ⛔ supabase/CANONICAL-get_portal_data.sql is the ONLY definition of the portal RPC,')
      console.error('     and DEPLOY_CHECKLIST runs it LAST so it wins. A stale or weakened body here')
      console.error('     rolls production backward silently. Resync it from production before shipping:')
      console.error("     select pg_get_functiondef(oid) from pg_proc where proname='get_portal_data';")
    }
    process.exit(fail === 0 ? 0 : 1)
  })
  .catch(err => { console.error(err); process.exit(1) })
