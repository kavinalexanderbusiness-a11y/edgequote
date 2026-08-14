// ── THE customer-request engine ──────────────────────────────────────────────
// One home for everything the app knows about a request a customer made from
// their portal: what the kinds are, what a request MEANS, what the owner's next
// move is, and the media contract both sides of the wire obey.
//
// ⭐ THE LAW: A REQUEST IS AN ASK, NOT AN OUTCOME.
// A request is not a job, not a schedule change, not an approved change order,
// and not a price anyone has agreed to. Every action below is a LINK to a
// creation door the owner already uses — this module can neither create nor
// price anything, and deliberately carries no money from the ask to the door.
// That is not a convention: it is pure, has no Supabase client, and returns
// only strings and data, so it *cannot* write.
//
// Pure and framework-free (no React, no IO), which is what lets
// verify:portal-requests drive the exact production logic.

// ── Kinds ────────────────────────────────────────────────────────────────────
// The five values service_requests.kind is constrained to. Four are portal asks;
// 'plan_change' covers skip/pause/cancel on a recurring plan.
export const REQUEST_KINDS = ['service', 'additional_work', 'reschedule', 'appointment', 'plan_change'] as const
export type RequestKind = (typeof REQUEST_KINDS)[number]

export function isRequestKind(k: unknown): k is RequestKind {
  return typeof k === 'string' && (REQUEST_KINDS as readonly string[]).includes(k)
}

// What the OWNER sees this request called. Short, verb-free noun phrases — the
// verb belongs to the action button, not the label.
const KIND_LABEL: Record<RequestKind, string> = {
  service: 'Quote request',
  additional_work: 'Extra work',
  reschedule: 'Schedule change',
  appointment: 'Appointment request',
  plan_change: 'Plan change',
}

// What the CUSTOMER picked, in their own words. Kept separate from the owner
// label on purpose: "Extra work" is how a business files it, "Some extra work"
// is how a homeowner asks for it, and one string cannot be both without reading
// oddly on one of the two screens.
const KIND_CUSTOMER_LABEL: Record<RequestKind, string> = {
  service: 'A new quote',
  additional_work: 'Some extra work',
  reschedule: 'Change a visit',
  appointment: 'A visit on a date',
  plan_change: 'Change my plan',
}

export function requestKindLabel(kind: string): string {
  return isRequestKind(kind) ? KIND_LABEL[kind] : 'Request'
}
export function requestKindCustomerLabel(kind: string): string {
  return isRequestKind(kind) ? KIND_CUSTOMER_LABEL[kind] : 'Something else'
}

// ── Media contract ───────────────────────────────────────────────────────────
// Customer request photos ride the SAME public bucket the booking door and the
// website-lead intake already use (lib/intake.ts, book/[token]) — one anon-upload
// path for customer-supplied photos, not a second one. They are NOT job_photos:
// that table's rows are the business's own proof-of-work and are rendered to the
// customer as evidence, which a photo the customer sent is not.
export const REQUEST_PHOTO_BUCKET = 'booking-uploads'
export const MAX_REQUEST_PHOTOS = 6

// ⭐ The stored value is a PATH, never a URL — the bucket is named in code at
// render time, so a stored value can never address another bucket, another
// tenant's object, or an external host the owner's browser would then fetch.
// The shape carries no customer-supplied text at all (two UUIDs and an
// extension): there is nothing to traverse with and nothing to inject.
//
// This mirrors the database's own CHECK (portal_request_photos_ok). Two copies
// of one rule is normally the bug this codebase hates — here the DB copy is the
// ENFORCEMENT and this one is a render-time refusal to display anything the
// enforcement would not have accepted, so a row written before the constraint
// existed still cannot paint. The verify guard pins them to the same shape.
const PHOTO_PATH = /^portal\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif)$/

export function isRequestPhotoPath(p: unknown): p is string {
  return typeof p === 'string' && PHOTO_PATH.test(p)
}

/** The photos of a request that are safe to render, capped. Anything else is dropped. */
export function requestPhotoPaths(photos: unknown): string[] {
  if (!Array.isArray(photos)) return []
  return photos.filter(isRequestPhotoPath).slice(0, MAX_REQUEST_PHOTOS)
}

/**
 * The path a freshly picked file is uploaded to. `batch` groups one submission's
 * photos; `file` identifies the file. Both are caller-supplied UUIDs — the
 * FILENAME the customer chose is deliberately discarded, so a hostile name has
 * nowhere to land, and the portal token never appears in a public bucket URL.
 */
export function requestPhotoPath(batch: string, file: string, ext: string): string | null {
  const e = ext.toLowerCase().replace(/^\./, '')
  const path = `portal/${batch}/${file}.${e === 'jpeg' ? 'jpeg' : e}`
  return isRequestPhotoPath(path) ? path : null
}

/** The extension to store for a picked file, or null when we won't accept it. */
export function requestPhotoExt(fileName: string, mime?: string | null): string | null {
  const byMime: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/heic': 'heic', 'image/heif': 'heif',
  }
  const m = (mime || '').toLowerCase()
  if (byMime[m]) return byMime[m]
  // Some phones hand over an empty or generic type; fall back to the name, and
  // only for the extensions the bucket path is allowed to carry.
  const ext = (fileName.split('.').pop() || '').toLowerCase()
  return ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(ext) ? ext : null
}

// ── The row, as every owner surface reads it ─────────────────────────────────
export interface PortalRequest {
  id: string
  created_at: string
  customer_id: string | null
  message: string
  kind: string
  status: string
  preferred_date: string | null
  job_id: string | null
  recurrence_id: string | null
  details: unknown
  photos: unknown
  from_portal: boolean
}

