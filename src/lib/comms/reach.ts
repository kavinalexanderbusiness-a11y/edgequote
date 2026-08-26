// ── Can we reach this customer? (pure) ───────────────────────────────────────
// THE one answer to "will this message actually go out, and if not why not".
// Extracted from dispatchToCustomer so the send path and anything that wants to
// PREDICT a send (the campaign audience preview) share one definition instead of
// re-deriving consent rules. Consent has already been hand-rolled in four places
// in this codebase; this exists so a fifth copy never gets written.
//
// Pure: no I/O, no Supabase, safe on the client. It decides nothing on its own —
// dispatch still owns the sending; this owns the *reason*.

import { SKIP_REASON, type SkipReason, describeSkip } from './skipReasons'
import { prefAllows, type MessagePrefs } from './templates'

/** How a customer would rather be contacted (customers.preferred_channel).
 *  `null`/absent = no preference recorded, which is most of the book.
 *
 *  'phone' is a human phone call. It is NOT a channel this pipeline can send on
 *  — it is an instruction to the OWNER, and it is modelled here rather than
 *  omitted so that "they asked to be phoned" is a first-class answer instead of
 *  a note somebody has to read. */
export type PreferredChannel = 'sms' | 'email' | 'phone'

/** The channels the send pipeline can actually put a message on, in the order it
 *  falls back to when the customer expressed no preference. */
export const SENDABLE_CHANNELS: readonly string[] = ['sms', 'email']

export function isSendableChannel(ch: string | null | undefined): boolean {
  return !!ch && SENDABLE_CHANNELS.includes(ch)
}

export interface ReachCustomer {
  phone: string | null
  email: string | null
  sms_opt_in: boolean
  email_opt_in: boolean
  message_prefs?: MessagePrefs | null
  /** PREFERENCE, never consent — see resolveReach. Optional so every existing
   *  caller keeps working and a customer without one behaves exactly as before. */
  preferred_channel?: PreferredChannel | null
}

/** One channel's verdict. `blocked === null` means the message would go out. */
export interface ChannelReach {
  channel: string
  blocked: SkipReason | null
}

/** The subset of lib/capabilities' TenantCapabilities this file needs. Structural
 *  so reach.ts stays pure and importable on the client — a TenantCapabilities
 *  satisfies it without reach.ts depending on the module that reads the table. */
export interface ReachCapabilities {
  outboundSms: boolean
  outboundEmail: boolean
}

/**
 * THE capability rule: has the platform granted THIS tenant the shared sender
 * for this channel? One definition, used by the pure predicate below AND by
 * dispatchToCustomer, so a surface that PREDICTS a send and the send itself can
 * never disagree about whether a channel exists for this business.
 *
 * `caps` absent/null means the caller does not know — this predicate then leaves
 * the channel alone rather than inventing an answer. That is safe because the
 * capability gate is not OPTIONAL at send time: dispatchToCustomer always reads
 * it authoritatively from platform_capabilities before anything goes out, and a
 * failed read there resolves to NO_CAPABILITIES. So "unknown here" can only ever
 * make a PREDICTION more optimistic than the send — never a send more permissive
 * than the grant. scripts/verify-comm-prefs.ts pins that the send path passes it.
 */
export function capabilityBlocks(channel: string, caps: ReachCapabilities | null | undefined): boolean {
  if (!caps) return false
  if (channel === 'sms') return !caps.outboundSms
  if (channel === 'email') return !caps.outboundEmail
  return false
}

export interface ReachOptions {
  /**
   * This message is a receipt/confirmation for something the customer just did
   * with us. CASL s.6(6)(b) exempts that from *consent*, so EMAIL does not
   * require `email_opt_in` — the customer paid; they get the receipt.
   *
   * Deliberately narrow, and stated here rather than by omission in a copy:
   *  • SMS still requires sms_opt_in. No exemption covers texting someone who
   *    said don't text me.
   *  • The category preference still applies to BOTH channels. Someone who
   *    turned off "Invoices & receipts" asked for exactly this and gets it.
   */
  transactional?: boolean
  /**
   * What the platform has granted this tenant (lib/capabilities). When supplied,
   * a channel the tenant may not use is blocked with NOT_ENABLED — the same
   * verdict, in the same order, that dispatchToCustomer reaches. Omit only when
   * the caller genuinely cannot know; see capabilityBlocks.
   */
  caps?: ReachCapabilities | null
}

