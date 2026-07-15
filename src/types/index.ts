export type QuoteStatus =
  | 'draft' | 'sent' | 'accepted' | 'scheduled' | 'completed' | 'paid' | 'declined'

export interface Customer {
  id: string
  created_at: string
  updated_at: string
  name: string
  email: string | null
  phone: string | null
  address: string | null
  city: string | null
  province: string | null
  postal_code: string | null
  notes: string | null
  tags: string[]
  acquisition_source: string | null
  referred_by_customer_id: string | null
  // Soft-archive: set when the customer is archived (hidden but fully preserved);
  // null = active. Deleting a customer with any history archives instead of cascading.
  archived_at?: string | null
  // Scheduling preferences (customer-wide default; a property may override per
  // field — see lib/preferences). Honoured by manual scheduling, the optimizer
  // and the weekly Best-Day picker. getDay weekday indices (0=Sun…6=Sat).
  preferred_days: number[] | null
  avoid_days: number[] | null
  pref_time_start: string | null // 'HH:mm'
  pref_time_end: string | null   // 'HH:mm'
  // Communication consent — gates all SMS/email sends (default off).
  sms_opt_in: boolean
  email_opt_in: boolean
  // ── CRM automation ──
  // Review lifecycle on top of reviewed_at (status DERIVED in lib/crm/reviews):
  //   declined → review_declined_at · reviewed → reviewed_at · requested →
  //   review_requested_at · else not_requested. review_source/_rating are the
  //   editable details once a review lands.
  reviewed_at?: string | null
  review_requested_at?: string | null
  review_source?: string | null
  review_rating?: number | null
  review_declined_at?: string | null
  // Optional dates that power the birthday / anniversary campaigns (month+day
  // matched; year ignored). 'YYYY-MM-DD'.
  birthday?: string | null
  anniversary?: string | null
  // Denormalised last OUTBOUND touch (maintained from messages by a trigger) —
  // powers "not contacted in X days" + the win-back campaign.
  last_contacted_at?: string | null
  // ── Recurring card-on-file AutoPay ──
  // Stripe customer id (lazily created on first card save). We store only this id +
  // the display metadata on PaymentMethod; Stripe holds the card itself.
  stripe_customer_id?: string | null
  // Master per-customer AutoPay switch (default off). When on AND a card is saved,
  // recurring invoices are auto-charged off-session.
  autopay_enabled?: boolean
  // Per-customer charge-mode OVERRIDE: null = inherit the business default;
  // 'auto' = charge on completion; 'manual_review' = always hold for the owner.
  autopay_charge_mode?: 'auto' | 'manual_review' | null
  user_id: string
}

// A saved card — DISPLAY metadata only. Stripe stores the actual card; we keep just
// the Stripe ids + brand/last4/expiry so the profile + portal can show "Visa ••42".
export interface PaymentMethod {
  id: string
  created_at: string
  user_id: string
  customer_id: string
  stripe_customer_id: string | null
  stripe_payment_method_id: string
  brand: string | null
  last4: string | null
  exp_month: number | null
  exp_year: number | null
  is_default: boolean
}

export interface Property {
  id: string
  created_at: string
  updated_at: string
  customer_id: string
  user_id: string
  address: string
  city: string | null
  province: string | null
  postal_code: string | null
  lat: number | null
  lng: number | null
  // Real community name ("Queensland"), reverse-geocoded once from lat/lng.
  // All neighborhood analytics prefer this over the postal FSA prefix.
  neighborhood: string | null
  lot_size: number | null
  lawn_sqft: number | null
  fence_length: number | null
  mulch_area: number | null
  rock_area: number | null
  driveway_area: number | null
  notes: string | null
  measurement_history: MeasurementSnapshot[]
  // Permanently-saved lawn boundary + map identity (from a website measurement or
  // an in-app trace). The CURRENT boundary — section-tagged {lat,lng} rings (jsonb)
  // — so a measured property can be reopened and redrawn without re-tracing.
  lawn_polygon?: LawnPolygon | null
  google_place_id?: string | null
  maps_url?: string | null
  property_travel_distance_km?: number | null
  property_travel_fee?: number | null
  is_primary: boolean
  // Optional per-property override of the customer's scheduling preferences.
  // A set field wins over the customer default for that field only.
  preferred_days: number[] | null
  avoid_days: number[] | null
  pref_time_start: string | null // 'HH:mm'
  pref_time_end: string | null   // 'HH:mm'
  customers?: Pick<Customer, 'id' | 'name' | 'email' | 'phone'>
}

