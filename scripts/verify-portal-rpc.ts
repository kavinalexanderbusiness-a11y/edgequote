// ── Portal RPC contract suite — `npm run verify:portal-rpc` ──────────────────
//
// Every other verify suite in this repo is pure and offline. This one is not, and
// deliberately so: the bug it guards lives in the DATABASE, not in TypeScript.
// get_portal_data selected the customer's invoices with no status filter, so a
// DRAFT invoice — the owner's unfinished, unsent bill — was serialized into the
// payload the browser receives. The UI filtered it out of the render, so every
// offline model test passed while the row sat there in devtools, fully readable.
//
// A client-side filter is a rendering decision. Only the server can be the privacy
// boundary, so only a live call can prove the boundary holds. This asks the real
// RPC, as the customer's own `anon` role, exactly the way the portal page does.
//
// SKIPS CLEANLY without credentials (prints SKIPPED, exits 0) so `npm run verify`
// stays green on a machine that has no .env.local. When it does run it needs:
//   NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY   (the customer path)
//   PORTAL_RPC_OWNER_EMAIL + PORTAL_RPC_OWNER_PASSWORD         (to enumerate what
//     SHOULD be visible — read-only, via the owner's own RLS)
//
// Portal tokens are CREDENTIALS: they are discovered at runtime through the owner
// session and never hardcoded, never printed. Read-only throughout — no writes, no
// payment calls.

import { createClient } from '@supabase/supabase-js'
import { readFileSync, existsSync } from 'node:fs'
import { normalizePortal, buildPortalView, type DocBlobRenderers } from '../src/app/portal/[token]/model'
import { invoiceBalance } from '../src/lib/payments/ledger'

for (const line of existsSync('.env.local') ? readFileSync('.env.local', 'utf8').split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
}

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
// A token grants portal access. Never let one reach a log.
const redact = (t: string) => `${t.slice(0, 4)}…${t.slice(-2)}`

// THE visibility rule, in one place. Invoice statuses are pinned identically by the
// DB CHECK constraint (invoices_status_check) and src/types/index.ts:
//   draft | unpaid | sent | partial | paid | overpaid | cancelled
// `draft` is the owner's private work-in-progress. Everything else is a bill the
// customer is entitled to read — `cancelled` included, so a withdrawn charge is
// explainable rather than silently gone. Same rule the RPC already applied to quotes.
const PRIVATE_STATUSES = new Set(['draft'])
const isCustomerVisible = (status: string) => !PRIVATE_STATUSES.has(status)

