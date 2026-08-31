// ── Service publication — ACTIVE is not PUBLISHED ────────────────────────────
// THE one definition of "may a customer see this service?".
//
// ⭐⭐ THE MEASURED DEFECT THIS EXISTS TO FIX. Before this module there was one
// switch, `service_templates.is_active`, and BOTH customer-facing projections
// gated on it and nothing else:
//
//   public_services(p_token)  → /api/public/services → the marketing website,
//                               anonymous, CORS *, edge-cached for five minutes
//   get_portal_data(...)      → the portal's "Request a service" tab
//
// So "active" silently meant "published to the public internet". Every service
// an owner switched on to use INTERNALLY — a placeholder while pricing was being
// worked out, a $1 row from a test, an internal-only call-out line — was on the
// website the moment it was created. That is exactly what the production audit
// found, and no amount of naming discipline fixes it, because the system never
// asked the question.
//
// ── THE MODEL: three states, ONE new column ─────────────────────────────────
// `service_templates.published_at timestamptz null`
//
//   INACTIVE   is_active = false                     Not available at all.
//   INTERNAL   is_active = true,  published_at NULL  The owner may use it on a
//                                                    quote; no customer sees it.
//   PUBLISHED  is_active = true,  published_at set   Explicitly customer-visible.
//
// ⭐ Three states out of two columns, so there is no new enum to keep in sync
// with `is_active` and no way to express a contradiction. The timestamp is not
// decoration: "when did this become public?" is the question anyone auditing a
// price the customer saw will ask.
//
// ⛔⛔ THE DEFAULT IS CLOSED, AND THAT IS THE WHOLE POINT. `published_at`
// defaults to NULL and the migration DOES NOT backfill. Publication has to be an
// act. The cost is real and is stated plainly in the migration header: on the
// day it applies, the public catalogue is EMPTY until the owner publishes. The
// alternative — backfilling every active service as published — would reproduce
// the exact bug this replaces, on the exact rows that caused it.
//
// ⛔ The DATABASE is the gate, not this module. Both projections filter on
// `published_at is not null`. Everything here is the app's copy of that rule, so
// a screen can say the honest sentence instead of showing a service that quietly
// is not there.

export type PublicationState = 'inactive' | 'internal' | 'published'

export interface PublishableLike {
  is_active?: boolean | null
  published_at?: string | null
}

/**
 * ⭐ THE predicate every surface asks, the same way.
 *
 * Note the ORDER: inactive wins over published. A service that was published and
 * then switched off is INACTIVE, not published — `is_active` is the master
 * switch and `published_at` only ever describes an active row. Reading them the
 * other way round would leave a switched-off service on the website.
 */
export function publicationState(row: PublishableLike | null | undefined): PublicationState {
  if (!row) return 'inactive'
  if (row.is_active === false) return 'inactive'
  return row.published_at ? 'published' : 'internal'
}

/** May a CUSTOMER see this? The single question the two projections answer, and
 *  the one this app must never answer differently from them. */
export function isCustomerVisible(row: PublishableLike | null | undefined): boolean {
  return publicationState(row) === 'published'
}

/** May the OWNER use it on a quote? Published and internal both qualify — the
 *  distinction is about the customer, never about the owner's own tools. */
export function isOwnerUsable(row: PublishableLike | null | undefined): boolean {
  return publicationState(row) !== 'inactive'
}

/** What the owner reads on the row. Kept beside the rule so a new state cannot
 *  be added without a word for it. */
export const PUBLICATION_LABEL: Record<PublicationState, string> = {
  inactive: 'Inactive',
  internal: 'Internal',
  published: 'Published',
}

/** One sentence saying what the state MEANS, because "Internal" alone reads as a
 *  category rather than as an answer to "can my customers book this?". */
export const PUBLICATION_MEANING: Record<PublicationState, string> = {
  inactive: 'Switched off. Not available to you or to customers.',
  internal: 'Yours to quote with. Customers cannot see it on your website or in their portal.',
  published: 'Live for customers on your website and in their portal.',
}

/** Tone token per state, so every surface colours them identically. */
export const PUBLICATION_TONE: Record<PublicationState, 'muted' | 'neutral' | 'accent'> = {
  inactive: 'muted',
  internal: 'neutral',
  published: 'accent',
}

/**
 * Why this service cannot be published yet, or null when it can.
 *
 * ⭐ Composed from lib/fixtureData's suspicions rather than re-deriving them —
 * the catalogue-quality rules and the publish gate must be the same rules, or a
 * row can be blocked by a warning nobody showed, or published despite one.
 * ⛔ ADVISORY. The database is what actually refuses; this is what lets the
 * owner read the reason before they tap.
 */
export function publishBlockedReason(
  suspicions: readonly { message: string; blocksPublication: boolean }[],
): string | null {
  const blocking = suspicions.filter(s => s.blocksPublication)
  return blocking.length ? blocking[0].message : null
}

/** The patch that publishes / unpublishes. ⭐ ONE shape, so no call site invents
 *  its own — and `is_active` is deliberately NOT touched: publishing an inactive
 *  service would switch it on as a side effect nobody asked for. */
export function publishPatch(next: boolean): { published_at: string | null } {
  return { published_at: next ? new Date().toISOString() : null }
}

/**
 * The columns every customer-facing reader must select for `publicationState`
 * to be answerable. ⚠️ A reader that omits `published_at` gets `undefined`,
 * which reads as INTERNAL — safe, but silently empty. Named here so the guard
 * can assert the customer-facing selects carry it.
 */
export const PUBLICATION_COLUMNS = 'is_active, published_at' as const
