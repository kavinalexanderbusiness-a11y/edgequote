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

import { portalDataSql, baselineFile } from './lib/schema-source'
import { createClient } from '@supabase/supabase-js'
import { readFileSync, existsSync } from 'node:fs'
import { normalizePortal, buildPortalView, type DocBlobRenderers, type PortalData } from '../src/app/portal/[token]/model'
import { invoiceBalance } from '../src/lib/payments/ledger'
import type { InvoiceStatus } from '../src/types'

for (const line of existsSync('.env.local') ? readFileSync('.env.local', 'utf8').split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
}

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
// Coverage output. Deliberately has NO access to `pass`/`fail` — what the live book
// happens to contain today must never be able to decide the exit code.
const report = (m: string) => console.log(`  · ${m}`)
// A token grants portal access. Never let one reach a log.
const redact = (t: string) => `${t.slice(0, 4)}…${t.slice(-2)}`

// THE visibility rule, in one place. Invoice statuses are pinned identically by the
// DB CHECK constraint (invoices_status_check) and src/types/index.ts:
//   draft | unpaid | sent | partial | paid | overpaid | cancelled
// `draft` is the owner's private work-in-progress. Everything else is a bill the
// customer is entitled to read — `cancelled` included, so a withdrawn charge is
// explainable rather than silently gone. Same rule the RPC already applied to quotes.
const PRIVATE_STATUSES = new Set<string>(['draft'])
const isCustomerVisible = (status: string) => !PRIVATE_STATUSES.has(status)

/**
 * COMPILE-TIME exhaustiveness over the status vocabulary.
 *
 * The runtime tripwires below catch a list that was emptied; this catches the
 * opposite and quieter drift — a NEW status added to InvoiceStatus that the fixture
 * never exercises. `tsc` refuses to build this file until the new status is either
 * listed as customer-visible or declared private, so the guard cannot silently fall
 * behind the vocabulary it is guarding.
 */
type CoveredStatus = 'sent' | 'unpaid' | 'partial' | 'paid' | 'overpaid' | 'cancelled'
type UncoveredStatus = Exclude<InvoiceStatus, CoveredStatus | 'draft'>
const _everyStatusIsAccountedFor: UncoveredStatus[] = []
void _everyStatusIsAccountedFor

const renderers: DocBlobRenderers = { quote: async () => new Blob(['q']), invoice: async () => new Blob(['i']), acceptedQuote: async () => new Blob(['a']) }

// ── The invariant, proven WITHOUT depending on today's book ──────────────────
//
// ⭐⭐ THE BOOK IS NOT A FIXTURE. Three checks at the end of this file used to read
//
//     check('issued-but-unpaid invoices are returned', statusesSeen.has('sent') || …)
//
// which is an EXISTENCE claim over live production data wearing an invariant's
// clothes. On 2026-08-11 the owner's book held 59 paid, 4 partial, 2 cancelled and
// 1 overpaid invoice — and not one issued-but-unpaid row — so the suite went red
// because a customer had PAID A BILL. Meanwhile `paid` and `partial` passed on that
// same run purely by luck, one settled invoice away from doing the same thing. A
// guard that flips with the day's trading teaches everyone to ignore it, which costs
// more than the check was ever worth.
//
// ⚠️ A first fix (main, 2026-08-11) softened only the `sent` line to a console.log
// when the status was absent. That removes the flake but ALSO removes the claim on
// exactly the days it cannot be observed — the guard stops proving the thing it is
// named for — and it left the other two as the same coin flip. Softening the
// assertion was the wrong axis: the problem was never the strictness, it was
// sourcing the evidence from a book that changes under you.
//
// This is not a new lesson in this file: the draft-withholding check above was
// already fixed for exactly this, and its comment says why. The fix was simply
// never carried across to its three siblings. It is now.
//
// The claim is real and is kept whole — it is just proven in the two places it
// actually lives, neither of which needs a particular row to exist today:
//
//   SERVER  the RPC's invoice filter is an EXCLUSION — `status <> 'draft'` — so no
//           non-draft status CAN be dropped. Pinned as text by verify:portal-canonical
//           and, from the other side, by the allowlist tripwire below: an allowlist
//           creeping into that select is the one edit that would silently stop
//           returning a 'sent' invoice.
//   CONSUMER a fixture payload shaped exactly like get_portal_data's output, driven
//           through the REAL model and ledger, proving an issued-but-unpaid invoice
//           survives normalize → view → doc item with its money intact.
//
// Both run ALWAYS — including on a machine with no credentials, which until now
// proved nothing at all. What is left of the live sweep is COVERAGE: reported,
// never asserted.

