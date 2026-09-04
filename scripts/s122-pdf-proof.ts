// ── The customer's actual PDF, generated and read back ───────────────────────
//   npx tsx scripts/s122-pdf-proof.ts
//
// ⭐⭐ WHY THIS EXISTS. The browser fixture instruments the PDF SEAM — it asks the
// shipping `getBlob` closure what `accepted_price` it was handed. That is a real
// fact about the INPUT, and it was reported as exactly that and nothing more.
// It is not a proof about the DOCUMENT.
//
// This closes that gap the only way it can honestly be closed: run the shipping
// renderer, produce a real PDF, and read the text back out of it with pdftotext.
// The assertions below are about words and figures that actually appear on paper
// the customer keeps.
//
// ⛔ OFFLINE, BY DATA AND BY TRAP.
//   · `@react-pdf/renderer` registers NO fonts anywhere in this repo, so it uses
//     PDF standard Helvetica — nothing is fetched for type.
//   · The one network path in QuotePDF is `<Image src={pdfLogoUrl(logo_url)}>`,
//     which renders ONLY when a logo_url exists. The synthetic business has none,
//     so the element is never emitted.
//   · Belt and braces: `globalThis.fetch` is replaced with a trap that refuses
//     anything with a HOST. `data:` URIs pass through, because @react-pdf loads
//     Yoga's layout WASM from one inlined in the package — and the run names that
//     single call rather than claiming a zero it does not have.
// ⛔ Neutral synthetic branding, no production asset, no credential, no server.

import React from 'react'
import { writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

;(globalThis as unknown as { React: typeof React }).React = React

// ── The network trap ────────────────────────────────────────────────────────
// ⚠️ `data:` URIs pass THROUGH to the real fetch, and that distinction matters
// twice over. First it is correct: a data: URI never leaves the process, and
// @react-pdf loads Yoga's layout WASM from one inlined in the package. Second it
// is honest: an earlier version of this trap threw on everything, which forced
// the renderer off its intended path onto a fallback — a proof that quietly
// changes the code it is proving is not a proof. Anything with a HOST is
// recorded and refused.
const fetchCalls: string[] = []
const dataUris: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: unknown) => {
  const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input)
  if (/^data:/i.test(url)) { dataUris.push(url.slice(0, 48)); return realFetch(input as RequestInfo, init as RequestInit) }
  fetchCalls.push(url)
  throw new Error(`s122-pdf-proof: refusing a network fetch to ${url}`)
}) as typeof globalThis.fetch

const OUT = process.env.S122_PDF_OUT
  || 'C:/Users/Kavin/Documents/Codex/2026-09-04/referenced-chatgpt-conversation-this-is-an/outputs/s122-pdf-proof'
mkdirSync(OUT, { recursive: true })

