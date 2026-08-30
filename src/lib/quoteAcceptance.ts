// ── THE quote acceptance engine ──────────────────────────────────────────────
//
// Pure, I/O-free, and the only place the product decides what an acceptance IS,
// what changes un-do one, and what words describe it. The database owns the same
// rules (20260828140000_quote_acceptance_integrity_v1.sql); this file exists so a
// button can be labelled, disabled and explained without a round trip — never so
// a second implementation can drift away from the first.
//
// ── THE FIVE EVENTS, WHICH ARE NOT ONE EVENT ─────────────────────────────────
// Collapsing any two of these is how a business ends up asserting something
// nobody said:
//
//   CUSTOMER ACCEPTED     they decided, in their own portal, and the token that
//                         let them in names them.
//   OWNER ON THEIR BEHALF staff recorded a decision that arrived by phone, email
//                         or in person. A real, everyday, legitimate act — and a
//                         DIFFERENT one, which must carry a reason.
//   STATUS OVERRIDE       someone set the label to Accepted. Nobody consented to
//                         anything. It produces NO acceptance record, and every
//                         surface that reads one says so.
//   CONTRACT SIGNED       Sessions 74/83. Not here, not ever from this file.
//   PAYMENT RECEIVED      the ledger. A deposit is not a yes and a yes is not a
//                         payment.
//
// ── THE VOCABULARY RULING ────────────────────────────────────────────────────
// ⭐ One word for the quote's own state: ACCEPTED. The product previously said
// "Approved" on the status pill, the portal button and the PDF; "Accepted" in
// four dashboard banners; and "Won" on the quote page's own action and toast.
// Three words, one event, on screens an owner reads side by side.
//
// ⭐ "Won" SURVIVES, and is not a synonym. lib/salesStage's ladder describes a
// DEAL, not a document — a deal can be won before any quote exists. Renaming that
// rung would erase a distinction the pipeline deliberately makes. The rule is:
// the quote's status says Accepted; the deal's rung says Won.
//
// ⭐ "Signed" is not ours. Sessions 74/83 own signatures, and an acknowledgement
// tick is not a signature — see TERMS below.

import type { QuoteStatus } from '@/types'

// ── What kind of acceptance ──────────────────────────────────────────────────

/**
 * The two ways consent is genuinely obtained — plus one that is neither, and
 * says so.
 *
 * ⭐ `legacy_unrecorded` is the BACKFILL kind. Every quote already sitting at
 * accepted/scheduled/completed/paid when this shipped was accepted before any
 * evidence existed, and the migration writes one row per quote saying exactly
 * that: a deal exists, and who accepted it, when, and against which terms was
 * never recorded. Without it the gate below would answer "not authorized" for
 * the entire existing book on the first deploy.
 *
 * ⛔ It authorizes the terms AS THEY STOOD AT BACKFILL — and no further. From
 * that moment a material change flags reapproval exactly like a real one. It is
 * never rendered as somebody having consented; see acceptanceSentence.
 */
export type AcceptanceKind = 'customer' | 'owner_on_behalf' | 'legacy_unrecorded'
/** The door it came through. Passed by the door that knows; never inferred. */
export type AcceptanceSource = 'portal' | 'dashboard' | 'migration'

/** Where an owner-recorded decision actually reached them. */
export type OnBehalfReason = 'phone' | 'email' | 'text_message' | 'in_person' | 'written' | 'other'

/**
 * ⭐ NO DEFAULT, DELIBERATELY. The reason is what makes an owner-recorded
 * acceptance a record instead of an assertion, so there is no value here for a
 * caller to fall back on and no "other" pre-selected. The database refuses a
 * null reason for the same reason (owner_record_customer_acceptance).
 */
export const ON_BEHALF_REASONS: { value: OnBehalfReason; label: string }[] = [
  { value: 'phone', label: 'They told me on the phone' },
  { value: 'email', label: 'They replied by email' },
  { value: 'text_message', label: 'They replied by text' },
  { value: 'in_person', label: 'They said yes in person' },
  { value: 'written', label: 'They signed or wrote it down' },
  { value: 'other', label: 'Something else — see my note' },
]

const REASON_PHRASE: Record<OnBehalfReason, string> = {
  phone: 'by phone',
  email: 'by email',
  text_message: 'by text',
  in_person: 'in person',
  written: 'in writing',
  other: 'another way',
}