// One versioned measurement. Stored as an element of properties.measurement_history
// (jsonb) so re-measuring a property APPENDS a new snapshot instead of overwriting.
// The full pricing recommendation captured WITH a measurement — the source of
// truth for suggested prices on quotes/jobs until the next measurement or
// recalculation. Built by lib/pricing's pricingPackage (never a second system).
export interface SavedRecommendation {
  one_time: number
  weekly: number
  biweekly: number
  monthly: number
  cadence: 'one_time' | 'weekly' | 'biweekly' | 'monthly' // recommended frequency
  season_weekly: number
  season_biweekly: number
  season_monthly: number
  est_minutes: number
  score?: string | null  // prospect score at measurement time (A+…F)
  hood?: string | null   // neighborhood name at measurement time
}

export interface MeasurementSnapshot {
  date: string            // ISO timestamp the measurement was taken
  total_sqft: number      // sum of all lawn sections
  sections?: LawnSections // per-section breakdown (front/back/left/right/boulevard/other)
  recommendation?: SavedRecommendation | null
  rate_per_1000?: number | null
  // The exact traced boundary for THIS snapshot, so any past measurement can be
  // redrawn/compared, not just the current one.
  polygon?: LawnPolygon | null
  // How the area was captured: 'traced' (drawn on the map), 'auto' (building-
  // footprint estimate accepted as-is), 'manual' (typed), 'website' (online booking).
  source?: string | null
  // legacy single-figure fields kept for older snapshots
  lawn_sqft?: number | null
  fence_length?: number | null
  mulch_area?: number | null
  rock_area?: number | null
  driveway_area?: number | null
  notes?: string | null
}

// A saved lawn boundary: each traced section as a closed ring of {lat,lng} points.
// Stored on properties.lawn_polygon (current) and on each MeasurementSnapshot.
export interface LawnPolygonSection {
  section: string         // front | back | left | right | boulevard | other
  ring: { lat: number; lng: number }[]
}
export type LawnPolygon = LawnPolygonSection[]

// The six lawn sections the Measurement Tool traces, in square feet.
export interface LawnSections {
  front: number
  back: number
  left: number
  right: number
  boulevard: number
  other: number
}

// How much we trust a suggested price. Driven by whether real measurements exist
// and whether there are comparable nearby jobs to anchor against.
export type PricingConfidence = 'high' | 'medium' | 'low'

export const CONFIDENCE_LABELS: Record<PricingConfidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
}

export const CONFIDENCE_COLORS: Record<PricingConfidence, string> = {
  high:   'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  medium: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  low:    'bg-red-500/10 text-red-400 border-red-500/20',
}

export interface PropertyFormValues {
  address: string
  city: string
  province: string
  postal_code: string
  notes: string
}

export type JobStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled'

export type RecurFreq = 'weekly' | 'biweekly' | 'monthly' // legacy label set
export type RecurUnit = 'day' | 'week' | 'month'

// One row per recurring series. Individual visits are real `jobs` rows that
// share a recurrence_id, so per-visit status / invoicing / drag still work.
// The series is described by an interval (count + unit) so ANY cadence works
// — every 3 weeks, every 10 days, every 2 months, etc. `freq` is kept only for
// backward-compatibility with older rows.
export interface JobRecurrence {
  id: string
  created_at: string
  user_id: string
  freq: RecurFreq | null
  interval_unit: RecurUnit | null
  interval_count: number | null
  start_date: string
  end_date: string | null // null = no date limit
  end_count: number | null // ends after N visits (null = not count-limited)
  customer_id: string | null
}

