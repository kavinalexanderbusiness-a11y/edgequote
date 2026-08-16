// ── Which field writes may survive a dead zone, and which may not ────────────
// ⭐⭐ NOT EVERY ACTION SHOULD QUEUE. A queue is a promise that the work will
// happen later, and there are writes for which that promise cannot honestly be
// made. Deciding this per call site is how a codebase ends up queueing a
// password change; so the decision lives here, once, as DATA, and a guard reads
// this table rather than trusting a comment.
//
// The test a write has to pass to be queueable, all four:
//
//  1. It is a FACT ABOUT FIELD WORK the worker observed — not a permission, not
//     money moving, not an identity.
//  2. Replaying it later is still TRUE. "I mowed this lawn at 9:05" stays true
//     at 4pm; "let me in" does not.
//  3. It is IDEMPOTENT under retry, by a key the client minted before the first
//     attempt (lib/field/visitIntent, crew_messages.client_token, a photo's
//     content hash) — never by hope.
//  4. Its failure is RECOVERABLE by the person who made it. They are standing at
//     the property; they can redo it.
//
// Everything else requires a connection and says so out loud. ⛔ A write that
// needs a connection must FAIL VISIBLY — never queue, never claim success.

export type FieldWriteKind =
  // ── Queueable: facts about work, observed on site ──
  | 'visit.start'
  | 'visit.stop_for_day'
  | 'visit.complete'
  | 'visit.revert'
  | 'visit.record'          // completion summary / internal issue — proof of work
  | 'crew.message'          // a message to the office about this visit
  | 'crew.photo'            // proof-of-work photo (bytes live in the photo store)
  // ── Connection required ──
  | 'auth.signin'
  | 'auth.password'
  | 'crew.join'             // redeeming an invite code = becoming someone
  | 'media.signed_url'      // minting a credential; a stale one is useless anyway

export type WriteClass = 'queueable' | 'online-only'

/**
 * ⭐ THE TABLE. One row per field write in the app.
 *
 * Notes on the two judgement calls a reader will want to challenge:
 *
 * • `visit.complete` IS queueable, even though completing drafts an invoice and
 *   can fire an AutoPay charge. The COMPLETION is a fact about work — the
 *   billing is a server-side CONSEQUENCE of it, and it already runs behind its
 *   own idempotency (the draft de-dupes on job_id with a partial unique index as
 *   the atomic backstop; the owner notification de-dupes on (type, job)). The
 *   alternative — refusing to let a worker finish a visit without bars — strands
 *   the single most important action in the product at exactly the moment it is
 *   needed, and the owner-side outbox already queues this same completion
 *   (lib/offline/handlers P6). What defers is the invoice's TIMING, which the
 *   office already tolerates; what is never duplicated is the completion itself.
 *   ⛔ This is NOT a licence to queue money: no crew surface takes a payment,
 *   sets a price, or touches an invoice, and none may be added to this list.
 *
 * • `media.signed_url` is online-only despite being harmless to retry, because
 *   queueing it is MEANINGLESS: a signed URL is a short-lived credential (300s),
 *   so one minted on reconnect has already expired against the moment the worker
 *   wanted it. Queueing would be theatre — the request would "succeed" and the
 *   photo still would not open.
 */
const WRITE_CLASS: Record<FieldWriteKind, WriteClass> = {
  'visit.start': 'queueable',
  'visit.stop_for_day': 'queueable',
  'visit.complete': 'queueable',
  'visit.revert': 'queueable',
  'visit.record': 'queueable',
  'crew.message': 'queueable',
  'crew.photo': 'queueable',

  'auth.signin': 'online-only',
  'auth.password': 'online-only',
  'crew.join': 'online-only',
  'media.signed_url': 'online-only',
}

export function writeClass(kind: FieldWriteKind): WriteClass {
  return WRITE_CLASS[kind]
}

export function isQueueable(kind: FieldWriteKind): boolean {
  return WRITE_CLASS[kind] === 'queueable'
}

/** Every kind, for the guard — so a new write added to the union without a
 *  classification fails the build, and one added to the table without a guard
 *  entry fails `verify:field-reliability`. */
export const FIELD_WRITE_KINDS = Object.keys(WRITE_CLASS) as FieldWriteKind[]

/** What a worker is told when an online-only write meets a dead zone. It names
 *  the reason and what to do — "Load failed" is the string this replaces. */
export function onlineOnlyMessage(kind: FieldWriteKind): string {
  switch (kind) {
    case 'auth.signin':
    case 'auth.password':
      return 'Signing in needs a connection. Move somewhere with signal and try again.'
    case 'crew.join':
      return 'Joining a crew needs a connection. Try again once you have signal.'
    case 'media.signed_url':
      return 'That file needs a connection to open. It’ll load once you have signal.'
    default:
      return 'That needs a connection. Try again once you have signal.'
  }
}
