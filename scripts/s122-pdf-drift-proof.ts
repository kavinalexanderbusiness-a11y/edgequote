// ── The drifted document, before and after ───────────────────────────────────
//   npx tsx scripts/s122-pdf-drift-proof.ts
//
// S121's ruling, in one line:
//
//   > An amount and its authority travel together. When the acceptance is not
//   > current, the document must not present a figure derived from the superseded
//   > snapshot as a live ask.
//
// This renders the real document both ways and reads the words back, so the
// change is demonstrated on paper rather than argued in a diff.
//
// ⛔ WHAT IT MUST NOT DO, asserted below and not merely intended:
//   · never substitute the current price as the accepted price (the fixed
//     document must not quietly ask 50% of the new total either);
//   · never fabricate a historical line item;
//   · never touch a gate — the charge route already refuses a non-current
//     acceptance and nothing here changes that.
//
// ⛔ Offline: no font is registered anywhere in this repo, the one network
// element in QuotePDF is the logo <Image> (the synthetic business has none), and
// a fetch trap refuses anything with a host.

import React from 'react'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import type { Quote, BusinessSettings } from '../src/types'
import type { AcceptanceCurrentness as Cur } from '../src/lib/payments/paymentTiming'

;(globalThis as unknown as { React: typeof React }).React = React

const fetchCalls: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: unknown) => {
  const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input)
  // data: URIs stay in-process (@react-pdf loads Yoga's layout WASM from one).
  if (/^data:/i.test(url)) return realFetch(input as RequestInfo, init as RequestInit)
  fetchCalls.push(url)
  throw new Error(`s122-pdf-drift-proof: refusing a network fetch to ${url}`)
}) as typeof globalThis.fetch

const OUT = process.env.S122_PDF_OUT
  || 'C:/Users/Kavin/Documents/Codex/2026-09-04/referenced-chatgpt-conversation-this-is-an/outputs/s122-pdf-drift'
mkdirSync(OUT, { recursive: true })

