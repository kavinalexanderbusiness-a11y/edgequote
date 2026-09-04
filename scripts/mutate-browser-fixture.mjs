// ── Mutation harness for the S122 browser fixture ────────────────────────────
//   node scripts/mutate-browser-fixture.mjs
//
// A fixture is a claim about what a reviewer will see. This breaks the claim on
// purpose, in the two directions that matter:
//
//   · FIXTURE DRIFT — the page stops being safe or stops being real (its locks
//     removed, its transport made permissive, its control flipped, a sentence
//     retyped into it). A fixture that can be quietly turned into a mock-up is
//     worse than none, because it looks like evidence.
//   · PRODUCT REGRESSION — the repair itself is reverted. This is the one that
//     proves the fixture is wired to the product and not to itself: revert
//     `legacy_unrecorded`'s presentation or the `payable` verdict, and the
//     RENDERED scenes must go red without anyone opening a browser.
//
// ⛔ verify:browser-fixture renders components in Node. It is not a browser pass
// and this harness does not make it one — it only proves the checks can fail.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = 'src/app/dev/s122-fixture/page.tsx'
const CLIENT = 'src/app/dev/s122-fixture/S122Fixture.tsx'
const RULES = 'src/lib/quoteAcceptance.ts'
const MODEL = 'src/app/portal/[token]/model.ts'
const CDP = 'scripts/s122-fixture-cdp.mjs'
const G = 'browser-fixture'

const MUTATIONS = [
  // ── The fixture stops being safe ──────────────────────────────────────────
  { name: 'the production lock is removed', file: PAGE,
    from: "  if (process.env.NODE_ENV === 'production') notFound()", to: '' },
  { name: 'the deliberate opt-in is removed', file: PAGE,
    from: "  if (process.env.S122_FIXTURE !== '1') notFound()", to: '' },
  { name: 'the transport stops being deny-by-default', file: CLIENT,
    from: '    onViolation({ url, method })\n    throw new Error(`S122 fixture: refusing a real request to ${method} ${url}`)',
    to: '    return json({ ok: true }, 200)' },

  // ── The fixture stops being honest ────────────────────────────────────────
  { name: 'the honest control is flipped (payments switched off)', file: CLIENT,
    from: '    paymentsEnabled: true,', to: '    paymentsEnabled: false,' },
  { name: 'a component-owned sentence is retyped into the fixture', file: CLIENT,
    from: '        <h1 className="text-xl font-bold">S122 browser fixture</h1>',
    to: '        <h1 className="text-xl font-bold">S122 browser fixture — on your behalf</h1>' },
  { name: 'the browser run stops treating a blank page as a failure', file: CDP,
    from: '    fail(`PAGE DID NOT RENDER at ${path} (${len} chars)`,', to: '    ok(`PAGE DID NOT RENDER at ${path} (${len} chars)`) || fail(`x`,' },

  // ── ⭐ The PRODUCT regresses — the rendered scenes must notice ─────────────
  { name: '⭐ PRODUCT · legacy speaks as an owner attestation again', file: RULES,
    from: "  if (evidence === 'legacy_unrecorded') return 'evidenced_legacy'",
    to: "  if (evidence === 'legacy_unrecorded') return 'evidenced_on_behalf'" },
  { name: '⭐ PRODUCT · the blocked deposit becomes payable again', file: MODEL,
    from: '      payable: facing.depositChargeBlock === null,', to: '      payable: true,' },
  { name: '⭐ PRODUCT · the unproven snapshot is shown again', file: RULES,
    from: "  if (presentation === 'evidenced_customer' || presentation === 'evidenced_on_behalf') {",
    to: "  if (presentation === 'evidenced_customer' || presentation === 'evidenced_on_behalf' || presentation === 'evidenced_legacy' || presentation === 'unevidenced') {" },
  // ⭐⭐ The one the fixture exists for. On an ACCEPTED quote the timing sentence
  // is not rendered in the portal at all, so the raw-quote regression only lands
  // on the PDF — which is why the seam is instrumented rather than assumed.
  { name: '⭐ PRODUCT · the customer’s PDF is handed the raw quote again', file: MODEL,
    from: 'renderers.quote(moneyQuote)', to: 'renderers.quote(qq)' },
  { name: '⭐ PRODUCT · the model’s timing sentence takes the raw quote again', file: MODEL,
    from: 'paymentTiming(moneyQuote,', to: 'paymentTiming(qq,' },
]

const crlf = (s, src) => (/\r\n/.test(src) ? s.replace(/\n/g, '\r\n') : s)
let caught = 0, missed = 0

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
  try { execFileSync('npx', ['tsx', `scripts/verify-${G}.ts`], { cwd: ROOT, stdio: 'pipe', shell: true }) }
  catch { red = true }
  writeFileSync(path, orig, 'utf8')
  if (red) { caught++; console.log(`  ✓ ${m.name}`) }
  else { missed++; console.log(`  ✗ ${m.name}\n      verify:${G} stayed GREEN — that check proves nothing`) }
}

console.log(`\n${caught}/${caught + missed} mutations caught`)
process.exit(missed > 0 ? 1 : 0)
