// ── Mutation harness for the S122 red-team repair ────────────────────────────
//   node scripts/mutate-redteam-repair.mjs
//
// Three defects were found in S122 by independent review, and each is repaired
// below. This proves the guards that cover them can actually FAIL: every entry
// reverts ONE repaired behaviour and the named guard must go red.
//
// ⭐ Why this file exists at all. Three separate checks in this lane have already
// been found green-by-accident — a corpus that agreed with itself, a guard that
// tested a SIMULATION of the route it was guarding, and a file-wide toast COUNT
// that was hiding seven real gaps. A guard nobody has broken on purpose is a
// guess about what it covers.
//
// ⏭ One entry is marked `unprovableHere`. It is NOT a gap in the guard: PGlite
// compiles a single Postgres backend, so no statement can interleave between the
// evidence INSERT and the assertion that follows it, and the two spellings under
// test are indistinguishable by construction. It is asserted to stay GREEN, so
// the day a multi-connection runtime makes it distinguishable, this line is where
// that shows up.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODEL = 'src/app/portal/[token]/model.ts'
const RULES = 'src/lib/quoteAcceptance.ts'
const S122D = 'supabase/proposals/RUN-S122D-owner-confirm-current-acceptance.sql'
const S122E = 'supabase/proposals/RUN-S122E-recorded-version-must-match.sql'
const CHARGE = 'src/app/api/portal/quote-deposit/route.ts'
const RECORD = 'src/app/api/quotes/record-acceptance/route.ts'
const OWNER = 'src/app/dashboard/quotes/[id]/page.tsx'
const BILLING = 'src/app/portal/[token]/components/BillingTab.tsx'
const PRES = 'acceptance-presentation'
const CVA = 'current-version-acceptance'
const AUTH = 'deposit-charge-authority'