/**
 * The owner's queue. A request is OPEN when the customer is still waiting: it
 * came from the portal and nobody has handled or dismissed it.
 *
 * ⭐ `from_portal` is load-bearing, not decoration. service_requests is shared by
 * five producers — website leads, online bookings, marketplace leads and the
 * portal contact-details note all write rows, and 27 of production's 29 rows are
 * still 'new' because those producers close their work in their OWN lifecycles
 * (website_leads.status, conversations.lead_status). Reading `status` alone
 * would put twenty stale leads in front of the owner as customer requests.
 */
export function isOpenRequest(r: Pick<PortalRequest, 'from_portal' | 'status'>): boolean {
  return r.from_portal === true && r.status === 'new'
}

export function openRequests<T extends Pick<PortalRequest, 'from_portal' | 'status'>>(rows: T[] | null | undefined): T[] {
  return (rows ?? []).filter(isOpenRequest)
}

// Known keys of the `details` blob, read defensively. The column is free-form
// jsonb written through a public RPC, so nothing here trusts its shape: an
// unexpected value reads as absent rather than rendering whatever arrived.
export interface RequestDetails { window?: 'anytime' | 'morning' | 'afternoon'; service?: string; action?: string }
export function requestDetails(details: unknown): RequestDetails {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {}
  const d = details as Record<string, unknown>
  const out: RequestDetails = {}
  if (d.window === 'anytime' || d.window === 'morning' || d.window === 'afternoon') out.window = d.window
  if (typeof d.service === 'string' && d.service.trim()) out.service = d.service.trim().slice(0, 80)
  if (typeof d.action === 'string' && d.action.trim()) out.action = d.action.trim().slice(0, 40)
  return out
}

// ── The recommended next action ──────────────────────────────────────────────
export interface RequestAction {
  key: 'quote' | 'schedule' | 'schedule_new'
  label: string
  href: string
  /** Why this is the move, in one line, shown under the buttons. */
  hint: string
}

/**
 * ONE recommended action per request, and the doors it opens are the doors that
 * already exist.
 *
 * ⛔ There is no "change order" object in this product, and this does not invent
 * one. Extra work that changes what a customer owes goes through a QUOTE,
 * because a quote is where this business and its customer agree a price — that
 * is what a change order IS here. Inventing a second priced document would put a
 * second money path beside the one the ledger, the invoice engine and the portal
 * all already read.
 *
 * ⭐ The quote door is opened with `?customer=<id>` and NOTHING ELSE. It carries
 * no amount, no service and no line item from the request — so a price a
 * customer typed into a request can never arrive in a quote as though the
 * business had offered it, and can never be approved. The owner prices the work.
 *
 * ⭐ Schedule changes open the schedule BARE. `?customer=` on that page opens a
 * prefilled NEW-visit form, which is precisely the wrong thing to put in front
 * of someone reading "please move Thursday" — the one confusion that turns a
 * request into a duplicate visit. The card states which visit and which date
 * instead; the owner moves the real one.
 */
export function recommendedAction(r: Pick<PortalRequest, 'kind' | 'customer_id' | 'job_id'>): RequestAction {
  const cust = r.customer_id
  const quoteHref = cust ? `/dashboard/quotes/new?customer=${cust}` : '/dashboard/quotes/new'
  switch (r.kind) {
    case 'reschedule':
      return { key: 'schedule', label: 'Open the schedule', href: '/dashboard/schedule',
        hint: 'Move the visit named above. Nothing has moved yet — this request changed nothing.' }
    case 'plan_change':
      return { key: 'schedule', label: 'Open the schedule', href: '/dashboard/schedule',
        hint: 'Their plan is untouched until you change it here.' }
    case 'appointment':
      return { key: 'schedule_new', label: 'Book a visit', href: cust ? `/dashboard/schedule?customer=${cust}` : '/dashboard/schedule',
        hint: 'Opens a new visit for this customer — pick the day yourself; the date they asked for is above.' }
    case 'additional_work':
      return { key: 'quote', label: 'Create quote', href: quoteHref,
        hint: 'Extra work is priced in a quote — that is where you and the customer agree the change. Nothing is priced from the request.' }
    default:
      return { key: 'quote', label: 'Create quote', href: quoteHref,
        hint: 'Opens the builder on this customer. You set the price — nothing is carried over from the request.' }
  }
}

/**
 * The other doors worth offering, never the recommended one twice. Kept short:
 * a card with five buttons is a card with no recommendation.
 */
export function alternateActions(r: Pick<PortalRequest, 'kind' | 'customer_id' | 'job_id'>): RequestAction[] {
  const primary = recommendedAction(r)
  const cust = r.customer_id
  const all: RequestAction[] = [
    { key: 'quote', label: 'Create quote', href: cust ? `/dashboard/quotes/new?customer=${cust}` : '/dashboard/quotes/new',
      hint: 'You set the price.' },
    { key: 'schedule', label: 'Open the schedule', href: '/dashboard/schedule',
      hint: 'Nothing moves until you move it.' },
  ]
  return all.filter(a => a.key !== primary.key && !(primary.key === 'schedule_new' && a.key === 'schedule'))
}

// ── Copy ─────────────────────────────────────────────────────────────────────
/**
 * The one line that says what this is, for a bell/priority row. Deliberately
 * says "asked", never "booked" or "approved" — the whole feature depends on the
 * owner never reading a request as a commitment.
 */
export function openRequestsHeadline(n: number): string {
  return n === 1 ? '1 customer request waiting' : `${n} customer requests waiting`
}
