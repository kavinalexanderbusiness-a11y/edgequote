// ── Does verify:recurring-quote-flow actually catch anything? ────────────────
//   node scripts/mutate-recurring-quote-flow.mjs
//
// A guard that passes is worthless until you have watched it fail. Each mutation
// below is a real bug someone could plausibly introduce while "simplifying" this
// feature — and several are the exact collapse the separations exist to prevent:
//
//   MEASUREMENT ≠ PRICE ≠ COMMERCIAL OFFERING ≠ BILLING TERM
//               ≠ OPERATIONAL RECURRENCE ≠ SERVICE TRIGGER ≠ CONTRACT TERM
//
// The guard must go RED for every one, and the tree must be byte-identical
// afterwards.
//
// ⚠️ COMMIT BEFORE RUNNING. This rewrites source files in place and restores them
// from the copy it took; a crash between the two leaves the tree mutated, and an
// uncommitted change would be unrecoverable.
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const MUTATIONS = [
  // ── 1. A BILLING TERM DRIVES OPERATIONAL RECURRENCE ────────────────────────
  // The collapse this whole feature is against: "$240/month" quietly becoming
  // "one visit a month" because someone wired the term to the scheduler.
  {
    file: 'src/lib/recurringOffering.ts',
    name: 'billing term drives recurrence (the seam imports a scheduling engine)',
    from: "import { MIN_QUOTE_OPTIONS, MAX_QUOTE_OPTIONS, type OptionLike } from '@/lib/quoteOptions'",
    to: "import { MIN_QUOTE_OPTIONS, MAX_QUOTE_OPTIONS, type OptionLike } from '@/lib/quoteOptions'\nimport { recurrenceEligibilityFor } from '@/lib/serviceRecurrence'",
  },
  // ── 2. A SEASONAL PLAN MANUFACTURES A SCHEDULE ─────────────────────────────
  // A seasonal plan HAS dates. The temptation to turn them into visits is the
  // whole reason term_start/term_end were nearly not built at all.
  {
    file: 'src/lib/recurringOffering.ts',
    name: 'seasonal plan manufactures a schedule (an offering grows a visit count)',
    from: '    termText: termText(source),\n    isRecommended: p.isRecommended,',
    to: '    termText: termText(source),\n    visitCount: 4,\n    isRecommended: p.isRecommended,',
  },
  // ── 3. A SERVICE NAME DECIDES BEHAVIOUR ────────────────────────────────────
  // The product becomes a landscaping app again the moment this compiles.
  {
    file: 'src/lib/recurringOffering.ts',
    name: 'service-name keyword behaviour appears in the pricing path',
    from: 'export function offerable(offerings: Offering[] | null | undefined): Offering[] {',
    to: 'const WINTER = /snow|ice/i\nexport function offerable(offerings: Offering[] | null | undefined): Offering[] {',
  },
  // ── 4. AN UNCONFIGURED PLAN BECOMES A $0 QUOTE ─────────────────────────────
  // Not a cheap quote. A wrong one.
  {
    file: 'src/lib/recurringOffering.ts',
    name: 'unconfigured $0 becomes a quote (unpriced offerings stop being filtered)',
    from: '  return (offerings || []).filter(o => o.price != null)',
    to: '  return (offerings || [])',
  },
  {
    file: 'src/lib/recurringOffering.ts',
    name: 'unknown price is coerced to zero on the way to a customer option',
    from: '    price: o.price as number,',
    to: '    price: o.price ?? 0,',
  },
  // ── 5. THE SNAPSHOT STOPS BEING FROZEN ─────────────────────────────────────
  // An owner raising a rate next winter must not rewrite what a customer already
  // accepted.
  {
    file: 'src/lib/measurePricing.ts',
    name: 'plan snapshot changes after a Price Book edit (the rate is not copied)',
    from: 'rate: input.plan?.rate ?? null,',
    to: 'rate: null,',
  },
  {
    file: 'src/lib/measurePricing.ts',
    name: 'the snapshot forgets which term it was sold on',
    from: 'term: input.plan?.term ?? null,',
    to: 'term: null,',
  },
  // ── 6. AN INTERNAL NOTE LEAKS ──────────────────────────────────────────────
  // The pre-send preview is a rehearsal of what the CUSTOMER receives.
  {
    file: 'src/components/quotes/QuoteBuilder.tsx',
    name: 'internal note leaks into the owner preview (which rehearses the customer view)',
    from: "          {String(notes || '').trim() && (",
    to: "          {String(internalNotes || '').trim() && (",
  },
  // ── 7. AN UNSELLABLE PLAN BECOMES SELECTABLE ───────────────────────────────
  // There is no is_enabled on a plan — the row existing IS the offer — so the
  // "inactive plan" failure takes the only shape available: a plan with no
  // usable rate becoming pickable.
  {
    file: 'src/components/quotes/ServiceOfferings.tsx',
    name: 'inactive (rate-less) plan becomes selectable',
    from: '                  disabled={unpriced}',
    to: '                  disabled={false}',
  },
  // ── 8. AN ARCHIVED SERVICE BECOMES SELECTABLE ──────────────────────────────
  {
    file: 'src/components/quotes/QuoteBuilder.tsx',
    name: 'inactive service becomes selectable in the quote builder',
    from: '                  templates={activeTemplates}',
    to: '                  templates={templates}',
  },
  // ── 9. MONTHLY IS READ AS A MONTHLY VISIT ──────────────────────────────────
  // The suffix is what the customer reads. "/visit" on a monthly plan says the
  // $240 buys one attendance.
  {
    file: 'src/lib/measurePricing.ts',
    name: 'monthly plan reinterpreted as a monthly VISIT',
    from: "  { key: 'monthly', label: 'Monthly', priceSuffix: '/month' },",
    to: "  { key: 'monthly', label: 'Monthly', priceSuffix: '/visit' },",
  },
  // ── 10. AN ADD-ON BECOMES A CHANGE ORDER ───────────────────────────────────
  // An add-on is chosen BEFORE approval; a change order is agreed AFTER.
  // Different tables, different times, different consent.
  {
    file: 'src/lib/recurringOffering.ts',
    name: 'add-on is conflated with a change order',
    from: 'export type OfferingMode = ',
    to: 'export type ChangeOrderAddon = { addon: string }\nexport type OfferingMode = ',
  },
  // ── 11. THE OPTION TOTAL DIVERGES FROM CANONICAL PRICING ───────────────────
  // Two multiplications is how the map and the builder come to disagree by a
  // dollar nobody can explain.
  {
    file: 'src/lib/recurringOffering.ts',
    name: 'option total differs from canonical pricing (a second multiplication)',
    from: '    price: p.price,\n    priceText: formatPlanPrice(p),',
    to: '    price: p.price == null ? null : Math.round(p.price * 1.05),\n    priceText: formatPlanPrice(p),',
  },

  // ── Beyond the brief: the regressions this session actually fixed ──────────
  {
    file: 'src/lib/recurringOffering.ts',
    name: 'the customer description reverts to the owner-facing provenance string',
    from: "  return [o.customerNote, o.termText].filter(Boolean).join(' · ')",
    to: '  return o.basisText',
  },
  {
    file: 'src/lib/recurringOffering.ts',
    name: 'a default promise ships with the product',
    from: "  return [o.customerNote, o.termText].filter(Boolean).join(' · ')",
    to: "  return [o.customerNote ?? 'Pay only when service occurs.', o.termText].filter(Boolean).join(' · ')",
  },
  {
    file: 'src/lib/recurringOffering.ts',
    name: 'the starting price competes with configured plans again',
    from: "  if (plans?.length) return 'configured_plans'",
    to: "  if (plans?.length && false) return 'configured_plans'",
  },
  {
    file: 'src/components/pricing/MeasurePricingEditor.tsx',
    name: 'the plan editor is re-gated on the service being measured',
    from: '      <div className="space-y-2 pt-1">',
    to: '      {measured && (\n      <div className="space-y-2 pt-1">',
  },
  {
    file: 'src/components/pricing/MeasurePricingEditor.tsx',
    name: 'an unmeasured service can be given a per-unit rate that prices nothing',
    from: "      if (!measured) next.basis = 'flat'",
    to: '      if (false) next.basis = \'flat\'',
  },
  {
    file: 'src/components/quotes/ServiceOfferings.tsx',
    name: 'the panel stops saying that billing is not scheduling',
    from: '          <p className="text-[11px] text-ink-faint">{BILLING_VS_VISITS}</p>',
    to: '          <p className="text-[11px] text-ink-faint">{null}</p>',
  },
  {
    file: 'supabase/migrations/20260827120000_commercial_plan_presentation.sql',
    name: 'a new plan column is made NOT NULL (forcing existing plans to invent a value)',
    from: '  add column if not exists "customer_note" text;',
    to: '  add column if not exists "customer_note" text not null;',
  },
  {
    file: 'supabase/migrations/20260827120000_commercial_plan_presentation.sql',
    name: 'the term fields are restricted to seasonal plans (product logic in the schema)',
    from: '    check ("term_start" is null or "term_end" is null or "term_end" >= "term_start");',
    to: '    check ("term" = \'seasonal\');',
  },
]