/** The row `quote_acceptance_state()` returns. Read-only, always. */
export interface AcceptanceState {
  accepted: boolean
  acceptance_id: string | null
  acceptance_seq: number | null
  accepted_at: string | null
  kind: AcceptanceKind | null
  source: AcceptanceSource | null
  actor_label: string | null
  on_behalf_reason: OnBehalfReason | null
  accepted_amount: number | string | null
  selected_option_id: string | null
  document: AcceptedDocument | null
  terms_acknowledged: boolean
  needs_reapproval: boolean
  terms_changed: boolean
}

/** The immutable snapshot stored in quote_acceptances.document. */
export interface AcceptedDocument {
  quote_number?: string | null
  customer_name?: string | null
  address?: string | null
  service_type?: string | null
  notes?: string | null
  initial_price?: number | string | null
  travel_fee?: number | string | null
  total?: number | string | null
  valid_until?: string | null
  deposit_type?: string | null
  deposit_value?: number | string | null
  plan_prices?: { weekly?: number | string | null; biweekly?: number | string | null; monthly?: number | string | null } | null
  option?: { id: string; name: string; description?: string | null; price: number | string } | null
  options_offered?: { id: string; name: string; price: number | string }[] | null
  addons?: { id: string; name: string; price: number | string }[] | null
  services?: {
    service_type: string; quantity: number | string; unit: string | null
    unit_price: number | string; discount_type: string | null
    discount_value: number | string | null; notes: string | null; kind: string
  }[] | null
}

// ── Standing ─────────────────────────────────────────────────────────────────

/**
 * What the acceptance record says right now.
 *
 *   none            nobody has accepted. If the status still says Accepted, that
 *                   is an ADMINISTRATIVE OVERRIDE and the UI must say so — the
 *                   one state this whole feature exists to stop being invisible.
 *   standing        a live acceptance, and the document still matches it.
 *   needs_reapproval a real acceptance exists, but the deal has changed since.
 */
export type AcceptanceStanding = 'none' | 'standing' | 'needs_reapproval'

export function acceptanceStanding(s: AcceptanceState | null | undefined): AcceptanceStanding {
  if (!s?.accepted) return 'none'
  return s.needs_reapproval || s.terms_changed ? 'needs_reapproval' : 'standing'
}

/**
 * ⭐ THE state that made the old model dishonest: the quote SAYS accepted and
 * nothing in the record supports it. Not an error — an owner repairing a stuck
 * row is a real need — but it must never render as "the customer approved this".
 */
export function isUnevidencedAcceptance(status: QuoteStatus | string, s: AcceptanceState | null | undefined): boolean {
  return isAcceptedOrBeyond(status) && !s?.accepted
}

// ── ⭐⭐ THE GATE — asked once, by everything that acts ───────────────────────
//
// "May I act on this quote's commercial terms right now?" Scheduling a job,
// converting to an invoice and asking for a deposit are the same question in
// three costumes, and before this each answered it by reading `quotes.status`.
// Status is not evidence: it survives the edit that invalidated the consent
// behind it, which is precisely how a customer ends up billed for a number they
// never agreed to.
//
// ⛔ DO NOT RE-DERIVE THIS. Every acting path calls this one function (or its
// database twin, quote_acceptance_is_current) — a second fingerprint comparison
// somewhere else is a second answer waiting to disagree.

/** Does a live, un-drifted acceptance authorize this quote's CURRENT terms? */
export function hasCurrentValidAcceptance(s: AcceptanceState | null | undefined): boolean {
  return acceptanceStanding(s) === 'standing'
}

/**
 * Why acting on the terms is refused — null when it is not.
 *
 * The two reasons are NOT interchangeable to a human, which is the whole reason
 * this returns a reason rather than a boolean: "nobody accepted this" and "they
 * accepted a different deal" call for completely different next actions.
 */
export type AuthorizationBlock = 'never_accepted' | 'pending_reapproval'