export interface Job {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  customer_id: string | null
  property_id: string | null
  quote_id: string | null
  recurrence_id: string | null
  title: string
  service_type: string | null
  scheduled_date: string
  start_time: string | null
  end_time: string | null
  duration_minutes: number | null
  crew_size: number
  status: JobStatus
  notes: string | null
  // Per-visit price. Manual override — when set it wins over the linked quote's
  // cadence price (the one source for what a visit is worth).
  price: number | null
  // Actual minutes spent on site. Auto-calculated from started_at → completed_at
  // by the check-in/check-out flow (manually editable). THE timing value every
  // engine reads (profitability, routes, pricing calibration).
  actual_minutes: number | null
  // Check-in/check-out: ▶ Start stamps started_at (arrival), ✓ Complete stamps
  // completed_at and derives actual_minutes.
  started_at: string | null
  completed_at: string | null
  // Stamped by /api/comms/send when an "on my way" goes out (portal live status).
  on_my_way_at?: string | null
  // Best-day suggester telemetry: what was recommended vs. what was picked,
  // so recommendation quality can be measured later.
  suggested_date: string | null
  suggested_nearby_count: number | null
  // The first visit of a recurring series — derives the quote's INITIAL price,
  // not the cadence price. Editing the recurring price never touches it.
  is_initial_visit: boolean
  // Manual day-route sequence (drag-and-drop). null/absent = automatic (optimizer).
  route_order?: number | null
  customers?: Pick<Customer, 'id' | 'name' | 'phone' | 'preferred_days' | 'avoid_days' | 'pref_time_start' | 'pref_time_end'>
  properties?: Pick<Property, 'id' | 'address' | 'lat' | 'lng' | 'neighborhood' | 'preferred_days' | 'avoid_days' | 'pref_time_start' | 'pref_time_end'>
}

// Apple-style edit scope for recurring jobs.
export type RecurrenceScope = 'this' | 'future' | 'all'

export const RECUR_FREQ_LABELS: Record<RecurFreq, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
}

export interface JobFormValues {
  customer_id: string
  property_id: string
  title: string
  service_type: string
  scheduled_date: string
  start_time: string
  end_time: string
  duration_minutes: number
  crew_size: number
  status: JobStatus
  notes: string
  actual_minutes: number
  price: number
}

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  scheduled: 'Scheduled',
  in_progress: 'In Progress',
  completed: 'Done',
  cancelled: 'Cancelled',
}

export const JOB_STATUS_COLORS: Record<JobStatus, string> = {
  scheduled:   'bg-blue-500/10 text-blue-400 border-blue-500/20',
  in_progress: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  completed:   'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  cancelled:   'bg-ink-faint/20 text-ink-muted border-ink-faint/30',
}

// Before/after (or general) photo captured on a visit. Files live in the public
// `job-photos` storage bucket; this row is the catalogue entry. See lib/photos.
export type PhotoKind = 'before' | 'after' | 'general'

export interface JobPhoto {
  id: string
  created_at: string
  user_id: string
  job_id: string | null
  property_id: string | null
  customer_id: string | null
  storage_path: string
  kind: PhotoKind
  caption: string | null
  taken_at: string
}

export const PHOTO_KIND_LABELS: Record<PhotoKind, string> = {
  before: 'Before',
  after: 'After',
  general: 'Photo',
}

// An extra service added to a single visit (Fertilizer $45, Weed Control $25…).
// The base price stays on the job/quote — these are ADDITIVE. "Future / Entire
// plan" inserts one row per affected non-completed visit sharing a group_id.
export interface JobLineItem {
  id: string
  created_at: string
  user_id: string
  job_id: string
  description: string
  amount: number
  service_key: string | null      // normalised BI key: "fertilizer", "custom"…
  service_category: string | null // lawn | snow | year_round (lib/seasons)
  group_id: string | null
  recurring: boolean
}

// Audit trail for a price change. Reason is only required on an increase.
export interface JobPriceChange {
  id: string
  created_at: string
  user_id: string
  job_id: string | null
  quote_id: string | null
  scope: 'this' | 'future' | 'all' | null
  old_amount: number | null
  new_amount: number | null
  reason: string | null
  changed_by_email: string | null
}

// Reasons offered when raising a price (audit trail for upsells/surcharges).
export type PriceReason = 'Upsell' | 'Larger than expected' | 'Extra work' | 'Travel surcharge' | 'Custom'
export const PRICE_REASONS: PriceReason[] = ['Upsell', 'Larger than expected', 'Extra work', 'Travel surcharge', 'Custom']

