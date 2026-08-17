// ── What can the owner do with this day-board record? (pure) ─────────────────
//
// One module answering, for a record on the day view, WHICH customer-facing
// doors are open — the same doors/ladder shape as lib/payments/invoiceActions,
// and for the same reason: these rules used to live inline in the card markup,
// where each button restated its own copy of "does this action make sense
// here" and nothing kept the copies agreeing.
//
// WHY THE `kind` FIELD EXISTS BEFORE A SECOND KIND RENDERS ANYWHERE
// The day board renders visits (`jobs` rows) today. An ESTIMATE APPOINTMENT —
// a scheduled sales visit whose only purpose is producing a quote — is a
// planned record kind that must NEVER carry the Complete door: completing a
// visit drafts an invoice and can text the customer that their work is done,
// and an estimate is not work. That boundary is cheapest to state while there
// is exactly one kind, so whoever renders the second kind inherits a closed
// door instead of a decision. (schedule_items already models estimates in the
// DB; nothing renders it yet.)
//
// NO CONSENT IS DECIDED HERE. Whether a message actually goes out belongs to
// lib/comms/reach + the send route's capability/governor gates. These doors
// only say whether the AFFORDANCE makes sense for the record — a customer who
// texted STOP still gets a Message button, and the composer tells the truth
// about why nothing will send. Hiding the button would misreport a consent
// fact as a UI absence.

import type { JobStatus } from '@/types'
import { reviewStatus, type ReviewFields } from '@/lib/crm/reviews'
import { reachCheck, type ReachCustomer } from '@/lib/comms/reach'
import { describeSkip } from '@/lib/comms/skipReasons'

export type DayRecordKind = 'visit' | 'estimate'

/** The customer facts a day-board record carries (the schedule query's join). */
export interface DayActionCustomer extends ReviewFields {
  id: string
  phone?: string | null
  email?: string | null
  sms_opt_in?: boolean
  email_opt_in?: boolean
  message_prefs?: ReachCustomer['message_prefs']
}

export interface DayActionRecord {
  kind: DayRecordKind
  status: JobStatus
  customer: DayActionCustomer | null
}

/**
 * The review-ask ladder for this record, most-final state first. One state at a
 * time so the card can render exactly one affordance (button, chip or nothing)
 * without re-deriving precedence.
 */
export type ReviewAskState =
  | 'ready'             // completed visit, nobody has asked, a link exists
  | 'no-url'            // completed + unasked, but there is no review link to send
  | 'already-requested' // somebody (owner, cron or campaign) already asked
  | 'reviewed'          // they left a review — asking again is noise
  | 'declined'          // they said no — a re-ask overrides an explicit answer
  | 'not-done'          // the work isn't finished; there is nothing to review yet
  | 'no-customer'       // nobody to ask

export interface ReviewAsk {
  state: ReviewAskState
  /** When the ask happened, for 'already-requested' — so the owner sees WHEN, not just "no". */
  requestedAt: string | null
}

export interface DayDoors {
  /**
   * ⭐ THE completion boundary. Only a VISIT that isn't finished or cancelled
   * can be completed. An estimate appointment NEVER can — "the estimating
   * appointment occurred" must not become "the customer's job is complete",
   * with the invoice draft and completion text that transition carries.
   */
  canComplete: boolean
  /** One-tap arrival promise: a visit still ahead of us, with someone to tell. */
  canOnMyWay: boolean
  /** The customer messaging panel — needs a customer, nothing else. */
  canMessage: boolean
  /** tel: link — a phone number on file is the whole requirement. */
  canCall: boolean
  /** The customer profile door. */
  canOpenCustomer: boolean
  review: ReviewAsk
}

export function reviewAsk(r: DayActionRecord, reviewUrl: string | null | undefined): ReviewAsk {
  const none = { requestedAt: null }
  if (!r.customer) return { state: 'no-customer', ...none }
  // Ask AFTER the work, from this surface: the day board's ask rides the visit
  // that just finished. The anytime door stays on the customer profile
  // (ReviewLifecycle), which owns re-asks and recorded outcomes.
  if (r.kind !== 'visit' || r.status !== 'completed') return { state: 'not-done', ...none }
  const status = reviewStatus(r.customer)
  if (status === 'reviewed') return { state: 'reviewed', ...none }
  if (status === 'declined') return { state: 'declined', ...none }
  if (status === 'requested') return { state: 'already-requested', requestedAt: r.customer.review_requested_at ?? null }
  if (!reviewUrl?.trim()) return { state: 'no-url', ...none }
  return { state: 'ready', ...none }
}

