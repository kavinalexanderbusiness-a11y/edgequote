// ── Portal view-model engine ────────────────────────────────────────────────
// Every derivation the portal renders, as PURE functions — no React, no PDF
// imports, no I/O — so `verify:portal` can execute the exact production logic
// against fixtures (including a captured real payload) and the tabs stay
// presentational. The load-bearing comments moved here WITH their logic from
// PortalClient; they are the record of decisions that must survive redesigns:
// requests-never-mutations, display-status derivation, the property-identity
// fix, ledger-honest money. If you change a rule here, change its comment.
//
// get_portal_data remains THE only data source and is deliberately untouched
// by this redesign (see prod-schema-exceeds-main: seven files define it; only
// the live definition may be extended, in place, and its length only grows).

import { buildServicePlans, type ServicePlan } from '@/lib/recurrence'
import { jobVisitValue } from '@/lib/invoicing'
import { settingsToSeasons } from '@/lib/seasons'
// THE balance engine (lib/payments/ledger) — the same call the owner's customer
// page, the invoice-reminder cron and ReceiptPDF make. The portal used to re-derive
// `total − amount_paid` inline in three places; identical arithmetic today, but a
// fourth copy of the ledger's definition is exactly how a customer ends up reading a
// different amount due than the owner. Costs nothing to import: ledger's only runtime
// dependency is invoiceTotals, which this module already pulls.
import { invoiceBalance } from '@/lib/payments/ledger'
import { depositState, depositChargeAmount } from '@/lib/payments/deposit'
// THE scheduling-deposit gate (lib/payments/depositGate) — the same engine the
// /api/portal/quote-deposit charge route runs over the same ledger rows, so the
// row's figures and Stripe's ask can never disagree.
import { schedulingGate } from '@/lib/payments/depositGate'
// THE payment-timing interpretation (lib/payments/paymentTiming) — the words
// that describe the gate above. The quote card used to assert "you'll get an
// invoice once the work is done" on a quote whose approval screen then asked for
// half up front; both sentences now come from this one reader.
import { paymentTiming, quoteTimingLine, approvedTimingLine } from '@/lib/payments/paymentTiming'
import { cashAmountOf, ledgerRowType } from '@/lib/payments/analytics'
import { serviceLineTotals } from '@/lib/quoteServices'
import { sortedOptions } from '@/lib/quoteOptions'
// THE authorized-value engine — the same function the owner's job card runs, so
// "$5,500 + $575 = $6,075" is one calculation with two audiences, not two.
import { authorizedValue } from '@/lib/changeOrders'
import { displayQuoteStatus } from '@/lib/quoteStatus'
import {
  isAcceptedOrBeyond, acceptedPresentation, customerFacingQuote,
  acceptedAmountNote, type AcceptanceKind,
} from '@/lib/quoteAcceptance'
import { formatCurrency, parseLocalDate } from '@/lib/utils'
// THE request engine (lib/portalRequests) — the same module the owner's request
// card reads. The kinds, the media contract and the "a request is an ask, not an
// outcome" law live there once, so the two sides of the wire cannot disagree
// about what a customer asked for.
import type { RequestKind } from '@/lib/portalRequests'
import type { Job, JobRecurrence, QuoteStatus } from '@/types'

// ── Payload types (the get_portal_data JSON, verbatim from the old client) ──

export interface PortalQuoteService { service_type: string; quantity: number; unit: string | null; unit_price: number; est_minutes: number | null; discount_type: 'amount' | 'percent' | null; discount_value: number | null; notes: string | null; sort_order: number }
// `valid_until` is the date this price stops standing. Null = it never lapses (every
// quote sent before expiry stamping began). Expiry is DERIVED from it via
// lib/quoteStatus — never stored on status — so the portal reads the same field and
// reaches the same answer as the owner's screens, with no second rule to drift.
// `property_id` is the canonical FK to the property this quote is actually FOR. It is
// optional because a handful of live rows predate property linking — a legacy quote
// answers `null`, and callers must degrade to the quote's own `address` text rather
// than borrowing another property's facts.
/** One alternative version of the job, as get_portal_data nests it under a quote.
 *  ⛔ NOT additive with its siblings and NOT additive with `services` — an option's
 *  price IS the whole job for whoever picks it, and the database refuses a quote
 *  carrying both kinds of row. */
export interface PortalQuoteOption { id: string; name: string; description: string | null; price: number; sort_order: number; is_recommended: boolean }
// `accepted_price` is the consent snapshot (selected option + travel) — the
// scheduling deposit derives from it, never from a total an edit could move.
// `deposit_type`/`deposit_value` is the scheduling-deposit RULE; readiness is
// derived from the ledger by lib/payments/depositGate, never stored anywhere.
// `preferred_*` is the customer's own scheduling REQUEST — a preference, never
// an appointment — echoed back so a reload keeps what they told us.
export interface PortalQuote { id: string; quote_number: string; service_type: string; address: string; property_id?: string | null; total: number; initial_price: number | null; subtotal: number | null; weekly_price: number | null; biweekly_price: number | null; monthly_price: number | null; notes: string | null; status: string; created_at: string; issued_date: string | null; valid_until: string | null; crew_size: number | null; hours: number | null; travel_fee: number | null; services?: PortalQuoteService[] | null; options?: PortalQuoteOption[] | null; selected_option_id?: string | null; accepted_price?: number | null; acceptance_kind?: string | null; deposit_type?: string | null; deposit_value?: number | null; preferred_date?: string | null; preferred_date_2?: string | null; preferred_timing?: string | null; preferred_note?: string | null }
// `property_id` null is the HONEST answer for an invoice spanning several properties —
// never infer one, or a combined invoice prints one address as if it were the whole bill.
export interface PortalInvoice { id: string; invoice_number: string; service_type: string | null; amount: number; status: string; issued_date: string | null; due_date: string | null; notes: string | null; address: string | null; property_id?: string | null; line_items: { description: string; amount: number; kind: string }[] | null; job_id: string | null; created_at: string; discount_type?: 'amount' | 'percent' | null; discount_value?: number | null; amount_paid?: number | null; deposit_amount?: number | null; deposit_requested_at?: string | null }
// ⛔ NO `notes` FIELD, DELIBERATELY. jobs.notes is the INTERNAL access note for
// whoever does the work (gate code, where to park) — it was selected by
// get_portal_data and rendered verbatim here until 2026-08-11, on 49 of 78
// completed production visits, including "dog removal, keep gate closed". It is
// gone from the RPC's projection, so there is nothing left to render even by
// accident. `completion_summary` is the field written FOR the customer, and
// `completion_issue` (the internal half) is likewise not in the payload.
// verify:completion fails the build if either internal field reappears.
export interface PortalJob { id: string; recurrence_id: string | null; property_id: string | null; quote_id: string | null; price: number | null; is_initial_visit: boolean | null; service_type: string | null; title: string; scheduled_date: string; status: string; on_my_way_at: string | null; started_at: string | null; completed_at: string | null; completion_summary: string | null }
export interface PortalRec { id: string; freq: string | null; interval_unit: string | null; interval_count: number | null; start_date: string | null; end_date: string | null; end_count: number | null }
export interface PortalPhoto { id: string; job_id: string | null; storage_path: string; kind: string; caption: string | null; taken_at: string }
export interface PortalPayment { id: string; amount: number; status: string; paid_at: string | null; provider: string; invoice_id: string | null; quote_id?: string | null; created_at: string; kind?: string }
export interface PortalCard { brand: string | null; last4: string | null; exp_month: number | null; exp_year: number | null }
// A change to a visit's scope, priced and awaiting (or carrying) the customer's
// own decision. `status` is the raw lifecycle — the portal only ever renders
// pending / approved / declined / cancelled, never a draft (the RPC filters it).
export interface PortalChangeOrder {
  id: string; co_number: string; job_id: string; quote_id: string | null
  description: string; amount: number; status: string
  decided_via: string | null
  created_at: string; sent_at: string | null; approved_at: string | null; declined_at: string | null
}
// The owner's OWN catalogue (service_templates), surfaced by get_portal_data. This
// is what makes ONE portal fit any field-service business — and it is also the
// portal's ONE honest "recommendations" surface: things this business actually
// sells, in the owner's order. Never an invented score, prediction or urgency —
// the customer-experience audit is explicit that the data cannot support those.
export interface PortalService { name: string; category: string | null; default_rate: number | null; pricing_display_type: string | null; default_description: string | null }
// One of the customer's properties. `id` is what a quote/invoice row's property_id
// points at — this array is the ONLY way a card can name its own address or area.
// `lawn_sqft` is a historical column NAME holding a measured AREA of any kind (a
// driveway, a roof); never surface the word "lawn" from it.
export interface PortalProperty { id: string; address: string | null; city: string | null; province: string | null; postal_code: string | null; lawn_sqft: number | null; fence_length: number | null; neighborhood: string | null; is_primary: boolean | null }
// direction is from the OWNER's perspective: 'inbound' = the customer speaking.
export interface PortalMessage { id: string; direction: string; channel: string; body: string; created_at: string }

export interface PortalData {
  customer: { id: string; name: string; email: string | null; phone: string | null; address: string | null; city: string | null; sms_opt_in?: boolean | null; email_opt_in?: boolean | null; reviewed_at?: string | null; review_declined_at?: string | null; autopay_enabled?: boolean | null }
  business: { company_name: string | null; owner_name: string | null; phone: string | null; email_primary: string | null; email_secondary: string | null; website: string | null; logo_url: string | null; logo_scale: number | null; base_address: string | null; terms_text: string | null; review_url?: string | null; etransfer_email?: string | null; gst_percent?: number | null; gst_number?: string | null; service_seasons?: unknown } | null
  // `property` (singular) is the PRIMARY property and stays exactly as it was — the
  // right answer to "where does this customer mainly live", the WRONG answer to
  // "what is this quote for" (that is `properties` + a row's own property_id).
  property: { address: string | null; city: string | null; province: string | null; lawn_sqft: number | null; fence_length: number | null; neighborhood: string | null; notes: string | null } | null
  // Every property, primary first (same ordering as `property`, so properties[0] is it).
  properties?: PortalProperty[] | null
  quotes: PortalQuote[]; invoices: PortalInvoice[]; jobs: PortalJob[]; recurrences: PortalRec[]; photos: PortalPhoto[]; payments: PortalPayment[]
  // Scope priced AFTER the original approval. get_portal_data omits DRAFTS — an
  // unsent change is the business's unfinished thought, not a price anybody has
  // decided to charge. Absent on a payload from before this feature.
  change_orders?: PortalChangeOrder[] | null
  payment_method?: PortalCard | null
  services?: PortalService[] | null
}