export function acceptanceBlock(
  status: QuoteStatus | string,
  s: AcceptanceState | null | undefined,
): AuthorizationBlock | null {
  if (hasCurrentValidAcceptance(s)) return null
  return s?.accepted ? 'pending_reapproval' : 'never_accepted'
  // ⚠️ `status` is deliberately UNUSED for the verdict and kept in the signature
  // so no caller can pass the ledger alone and think status still counts for
  // something. It is the input that used to be trusted; it is now the input that
  // proves nothing.
}

/** What to tell the owner, and what to do about it. */
export function acceptanceBlockLabel(b: AuthorizationBlock, action = 'this'): string {
  return b === 'never_accepted'
    ? `No customer acceptance is on record for this quote, so ${action} can’t go ahead yet. Record how they accepted it first.`
    : `This quote has changed since it was accepted, so ${action} can’t go ahead on the old approval. Send it again and record the new acceptance.`
}

/**
 * ⭐ THE AUTHORIZED FIGURE — the amount consented to, taken from the LEDGER and
 * never from the live row.
 *
 * When the acceptance is current these agree by construction (a moved price
 * moves the fingerprint), so reading the ledger costs nothing. When it is NOT
 * current they disagree, and that gap is exactly the money an invoice would
 * otherwise bill against an approval that never covered it.
 */
export function authorizedAmount(s: AcceptanceState | null | undefined): number | null {
  if (!s?.accepted || s.accepted_amount == null) return null
  const n = Number(s.accepted_amount)
  return Number.isFinite(n) ? n : null
}

/** Statuses that all assert, downstream, that a deal was struck. */
export function isAcceptedOrBeyond(status: QuoteStatus | string): boolean {
  return status === 'accepted' || status === 'scheduled' || status === 'completed' || status === 'paid'
}

// ── What changed ─────────────────────────────────────────────────────────────
//
// ⭐⭐ THE MATERIALITY LIST, stated once. The database answers "did it change?"
// with a fingerprint (quote_material_fingerprint); this answers "WHAT changed?"
// so a banner can name it. The two are pinned to each other field-by-field by
// verify:quote-acceptance-integrity — every key below is mutated against the SQL
// function, and every excluded key is mutated too, to prove it does NOT count.

/** A material fact on the quote row itself. Changing one requires reapproval. */
export const MATERIAL_QUOTE_FIELDS = [
  'initial_price', 'travel_fee', 'addons_total',
  'weekly_price', 'biweekly_price', 'monthly_price',
  'deposit_type', 'deposit_value',
  'service_type', 'address', 'notes',
  'selected_option_id',
] as const

/**
 * Corrections that do NOT un-accept a quote, named rather than merely omitted —
 * so that adding a column later is a decision somebody makes, not a default
 * somebody inherits.
 *
 * `internal_notes` is staff-only by construction (`notes` is the customer-facing
 * one and IS material). The measurement and scoring columns describe the
 * property, not the promise. `sent_at` / `valid_until` / the follow-up counters
 * are the chase record. `preferred_date` is the customer's own scheduling wish,
 * which they may change without renegotiating anything.
 */
export const NON_MATERIAL_QUOTE_FIELDS = [
  'internal_notes', 'property_id', 'customer_id', 'customer_name',
  'measured_sqft', 'front_lawn_sqft', 'back_lawn_sqft', 'left_side_sqft',
  'right_side_sqft', 'boulevard_sqft', 'other_sqft', 'travel_distance_km',
  'measurement_snapshot', 'pricing_confidence', 'suggested_price', 'value_grade',
  'nearby_count', 'price_source', 'lead_meta',
  'sent_at', 'valid_until', 'last_followed_up_at', 'follow_up_count',
  'preferred_date', 'preferred_date_2', 'preferred_timing', 'preferred_note',
  'issued_date', 'selected_cadence',
] as const

/** A named difference between what was accepted and what the quote says now. */
export interface MaterialChange {
  /** Which fact moved — the owner's word for it, not the column name. */
  what: string
  /** As accepted. Null when the fact did not exist then. */
  was: string | null
  /** As it stands. Null when the fact has been removed. */
  now: string | null
}

