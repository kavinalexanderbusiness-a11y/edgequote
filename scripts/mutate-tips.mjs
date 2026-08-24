// ── Mutation harness for verify:tips ─────────────────────────────────────────
// Breaks each load-bearing money boundary ON PURPOSE and proves the guard turns
// red. Run by hand: node scripts/mutate-tips.mjs   (never a verify: entry —
// that would break verify-all's parity contract, and this edits source files).
//
// WHAT IS BEING PROVEN. verify:tips makes one claim: a gratuity is money BESIDE
// the invoice and never money IN it. Every mutation below is a plausible way for
// that to stop being true — the shapes a refactor, a merge, or a well-meaning
// "simplification" actually produces. If the guard does not notice, the guard is
// decoration.
//
// Rules of the harness (learned the hard way elsewhere in this repo):
//   · REFUSES to run on a dirty tree — reverts use `git checkout --`, which
//     destroys uncommitted work indiscriminately.
//   · Every mutation PROVES it applied (content must change) — a splice whose
//     anchor drifted reports NOT APPLIED, never "caught".
//   · A baseline run must be green first; a red baseline proves nothing.
import { execSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const WEBHOOK = 'src/app/api/stripe/webhook/route.ts'
const PAY = 'src/app/api/portal/pay/route.ts'
const TIPS = 'src/lib/payments/tips.ts'
const LEDGER = 'src/lib/payments/ledger.ts'
const MIG = 'supabase/migrations/20260823120000_tips_gratuity_v1.sql'
const TIMELINE = 'src/lib/timeline.ts'
const CONFIG = 'src/lib/stripe/config.ts'
const STATUS = 'src/app/api/payments/status/route.ts'
const PAYMENTS_PAGE = 'src/app/dashboard/payments/page.tsx'
const SELECTOR = 'src/app/portal/[token]/components/TipSelector.tsx'

const MUTATIONS = [
  // ── 1. INVOICE EXCLUSION ───────────────────────────────────────────────────
  // The single most dangerous edit in the feature: the invoice row records the
  // GROSS again, as it did before tips existed. Every tipped invoice silently
  // overpays by the tip.
  {
    file: WEBHOOK,
    why: 'invoice exclusion — the invoice row records the GROSS charge again',
    from: 'amount: invoiceCents / 100,',
    to: 'amount: (s.amount_total ?? 0) / 100,',
  },
  // The split stops happening at all — the tip is declared but never subtracted.
  {
    file: WEBHOOK,
    why: 'invoice exclusion — the gross is never split, so the tip rides into amount_paid',
    from: 'const { invoiceCents, tipCents } = splitGrossCents(s.amount_total ?? 0, s.metadata?.tip_cents)',
    to: 'const invoiceCents = Math.round(s.amount_total ?? 0), tipCents = 0',
  },

  // ── 2. TIP SEPARATION ──────────────────────────────────────────────────────
  // The tip is written as an ordinary payment. The DB trigger then sums it into
  // invoices.amount_paid and the invoice reads 'overpaid'.
  {
    file: WEBHOOK,
    why: "tip separation — the tip leg is written as kind='payment'",
    from: "kind: 'tip', provider: 'stripe', method: 'stripe',",
    to: "kind: 'payment', provider: 'stripe', method: 'stripe',",
  },
  // The DB stops permitting the kind at all — the constraint silently narrows.
  {
    file: MIG,
    why: "tip separation — the kind CHECK drops 'tip', so every tip INSERT fails forever",
    from: "CHECK ((kind = ANY (ARRAY['payment'::text, 'credit'::text, 'refund'::text, 'tip'::text])))",
    to: "CHECK ((kind = ANY (ARRAY['payment'::text, 'credit'::text, 'refund'::text])))",
  },
  // isCashRow starts accepting tips → a gratuity enters every revenue figure.
  {
    file: LEDGER,
    why: 'cash exclusion — isCashRow accepts a tip, putting gratuity into revenue',
    from: "return r.kind === 'payment' && r.status === 'paid' && r.provider !== 'credit'",
    to: "return (r.kind === 'payment' || r.kind === 'tip') && r.status === 'paid' && r.provider !== 'credit'",
  },
  // The classifier stops naming tips → they render as "Payment" everywhere.
  {
    file: 'src/lib/payments/analytics.ts',
    why: "row naming — ledgerRowType stops recognising 'tip' and calls it a Payment",
    from: "if (r.kind === 'tip') return amt >= 0 ? 'Tip' : 'Tip refunded'",
    to: "if (false) return amt >= 0 ? 'Tip' : 'Tip refunded'",
  },

  // ── 3. SERVER DERIVATION ───────────────────────────────────────────────────
  // The browser's number goes straight to Stripe.
  {
    file: PAY,
    why: 'server derivation — the raw client tip is passed through unvalidated',
    from: 'const tip = resolveTipCents(body.tipCents, { chargeCents, config: tips, tippable: !charge.isDeposit })',
    to: 'const tip = { cents: Number(body.tipCents) || 0, rejected: undefined as undefined }',
  },
  // The ceiling disappears — an absurd tip is accepted.
  {
    file: TIPS,
    why: 'abuse ceiling — the maximum stops applying, so any amount is chargeable',
    from: "if (n > ceiling) return { cents: 0, rejected: 'over-maximum' }",
    to: "if (false) return { cents: 0, rejected: 'over-maximum' }",
  },
  // Integer discipline drops — fractional cents and NaN survive.
  {
    file: TIPS,
    why: 'precision — a fractional-cent / NaN tip is no longer rejected',
    from: "if (!Number.isFinite(n) || !Number.isSafeInteger(n)) return { cents: 0, rejected: 'not-an-integer' }",
    to: "if (false) return { cents: 0, rejected: 'not-an-integer' }",
  },
  // A rejected tip stops failing the request and silently charges something else.
  {
    file: PAY,
    why: 'rejection honesty — an invalid tip is silently dropped instead of 400ing',
    from: 'if (tip.rejected) {',
    to: 'if (false && tip.rejected) {',
  },
  // The split trusts an oversized declaration → a NEGATIVE invoice payment.
  {
    file: TIPS,
    why: 'clamp — an oversized tip declaration books a negative invoice payment',
    from: 'const tip = Number.isFinite(raw) && raw > 0 ? Math.min(raw, gross) : 0',
    to: 'const tip = Number.isFinite(raw) && raw > 0 ? raw : 0',
  },

  // ── 4. TIPPABILITY ─────────────────────────────────────────────────────────
  // A deposit ask starts carrying a tip: Stripe's total stops matching the
  // number already texted to the customer.
  {
    file: PAY,
    why: 'deposit rule (server) — a communicated deposit ask starts carrying a tip',
    from: 'tippable: !charge.isDeposit',
    to: 'tippable: true',
  },
  {
    file: 'src/app/portal/[token]/components/BillingTab.tsx',
    why: 'deposit rule (UI) — the selector is offered on a deposit charge',
    from: 'const canTip = canPay && actions.tips.enabled && !d.payIsDeposit',
    to: 'const canTip = canPay && actions.tips.enabled',
  },

  // ── 5. TENANT SCOPE / CAPABILITY ───────────────────────────────────────────
  // The capability check disappears from the charge door: a tenant with no
  // online_payments grant has its customers charged into the deployment's one
  // Stripe account.
  {
    file: PAY,
    why: 'capability — the tenant grant stops gating the charge door',
    from: 'if (!(await tenantCapabilities(admin, invoice.user_id)).onlinePayments) {',
    to: 'if (false) {',
  },
  // The portal is told about tips even when payments are off — fail-open.
  {
    file: STATUS,
    why: 'capability — the tip config leaks out even when payments are disabled',
    from: 'tips: enabled ? tips : TIPS_OFF,',
    to: 'tips,',
  },
  // The capability is resolved from the CLIENT rather than the token's owner.
  {
    file: STATUS,
    why: 'tenant scope — the owner stops being resolved from the portal token',
    from: ".eq('token', portalToken).eq('revoked', false).maybeSingle()",
    to: ".eq('revoked', false).limit(1).maybeSingle()",
  },
  // Tips-off stops meaning tips-off.
  {
    file: TIPS,
    why: 'owner consent — tipConfig ignores tips_enabled and turns tips on for everyone',
    from: 'if (!settings?.tips_enabled) return TIPS_OFF',
    to: 'if (false) return TIPS_OFF',
  },

  // ── 6. WEBHOOK IDEMPOTENCY ─────────────────────────────────────────────────
  // The tip leg stops deduping — a redelivered Stripe event records the tip twice.
  {
    file: WEBHOOK,
    why: 'idempotency — the tip leg reuses the payment row key, so one leg vanishes',
    from: 'stripe_session_id: tipSessionKey(s.id),',
    to: 'stripe_session_id: s.id,',
  },
  {
    file: TIPS,
    why: 'idempotency — the tip refund key stops encoding the cumulative amount',
    from: '`refund-tip:${chargeId}:${Math.round(cumulativeRefundedCents)}`',
    to: '`refund-tip:${chargeId}`',
  },
  {
    file: TIPS,
    why: 'idempotency — the tip key collides with the invoice refund LIKE lookup',
    from: "export const tipRefundKey = (chargeId: string, cumulativeRefundedCents: number) =>\n  `refund-tip:${chargeId}:${Math.round(cumulativeRefundedCents)}`",
    to: "export const tipRefundKey = (chargeId: string, cumulativeRefundedCents: number) =>\n  `refund:${chargeId}:tip${Math.round(cumulativeRefundedCents)}`",
  },
  // A failed tip write is swallowed instead of making Stripe retry.
  {
    file: WEBHOOK,
    why: 'durability — a failed tip write 200s, losing the gratuity silently',
    from: "console.error('[stripe] tip upsert failed:', tipRes.error.message)\n            return NextResponse.json({ error: 'db write failed' }, { status: 500 })",
    to: "console.error('[stripe] tip upsert failed:', tipRes.error.message)",
  },

  // ── 7. REFUNDS ─────────────────────────────────────────────────────────────
  // The refund stops being apportioned: a full refund of a tipped charge books
  // the gross against the invoice, reopens a settled balance, and the payment
  // chaser starts texting a customer who was just paid back.
  {
    file: WEBHOOK,
    why: 'refund apportionment — the gross is booked entirely against the invoice',
    from: 'const { invoiceDelta, tipDelta, basis } = apportionRefund({',
    to: 'const invoiceDelta = Math.round((refunded - alreadyInvoice) * 100) / 100, tipDelta = 0, basis = "tip-first"; const _u = ({',
  },
  {
    file: TIPS,
    why: 'refund cap — more tip is reversed than was ever collected',
    from: 'const tipRemaining = Math.max(0, round2(tipRecorded - doneTip))',
    to: 'const tipRemaining = Number.MAX_SAFE_INTEGER',
  },
  {
    file: TIPS,
    why: 'refund idempotency — a redelivered refund event reverses the money again',
    from: 'const outstanding = round2(refunded - doneInvoice - doneTip)',
    to: 'const outstanding = round2(refunded)',
  },
  // A failed apportionment read becomes a guess that writes money.
  {
    file: WEBHOOK,
    why: 'refund honesty — a failed split read is treated as "no tip" and guesses',
    from: 'if (priorErr || tipErr) {',
    to: 'if (false) {',
  },
  // The dispute branch starts writing a reversal automatically.
  {
    file: WEBHOOK,
    why: 'dispute restraint — the split read is taken from the Stripe charge payload',
    from: ".eq('user_id', p.user_id).eq('stripe_payment_intent', piId).eq('kind', 'tip')\n        const disputedTip",
    to: ".eq('user_id', p.user_id).eq('stripe_payment_intent', piId).eq('kind', 'tip')\n        void ch.metadata\n        const disputedTip",
  },

  // ── 7b. EXPLICIT VS GUESSED SCOPE ─────────────────────────────────────────
  // The exact-match rules are what demote tip-first to a last resort. Losing
  // them silently restores the old wrong case: a service-only refund eating the
  // gratuity.
  {
    file: TIPS,
    why: 'exact match — a service-only refund goes back to eating the tip',
    from: '  if (invoiceRemaining > 0 && eq(outstanding, invoiceRemaining) && !eq(tipRemaining, invoiceRemaining)) {',
    to: '  if (false) {',
  },
  {
    file: TIPS,
    why: 'exact match — a tip-only refund stops being recognised as one',
    from: '  if (tipRemaining > 0 && eq(outstanding, tipRemaining) && !eq(tipRemaining, invoiceRemaining)) {',
    to: '  if (false) {',
  },
  {
    file: TIPS,
    why: 'a TIE is treated as evidence, so an ambiguous refund claims to be exact',
    from: 'eq(outstanding, tipRemaining) && !eq(tipRemaining, invoiceRemaining)',
    to: 'eq(outstanding, tipRemaining)',
  },
  {
    file: WEBHOOK,
    why: 'the webhook stops telling the engine what the invoice actually received',
    from: 'invoiceRecorded: Number(p.amount) || 0,',
    to: 'invoiceRecorded: 0,',
  },
  {
    file: WEBHOOK,
    why: 'a guessed split is reported as though it had been matched exactly',
    from: "refundBasis === 'tip-first'",
    to: 'false',
  },
  // ── 7c. OWNER-ORIGINATED EXPLICIT REFUNDS ─────────────────────────────────
  {
    file: LEDGER,
    why: 'owner tip refund — the tip leg is written as a PAYMENT, moving amount_paid',
    from: "rows.push({ ...common, amount: -tipAmt, provider: 'refund', kind: 'tip'",
    to: "rows.push({ ...common, amount: -tipAmt, provider: 'refund', kind: 'payment'",
  },
  {
    file: LEDGER,
    why: 'owner tip refund — the live tip cap disappears, so more tip can be given back than was taken',
    from: '    if (tipAmt > held + 0.005) {',
    to: '    if (false) {',
  },
  {
    file: LEDGER,
    why: 'owner tip refund — a failed tip read is spent as "no tip", turning the cap into no cap',
    from: 'if (held === null) return { error: ',
    to: 'if (false) return { error: ',
  },
  {
    file: LEDGER,
    why: 'tipHeldOnInvoice reports 0 instead of null on a failed read',
    from: 'if (error) return null',
    to: 'if (error) return 0',
  },
  {
    file: 'src/components/payments/InvoicePaymentControls.tsx',
    why: 'the owner form collapses both legs into one number again',
    from: 'amount: Number(refundAmount) || 0, tipAmount: Number(refundTip) || 0',
    to: 'amount: Number(refundAmount) || 0',
  },

  // ── 8. STRIPE SESSION ──────────────────────────────────────────────────────
  // The tip is folded into the invoice line item: the customer sees one bigger
  // "Invoice N" charge and the webhook has no declaration to split on.
  {
    file: CONFIG,
    why: 'checkout honesty — the tip is folded into the invoice line item',
    from: "form.set('line_items[1][price_data][product_data][name]', 'Tip')",
    to: "form.set('line_items[1][price_data][product_data][name]', 'Service')",
  },
  {
    file: CONFIG,
    why: 'the split declaration — session metadata stops carrying the tip',
    from: "form.set('metadata[tip_cents]', String(tipCents))",
    to: "form.set('metadata[tip_cents_x]', String(tipCents))",
  },
  {
    file: CONFIG,
    why: 'session expiry — the 30-minute window is widened back to a day',
    from: "form.set('expires_at', String(Math.floor(Date.now() / 1000) + 30 * 60))",
    to: "form.set('expires_at', String(Math.floor(Date.now() / 1000) + 24 * 60 * 60))",
  },

  // ── 9. DOWNSTREAM READERS ──────────────────────────────────────────────────
  // The deposit-coverage walk goes back to an exclusion list: a tip counts
  // toward covering a deposit ask it has nothing to do with.
  {
    file: TIMELINE,
    why: 'deposit coverage — a tip counts toward covering the deposit ask',
    from: "if (p.status !== 'paid' || p.kind !== 'payment' || !p.invoice_id) continue",
    to: "if (p.status !== 'paid' || p.kind === 'credit' || !p.invoice_id) continue",
  },
  {
    file: PAYMENTS_PAGE,
    why: 'export completeness — the Tip Amount column disappears, making the CSV lossy',
    from: "{ label: 'Tip Amount', value: r => tipAmountOf(r) || '' },",
    to: '',
  },
  {
    file: PAYMENTS_PAGE,
    why: 'reporting honesty — tips are folded into the cash summary',
    from: '<StatTile label="Tips" value={formatCurrency(tips.net)} tone="accent" />',
    to: '<StatTile label="Collected" value={formatCurrency(summary.collected + tips.net)} tone="accent" />',
  },

  // ── 10. NO DARK PATTERNS ───────────────────────────────────────────────────
  // A tip is pre-selected, or the copy starts pressuring.
  {
    file: 'src/app/portal/[token]/components/BillingTab.tsx',
    why: 'no pre-selection — a 20% tip is ticked before the customer chooses',
    from: "useState<TipChoice>({ kind: 'none' })",
    to: "useState<TipChoice>({ kind: 'preset', percent: 20 })",
  },
  {
    file: SELECTOR,
    why: 'no guilt copy — social pressure is added to the selector',
    from: 'Entirely optional, and it goes to the business on top of your invoice',
    to: 'Most customers tip 20%. It goes to the business on top of your invoice',
  },
  {
    // Anchored on the JSX attribute, not the bare word: the file's header
    // comment also says `inputMode="decimal"`, and a bare anchor mutated the
    // COMMENT instead — proving nothing while reporting MISSED.
    file: SELECTOR,
    why: 'phone input — the money field stops opening a numeric keypad',
    from: '              type="text"\n              inputMode="decimal"',
    to: '              type="text"\n              inputMode="text"',
  },
  {
    file: SELECTOR,
    why: 'touch target — the tip chips shrink below 44px',
    from: "'tap-target-y rounded-xl border px-3 py-2.5 text-left transition-colors',",
    to: "'rounded-xl border px-3 py-2.5 text-left transition-colors',",
  },
]

const md5 = (s) => createHash('md5').update(s).digest('hex')
// Resolve tsx's real cli from its package.json, the way verify-all does —
// the .bin shim breaks under spawnSync on Windows.
const tsxPkg = JSON.parse(readFileSync('node_modules/tsx/package.json', 'utf8'))
const TSX_CLI = 'node_modules/tsx/' + (typeof tsxPkg.bin === 'string' ? tsxPkg.bin : tsxPkg.bin.tsx)
const run = () => spawnSync(process.execPath, [TSX_CLI, 'scripts/verify-tips.ts'], { encoding: 'utf8' })

const files = [...new Set(MUTATIONS.map(m => m.file))]
const dirty = execSync('git status --porcelain -- ' + files.map(f => `"${f}"`).join(' '), { encoding: 'utf8' }).trim()
if (dirty) {
  console.error('✗ refusing to run: mutation targets have uncommitted changes\n' + dirty)
  process.exit(2)
}

const baseline = run()
if (baseline.status !== 0) {
  console.error('✗ baseline is already red — a mutation proves nothing. Fix the guard first.')
  console.error((baseline.stdout || '').split('\n').filter(l => l.includes('✗')).join('\n'))
  process.exit(2)
}
console.log(`baseline green — ${MUTATIONS.length} mutations\n`)

let caught = 0, missed = 0, notApplied = 0
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8')
  const normalized = original.replace(/\r\n/g, '\n')          // CRLF disarms literal anchors
  const mutated = normalized.replace(m.from, m.to)
  if (md5(mutated) === md5(normalized)) {
    notApplied++
    console.log(`  ⚠ NOT APPLIED — ${m.why}\n      anchor not found in ${m.file}`)
    continue
  }
  writeFileSync(m.file, mutated, 'utf8')
  const res = run()
  execSync(`git checkout -- "${m.file}"`)
  if (res.status !== 0) { caught++; console.log(`  ✓ caught — ${m.why}`) }
  else { missed++; console.log(`  ✗ MISSED — ${m.why}`) }
}

console.log(`\n${caught}/${MUTATIONS.length} mutations caught`
  + (missed ? ` · ${missed} MISSED` : '') + (notApplied ? ` · ${notApplied} NOT APPLIED` : ''))
process.exit(missed || notApplied ? 1 : 0)