// A PortalInvoice as the ledger's balance engine wants it. Only a type bridge: the
// RPC's json_agg yields `null` for an absent amount_paid/discount where the Invoice
// row type uses `undefined`. No arithmetic happens here — that is invoiceBalance's job.
function forBalance(i: PortalInvoice) {
  return {
    amount: i.amount,
    amount_paid: i.amount_paid ?? undefined,
    discount_type: i.discount_type ?? null,
    discount_value: i.discount_value ?? null,
  }
}

// The same bridge, widened for the deposit engine (lib/payments/deposit). Same
// rule: types only, zero arithmetic — depositState/depositChargeAmount own every
// number derived from these fields, here exactly as on the owner's screens and
// in both charge routes, so no surface can disagree about what a deposit is.
function forDeposit(i: PortalInvoice) {
  return {
    ...forBalance(i),
    deposit_amount: i.deposit_amount ?? null,
    deposit_requested_at: i.deposit_requested_at ?? null,
  }
}

export type TabKey = 'home' | 'property' | 'visits' | 'billing' | 'messages' | 'requests'
export type LiveStatus = 'scheduled' | 'on_my_way' | 'in_progress' | 'completed'
export type DocKind = 'quote' | 'invoice'

// Every customer action is a REQUEST that threads into the owner's ONE Messages
// hub (service_requests → sr_to_conversation) — nothing in the portal mutates
// jobs or plans directly. The message string is what the owner reads; the
// structured fields exist so their side can grow one-tap actions later.
export type SubmitRequestFn = (opts: {
  message: string; kind: RequestKind
  preferredDate?: string | null; jobId?: string | null; recurrenceId?: string | null
  details?: Record<string, unknown> | null
  /**
   * booking-uploads storage PATHS the customer attached (never URLs — see
   * lib/portalRequests). The RPC refuses a malformed one rather than dropping
   * it silently, so a photo either arrives or the customer is told it didn't.
   */
  photos?: string[] | null
}) => Promise<boolean>

// What a customer can request comes from the owner's OWN catalogue — never a
// hardcoded list. Capped so the tab stays a decision, not a catalogue dump; the
// free-text "Something else?" ask covers the rest and always works.
export const MAX_REQUEST_PRESETS = 8

// ── Deep links (URL-addressable portal) ─────────────────────────────────────
// The portal is opened from a link — a reminder text, a bookmark, a refresh.
// This makes the URL name a place, so the owner's existing "pay your invoice"
// text can land the customer on the exact bill (?invoice=<id>) and a refresh
// keeps their tab (?tab=billing) instead of bouncing them to Home. Pure
// parsing, no navigation and no data claim: an ?invoice pointing at a bill this
// customer can't see simply lands them on Billing with nothing to highlight —
// wrong-answer-proof, like resolveDocAddress. It reuses the existing tab keys;
// it never invents a route or a second navigation model.
const TAB_KEYS: TabKey[] = ['home', 'property', 'visits', 'billing', 'messages', 'requests']

export interface PortalDeepLink {
  tab: TabKey | null
  docsCat: 'all' | 'quote' | 'invoice' | null
  focusDocId: string | null
}

export function parsePortalDeepLink(search: string): PortalDeepLink {
  const sp = new URLSearchParams(search || '')
  const rawTab = (sp.get('tab') || '').toLowerCase()
  let tab: TabKey | null = (TAB_KEYS as string[]).includes(rawTab) ? (rawTab as TabKey) : null
  let docsCat: 'all' | 'quote' | 'invoice' | null = null
  let focusDocId: string | null = null

  // A pointed link to one document wins and implies the Billing tab + its filter.
  const invoice = (sp.get('invoice') || '').trim()
  const quote = (sp.get('quote') || '').trim()
  if (invoice) { tab = 'billing'; docsCat = 'invoice'; focusDocId = invoice }
  else if (quote) { tab = 'billing'; docsCat = 'quote'; focusDocId = quote }
  else if (tab === 'billing') {
    const c = (sp.get('cat') || '').toLowerCase()
    if (c === 'quote' || c === 'invoice' || c === 'all') docsCat = c
  }
  return { tab, docsCat, focusDocId }
}

// The tablist keyboard model (WAI-ARIA tabs): which tab index a keypress moves
// focus to, or null to leave the event alone. Pure so the wrap-around is pinned
// by verify — an off-by-one here silently traps keyboard users on the last tab.
// Arrow keys wrap (a tab bar is a ring); Home/End jump to the ends.
export function tabNavTarget(key: string, current: number, count: number): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowRight': case 'ArrowDown': return (current + 1) % count
    case 'ArrowLeft': case 'ArrowUp': return (current - 1 + count) % count
    case 'Home': return 0
    case 'End': return count - 1
    default: return null
  }
}

// The keyboard "send" chord for a composer: Cmd/Ctrl+Enter, matching the app's
// Modal convention. Plain Enter stays a newline (a message can be multi-line),
// so a phone's soft keyboard — which never sends the modifier — is completely
// unaffected; this is a desktop convenience only. Pure so verify pins that
// plain Enter never sends.
export function isSendChord(e: { key: string; metaKey?: boolean; ctrlKey?: boolean }): boolean {
  return (!!e.metaKey || !!e.ctrlKey) && e.key === 'Enter'
}

// ── Add to calendar (client-side .ics) ──────────────────────────────────────
// A homeowner wants their service visit in their phone's calendar so they can
// plan around it. Everything needed is already in the payload — this generates
// a standard iCalendar file in the browser, no backend and no engine. Pure so
// verify can pin the format (a malformed .ics silently fails to import).
export interface CalendarVisit {
  uid: string          // stable per visit → re-adding UPDATES, never duplicates
  dateISO: string      // 'YYYY-MM-DD'
  title: string
  description?: string | null
  location?: string | null
}

// RFC 5545 §3.3.11 text escaping: backslash, semicolon, comma, newline.
function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}
// Fold content lines to ≤75 octets (§3.1) — Google Calendar is strict; a
// continuation line begins with a single space.
function icsFold(line: string): string {
  if (line.length <= 74) return line
  const out = [line.slice(0, 74)]
  let rest = line.slice(74)
  while (rest.length) { out.push(' ' + rest.slice(0, 73)); rest = rest.slice(73) }
  return out.join('\r\n')
}
// 'YYYY-MM-DD' → basic 'YYYYMMDD', with an optional day offset for the all-day
// exclusive DTEND. UTC arithmetic, so it never drifts a day across a timezone.
function icsDate(dateISO: string, addDays = 0): string {
  const d = new Date(Date.parse(dateISO + 'T00:00:00Z') + addDays * 86_400_000)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}
// ISO instant → basic 'YYYYMMDDTHHMMSSZ' for DTSTAMP.
function icsStamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d+/, '').replace(/Z?$/, 'Z')
}

// Booked visits → one downloadable .ics. All-day events on the scheduled date:
// the payload carries a DATE, not a time, so an all-day block is the HONEST
// representation — we never invent an appointment hour. `stampISO` is injected
// (kept pure) so verify is deterministic.
export function buildVisitICS(visits: CalendarVisit[], opts: { stampISO: string; calName?: string }): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//EdgeQuote//Customer Portal//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH']
  if (opts.calName) lines.push(icsFold(`X-WR-CALNAME:${icsEscape(opts.calName)}`))
  const stamp = icsStamp(opts.stampISO)
  for (const v of visits) {
    lines.push('BEGIN:VEVENT')
    lines.push(icsFold(`UID:${v.uid}`))
    lines.push(`DTSTAMP:${stamp}`)
    lines.push(`DTSTART;VALUE=DATE:${icsDate(v.dateISO)}`)
    lines.push(`DTEND;VALUE=DATE:${icsDate(v.dateISO, 1)}`)
    lines.push(icsFold(`SUMMARY:${icsEscape(v.title)}`))
    if (v.description) lines.push(icsFold(`DESCRIPTION:${icsEscape(v.description)}`))
    if (v.location) lines.push(icsFold(`LOCATION:${icsEscape(v.location)}`))
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.join('\r\n') + '\r\n'
}

// Per-token, per-surface sessionStorage key for a composer draft, so a
// half-typed message or request survives tapping to another tab (and a
// refresh) instead of being lost when the tab unmounts. Token-scoped hygiene:
// a draft belongs to the one customer whose link it is, and the two composers
// never share a key. sessionStorage (not local) so it clears when the tab
// closes — a draft never outlives the session that wrote it.
export type DraftSurface = 'message' | 'request'
export function draftStorageKey(token: string, surface: DraftSurface): string {
  return `eqp:draft:${surface}:${token}`
}

// ── Which contact detail is missing? ─────────────────────────────────────────
// THE one answer, so the prompt, the form and the guard can't disagree about
// what's absent. Whitespace is not a way to reach someone.
//
// ⚠️ A missing customer payload is 'none' — NOT 'both'. A read that failed tells
// us nothing about the file, and the honest reading of "we don't know" is to ask
// for nothing, never to assert a gap. (The inverse mistake — treating a failed
// read as "profile complete" — is harmless here for the same reason: the prompt
// is the only thing gated on this, and it reappears on the next good load.)
//
// This replaced needsContactMethod(), which answered only the both-missing case.
// That left the 47 customers with a phone but no email, and the 2 with an email
// but no phone, never asked — the commonest gap in the book was the one nobody
// was prompted about.
export type ContactGap = 'none' | 'phone' | 'email' | 'both'

export function contactGap(customer: { phone: string | null; email: string | null } | null | undefined): ContactGap {
  if (!customer) return 'none'
  const noPhone = !(customer.phone ?? '').trim()
  const noEmail = !(customer.email ?? '').trim()
  if (noPhone && noEmail) return 'both'
  if (noPhone) return 'phone'
  if (noEmail) return 'email'
  return 'none'
}

// ── What counts as a usable contact detail ───────────────────────────────────
// ⚠️ These MIRROR portal_add_contact's validation so the customer gets an answer
// without a round-trip. The RPC is the authority — it re-checks everything, and a
// disagreement can only ever make this side stricter-looking, never let a bad
// value through. verify:portal-contact pins the two thresholds against the
// migration file so the mirror can't drift silently.
//
// Ten digits, not the seven that phoneMatches() will link on: seven is a local
// number missing its area code, and a stored number that can't be dialled fails
// at exactly the moment it's needed.
export const PHONE_MIN_DIGITS = 10
export const PHONE_MAX_DIGITS = 15

