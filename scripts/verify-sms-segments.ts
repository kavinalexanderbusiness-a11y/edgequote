// ── SMS segment + cost verification — npm run verify:sms-segments ───────────
//
// lib/sms/segments.ts is the estimate the owner sees BEFORE pressing Send: which
// encoding a message uses, how many segments it splits into, and what that costs
// per recipient. The segment math follows the real GSM 03.38 / UCS-2 rules, so a
// regression is a WRONG NUMBER, not a type error — a smart-quote silently flipping
// a message to Unicode, or an emoji miscounted at the 70-unit boundary, changes
// the segment count (and the bill) while tsc and next build stay green. Nothing
// exercised it until now.
//
// These are CHARACTERIZATION tests: they encode what the code does today (the
// values were captured from the module itself), so the behaviour is pinned
// without changing a line of it. Pure + deterministic, no I/O — same discipline
// as verify-onboarding / verify-invoice-totals, runnable in CI beside them.

import {
  analyzeSms, resolveSmsPricing, segmentPrice, smsCost, formatSmsCost,
  DEFAULT_SMS_PRICING, type SmsPricing,
} from '../src/lib/sms/segments'
// Section 11 measures the app's own defaults through the engine above — the
// estimator and the messages it prices belong in one guard, or the estimator
// stays correct about templates nobody checked.
import { DEFAULT_TEMPLATES, renderMessage, smsSafe, type MsgType } from '../src/lib/comms/templates'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}

const EMOJI = '\u{1F600}'   // 😀 — one code point, TWO UTF-16 units
const SMARTQUOTE = '’' // ' — the classic GSM→Unicode flip

// ═══════════════════════════════════════════════════════════════════════════
H('1. ENCODING — GSM-7 unless a single character forces UCS-2')
check('plain ASCII is GSM-7', analyzeSms('Hello').encoding, 'GSM-7')
check('accented Latin still in the GSM-7 alphabet stays GSM-7 (café)', analyzeSms('café').encoding, 'GSM-7')
check('a euro sign is GSM-7 (an EXTENSION char, not Unicode)', analyzeSms('€').encoding, 'GSM-7')
check('one smart quote flips the WHOLE message to Unicode', analyzeSms(`It's fine ${SMARTQUOTE}`).encoding, 'Unicode')
check('one emoji flips the whole message to Unicode', analyzeSms(`Thanks ${EMOJI}`).encoding, 'Unicode')
check('a Greek letter (not in GSM-7) is Unicode', analyzeSms('α').encoding, 'Unicode')

// ═══════════════════════════════════════════════════════════════════════════
H('2. EMPTY — zero segments, but a defined shape')
check('empty string → GSM-7, 0 segments, 160 capacity',
  analyzeSms(''), { chars: 0, encoding: 'GSM-7', segments: 0, perSegment: 160 })
check('null → same as empty (no throw)', analyzeSms(null), { chars: 0, encoding: 'GSM-7', segments: 0, perSegment: 160 })
check('undefined → same as empty', analyzeSms(undefined), { chars: 0, encoding: 'GSM-7', segments: 0, perSegment: 160 })

// ═══════════════════════════════════════════════════════════════════════════
H('3. GSM-7 SEGMENT BOUNDARIES — 160 single, then 153 each')
check('5 chars → 1 segment, 160 capacity', analyzeSms('Hello'),
  { chars: 5, encoding: 'GSM-7', segments: 1, perSegment: 160 })
check('exactly 160 → still 1 segment', analyzeSms('A'.repeat(160)),
  { chars: 160, encoding: 'GSM-7', segments: 1, perSegment: 160 })
check('161 → 2 segments, capacity drops to 153', analyzeSms('A'.repeat(161)),
  { chars: 161, encoding: 'GSM-7', segments: 2, perSegment: 153 })
check('306 (= 153×2) → 2 segments', analyzeSms('A'.repeat(306)).segments, 2)
check('307 → 3 segments', analyzeSms('A'.repeat(307)).segments, 3)
check('459 (= 153×3) → 3 segments', analyzeSms('A'.repeat(459)).segments, 3)
check('460 → 4 segments', analyzeSms('A'.repeat(460)).segments, 4)

// ═══════════════════════════════════════════════════════════════════════════
H('4. GSM-7 EXTENSION CHARS — each costs TWO septets, so they halve capacity')
check('one euro sign is 1 visible char but still 1 segment',
  analyzeSms('€'), { chars: 1, encoding: 'GSM-7', segments: 1, perSegment: 160 })
check('80 euro signs = 160 septets → still 1 segment', analyzeSms('€'.repeat(80)),
  { chars: 80, encoding: 'GSM-7', segments: 1, perSegment: 160 })
check('81 euro signs = 162 septets → 2 segments (an extension char pushed it over)',
  analyzeSms('€'.repeat(81)), { chars: 81, encoding: 'GSM-7', segments: 2, perSegment: 153 })