/** Shaped like get_portal_data's json payload, minimal but complete. */
const fixture = (invoices: PortalData['invoices']): PortalData => ({
  customer: { id: 'c-fix', name: 'Fixture Customer', email: null, phone: null, address: null, city: null },
  business: { company_name: 'Fixture Co', owner_name: null, phone: null, email_primary: null, email_secondary: null, website: null, logo_url: null, logo_scale: null, base_address: null, terms_text: null, gst_percent: 0 },
  property: null, properties: [], quotes: [], invoices, jobs: [], recurrences: [], photos: [], payments: [],
})

const inv = (over: Partial<PortalData['invoices'][number]>): PortalData['invoices'][number] => ({
  id: 'i-fix', invoice_number: 'INV-FIXTURE', service_type: 'Mowing', amount: 100, status: 'sent',
  issued_date: '2026-07-01', due_date: '2026-07-15', notes: null, address: null, property_id: null,
  line_items: null, job_id: null, created_at: '2026-07-01T10:00:00Z', amount_paid: 0, ...over,
})

/**
 * Every status a customer is entitled to read, proven end-to-end on a fixture.
 * `sent` and `unpaid` are the two spellings of issued-but-unpaid that the DB CHECK
 * constraint allows, and both must arrive — that is the claim the deleted assertion
 * was making, now made deterministically.
 */
function checkVisibleStatusesSurviveTheModel() {
  const ISSUED_UNPAID: InvoiceStatus[] = ['sent', 'unpaid']
  const VISIBLE: InvoiceStatus[] = [...ISSUED_UNPAID, 'partial', 'paid', 'overpaid', 'cancelled']

  // Silent-cap tripwires. Emptying either list above removes the proof WITHOUT
  // failing anything — the loops simply stop running, and a guard that covers
  // nothing reports the same green as one that covers everything. (Mutation-testing
  // this repair is what found it: `ISSUED_UNPAID = []` passed.)
  check('the fixture covers both spellings of issued-but-unpaid',
    ISSUED_UNPAID.length === 2 && ISSUED_UNPAID.includes('sent') && ISSUED_UNPAID.includes('unpaid'),
    `covers: ${ISSUED_UNPAID.join(', ') || 'NOTHING'}`)
  check('…and every customer-visible status, none quietly dropped',
    VISIBLE.length === 6 && new Set(VISIBLE).size === 6 && !VISIBLE.some(s => PRIVATE_STATUSES.has(s)),
    `covers: ${VISIBLE.join(', ')}`)

  const pd = normalizePortal(JSON.parse(JSON.stringify(fixture(
    VISIBLE.map((status, n) => inv({
      id: `i-${status}`, invoice_number: `INV-${status.toUpperCase()}`, status,
      amount: 100, amount_paid: status === 'partial' ? 40 : status === 'paid' ? 100 : status === 'overpaid' ? 120 : 0,
      due_date: `2026-07-${String(10 + n).padStart(2, '0')}`,
    })),
  ))))
  if (!pd) { check('the fixture payload normalises at all', false); return }

  // normalizePortal is the first place a status could be silently dropped.
  check('every customer-visible status survives normalizePortal',
    VISIBLE.every(s => pd.invoices.some(i => i.status === s)),
    `kept: ${pd.invoices.map(i => i.status).join(', ')}`)

  const view = buildPortalView(pd, '2026-07-20', renderers)
  const shownIds = new Set(view.docItems.filter(d => d.kind === 'invoice').map(d => d.rawId))
  check('…and reaches the customer as a document they can open',
    VISIBLE.every(s => shownIds.has(`i-${s}`)),
    `missing: ${VISIBLE.filter(s => !shownIds.has(`i-${s}`)).join(', ') || 'none'}`)

  // The point of the deleted check, made deterministic: an issued-but-unpaid
  // invoice is not merely PRESENT, it still asks for its money.
  for (const s of ISSUED_UNPAID) {
    const d = view.docItems.find(x => x.rawId === `i-${s}`)!
    check(`an issued-but-unpaid ('${s}') invoice is returned AND still payable`,
      !!d && d.payAmount === 100 && d.balance === 100,
      d ? `payAmount=${d.payAmount}, balance=${d.balance}` : 'absent')
  }
  // …and the settled one is not asking again — the same engine, opposite verdict,
  // so "everything is payable" cannot be what makes the line above pass.
  const paid = view.docItems.find(x => x.rawId === 'i-paid')
  check('…while a settled invoice asks for nothing', !!paid && paid.payAmount === 0,
    paid ? `payAmount=${paid.payAmount}` : 'absent')
}

