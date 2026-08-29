import { jobVisitValueOrNull, type DerivedAmount } from '@/lib/visitValue'

// ── THE price state of a piece of work ───────────────────────────────────────
// One engine, one question: has anyone decided what this costs, and if so, what
// did they decide? Every surface that shows money about a quote or a visit asks
// HERE, so the dashboard, the pipeline, Growth and the invoice drafter can never
// again disagree about whether $0 was a price or a silence.
//
// ⭐⭐ THE DOMAIN LAW, and the whole reason this file exists:
//
//     UNPRICED  ≠  INTENTIONALLY FREE  ≠  $0 DUE  ≠  PAID
//
//   UNPRICED   nobody has said what this costs. It is UNKNOWN. It is not zero,
//              it is not free, and it must never be added to a revenue figure —
//              not as 0, not as anything.
//   NO CHARGE  somebody DECIDED this is free, on the record, with a reason and
//              a name against it. A known amount that happens to be $0.
//   $0 DUE     a balance, computed from a ledger. Lives in lib/payments.
//   PAID       money actually arrived. Also the ledger's business.
//
// This module owns the first two. It deliberately knows nothing about balances
// or payments: conflating "free" with "settled" is the next version of the same
// mistake.
//
// ⛔ A BARE $0 IS NEVER FREE. `price = 0` with no no-charge record is UNPRICED —
// zero is what a blank numeric input becomes on its way through `Number('')`,
// which is exactly how unpriced work got its price in the first place.
//
// Pure and IO-free (the shape lib/quoteStatus and lib/portalRequests established)
// so the guard can drive the real production logic rather than a copy of it.

/** What is known about what this work costs. */
export type PriceState = 'priced' | 'unpriced' | 'no_charge'

// ── The no-charge record ─────────────────────────────────────────────────────
// Free work is a DECISION, so it carries the evidence of one. All three parts
// are required together: a reason nobody signed is an assertion, and a signature
// with no reason is a shrug. `at` is the audit timestamp; `by` is the actor.
//
// ⚠️ These fields are read with `?.` throughout and every reader treats absent
// as "not free". That is what lets this module run correctly against a database
// where the columns do not exist yet — a `select('*')` simply omits them. See
// supabase/proposals/no_charge_v1.sql; nothing in the app WRITES them until that
// migration is applied.
export interface NoChargeRecord {
  no_charge_at?: string | null
  no_charge_reason?: string | null
  no_charge_by?: string | null
}

/** Is this row explicitly, accountably free? All three parts or none. */
export function isNoCharge(r: NoChargeRecord | null | undefined): boolean {
  return !!(r?.no_charge_at && String(r.no_charge_reason ?? '').trim() && r?.no_charge_by)
}

/** A no-charge decision that is missing part of its evidence. Not free — the
 *  record is incomplete, and an incomplete record must not authorise free work.
 *  Surfaced so Data Quality can name it rather than silently reading it as
 *  unpriced. */
export function isPartialNoCharge(r: NoChargeRecord | null | undefined): boolean {
  const parts = [!!r?.no_charge_at, !!String(r?.no_charge_reason ?? '').trim(), !!r?.no_charge_by]
  return parts.some(Boolean) && !parts.every(Boolean)
}

// ── Quotes ───────────────────────────────────────────────────────────────────

export interface PriceableQuote extends NoChargeRecord {
  total?: number | null
  initial_price?: number | null
}

/**
 * A quote's price state.
 *
 * ⭐ `total` is the GENERATED column `initial_price + travel_fee + addons_total`,
 * and Postgres already does the right thing: NULL + anything is NULL, so an
 * unpriced quote HAS no total. The database has been telling the truth the whole
 * time; the app was the layer that turned it into a zero.
 */
export function quotePriceState(q: PriceableQuote | null | undefined): PriceState {
  if (!q) return 'unpriced'
  if (isNoCharge(q)) return 'no_charge'
  const t = Number(q.total)
  // `> 0` and not merely "is a number": a stored 0 with no no-charge record is
  // the manufactured zero this work exists to stop believing.
  return Number.isFinite(t) && t > 0 ? 'priced' : 'unpriced'
}

/** The amount, or UNKNOWN. A no-charge quote is a KNOWN zero — that is the
 *  entire difference between the two, expressed as a number. */
export function quoteAmountOrNull(q: PriceableQuote | null | undefined): DerivedAmount {
  const s = quotePriceState(q)
  if (s === 'no_charge') return 0
  if (s === 'unpriced') return null
  return Number(q!.total)
}

// ── Jobs / visits ────────────────────────────────────────────────────────────

export interface PriceableJob extends NoChargeRecord {
  price?: number | null
  is_initial_visit?: boolean | null
}

/**
 * A visit's price state, resolved through the SAME derivation the invoice
 * drafter and every dashboard use (lib/visitValue) — never a second reading.
 *
 * ⭐ `job.price === null` is NOT unpriced on its own: on `jobs` it means "no
 * job-level override, follow the quote", which lib/recurrence and the schedule
 * page both write deliberately. Unpriced is when that derivation finds nothing
 * either — no job price AND no quote price.
 */