let pass = 0, fail = 0
const check = (n: string, ok: boolean, d?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; console.error(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
}
const git = (a: string[]) => { try { return execFileSync('git', a).toString().trim() } catch { return 'unknown' } }

// Neutral synthetic branding. ⛔ logo_url null keeps the one fetching element out.
const settings = {
  company_name: 'ZZ Fixture Landscaping', owner_name: 'ZZ Owner',
  logo_url: null, gst_percent: 0,
  terms_text: 'We accept cash, cheque and e-transfer.',
} as unknown as BusinessSettings

/** The reported shape: named evidence at $1,400, document revised to $500. */
const drifted = {
  quote_number: 'ZZ-2026-0152', customer_name: 'ZZ Fixture Customer',
  address: '1 Fixture Street', service_type: 'Landscaping', notes: null,
  hours: 2, crew_size: 1, travel_fee: 0,
  subtotal: 500, total: 500, initial_price: 500,
  status: 'accepted', issued_date: '2026-09-04', created_at: '2026-09-04',
  valid_until: '2026-12-31', selected_option_id: null,
  accepted_price: 1400, deposit_type: 'percent', deposit_value: 50,
} as unknown as Quote

async function main() {
  const TIP = git(['rev-parse', 'HEAD'])
  const BASE = git(['merge-base', 'HEAD', 's106-candidate/s122-final'])
  console.log('\n══ S122 · the drifted document, before and after ═══════════════════')
  console.log(`   tip  : ${TIP}`)
  console.log(`   base : ${BASE} (the s122-final integration this branch builds on)`)
  console.log(`   out  : ${OUT}\n`)

  const { renderQuoteBlob } = await import('../src/components/quotes/QuotePDF')
  const text = async (name: string, q: Quote, doc?: { acceptanceCurrentness?: Cur }) => {
    const blob = await renderQuoteBlob(q, settings, undefined, undefined, doc)
    const buf = Buffer.from(await blob.arrayBuffer())
    writeFileSync(join(OUT, `${name}.pdf`), buf)
    const txt = execFileSync('pdftotext', ['-layout', join(OUT, `${name}.pdf`), '-']).toString()
    writeFileSync(join(OUT, `${name}.txt`), txt)
    const flat = txt.replace(/\s+/g, ' ')
    // ⚠️ Preview only, and deliberately NOT the 50%-shaped regex it started as:
    // ⚠️ A window around the word, not a sentence regex: a money token contains a
    // dot, so the earlier [^.]* pattern reported '(no deposit sentence)' for a
    // fixed rule whose assertion was passing. A log that misreports a green
    // check is its own small lie.
    const at = flat.indexOf('deposit')
    console.log(`    · ${name}: ${at < 0 ? '(no deposit sentence)' : flat.slice(Math.max(0, at - 26), at + 116)}`)
    // assertion passed. A log that misreports a green check is its own small lie.
    console.log(`    · ${name}: ${(flat.match(/A [^.]*deposit[^.]*\./) || ['(no deposit sentence)'])[0].slice(0, 130)}`)
    return flat
  }

  console.log('■ 1. BEFORE — the defect, on paper')
  {
    const t = await text('BEFORE-drifted-unqualified', drifted)
    check('the page prints the CURRENT total $500.00', /Quote Total \$500\.00/.test(t))
    check('…and a deposit derived from the SUPERSEDED $1,400', /50% deposit \(\$700\.00\)/.test(t))
    check('⛔ with nothing on the page reconciling them',
      !/revised since you accepted it/i.test(t))
  }

  console.log('\n■ 2. AFTER — the rule kept, the figure withheld')
  {
    const t = await text('AFTER-drifted-qualified', drifted, { acceptanceCurrentness: 'superseded' })
    check('the page still prints the CURRENT total $500.00', /Quote Total \$500\.00/.test(t))
    check('⭐ the superseded $700.00 is GONE', !/700/.test(t))
    check('⛔ …and $250.00 was NOT substituted in its place', !/250/.test(t),
      're-deriving from the current total would put a demand on paper nobody agreed to')
    check('the RULE survives — the percentage is still stated', /50% deposit is required/.test(t))
    check('⭐ and the document says WHY the amount is missing',
      /revised since you accepted it/i.test(t))
    check('…and that a figure is coming, not that the deposit is waived',
      /agree the amount with you before anything is due/i.test(t))
    check('⛔ no historical line item was invented — the scope table is the current one',
      /Landscaping/.test(t) && !/1,400/.test(t))
  }

  console.log('\n■ 3. Nothing else moves')
  {
    // A named acceptance that still matches its document keeps its figure.
    const current = { ...drifted, accepted_price: 500 } as Quote
    const t = await text('CONTROL-current-acceptance', current, { acceptanceCurrentness: 'current' })
    check('an acceptance that still matches prints its figure', /50% deposit \(\$250\.00\)/.test(t))
    check('…and says nothing about a revision', !/revised since you accepted it/i.test(t))

    // An un-accepted quote never had an authority to supersede.
    const sent = { ...drifted, status: 'sent', accepted_price: null } as Quote
    const t2 = await text('CONTROL-unaccepted', sent)
    check('an un-accepted quote is untouched', /50% deposit \(\$250\.00\)/.test(t2))

    // ⛔⛔ A FIXED rule is unsettled by drift TOO — this control used to assert the
    // opposite. Provenance said a fixed figure is the quote's configuration rather
    // than a consent artifact, which is true and beside the point: requiredDeposit
    // clamps it to the basis, so a fixed $700 prints on a $500 document under an
    // acceptance the charge route refuses. That is the same unreconcilable ask the
    // whole rule exists to stop.
    const fixed = { ...drifted, deposit_type: 'fixed', deposit_value: 700 } as Quote
    const t3 = await text('CONTROL-fixed-rule-drifted', fixed, { acceptanceCurrentness: 'superseded' })
    check('⭐ a FIXED deposit ALSO drops its figure under drift', !/\$700\.00/.test(t3), t3.slice(0, 300))
    check('…and says a deposit is required without inventing a percentage',
      /A deposit is required before we schedule your visit/.test(t3) && !/%/.test(t3))
    check('…and still explains the revision', /revised since you accepted it/.test(t3))
    const fixedOk = await text('CONTROL-fixed-rule-current', fixed, { acceptanceCurrentness: 'current' })
    check('…while an un-drifted fixed rule still states its dollars', /\$700\.00 deposit/.test(fixedOk))
  }

  console.log('\n■ 3b. ⭐⭐ THE PORTAL ASKS THE CANONICAL QUESTION — same-total drift')
  {
    // S121's Finding 1: an edit to address, service_type, notes or the deposit
    // terms moves the material fingerprint and leaves `total` untouched. A TOTAL
    // comparison answers "not superseded" there while the owner's fingerprint
    // answer says otherwise — same quote, two documents, two answers.
    const { buildPortalView } = await import('../src/app/portal/[token]/model')
    const renderers = { quote: async () => new Blob(), invoice: async () => new Blob() }
    const q = (over: Record<string, unknown>) => ({
      id: 'zz1', quote_number: 'ZZ-1', service_type: 'Landscaping', address: '1 Fixture Street',
      property_id: null, total: 500, initial_price: 500, subtotal: null,
      weekly_price: null, biweekly_price: null, monthly_price: null, notes: null,
      status: 'accepted', created_at: '2026-09-04', issued_date: '2026-09-04',
      valid_until: '2026-12-31', crew_size: 1, hours: 2, travel_fee: 0,
      accepted_price: 500, acceptance_kind: 'customer',
      deposit_type: 'percent', deposit_value: 50, ...over,
    })
    const line = (over: Record<string, unknown>) => {
      const data = {
        customer: { id: 'c', name: 'ZZ', email: null, phone: null, address: null, city: null },
        business: { gst_percent: 0 }, property: null, properties: [],
        quotes: [q(over)], invoices: [], jobs: [], recurrences: [], photos: [], payments: [],
      }
      const v = buildPortalView(data as never, '2026-09-04', renderers as never)
      return v.docItems.find(d => d.kind === 'quote')!.paymentTimingLine ?? ''
    }
    // ⭐ SAME TOTAL — only the fingerprint moved. The old price proxy answered
    // "not superseded" here and printed the figure anyway.
    const sameTotalDrift = line({ acceptance_is_current: false })
    check('same-total drift IS caught — the figure is dropped',
      !/\$250\.00/.test(sameTotalDrift) && /revised since you accepted it/.test(sameTotalDrift),
      sameTotalDrift)
    const current = line({ acceptance_is_current: true })
    check('…while a current acceptance still prints its figure',
      /\$250\.00/.test(current), current)
    // ⭐⭐ THERE ARE THREE REACHABLE PAYLOAD SHAPES, NOT TWO, and the middle one
    // was the defect. All four are PRINTED before they are asserted — an
    // independent reviewer found this exact gap with an assertion that passed
    // through their own escaping error, and printing is what exposed it. A check
    // I wrote badly is the failure class this lane keeps meeting.
    const shapes: [string, Record<string, unknown>][] = [
      ['baseline  (neither field)     ', { acceptance_kind: undefined, acceptance_is_current: undefined, accepted_price: 1400 }],
      ['OLD C     (kind, no current)  ', { acceptance_kind: 'customer', acceptance_is_current: undefined, accepted_price: 1400 }],
      ['OLD C     (kind, current NULL)', { acceptance_kind: 'customer', acceptance_is_current: null, accepted_price: 1400 }],
      ['v2        (current = true)    ', { acceptance_kind: 'customer', acceptance_is_current: true, accepted_price: 1400 }],
      ['v2        (current = false)   ', { acceptance_kind: 'customer', acceptance_is_current: false, accepted_price: 1400 }],
    ]
    for (const [label, over] of shapes) console.log(`      ${label} => ${line(over).slice(0, 96)}`)

    const preWidening = line({ acceptance_kind: undefined, acceptance_is_current: undefined, accepted_price: 1400 })
    check('baseline · prints the CURRENT figure, not the snapshot',
      /\$250\.00/.test(preWidening) && !/\$700\.00/.test(preWidening), preWidening)
    // ⛔ THE DEFECT: kind present (old C projects it) and currentness absent (v2
    // not yet applied) — the snapshot is USABLE and its currentness is UNKNOWN.
    // `=== false` called that current and printed $700.00 on a $500 document.
    // ⭐⭐ UNKNOWN WITHHOLDS THE FIGURE **AND SAYS ONLY WHAT IS KNOWN**. It used
    // to borrow the known-stale sentence, which asserted a revision the payload
    // never established — on an old-C database the acceptance may be perfectly
    // current. Withholding was the safe direction; the claim was not.
    const oldC = line({ acceptance_kind: 'customer', acceptance_is_current: undefined, accepted_price: 1400 })
    check('⭐ OLD-C · a usable snapshot with UNKNOWN currentness withholds the figure',
      !/\$700\.00/.test(oldC), oldC)
    check('⛔ OLD-C · …and does NOT claim the quote was revised',
      !/revised since you accepted it/.test(oldC) && !/revised since you accepted it/.test(oldC), oldC)
    check('⭐ OLD-C · …it says the acceptance is being confirmed',
      /acceptance on file for this quote is still being confirmed/.test(oldC)
      && /agree the amount with you before anything is due/.test(oldC), oldC)
    check('…and keeps the RULE, which the revision never touched', /50% deposit is required/.test(oldC))
    const oldCNull = line({ acceptance_kind: 'customer', acceptance_is_current: null, accepted_price: 1400 })
    check('⭐ OLD-C · a NULL currentness behaves identically to a missing one',
      oldCNull === oldC, `${oldCNull}\n      vs ${oldC}`)
    // ⛔ THE CONTROL THAT KEEPS THE TWO APART: known-stale must still say the
    // accurate thing. If this ever matches the unverified sentence, the split
    // has collapsed back into one.
    const knownStale = line({ acceptance_kind: 'customer', acceptance_is_current: false, accepted_price: 1400 })
    check('⭐ KNOWN-STALE · keeps the accurate revised wording',
      /revised since you accepted it/.test(knownStale)
      && /revised since you accepted it/.test(knownStale), knownStale)
    check('⛔ …and the two sentences are genuinely different',
      knownStale !== oldC && !/acceptance on file for this quote is still being confirmed/.test(knownStale))
    const v2true = line({ acceptance_kind: 'customer', acceptance_is_current: true, accepted_price: 1400 })
    check('v2 · an explicitly CURRENT acceptance still prints its authoritative figure',
      /\$700\.00/.test(v2true), v2true)
    const model = readFileSync(join(process.cwd(), 'src/app/portal/[token]/model.ts'), 'utf8')
    check('⛔ the portal maps THREE states, not a boolean',
      /qq\.acceptance_kind == null \? 'current'/.test(model)
      && /qq\.acceptance_is_current === true \? 'current'/.test(model)
      && /qq\.acceptance_is_current === false \? 'superseded'/.test(model)
      && /: 'unverified'/.test(model)
      && !/const acceptanceSuperseded = priceMovedSinceAccepted/.test(model))
    const sql = readFileSync(join(process.cwd(), 'supabase/proposals/RUN-S122C-portal-acceptance-evidence.sql'), 'utf8')
    check('…and the payload gets it from the CANONICAL function, in the same patch as the kind',
      /public\.quote_acceptance_is_current\(qt\.id\) as acceptance_is_current/.test(sql)
      && /as acceptance_kind/.test(sql))
    check('⛔ …which is still a CANDIDATE, never applied', /CANDIDATE — NOT APPLIED/.test(sql))

    // ── ⭐⭐ AND THE SAME SHAPE AS A REAL DOCUMENT ─────────────────────────────
    // The checks above read the model's sentence. This renders the OLD-C row's
    // own `getBlob` closure — the one the customer's Download button invokes —
    // through the shipping PDF pipeline, and reads the words back off the paper.
    // A model-level assertion is not a document.
    const { renderPortalQuoteBlob } = await import('../src/lib/portalPdf')
    const realDoc = async (name: string, over: Record<string, unknown>) => {
      let seen: { q: unknown; doc?: { acceptanceCurrentness?: Cur } } | null = null
      const data = {
        customer: { id: 'c', name: 'ZZ Fixture Customer', email: null, phone: null, address: null, city: null },
        business: { gst_percent: 0 }, property: null, properties: [],
        quotes: [q(over)], invoices: [], jobs: [], recurrences: [], photos: [], payments: [],
      }
      const v = buildPortalView(data as never, '2026-09-04', {
        quote: async (qq: unknown, doc?: { acceptanceCurrentness?: Cur }) => { seen = { q: qq, doc }; return new Blob() },
        invoice: async () => new Blob(),
      } as never)
      await v.docItems.find(d => d.kind === 'quote')!.getBlob!()
      const s = seen as unknown as { q: never; doc?: { acceptanceCurrentness?: Cur } }
      const blob = await renderPortalQuoteBlob(s.q, 'ZZ Fixture Customer', settings as never, s.doc)
      const buf = Buffer.from(await blob.arrayBuffer())
      writeFileSync(join(OUT, `${name}.pdf`), buf)
      const txt = execFileSync('pdftotext', ['-layout', join(OUT, `${name}.pdf`), '-']).toString()
      writeFileSync(join(OUT, `${name}.txt`), txt)
      const flat = txt.replace(/\s+/g, ' ')
      const at = flat.indexOf('deposit')
      console.log(`    · ${name}: ${at < 0 ? '(no deposit sentence)' : flat.slice(Math.max(0, at - 26), at + 116)}`)
      return flat
    }
    const oldCDoc = await realDoc('OLDC-kind-without-currentness', { acceptance_kind: 'customer', accepted_price: 1400 })
    check('⭐ REAL PDF · the old-C document does NOT demand $700.00',
      !/700/.test(oldCDoc), oldCDoc.slice(0, 300))
    check('…it still shows the current $500.00 total', /Quote Total \$500\.00/.test(oldCDoc))
    check('⛔ REAL PDF · …and the paper does NOT claim the quote was revised',
      !/revised since you accepted it/.test(oldCDoc) && !/revised since you accepted it/.test(oldCDoc),
      oldCDoc.slice(0, 300))
    check('⭐ REAL PDF · …it says the acceptance is being confirmed',
      /acceptance on file for this quote is still being confirmed/.test(oldCDoc))
    const oldCNullDoc = await realDoc('OLDC-currentness-null', { acceptance_kind: 'customer', acceptance_is_current: null, accepted_price: 1400 })
    check('⭐ REAL PDF · a NULL currentness document behaves identically',
      !/700/.test(oldCNullDoc) && /acceptance on file for this quote is still being confirmed/.test(oldCNullDoc)
      && !/revised since you accepted it/.test(oldCNullDoc))
    // ⛔ THE CONTROL, as a document: known-stale must still say the accurate thing
    // on paper. Two PDFs, two sentences — if they ever converge the split is gone.
    const staleDoc = await realDoc('KNOWN-STALE-current-false', { acceptance_kind: 'customer', acceptance_is_current: false, accepted_price: 1400 })
    check('⭐ REAL PDF · known-stale keeps the revised wording',
      /revised since you accepted it/.test(staleDoc) && /revised since you accepted it/.test(staleDoc),
      staleDoc.slice(0, 300))
    check('⛔ REAL PDF · …and never borrows the confirmation sentence',
      !/acceptance on file for this quote is still being confirmed/.test(staleDoc))
    check('⛔ REAL PDF · neither document names a dollar deposit',
      !/700/.test(staleDoc) && !/\$250\.00/.test(staleDoc) && !/\$250\.00/.test(oldCDoc))
    const v2Doc = await realDoc('V2-current-true', { acceptance_kind: 'customer', acceptance_is_current: true, accepted_price: 1400 })
    check('REAL PDF · an explicitly current acceptance still prints $700.00',
      /\$700\.00/.test(v2Doc), v2Doc.slice(0, 300))
  }

  console.log('\n■ 4. Offline')
  check('⛔ the renderer made no call to any host', fetchCalls.length === 0, fetchCalls.join(', '))

  console.log(fail > 0 ? `\n✗ ${fail} FAILURE(S) — ${pass} passed` : `\n✓ pdf drift: ${pass} checks passed`)
  console.log(`   tip ${TIP} · base ${BASE}`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()