/**
 * The one server-side edit that would silently stop returning issued-but-unpaid
 * invoices: swapping the exclusion for an allowlist. verify:portal-canonical pins
 * that `status <> 'draft'` is PRESENT; this pins that nothing narrower replaces it.
 */
function checkServerFilterIsAnExclusionNotAnAllowlist() {
  // The SAME definition verify:portal-canonical treats as the one true one — now
  // the generated baseline rather than the retired hand-maintained canonical file.
  const sql = portalDataSql().replace(/\r\n?/g, '\n')
  if (!sql) { check('canonical portal SQL found in the baseline', false); return }
  const sel = sql.slice(sql.indexOf('from public.invoices'), sql.indexOf('from public.invoices') + 200)
  check('the invoice filter EXCLUDES draft rather than allow-listing statuses',
    /status\s*<>\s*'draft'/.test(sel) && !/status\s+in\s*\(/i.test(sel) && !/status\s*=\s*'/.test(sel),
    `an allowlist here silently drops every status nobody remembered — saw: ${sel.split('\n')[0]}`)
}

async function main() {
  // Deterministic first, and unconditionally — these need no database, no
  // credentials and no particular invoice to exist, so they hold on every machine
  // and on every day's book.
  console.log('\n  deterministic (no live data required):')
  checkVisibleStatusesSurviveTheModel()
  checkServerFilterIsAnExclusionNotAnAllowlist()
  checkTheTransientDependencyCannotComeBack()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const email = process.env.PORTAL_RPC_OWNER_EMAIL
  const password = process.env.PORTAL_RPC_OWNER_PASSWORD
  if (!url || !anonKey || !email || !password) {
    console.log('  … live sweep SKIPPED — no Supabase/owner credentials (set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, PORTAL_RPC_OWNER_EMAIL, PORTAL_RPC_OWNER_PASSWORD to run)')
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
  // ⭐ COVERAGE, NOT A VERDICT. What the live book happened to contain today is
  // reported so a reader can see how much of the payload was exercised for real —
  // and is deliberately NOT fed to check(). `report` has no access to the pass/fail
  // counters, which is the mechanism that keeps it that way: reinstating the old
  // behaviour would mean calling check() here again, which the tripwire below
  // refuses. The invariant itself is proven in `deterministic` above.
  //
  // Note "nothing leaked" is still not vacuous: `missing === 0` is a for-all over
  // whatever the book DOES hold, and it fails the moment a visible invoice goes
  // absent — that is the anti-vacuity the existence checks were reaching for.
  const spanned = ['sent', 'unpaid', 'partial', 'paid', 'overpaid', 'cancelled'].filter(s => statusesSeen.has(s))
  report(`live coverage: the book exercised ${spanned.length}/6 customer-visible statuses (${spanned.join(', ') || 'none'})`)
  if (!statusesSeen.has('sent') && !statusesSeen.has('unpaid')) {
    report('note: no issued-but-unpaid invoice exists in the book right now, so the live')
    report('      sweep could not exercise one. Proven deterministically above instead.')
  }
}

/**
 * The old defect, made structurally unable to return.
 *
 * ⚠️ This greps this guard's own source, which is the shape that made
 * verify:public-edge report the cure as the disease — so it reads CODE ONLY. The
 * prose above quotes the deleted `check(… statusesSeen.has('sent') …)` line on
 * purpose, and that explanation must never be what fails the build.
 */
function checkTheTransientDependencyCannotComeBack() {
  const self = readFileSync(__filename, 'utf8')
    .replace(/\r\n?/g, '\n')                       // `.` does not match \r — a CRLF
    .replace(/\/\*[\s\S]*?\*\//g, ' ')             // checkout would strip nothing
    .split('\n').map(l => l.replace(/^\s*\/\/[^\n]*/, '')).join('\n')
  check('no live-data status tally is wired to a pass/fail check',
    !/check\([^)]*statusesSeen/.test(self),
    'an existence claim over the production book is a coin flip, not an invariant')
  check('…and the coverage reporter cannot fail the run',
    /const report = \(m: string\) => console\.log/.test(self))
}

main()
  .then(() => {
    if (pass + fail > 0) console.log(`\n${fail === 0 ? '✓' : '✗'} portal RPC checks: ${pass} passed, ${fail} failed`)
    process.exit(fail === 0 ? 0 : 1)
  })
  .catch(e => { console.error(e); process.exit(1) })