// Per-channel gate, in the same order the caller asked for the channels.
// Mirrors dispatchToCustomer exactly:
//   category preference → channel opt-in → contact on file.
// A channel this pipeline doesn't send (e.g. push) is reported unblocked here;
// dispatch simply never attempts it, so it can't produce a false "will send".
export function reachCheck(
  c: ReachCustomer, channels: string[], template: string, opts?: ReachOptions,
): ChannelReach[] {
  // The customer declined this whole CATEGORY of message (e.g. opted into
  // invoices but out of marketing) — nothing goes out on any channel. Applies to
  // transactional sends too: "don't send me receipts" is a real answer.
  if (!prefAllows(c.message_prefs, template)) {
    return channels.map(channel => ({ channel, blocked: SKIP_REASON.UNSUBSCRIBED }))
  }
  return channels.map(channel => {
    if (channel === 'sms') {
      if (!c.sms_opt_in) return { channel, blocked: SKIP_REASON.NO_OPT_IN }
      if (!c.phone) return { channel, blocked: SKIP_REASON.NO_PHONE }
      // Capability LAST, so the reason reported stays the CONSENT reason when
      // both apply — byte-for-byte the order dispatchToCustomer uses, where the
      // capability pass only touches channels consent left unblocked. "They
      // opted out" is the truth the owner can act on; "this business has no SMS
      // grant" would send them looking for the wrong problem.
      if (capabilityBlocks(channel, opts?.caps)) return { channel, blocked: SKIP_REASON.NOT_ENABLED }
      return { channel, blocked: null }
    }
    if (channel === 'email') {
      if (!c.email_opt_in && !opts?.transactional) return { channel, blocked: SKIP_REASON.NO_OPT_IN }
      if (!c.email) return { channel, blocked: SKIP_REASON.NO_EMAIL }
      if (capabilityBlocks(channel, opts?.caps)) return { channel, blocked: SKIP_REASON.NOT_ENABLED }
      return { channel, blocked: null }
    }
    return { channel, blocked: null }
  })
}

/**
 * Would this customer receive the message on at least one requested channel?
 * A campaign counts as reaching someone if ANY channel gets through — the same
 * rule dispatch applies when it decides whether anything was sent.
 */
export function isReachable(c: ReachCustomer, channels: string[], template: string, opts?: ReachOptions): boolean {
  return reachCheck(c, channels, template, opts).some(r => !r.blocked)
}

/**
 * Why a customer can't be reached on ANY channel, for an audience preview.
 * Returns null when they are reachable. When every channel is blocked for the
 * same reason that reason is reported; a mixture reports the first.
 *
 * "The first" is now the first in the customer's PREFERRED order, so someone who
 * asked for email and cannot get it is told why EMAIL failed rather than why SMS
 * did. This changes no verdict — reachability is `some(unblocked)`, which no
 * ordering can affect — only which of several true reasons is the one shown, and
 * the preferred channel is the one the owner would want to fix. Customers with
 * no preference (the whole book until one is recorded) are unaffected.
 */
export function blockedReason(c: ReachCustomer, channels: string[], template: string, opts?: ReachOptions): SkipReason | null {
  const gate = reachCheck(c, orderByPreference(channels, c.preferred_channel), template, opts)
  if (!gate.length || gate.some(r => !r.blocked)) return null
  return gate[0].blocked
}

// ── Preference ───────────────────────────────────────────────────────────────
// Everything above answers WHETHER a channel may be used. Everything below
// answers WHICH of the allowed ones the customer would rather have, and it is
// kept in this file precisely so the two can never drift into separate engines.
//
// THE INVARIANT, stated once and pinned by scripts/verify-comm-prefs.ts:
//   preference ORDERS the allowed channels. It never adds one, never removes
//   one, and never changes a `blocked` verdict.
// A preference that could suppress a channel would be a second consent engine
// wearing a friendlier name, and a preference that could enable one would
// fabricate consent the customer never gave. It does neither: `blocked` is
// computed entirely by reachCheck above, and the functions below only re-order
// the array and describe the result.

/**
 * The template to ask about when the question is "can we reach this person AT
 * ALL" rather than "may we send THIS message" — the owner's question on the
 * customer record. Deliberately not a real template, so prefAllows passes and
 * only channel-level truth (consent · contact · capability) answers. A real
 * send ALWAYS passes its own template, which is what applies the category
 * preference on top.
 */
export const ANY_MESSAGE = '__any_message__'

/**
 * Sort `channels` so the customer's preferred one comes first. PURE ORDERING —
 * the returned array is a permutation of the input: same members, same length.
 *
 * A preference for 'phone' changes nothing here, because a phone call is not
 * something this pipeline sends; the natural order stands and the owner is told
 * to call (see PreferenceState 'manual').
 */
export function orderByPreference(channels: string[], preferred: PreferredChannel | null | undefined): string[] {
  if (!preferred || !isSendableChannel(preferred)) return [...channels]
  const first = channels.filter(ch => ch === preferred)
  return first.length ? [...first, ...channels.filter(ch => ch !== preferred)] : [...channels]
}

