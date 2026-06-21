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
  user_id: string
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
  // legacy single-figure fields kept for older snapshots
  lawn_sqft?: number | null
  fence_length?: number | null
  mulch_area?: number | null
  rock_area?: number | null
  driveway_area?: number | null
  notes?: string | null
}

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
  // Best-day suggester telemetry: what was recommended vs. what was picked,
  // so recommendation quality can be measured later.
  suggested_date: string | null
  suggested_nearby_count: number | null
  // The first visit of a recurring series — derives the quote's INITIAL price,
  // not the cadence price. Editing the recurring price never touches it.
  is_initial_visit: boolean
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
  amount: number
  kind: InvoiceLineKind
}

export type InvoiceStatus = 'draft' | 'unpaid' | 'sent' | 'paid'

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
  customers?: Pick<Customer, 'id' | 'name' | 'email' | 'phone'>
}

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  unpaid: 'Unpaid',
  sent: 'Sent',
  paid: 'Paid',
}

export const INVOICE_STATUS_COLORS: Record<InvoiceStatus, string> = {
  draft:  'bg-ink-faint/15 text-ink-muted border-ink-faint/30',
  unpaid: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  sent:   'bg-blue-500/10 text-blue-400 border-blue-500/20',
  paid:   'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
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

export interface DashboardStats {
  totalQuotes: number
  revenueQuoted: number
  acceptedJobs: number
  pendingQuotes: number
  acceptedRevenue: number
  monthlyRevenue: number
  conversionRate: number
  collectedRevenue: number
  outstandingRevenue: number
  jobsDone: number
  jobsDoneThisMonth: number
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
  user_id: string
}

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

export interface ServiceTemplate {
  id: string
  created_at: string
  updated_at: string
  name: string
  category: string
  default_rate: number
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
  accepted:  'bg-accent-dim text-accent border-accent/20',
  scheduled: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  completed: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
  paid:      'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  declined:  'bg-red-500/10 text-red-400 border-red-500/20',
}