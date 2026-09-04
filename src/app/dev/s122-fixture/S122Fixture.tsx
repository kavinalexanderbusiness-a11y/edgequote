'use client'

// ── The S122 browser fixture ─────────────────────────────────────────────────
//
// ⭐⭐ WHAT MAKES THIS A PROOF AND NOT A MOCK-UP. Every pixel below is drawn by
// the SHIPPING components — `BillingTab` and `RecordAcceptanceDialog`, imported
// from where the app imports them — fed through the SHIPPING model
// (`buildPortalView`). Nothing here re-implements a rule, a sentence or a figure.
// If the repair changes, this page changes with it; if someone reverts the
// repair, this page shows the defect again.
//
// The only thing that is faked is the WIRE. `window.fetch` is replaced with a
// deny-by-default stub that answers exactly two routes with the exact shapes
// those routes return, and THROWS on anything else. That is what lets an owner's
// confirmation flow be driven in a browser without a database, a session, or a
// single real request — and the violation list it keeps is rendered on the page,
// so a run that quietly reached the network cannot pass.
//
// ⛔ It records nothing, charges nothing, and sends nothing. There is no Supabase
// client on this page and no credential of any kind.

import { useMemo, useRef, useState } from 'react'
import { buildPortalView, type DocBlobRenderers } from '@/app/portal/[token]/model'
import type { PortalActions } from '@/app/portal/[token]/components/shared'
import { BillingTab } from '@/app/portal/[token]/components/BillingTab'
import { RecordAcceptanceDialog } from '@/components/quotes/RecordAcceptanceDialog'
import { Toaster } from '@/components/ui/Toaster'
import {
  fixtureData, FIXTURE_TODAY, UNNAMED_ANSWER, REVISED_ANSWER, type FixtureKind,
} from './fixtureData'

// ── The deny-by-default transport ───────────────────────────────────────────
// ⛔ A permissive mock would be the whole safety story undone: one unmocked URL
// and the fixture starts making real requests from a browser someone left signed
// in. So the default is REFUSAL, and every refusal is recorded and displayed.
type Violation = { url: string; method: string }

function installFetchStub(
  answerFor: () => typeof UNNAMED_ANSWER | typeof REVISED_ANSWER,
  onViolation: (v: Violation) => void,
) {
  if (typeof window === 'undefined') return
  const w = window as Window & { __s122FixtureFetch?: boolean }
  if (w.__s122FixtureFetch) return
  w.__s122FixtureFetch = true

  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()

    // The ordinary owner action — answered with the route's real refusal shape.
    if (url.includes('/api/quotes/record-acceptance')) return json(answerFor(), 409)
    // The explicit attestation — answered as the route answers a success.
    if (url.includes('/api/quotes/confirm-current-acceptance')) {
      return json({ ok: true, acceptanceId: 'zz-acceptance-1', amount: answerFor().currentAmount, idempotent: false }, 200)
    }

    // ⛔ EVERYTHING ELSE IS REFUSED, LOUDLY. Recorded first so the page can show
    // it even though the throw stops the caller.
    onViolation({ url, method })
    throw new Error(`S122 fixture: refusing a real request to ${method} ${url}`)
  }
}

/** Every action is inert and self-reporting. None of them can reach a network. */
function inertActions(record: (what: string) => void): PortalActions {
  const noop = (what: string) => () => record(what)
  const noopAsync = (what: string) => async () => { record(what); return false }
  return {
    token: 'zz-fixture-token',
    accept: noop('accept'),
    accepting: null,
    pay: noop('pay'),
    payingId: null,
    // ⛔ If a Pay-deposit button is ever rendered on a blocked scene, this fires
    // and the page says so — the fixture cannot silently pass a wrong screen.
    payQuoteDeposit: noop('payQuoteDeposit'),
    payingQuoteId: null,
    savePreference: noopAsync('savePreference'),
    // ⭐⭐ THE HONEST CONTROL. Payments are ON and nothing is pending, so a missing
    // Pay button can only be caused by the acceptance rule under test. With these
    // false, the blocked scene would pass for entirely the wrong reason.
    paymentsEnabled: true,
    paymentPending: false,
    request: noopAsync('request'),
    submitRequest: noopAsync('submitRequest') as PortalActions['submitRequest'],
    uploadRequestPhotos: async () => { record('uploadRequestPhotos'); return { paths: [], failed: 0 } },
    photoUrl: () => '',
    markInvoiceViewed: noop('markInvoiceViewed'),
    refresh: noopAsync('refresh'),
    navigate: noop('navigate'),
    askAbout: noop('askAbout'),
    respondToChange: noopAsync('respondToChange'),
    decidingChangeId: null,
  }
}