export function isUsablePhone(raw: string): boolean {
  const d = (raw || '').replace(/\D/g, '')
  return d.length >= PHONE_MIN_DIGITS && d.length <= PHONE_MAX_DIGITS
}

// Same shape as the SQL check: something, @, something, dot, a real TLD. Kept
// deliberately loose — an address the customer insists is theirs is not ours to
// argue with, and the only failure this needs to catch is an obvious typo.
export function isUsableEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test((raw || '').trim())
}

// Did real money land in the ledger just now? THE post-checkout confirmation test.
//
// `?paid=1` only means the customer reached Stripe's return URL, so the banner has
// always been gated on the LEDGER rather than the query string. It used to make
// that check by counting rows before and after a single refetch — which breaks in
// the commonest direction: Stripe's webhook usually beats our return trip, so the
// row is ALREADY in the server-rendered payload, the count never increases, and a
// customer who genuinely paid is told "confirming your payment…" forever while
// their invoice still shows a Pay button.
//
// Asking the ledger WHAT it holds instead of HOW MANY rows it has answers both
// orderings with one question: a completed payment stamped within the last few
// minutes is the money we just sent them to make. Still strictly a ledger check —
// nothing here trusts the URL — and it stays honest when nothing landed, because
// an empty or older ledger returns false and the banner keeps saying "confirming".
//
// Deliberately provider-agnostic: a portal checkout records `stripe` today and
// `card` on the saved-card path, and a future provider must not silently stop
// confirming. Refunds/credits are excluded — `kind` is only ever absent on a
// payment (older rows predate the column), never on a reversal.
const PAYMENT_LANDED_WINDOW_MS = 15 * 60 * 1000

export function recentPaymentLanded(
  payments: PortalPayment[] | null | undefined,
  nowMs: number,
  windowMs: number = PAYMENT_LANDED_WINDOW_MS,
): boolean {
  for (const p of payments || []) {
    if (p.status !== 'paid') continue
    if (p.kind != null && p.kind !== 'payment') continue
    const stamp = Date.parse(p.paid_at || p.created_at || '')
    if (!Number.isFinite(stamp)) continue
    // A future-dated stamp (clock skew) still counts as "just now"; only an
    // OLDER-than-window payment is somebody else's, earlier, story.
    if (nowMs - stamp <= windowMs) return true
  }
  return false
}

// ── What portal_add_contact answered ─────────────────────────────────────────
// The RPC returns the row state read back AFTER its write, which is the only
// thing that entitles the portal to say "saved". `reason` is a machine code, not
// a sentence — the wording lives with the card so copy can change without
// touching a contract, and so the same code can read differently in two places.
//
// `contactUpdateMessage` / `contactSentKey` were deleted with the old card. That
// card couldn't write anything, so it sent the typed values to the owner as a
// REQUEST and used a sessionStorage flag to remember it had — a client-side
// guess at a server-side fact. The file now changes for real, so "is it done?"
// is answered by the customer row on the next load and nothing needs to remember.
export type AddContactReason =
  | 'invalid_token' | 'nothing_to_add' | 'already_on_file'
  | 'bad_phone' | 'bad_email' | 'phone_taken' | 'email_taken'
  | 'network'

export interface AddContactResult {
  ok: boolean
  reason?: AddContactReason | null
  added?: string[]
  skipped?: string[]
  has_phone?: boolean
  has_email?: boolean
}

// A contextual "ask about this" seed for the message composer. It MUST carry
// the document number — that's the whole point: the owner can tell which
// invoice/quote the question is about instead of asking "which one?". Ends with
// ": " so the cursor lands where the customer starts typing. Pure so verify
// pins the number's presence (a future edit that drops it breaks the feature
// silently).
export function messageAboutDoc(kindLabel: string, number: string, title?: string | null): string {
  const t = title?.trim()
  return `About ${kindLabel.toLowerCase()} ${number}${t ? ` (${t})` : ''}: `
}

// One booked job → a calendar event. ASCII separator on purpose (max calendar
// compatibility); location is the visit's OWN property (resolved through its
// property_id, same rule as everywhere — never the primary as a stand-in).
export function visitToCalendarEvent(job: PortalJob, business: PortalData['business'], propsById: Map<string, PortalProperty>): CalendarVisit {
  const svc = job.service_type || job.title || 'Service visit'
  const company = business?.company_name?.trim() || null
  const address = (job.property_id ? propsById.get(job.property_id)?.address : null)?.trim() || null
  return {
    uid: `visit-${job.id}@edgequote`,
    dateISO: job.scheduled_date,
    title: company ? `${svc} - ${company}` : svc,
    description: company ? `Your scheduled visit with ${company}.` : 'Your scheduled visit.',
    location: address,
  }
}

// ── Normalize ───────────────────────────────────────────────────────────────
// Defensive: an OLDER get_portal_data — or a customer with no rows in a section —
// can return null for a collection (Postgres json_agg is null, not []). Coerce
// EVERY array so the portal can never white-screen.
// ⚠️ History: `services` was once dropped from this literal, so the owner's own
// catalogue never rendered and tsc could not notice (every field is optional).
// Any NEW key the RPC grows must be added HERE and to verify-portal's
// round-trip check, which exists precisely to catch the next silent drop.
export function normalizePortal(d: unknown): PortalData | null {
  const raw = (d ?? null) as Partial<PortalData> | null
  if (!raw) return null
  return {
    customer: raw.customer ?? { id: '', name: 'Customer', email: null, phone: null, address: null, city: null },
    business: raw.business ?? null,
    property: raw.property ?? null,
    properties: Array.isArray(raw.properties) ? raw.properties : [],
    services: Array.isArray(raw.services) ? raw.services : [],
    quotes: Array.isArray(raw.quotes) ? raw.quotes : [],
    invoices: Array.isArray(raw.invoices) ? raw.invoices : [],
    jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
    recurrences: Array.isArray(raw.recurrences) ? raw.recurrences : [],
    photos: Array.isArray(raw.photos) ? raw.photos : [],
    payments: Array.isArray(raw.payments) ? raw.payments : [],
    payment_method: raw.payment_method ?? null,
    // A payload from before this feature has no key at all — [] is the honest
    // reading of "this business has never raised a change", and it is also what
    // an older get_portal_data returns, so the portal renders identically.
    change_orders: Array.isArray(raw.change_orders) ? raw.change_orders : [],
  }
}

// ── Small facts ─────────────────────────────────────────────────────────────

export function liveStatusOf(j: PortalJob): LiveStatus {
  if (j.completed_at || j.status === 'completed') return 'completed'
  if (j.started_at || j.status === 'in_progress') return 'in_progress'
  if (j.on_my_way_at) return 'on_my_way'
  return 'scheduled'
}

// THE day a visit actually happened. A rained-out visit is scheduled for Tuesday
// and completed on Thursday — and the customer remembers Thursday. One visit, one date.
export function visitDay(j: { scheduled_date: string; completed_at: string | null }): string {
  return j.completed_at ? j.completed_at.slice(0, 10) : j.scheduled_date
}

// "Tomorrow" is the answer they actually wanted; beyond two weeks the countdown
// stops being useful and the absolute date carries it alone.
export function daysAwayLabel(dateISO: string, todayISO: string): string | null {
  const days = Math.round((parseLocalDate(dateISO).getTime() - parseLocalDate(todayISO).getTime()) / 86_400_000)
  if (days < 0 || days > 14) return null
  return days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `In ${days} days`
}

// How soon an unpaid invoice is DUE — so a bill due tomorrow doesn't read the
// same as one due next month, which is how a customer misses it and lets it
// slip overdue. Returns a relative phrase only inside a 7-day window (a due
// date further out is not yet urgent and the absolute date carries it), and
// `urgent` for today/tomorrow so the row can raise its voice. Past dates return
// null — an overdue invoice already has its own (louder) treatment. Pure so
// verify pins the window and the urgent boundary.
export function dueSoonLabel(dueISO: string, todayISO: string): { rel: string; urgent: boolean } | null {
  const days = Math.round((parseLocalDate(dueISO).getTime() - parseLocalDate(todayISO).getTime()) / 86_400_000)
  if (days < 0 || days > 7) return null
  if (days === 0) return { rel: 'due today', urgent: true }
  if (days === 1) return { rel: 'due tomorrow', urgent: true }
  return { rel: `due in ${days} days`, urgent: false }
}

export function groupPhotos(photos: PortalPhoto[]): Map<string, PortalPhoto[]> {
  const m = new Map<string, PortalPhoto[]>()
  for (const p of photos) { const k = p.job_id || 'none'; if (!m.has(k)) m.set(k, []); m.get(k)!.push(p) }
  return m
}

// Every photo the Visits tab won't already show inside a completed-visit card —
// i.e. loose photos (no job) AND photos on a job that isn't completed yet (a
// "before" shot on an in-progress visit). The old Photos tab rendered EVERY
// group regardless of job status; when that tab folded into per-visit cards,
// non-completed-job photos had nowhere to land. This is their home, so "every
// photo" stays literally true. Sorted newest-first, like the old gallery.
export function orphanPhotos(photos: PortalPhoto[], completedJobIds: Set<string>): PortalPhoto[] {
  return photos
    .filter(p => !p.job_id || !completedJobIds.has(p.job_id))
    .slice()
    .sort((a, b) => (b.taken_at || '').localeCompare(a.taken_at || ''))
}

// The bucket for a document/visit that doesn't name a property we know. A UUID
// can never collide with it, so it can share the group maps' key space.
export const NO_PROPERTY = 'no-property'

// THE address resolver — the one answer to "which address identifies this row",
// asked identically by quotes, invoices and visits so the fallback chain exists
// once. The canonical properties.address WINS whenever property_id resolves; the
// row's own copied `address` text is a FALLBACK (stale copies differ in
// formatting, and some name a different street outright), answering only when
// property_id is null (legacy) or points at a property this payload didn't carry.
export function resolveDocAddress(propsById: Map<string, PortalProperty>, propertyId: string | null | undefined, ownAddress: string | null | undefined): string | null {
  const canonical = (propertyId ? propsById.get(propertyId) : null)?.address?.trim()
  if (canonical) return canonical
  return ownAddress?.trim() || null
}

// ── Derived schedule / plans (THE shared engines, unchanged) ────────────────

export interface Derived {
  upcoming: PortalJob[]; completed: PortalJob[]; nextService: PortalJob | null
  lastCompleted: PortalJob | null; outstanding: number
  // ServicePlan comes from THE shared engine (lib/recurrence.buildServicePlans).
  // nextJobId rides alongside: the concrete visit behind nextVisitDate — what a
  // "skip next visit" request points at, so the owner knows exactly which job.
  plans: (ServicePlan & { nextJobId: string | null })[]
}