// Quick-add add-on templates for fast field entry. `recurringByDefault` flips the
// scope chooser to a recurring suggestion (program services). Keys are stable for BI.
export interface AddonTemplate { key: string; label: string; recurringByDefault?: boolean }
export const ADDON_TEMPLATES: AddonTemplate[] = [
  { key: 'fertilizer', label: 'Fertilizer', recurringByDefault: true },
  { key: 'weed_control', label: 'Weed Control', recurringByDefault: true },
  { key: 'mulch', label: 'Mulch' },
  { key: 'spring_cleanup', label: 'Spring Cleanup' },
  { key: 'fall_cleanup', label: 'Fall Cleanup' },
  { key: 'shrub_trimming', label: 'Shrub Trimming' },
  { key: 'aeration', label: 'Aeration' },
  { key: 'overseeding', label: 'Overseeding' },
  { key: 'hauling', label: 'Hauling' },
  { key: 'custom', label: 'Custom' },
]

// One snapshotted row of an invoice's breakdown (stored in invoices.line_items).
export type InvoiceLineKind = 'service' | 'addon' | 'travel'
export interface InvoiceLineItem {
  description: string
  // The line total, and the ONLY figure any total/balance/PDF math reads. qty and
  // unit_price below are the manual breakdown that produced it — they never
  // re-derive a total, so engine-priced lines (which have no qty) are unaffected.
  amount: number
  kind: InvoiceLineKind
  // Optional, manual-invoice only: how the owner arrived at `amount`
  // (qty x unit_price). Absent on job/quote-generated lines, and the PDF only
  // grows Qty/Unit columns when a line actually carries them — so a generated
  // invoice renders byte-identically to before.
  qty?: number | null
  unit_price?: number | null
}

// Stored statuses. partial/overpaid are derived by the recompute_invoice_paid DB
// trigger from the payment ledger (Total Paid vs Total); 'cancelled' is terminal
// (the trigger never revives it). 'overdue' (balance owing + past due) and
// 'viewed' (sent + customer opened it in the portal → viewed_at) are DISPLAY-only
// overlays — never stored.
export type InvoiceStatus = 'draft' | 'unpaid' | 'sent' | 'partial' | 'paid' | 'overpaid' | 'cancelled'
export type InvoiceDisplayStatus = InvoiceStatus | 'overdue' | 'viewed'

export interface Invoice {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  quote_id: string | null
  customer_id: string | null
  property_id: string | null
  job_id: string | null
  invoice_number: string
  customer_name: string
  address: string | null
  service_type: string | null
  amount: number
  status: InvoiceStatus
  issued_date: string | null
  due_date: string | null
  notes: string | null
  // Snapshot breakdown for the customer (base service + add-ons + travel). Null
  // on legacy invoices → render the single (service_type, amount) row.
  line_items: InvoiceLineItem[] | null
  // How it was paid (set on mark-paid / by the Stripe webhook). null = unpaid.
  payment_method?: 'stripe' | 'etransfer' | 'cash' | 'cheque' | null
  paid_at?: string | null
  // Total received toward this invoice (maintained by the recompute_invoice_paid
  // trigger from the payment ledger). Balance = invoiceTotals(...).total − amount_paid.
  amount_paid?: number
  // When the CUSTOMER first opened this invoice in the portal (drives 'Viewed').
  viewed_at?: string | null
  // Optional discount. `amount` is ALWAYS the net (post-discount) subtotal; these
  // record how that net was reached so the breakdown + editor can show/reapply it.
  discount_type?: 'amount' | 'percent' | null
  discount_value?: number | null
  customers?: Pick<Customer, 'id' | 'name' | 'email' | 'phone'>
}

export const INVOICE_STATUS_LABELS: Record<InvoiceDisplayStatus, string> = {
  draft: 'Draft',
  unpaid: 'Unpaid',
  sent: 'Sent',
  viewed: 'Viewed',
  partial: 'Partially Paid',
  paid: 'Paid',
  overpaid: 'Overpaid',
  overdue: 'Overdue',
  cancelled: 'Cancelled',
}

export const INVOICE_STATUS_COLORS: Record<InvoiceDisplayStatus, string> = {
  draft:     'bg-ink-faint/15 text-ink-muted border-ink-faint/30',
  unpaid:    'bg-amber-500/10 text-amber-400 border-amber-500/20',
  sent:      'bg-blue-500/10 text-blue-400 border-blue-500/20',
  viewed:    'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
  partial:   'bg-sky-500/10 text-sky-400 border-sky-500/20',
  paid:      'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  overpaid:  'bg-violet-500/10 text-violet-400 border-violet-500/20',
  overdue:   'bg-red-500/10 text-red-400 border-red-500/20',
  cancelled: 'bg-ink-faint/10 text-ink-faint border-ink-faint/20',
}

