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
import { writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import type { Quote, BusinessSettings } from '../src/types'

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
  const BASE = git(['merge-base', 'HEAD', 'session122/redteam-acceptance-repair'])
  console.log('\n══ S122 · the drifted document, before and after ═══════════════════')
  console.log(`   tip  : ${TIP}`)
  console.log(`   base : ${BASE} (9ffac020 = the PASSed acceptance repair)`)
  console.log(`   out  : ${OUT}\n`)

  const { renderQuoteBlob } = await import('../src/components/quotes/QuotePDF')
  const text = async (name: string, q: Quote, doc?: { acceptanceSuperseded?: boolean }) => {
    const blob = await renderQuoteBlob(q, settings, undefined, undefined, doc)
    const buf = Buffer.from(await blob.arrayBuffer())
    writeFileSync(join(OUT, `${name}.pdf`), buf)
    const txt = execFileSync('pdftotext', ['-layout', join(OUT, `${name}.pdf`), '-']).toString()
    writeFileSync(join(OUT, `${name}.txt`), txt)
    const flat = txt.replace(/\s+/g, ' ')
    // ⚠️ Preview only, and deliberately NOT the 50%-shaped regex it started as:
    // a fixed-rule document printed "(no deposit sentence)" in the log while its
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
      !/revised since it was accepted/i.test(t))
  }

  console.log('\n■ 2. AFTER — the rule kept, the figure withheld')
  {
    const t = await text('AFTER-drifted-qualified', drifted, { acceptanceSuperseded: true })
    check('the page still prints the CURRENT total $500.00', /Quote Total \$500\.00/.test(t))
    check('⭐ the superseded $700.00 is GONE', !/700/.test(t))
    check('⛔ …and $250.00 was NOT substituted in its place', !/250/.test(t),
      're-deriving from the current total would put a demand on paper nobody agreed to')
    check('the RULE survives — the percentage is still stated', /50% deposit is required/.test(t))
    check('⭐ and the document says WHY the amount is missing',
      /revised since it was accepted, so the amount previously agreed no longer applies/i.test(t))
    check('…and that a figure is coming, not that the deposit is waived',
      /confirm the deposit on the updated quote/i.test(t))
    check('⛔ no historical line item was invented — the scope table is the current one',
      /Landscaping/.test(t) && !/1,400/.test(t))
  }

  console.log('\n■ 3. Nothing else moves')
  {
    // A named acceptance that still matches its document keeps its figure.
    const current = { ...drifted, accepted_price: 500 } as Quote
    const t = await text('CONTROL-current-acceptance', current, { acceptanceSuperseded: false })
    check('an acceptance that still matches prints its figure', /50% deposit \(\$250\.00\)/.test(t))
    check('…and says nothing about a revision', !/revised since it was accepted/i.test(t))

    // An un-accepted quote never had an authority to supersede.
    const sent = { ...drifted, status: 'sent', accepted_price: null } as Quote
    const t2 = await text('CONTROL-unaccepted', sent)
    check('an un-accepted quote is untouched', /50% deposit \(\$250\.00\)/.test(t2))

    // ⭐ A FIXED-dollar rule is the quote's own configuration, not a borrowed
    // basis, so drift cannot unsettle it — it must still print.
    const fixed = { ...drifted, deposit_type: 'fixed', deposit_value: 300 } as Quote
    const t3 = await text('CONTROL-fixed-rule-drifted', fixed, { acceptanceSuperseded: true })
    check('a FIXED deposit still states its dollars under drift', /\$300\.00 deposit/.test(t3),
      'a fixed figure is not derived from the snapshot, so it is not superseded by drift')
  }

  console.log('\n■ 4. Offline')
  check('⛔ the renderer made no call to any host', fetchCalls.length === 0, fetchCalls.join(', '))

  console.log(fail > 0 ? `\n✗ ${fail} FAILURE(S) — ${pass} passed` : `\n✓ pdf drift: ${pass} checks passed`)
  console.log(`   tip ${TIP} · base ${BASE}`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()