export function buildDerived(data: PortalData, todayISO: string): Derived {
  const jobs = data.jobs || []
  const upcoming = jobs.filter(j => j.scheduled_date >= todayISO && j.status !== 'completed').sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))
  // Sorted by when the work HAPPENED, not when it was planned — otherwise a
  // rain-delayed visit sits below one it actually followed, and lastCompleted
  // (which also gates the review card) can name the wrong visit entirely.
  const completed = jobs.filter(j => j.status === 'completed').sort((a, b) => visitDay(b).localeCompare(visitDay(a)))
  const nextService = upcoming[0] || null
  const lastCompleted = completed[0] || null
  // Outstanding = unpaid BALANCE (total − payments recorded) across issued
  // invoices, so partial payments and discounts are reflected. Same engine as
  // the dashboard — never a second GST/discount computation here.
  const gstPct = Number(data.business?.gst_percent) || 0
  const outstanding = (data.invoices || []).filter(i => i.status !== 'draft' && i.status !== 'cancelled').reduce(
    (s, i) => s + Math.max(0, invoiceBalance(forBalance(i), { gst_percent: gstPct }).balance), 0)
  // Service plans come from THE shared engine — the exact function the owner's
  // customer page runs, so the two can never disagree about a plan. A series
  // with no future visits reports paused:true instead of disappearing.
  const seasons = settingsToSeasons(data.business?.service_seasons)
  const quoteById = new Map(data.quotes.map(q => [q.id, q]))
  const planValueOf = (j: Job) => {
    const q = j.quote_id ? quoteById.get(j.quote_id) : null
    const freq = data.recurrences.find(r => r.id === j.recurrence_id)?.freq ?? null
    return jobVisitValue(j.price, q as unknown as Record<string, unknown>, freq, j.is_initial_visit)
  }
  const plans = buildServicePlans(
    data.recurrences as unknown as JobRecurrence[],
    jobs as unknown as Job[],
    seasons,
    todayISO,
    planValueOf,
  ).map(p => ({ ...p, nextJobId: upcoming.find(j => j.recurrence_id === p.recurrenceId)?.id || null }))
  return { upcoming, completed, nextService, lastCompleted, outstanding, plans }
}

// ── Changes to a visit ───────────────────────────────────────────────────────
//
// The customer's half of change orders. THREE figures that must stay apart on
// every screen, which is the whole point of the feature:
//
//   original    what they approved when the work was agreed — never rewritten
//   approved    changes they have since said yes to
//   authorized  the two added up: everything they have agreed to pay
//
// …and `pending`, which is asked and NOT in any of those totals. The arithmetic
// is lib/changeOrders.authorizedValue — the SAME function the owner's job card
// runs, so the two sides of the same job cannot report different totals.
export interface VisitChanges {
  jobId: string
  original: number
  approvedChanges: number
  authorized: number
  pending: PortalChangeOrder[]
  approved: PortalChangeOrder[]
  /** Answered "no", kept visible so a customer can see what they turned down. */
  declined: PortalChangeOrder[]
}

/** Every visit that has a non-draft change order, keyed by job id. Visits with
 *  none are absent — there is nothing to say about them. */
export function buildVisitChanges(
  data: PortalData, valueOf: (job: PortalJob) => number,
): Map<string, VisitChanges> {
  const out = new Map<string, VisitChanges>()
  const byJob = new Map<string, PortalChangeOrder[]>()
  for (const co of data.change_orders || []) {
    // 'cancelled' is deliberately dropped from the customer's view: the business
    // withdrew the ask, so there is nothing for them to do or to have agreed to.
    if (co.status === 'cancelled' || co.status === 'draft') continue
    const list = byJob.get(co.job_id) || []
    list.push(co)
    byJob.set(co.job_id, list)
  }
  for (const [jobId, list] of byJob) {
    const job = (data.jobs || []).find(j => j.id === jobId)
    if (!job) continue   // a change order for a visit this payload can't see says nothing
    const av = authorizedValue({ originalValue: valueOf(job), changeOrders: list.map(c => ({ status: c.status as never, amount: c.amount })) })
    out.set(jobId, {
      jobId,
      original: av.original,
      approvedChanges: av.approvedChanges,
      authorized: av.authorized,
      pending: list.filter(c => c.status === 'pending').sort((a, b) => a.created_at.localeCompare(b.created_at)),
      approved: list.filter(c => c.status === 'approved').sort((a, b) => a.created_at.localeCompare(b.created_at)),
      declined: list.filter(c => c.status === 'declined').sort((a, b) => a.created_at.localeCompare(b.created_at)),
    })
  }
  return out
}

// ── Documents (quotes + invoices as one records list) ───────────────────────
// `amountNote` qualifies the headline figure: invoice amounts include GST, quote
// totals don't — the row a customer approves from must say so, or the first bill
// looks like a bait-and-switch. `explain` answers "why does this cost this?" in
// the customer's own terms — only facts about THEIR property and THEIR job,
// never the owner's rate, margin, floor or win-rate. `status` on a quote is the
// DISPLAY status (lib/quoteStatus): an expired quote arrives as 'expired', which
// is what removes the Accept button (canAccept tests 'sent') with no second
// expiry check anywhere in the render path to forget or contradict.
export interface DocItem { id: string; rawId: string; kind: DocKind; number: string; title: string; date: string; status: string; expiredOn?: string; validUntil?: string | null; dueDate?: string | null; amount: number; amountNote?: string; balance: number; filename: string; getBlob: () => Promise<Blob>
  /** Additive breakdown — these SUM to `amount`. The scope being approved. */
  lines?: { label: string; amount: number }[]
  /**
   * Ongoing per-visit rates. These are ALTERNATIVES to one another and are NOT
   * part of `amount` — kept out of `lines` because the two answer different
   * questions and a customer cannot tell them apart once they share one list.
   * Flattened together, a real quote showed a $50 total with "Bi-weekly plan
   * $50" directly beneath it — the same number meaning two different things —
   * above rows that summed to $95 against a $50 quote.
   * Approving does NOT choose one (portal_accept_quote snapshots the quote
   * total, never a cadence), so the UI must not present them as selectable.
   */
  planOptions?: { label: string; amount: number }[]
  /**
   * ⭐ SCOPE alternatives — Budget / Standard / Premium. The customer picks ONE
   * and that option's price IS the quote's price.
   *
   * ⛔ Three different lists live on this row and a reader must never confuse
   * them. `lines` ADD UP to `amount`. `planOptions` are ongoing per-visit rates
   * for LATER and are not selectable at all. These are mutually exclusive
   * versions of the job being quoted, exactly one of which is bought — and they
   * are the only one of the three the approval flow acts on.
   *
   * Each `amount` is what that option costs the customer, travel included, which
   * is the same figure `quote_apply_option_choice` writes to accepted_price. No
   * caller sums them, and `amount` above is never their total: it is whichever
   * single option the quote currently rests on.
   */
  options?: { id: string; name: string; description: string | null; amount: number; isRecommended: boolean }[]
  /** The option the customer approved, once they have. Null while the choice is
   *  still open — which is the fact the Approve button is gated on. */
  selectedOptionId?: string | null
  /**
   * The SCHEDULING-DEPOSIT gate, present only on a quote that requires one and
   * has been approved (or scheduled). Every figure is lib/payments/depositGate's
   * answer over the same ledger rows the charge route reads — the row can never
   * quote money the server won't ask for. `satisfied` is the ONE fact that
   * separates "Deposit required" from "Deposit received"; scheduling itself is
   * still the business's call either way.
   */
  schedulingDeposit?: {
    required: number; collected: number; outstanding: number
    percent: number | null; satisfied: boolean
  }
  /**
   * ⭐ WHEN this quote's money is due, in words — lib/payments/paymentTiming's
   * one sentence, computed HERE so every surface that mentions timing renders
   * the identical string rather than composing its own.
   *
   * It rides the row for the same reason payAmount does: Home, Billing and the
   * approval dialog each used to write their own version, and a customer could
   * read "nothing is charged" on one card and "$500 deposit required" on the
   * next. A component that needs to say when money is due renders THIS.
   */
  paymentTimingLine?: string
  /**
   * The same interpretation AFTER approval, read against the LEDGER — present
   * only while a gate exists. Distinct from `paymentTimingLine` because the
   * question changes once they have said yes: not "when will I owe" but "where
   * does this stand". It knows three things the standing terms cannot:
   * what is still outstanding, that a satisfied deposit is HELD AS CREDIT and
   * comes off the final invoice (ledger.recordDeposit's second leg — the portal
   * used to leave the customer wondering if they had paid $500 extra), and that
   * an overridden quote is already booked with the money still owed.
   */
  depositTimingLine?: string
  /** The customer's scheduling preference, echoed back. Editable while the
   *  quote is 'accepted'; read-only once a real visit exists. */
  preference?: { date: string | null; date2: string | null; timing: string | null; note: string | null }
  /** True while portal_set_scheduling_preference will still accept a write —
   *  i.e. status is exactly 'accepted'. The form hides itself after that. */
  canEditPreference?: boolean
  explain?: string[]; propertyId?: string | null; address?: string | null
  /**
   * What the Pay button collects RIGHT NOW — depositChargeAmount's answer, the
   * SAME engine call /api/portal/pay makes server-side. Carried on the row so
   * the button can never quote money Stripe won't ask for: while a deposit is
   * outstanding this is the deposit (payIsDeposit true), afterwards the
   * ordinary balance. 0 on quotes and settled invoices.
   */
  payAmount: number
  payIsDeposit: boolean
  /** The deposit picture (engine's depositState), present only when one was requested. */
  deposit?: { requested: number; percent: number | null; outstanding: number; remainingAfter: number; covered: boolean }
}

export interface DocBlobRenderers {
  quote: (q: PortalQuote) => Promise<Blob>
  invoice: (i: PortalInvoice) => Promise<Blob>
}

