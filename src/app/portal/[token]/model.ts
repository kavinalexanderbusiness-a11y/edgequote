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
import { invoiceTotals } from '@/lib/invoiceTotals'
import { serviceLineTotals } from '@/lib/quoteServices'
import { displayQuoteStatus } from '@/lib/quoteStatus'
import { formatCurrency, parseLocalDate } from '@/lib/utils'
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
export interface PortalQuote { id: string; quote_number: string; service_type: string; address: string; property_id?: string | null; total: number; initial_price: number | null; subtotal: number | null; weekly_price: number | null; biweekly_price: number | null; monthly_price: number | null; notes: string | null; status: string; created_at: string; issued_date: string | null; valid_until: string | null; crew_size: number | null; hours: number | null; travel_fee: number | null; services?: PortalQuoteService[] | null }
// `property_id` null is the HONEST answer for an invoice spanning several properties —
// never infer one, or a combined invoice prints one address as if it were the whole bill.
export interface PortalInvoice { id: string; invoice_number: string; service_type: string | null; amount: number; status: string; issued_date: string | null; due_date: string | null; notes: string | null; address: string | null; property_id?: string | null; line_items: { description: string; amount: number; kind: string }[] | null; job_id: string | null; created_at: string; discount_type?: 'amount' | 'percent' | null; discount_value?: number | null; amount_paid?: number | null }
export interface PortalJob { id: string; recurrence_id: string | null; property_id: string | null; quote_id: string | null; price: number | null; is_initial_visit: boolean | null; service_type: string | null; title: string; scheduled_date: string; status: string; on_my_way_at: string | null; started_at: string | null; completed_at: string | null; notes: string | null }
export interface PortalRec { id: string; freq: string | null; interval_unit: string | null; interval_count: number | null; start_date: string | null; end_date: string | null; end_count: number | null }
export interface PortalPhoto { id: string; job_id: string | null; storage_path: string; kind: string; caption: string | null; taken_at: string }
export interface PortalPayment { id: string; amount: number; status: string; paid_at: string | null; provider: string; invoice_id: string | null; created_at: string; kind?: string }
export interface PortalCard { brand: string | null; last4: string | null; exp_month: number | null; exp_year: number | null }
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
  payment_method?: PortalCard | null
  services?: PortalService[] | null
}

export type TabKey = 'home' | 'property' | 'visits' | 'billing' | 'messages' | 'requests'
export type LiveStatus = 'scheduled' | 'on_my_way' | 'in_progress' | 'completed'
export type DocKind = 'quote' | 'invoice'

// Every customer action is a REQUEST that threads into the owner's ONE Messages
// hub (service_requests → sr_to_conversation) — nothing in the portal mutates
// jobs or plans directly. The message string is what the owner reads; the
// structured fields exist so their side can grow one-tap actions later.
export type SubmitRequestFn = (opts: {
  message: string; kind: 'service' | 'appointment' | 'reschedule' | 'plan_change'
  preferredDate?: string | null; jobId?: string | null; recurrenceId?: string | null
  details?: Record<string, unknown> | null
}) => Promise<boolean>

// What a customer can request comes from the owner's OWN catalogue — never a
// hardcoded list. Capped so the tab stays a decision, not a catalogue dump; the
// free-text "Something else?" ask covers the rest and always works.
export const MAX_REQUEST_PRESETS = 8

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
  const outstanding = (data.invoices || []).filter(i => i.status !== 'draft' && i.status !== 'cancelled').reduce((s, i) => {
    const total = invoiceTotals(i.amount, { gst_percent: gstPct }, { type: i.discount_type, value: i.discount_value }).total
    return s + Math.max(0, Math.round((total - (Number(i.amount_paid) || 0)) * 100) / 100)
  }, 0)
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