const renderers: DocBlobRenderers = { quote: async () => new Blob(['q']), invoice: async () => new Blob(['i']) }

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const email = process.env.PORTAL_RPC_OWNER_EMAIL
  const password = process.env.PORTAL_RPC_OWNER_PASSWORD
  if (!url || !anonKey || !email || !password) {
    console.log('  … SKIPPED — no Supabase/owner credentials (set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, PORTAL_RPC_OWNER_EMAIL, PORTAL_RPC_OWNER_PASSWORD to run)')
    console.log('\n✓ portal RPC checks: skipped')
    return
  }

  // The CUSTOMER's client: anon, exactly what the portal page uses.
  const anon = createClient(url, anonKey)
  // The OWNER's client: read-only, only to learn what SHOULD be visible.
  const owner = createClient(url, anonKey, { auth: { persistSession: false } })
  const { error: signInErr } = await owner.auth.signInWithPassword({ email, password })
  if (signInErr) { console.error(`  ✗ owner sign-in failed: ${signInErr.message}`); process.exit(1) }

  const { data: tokens, error: tErr } = await owner.from('customer_portal_tokens').select('token, customer_id, revoked')
  if (tErr) { console.error(`  ✗ could not read portal tokens: ${tErr.message}`); process.exit(1) }
  const { data: allInv, error: iErr } = await owner.from('invoices').select('id, invoice_number, customer_id, status, amount, amount_paid, discount_type, discount_value')
  if (iErr) { console.error(`  ✗ could not read invoices: ${iErr.message}`); process.exit(1) }
  const { data: biz } = await owner.from('business_settings').select('gst_percent').maybeSingle()
  const gstPct = Number(biz?.gst_percent) || 0

  const live = (tokens || []).filter(t => !t.revoked)
  const invByCustomer = new Map<string, typeof allInv>()
  for (const i of allInv || []) {
    if (!invByCustomer.has(i.customer_id)) invByCustomer.set(i.customer_id, [])
    invByCustomer.get(i.customer_id)!.push(i)
  }
  console.log(`\n  (${live.length} live portal token(s), ${(allInv || []).length} invoice(s) in the book)`)

  // 6. A bogus token must yield nothing at all — before anything else is trusted.
  const { data: bogus, error: bogusErr } = await anon.rpc('get_portal_data', { p_token: 'not-a-real-token-' + 'x'.repeat(24) })
  check('a bogus portal token returns no customer data', !bogusErr && bogus === null, bogusErr?.message ?? `got ${typeof bogus}`)

  let checkedDraftWithholding = 0
  const statusesSeen = new Set<string>()
  let leaked = 0, missing = 0, foreign = 0, balanceMismatches = 0

  for (const t of live) {
    const { data, error } = await anon.rpc('get_portal_data', { p_token: t.token })
    if (error) { check(`payload loads for ${redact(t.token)}`, false, error.message); continue }
    const pd = normalizePortal(data)
    if (!pd) { check(`payload loads for ${redact(t.token)}`, false, 'null payload for a live token'); continue }

    const mine = invByCustomer.get(t.customer_id) || []
    const expected = mine.filter(i => isCustomerVisible(i.status))
    const withheld = mine.filter(i => !isCustomerVisible(i.status))
    const gotIds = new Set(pd.invoices.map(i => i.id))

    // 4. No private invoice may appear in the payload — the whole point.
    for (const w of withheld) if (gotIds.has(w.id)) { leaked++; console.error(`  ✗ DRAFT LEAKED: ${w.invoice_number} in ${redact(t.token)}`) }
    if (withheld.length > 0) checkedDraftWithholding++

    // 1/2/3. Every status the customer IS entitled to must still arrive.
    for (const e of expected) {
      if (!gotIds.has(e.id)) { missing++; console.error(`  ✗ MISSING: ${e.invoice_number} (${e.status}) absent from ${redact(t.token)}`) }
      statusesSeen.add(e.status)
    }

    // 5. Nothing belonging to anyone else may appear.
    for (const got of pd.invoices) if (!mine.some(i => i.id === got.id)) { foreign++; console.error(`  ✗ FOREIGN: invoice ${got.invoice_number} is not this customer's`) }

    // 7. Counts and balances still add up, through the REAL model + ledger engine.
    const view = buildPortalView(pd, new Date().toISOString().slice(0, 10), renderers)
    const shown = view.docItems.filter(d => d.kind === 'invoice')
    const expectedDue = expected
      .filter(i => i.status !== 'cancelled')
      .reduce((s, i) => s + Math.max(0, invoiceBalance({ ...i, amount_paid: i.amount_paid ?? undefined }, { gst_percent: gstPct }).balance), 0)
    if (shown.length !== expected.length) { balanceMismatches++; console.error(`  ✗ COUNT: ${redact(t.token)} shows ${shown.length}, expected ${expected.length}`) }
    if (Math.abs(view.money.due - Math.round(expectedDue * 100) / 100) > 0.005) {
      balanceMismatches++; console.error(`  ✗ BALANCE: ${redact(t.token)} due=${view.money.due}, expected ${expectedDue}`)
    }
    // 8. The View/Download contract from 38b7b0e still holds on every real row.
    for (const d of shown) {
      if (typeof d.getBlob !== 'function' || !/\.pdf$/.test(d.filename)) {
        balanceMismatches++; console.error(`  ✗ DOC: ${d.number} has no downloadable document`)
      }
    }
  }

  check('no draft/private invoice appears in ANY live portal payload', leaked === 0, `${leaked} leaked`)
  // Anti-vacuity: "nothing leaked" is worthless if there was nothing to leak. When a
  // draft DOES exist this is a real assertion; when the owner simply has none right
  // now it must NOT fail the build — that would make a green suite depend on
  // transient production data, and a guard that cries wolf gets switched off. The
  // predicate itself is pinned unconditionally by verify:portal-canonical, so
  // coverage is not lost on a draft-free day.
  if (checkedDraftWithholding > 0) {
    check(`… and ${checkedDraftWithholding} portal(s) actually HAD a draft withheld (so the check above can fail)`, true)
  } else {
    console.log('  … note: no draft invoice exists right now, so the leak check is vacuous this run')
    console.log('    (the server-side predicate is pinned by npm run verify:portal-canonical)')
  }
  check('every customer-visible invoice is still returned', missing === 0, `${missing} missing`)
  check('no invoice from another customer appears in a payload', foreign === 0, `${foreign} foreign`)
  check('counts, balances and the View/Download contract all hold', balanceMismatches === 0, `${balanceMismatches} mismatch(es)`)
  // 2 + 3: prove the visible set really spans the paid/partial statuses, so
  // "nothing leaked" can never be satisfied by returning nothing.
  check('paid invoices are returned', statusesSeen.has('paid'))
  check('partially-paid invoices are returned', statusesSeen.has('partial'), `saw: ${[...statusesSeen].join(', ')}`)
  // ⚠️ Asserted only when such an invoice EXISTS. This is a live-data probe, and
  // the business had no issued-but-unpaid invoice left on 2026-08-11 (59 paid, 4
  // partial, 2 cancelled, 1 overpaid) — so the guard went red because a customer
  // paid a bill, which is not a regression in anything. Same vacuity handling the
  // draft-withholding check above already uses: a status the data cannot exercise
  // is reported, not failed. The leak direction stays hard-asserted above; this
  // one only exists to prove the visible set isn't empty, and `paid`/`partial`
  // already prove that.
  const unpaidSeen = statusesSeen.has('sent') || statusesSeen.has('unpaid')
  if (unpaidSeen) check('issued-but-unpaid invoices are returned', true)
  else console.log(`  … no issued-but-unpaid invoice exists right now, so that status is unexercised (saw: ${[...statusesSeen].join(', ')})`)
}

main()
  .then(() => {
    if (pass + fail > 0) console.log(`\n${fail === 0 ? '✓' : '✗'} portal RPC checks: ${pass} passed, ${fail} failed`)
    process.exit(fail === 0 ? 0 : 1)
  })
  .catch(e => { console.error(e); process.exit(1) })