// ── ⭐⭐ THE PDF SEAM, INSTRUMENTED ──────────────────────────────────────────
// ⚠️ THIS PANEL IS AN INSTRUMENT, NOT A PRODUCT SCREEN, and it is the one place
// this fixture shows something a customer never sees. It exists because the
// timing sentence — the "$700 against a $500 quote" half of the original defect —
// turns out NOT to be a DOM surface on an accepted quote: BillingTab renders
// `explain` only while a quote can still be accepted, and HomeTab's
// `paymentTimingLine` only on the approve card. On an accepted quote that
// sentence reaches the customer through the PDF they download, and nowhere else.
//
// Rendering a real PDF here would need the whole renderer for a string. So the
// seam is instrumented instead: `getBlob` is the SHIPPING closure the row hands
// out, and this records the `accepted_price` it was actually given. That is the
// exact fact the repair turns on — null when nobody is named, the snapshot when
// somebody is — and it is observable in a browser without generating a document.
const pdfSeen: { scene: string; acceptedPrice: number | null }[] = []
const recordingRenderers = (scene: string): DocBlobRenderers => ({
  quote: async q => { pdfSeen.push({ scene, acceptedPrice: q.accepted_price ?? null }); return new Blob() },
  invoice: async () => new Blob(),
})

const SCENES: { kind: FixtureKind; id: string; title: string; expect: string }[] = [
  {
    kind: 'legacy_unrecorded', id: 'scene-legacy-blocked',
    title: '1 · Legacy acceptance — deposit blocked',
    expect: 'No Pay button. The reason is shown. The $250 ask stands; $700 appears nowhere.',
  },
  {
    kind: 'customer', id: 'scene-accepted-current',
    title: '2 · The customer’s own acceptance — current version',
    expect: 'The consent snapshot ($1,400) is shown and the Pay button is offered at $700.',
  },
  {
    kind: 'owner_on_behalf', id: 'scene-accepted-on-behalf',
    title: '3 · Recorded on the customer’s behalf',
    expect: 'The agreed figure is shown, worded as the business’s record — never “you accepted”.',
  },
  {
    kind: null, id: 'scene-unevidenced',
    title: '4 · Marked accepted, nothing on record',
    expect: 'Current price, the honest note, and no Pay button.',
  },
]