// ── Documents (quotes + invoices as one records list) ───────────────────────
// `amountNote` qualifies the headline figure: invoice amounts include GST, quote
// totals don't — the row a customer approves from must say so, or the first bill
// looks like a bait-and-switch. `explain` answers "why does this cost this?" in
// the customer's own terms — only facts about THEIR property and THEIR job,
// never the owner's rate, margin, floor or win-rate. `status` on a quote is the
// DISPLAY status (lib/quoteStatus): an expired quote arrives as 'expired', which
// is what removes the Accept button (canAccept tests 'sent') with no second
// expiry check anywhere in the render path to forget or contradict.
export interface DocItem { id: string; rawId: string; kind: DocKind; number: string; title: string; date: string; status: string; expiredOn?: string; validUntil?: string | null; dueDate?: string | null; amount: number; amountNote?: string; balance: number; filename: string; getBlob: () => Promise<Blob>; lines?: { label: string; amount: number }[]; explain?: string[]; propertyId?: string | null; address?: string | null }

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
}): DocItem[] {
  const { quotes, invoices, properties, business, todayISO, renderers, onInvoiceOpen } = opts
  const gstPct = Number(business?.gst_percent) || 0
  const propsById = new Map(properties.map(p => [p.id, p]))

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
    const planLines = [
      Number(qq.weekly_price) > 0 ? { label: 'Weekly plan (per visit)', amount: Number(qq.weekly_price) } : null,
      Number(qq.biweekly_price) > 0 ? { label: 'Bi-weekly plan (per visit)', amount: Number(qq.biweekly_price) } : null,
      Number(qq.monthly_price) > 0 ? { label: 'Monthly plan (per visit)', amount: Number(qq.monthly_price) } : null,
    ].filter((l): l is { label: string; amount: number } => l !== null)
    const allLines = [...svcLines, ...planLines]
    const lines = allLines.length > 0 ? allLines : undefined
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
      Number(qq.travel_fee) > 0 ? `Includes a ${formatCurrency(Number(qq.travel_fee))} travel charge to reach your property.` : null,
      planLines.length > 0 ? 'Your first visit is priced above; ongoing visits are charged at the plan rate shown.' : null,
      'Nothing is charged when you approve — you’ll get an invoice once the work is done.',
    ].filter((s): s is string => !!s)
    // THE shared expiry engine — the same call the owner's screens make.
    const display = displayQuoteStatus({ status: qq.status as QuoteStatus, valid_until: qq.valid_until }, todayISO)
    const expired = display === 'expired'
    return {
      id: 'q' + qq.id, rawId: qq.id, kind: 'quote' as const, number: qq.quote_number, title: qq.service_type || 'Quote',
      date: qq.issued_date || qq.created_at, status: display, expiredOn: expired ? qq.valid_until || undefined : undefined,
      validUntil: qq.valid_until,
      amount: Number(qq.total) || 0,
      amountNote: gstPct > 0 ? `+ GST (${gstPct}%) — added on your invoice` : undefined, balance: 0,
      filename: `${qq.quote_number}.pdf`, getBlob: () => renderers.quote(qq), lines,
      // Identity, not decoration: the address tells a landlord which of their six
      // quotes this is. It never becomes the row's title — service_type is the
      // real disambiguator for same-property customers.
      propertyId: qq.property_id ?? null, address: resolveDocAddress(propsById, qq.property_id, qq.address),
      // Don't justify a price that no longer stands.
      explain: !expired && explainBits.length > 1 ? explainBits : undefined,
    }
  })

  // A DRAFT invoice is the owner's unfinished work — private until sent, the
  // precedent quotes set (get_portal_data filters draft quotes server-side).
  const inv: DocItem[] = invoices.filter(ii => ii.status !== 'draft').map(ii => {
    // Same balance math as the dashboard: discounted+GST total − payments recorded.
    const total = invoiceTotals(ii.amount, { gst_percent: gstPct }, { type: ii.discount_type, value: ii.discount_value }).total
    const balance = Math.max(0, Math.round((total - (Number(ii.amount_paid) || 0)) * 100) / 100)
    // 'overdue' is a DISPLAY overlay derived from due_date — never stored —
    // exactly the shape quoteStatus uses for expiry. The portal must tell the
    // customer they're late before a chasing text does.
    const overdue = balance > 0 && !!ii.due_date && ii.due_date < todayISO && ii.status !== 'cancelled'
    return {
      id: 'i' + ii.id, rawId: ii.id, kind: 'invoice' as const, number: ii.invoice_number, title: ii.service_type || 'Invoice',
      date: ii.issued_date || ii.created_at, status: overdue ? 'overdue' : ii.status, dueDate: ii.due_date, amount: total, balance,
      // A partial payment is the customer's own money already on this bill —
      // not showing it made the row look like they'd paid nothing.
      amountNote: Number(ii.amount_paid) > 0 && balance > 0 ? `${formatCurrency(Number(ii.amount_paid))} already paid` : undefined,
      filename: `${ii.invoice_number}.pdf`, getBlob: () => { onInvoiceOpen?.(ii.id); return renderers.invoice(ii) },
      // Same resolver as quotes. An invoice that spans several properties answers
      // null on purpose — it lands in the neutral bucket rather than being filed
      // under whichever address happened to be copied onto it.
      propertyId: ii.property_id ?? null, address: resolveDocAddress(propsById, ii.property_id, ii.address),
    }
  })
  return [...q, ...inv]
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
    const total = invoiceTotals(i.amount, { gst_percent: gstPct }, { type: i.discount_type, value: i.discount_value }).total
    const amtPaid = Math.min(Number(i.amount_paid) || 0, total)
    const balance = Math.max(0, Math.round((total - (Number(i.amount_paid) || 0)) * 100) / 100)
    invoiced += total
    paid += amtPaid
    due += balance
    if (balance > 0) owingCount += 1
  }
  const r = (n: number) => Math.round(n * 100) / 100
  return { invoiced: r(invoiced), paid: r(paid), due: r(due), owingCount }
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
}

export function buildPortalView(data: PortalData, todayISO: string, renderers: DocBlobRenderers, onInvoiceOpen?: (id: string) => void): PortalView {
  const derived = buildDerived(data, todayISO)
  const properties = data.properties ?? []
  const photosByJob = groupPhotos(data.photos)
  const completedJobIds = new Set(derived.completed.map(j => j.id))
  const hasProperty = !!(data.property && (data.property.address || data.property.lawn_sqft || data.property.fence_length || data.property.neighborhood)) || properties.length > 0
  return {
    data, derived, todayISO,
    firstName: (data.customer?.name || '').trim().split(' ')[0] || 'there',
    photosByJob,
    invoiceByJob: new Map((data.invoices || []).filter(i => i.job_id).map(i => [i.job_id as string, i])),
    propsById: new Map(properties.map(p => [p.id, p])),
    properties,
    multiProperty: properties.length > 1,
    hasProperty,
    docItems: buildDocItems({ quotes: data.quotes, invoices: data.invoices, properties, business: data.business, todayISO, renderers, onInvoiceOpen }),
    money: moneySummary(data.invoices, data.business),
    propertyModels: buildPropertyModels(data, derived, photosByJob),
    customerSince: customerSinceYear(data),
    requestPresets: requestPresetsOf(data),
    orphanPhotos: orphanPhotos(data.photos, completedJobIds),
  }
}