export function jobPriceState(
  job: PriceableJob | null | undefined,
  quote: Record<string, unknown> | null | undefined,
  freq: string | null,
): PriceState {
  if (!job) return 'unpriced'
  if (isNoCharge(job)) return 'no_charge'
  const v = jobVisitValueOrNull(job.price, quote, freq, job.is_initial_visit ?? false)
  return v != null && v > 0 ? 'priced' : 'unpriced'
}

/** A visit's amount, or UNKNOWN. No-charge resolves to a known 0. */
export function jobAmountOrNull(
  job: PriceableJob | null | undefined,
  quote: Record<string, unknown> | null | undefined,
  freq: string | null,
): DerivedAmount {
  const s = jobPriceState(job, quote, freq)
  if (s === 'no_charge') return 0
  if (s === 'unpriced') return null
  return jobVisitValueOrNull(job!.price, quote, freq, job!.is_initial_visit ?? false)
}

// ── Words ────────────────────────────────────────────────────────────────────
// Kept beside the rule so a new state cannot be added without a sentence for it
// (the shape lib/portalRequests and lib/quoteOptions both use).

/**
 * The value a numeric FORM FIELD holds when nobody has typed in it.
 *
 * react-hook-form types these fields as `number`, and seeding one with `0`
 * renders a literal "0" the owner then has to delete — which is how a money
 * field came to arrive pre-filled with an amount nobody chose. An empty string
 * renders as empty and every save path already turns it into NULL.
 *
 * ⭐ Exported from here, and imported by BOTH money forms (QuoteBuilder and
 * JobForm), because two local copies of one sentinel is how the fix drifts back
 * out of one of them — which has already happened once to QuoteBuilder's, in the
 * 2026-07-26 replay that "silently took the pre-fix side; the zeros returned".
 */
export const BLANK_NUMERIC_FIELD = '' as unknown as number

/** What the owner reads where a price would go. ⛔ Never "$0.00". */
export const PRICE_STATE_LABEL: Record<PriceState, string> = {
  priced: 'Priced',
  unpriced: 'Not set',
  no_charge: 'No charge',
}

/** One line explaining what the state MEANS, in the owner's terms. */
export const PRICE_STATE_MEANING: Record<PriceState, string> = {
  priced: 'Someone has set what this costs',
  unpriced: 'Nobody has priced this yet — it is not $0, it is unknown',
  no_charge: 'Deliberately free, on the record',
}

/** How an unknown amount reads inline. One spelling, everywhere. */
export const UNKNOWN_AMOUNT_TEXT = 'Not set'

/**
 * Money for display, with the unknown told rather than hidden.
 * ⛔ This is the ONLY sanctioned way to render a possibly-unknown amount. A
 * surface that wants a number instead must say on screen what it did with the
 * unknown ones — see `excludedNote`.
 */
export function amountText(amount: DerivedAmount, money: (n: number) => string): string {
  return amount == null ? UNKNOWN_AMOUNT_TEXT : money(amount)
}

/**
 * The honest footnote for a total that had to leave records out.
 * Returns null when nothing was excluded, so a clean total carries no apology.
 *
 * ⭐ THE RULE THIS ENCODES: a total may exclude unknowns — it cannot pretend
 * they were zero. "$4,200 from 14 visits" over a book with 3 unpriced visits is
 * a lie of omission; "$4,200 from 14 visits · 3 not priced yet" is a figure a
 * person can act on.
 */
export function excludedNote(unknownCount: number, noun = 'record'): string | null {
  if (!unknownCount || unknownCount < 1) return null
  return `${unknownCount} ${noun}${unknownCount === 1 ? '' : 's'} not priced yet — excluded`
}

// ── Summing a set of records ─────────────────────────────────────────────────
// ⭐⭐ THE REPLACEMENT FOR `reduce((s, q) => s + Number(q.total || 0), 0)`, which
// this codebase had NINE copies of — dashboard priorities, the weekly review,
// business intelligence, suggestions, the customer page. Every one of them added
// a silent zero for each unpriced quote, so nine different figures were wrong in
// the same way and none of them said so.
//
// It returns the count alongside the total ON PURPOSE: a caller cannot take the
// money without also being handed the number of records it had to leave out.
// That is what makes `excludedNote` cheap to render and hard to forget.

export interface AmountRollup {
  /** The sum of every KNOWN amount. Free work contributes its real 0. */
  total: number
  /** How many records had no price and were therefore excluded. */
  unknown: number
  /** How many records were actually summed. Use THIS as an average's divisor —
   *  dividing a priced-only total by the full count is the second half of the
   *  same bug. */
  counted: number
}

export function sumQuoteAmounts(quotes: readonly (PriceableQuote | null | undefined)[]): AmountRollup {
  let total = 0, unknown = 0, counted = 0
  for (const q of quotes) {
    const a = quoteAmountOrNull(q)
    if (a == null) { unknown++; continue }
    total += a; counted++
  }
  return { total, unknown, counted }
}

