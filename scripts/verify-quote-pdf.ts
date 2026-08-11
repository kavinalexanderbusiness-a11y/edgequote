// ── Verify: the quote PDF never prints a number equal to the sum of the options ──
//   npm run verify:quote-pdf        [outputDir]
//
// The document is the artefact a customer keeps, prints and shows their partner.
// "A PDF must not visually total all the packages together" is the one rule it
// cannot break, and a rule stated only in a comment is not enforced — so this
// renders the REAL QuoteDocument to a REAL PDF, inflates its content streams and
// reads the strings that actually reach the page. Not the JSX; the paper.
//
// Three documents, because the feature has three states and each has its own way
// of going wrong: before the choice (three prices, none of them THE price), after
// it (one chosen, the rest history), and an ordinary quote (which must be
// byte-for-byte the document it has always been).
//
// Writes the PDFs to the directory given as argv[2] — the OS temp dir by default,
// so `npm run verify` leaves nothing behind — where they can be opened and looked
// at, which is the other half of "does it read correctly".

// tsx compiles JSX with the classic runtime here, so React must be in scope for
// the JSX inside QuotePDF.tsx. Next supplies this automatically; a standalone
// node run does not.
import * as React from 'react'
;(globalThis as unknown as { React: typeof React }).React = React
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { inflateSync } from 'node:zlib'
import { join } from 'node:path'
import { renderQuoteBlob } from '../src/components/quotes/QuotePDF'
import type { Quote, QuoteOption, BusinessSettings } from '../src/types'

const OUT = process.argv[2] || tmpdir()

const OPTIONS = [
  { id: 'o1', name: 'Budget', description: 'Level and reseed the existing lawn.', price: 3900, sort_order: 0, is_recommended: false },
  { id: 'o2', name: 'Standard', description: 'Everything in Budget, plus a 12x14 paver patio and sod.', price: 5400, sort_order: 1, is_recommended: true },
  { id: 'o3', name: 'Premium', description: 'Everything in Standard, plus a cedar planter and lighting.', price: 7100, sort_order: 2, is_recommended: false },
] as unknown as QuoteOption[]

const BASE = {
  quote_number: 'Q-OPT-001', customer_name: 'Yasmin Dahl', address: '812 Riverbend Cr',
  service_type: 'Backyard rebuild', notes: null, hours: 6, crew_size: 2,
  travel_fee: 150, show_travel_separately: false,
  initial_price: 5400, total: 5550, subtotal: 5400,
  weekly_price: 55, biweekly_price: 75, monthly_price: 260,
  status: 'sent', issued_date: '2026-08-11', valid_until: '2026-09-10',
  created_at: '2026-08-11T00:00:00Z', selected_option_id: null,
} as unknown as Quote

const SETTINGS = { company_name: 'Edge Property Services', gst_percent: 5, logo_scale: 100 } as unknown as BusinessSettings

// Pull the text that actually reaches the page out of a PDF's content streams.
// @react-pdf Flate-compresses them, so inflate first.
//
// ⚠️ @react-pdf writes its TJ operands as HEX strings — `[<456467> -10 <65…>]` —
// not as `(literal)` strings. The first cut of this function only read the
// literal form, found nothing, and every "no forbidden number appears" check
// passed VACUOUSLY while every positive check failed. That pattern (all the
// negatives green, all the positives red) is what a dead extractor looks like,
// and `assertExtractorWorks` below now makes it impossible to mistake it for a
// clean run.
function pdfStrings(buf: Buffer): string[] {
  const out: string[] = []
  const raw = buf.toString('latin1')
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    let body = m[1]
    try { body = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1') } catch { /* already plain */ }
    // Literal strings…
    const lit = /\(((?:\\.|[^\\)])*)\)/g
    let s: RegExpExecArray | null
    while ((s = lit.exec(body))) out.push(s[1].replace(/\\([()\\])/g, '$1'))
    // …and hex strings, which is the form this renderer actually emits.
    const hex = /<([0-9A-Fa-f]{2,})>/g
    while ((s = hex.exec(body))) {
      const h = s[1]
      let t = ''
      for (let i = 0; i + 1 < h.length; i += 2) t += String.fromCharCode(parseInt(h.slice(i, i + 2), 16))
      out.push(t)
    }
  }
  return out
}
// The text of one TJ array arrives as several fragments; join with nothing so
// "Choose One Option" is findable even when the kerning split it.
const pageText = (buf: Buffer) => pdfStrings(buf).join('')
// react-pdf applies textTransform at RENDER, so every section heading reaches the
// page in caps. Compare case-insensitively or the check is about CSS, not copy.
const lc = (buf: Buffer) => pageText(buf).toLowerCase()