// A row in the unified payment ledger (existing `payments` table). kind='payment'
// is money toward an invoice (negative = refund / moved-to-credit); kind='credit'
// is a customer-credit movement (+granted / −used). One ledger, no separate system.
export interface Payment {
  id: string
  created_at: string
  user_id: string
  customer_id: string | null
  invoice_id: string | null
  amount: number
  currency: string
  provider: string
  kind: 'payment' | 'credit'
  method: string | null
  notes: string | null
  status: string
  paid_at: string | null
  stripe_payment_intent?: string | null
}

// Manual payment methods the owner can record (Stripe rows come from the webhook;
// 'card' = a card charged outside EdgeQuote, e.g. a terminal or another processor).
// The picker offers Card / E-transfer / Cash — the three ways customers actually pay.
// Retired methods (cheque/debit/other) still LABEL correctly on legacy rows via the
// fallback in paymentMethodLabel; 'credit' stays for labeling but is filtered out of
// the picker (customer credit is applied by the ledger, never chosen here).
export const PAYMENT_METHODS: { value: string; label: string }[] = [
  { value: 'card', label: 'Card' },
  { value: 'etransfer', label: 'E-transfer' },
  { value: 'cash', label: 'Cash' },
  { value: 'credit', label: 'Customer credit' },
]

// Human label for any payment method value (ledger rows may also carry 'stripe'
// from the webhook or 'refund'). One vocabulary for receipts, lists and PDFs.
export function paymentMethodLabel(method: string | null | undefined): string {
  if (!method) return 'Payment'
  const hit = PAYMENT_METHODS.find(m => m.value === method)
  if (hit) return hit.label
  if (method === 'stripe') return 'Card (online)'
  if (method === 'refund') return 'Refund'
  return method.charAt(0).toUpperCase() + method.slice(1)
}

export interface Quote {
  id: string
  created_at: string
  updated_at: string
  quote_number: string
  customer_id: string | null
  customer_name: string
  address: string
  service_type: string
  notes: string | null
  hours: number
  crew_size: number
  rate: number
  travel_fee: number
  man_hours: number
  subtotal: number
  total: number
  initial_price: number | null
  weekly_price: number | null
  biweekly_price: number | null
  monthly_price: number | null
  // Measurement provenance — lets us later compare suggested vs. actual vs. outcome.
  measured_sqft: number | null
  suggested_price: number | null
  // Per-section breakdown captured from the Measurement Tool (sq ft).
  front_lawn_sqft: number | null
  back_lawn_sqft: number | null
  left_side_sqft: number | null
  right_side_sqft: number | null
  boulevard_sqft: number | null
  other_sqft: number | null
  // Travel + pricing-intelligence capture.
  travel_distance_km: number | null
  pricing_confidence: PricingConfidence | null
  custom_travel_required: boolean
  show_travel_separately: boolean
  status: QuoteStatus
  // Follow-up / missed-quote recovery
  sent_at: string | null
  // Calendar date the quote stops standing. Null = never expires (every quote
  // sent before expiry existed). 'expired' is DERIVED by lib/quoteStatus and is
  // never stored in `status` — see the invoice 'overdue' overlay it mirrors.
  valid_until: string | null
  last_followed_up_at: string | null
  follow_up_count: number
  // Captured at acceptance so recovery impact can be measured later
  accepted_after_followup: boolean
  follow_up_count_at_acceptance: number | null
  service_template_id: string | null
  overgrowth_multiplier: number
  issued_date: string | null
  property_id: string | null
  user_id: string
  customers?: Pick<Customer, 'id' | 'name' | 'email' | 'phone'>
}

// One service line on a multi-service quote (quote_services child table).
// sort_order 0 is the PRIMARY service (mapped to the classic single-service
// fields in the builder); rows 1+ are additional services. When rows exist they
// are the source of truth; quotes.service_type/initial_price are derived caches
// (primary label + summed net) so the generated quotes.total stays correct.
export interface QuoteService {
  id: string
  created_at: string
  user_id: string
  quote_id: string
  service_type: string
  service_template_id: string | null
  quantity: number
  unit: string | null            // each | hour | sqft | linear_ft
  unit_price: number
  est_minutes: number | null
  discount_type: 'amount' | 'percent' | null
  discount_value: number | null
  notes: string | null
  sort_order: number
}

