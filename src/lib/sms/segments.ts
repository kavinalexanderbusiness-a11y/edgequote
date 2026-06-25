// ── SMS segment + cost estimator ─────────────────────────────────────────────────
// Approximate (but encoding-aware) so the owner can see roughly what a send costs
// BEFORE pressing Send. Not billing-accurate — carrier/Twilio pricing varies — but
// the segment math follows the real rules so the estimate tracks reality.
//
// Encoding: a message is sent as GSM-7 if EVERY character is in the GSM-7 alphabet;
// otherwise the whole message falls back to UCS-2 (Unicode) — a single emoji or
// "smart quote" flips it. Segment lengths: GSM-7 = 160 (single) / 153 (multipart);
// UCS-2 = 70 (single) / 67 (multipart). GSM-7 extension chars cost 2 septets each.

// GSM 03.38 basic alphabet (printable + \n, \r). ESC (extension marker) excluded.
const GSM7_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
// Extension chars — each takes TWO GSM-7 septets (an ESC + the char).
const GSM7_EXT = '^{}\\[~]|€'
const GSM7 = new Set<string>([...GSM7_BASIC, ...GSM7_EXT])
const GSM7_EXT_SET = new Set<string>([...GSM7_EXT])

export type SmsEncoding = 'GSM-7' | 'Unicode'

export interface SmsInfo {
  chars: number          // visible characters (code points)
  encoding: SmsEncoding
  segments: number       // number of SMS this message splits into
  perSegment: number     // capacity of each segment for this message
}

// Pricing is CONFIGURABLE (Business Settings → Messaging) so the estimate stays
// accurate as carrier/provider rates change — no code edit needed. Per-segment
// prices are kept separate for GSM-7 vs Unicode (some providers differ); Unicode
// defaults to the GSM-7 price. DEFAULT is a rough Twilio-Canada figure used until
// the owner configures their own.
export interface SmsPricing {
  currency: string     // e.g. 'CAD'
  gsm7: number         // estimated cost per GSM-7 segment
  unicode: number      // estimated cost per Unicode (UCS-2) segment
  provider?: string    // free-text, for the owner's reference / future providers
}

export const DEFAULT_SMS_PRICING: SmsPricing = { currency: 'CAD', gsm7: 0.015, unicode: 0.015, provider: 'Twilio' }

// Normalize a stored (possibly partial / null) pricing config into a complete one.
export function resolveSmsPricing(raw: unknown): SmsPricing {
  const p = (raw && typeof raw === 'object') ? raw as Partial<SmsPricing> : {}
  const gsm7 = typeof p.gsm7 === 'number' && p.gsm7 >= 0 ? p.gsm7 : DEFAULT_SMS_PRICING.gsm7
  const unicode = typeof p.unicode === 'number' && p.unicode >= 0 ? p.unicode : gsm7
  const currency = typeof p.currency === 'string' && p.currency.trim() ? p.currency.trim().toUpperCase() : DEFAULT_SMS_PRICING.currency
  return { currency, gsm7, unicode, provider: typeof p.provider === 'string' ? p.provider : DEFAULT_SMS_PRICING.provider }
}

// Per-segment price for a message's encoding.
export function segmentPrice(encoding: SmsEncoding, pricing: SmsPricing): number {
  return encoding === 'Unicode' ? pricing.unicode : pricing.gsm7
}

export function analyzeSms(text: string | null | undefined): SmsInfo {
  const t = text || ''
  const chars = [...t].length

  // GSM-7 only if every character is representable in it.
  let gsm = true
  for (const ch of t) { if (!GSM7.has(ch)) { gsm = false; break } }

  if (gsm) {
    let septets = 0
    for (const ch of t) septets += GSM7_EXT_SET.has(ch) ? 2 : 1
    const segments = septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153)
    return { chars, encoding: 'GSM-7', segments, perSegment: segments <= 1 ? 160 : 153 }
  }

  // UCS-2: count UTF-16 code units (emoji/surrogate pairs take 2).
  const units = t.length
  const segments = units === 0 ? 0 : units <= 70 ? 1 : Math.ceil(units / 67)
  return { chars, encoding: 'Unicode', segments, perSegment: segments <= 1 ? 70 : 67 }
}

// Estimated cost for `segments` (of the given encoding) × `recipients`.
export function smsCost(segments: number, encoding: SmsEncoding, recipients: number, pricing: SmsPricing): number {
  return segments * Math.max(0, recipients) * segmentPrice(encoding, pricing)
}

// "~$0.03 CAD" — 3 decimals under a dollar (per-message), 2 above (bulk totals).
export function formatSmsCost(amount: number, currency = 'CAD'): string {
  if (amount <= 0) return '$0.00 ' + currency
  return '~$' + (amount < 1 ? amount.toFixed(3) : amount.toFixed(2)) + ' ' + currency
}
