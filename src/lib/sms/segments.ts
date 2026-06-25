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

// Rough Twilio Canada outbound price per segment, in CAD. Deliberately a single,
// easy-to-tune constant — the estimate is for awareness, not invoicing.
export const SMS_COST_PER_SEGMENT_CAD = 0.015

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

// Estimated cost in CAD for `segments` per recipient × `recipients`.
export function smsCostCad(segments: number, recipients = 1): number {
  return segments * Math.max(0, recipients) * SMS_COST_PER_SEGMENT_CAD
}

// "~$0.03 CAD" — 3 decimals under a dollar (per-message), 2 above (bulk totals).
export function formatSmsCost(cad: number): string {
  if (cad <= 0) return '$0.00 CAD'
  return '~$' + (cad < 1 ? cad.toFixed(3) : cad.toFixed(2)) + ' CAD'
}