export function buildDocItems(opts: {
  quotes: PortalQuote[]; invoices: PortalInvoice[]
  properties: PortalProperty[]; business: PortalData['business']
  todayISO: string
  renderers: DocBlobRenderers
  onInvoiceOpen?: (invoiceId: string) => void
  /** The customer's ledger rows — the scheduling-deposit gate derives from these. */
  payments?: PortalPayment[]
}): DocItem[] {
  const { quotes, invoices, properties, business, todayISO, renderers, onInvoiceOpen, payments } = opts
  const gstPct = Number(business?.gst_percent) || 0
  const propsById = new Map(properties.map(p => [p.id, p]))
  // Cash rows by the quote they secure. The gate engine applies isCashRow itself;
  // this only groups. Rows with no quote_id (ordinary invoice payments) drop out.
  const depositRowsByQuote = new Map<string, PortalPayment[]>()
  for (const p of payments || []) {
    if (p.quote_id) {
      const list = depositRowsByQuote.get(p.quote_id) || []
      list.push(p)
      depositRowsByQuote.set(p.quote_id, list)
    }
  }

  const q: DocItem[] = quotes.map(qq => {
    // The property THIS quote is for. Null for a legacy quote with no
    // property_id — in which case every property-derived fact below stays silent.
    const qProp = qq.property_id ? propsById.get(qq.property_id) ?? null : null
    const qSqft = Number(qProp?.lawn_sqft) || 0
    // Multi-service quotes get a per-service breakdown (same serviceLineTotals
    // math as the builder/PDF) so the customer sees what makes up the total.
    const svc = (qq.services || []).slice().sort((a, b) => a.sort_order - b.sort_order)
    const svcLines = svc.length > 1
      ? [
          ...svc.map(s => ({
            label: Number(s.quantity) > 1 ? `${s.service_type} × ${Number(s.quantity)}` : s.service_type,
            amount: serviceLineTotals(s).net,
          })),
          ...(Number(qq.travel_fee) > 0 ? [{ label: 'Travel fee', amount: Number(qq.travel_fee) }] : []),
        ]
      : []
    // Ongoing plan pricing is material to the approval — show it on the row.
    // "(per visit)" is NOT optional: "Monthly plan · $260" without it says
    // $260/month all-in — at 4 visits/month that's a 4× misread the customer
    // only discovers on their first bill.
    // Ongoing rates are a CHOICE, so they leave the additive breakdown entirely
    // (see DocItem.planOptions). "(per visit)" stays: "Monthly · $260" without it
    // says $260/month all-in — at 4 visits/month a 4× misread the customer only
    // discovers on their first bill.
    const planOptionRows = [
      Number(qq.weekly_price) > 0 ? { label: 'Every week', amount: Number(qq.weekly_price) } : null,
      Number(qq.biweekly_price) > 0 ? { label: 'Every 2 weeks', amount: Number(qq.biweekly_price) } : null,
      Number(qq.monthly_price) > 0 ? { label: 'Every month', amount: Number(qq.monthly_price) } : null,
    ].filter((l): l is { label: string; amount: number } => l !== null)
    const planOptions = planOptionRows.length > 0 ? planOptionRows : undefined
    const lines = svcLines.length > 0 ? svcLines : undefined
    // ── The scope alternatives ────────────────────────────────────────────────
    // Sorted by the ONE shared engine so the customer sees the owner's order —
    // never re-sorted by price, because an owner who leads with Premium meant to.
    // Travel is added to EACH option independently (never once to a total): it is
    // payable whichever one they choose, and it is how the approval RPC computes
    // accepted_price, so the button and the receipt agree by construction.
    const qOpts = sortedOptions(qq.options || [])
    const options = qOpts.length > 0
      ? qOpts.map(o => ({
          id: o.id, name: o.name, description: o.description,
          amount: Number(o.price) + (Number(qq.travel_fee) || 0),
          isRecommended: !!o.is_recommended,
        }))
      : undefined
    // ── ⭐⭐ MAY WE CALL THIS AN ACCEPTED PRICE AT ALL? ───────────────────────
    // A red-team found EPS-2026-0152 live: status=accepted, accepted_price=1400,
    // current total=500, and ZERO quote_acceptances rows — with this screen
    // telling the customer "This is the price you accepted" over $1,400.
    //
    // ⛔ Status is not evidence and neither is accepted_price. The only thing
    // that can support that sentence is a quote_acceptances row, and
    // get_portal_data does not carry one — so the kind is `undefined` here and
    // the rule FAILS CLOSED: no consent claim, and the customer-facing figure is
    // the quote's CURRENT price.
    //
    // ⚠️ That deliberately gives up S121's consent snapshot for the moment,
    // because S121's protection and this one point opposite ways and only one of
    // them can be right without evidence in the payload. Showing a stale figure
    // AS AGREED is the worse failure: it is a false statement about what someone
    // consented to, where the other is merely a less useful true one. The
    // payload widening that restores the snapshot for evidenced quotes is
    // supabase/proposals/RUN-S122C-portal-acceptance-evidence.sql — until it is
    // applied, the evidenced states are unreachable and every accepted quote
    // reads current.
    //
    // ⭐⭐ THIS BLOCK RUNS FIRST, AND THAT ORDERING IS LOAD-BEARING. It used to
    // sit ~60 lines below, so `paymentTiming` — computed here — was handed the
    // RAW quote while only the deposit gate got the stripped one. The customer
    // saw a $250 deposit card above the sentence "A 50% deposit ($700.00) is
    // required before we schedule your visit": two figures, same screen, same
    // quote, same engine. Anything that reads money off this quote belongs
    // BELOW this point and takes `moneyQuote`.
    const presentation = acceptedPresentation(qq.status, qq.acceptance_kind as AcceptanceKind | null | undefined)
    // ⭐ ONE call, BOTH halves — the figure the customer is shown and the quote
    // every money reader is allowed to see. There is deliberately no way to ask
    // for one without the other (lib/quoteAcceptance).
    const facing = customerFacingQuote(presentation, qq)
    // ⛔ THE quote for every money engine and every money sentence below. Without
    // proven evidence, `accepted_price` is not a consent snapshot — it is a
    // number a past state believed — and `depositBasis` prefers it over `total`
    // whenever it is non-zero, so the only way to keep it out of a figure is to
    // hand the engine a quote that does not carry one. ⛔ Do not pass `qq` to a
    // deposit or timing call below; that is exactly the bug this closes.
    const moneyQuote = facing.moneyQuote
    const acceptedFigure = facing.isAcceptedAmount ? facing.amount : null
    const priceMovedSinceAccepted =
      acceptedFigure != null && Math.abs(acceptedFigure - (Number(qq.total) || 0)) > 0.005
    // ⭐ THE payment-timing interpretation of this quote — computed ONCE, read by
    // the explain list below, by `paymentTimingLine` on the row, and (through
    // that field) by every component that tells this customer when money is due.
    //
    // basisSettled: an options quote with no choice made has no settled price for
    // a PERCENT rule to be taken of, so the copy names the percentage and never a
    // dollar figure belonging to an option they may not pick. The moment a choice
    // exists — or acceptance snapshots accepted_price — the figure is real and
    // the same call prints it.
    const timing = paymentTiming(moneyQuote, { basisSettled: !(options && !qq.selected_option_id) })
    const manHours = Number(qq.hours) > 0 && Number(qq.crew_size) > 0 ? Number(qq.hours) * Number(qq.crew_size) : 0
    const fmtHrs = (h: number) => h < 1 ? `${Math.round(h * 60)} minutes` : h === 1 ? '1 hour' : `${Number(h.toFixed(1))} hours`
    const explainBits = [
      // The measured area, not "your lawn" — the same number explains a driveway
      // to a pressure washer's customer or a deck to a stainer's. It is THIS
      // quote's property's area, resolved through this quote's own property_id.
      // When the property is unknown (a legacy quote) the claim is DROPPED, not
      // defaulted: we can be silent about the area, but we cannot be wrong about
      // it while claiming to explain their price.
      qSqft > 0 ? `Priced for your measured ${qSqft.toLocaleString()} sq ft — measured, not guessed.` : null,
      manHours > 0
        ? `About ${fmtHrs(manHours)} of work${Number(qq.crew_size) > 1 ? `, with a crew of ${Number(qq.crew_size)}` : ''}.`
        : null,
      // "Includes a travel charge" is true of EVERY option (each row already has
      // it added), so the sentence holds either way — but on an options quote it
      // must not read as though it describes one bundled price.
      Number(qq.travel_fee) > 0
        ? (options
          ? `Every option includes the ${formatCurrency(Number(qq.travel_fee))} travel charge to reach your property.`
          : `Includes a ${formatCurrency(Number(qq.travel_fee))} travel charge to reach your property.`)
        : null,
      planOptionRows.length > 0 ? 'This price is for the visit above. If you want us back regularly, the ongoing rates are listed separately — you can pick one with us later.' : null,
      // ⭐ THE payment-timing sentence — derived, never asserted. This line used
      // to read "Nothing is charged when you approve — you'll get an invoice once
      // the work is done" on EVERY quote, and the approval dialog three files
      // away then asked a deposit-gated customer for half the job. It is the same
      // sentence for a plain quote and a truthful one for a gated quote, because
      // both now come out of paymentTiming.
      quoteTimingLine(timing),
    ].filter((s): s is string => !!s)
    // THE shared expiry engine — the same call the owner's screens make.
    const display = displayQuoteStatus({ status: qq.status as QuoteStatus, valid_until: qq.valid_until }, todayISO)
    // ⭐ `presentation` / `facing` / `moneyQuote` are derived ABOVE, before the
    // first money reader — see the block by that name. They used to be derived
    // here, and everything above them read the raw quote.
    const expired = display === 'expired'
    // ── The scheduling-deposit gate ──────────────────────────────────────────
    // THE engine's answer (lib/payments/depositGate — the same call the charge
    // route makes over the same rows), surfaced only once the quote is approved
    // or scheduled: before consent there is nothing to secure, and a declined
    // quote gates nothing. A quote with no rule carries no gate at all — it
    // renders exactly as it did before this feature existed.
    const gateActive = qq.status === 'accepted' || qq.status === 'scheduled'
    // ⛔ The deposit basis follows the SAME rule as the headline figure and the
    // timing sentence — literally the same object, so the three cannot disagree.
    const gate = gateActive ? schedulingGate(moneyQuote, depositRowsByQuote.get(qq.id)) : null
    const schedulingDeposit = gate && gate.required > 0 ? {
      required: gate.required, collected: gate.collected, outstanding: gate.outstanding,
      percent: gate.percent, satisfied: gate.status === 'satisfied',
    } : undefined
    // The preference travels on any live approved/scheduled quote (so a reload
    // shows it back); the FORM only opens while the RPC will still accept a
    // write — status exactly 'accepted'.
    const preference = gateActive ? {
      date: qq.preferred_date ?? null, date2: qq.preferred_date_2 ?? null,
      timing: qq.preferred_timing ?? null, note: qq.preferred_note ?? null,
    } : undefined
    return {
      id: 'q' + qq.id, rawId: qq.id, kind: 'quote' as const, number: qq.quote_number, title: qq.service_type || 'Quote',
      date: qq.issued_date || qq.created_at, status: display, expiredOn: expired ? qq.valid_until || undefined : undefined,
      validUntil: qq.valid_until,
      // ── ⭐⭐ WHAT AN ACCEPTED QUOTE IS WORTH, TO THE PERSON WHO ACCEPTED IT ──
      // (Session 121.) This read `total` for every quote, including accepted
      // ones — so an owner who raised the price after acceptance changed the
      // number on the customer's own screen, under a badge still reading
      // Accepted. The customer had no way to know the figure had moved, and no
      // way to tell which one they had agreed to.
      //
      // Once accepted, the figure shown is the CONSENT SNAPSHOT. `accepted_price`
      // is written only inside the database's acceptance window
      // (quote_apply_choice; nothing else may set it), so it IS the authorized
      // amount — no new payload field and no extra round trip.
      //
      // ⚠️ `?? total` is the LEGACY path, not a fallback for convenience: quotes
      // accepted before this feature existed may carry no snapshot, and for them
      // the current total is genuinely the best the record can offer.
      // Un-accepted quotes are untouched — `total` is the offer.
      amount: facing.amount,
      // ⭐ And when the two DISAGREE, say so rather than quietly showing the old
      // number beside new work. The customer is told a revision is coming; they
      // are never shown a price they have not agreed to as though they had.
      amountNote: [
        // ⛔⛔ "YOU accepted" is reachable ONLY from `evidenced_customer`. It is
        // the one claim on this screen about what the customer PERSONALLY did,
        // so it may never be made from a status flag — and never from an
        // owner's attestation either. An on-behalf acceptance is real evidence
        // of an agreed figure, and it gets its own sentence below saying so;
        // borrowing the customer's voice for it would undo the whole reason S121
        // keeps the kinds apart.
        priceMovedSinceAccepted && presentation === 'evidenced_customer'
          ? 'This is the price you accepted — we’ve made changes since and will send you an updated quote to look over.'
          : null,
        // Status says accepted, the record cannot show it. Named plainly rather
        // than left silent: the customer can see the badge, and an unexplained
        // "Accepted" they never remember agreeing to is its own small alarm.
        acceptedAmountNote(presentation),
        gstPct > 0 ? `+ GST (${gstPct}%) — added on your invoice` : null,
      ].filter(Boolean).join(' · ') || undefined,
      balance: 0,
      payAmount: 0, payIsDeposit: false,
      // ⛔ The PDF gets `moneyQuote`, not `qq`. The customer's own downloadable
      // copy runs the SAME paymentTiming reader (QuotePDF → pdfTimingLine) off
      // the SAME accepted_price, so handing it the raw quote would print the
      // $700 sentence onto the document they keep, under the $250 card they were
      // just shown. `accepted_price` feeds nothing else in that renderer.
      filename: `${qq.quote_number}.pdf`, getBlob: () => renderers.quote(moneyQuote), lines, planOptions,
      options, selectedOptionId: qq.selected_option_id ?? null,
      schedulingDeposit, preference, canEditPreference: qq.status === 'accepted',
      paymentTimingLine: quoteTimingLine(timing),
      // Gate-aware, so it can only exist where a gate does. `scheduled` is the
      // override case: the owner booked the visit anyway and the money is still
      // owed — telling that customer a deposit "secures your booking" would
      // describe a gate that was waived.
      depositTimingLine: gate && gate.required > 0
        ? approvedTimingLine(timing, gate, qq.status === 'scheduled')
        : undefined,
      // Identity, not decoration: the address tells a landlord which of their six
      // quotes this is. It never becomes the row's title — service_type is the
      // real disambiguator for same-property customers.
      propertyId: qq.property_id ?? null, address: resolveDocAddress(propsById, qq.property_id, qq.address),
      // Don't justify a price that no longer stands.
      explain: !expired && explainBits.length > 1 ? explainBits : undefined,
    }
  })

  // A DRAFT invoice is the owner's unfinished work — private until sent.
  // ⚠️ This filter is DEFENCE IN DEPTH, not the privacy boundary. It used to be the
  // only thing standing between a customer and the owner's unsent bill: the RPC
  // returned every invoice and this line merely declined to render the draft, which
  // left it fully readable in the payload (devtools). The boundary now lives in
  // get_portal_data — `and status <> 'draft'`, the same predicate it already applied
  // to quotes — so a draft never leaves the database
  // (RUN-2026-08-09-portal-hide-draft-invoices.sql, pinned by verify:portal-rpc).
  // Keep this line anyway: it costs nothing and a payload is not ours to trust.
  const inv: DocItem[] = invoices.filter(ii => ii.status !== 'draft').map(ii => {
    // THE dashboard's balance engine, not a copy of it: discounted+GST total −
    // payments recorded. Clamped at 0 for display — an overpaid invoice owes
    // nothing, and the credit is the ledger's story (PaymentsTab tells it).
    const { total, balance: signed } = invoiceBalance(forBalance(ii), { gst_percent: gstPct })
    const balance = Math.max(0, signed)
    // 'overdue' is a DISPLAY overlay derived from due_date — never stored —
    // exactly the shape quoteStatus uses for expiry. The portal must tell the
    // customer they're late before a chasing text does.
    const overdue = balance > 0 && !!ii.due_date && ii.due_date < todayISO && ii.status !== 'cancelled'
    // The mirror of `overdue`, and it exists for the same reason: what a customer is
    // told about a bill must follow the LEDGER, not a status column that can fall
    // behind it. Production holds exactly one such row today — INV-0060, stored
    // 'unpaid' with $100.00 of $100.00 received — and the portal spoke about it with
    // two voices: the money strip and the amount-due banner (both balance-derived)
    // correctly showed nothing owed, while this row's pill said "Due" and the Home
    // activity feed said "$100.00 · Due". A customer's own record of a bill they had
    // settled told them they still owed it.
    // Display only: `ii.status` is never written, `balance` is never recomputed, and
    // because the overlay requires balance <= 0 it cannot collide with `overdue`
    // (which requires > 0). 'cancelled' keeps its own word — a withdrawn charge must
    // stay explainable — and 'overpaid' is more specific than 'paid', so both stand.
    const settled = balance <= 0 && ii.status !== 'cancelled' && ii.status !== 'overpaid'
    // The deposit picture + what Pay collects now — BOTH straight from the
    // engine /api/portal/pay answers to. The row quoting one figure while
    // Stripe charges another is the disagreement this exists to prevent, so
    // nothing here recomputes: an edited-down invoice's clamp, the covered-by-
    // e-transfer case, the part-paid cap all arrive already decided. A request
    // saved but not yet SENT still shows (the charge rule already honours it —
    // hiding it would recreate the mismatch). Cancelled invoices ask for
    // nothing regardless of any leftover request.
    const cancelled = ii.status === 'cancelled'
    const dep = cancelled ? null : depositState(forDeposit(ii), { gst_percent: gstPct })
    const charge = cancelled ? null : depositChargeAmount(forDeposit(ii), { gst_percent: gstPct })
    return {
      id: 'i' + ii.id, rawId: ii.id, kind: 'invoice' as const, number: ii.invoice_number, title: ii.service_type || 'Invoice',
      date: ii.issued_date || ii.created_at, status: overdue ? 'overdue' : settled ? 'paid' : ii.status, dueDate: ii.due_date, amount: total, balance,
      payAmount: charge?.amount ?? 0, payIsDeposit: charge?.isDeposit ?? false,
      deposit: dep && dep.status !== 'none' ? {
        requested: dep.requested ?? 0, percent: dep.percent, outstanding: dep.outstanding,
        remainingAfter: dep.remainingAfter, covered: dep.status === 'paid',
      } : undefined,
      // An invoice's headline is its total (GST already in it) — no note. The
      // partial-payment breakdown ("still due / paid") is derived on demand by
      // invoicePaymentNote so the amount OWED, not just the total, is legible.
      amountNote: undefined,
      filename: `${ii.invoice_number}.pdf`, getBlob: () => { onInvoiceOpen?.(ii.id); return renderers.invoice(ii) },
      // Same resolver as quotes. An invoice that spans several properties answers
      // null on purpose — it lands in the neutral bucket rather than being filed
      // under whichever address happened to be copied onto it.
      propertyId: ii.property_id ?? null, address: resolveDocAddress(propsById, ii.property_id, ii.address),
    }
  })
  return [...q, ...inv]
}