export function S122Fixture() {
  // The dialog scene is chosen by ?scene=owner-unnamed | owner-revised. Read once,
  // synchronously, so no Suspense boundary is needed for a dev-only page.
  const [scene] = useState(() =>
    typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('scene') || '')
  const owner = scene === 'owner-unnamed' ? 'unnamed' : scene === 'owner-revised' ? 'revised' : null

  const [violations, setViolations] = useState<Violation[]>([])
  const [fired, setFired] = useState<string[]>([])
  const [recorded, setRecorded] = useState(0)
  const answerRef = useRef(owner === 'revised' ? REVISED_ANSWER : UNNAMED_ANSWER)
  answerRef.current = owner === 'revised' ? REVISED_ANSWER : UNNAMED_ANSWER

  // Installed during the first render, before any child can mount a handler.
  useState(() => {
    installFetchStub(() => answerRef.current, v => setViolations(p => [...p, v]))
    return null
  })

  const actions = useMemo(() => inertActions(w => setFired(p => [...p, w])), [])
  const views = useMemo(
    () => SCENES.map(s => buildPortalView(fixtureData(s.kind), FIXTURE_TODAY, recordingRenderers(s.id))),
    [])
  const [pdfRun, setPdfRun] = useState(0)

  return (
    <div className="min-h-screen bg-bg text-ink p-4 sm:p-8 space-y-10">
      <Toaster />
      <header className="space-y-1">
        <h1 className="text-xl font-bold">S122 browser fixture</h1>
        <p className="text-xs text-ink-muted">
          Real components, synthetic props, offline transport. No database, no session, no credential.
        </p>
        {/* ⭐ The safety readout the CDP run asserts on. "0" here is the claim
            that nothing left this page; a non-zero list names what tried to. */}
        <p className="text-xs" id="fixture-network">
          network violations: <span className="font-bold tabular-nums">{violations.length}</span>
          {violations.map((v, i) => <span key={i} className="block text-red-400">{v.method} {v.url}</span>)}
        </p>
        <p className="text-xs" id="fixture-actions">
          portal actions fired: <span className="font-bold tabular-nums">{fired.length}</span>
          {fired.length > 0 && <span className="text-red-400"> ({fired.join(', ')})</span>}
        </p>
      </header>

      {owner ? (
        // ── The owner-confirmation scene ────────────────────────────────────
        // The dialog opens itself; everything after that is driven by a real
        // person or by the CDP script clicking real controls. Nothing is
        // auto-submitted — a fixture that pressed its own buttons would prove
        // the fixture works, not the dialog.
        <section id={`scene-owner-${owner}`} className="space-y-2">
          <h2 className="text-sm font-semibold">
            {owner === 'unnamed'
              ? '5 · Owner confirmation — nobody named on the record'
              : '6 · Owner confirmation — the document changed after acceptance'}
          </h2>
          <p className="text-xs text-ink-muted">
            Choose how they accepted, then press Record. The server answer is stubbed to the
            route’s real refusal shape, so the repair panel appears exactly as it would.
          </p>
          <p className="text-xs" id="fixture-recorded">
            onRecorded fired: <span className="font-bold tabular-nums">{recorded}</span>
          </p>
          <RecordAcceptanceDialog
            open
            onClose={() => { /* held open: the scene IS the dialog */ }}
            quoteId="zz-quote-1"
            quoteNumber="ZZ-2026-0152"
            customerName="ZZ Fixture Customer"
            travelFee={0}
            total={500}
            options={[]}
            termsText="We accept cash, cheque and e-transfer. Please give 24 hours notice to cancel."
            selectedAddonsTotal={0}
            onRecorded={() => setRecorded(n => n + 1)}
          />
        </section>
      ) : (
        <>
        {/* ⚠️ INSTRUMENT, not a customer screen — see the note by recordingRenderers. */}
        <section id="scene-pdf-seam" className="space-y-2">
          <h2 className="text-sm font-semibold">0 · PDF seam (instrument)</h2>
          <p className="text-xs text-ink-muted">
            What each row’s real <code>getBlob</code> closure hands the PDF renderer. Null means the
            unproven snapshot was stripped before the document the customer keeps.
          </p>
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-1.5 text-xs"
            onClick={async () => {
              pdfSeen.length = 0
              for (const v of views) await v.docItems.find(d => d.kind === 'quote')?.getBlob?.()
              setPdfRun(n => n + 1)
            }}
          >
            Ask every row for its PDF
          </button>
          <p className="text-xs" id="fixture-pdf">
            {pdfRun === 0 ? 'not asked yet' : pdfSeen.map(p => `${p.scene}=${p.acceptedPrice === null ? 'null' : p.acceptedPrice}`).join(' ')}
          </p>
        </section>
        {SCENES.map((s, i) => (
          <section key={s.id} id={s.id} className="space-y-2">
            <h2 className="text-sm font-semibold">{s.title}</h2>
            <p className="text-xs text-ink-muted">{s.expect}</p>
            <div className="rounded-xl border border-border p-3">
              <BillingTab view={views[i]} actions={actions} initialCat="quote" />
            </div>
          </section>
        ))}
        </>
      )}
    </div>
  )
}