// Form shape for an additional-service line in the builder ('' = unset selects).
export interface QuoteServiceInput {
  service_type: string
  service_template_id: string
  quantity: number
  unit: string
  unit_price: number
  est_minutes: number
  discount_type: '' | 'amount' | 'percent'
  discount_value: number
  notes: string
}

export interface QuoteFormValues {
  customer_id: string
  customer_name: string
  // Optional contact captured when entering a brand-new person manually, so the
  // save flow can create/match the customer (no duplicate) and store contact info.
  customer_phone?: string
  customer_email?: string
  address: string
  service_type: string
  service_template_id: string
  overgrowth_multiplier: number
  distance_km: number
  hours: number
  crew_size: number
  rate: number
  travel_fee: number
  notes: string
  initial_price: number
  weekly_price: number
  biweekly_price: number
  monthly_price: number
  custom_travel_required: boolean
  show_travel_separately: boolean
  status: QuoteStatus
  // Carried (not user-edited) when measuring inside the builder, so the in-builder
  // measure path records the same provenance as the standalone Measurement Tool.
  measured_sqft: number
  suggested_price: number
  // Additional service lines beyond the primary one (multi-service quotes).
  services: QuoteServiceInput[]
}

export interface CustomerFormValues {
  name: string
  email: string
  phone: string
  address: string
  city: string
  province: string
  postal_code: string
  notes: string
  acquisition_source: string
  referred_by_customer_id: string
  birthday: string
  anniversary: string
  // Contact consent captured at creation (persisted via the shared consent
  // engine so the audit trail is written). Optional — absent on the edit form,
  // where the profile's Communication card is the canonical consent manager.
  sms_opt_in?: boolean
  email_opt_in?: boolean
}

// ── CRM automation ──────────────────────────────────────────────────────────
// A referral and its outcome. The referred person is referenced by FK once they
// become a customer (referred_customer_id) — never duplicated. Bridges the
// existing customers.referred_by_customer_id link (see migration 2026-06-25h).
export interface Referral {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  referrer_customer_id: string
  referred_customer_id: string | null
  referred_name: string | null
  referred_contact: string | null
  status: 'invited' | 'joined' | 'rewarded' | 'declined'
  reward: string | null
  notes: string | null
  joined_at: string | null
  rewarded_at: string | null
}

export type CampaignKind =
  | 'birthday' | 'anniversary' | 'win_back' | 'broadcast'
  | 'seasonal'   // fires on a fixed calendar date (e.g. spring cleanup), once a year
  | 'referral'   // asks happy customers to refer a neighbour
  | 'review'     // asks customers who haven't reviewed yet

// What a campaign sends to, beyond the implicit filters the cron always applies
// (own customers, not archived, plus the kind's own trigger).
export interface CampaignAudience {
  recurring_only?: boolean   // has at least one job_recurrence
  not_reviewed?: boolean     // hasn't reviewed and hasn't declined — for review asks
  happy_only?: boolean       // left a review rated >= 4 — for referral asks
}

// Kind-specific timing. `starts_on`/`ends_on` are an optional active window that
// applies to EVERY kind — outside it the campaign is skipped without sending.
export interface CampaignSchedule {
  days?: number           // win_back: quiet for N days
  lead_days?: number      // birthday/anniversary: fire N days early
  day_of_month?: number   // broadcast/referral/review: day to fire on
  every_months?: number   // broadcast/referral/review: cadence
  month?: number          // seasonal: 1-12
  day?: number            // seasonal: 1-28
  starts_on?: string      // 'YYYY-MM-DD' — campaign is dormant before this date
  ends_on?: string        // 'YYYY-MM-DD' — campaign is dormant after this date
}

// A customer-centric automated outreach the owner defines; the daily cron
// (/api/cron/campaigns) resolves the audience and sends through the existing
// comms pipeline. Distinct from job-triggered business_settings.automations.
export interface CrmCampaign {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  name: string
  kind: CampaignKind
  enabled: boolean
  channels: string[]
  template_key: string | null
  custom_body: string | null
  subject: string | null      // owner-written email subject; blank → the template's stock subject
  audience: CampaignAudience
  schedule: CampaignSchedule
  last_run_at: string | null
}

