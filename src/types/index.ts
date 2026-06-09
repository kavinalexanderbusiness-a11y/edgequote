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
  lot_size: number | null
  lawn_sqft: number | null
  fence_length: number | null
  mulch_area: number | null
  rock_area: number | null
  driveway_area: number | null
  notes: string | null
  measurement_history: MeasurementSnapshot[]
  is_primary: boolean
  customers?: Pick<Customer, 'id' | 'name' | 'email' | 'phone'>
}

// One versioned measurement. Stored as an element of properties.measurement_history
// (jsonb) so re-measuring a property APPENDS a new snapshot instead of overwriting.
export interface MeasurementSnapshot {
  date: string            // ISO timestamp the measurement was taken
  total_sqft: number      // sum of all lawn sections
  sections?: LawnSections // per-section breakdown (front/back/left/right/boulevard/other)
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
  // Actual minutes spent on site (entered on completion). Foundation for future
  // pricing intelligence: estimated vs. actual time per job.
  actual_minutes: number | null
  // Best-day suggester telemetry: what was recommended vs. what was picked,
  // so recommendation quality can be measured later.
  suggested_date: string | null
  suggested_nearby_count: number | null
  customers?: Pick<Customer, 'id' | 'name' | 'phone'>
  properties?: Pick<Property, 'id' | 'address' | 'lat' | 'lng'>
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
  // Configurable lawn pricing (consumed by the centralized pricing engine).
  pricing_base_charge: number | null
  pricing_mow_rate: number | null
  pricing_recommended_mult: number | null
  pricing_premium_mult: number | null
  pricing_travel_rate: number | null
  terms_text: string | null
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