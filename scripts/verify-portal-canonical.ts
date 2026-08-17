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
const MIGRATIONS = join(SUPA, 'migrations')
const FN = 'get_portal_data'

// A runnable definition header, in any casing/spacing SQL permits.
const DEF_HEADER = /create\s+(or\s+replace\s+)?function\s+(public\.)?get_portal_data\s*\(/i
// The tombstone INF-2 left behind in every migration that used to define it.
const TOMBSTONE = /SUPERSEDED\s+—\s+DO\s+NOT\s+RESTORE\s+THIS\s+BODY|now has exactly ONE definition/i

// 2026-08-13: the canonical file is gone and its job moved into the baseline.
// It existed because "run this last, it wins" was the only way to guarantee the
// newest body survived a rebuild — which is also precisely how a STALE copy could
// roll production backward. The baseline removes the dilemma: it is generated FROM
// production, so there is no second copy that can be older than the first.
//
// What still has to be true, and is what this guard now checks:
//   · exactly one file IN THE APPLY PATH (supabase/migrations/) defines the RPC
//   · supabase/archive/ is NOT in the apply path — it holds ~10 older bodies
const migrationFiles = existsSync(MIGRATIONS)
  ? readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).map(f => join(MIGRATIONS, f))
  : []
const definers = migrationFiles.filter(f => DEF_HEADER.test(readFileSync(f, 'utf8')))

console.log('\n── one definition, and it is in the apply path ──')
check('supabase/migrations/ exists and holds a baseline', migrationFiles.length > 0)
check('exactly one migration defines get_portal_data', definers.length === 1, definers.join(', ') || 'none')

// Extract just this function's body from the baseline. The baseline defines ~93
// functions; running the contract regexes over all 468 KB would let a phrase from
// a neighbouring function satisfy a check meant for this one.
const baselineSrc = definers[0] ? readFileSync(definers[0], 'utf8') : ''
const fnMatch = baselineSrc.match(
  /CREATE OR REPLACE FUNCTION public\.get_portal_data[\s\S]*?\$function\$[\s\S]*?\$function\$/i)
const src = fnMatch?.[0] ?? ''
check('the baseline body for get_portal_data can be isolated', src.length > 0,
  'no $function$-quoted body found — has the generator changed its output format?')

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
const ARCHIVE = join(SUPA, 'archive')
const lostTombstone = TOMBSTONED.filter(f => {
  // Archived 2026-08-13 — the RUN files moved under supabase/archive/run/ and the
  // 2026-06-25 snapshot was renamed. Tombstones still matter: archiving keeps them
  // out of the apply path, but someone WILL open one of these looking for "the real
  // definition", and the tombstone is what tells them not to paste it into a shell.
  const p = f === 'schema.sql'
    ? join(ARCHIVE, 'schema-2026-06-25-snapshot.sql')
    : join(ARCHIVE, 'run', f)
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
  /from public\.invoices\s+where\s+customer_id\s*=\s*v_customer\s+and\s+user_id\s*=\s*v_user\s+and\s+status\s*<>\s*'draft'/.test(invoiceSelect),
  'the privacy predicate (customer + tenant weld + draft filter) is missing from the INVOICES select')
check('quotes keep their own draft filter', /qt\.status\s*<>\s*'draft'/.test(quoteSelect))
for (const field of ['deposit_amount', 'deposit_requested_at']) {
  check(`invoice projection still carries ${field}`, invoiceSelect.includes(field))
}
// The 13 top-level keys. `services` is the one that has actually been dropped before
// (it renders an empty catalogue — "this business offers nothing" — without erroring).
//
// `change_orders` (2026-08-14) is pinned here for a specific reason. Production began
// serving it at 05:33; the repo's hand-maintained canonical file did not have it, and
// the deploy checklist said to run that file LAST so it wins. Re-running it as
// documented would have deleted the projection from the live portal. The offline pin
// below and the live sweep further down now catch that from both directions.
const KEYS = ['customer', 'business', 'property', 'properties', 'quotes', 'invoices',
  'jobs', 'recurrences', 'photos', 'payments', 'payment_method', 'services', 'change_orders']
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
      console.error('\n  ⛔ The baseline in supabase/migrations/ holds the ONLY definition of the portal RPC.')
      console.error('     A weakened body there rebuilds a portal that leaks or omits. It is GENERATED,')
      console.error('     so do not hand-edit it — resync from production and regenerate:')
      console.error('       npm run schema:contract   # re-read production into supabase/contract/')
      console.error('       npm run schema:baseline   # rewrite the baseline from that capture')
    }
    process.exit(fail === 0 ? 0 : 1)
  })
  .catch(err => { console.error(err); process.exit(1) })