// A saved campaign configuration the owner can spin up again. Same shape as a
// campaign minus the runtime fields (enabled/last_run_at) — deliberately a
// separate table so a preset can never be mistaken for a live, sending campaign.
export interface CrmCampaignPreset {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  name: string
  kind: CampaignKind
  channels: string[]
  template_key: string | null
  custom_body: string | null
  subject: string | null
  audience: CampaignAudience
  schedule: CampaignSchedule
}

export const ACQUISITION_SOURCES = [
  'Referral',
  'Google',
  'Facebook',
  'Instagram',
  'Nextdoor',
  'Flyer / Mailout',
  'Truck Signage',
  'Repeat Customer',
  'Door Knocking',
  'Other',
] as const

// The four business-health numbers the dashboard StatsGrid renders (Jobs Done shows
// both the total and the this-month count). Trimmed to match the decluttered grid —
// vanity/duplicate stats (totalQuotes, revenueQuoted, pendingQuotes, monthlyRevenue,
// outstandingRevenue, acceptedJobs) were removed and must NOT be reintroduced.
export interface DashboardStats {
  collectedRevenue: number
  acceptedRevenue: number
  jobsDone: number
  jobsDoneThisMonth: number
  conversionRate: number
}

export interface BusinessSettings {
  id: string
  created_at: string
  updated_at: string
  company_name: string
  owner_name: string | null
  phone: string | null
  email_primary: string | null
  email_secondary: string | null
  website: string | null
  logo_url: string | null
  base_address: string | null
  base_lat: number | null
  base_lng: number | null
  default_rate: number
  // Fully-loaded cost of one crew-hour (labour + overhead). THE business cost
  // basis: revenue − (hours × this) = expected profit, used everywhere profit
  // is shown (measure verdict, customer/route/area profitability, scoring).
  // null → fall back to DEFAULT_CREW_COST ($40/hr) from lib/economics.
  crew_cost_per_hour: number | null
  // Minimum acceptable revenue per crew-hour — the Suggestions Center guardrail.
  // null → default $60/hr.
  target_rev_per_hour: number | null
  // Configurable lawn pricing (consumed by the centralized pricing engine).
  pricing_base_charge: number | null
  pricing_mow_rate: number | null
  pricing_recommended_mult: number | null
  pricing_premium_mult: number | null
  pricing_travel_rate: number | null
  terms_text: string | null
  // Weekday indices the owner works (0=Sun … 6=Sat). The weekly scheduler strongly
  // prefers these days. Default {5,6,0} = Fri/Sat/Sun.
  preferred_work_days: number[] | null
  // 'HH:mm' the work day starts — drives per-stop ETAs + estimated finish.
  work_start_time: string | null
  // Soft daily cap (drive + on-site hours) for overload / room-for-more signals.
  daily_capacity_hours: number | null
  // Uploaded-logo display scale in percent (100 = default size).
  logo_scale: number | null
  // Dashboard layout: section order + hidden sections.
  dashboard_cards: { order: string[]; hidden: string[] } | null
  // Service seasons (lawn/snow) as recurring month/day anchors. Drives the
  // "Season End" recurrence default and seasonal reactivation suppression.
  // null = use Calgary defaults (lib/seasons DEFAULT_SEASONS).
  service_seasons: { lawn?: unknown; snow?: unknown } | null
  // ── Payment fee recovery ── how the ~3% Stripe cost is recovered:
  //   'global_price_increase' (default) → new quote prices are bumped by
  //   fee_recovery_percent; 'absorb' → no change; 'etransfer_discount' →
  //   future-proof, off by default. Never a card surcharge (AB-compliant).
  payment_fee_strategy: PaymentFeeStrategy | null
  fee_recovery_percent: number | null        // markup % baked into new quotes
  etransfer_discount_percent: number | null  // future: % off for non-card pay (off by default)
  // Where customers send e-transfers — shown in the portal's Ways-to-pay panel.
  etransfer_email?: string | null
  gst_percent: number | null                 // GST shown/charged only when > 0 (Alberta = 5 when registered)
  // ── Recurring AutoPay ── business-wide default charge mode (a customer may
  // override). 'auto' = charge a saved card the moment a recurring visit completes;
  // 'manual_review' = always draft the invoice and wait for the owner to charge.
  autopay_charge_mode?: 'auto' | 'manual_review' | null
  // Safety check: a recurring invoice whose amount deviates from the customer's
  // usual recurring amount by more than this % is HELD for review, never auto-charged.
  autopay_variance_pct?: number | null
  user_id: string
}