let caught = 0
let missed = 0
const skipped = []

// ⚠️⚠️ CRLF DISARMS A MULTI-LINE ANCHOR. These files are checked out with CRLF on
// Windows (git says so on every write: "LF will be replaced by CRLF"), while the
// anchors above are written with \n. An exact `includes()` therefore misses any
// anchor spanning more than one line, and the mutation reports SKIP — which reads
// like a stale anchor and is really a mutation that silently stopped running.
// A guard nobody is mutating is a guard nobody is checking.
const rx = s => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\r?\n/g, '\\r?\\n'))

for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8')
  const anchor = rx(m.from)
  if (!anchor.test(original)) {
    skipped.push(m.name)
    console.log(`⚠️  SKIP  ${m.name}\n         anchor not found in ${m.file} — the mutation is stale, not the guard`)
    continue
  }
  writeFileSync(m.file, original.replace(anchor, m.to.replace(/\$/g, '$$$$')))
  let red = false
  try {
    execSync('npm run verify:recurring-quote-flow', { stdio: 'pipe' })
  } catch {
    red = true
  } finally {
    writeFileSync(m.file, original)
  }
  if (red) { caught++; console.log(`✓ CAUGHT  ${m.name}`) }
  else { missed++; console.log(`✗ MISSED  ${m.name}\n         the guard passed with this bug in place`) }
}

// The tree must be exactly as we found it.
const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim()
console.log(`\n${caught} caught · ${missed} missed · ${skipped.length} skipped`)
console.log(dirty ? `\n⚠️  TREE NOT RESTORED:\n${dirty}` : '\n✓ tree restored byte-for-byte')
process.exit(missed === 0 && skipped.length === 0 && !dirty ? 0 : 1)