// ═══════════════════════════════════════════════════════════════════════════
H('5. UCS-2 SEGMENT BOUNDARIES — 70 single, then 67 each')
check('one smart quote → Unicode, 1 char, 1 segment', analyzeSms(SMARTQUOTE),
  { chars: 1, encoding: 'Unicode', segments: 1, perSegment: 70 })
check('70 Unicode chars → 1 segment', analyzeSms('α'.repeat(70)),
  { chars: 70, encoding: 'Unicode', segments: 1, perSegment: 70 })
check('71 Unicode chars → 2 segments, capacity 67', analyzeSms('α'.repeat(71)),
  { chars: 71, encoding: 'Unicode', segments: 2, perSegment: 67 })

// ═══════════════════════════════════════════════════════════════════════════
H('6. THE UNITS-vs-CODE-POINTS DISTINCTION — an emoji is 1 char but 2 UTF-16 units')
// Segments are counted by UTF-16 units (what the carrier bills), `chars` by code
// points (what the owner sees). A surrogate-pair emoji is where those diverge, and
// where a naive `.length` on code points would undercount the segments = the bill.
check('one emoji: 1 visible char, but Unicode and 1 segment', analyzeSms(EMOJI),
  { chars: 1, encoding: 'Unicode', segments: 1, perSegment: 70 })
check('35 emoji = 70 UTF-16 units → 1 segment (chars reports 35)', analyzeSms(EMOJI.repeat(35)),
  { chars: 35, encoding: 'Unicode', segments: 1, perSegment: 70 })
check('36 emoji = 72 UTF-16 units → 2 segments (the boundary is units, not chars)',
  analyzeSms(EMOJI.repeat(36)), { chars: 36, encoding: 'Unicode', segments: 2, perSegment: 67 })

// ═══════════════════════════════════════════════════════════════════════════
H('7. PRICING RESOLUTION — a partial/absent config normalizes to a complete one')
check('null → all defaults', resolveSmsPricing(null), DEFAULT_SMS_PRICING)
check('a non-object → all defaults', resolveSmsPricing('nope'), DEFAULT_SMS_PRICING)
check('unicode price defaults to the gsm7 price when unset',
  resolveSmsPricing({ gsm7: 0.02 }), { currency: 'CAD', gsm7: 0.02, unicode: 0.02, provider: 'Twilio' })
check('an explicit unicode price is kept',
  resolveSmsPricing({ gsm7: 0.02, unicode: 0.05 }), { currency: 'CAD', gsm7: 0.02, unicode: 0.05, provider: 'Twilio' })
check('a NEGATIVE price is rejected → default', resolveSmsPricing({ gsm7: -1 }).gsm7, DEFAULT_SMS_PRICING.gsm7)
check('ZERO is a valid price (free tier), not rejected',
  resolveSmsPricing({ gsm7: 0 }), { currency: 'CAD', gsm7: 0, unicode: 0, provider: 'Twilio' })
check('currency is trimmed and upper-cased', resolveSmsPricing({ currency: '  usd ' }).currency, 'USD')
check('a blank currency falls back to the default', resolveSmsPricing({ currency: '   ' }).currency, 'CAD')
// Subtle, pinned on purpose: an empty-string provider is a string, so it is KEPT
// (not defaulted) — only a non-string provider falls back to 'Twilio'.
check('an empty-string provider is kept as-is', resolveSmsPricing({ provider: '' }).provider, '')
check('a non-string provider falls back to the default', resolveSmsPricing({ provider: 123 as unknown as string }).provider, 'Twilio')

// ═══════════════════════════════════════════════════════════════════════════
H('8. COST — segments × recipients × per-segment price, by encoding')
const PRICE: SmsPricing = { currency: 'CAD', gsm7: 0.01, unicode: 0.05 }
check('GSM-7 uses the gsm7 price', segmentPrice('GSM-7', PRICE), 0.01)
check('Unicode uses the unicode price', segmentPrice('Unicode', PRICE), 0.05)
check('2 segments × 3 recipients × $0.015', smsCost(2, 'GSM-7', 3, DEFAULT_SMS_PRICING), 0.09)
check('Unicode cost uses the Unicode rate', smsCost(1, 'Unicode', 2, PRICE), 0.1)
check('negative recipients clamp to 0 (never a negative charge)', smsCost(2, 'GSM-7', -5, DEFAULT_SMS_PRICING), 0)
check('zero segments → zero cost', smsCost(0, 'GSM-7', 10, DEFAULT_SMS_PRICING), 0)

// ═══════════════════════════════════════════════════════════════════════════
H('9. FORMAT — 3 decimals under a dollar, 2 above, and a hard $0.00 floor')
check('zero shows an exact floor, no tilde', formatSmsCost(0), '$0.00 CAD')
check('a negative amount also floors to $0.00 (given currency)', formatSmsCost(-1, 'USD'), '$0.00 USD')
check('under a dollar → 3 decimals with a ~', formatSmsCost(0.045), '~$0.045 CAD')
check('at exactly $1 → 2 decimals (the < 1 boundary)', formatSmsCost(1), '~$1.00 CAD')
check('over a dollar → 2 decimals', formatSmsCost(1.5), '~$1.50 CAD')
check('currency defaults to CAD', formatSmsCost(0.02), '~$0.020 CAD')