// For a partially-paid invoice, the breakdown a customer actually needs: what's
// still OWED (the actionable number the row can raise its voice for) and what's
// already been paid (their money, accounted for). Null for anything else — a
// full bill's total is its own answer, and a settled or overpaid one has
// nothing outstanding. Works for every payment method, including e-transfer and
// cash where there's no Pay button to read the amount off. Pure, so verify pins
// that "still due" is the remaining balance — never the total.
export function invoicePaymentNote(d: DocItem): { due: string; paid: string } | null {
  if (d.kind !== 'invoice' || !(d.balance > 0) || !(d.balance < d.amount)) return null
  return { due: formatCurrency(d.balance), paid: formatCurrency(d.amount - d.balance) }
}

// The deposit ask, in the customer's terms — the four numbers the message
// promised the portal would show: what's asked NOW, what it's a share of, and
// what will remain after. Only while the deposit is genuinely what the Pay
// button collects (payIsDeposit — the engine's verdict, so an edited-down
// invoice's clamped ask shows the CLAMPED figure); afterwards the ordinary
// partial-payment note carries the story. Formatted here so verify can pin
// that "due now" is the deposit and never the total. Pure.
export function invoiceDepositNote(
  d: DocItem,
): { dueNow: string; percentLabel: string; ofTotal: string; after: string; paidSoFar: string | null } | null {
  if (d.kind !== 'invoice' || !d.payIsDeposit || !(d.payAmount > 0) || !d.deposit) return null
  // The percent may only describe money the button actually collects. It is
  // derived from the STORED request, so the moment the ask diverges from it —
  // clamped because the invoice was edited down (the engine's exceedsTotal
  // case, where the raw figure reads "133.3% deposit"), or shrunk because a
  // part-payment already covered some — the number would be a claim about a
  // different amount than the headline. Divergence drops to the plain word.
  const askIsRequested = Math.abs(d.payAmount - d.deposit.requested) <= 0.005
  return {
    dueNow: formatCurrency(d.payAmount),
    percentLabel: askIsRequested && d.deposit.percent != null ? `${d.deposit.percent}% deposit` : 'Deposit',
    ofTotal: formatCurrency(d.amount),
    // After THIS payment lands: what's genuinely left on the bill. Derived from
    // the row's own balance minus what the button collects — not remainingAfter,
    // which describes the requested deposit even when the clamp shrank the ask.
    after: formatCurrency(Math.max(0, Math.round((d.balance - d.payAmount) * 100) / 100)),
    // Money already received stays visible — the deposit headline replaces the
    // ordinary still-due/paid note, so without this line a $500 e-transfer
    // would simply vanish from the row that asks for the rest.
    paidSoFar: d.balance < d.amount ? formatCurrency(Math.round((d.amount - d.balance) * 100) / 100) : null,
  }
}