export function dayDoors(r: DayActionRecord, reviewUrl: string | null | undefined): DayDoors {
  const active = r.status === 'scheduled' || r.status === 'in_progress'
  return {
    canComplete: r.kind === 'visit' && active,
    canOnMyWay: r.kind === 'visit' && r.status === 'scheduled' && !!r.customer,
    canMessage: !!r.customer,
    canCall: !!r.customer?.phone?.trim(),
    canOpenCustomer: !!r.customer,
    review: reviewAsk(r, reviewUrl),
  }
}

// ── What will completing this visit SAY to the customer? ─────────────────────
//
// Completing a visit is two separate things that one button used to do
// silently together: the STATE CHANGE (status/completed_at/invoice draft) and
// the CUSTOMER MESSAGE (the job_complete text). This plan makes the second
// half visible BEFORE it happens, so the completion dialog can show the exact
// message — or say honestly that nothing will go out, and why.
//
// The prediction mirrors the send route's real gates in their real order
// (consent via THE reach predicate, then the tenant capability grant). It
// deliberately does NOT consult the governor: job_complete is a service
// message the governor never blocks (only the runaway daily cap can, and
// predicting that here would mean a second copy of the governor's reads).

export interface CompletionCaps {
  outboundSms: boolean
  outboundEmail: boolean
}

export interface CompletionMessagePlan {
  /** The owner's automation is on and there is a customer to message. */
  configured: boolean
  /** Channels the message would actually attempt, after consent + capability. */
  channels: ('sms' | 'email')[]
  /** configured && at least one channel gets through → show the dialog. */
  wouldSend: boolean
  /**
   * Consent facts were absent from the record (a stale cached row from before
   * the columns joined the query). Unknown ≠ opted-out: the route decides
   * authoritatively, so the dialog still shows, saying "attempt" not "will".
   */
  contactKnown: boolean
  /** The first honest reason when configured but nothing can send, owner-worded. */
  reason: string | null
}

export function completionMessagePlan(
  r: DayActionRecord,
  opts: {
    automationOn: boolean
    /** null = this caller couldn't read the grants — predict the attempt and let dispatch decide. */
    caps: CompletionCaps | null
  },
): CompletionMessagePlan {
  const c = r.customer
  const configured = opts.automationOn && !!c
  if (!configured || !c) {
    return { configured: false, channels: [], wouldSend: false, contactKnown: true, reason: null }
  }
  const contactKnown = c.sms_opt_in !== undefined || c.email_opt_in !== undefined
  if (!contactKnown) {
    // Old cached row: no consent columns to test. Fail toward showing the
    // dialog — the route still enforces everything; the copy hedges.
    return { configured, channels: [], wouldSend: true, contactKnown: false, reason: null }
  }
  const gate = reachCheck(
    { phone: c.phone ?? null, email: c.email ?? null, sms_opt_in: !!c.sms_opt_in, email_opt_in: !!c.email_opt_in, message_prefs: c.message_prefs },
    ['sms', 'email'],
    'job_complete',
  )
  const capBlocked = (ch: string) =>
    !!opts.caps && ((ch === 'sms' && !opts.caps.outboundSms) || (ch === 'email' && !opts.caps.outboundEmail))
  const channels = gate.filter(g => !g.blocked && !capBlocked(g.channel)).map(g => g.channel as 'sms' | 'email')
  const firstBlocked = gate.find(g => g.blocked)?.blocked ?? null
  return {
    configured,
    channels,
    wouldSend: channels.length > 0,
    contactKnown,
    // Consent reasons outrank capability ones — "they opted out" is the reason
    // an owner can act on (same reporting order the comms stack uses).
    reason: channels.length ? null : firstBlocked ? describeSkip(firstBlocked).label : 'messaging is not enabled for this business',
  }
}