// ═══════════════════════════════════════════════════════════════════════════
H('10. END-TO-END — the number the owner actually sees on a real message')
// A 300-character GSM-7 message to 50 recipients: 2 segments each.
const body = 'A'.repeat(300)
const info = analyzeSms(body)
check('300 chars → 2 GSM-7 segments', { s: info.segments, e: info.encoding }, { s: 2, e: 'GSM-7' })
const cost = smsCost(info.segments, info.encoding, 50, DEFAULT_SMS_PRICING)
check('2 segments × 50 recipients × $0.015 = $1.50', cost, 1.5)
check('…formatted for the owner', formatSmsCost(cost, DEFAULT_SMS_PRICING.currency), '~$1.50 CAD')

// ═══════════════════════════════════════════════════════════════════════════
// 11. THE MESSAGES WE ACTUALLY SEND
//
// Everything above proves the ESTIMATOR is right. Nothing proved the app's own
// defaults were cheap — and they were not. Measured through this same engine,
// 15 of 29 defaults were forced to UCS-2 (160 chars/segment → 70) by a single
// character: the em dash in their sign-off. `on_my_way` is 139 characters,
// comfortably one GSM-7 segment, and cost THREE. Across the whole set: 106
// segments, now 53.
//
// Pinned as CONTRACTS, not prose — rewording is fine, making the most-sent
// messages expensive again is not.
H('11. THE DEFAULT TEMPLATES — what they cost to send')
{
  const VARS = {
    firstName: 'Christopher', businessName: 'Edge Property Services', eta: '15',
    reviewLink: 'https://g.page/r/edge-property/review',
    portalLink: 'https://app.edgequote.ca/portal/christopher-MB74A8ZH',
    quoteLink: 'https://app.edgequote.ca/portal/christopher-MB74A8ZH?quote=abc',
    invoiceLink: 'https://app.edgequote.ca/portal/christopher-MB74A8ZH?invoice=abc',
    dateLabel: 'Mon, Aug 18', timeWindow: '9-11 AM', oldDateLabel: 'Fri, Aug 15',
    address: '412 Silverado Way SW', amount: '$150.00',
    confirmationNumber: 'BK-2049', directPhone: '(403) 555-0142',
  }
  const ALL = Object.keys(DEFAULT_TEMPLATES) as MsgType[]
  const seg = (t: MsgType) => analyzeSms(renderMessage(t, null, VARS).sms)

  // ⭐ THE regression that cost the most: one stray character doubles every bill.
  check('no default template is forced into Unicode', ALL.filter(t => seg(t).encoding === 'Unicode'), [])

  // Sent on EVERY visit, often more than once a day per customer.
  const EVERY_VISIT: MsgType[] = ['on_my_way', 'arrived', 'job_complete', 'reminder', 'eta', 'confirm']
  check('every-visit messages fit in ONE segment', EVERY_VISIT.filter(t => seg(t).segments > 1), [])

  // Money and quote messages carry a link, so two segments is the honest ceiling.
  const TRANSACTIONAL: MsgType[] = ['invoice', 'receipt', 'payment_reminder', 'deposit_request', 'quote', 'estimate_followup', 'review_request']
  check('money / quote messages stay within TWO segments', TRANSACTIONAL.filter(t => seg(t).segments > 2), [])

  // Nothing may regress past three, whatever it is.
  check('no default exceeds three segments', ALL.filter(t => seg(t).segments > 3), [])

  // ── The per-channel split: SMS pays for typography, email does not ──────────
  const r = renderMessage('payment_reminder', null, VARS)
  check('email KEEPS real typography', /—/.test(r.html), true)
  check('…while SMS flattens it', /—/.test(r.sms), false)
  check('…leaving the SMS in GSM-7', analyzeSms(r.sms).encoding, 'GSM-7')

  // The biggest real-world win: owner copy pasted from Word or Docs arrives full
  // of smart quotes and silently doubled their bill with no visible cause.
  const pasted = smsSafe('Don’t worry — we’ll be there at 9 o’clock… “rain or shine”')
  check('owner-pasted typography is flattened too', analyzeSms(pasted).encoding, 'GSM-7')
  check('…without losing a single word', pasted, `Don't worry - we'll be there at 9 o'clock... "rain or shine"`)

  // Flattening must never eat the parts that carry meaning.
  const inv = renderMessage('invoice', null, VARS)
  check('the amount survives flattening', /\$150\.00/.test(inv.sms), true)
  check('the link survives flattening', inv.sms.includes(VARS.portalLink), true)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