let failures = 0
const check = (n: string, cond: boolean, d = '') => {
  if (cond) console.log(`  ✓ ${n}`)
  else { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
}

// ⭐ THE anti-false-all-clear. Every "no forbidden number appears" assertion in
// this file is only worth anything if the extractor can see the page at all. So
// before believing a single absence, prove a presence: the company name and the
// quote number are on every quote ever rendered.
function assertExtractorWorks(text: string, label: string) {
  const alive = text.includes('Edge Property Services') && text.includes('Q-OPT-001') && text.length > 400
  if (!alive) {
    failures++
    console.log(`  ✗ EXTRACTOR DEAD (${label}) — every "no sum appears" check below would pass vacuously`)
    console.log(`      read ${text.length} chars: ${JSON.stringify(text.slice(0, 160))}`)
  } else {
    console.log(`  ✓ the extractor can read the page (${text.length} chars of ${label})`)
  }
}

async function main() {
  // ── Before any choice ────────────────────────────────────────────────────
  const before = Buffer.from(await (await renderQuoteBlob(BASE, SETTINGS, undefined, OPTIONS)).arrayBuffer())
  writeFileSync(join(OUT, 'quote-options-before.pdf'), before)
  const b = pageText(before)
  assertExtractorWorks(b, 'before-selection')

  console.log('\n═══ BEFORE the customer chooses ═══')
  check('every option is named on the page',
    ['Budget', 'Standard', 'Premium'].every(n => b.includes(n)), b.slice(0, 400))
  check('the recommended one is marked', /Recommended/.test(b))
  check('the page says they are alternatives, before any price is read',
    /alternative versions of the same job/i.test(b) && /choose one option/i.test(b))
  check('the grand total NAMES the option it totals',
    /If you choose Standard/.test(b),
    'an unlabelled "Quote Total" over three prices is the ambiguity this feature removes')
  // ⭐ THE rule. 3,900 + 5,400 + 7,100 = 16,400 (+150 travel each = 16,850).
  const FORBIDDEN = ['16,400', '16,850', '$16,400.00', '$16,850.00', '16400', '16850']
  check('NO figure equal to the sum of the options appears anywhere',
    !FORBIDDEN.some(f => b.includes(f)),
    `found one of ${FORBIDDEN.join(', ')} in: ${b.slice(0, 600)}`)
  check('each option prints its own all-in figure',
    ['$4,050.00', '$5,550.00', '$7,250.00'].every(f => b.includes(f)),
    'option + rolled-in travel — the same arithmetic the approval RPC snapshots')
  check('the ONE big total is the leading option’s, not a combination',
    b.includes('$5,550.00'))
  // Cadence prices must still be there, and still separate.
  check('recurring plan prices are still printed, as their own section',
    /ongoing maintenance options/i.test(b) && b.includes('$55.00') && b.includes('$260.00'))
  check('…and the cadence prices are not folded into the option prices',
    !b.includes('$5,605.00') && !b.includes('$390.00'),
    'weekly+option or the cadence sum appearing would mean the two lists had flattened')

  // ── After the choice ─────────────────────────────────────────────────────
  const chosen = { ...BASE, status: 'accepted', selected_option_id: 'o2' } as unknown as Quote
  const after = Buffer.from(await (await renderQuoteBlob(chosen, SETTINGS, undefined, OPTIONS)).arrayBuffer())
  writeFileSync(join(OUT, 'quote-options-after.pdf'), after)
  const a = pageText(after)

  console.log('\n═══ AFTER the customer chooses Standard ═══')
  assertExtractorWorks(a, 'after-selection')
  check('the chosen option is identified', /your choice/i.test(a) && /approved . standard/i.test(a))
  check('the ones they did not take are still on the record',
    a.includes('Budget') && a.includes('Premium') && /not selected/i.test(a),
    'the document must keep proving what was offered')
  check('…and they are marked as not ordered, not merely listed',
    /were not ordered|not charged/i.test(a))
  check('still no figure equal to the sum', !FORBIDDEN.some(f => a.includes(f)))
  check('the total is the SELECTED option’s', a.includes('$5,550.00'))
  check('the "choose one" instruction is gone once there is nothing to choose',
    !/choose one option/i.test(a) && !/one option only/i.test(a))

  // ── Itemised travel must not fork the per-option figure ──────────────────
  // ⚠️ The one surface disagreement this feature can still produce. An owner who
  // ticked "show travel separately" gets an itemised Travel Fee row on an
  // ORDINARY quote — but on an options quote, printing the options at $5,400
  // while the portal's Approve button says $5,550 and accepted_price records
  // $5,550 is three numbers for one decision. Every option row is all-in,
  // whatever the itemisation preference says.
  const itemised = { ...BASE, show_travel_separately: true } as unknown as Quote
  const it = pageText(Buffer.from(await (await renderQuoteBlob(itemised, SETTINGS, undefined, OPTIONS)).arrayBuffer()))
  console.log('\n═══ "Show travel separately" cannot fork the per-option price ═══')
  assertExtractorWorks(it, 'itemised-travel')
  check('the option rows are still all-in, matching the portal and accepted_price',
    ['$4,050.00', '$5,550.00', '$7,250.00'].every(f => it.includes(f)),
    'printing $3,900 / $5,400 / $7,100 here would contradict the button the customer taps')
  check('and no separate travel row invites adding it twice',
    !/travel fee/i.test(it) && /includes \$150\.00 travel/i.test(it))

  // ── An ordinary quote is untouched ───────────────────────────────────────
  const plain = { ...BASE, weekly_price: null, biweekly_price: null, monthly_price: null } as unknown as Quote
  const p = pageText(Buffer.from(await (await renderQuoteBlob(plain, SETTINGS)).arrayBuffer()))
  console.log('\n═══ An ordinary quote prints exactly as it always did ═══')
  assertExtractorWorks(p, 'plain-quote')
  check('the line-item table is back', /quote details/i.test(p) && /description/i.test(p))
  check('no options language leaks onto it',
    !/choose one option/i.test(p) && !/options offered/i.test(p) && !/recommended/i.test(p) && !/not selected/i.test(p))
  check('the grand total is the plain "Quote Total"', /quote total/i.test(p) && p.includes('$5,550.00'))

  console.log(`\n  PDFs written to ${OUT}`)
}

main().then(() => {
  console.log(failures === 0
    ? '\n✅ quote PDF: alternatives are printed as alternatives, and no number on the page is their sum\n'
    : `\n❌ quote PDF: ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(failures === 0 ? 0 : 1)
}, e => { console.log('\n❌ ' + (e?.message ?? e) + '\n'); process.exit(1) })
