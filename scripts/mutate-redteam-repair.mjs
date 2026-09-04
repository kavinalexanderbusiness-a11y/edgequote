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
const PRES = 'acceptance-presentation'
const CVA = 'current-version-acceptance'

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
    unprovableHere: true,
    from: 'select a.document_fingerprint, a.accepted_amount',
    to: 'select public.quote_material_fingerprint(a.quote_id), a.accepted_amount' },
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

  if (m.unprovableHere) {
    if (red) { missed++; console.log(`  ✗ ${m.name}\n      went RED — it is distinguishable after all; re-read the note in the header`) }
    else { noted++; console.log(`  ⏭ ${m.name}  (green as expected — not distinguishable without a second connection)`) }
    continue
  }
  if (red) { caught++; console.log(`  ✓ ${m.name}`) }
  else { missed++; console.log(`  ✗ ${m.name}\n      verify:${m.guard} stayed GREEN — that check proves nothing`) }
}

console.log(`\n${caught}/${caught + missed} mutations caught` + (noted ? `, ${noted} not provable in a single-backend runtime` : ''))
process.exit(missed > 0 ? 1 : 0)