const MUTATIONS = [
  // ── Blocker 1 · the partial strip: $250 on the card, $700 in the sentence ──
  { name: 'B1 · paymentTiming gets the raw quote again (THE reported defect)', file: MODEL, guard: PRES,
    from: 'paymentTiming(moneyQuote,', to: 'paymentTiming(qq,' },
  { name: 'B1 · the deposit gate gets the raw quote', file: MODEL, guard: PRES,
    from: 'schedulingGate(moneyQuote,', to: 'schedulingGate(qq,' },
  { name: 'B1 · the customer’s own PDF gets the raw quote', file: MODEL, guard: PRES,
    from: 'renderers.quote(moneyQuote)', to: 'renderers.quote(qq)' },
  { name: 'B1 · the strip becomes unconditional (S121’s snapshot silently lost)', file: RULES, guard: PRES,
    from: 'moneyQuote: isAcceptedAmount ? q : ({ ...q, accepted_price: null } as T),',
    to: 'moneyQuote: ({ ...q, accepted_price: null } as T),' },
  { name: 'B1 · the strip never fires (the pre-S122 behaviour)', file: RULES, guard: PRES,
    from: 'moneyQuote: isAcceptedAmount ? q : ({ ...q, accepted_price: null } as T),',
    to: 'moneyQuote: q,' },

  // ── Blocker 2 · legacy_unrecorded speaking as a known owner attestation ────
  { name: 'B2 · legacy speaks as an owner attestation again (THE reported defect)', file: RULES, guard: PRES,
    from: "if (evidence === 'legacy_unrecorded') return 'evidenced_legacy'",
    to: "if (evidence === 'legacy_unrecorded') return 'evidenced_on_behalf'" },
  { name: 'B2 · legacy borrows the on-behalf sentence', file: RULES, guard: PRES,
    from: "return 'Accepted before we started keeping acceptance records — who accepted it, and when, isn’t on file. The price above is this quote’s current price.'",
    to: "return 'This is the amount your acceptance was recorded at by the business, on your behalf.'" },
  { name: 'B2 · a legacy row licenses the unproven snapshot', file: RULES, guard: PRES,
    from: "if (presentation === 'evidenced_customer' || presentation === 'evidenced_on_behalf') {",
    to: "if (presentation === 'evidenced_customer' || presentation === 'evidenced_on_behalf' || presentation === 'evidenced_legacy') {" },
  { name: 'B2 · legacy falls through to the no-record-at-all wording', file: RULES, guard: PRES,
    from: "if (presentation === 'evidenced_legacy') return legacyAcceptanceNote()",
    to: "if (presentation === 'evidenced_legacy') return unevidencedAcceptanceNote()" },

  // ── Blocker 3 · the version recorded was not the version checked ───────────
  { name: 'B3 · the writer stops asserting the stored fingerprint (THE reported defect)', file: S122E, guard: CVA,
    from: 'if v_expect_fp is not null and v_stored_fp is distinct from v_expect_fp then',
    to: 'if false and v_expect_fp is not null and v_stored_fp is distinct from v_expect_fp then' },
  { name: 'B3 · S122D stops arming the expectation', file: S122D, guard: CVA,
    from: "perform set_config('app.quote_expected_fingerprint', v_fp, true);",
    to: "perform set_config('app.quote_expected_fingerprint', '', true);" },
  { name: 'B3 · the amount clause is removed', file: S122E, guard: CVA,
    from: 'if v_expect_amt is not null\n         and abs(coalesce(v_stored_amt, 0) - v_expect_amt::numeric) > 0.005 then',
    to: 'if false and v_expect_amt is not null\n         and abs(coalesce(v_stored_amt, 0) - v_expect_amt::numeric) > 0.005 then' },
  { name: 'B3 · the markers are never consumed (they leak into the next write)', file: S122E, guard: CVA,
    from: "      perform set_config('app.quote_expected_fingerprint', '', true);\n      perform set_config('app.quote_expected_amount', '', true);",
    to: '      -- markers deliberately left armed' },
  { name: 'B3 · the anchor is allowed to match zero times', file: S122E, guard: CVA,
    from: "v_old := '  ) returning id into v_id;';",
    to: "v_old := '  ) returning id into v_id -- nope;';" },
  // ⏭ Expected-green: see the header. Nothing can commit between the INSERT and
  // the assertion in a single-backend runtime, so reading the stored value and
  // re-deriving it return the same answer here. The choice still matters in
  // production — re-deriving would roll back an attestation that a LATER edit
  // invalidated, which is the opposite error — and that is argued, not measured.
  { name: 'B3 · the writer re-derives instead of reading what it STORED', file: S122E, guard: CVA,
    expectGreen: 'not distinguishable without a second connection (PGlite is single-backend)',
    from: 'select a.document_fingerprint, a.accepted_amount',
    to: 'select public.quote_material_fingerprint(a.quote_id), a.accepted_amount' },

  // ── Defect 4 · only an actor-named acceptance may authorize a charge ───────
  { name: 'D4 · the charge door stops asking who is named (THE reported defect)', file: CHARGE, guard: AUTH,
    from: '  if (facing.depositChargeBlock) {', to: '  if (false && facing.depositChargeBlock) {' },
  { name: 'D4 · a legacy row is allowed to authorize money again', file: RULES, guard: AUTH,
    from: "  if (p === 'evidenced_legacy') return 'unknown_provenance'",
    to: "  if (p === 'evidenced_legacy') return null" },
  { name: 'D4 · an unreadable acceptance table is treated as permission', file: CHARGE, guard: AUTH,
    from: "  if (accErr) return NextResponse.json({ error: 'We couldn’t start the payment — please try again in a moment.' }, { status: 502 })",
    to: '  if (accErr) { /* carry on regardless */ }' },
  // ⏭ Expected-green, and the reason IS the fix: once the block above stands,
  // every quote that reaches the gate is evidenced — and for an evidenced quote
  // `facing.moneyQuote` IS `quote`, because nothing was stripped. The two
  // spellings are equivalent by construction, which is precisely what closes the
  // defect. Asserted green so that the day it goes red, the block has moved.
  { name: 'D4 · the charge prices the raw row instead of the shared basis', file: CHARGE, guard: AUTH,
    expectGreen: 'equivalent by construction — past the block, moneyQuote IS the quote',
    from: '  const gate = schedulingGate(facing.moneyQuote, (payRows as GateLedgerRow[]) || [])',
    to: '  const gate = schedulingGate(quote, (payRows as GateLedgerRow[]) || [])' },
  { name: 'D4 · the portal offers a Pay button the door will refuse', file: MODEL, guard: AUTH,
    from: '      payable: facing.depositChargeBlock === null,', to: '      payable: true,' },
  { name: 'D4 · the headline CTA stops checking payable', file: MODEL, guard: AUTH,
    from: "d.schedulingDeposit?.payable && !d.schedulingDeposit.satisfied",
    to: 'd.schedulingDeposit && !d.schedulingDeposit.satisfied' },
  { name: 'D4 · Billing renders the button instead of the reason', file: BILLING, guard: AUTH,
    from: '          {!d.schedulingDeposit.payable ? (', to: '          {false ? (' },

  // ── Defect 4 · and the owner must not be trapped by the refusal ────────────
  { name: 'D4 · S122D refuses a legacy row again, trapping the owner', file: S122D, guard: AUTH,
    from: "    if v_prev.kind <> 'legacy_unrecorded' then",
    to: "    if true then" },
  { name: 'D4 · the owner route counts a legacy row as a recorded acceptance', file: RECORD, guard: AUTH,
    from: "      .in('kind', ACTOR_NAMED_ACCEPTANCE_KINDS)", to: '' },
  { name: 'D4 · the repair panel needs a price move again (the old dead end)', file: RECORD, guard: AUTH,
    from: '    if (isAcceptedOrBeyond(qq.status) && (count ?? 0) === 0) {',
    to: '    if (isAcceptedOrBeyond(qq.status) && (count ?? 0) === 0 && drifted) {' },
  { name: 'D4 · the panel tells an owner their quote "changed" when it did not', file: RECORD, guard: AUTH,
    from: "        repairKind: drifted ? 'revised' : 'unnamed',", to: "        repairKind: 'revised'," },

  // ── Defect 4 · the owner-sent PDF is a customer document ──────────────────
  { name: 'D4 · the owner-sent PDF goes back to the raw quote', file: OWNER, guard: AUTH,
    from: '      const blob = await renderQuoteBlob(facing.moneyQuote, settings, services, options)',
    to: '      const blob = await renderQuoteBlob(quote, settings, services, options)' },
  { name: 'D4 · the owner is told the customer can pay when they cannot', file: OWNER, guard: AUTH,
    from: '                {chargeBlock\n                  ? depositChargeBlockedOwnerNote(chargeBlock)\n                  : scheduledStillOwed',
    to: '                {false\n                  ? depositChargeBlockedOwnerNote(chargeBlock)\n                  : scheduledStillOwed' },
]

