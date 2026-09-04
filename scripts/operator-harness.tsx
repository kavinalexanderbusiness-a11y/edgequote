// ── Operator measurement harness (investigation tool, not a guard) ──────────
// Renders the REAL <OperatorClient/> to static markup in the states that only
// appear when something is degraded — the states a signed-in browser pass on a
// healthy account never shows, and the ones this lane's last two fixes created.
//
// Same posture as dayactions-harness/inbox-harness: the component takes its
// whole world as one prop (`initial: OperatorDashboardSnapshot`), so the states
// below are ordinary values. NOTHING in the shipping component is changed to
// make this possible — that props seam already existed.
//
// ⚠️ TWO LIMITS, both real:
//   1. STATIC MARKUP RUNS NO EFFECTS. <EvidenceAge/> formats after mount (the
//      server and the viewer can be in different timezones), so its line is
//      EMPTY here by construction. Its absence in this output is correct, not a
//      regression — a browser pass is the only thing that can check it.
//   2. LAYOUT NEEDS THE COMPILED CSS. Tailwind classes mean nothing without the
//      stylesheet, so without `.next/static/css` this output proves STRUCTURE
//      AND COPY only, never overflow or tap-target size. The build slot is
//      held; when it runs, re-run this and the measurement below becomes real.
//
// Usage:
//   npx tsx --tsconfig tsconfig.harness.json scripts/operator-harness.tsx .operator-harness
//   node scripts/prove-dayactions-mobile.mjs .operator-harness    # 375/390/430
// (the prove script takes the dir as argv[2] and discovers scenarios from the
//  .html files in it, so it needs no changes to cover these.)

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://placeholder.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'placeholder-anon-key-for-build-only'

import { renderToStaticMarkup } from 'react-dom/server'
import { writeFileSync, readdirSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { OperatorClient } from '../src/components/operator/OperatorClient'
import type { OperatorActionCard, OperatorDashboardSnapshot } from '../src/lib/operator/types'

const outdir = process.argv[2] || '.operator-harness'
mkdirSync(outdir, { recursive: true })

// Tolerant on purpose: the harness must be runnable while the build slot is
// held. Without CSS it still proves the four states render the right copy.
const cssDir = '.next/static/css'
const css = existsSync(cssDir)
  ? readdirSync(cssDir).filter(f => f.endsWith('.css')).map(f => readFileSync(join(cssDir, f), 'utf8')).join('\n')
  : ''
if (!css) console.warn('⚠️  no .next/static/css — emitting UNSTYLED markup. Structure/copy only; re-run after a build to measure layout.')

// Realistic, not lorem: a long business name and a real-shaped address are what
// actually push a card off the right edge at 375.
const card = (over: Partial<OperatorActionCard> = {}): OperatorActionCard => ({
  id: 'balance:1', priority: 'high', category: 'money',
  title: 'Constantinopoulos Property Management Ltd. — $1,240.50 overdue',
  summary: 'The canonical invoice status is overdue: a balance remains and the due date is in the past.',
  why_it_matters: 'Confirmed overdue money is actionable.',
  evidence: [{ record_type: 'invoice', record_id: 'INV-2026-0188', label: 'INV-2026-0188', detail: 'stored=sent; display=overdue; paid=0.00; balance=1240.50', relevant_date: '2026-08-11', amount: 1240.5 }],
  financial_value: 1240.5,
  recommended_action: 'Review the invoice and communication before preparing a collection reminder.',
  requires_approval: true, customer_contact_required: true,
  record_references: [{ type: 'invoice', id: 'INV-2026-0188', href: '/dashboard/invoices?invoice=INV-2026-0188' },
    { type: 'customer', id: 'c1', href: '/dashboard/customers/c1' }],
  data_quality_warnings: [],
  ...over,
})

const snapshot = (over: Partial<OperatorDashboardSnapshot> = {}): OperatorDashboardSnapshot => ({
  morning: '4 high-priority items need review. $1,240.50 is canonically overdue. Start with customer-risk items before routine data cleanup.',
  afternoon: '6 items remain in the evidence-backed queue. Re-check new inbound messages and accepted work without linked visits before the day ends.',
  cards: [card(), card({ id: 'lead:1', category: 'messages', title: 'Bhattacharya-Wojciechowski, Priya may need a reply', summary: 'An unanswered website lead is waiting since 2026-08-30.', financial_value: null })],
  totalCards: 12,
  generated_at: '2026-09-04T15:04:00.000Z',
  readIncomplete: false,
  automationWarning: null,
  recentRuns: [],
  historyAvailable: true,
  ...over,
})

// The four states named for verification, plus the one S121 called out where
// they coincide — setup incomplete AND a tool degraded at the same time.
const scenarios: Record<string, OperatorDashboardSnapshot> = {
  'unavailable-history': snapshot({ historyAvailable: false }),
  'partial-tool-reads': snapshot({ readIncomplete: true }),
  'multiple-warnings': snapshot({
    cards: [card({ data_quality_warnings: [
      'A CRM conversation flag cannot prove whether a phone call, personal text, or in-person reply happened. Confirm before contacting the customer.',
      'Fee/tax settings could not be loaded; balance classification may be incomplete.',
      'This quote has no known price; do not describe $0 as a real value.',
    ] })],
  }),
  // The category sentence exactly as getAutomationHealth now composes it — no
  // raw platform text, which is the whole point of the F3 fix.
  'global-error-category': snapshot({
    automationWarning: 'The latest platform-wide automation sweep failed (a permission problem). The details are in the server log.',
  }),
  'worst-case-combined': snapshot({
    historyAvailable: false, readIncomplete: true,
    automationWarning: 'The latest platform-wide automation sweep failed (a missing database object). The details are in the server log.',
    cards: [card({ data_quality_warnings: ['Fee/tax settings could not be loaded; balance classification may be incomplete.', 'A positive balance is not automatically overdue.'] })],
    totalCards: 30,
  }),
}

for (const [name, initial] of Object.entries(scenarios)) {
  const body = renderToStaticMarkup(
    <div data-theme="dark" className="bg-bg text-ink min-h-screen p-4">
      <OperatorClient initial={initial} />
    </div>,
  )
  writeFileSync(join(outdir, `${name}.html`),
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>${body}`)
  console.log(`  ✓ ${name}.html`)
}
console.log(`\n${Object.keys(scenarios).length} scenarios → ${outdir}${css ? '' : '  (UNSTYLED — structure/copy only)'}`)
