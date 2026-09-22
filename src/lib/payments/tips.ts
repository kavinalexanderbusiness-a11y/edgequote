export const TIP_PERCENT_PRESETS = [0, 10, 15, 20] as const
export type TipPercent = typeof TIP_PERCENT_PRESETS[number]

export type TipRequest =
  | { kind: 'percent'; value: TipPercent }
  | { kind: 'custom'; cents: number }

export interface ValidatedTip {
  cents: number
  selection: 'none' | '10' | '15' | '20' | 'custom'
}

// A tip is optional and can never be used to smuggle an arbitrary charge into
// Checkout. The invoice/deposit amount is still derived server-side; this helper
// only validates the extra amount against that trusted base.
export function validateTipRequest(input: unknown, baseCents: number): ValidatedTip {
  if (!Number.isSafeInteger(baseCents) || baseCents <= 0) throw new Error('invalid base amount')
  if (input == null) return { cents: 0, selection: 'none' }
  if (typeof input !== 'object') throw new Error('invalid tip selection')

  const value = input as { kind?: unknown; value?: unknown; cents?: unknown }
  let cents: number
  let selection: ValidatedTip['selection']
  if (value.kind === 'percent') {
    if (!TIP_PERCENT_PRESETS.includes(value.value as TipPercent)) throw new Error('invalid tip percentage')
    const pct = value.value as TipPercent
    cents = Math.round(baseCents * pct / 100)
    selection = pct === 0 ? 'none' : String(pct) as ValidatedTip['selection']
  } else if (value.kind === 'custom') {
    if (!Number.isSafeInteger(value.cents) || Number(value.cents) < 0) throw new Error('invalid custom tip')
    cents = Number(value.cents)
    selection = cents === 0 ? 'none' : 'custom'
  } else {
    throw new Error('invalid tip selection')
  }

  // Bound custom tips to the lower of the charge itself and CAD $500. This still
  // supports generous tips while preventing an input typo from becoming a large
  // unrelated card charge. Presets pass through the same cap.
  const cap = Math.min(baseCents, 50_000)
  if (cents > cap) throw new Error(`Tip cannot exceed $${(cap / 100).toFixed(2)}.`)
  return { cents, selection }
}

export function splitRefundCents(refundedCents: number, baseCents: number, tipCents: number) {
  const total = baseCents + tipCents
  const bounded = Math.max(0, Math.min(Math.round(refundedCents), total))
  // Refund the voluntary amount first. This avoids reopening an invoice balance
  // for a tip-only adjustment; a full refund still reverses both rows exactly.
  const tip = Math.min(bounded, tipCents)
  return { tipCents: tip, baseCents: bounded - tip }
}