const crlf = (s, src) => (/\r\n/.test(src) ? s.replace(/\n/g, '\r\n') : s)
let caught = 0, missed = 0, noted = 0

for (const m of MUTATIONS) {
  const path = join(ROOT, m.file)
  const orig = readFileSync(path, 'utf8')
  const needle = crlf(m.from, orig)
  const hits = orig.split(needle).length - 1
  if (hits !== 1) {
    missed++
    console.log(`  ✗ ${m.name}\n      anchor matched ${hits} times — the mutation never applied, so nothing was tested`)
    continue
  }
  writeFileSync(path, orig.replace(needle, crlf(m.to, orig)), 'utf8')
  let red = false
  try {
    execFileSync('npx', ['tsx', `scripts/verify-${m.guard}.ts`], { cwd: ROOT, stdio: 'pipe', shell: true })
  } catch { red = true }
  writeFileSync(path, orig, 'utf8')

  if (m.expectGreen) {
    if (red) { missed++; console.log(`  ✗ ${m.name}\n      went RED — it IS distinguishable after all, so the stated reason no longer holds: ${m.expectGreen}`) }
    else { noted++; console.log(`  ⏭ ${m.name}  green as expected — ${m.expectGreen}`) }
    continue
  }
  if (red) { caught++; console.log(`  ✓ ${m.name}`) }
  else { missed++; console.log(`  ✗ ${m.name}\n      verify:${m.guard} stayed GREEN — that check proves nothing`) }
}

console.log(`\n${caught}/${caught + missed} mutations caught` + (noted ? `, ${noted} asserted green with a stated reason` : ''))
process.exit(missed > 0 ? 1 : 0)