// "Deposit paid" — said ONLY once the engine says the request is covered and
// money is still owed on the rest of the bill. The moment the customer returns
// from Stripe and the webhook's payment row lands, the refetched payload flips
// this on: their receipt line ("Deposit paid: $2,000") plus the honest
// remainder ("Remaining balance: $2,000") — the exact two numbers they need to
// trust the thing worked.
export function invoiceDepositPaidNote(d: DocItem): { paid: string; remaining: string } | null {
  if (d.kind !== 'invoice' || !d.deposit?.covered || !(d.balance > 0)) return null
  // `paid` is what has ACTUALLY been received (total − balance), not the
  // requested figure — the two agree in the ordinary case, but a customer who
  // sent more than the ask must see their real money, or the extra silently
  // vanishes from the one row accounting for it.
  return { paid: formatCurrency(Math.round((d.amount - d.balance) * 100) / 100), remaining: formatCurrency(d.balance) }
}

// Below this many documents, a search box and a sort toggle are furniture: you can
// see everything at once, so the controls only add things to read and decide about.
// Measured on the live book — 46 customers with a portal, 2.2 documents on average,
// and 45 of them hold five or fewer. A homeowner accumulates a handful of quotes and
// invoices in a lifetime with a lawn company, not a filing cabinet.
export const DOC_FILTER_MIN = 6

/** Is this list long enough that finding tools earn their space? */
export function showDocFilters(docCount: number): boolean {
  return docCount >= DOC_FILTER_MIN
}

// ── Progress (the journey rail) ─────────────────────────────────────────────
// The quote's stored status ALREADY walks the whole journey — the owner-side
// sync triggers advance it (accepted → scheduled → completed → paid) — so the
// rail is a direct DISPLAY of existing state, never a second lifecycle engine.
// Declined and expired quotes get no rail: a rail promises forward motion, and
// those rows aren't moving — their pill carries the state instead.

export interface JourneyStep { key: string; label: string; done: boolean; current: boolean }

const JOURNEY: { key: string; label: string }[] = [
  { key: 'sent', label: 'Sent' },
  { key: 'accepted', label: 'Approved' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'completed', label: 'Done' },
  { key: 'paid', label: 'Paid' },
]

export function quoteJourney(displayStatus: string): JourneyStep[] | null {
  const idx = JOURNEY.findIndex(s => s.key === displayStatus)
  if (idx < 0) return null // declined / expired / unknown → no rail
  return JOURNEY.map((s, i) => ({ key: s.key, label: s.label, done: i < idx, current: i === idx }))
}

// ── Money summary (Billing's headline strip) ────────────────────────────────
// Sums the SAME per-invoice figures the rows show (invoiceTotals + amount_paid)
// — never sum(payments.amount), which the accounting rules forbid (refunds and
// credits live there too). "paid" is capped per-invoice at its total so an
// overpayment doesn't inflate the lifetime figure; the credit is the ledger's
// story and PaymentsTab already tells it.
export interface MoneySummary { invoiced: number; paid: number; due: number; owingCount: number }

export function moneySummary(invoices: PortalInvoice[], business: PortalData['business']): MoneySummary {
  const gstPct = Number(business?.gst_percent) || 0
  let invoiced = 0, paid = 0, due = 0, owingCount = 0
  for (const i of invoices) {
    if (i.status === 'draft' || i.status === 'cancelled') continue
    const t = invoiceBalance(forBalance(i), { gst_percent: gstPct })
    const total = t.total
    const amtPaid = Math.min(t.paid, total)
    const balance = Math.max(0, t.balance)
    invoiced += total
    paid += amtPaid
    due += balance
    if (balance > 0) owingCount += 1
  }
  const r = (n: number) => Math.round(n * 100) / 100
  return { invoiced: r(invoiced), paid: r(paid), due: r(due), owingCount }
}

// ── Recent payments (what replaced Home's "Recent activity" feed) ───────────
// Home used to carry a five-row chronological feed of everything that had ever
// happened. Rendered against six live portals it was, in four of them, 100%
// records that Billing already owns — and worse, DOUBLE-ENTRY: a settled invoice
// emitted BOTH "Invoice INV-0062 issued · $55.00 · Paid" AND "Payment received ·
// E-transfer · $55.00", so one $55 transaction spent two of the five rows saying
// the same thing twice. The cap was routinely filled by two or three
// transactions.
//
// It could never have been otherwise: everything ACTIONABLE is deliberately
// suppressed from it (awaiting quotes and the currently-due invoice belong to the
// attention cards, future visits to the hero), so by construction the feed could
// only ever hold settled history — while Home's job is "is there anything I need
// to do, and has anything important changed".
//
// ⭐ ONE class of row survived that test: money moving. 33 of 58 live portals have
// payments and most are e-transfer or cash, which the OWNER records hours or days
// later — and the post-checkout confirmation banner only ever fires on the Stripe
// return (`?paid=1`). So for those customers Home had no positive way to say "your
// money arrived"; the only signal was the amount-due banner being absent, and an
// absence is not a confirmation. Refunds and credit movements are the same story
// pointing the other way, and a customer must not have to go looking for those.
//
// So: money movements only, recent only, capped, and ABSENT when nothing has
// moved. Classification is `ledgerRowType` — the ONE ledger classifier, never the
// sign of the amount (a $200 refund and a $200 overpayment moved to credit are
// both negative, and only the first is money leaving). `kind === 'credit'` rows
// stay excluded exactly as before: that is the credit LEDGER, whose story is
// Billing's "Available credit" tile, and counting it here would state the same
// money twice — the very thing this replacement exists to stop.
export const RECENT_PAYMENT_DAYS = 30
export const RECENT_PAYMENT_MAX = 3

export interface RecentPayment { id: string; at: string; amount: number; label: string; isRefund: boolean }

export function recentPayments(
  payments: PortalPayment[] | null | undefined,
  todayISO: string,
  opts?: { days?: number; max?: number },
): RecentPayment[] {
  const days = opts?.days ?? RECENT_PAYMENT_DAYS
  const max = opts?.max ?? RECENT_PAYMENT_MAX
  const today = parseLocalDate(todayISO)
  if (!today || !payments) return []
  const cutoff = new Date(today.getTime() - days * 86400000)
  const out: RecentPayment[] = []
  for (const p of payments) {
    if (p.kind === 'credit') continue
    const at = p.paid_at || p.created_at
    if (!at) continue
    // Compared as an instant, so a `paid_at` timestamp and a date-only
    // `created_at` are judged the same way. A row dated in the FUTURE is still
    // "recent" — it has certainly not fallen out of the window.
    const when = new Date(at)
    if (isNaN(when.getTime()) || when < cutoff) continue
    const rt = ledgerRowType(p)
    out.push({
      id: p.id,
      at,
      // Always the magnitude: the label carries the direction, so a refund reads
      // "Refund issued · $50.00" rather than a minus sign the eye can miss.
      amount: Math.abs(Number(p.amount) || 0),
      label: rt === 'Refund' ? 'Refund issued'
        : rt === 'Overpayment to credit' ? 'Overpayment moved to credit'
        : rt === 'Settled from credit' ? 'Settled from account credit'
        : `Payment received · ${paymentMethodLabel(p.provider)}`,
      isRefund: rt === 'Refund',
    })
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, max)
}

// How the customer paid, in their words. Lived in HomeTab and PaymentsSection as
// two identical copies; it belongs with the rows it labels.
export function paymentMethodLabel(provider: string | null | undefined): string {
  switch (provider) {
    case 'stripe': return 'Card'
    case 'etransfer': return 'E-transfer'
    case 'cash': return 'Cash'
    default: return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'Payment'
  }
}

// Real cash refunded to the customer across these rows — a NEGATIVE cash movement
// the ledger classifies as a refund, NOT an overpayment moved to their credit
// balance (that money is shown ONCE, as Available credit). Typing a refund by the
// SIGN of the amount — which the PaymentsTab total and the Home timeline both did —
// counts the provider='credit' overpayment leg as a refund, so a single $50
// overpayment reads as BOTH "$50 refunded" and "$50 available credit". cashAmountOf
// (via isCashRow) returns 0 for the credit leg, so this sums only real cash out —
// the same rows summarizeTransactions().refunded counts.
export function refundedTotal(payments: PortalPayment[]): number {
  const out = payments.reduce((s, p) => s + Math.min(0, cashAmountOf(p)), 0)
  return Math.abs(Math.round(out * 100) / 100)
}

// ── The one thing that needs the customer (a cross-tab convenience) ──────────
// Surfaced from any tab so someone deep in Photos or Messages doesn't have to
// go hunting in Billing for the bill they owe or the quote waiting on them.
// Priority is honest and time-ordered: an OVERDUE bill first, then a balance
// merely due, then a quote awaiting their decision. Returns null when nothing
// needs them — the banner just doesn't render. `focusDocId` is set only when a
// single row is the target, so one tap lands ON it (reusing the deep-link
// scroll); with several it lands on the filtered list. `key` is a stable
// identity so a dismissal sticks until the situation actually changes.
export interface PortalNextAction {
  key: string
  kind: 'pay' | 'approve' | 'pay-deposit' | 'approve-change'
  headline: string
  docsCat: 'invoice' | 'quote'
  focusDocId: string | null
}