/**
 * What happened to the customer's stated preference:
 *   'none'      — no preference recorded (most of the book; everything still works)
 *   'honoured'  — the channel a message would go out on IS the preferred one
 *   'overruled' — a preference exists, but consent/contact/capability stopped it
 *                 and another allowed channel is being used instead
 *   'manual'    — they prefer a phone CALL, which the owner places and this
 *                 pipeline never does. Messages still follow consent as normal.
 * 'overruled' is a distinct state from 'none' on purpose: it is the one case
 * where the product is knowingly doing something other than what was asked, and
 * it must be able to say so rather than quietly look identical to no preference.
 */
export type PreferenceState = 'none' | 'honoured' | 'overruled' | 'manual'

export interface ReachVerdict {
  /** Per-channel verdicts, in PREFERENCE order. Same members as `channels` in. */
  channels: ChannelReach[]
  /** The channel a send would actually use: the first ALLOWED one in preference
   *  order. `null` when nothing can go out. */
  best: string | null
  /** What the customer asked for; null when nothing was recorded. */
  preferred: PreferredChannel | null
  state: PreferenceState
  /** Why the PREFERRED channel isn't the one being used. Non-null only in the
   *  'overruled' state — this is the sentence that keeps a refusal honest. */
  preferredBlockedBy: SkipReason | null
  /** Why NOTHING can go out; null whenever `best` is non-null. */
  blocked: SkipReason | null
}

/**
 * THE canonical reach + preference answer. Every engine that decides, predicts
 * or explains a customer contact consumes this one function, so "will it send,
 * on what, and is that what they wanted" has exactly one implementation.
 *
 * Order of authority, highest first — none of it is overridable by preference:
 *   1. category preference (message_prefs)   — they declined this KIND of message
 *   2. channel consent (sms/email_opt_in)    — STOP lands here; it always wins
 *   3. contact on file                       — nothing to send to
 *   4. tenant capability (platform grant)    — this business may not use it
 *   5. preference                            — orders whatever survived 1–4
 */
export function resolveReach(
  c: ReachCustomer,
  opts?: ReachOptions & { channels?: string[]; template?: string },
): ReachVerdict {
  const requested = opts?.channels ?? [...SENDABLE_CHANNELS]
  const preferred = c.preferred_channel ?? null
  const ordered = orderByPreference(requested, preferred)
  const gate = reachCheck(c, ordered, opts?.template ?? ANY_MESSAGE, opts)

  const best = gate.find(g => !g.blocked)?.channel ?? null
  // `blocked` reports the FIRST reason in PREFERENCE order — so a customer who
  // asked for email and can't get it is told about email, not about SMS.
  const blocked = best ? null : (gate[0]?.blocked ?? SKIP_REASON.NO_CONTACT)

  let state: PreferenceState = 'none'
  let preferredBlockedBy: SkipReason | null = null
  if (preferred === 'phone') {
    state = 'manual'
  } else if (preferred) {
    const own = gate.find(g => g.channel === preferred)
    if (!own) {
      // The caller never offered the preferred channel for this message (e.g. a
      // reply that is SMS-only). Not a refusal of the customer's wish, and not
      // something to report as one.
      state = 'none'
    } else if (!own.blocked && best === preferred) {
      state = 'honoured'
    } else {
      state = 'overruled'
      preferredBlockedBy = own.blocked
    }
  }

  return { channels: gate, best, preferred, state, preferredBlockedBy, blocked }
}

/** How a channel is named to the owner. */
export const CHANNEL_LABEL: Record<string, string> = { sms: 'text', email: 'email', phone: 'phone call' }
export function channelLabel(ch: string | null | undefined): string {
  return (ch && CHANNEL_LABEL[ch]) || ch || 'nothing'
}

/**
 * The ONE owner-facing sentence for a verdict, composed from describeSkip so a
 * refusal reads in the same words the timeline and the campaign preview already
 * use. Returned by the primitive rather than written at each surface, because
 * this exact sentence is the product: it is what stops "preferred = SMS" from
 * being read as permission to text someone who said stop.
 */
export function reachSummary(v: ReachVerdict): string {
  if (!v.best) {
    const why = describeSkip(v.blocked).label
    return v.state === 'manual'
      ? `Prefers a phone call — and no message channel is available (${why}).`
      : `No way to reach this customer — ${why}.`
  }
  const on = channelLabel(v.best)
  switch (v.state) {
    case 'manual':
      return `Prefers a phone call — give them a ring. Messages still go by ${on}.`
    case 'honoured':
      return `Prefers ${on} — that's what messages use.`
    case 'overruled':
      return `Prefers ${channelLabel(v.preferred)}, but ${describeSkip(v.preferredBlockedBy).label} — messages go by ${on} instead.`
    default:
      return `No preference recorded — messages go by ${on}.`
  }
}
