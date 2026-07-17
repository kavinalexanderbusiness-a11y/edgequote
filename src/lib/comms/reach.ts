// ── Can we reach this customer? (pure) ───────────────────────────────────────
// THE one answer to "will this message actually go out, and if not why not".
// Extracted from dispatchToCustomer so the send path and anything that wants to
// PREDICT a send (the campaign audience preview) share one definition instead of
// re-deriving consent rules. Consent has already been hand-rolled in four places
// in this codebase; this exists so a fifth copy never gets written.
//
// Pure: no I/O, no Supabase, safe on the client. It decides nothing on its own —
// dispatch still owns the sending; this owns the *reason*.

import { SKIP_REASON, type SkipReason } from './skipReasons'
import { prefAllows, type MessagePrefs } from './templates'

export interface ReachCustomer {
  phone: string | null
  email: string | null
  sms_opt_in: boolean
  email_opt_in: boolean
  message_prefs?: MessagePrefs | null
}

/** One channel's verdict. `blocked === null` means the message would go out. */
export interface ChannelReach {
  channel: string
  blocked: SkipReason | null
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
      return { channel, blocked: null }
    }
    if (channel === 'email') {
      if (!c.email_opt_in && !opts?.transactional) return { channel, blocked: SKIP_REASON.NO_OPT_IN }
      if (!c.email) return { channel, blocked: SKIP_REASON.NO_EMAIL }
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
 * same reason that reason is reported; a mixture reports the first, which is the
 * one the owner can act on first.
 */
export function blockedReason(c: ReachCustomer, channels: string[], template: string, opts?: ReachOptions): SkipReason | null {
  const gate = reachCheck(c, channels, template, opts)
  if (!gate.length || gate.some(r => !r.blocked)) return null
  return gate[0].blocked
}