/** The live shape materialChanges() compares against the snapshot. */
export interface LiveQuoteFacts {
  initial_price?: number | string | null
  travel_fee?: number | string | null
  total?: number | string | null
  service_type?: string | null
  address?: string | null
  notes?: string | null
  weekly_price?: number | string | null
  biweekly_price?: number | string | null
  monthly_price?: number | string | null
  deposit_type?: string | null
  deposit_value?: number | string | null
  selected_option_id?: string | null
  options?: { id: string; name: string; price: number | string }[] | null
  addons?: { id: string; name: string; price: number | string; is_selected?: boolean }[] | null
  services?: {
    service_type: string; quantity: number | string; unit?: string | null
    unit_price: number | string; discount_type?: string | null
    discount_value?: number | string | null; notes?: string | null; kind?: string
  }[] | null
}

const money = (v: number | string | null | undefined): string | null =>
  v === null || v === undefined || v === '' ? null : Number(v).toFixed(2)
const text = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim()
  return t === '' ? null : t
}

/**
 * What moved between the accepted document and the quote as it stands.
 *
 * ⚠️ AN EMPTY LIST IS NOT PROOF OF NOTHING. This compares the facts it knows;
 * the DATABASE's fingerprint is the authority, and `needs_reapproval` comes from
 * there. When the two disagree the banner still shows (standing is computed from
 * the database's answer) and simply cannot itemise — which is the honest failure
 * for a describer, and the reason this returns a list rather than a boolean.
 */
export function materialChanges(doc: AcceptedDocument | null | undefined, live: LiveQuoteFacts): MaterialChange[] {
  if (!doc) return []
  const out: MaterialChange[] = []
  const cmp = (what: string, was: string | null, now: string | null) => {
    if (was !== now) out.push({ what, was, now })
  }

  // The chosen option is compared by its own NAME AND PRICE, copied into the
  // snapshot — not by id. An owner who deletes "Premium" and adds a new option
  // also called "Premium" at a different price has changed the deal, and an
  // id-only comparison would notice only the first half of that.
  const liveOpt = live.selected_option_id
    ? (live.options ?? []).find(o => o.id === live.selected_option_id) ?? null
    : null
  const wasOpt = doc.option ?? null
  cmp('the chosen option', wasOpt ? wasOpt.name : null, liveOpt ? liveOpt.name : null)
  if (wasOpt && liveOpt) cmp(`the ${liveOpt.name} price`, money(wasOpt.price), money(liveOpt.price))

  cmp('the price', money(doc.initial_price), money(live.initial_price))
  cmp('the travel fee', money(doc.travel_fee), money(live.travel_fee))
  cmp('the service', text(doc.service_type), text(live.service_type))
  cmp('the address', text(doc.address), text(live.address))
  cmp('the quote notes', text(doc.notes), text(live.notes))
  cmp('the weekly price', money(doc.plan_prices?.weekly), money(live.weekly_price))
  cmp('the bi-weekly price', money(doc.plan_prices?.biweekly), money(live.biweekly_price))
  cmp('the monthly price', money(doc.plan_prices?.monthly), money(live.monthly_price))
  cmp('the deposit', depositPhrase(doc.deposit_type, doc.deposit_value), depositPhrase(live.deposit_type, live.deposit_value))

  // Extras: only the SELECTED ones were ever part of the deal, so an unticked
  // suggestion appearing or disappearing is not a change to it. Ticking one is.
  const wasAddons = (doc.addons ?? []).map(a => `${a.name} ${money(a.price)}`).sort().join(' · ')
  const nowAddons = (live.addons ?? []).filter(a => a.is_selected).map(a => `${a.name} ${money(a.price)}`).sort().join(' · ')
  cmp('the extras', wasAddons || null, nowAddons || null)

  const line = (s: NonNullable<LiveQuoteFacts['services']>[number] | NonNullable<AcceptedDocument['services']>[number]) =>
    `${s.service_type} ×${Number(s.quantity)} @ ${money(s.unit_price)}`
  const wasLines = (doc.services ?? []).map(line).join(' · ')
  const nowLines = (live.services ?? []).map(line).join(' · ')
  cmp('the work listed', wasLines || null, nowLines || null)

  return out
}

function depositPhrase(type: string | null | undefined, value: number | string | null | undefined): string | null {
  const t = text(type)
  if (!t || t === 'none') return null
  return t === 'percent' ? `${Number(value ?? 0)}%` : `$${money(value) ?? '0.00'}`
}

// ── Saying it out loud ───────────────────────────────────────────────────────