export function primaryPortalAction(
  docItems: DocItem[], money: MoneySummary, pendingChanges: PortalChangeOrder[] = [],
): PortalNextAction | null {
  const owing = docItems.filter(d => d.kind === 'invoice' && d.balance > 0 && d.status !== 'cancelled' && d.status !== 'draft')
  const oneOwing = owing.length === 1 ? owing[0].rawId : null
  // When the ONE owing bill's ask is a deposit, the banner names the deposit —
  // "Past due: $4,000" over a $2,000 upfront ask tells the customer the whole
  // job is late and owed, which is neither. payIsDeposit is the engine's verdict
  // (the same call the Pay button and the charge route make), so the headline
  // figure is exactly what tapping through will collect. Several owing bills
  // fall back to the honest sum — a single number can't speak for mixed asks.
  if (owing.length === 1 && owing[0].payIsDeposit && owing[0].payAmount > 0) {
    const d = owing[0]
    return { key: `deposit:${d.payAmount}:${d.rawId}`, kind: 'pay', headline: `Deposit due: ${formatCurrency(d.payAmount)}`, docsCat: 'invoice', focusDocId: d.rawId }
  }
  if (owing.some(d => d.status === 'overdue')) {
    return { key: `overdue:${money.due}:${owing.length}`, kind: 'pay', headline: `Past due: ${formatCurrency(money.due)}`, docsCat: 'invoice', focusDocId: oneOwing }
  }
  // An approved quote whose SCHEDULING DEPOSIT is still owed — the one thing
  // standing between the customer and a confirmed booking, so it outranks an
  // ordinary balance (which has its own due date) and sits only behind overdue.
  // The figure is the gate's `outstanding` (the same number the charge route
  // will ask for), so a partial payment shrinks the headline honestly.
  const depositDue = docItems.find(d => d.kind === 'quote' && d.schedulingDeposit && !d.schedulingDeposit.satisfied && d.schedulingDeposit.outstanding > 0)
  if (depositDue?.schedulingDeposit) {
    return {
      key: `qdeposit:${depositDue.schedulingDeposit.outstanding}:${depositDue.rawId}`, kind: 'pay-deposit',
      headline: `Pay ${formatCurrency(depositDue.schedulingDeposit.outstanding)} deposit to secure scheduling`,
      docsCat: 'quote', focusDocId: depositDue.rawId,
    }
  }
  if (money.due > 0 && owing.length > 0) {
    return { key: `due:${money.due}:${owing.length}`, kind: 'pay', headline: `Balance due: ${formatCurrency(money.due)}`, docsCat: 'invoice', focusDocId: oneOwing }
  }
  // A change awaiting an answer outranks a quote awaiting one: the work it
  // belongs to is already underway or booked, so somebody is usually waiting on
  // this decision today. It sits BELOW the money asks for the same reason the
  // rest of this ladder does — an unpaid bill has a date attached, this doesn't.
  if (pendingChanges.length > 0) {
    const total = pendingChanges.reduce((s, c) => s + (Number(c.amount) || 0), 0)
    return {
      key: `change:${pendingChanges.length}:${total}`, kind: 'approve-change',
      headline: pendingChanges.length === 1
        ? `Extra work needs your approval: ${formatCurrency(total)}`
        : `${pendingChanges.length} changes need your approval: ${formatCurrency(total)}`,
      docsCat: 'quote', focusDocId: null,
    }
  }
  const quotes = docItems.filter(d => d.kind === 'quote' && d.status === 'sent')
  if (quotes.length > 0) {
    return {
      key: `quote:${quotes.length}`, kind: 'approve',
      headline: quotes.length === 1 ? 'A quote is waiting for your approval' : `${quotes.length} quotes are waiting for you`,
      docsCat: 'quote', focusDocId: quotes.length === 1 ? quotes[0].rawId : null,
    }
  }
  return null
}

// The invoice number a customer should put in their e-transfer memo so the
// business can match the payment — returned ONLY when there is exactly one
// owing invoice, so the "copy" affordance never hands them an ambiguous or
// wrong reference (a mistyped/absent memo is the #1 reason an e-transfer can't
// be reconciled). With several owing, the customer pays one at a time and the
// UI keeps its plain guidance; with none, there's nothing to reference.
export function etransferReference(docItems: DocItem[]): string | null {
  const owing = docItems.filter(d => d.kind === 'invoice' && d.balance > 0 && d.status !== 'cancelled')
  return owing.length === 1 ? owing[0].number : null
}

// ── Per-property view (the "every property" surface) ────────────────────────
// Grouping rule (from the property-identity work): a single-property customer
// sees ONE unified story — splitting their history over property_id nulls would
// manufacture confusion. Multi-property customers get strict buckets: a row
// names its own property or it lands in the neutral bucket; the primary is
// never "close enough".

export interface PropertyModel {
  key: string // property id, or NO_PROPERTY
  property: PortalProperty | null
  plans: Derived['plans']
  upcoming: PortalJob[]
  completed: PortalJob[]
  photoCount: number
  quoteCount: number
  invoiceCount: number
  lastVisitDay: string | null
}

// A plan's property comes through its visits — job_recurrences deliberately has
// no property_id (customer-v2 rule: plans derive through jobs).
export function planPropertyId(plan: { recurrenceId: string }, jobs: PortalJob[]): string | null {
  return jobs.find(j => j.recurrence_id === plan.recurrenceId && j.property_id)?.property_id ?? null
}

export function buildPropertyModels(data: PortalData, derived: Derived, photosByJob: Map<string, PortalPhoto[]>): PropertyModel[] {
  const properties = data.properties ?? []
  const jobs = data.jobs || []

  const modelFor = (key: string, property: PortalProperty | null, member: (propertyId: string | null) => boolean): PropertyModel => {
    const upcoming = derived.upcoming.filter(j => member(j.property_id))
    const completed = derived.completed.filter(j => member(j.property_id))
    const photoCount = completed.concat(upcoming).reduce((n, j) => n + (photosByJob.get(j.id)?.length ?? 0), 0)
    return {
      key, property,
      plans: derived.plans.filter(p => member(planPropertyId(p, jobs))),
      upcoming, completed, photoCount,
      quoteCount: data.quotes.filter(q => member(q.property_id ?? null)).length,
      invoiceCount: data.invoices.filter(i => i.status !== 'draft' && member(i.property_id ?? null)).length,
      lastVisitDay: completed[0] ? visitDay(completed[0]) : null,
    }
  }

  if (properties.length <= 1) {
    return [modelFor(properties[0]?.id ?? NO_PROPERTY, properties[0] ?? null, () => true)]
  }
  const models = properties.map(p => modelFor(p.id, p, id => id === p.id))
  const orphan = modelFor(NO_PROPERTY, null, id => !id || !properties.some(p => p.id === id))
  if (orphan.upcoming.length || orphan.completed.length || orphan.plans.length || orphan.quoteCount || orphan.invoiceCount) {
    models.push(orphan)
  }
  return models
}

// ── Trust facts ─────────────────────────────────────────────────────────────
// "Customer since" — the year of the earliest thing we can prove: a visit, a
// quote or an invoice. Null when there's nothing yet (a brand-new prospect);
// never invented from the token's mint date, which the customer never saw.
export function customerSinceYear(data: PortalData): string | null {
  const dates: string[] = [
    ...data.jobs.map(j => j.scheduled_date),
    ...data.quotes.map(q => (q.issued_date || q.created_at || '').slice(0, 10)),
    ...data.invoices.map(i => (i.issued_date || i.created_at || '').slice(0, 10)),
  ].filter(Boolean)
  if (dates.length === 0) return null
  return dates.sort()[0].slice(0, 4)
}

// The owner's catalogue as the request presets (names only, owner's order, capped).
export function requestPresetsOf(data: PortalData): string[] {
  return (data.services ?? [])
    .map(s => s.name?.trim())
    .filter((n): n is string => !!n)
    .slice(0, MAX_REQUEST_PRESETS)
}

// ── The assembled view every tab receives ───────────────────────────────────
// ONE object, built once per data change in PortalClient — so six parallel tab
// files cannot disagree about what a fact means or recompute it differently.

export interface PortalView {
  data: PortalData
  derived: Derived
  todayISO: string
  firstName: string
  photosByJob: Map<string, PortalPhoto[]>
  invoiceByJob: Map<string, PortalInvoice>
  propsById: Map<string, PortalProperty>
  properties: PortalProperty[]
  multiProperty: boolean
  hasProperty: boolean
  docItems: DocItem[]
  money: MoneySummary
  propertyModels: PropertyModel[]
  customerSince: string | null
  requestPresets: string[]
  // Photos not shown inside a completed-visit card (loose + not-yet-completed jobs).
  orphanPhotos: PortalPhoto[]
  /** Per-visit change picture (original / approved / authorized + the open asks). */
  changesByJob: Map<string, VisitChanges>
  /** Every change awaiting THIS customer's answer, oldest first. Home leads with it. */
  pendingChanges: PortalChangeOrder[]
}

export function buildPortalView(data: PortalData, todayISO: string, renderers: DocBlobRenderers, onInvoiceOpen?: (id: string) => void): PortalView {
  const derived = buildDerived(data, todayISO)
  const properties = data.properties ?? []
  const photosByJob = groupPhotos(data.photos)
  const completedJobIds = new Set(derived.completed.map(j => j.id))
  const hasProperty = !!(data.property && (data.property.address || data.property.lawn_sqft || data.property.fence_length || data.property.neighborhood)) || properties.length > 0
  // The originally-approved value of a visit, from the SAME engine buildDerived's
  // plans use — jobVisitValue over the visit's own price and its quote's cadence.
  // Never the quote total: a weekly plan's original for THIS visit is one visit.
  const quoteById = new Map((data.quotes || []).map(q => [q.id, q]))
  const changesByJob = buildVisitChanges(data, (j: PortalJob) => {
    const q = j.quote_id ? quoteById.get(j.quote_id) : null
    const freq = (data.recurrences || []).find(r => r.id === j.recurrence_id)?.freq ?? null
    return jobVisitValue(j.price, q as unknown as Record<string, unknown>, freq, j.is_initial_visit ?? undefined)
  })
  const pendingChanges = [...changesByJob.values()].flatMap(v => v.pending)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
  return {
    data, derived, todayISO,
    firstName: (data.customer?.name || '').trim().split(' ')[0] || 'there',
    photosByJob,
    invoiceByJob: new Map((data.invoices || []).filter(i => i.job_id).map(i => [i.job_id as string, i])),
    propsById: new Map(properties.map(p => [p.id, p])),
    properties,
    multiProperty: properties.length > 1,
    hasProperty,
    docItems: buildDocItems({ quotes: data.quotes, invoices: data.invoices, properties, business: data.business, todayISO, renderers, onInvoiceOpen, payments: data.payments }),
    money: moneySummary(data.invoices, data.business),
    propertyModels: buildPropertyModels(data, derived, photosByJob),
    customerSince: customerSinceYear(data),
    requestPresets: requestPresetsOf(data),
    orphanPhotos: orphanPhotos(data.photos, completedJobIds),
    changesByJob,
    pendingChanges,
  }
}
