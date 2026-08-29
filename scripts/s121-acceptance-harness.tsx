// ── Session 121 acceptance-surface harness ───────────────────────────────────
//   tsx scripts/s121-acceptance-harness.tsx <outdir>
//
// Renders the REAL acceptance components to static markup, wrapped in the REAL
// compiled Tailwind CSS, so headless Chrome can lay them out and MEASURE them at
// 375 / 390 / 430 / desktop. Same pattern as scripts/qb-harness.tsx.
//
// ⭐ WHY A HARNESS AND NOT THE RUNNING APP. Every surface here is driven by
// schema this session deliberately has NOT applied — quote_acceptances, the
// state RPC, the gate. Against production the components would render their
// "no acceptance on record" branch and nothing else, and a proof that measured
// that would be measuring the wrong screen (the exact failure qb-harness's own
// header warns about). The harness supplies the states the database cannot yet
// produce; the DATABASE behaviour is proved separately and exhaustively by
// verify:quote-acceptance-integrity against a Postgres built from these very
// migrations.
//
// ⛔ What this proves: layout, reachability and wording at each width.
// ⛔ What it does NOT prove: that the RPCs work. That is the guard's job, and
// saying otherwise would be the "green report, wrong screen" failure again.

import { renderToStaticMarkup } from 'react-dom/server'
import { writeFileSync, readdirSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { RecordAcceptanceDialog } from '../src/components/quotes/RecordAcceptanceDialog'
import { OverrideStatusDialog } from '../src/components/quotes/OverrideStatusDialog'
import { Banner } from '../src/components/ui/Banner'
import {
  acceptanceSentence, reapprovalSentence, materialChanges, TERMS_ACK_LABEL,
  type AcceptanceState, type AcceptedDocument,
} from '../src/lib/quoteAcceptance'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'

const outdir = process.argv[2] || '.s121'
mkdirSync(outdir, { recursive: true })

const cssDir = '.next/static/css'
const css = readdirSync(cssDir).filter(f => f.endsWith('.css'))
  .map(f => readFileSync(join(cssDir, f), 'utf8')).join('\n')

const TERMS = 'Payment is due on completion. Cancellations need 24 hours notice. '
  + 'We are insured to $2,000,000 and all crew are WCB covered.'

const DOC: AcceptedDocument = {
  quote_number: 'Q-1042', customer_name: 'Dana Reyes', address: '12 Elm St SW, Calgary',
  service_type: 'Lawn care', notes: 'Front and back, gate code 4417',
  initial_price: 5400, travel_fee: 150, total: 5550,
  plan_prices: { weekly: 60, biweekly: 90, monthly: 140 },
  deposit_type: 'percent', deposit_value: 20,
  option: { id: 'o2', name: 'Standard', price: 5400 },
  options_offered: [{ id: 'o1', name: 'Budget', price: 3900 }, { id: 'o2', name: 'Standard', price: 5400 }],
  addons: [], services: [],
}

const base = (over: Partial<AcceptanceState> = {}): AcceptanceState => ({
  accepted: true, acceptance_id: 'a1', acceptance_seq: 1,
  accepted_at: '2026-08-20T10:00:00Z', kind: 'customer', source: 'portal',
  actor_label: 'Dana Reyes', on_behalf_reason: null, accepted_amount: 5550,
  selected_option_id: 'o2', document: DOC, terms_acknowledged: true,
  needs_reapproval: false, terms_changed: false, ...over,
})

const LIVE_DRIFTED = {
  initial_price: 6075, travel_fee: 150, total: 6225,
  service_type: 'Lawn care', address: '12 Elm St SW, Calgary', notes: 'Front and back, gate code 4417',
  weekly_price: 60, biweekly_price: 90, monthly_price: 140,
  deposit_type: 'percent', deposit_value: 30, selected_option_id: 'o2',
  options: [{ id: 'o1', name: 'Budget', price: 3900 }, { id: 'o2', name: 'Standard', price: 6075 }],
  addons: [], services: [],
}

const noop = () => {}
const noopAsync = async () => true

/** The three acceptance banner states the quote page renders. */
function Banners() {
  const drifted = base({ needs_reapproval: true })
  const changes = materialChanges(DOC, LIVE_DRIFTED)
  return (
    <div className="max-w-5xl mx-auto space-y-6 p-4">
      {/* E/I — a standing acceptance, said in the record's own words. */}
      <div data-probe="banner-standing">
        <Banner tone="info" icon={CheckCircle2}>
          <span className="font-semibold text-ink">{acceptanceSentence('accepted', base())}</span>
          <span className="text-ink-muted"> Aug 20, 2026.</span>
          <span className="block mt-1 text-xs text-ink-muted">
            The terms in force at that moment are stored with the acceptance — editing your terms in Settings will not change them.
          </span>
        </Banner>
      </div>
      {/* F — changes require reapproval, itemised. */}
      <div data-probe="banner-reapproval">
        <Banner tone="warn" icon={AlertTriangle}>
          <span className="font-semibold text-ink">Changes require reapproval.</span>{' '}
          {reapprovalSentence(drifted, changes)}
          <span className="block mt-1.5 text-xs text-ink-muted">
            {changes.map(c => (
              <span key={c.what} className="block">
                {c.what}: <span className="text-ink-faint">{c.was ?? '—'}</span> → <span className="text-ink">{c.now ?? '—'}</span>
              </span>
            ))}
          </span>
          <span className="block mt-1.5 text-xs text-ink-muted">
            The original acceptance stays on the record either way — reapproving adds to the history, it never replaces it.
          </span>
        </Banner>
      </div>
      {/* D — a hand-set status, which must never read as consent. */}
      <div data-probe="banner-unevidenced">
        <Banner tone="warn" icon={AlertTriangle}>
          <span className="font-semibold text-ink">No customer acceptance on record.</span>{' '}
          This quote’s status was set by hand. If they did accept it, record that so the
          amount, the date and how they told you are all on file.
        </Banner>
      </div>
      {/* C (rendered) — an owner-recorded acceptance never claims the portal. */}
      <div data-probe="banner-on-behalf">
        <Banner tone="info" icon={CheckCircle2}>
          <span className="font-semibold text-ink">
            {acceptanceSentence('accepted', base({
              kind: 'owner_on_behalf', source: 'dashboard',
              actor_label: 'Sam Owner', on_behalf_reason: 'phone',
            }))}
          </span>
        </Banner>
      </div>
      {/* The backfilled book — names nobody, because nobody was recorded. */}
      <div data-probe="banner-legacy">
        <Banner tone="info" icon={CheckCircle2}>
          <span className="font-semibold text-ink">
            {acceptanceSentence('accepted', base({
              kind: 'legacy_unrecorded', source: 'migration',
              actor_label: 'Recorded before EdgeHQ kept acceptance evidence',
              terms_acknowledged: false,
            }))}
          </span>
        </Banner>
      </div>
    </div>
  )
}

/** J + C — the owner's "Record customer acceptance" door, with terms shown. */
function RecordDialog() {
  return (
    <div data-probe="record-dialog">
      <RecordAcceptanceDialog
        open onClose={noop} quoteId="q1" quoteNumber="Q-1042" customerName="Dana Reyes"
        travelFee={150} total={5550}
        options={[
          { id: 'o1', name: 'Budget', price: 3900 },
          { id: 'o2', name: 'Standard', price: 5400, is_recommended: true },
          { id: 'o3', name: 'Premium — full seasonal package', price: 7100 },
        ]}
        presetOptionId={null} termsText={TERMS} selectedAddonsTotal={0}
        onRecorded={noop}
      />
    </div>
  )
}

/** D — the administrative override, which must say it is not an acceptance. */
function OverrideDialog() {
  return (
    <div data-probe="override-dialog">
      <OverrideStatusDialog
        open onClose={noop} quoteNumber="Q-1042" currentStatus="sent" onOverride={noopAsync}
      />
    </div>
  )
}

/** J — the customer's terms acknowledgement, above the Accept button. */
function PortalTerms() {
  return (
    <div className="max-w-2xl mx-auto p-4" data-probe="portal-terms">
      <div className="mb-3 rounded-xl border border-border bg-bg-tertiary/40 px-3.5 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Scope &amp; terms</p>
        <p className="text-xs text-ink-muted whitespace-pre-wrap mt-1.5 max-h-40 overflow-y-auto">{TERMS}</p>
        <label className="flex items-start gap-2.5 mt-3 cursor-pointer min-h-[44px] items-center">
          <input type="checkbox" className="mt-0.5 w-4 h-4 shrink-0" />
          <span className="text-xs text-ink">{TERMS_ACK_LABEL}</span>
        </label>
      </div>
      <button className="w-full sm:w-auto inline-flex items-center justify-center gap-2 font-medium rounded-xl min-h-[44px] px-4 bg-accent text-white opacity-50">
        Accept Standard — $5,550.00
      </button>
      <p className="text-[11px] text-ink-faint mt-1.5">
        Please tick to confirm you agree to the quoted scope and terms.
      </p>
    </div>
  )
}

const SCENES: [string, React.ReactElement][] = [
  ['owner-banners', <Banners key="b" />],
  ['owner-record-acceptance', <RecordDialog key="r" />],
  ['owner-override-status', <OverrideDialog key="o" />],
  ['portal-terms-accept', <PortalTerms key="p" />],
]

for (const [name, node] of SCENES) {
  const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
<style>html,body{margin:0;background:var(--bg,#0b0f14);}</style>
</head><body>${renderToStaticMarkup(node)}</body></html>`
  writeFileSync(join(outdir, `${name}.html`), html)
  console.log(`  wrote ${name}.html`)
}