let pass = 0, fail = 0
const check = (n: string, ok: boolean, d?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; console.error(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
}
const git = (a: string[]) => { try { return execFileSync('git', a).toString().trim() } catch { return 'unknown' } }

async function main() {
  const FIXTURE_SHA = git(['rev-parse', 'HEAD'])
  const PRODUCT_SHA = git(['merge-base', 'HEAD', 'session122/redteam-acceptance-repair'])
  console.log('\n══ S122 · the customer’s actual PDF ════════════════════════════════')
  console.log(`   fixture SHA : ${FIXTURE_SHA}`)
  console.log(`   product SHA : ${PRODUCT_SHA}`)
  console.log(`   artifacts   : ${OUT}\n`)

  const { buildPortalView } = await import('../src/app/portal/[token]/model')
  const { renderPortalQuoteBlob } = await import('../src/lib/portalPdf')
  const { fixtureData, FIXTURE_TODAY } = await import('../src/app/dev/s122-fixture/fixtureData')
  type PortalQuote = Awaited<ReturnType<typeof fixtureData>>['quotes'][number]

  // ⛔ Neutral synthetic branding. No logo_url — that is what keeps the one
  // fetching element out of the document entirely.
  const business = {
    company_name: 'ZZ Fixture Landscaping', owner_name: 'ZZ Owner', phone: null,
    email_primary: null, email_secondary: null, website: null,
    logo_url: null, logo_scale: null, base_address: null,
    terms_text: 'We accept cash, cheque and e-transfer.', gst_percent: 0,
  }

  /**
   * The quote the shipping row actually hands its renderer.
   * ⭐ Taken from `getBlob` rather than rebuilt: this is the same closure the
   * customer's Download button invokes, so the basis under test is the real one.
   */
  const basisFor = async (kind: 'legacy_unrecorded' | 'customer' | 'owner_on_behalf' | null) => {
    let captured: PortalQuote | null = null
    const view = buildPortalView(fixtureData(kind), FIXTURE_TODAY, {
      quote: async q => { captured = q; return new Blob() },
      invoice: async () => new Blob(),
    })
    await view.docItems.find(d => d.kind === 'quote')!.getBlob!()
    if (!captured) throw new Error('the row never asked for a PDF')
    return captured as PortalQuote
  }

  /** Generate with the SHIPPING renderer and read the text back with pdftotext. */
  const textOf = async (name: string, q: PortalQuote) => {
    const blob = await renderPortalQuoteBlob(q, 'ZZ Fixture Customer', business as never)
    const buf = Buffer.from(await blob.arrayBuffer())
    const pdfPath = join(OUT, `${name}.pdf`)
    writeFileSync(pdfPath, buf)
    const txt = execFileSync('pdftotext', ['-layout', pdfPath, '-']).toString()
    writeFileSync(join(OUT, `${name}.txt`), txt)
    console.log(`    · ${name}.pdf ${buf.length} bytes → ${name}.txt ${txt.length} chars`)
    return txt.replace(/\s+/g, ' ')
  }

  console.log('■ 1. Nobody named on the record — legacy and unevidenced')
  for (const kind of ['legacy_unrecorded', null] as const) {
    const label = kind ?? 'unevidenced'
    const q = await basisFor(kind)
    check(`${label} · the row hands the renderer NO snapshot`, q.accepted_price === null, String(q.accepted_price))
    const t = await textOf(`${label}`, q)
    check(`${label} · the document asks $250.00`, t.includes('$250.00'), t.slice(0, 400))
    check(`${label} · ⛔ and the raw-snapshot $700 is NOT on the paper`, !/700/.test(t))
    check(`${label} · ⛔ nor the unproven $1,400`, !/1,400/.test(t))
    check(`${label} · the timing sentence is printed`,
      /before we schedule your visit/.test(t), t.slice(0, 400))
  }

  console.log('\n■ 2. Somebody IS named — the agreed figure is printed')
  for (const kind of ['customer', 'owner_on_behalf'] as const) {
    const q = await basisFor(kind)
    check(`${kind} · the row hands the renderer the snapshot`, Number(q.accepted_price) === 1400)
    const t = await textOf(kind, q)
    check(`${kind} · the document asks $700.00 — derived from the agreed $1,400`,
      t.includes('$700.00'), t.slice(0, 400))
  }

  console.log('\n■ 3. ⭐⭐ NEGATIVE CONTROL — the defect, printed on paper')
  {
    // The pre-repair path: the raw quote, snapshot and all, straight to the
    // renderer. ⛔ If this does NOT print $700, the extraction cannot see the
    // failure and every assertion above is worthless.
    const raw = { ...(await basisFor('legacy_unrecorded')), accepted_price: 1400 } as PortalQuote
    const t = await textOf('NEGATIVE-CONTROL-raw-quote', raw)
    check('the un-stripped quote DOES print $700.00 — the assertions can fail',
      t.includes('$700.00'), t.slice(0, 400))
    check('…and does NOT print $250.00', !t.includes('$250.00'))
  }

  console.log('\n■ 3b. ⚠️ A PRE-EXISTING incoherence, now seen on paper')
  {
    // ⚠️⚠️ NOT a defect of this repair, and deliberately not a red check — but it
    // is the kind of thing only a generated document shows, so it is recorded
    // where it cannot be forgotten.
    //
    // On a DRIFTED but evidenced quote (agreed $1,400, current total $500) the
    // document prints "Quote Total $500.00" and, four lines below, "A 50% deposit
    // ($700.00)". Both halves are individually correct — the total is the current
    // document, the deposit is derived from the consent snapshot — and together
    // they are arithmetic no customer can reconcile.
    //
    // ⛔ It predates S122: QuotePDF has always printed `total`, and paymentTiming
    // has always preferred `accepted_price`. The repair neither introduced nor
    // widened it. Reachability is narrow — the portal shows a "we've made changes
    // since" banner in this state and the charge route refuses, because the
    // fingerprint has moved. S106/S121 to rule.
    const q = await basisFor('customer')
    const t = await textOf('FINDING-drifted-evidenced', q)
    const totalIs500 = /Quote Total \$500\.00/.test(t)
    const depositIs700 = /50% deposit \(\$700\.00\)/.test(t)
    check('⚠️ recorded: a drifted evidenced quote pairs a $500 total with a $700 deposit',
      totalIs500 && depositIs700,
      'if this ever stops being true, delete this check and the note beside it')
  }

  console.log('\n■ 4. Nothing left the process')
  check('⛔ the renderer made no call to any HOST', fetchCalls.length === 0, fetchCalls.join(', '))
  // Named rather than hidden: one in-package data: URI is expected, and saying
  // which one is the difference between "zero fetches" and the truth.
  console.log(`    · ${dataUris.length} in-package data: URI fetch(es) — ${dataUris[0] ?? 'none'}`)
  check('…and every fetch it DID make was an inlined data: URI',
    dataUris.every(u => /^data:/i.test(u)))
  check('…which is Yoga’s layout WASM, not a font or an asset',
    dataUris.length === 0 || dataUris.some(u => u.startsWith('data:application/octet-stream;base64,AGFzbQ')),
    dataUris.join(', '))

  console.log(fail > 0 ? `\n✗ ${fail} FAILURE(S) — ${pass} passed` : `\n✓ s122 pdf proof: ${pass} checks passed`)
  console.log(`   fixture ${FIXTURE_SHA} · product ${PRODUCT_SHA}`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()