export type PaymentFeeStrategy = 'absorb' | 'global_price_increase' | 'etransfer_discount'

export interface TravelFeeTier {
  id: string
  created_at: string
  min_km: number
  max_km: number | null
  fee: number | null
  is_custom: boolean
  sort_order: number
  user_id: string
}

// How a service template's price is displayed. The default_rate column holds the
// value; this drives the label + unit (see src/lib/servicePricing.ts).
export const PRICING_DISPLAY_TYPES = [
  'starting_from',
  'hourly',
  'per_sqft',
  'per_linear_ft',
  'starting_from_materials',
  'hourly_materials',
] as const
export type PricingDisplayType = typeof PRICING_DISPLAY_TYPES[number]

export const PRICING_DISPLAY_TYPE_LABELS: Record<PricingDisplayType, string> = {
  starting_from: 'Starting From',
  hourly: 'Hourly',
  per_sqft: 'Per Sq Ft',
  per_linear_ft: 'Per Linear Ft',
  starting_from_materials: 'Starting From + Materials',
  hourly_materials: 'Hourly + Materials',
}

export interface ServiceTemplate {
  id: string
  created_at: string
  updated_at: string
  name: string
  category: string
  default_rate: number
  pricing_display_type: PricingDisplayType
  default_description: string | null
  notes: string | null
  is_active: boolean
  sort_order: number
  user_id: string
}

export interface ServiceTemplateFormValues {
  name: string
  category: string
  default_rate: number
  pricing_display_type: PricingDisplayType
  default_description: string
  notes: string
  is_active: boolean
}

export interface BusinessSettingsFormValues {
  company_name: string
  owner_name: string
  phone: string
  email_primary: string
  email_secondary: string
  website: string
  base_address: string
  default_rate: number
  crew_cost_per_hour: number
  target_rev_per_hour: number
  pricing_base_charge: number
  pricing_mow_rate: number
  pricing_recommended_mult: number
  pricing_premium_mult: number
  pricing_travel_rate: number
  terms_text: string
  payment_fee_strategy: PaymentFeeStrategy
  fee_recovery_percent: number
  etransfer_discount_percent: number
  etransfer_email: string
  gst_percent: number
  autopay_charge_mode: 'auto' | 'manual_review'
  autopay_variance_pct: number
}

export const SERVICE_CATEGORIES = [
  'Lawn Care',
  'Property Maintenance',
  'Landscaping',
  'Tree & Shrub Care',
  'Winter Services',
  'General',
] as const

export const OVERGROWTH_LEVELS = [
  { label: 'Normal Lawn', multiplier: 1.0, description: 'Standard condition — base price' },
  { label: '6–12 inches', multiplier: 1.5, description: 'Moderate overgrowth' },
  { label: '1–2 feet', multiplier: 2.0, description: 'Heavy overgrowth' },
  { label: 'Over 2 feet', multiplier: 0, description: 'Custom quote required' },
] as const

export const SERVICE_TYPES = [
  'Lawn Mowing',
  'Yard Cleanup',
  'Snow Removal',
  'Landscaping',
  'Pressure Washing',
  'Window Cleaning',
  'Junk Removal',
  'Fencing',
  'Painting',
  'Other',
] as const

export const STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Accepted',
  scheduled: 'Scheduled',
  completed: 'Completed',
  paid: 'Paid',
  declined: 'Declined',
}

export const STATUS_COLORS: Record<QuoteStatus, string> = {
  draft:     'bg-ink-faint/20 text-ink-muted border-ink-faint/30',
  sent:      'bg-blue-500/10 text-blue-400 border-blue-500/20',
  accepted:  'bg-accent-dim text-accent-text border-accent/20',
  scheduled: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  completed: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
  paid:      'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  declined:  'bg-red-500/10 text-red-400 border-red-500/20',
}