/**
 * ⭐ NEVER CLAIM MORE THAN THE RECORD KNOWS — the same rule lib/audit/phrase
 * follows. Each branch below is a different sentence because each is a different
 * fact, and the one that says "the customer approved this" is reachable only
 * from evidence that they did.
 */
export function acceptanceSentence(status: QuoteStatus | string, s: AcceptanceState | null | undefined): string {
  if (!isAcceptedOrBeyond(status) && !s?.accepted) return 'Not accepted yet.'
  if (!s?.accepted) {
    return 'Marked accepted by hand — no customer acceptance is on record for this quote.'
  }
  // ⛔ A BACKFILLED ROW NAMES NOBODY, because nobody was recorded. It says a deal
  // exists and that the product was not keeping evidence when it was struck —
  // which is a fact about US, not an accusation about the customer, and not a
  // claim that anyone consented in any particular way.
  if (s.kind === 'legacy_unrecorded') {
    const amt = s.accepted_amount == null ? '' : ` at ${formatMoney(s.accepted_amount)}`
    return `Accepted${amt} before EdgeHQ started keeping acceptance records — who accepted it, and when, was never captured.`
  }
  // ⭐ The two sentences differ in their SUBJECT, which is the whole point. One
  // says the customer acted; the other says the business recorded that they did,
  // and where. Neither can be rendered from the other's data.
  const who = s.kind === 'customer'
    ? `${s.actor_label?.trim() || 'The customer'} accepted this in their portal`
    : `${s.actor_label?.trim() || 'Someone at this business'} recorded ` +
      `${s.document?.customer_name?.trim() || 'the customer'}’s acceptance` +
      `${s.on_behalf_reason ? `, taken ${REASON_PHRASE[s.on_behalf_reason]}` : ''}`
  const amount = s.accepted_amount == null ? '' : ` at ${formatMoney(s.accepted_amount)}`
  return `${who}${amount}.`
}

/** Why the quote needs approving again, in the owner's words. */
export function reapprovalSentence(s: AcceptanceState | null | undefined, changes: MaterialChange[]): string {
  if (!s?.accepted) return ''
  if (s.terms_changed && !s.needs_reapproval) {
    return 'Your terms have changed since this was accepted. Send the quote again so the customer accepts the terms they will actually be held to.'
  }
  if (!changes.length) {
    return 'This quote has changed since it was accepted. Send it again so the customer accepts what it says now.'
  }
  const named = changes.slice(0, 3).map(c => c.what).join(', ')
  const more = changes.length > 3 ? ` and ${changes.length - 3} more` : ''
  return `${named}${more} changed since this was accepted. Send it again so the customer accepts what it says now.`
}

function formatMoney(v: number | string): string {
  const n = Number(v)
  return `$${n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// ── The terms tick ───────────────────────────────────────────────────────────
//
// ⛔ THIS IS NOT A SIGNATURE, and nothing here should ever grow into one. It is
// an acknowledgement: a record that a specific block of text was shown and
// agreed to, stored WITH that exact text so editing the tenant's terms later
// cannot rewrite what a past customer appears to have agreed to. Sessions 74/83
// add real signature evidence on top; this is the floor, not the ceiling.

export const TERMS_ACK_LABEL = 'I agree to the quoted scope and terms'

/** Terms are required exactly when the business has any. */
export function termsRequired(termsText: string | null | undefined): boolean {
  return text(termsText) !== null
}

/** Can this quote be accepted right now, and if not, why not. */
export type AcceptBlock = 'option_not_chosen' | 'terms_not_acknowledged'

export function acceptBlockedReason(input: {
  hasOptions: boolean
  chosenOptionId: string | null
  termsText: string | null | undefined
  termsAcknowledged: boolean
}): AcceptBlock | null {
  // The database refuses this too (quote_record_acceptance). Asking here is what
  // lets a button be disabled with a reason instead of failing on submit.
  if (input.hasOptions && !input.chosenOptionId) return 'option_not_chosen'
  if (termsRequired(input.termsText) && !input.termsAcknowledged) return 'terms_not_acknowledged'
  return null
}

export function acceptBlockedLabel(r: AcceptBlock): string {
  return r === 'option_not_chosen'
    ? 'Choose which option you’d like before accepting.'
    : 'Please tick to confirm you agree to the quoted scope and terms.'
}