// ── Reading the records that already exist ───────────────────────────────────
// ⛔⛔ CLASSIFICATION ONLY. Nothing here writes, and nothing that consumes it may
// write either. Every $0 row in production was created by a system that could
// not tell "free" from "unpriced", so the app CANNOT now decide which one any
// given row meant — only a human who was there can. Rewriting them automatically
// would replace an honest unknown with a confident guess, which is the exact
// failure this whole lane is about.
//
// So the output is three buckets and a recommended question, never a patch.

export type LegacyZeroClass =
  /** Carries a complete no-charge record. Nothing to do. */
  | 'legitimate_free'
  /** Strong evidence nobody priced it: no money anywhere near the record. */
  | 'likely_unpriced'
  /** Evidence points both ways, or there is not enough of it. Ask a human. */
  | 'ambiguous'

export interface LegacyZeroInput extends NoChargeRecord {
  /** The stored amount: 0 or null (a priced row is not a candidate at all). */
  amount?: number | null
  /** Was the work actually delivered? Completed $0 work is the costly case. */
  completed?: boolean
  /** Does an invoice exist against it? An invoice for $0 is a deliberate act far
   *  more often than a blank price field is. */
  hasInvoice?: boolean
  /** Did any payment land against it? Money proves it was never free. */
  hasPayment?: boolean
  /** Free text an owner wrote — the only place a pre-migration "no charge"
   *  decision could have been recorded, because there was no column for it. */
  note?: string | null
}

/** Words an owner actually uses when they meant "free". Matched on the OWNER's
 *  own note, never inferred from the amount. Deliberately narrow: a false
 *  'legitimate_free' is worse than an 'ambiguous', because it closes a question
 *  that should have been asked. */
const FREE_PHRASES = /\b(no charge|free of charge|comp(?:ed|limentary)?|goodwill|warranty|on us|gratis|write[- ]?off|redo|make[- ]?good)\b/i

export function classifyLegacyZero(r: LegacyZeroInput): { klass: LegacyZeroClass; why: string } {
  if (isNoCharge(r)) return { klass: 'legitimate_free', why: 'Has a complete no-charge record (reason, actor, timestamp).' }
  if (isPartialNoCharge(r)) return { klass: 'ambiguous', why: 'A no-charge record was started but is incomplete — someone meant something here.' }
  // Money against a $0 record is a contradiction, not a free job.
  if (r.hasPayment) return { klass: 'ambiguous', why: 'A payment exists against a record with no price — the amounts disagree.' }
  if (r.note && FREE_PHRASES.test(r.note)) {
    return { klass: 'ambiguous', why: 'The note reads as deliberate free work, but nobody recorded who decided it or when.' }
  }
  if (r.hasInvoice) return { klass: 'ambiguous', why: 'It was invoiced at $0 — deliberate more often than blank, but not recorded as such.' }
  if (r.completed) return { klass: 'likely_unpriced', why: 'Work was completed and no price, invoice, payment or note exists anywhere against it.' }
  return { klass: 'likely_unpriced', why: 'No price, and no evidence anyone decided it was free.' }
}

// ── Gates ────────────────────────────────────────────────────────────────────
// The narrow universal rule, in one sentence: UNPRICED WORK MAY BE DRAFTED,
// SCHEDULED AND DONE — IT MAY NOT BE AUTHORISED, BILLED, OR COUNTED AS MONEY.
//
// ⭐ Why scheduling and completion are deliberately NOT gated (measured, not
// assumed): `book_service` creates a job from a public booking before anyone has
// priced it; a crew completing a visit is recording that WORK HAPPENED, which is
// true whatever it cost; and `jobs.price = null` is the normal state of every
// visit in a quote-linked series. Blocking any of those would break real
// operations to fix an accounting problem. The money door is where the lie
// happens, so the money door is where the gate goes — invoicing already refuses
// (`no-amount`), and everything below joins it.

/** Whether unpriced work may pass this door. `false` for every money door. */
export const MONEY_DOORS = [
  'send',            // a document in a customer's hands
  'accept',          // customer-authorised paid work
  'won',             // the owner recording that authorisation
  'invoice',         // billing
  'booked_revenue',  // money the business says it has coming
  'projection',      // money the business says it will have
  'growth',          // a recommendation computed from money
] as const
export type MoneyDoor = (typeof MONEY_DOORS)[number]

/** May work in this price state pass a money door? A no-charge record passes:
 *  it is a known amount, and refusing it is what made real free work
 *  impossible to send. */
export function passesMoneyDoor(s: PriceState): boolean {
  return s !== 'unpriced'
}

/** Why the door refused — null when it did not. */
export function moneyDoorBlock(s: PriceState, door: MoneyDoor): string | null {
  if (passesMoneyDoor(s)) return null
  switch (door) {
    case 'send':   return 'This has no price yet — add one, or mark it No charge, before sending it.'
    case 'accept': return 'This has no price yet, so it cannot be approved.'
    case 'won':    return 'Set a price (or mark it No charge) before recording this as won — otherwise the win has no value.'
    case 'invoice': return 'This has no price yet, so there is nothing to bill.'
    default:       return 'Not priced yet — excluded until someone sets a price.'
  }
}
