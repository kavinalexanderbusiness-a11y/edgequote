import { type Tone, toneSoft } from '@/lib/tone'
import type { MessagePrefs } from '@/lib/comms/templates'
import { type PreferredChannel } from '@/lib/comms/reach'

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
  // Per-CATEGORY consent (portal self-serve; lib/comms/templates.prefAllows).
  // Optional because most reads don't select it; reach.ts treats absent as
  // "no category opt-outs recorded".
  message_prefs?: MessagePrefs | null
  // How they'd RATHER be contacted. A preference, not a permission: it orders
  // the channels consent above already allows and can never grant one, so
  // 'sms' here with sms_opt_in false still never sends a text. null = no
  // preference, the state every existing customer is in. 'phone' means call
  // them — the owner does that, this product never places calls.
  // THE resolver is resolveReach in lib/comms/reach; nothing reads this raw.
  //
  // ⚠️ ORTHOGONAL to message_prefs above, and both are load-bearing:
  // message_prefs answers "may we send this CATEGORY at all", preferred_channel
  // answers "which allowed channel FIRST". Consent gates; preference orders.
  preferred_channel?: PreferredChannel | null
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
  // CUSTOMER-FACING: get_portal_data returns this and the portal renders it under
  // "Notes from your provider". Anything the customer must not read belongs in
  // `internal_notes` below.
  notes: string | null
  // PRIVATE to the owner and crew — the place's access facts (gate side, dog,
  // controller location). Never selected by get_portal_data, so it cannot reach
  // the portal; verify:location-intelligence pins that.
  internal_notes?: string | null
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

// Confidence maps onto the shared semantic tones — these three class strings were
// a verbatim re-spelling of toneSoft, in the one file lib/tone.ts tells pages not
// to spell colours in. Referencing the tone map keeps the pill identical today and
// keeps it in lock-step if a tone is ever retuned.
export const confidenceTone: Record<PricingConfidence, Tone> = {
  high: 'success', medium: 'warn', low: 'danger',
}

export const CONFIDENCE_COLORS: Record<PricingConfidence, string> = {
  high:   toneSoft[confidenceTone.high],
  medium: toneSoft[confidenceTone.medium],
  low:    toneSoft[confidenceTone.low],
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
  // 🔒 INTERNAL. The access/instruction note for whoever does the work (gate
  // code, where to park). crew_day ships it to the worker's phone. ⛔ It is NOT
  // in get_portal_data's payload and must never go back: it was rendered to
  // customers until 2026-08-11. Customer-facing words go in completion_summary.
  notes: string | null
  // ── Proof of work (lib/completion) ─────────────────────────────────────────
  // What a finished visit LEFT BEHIND. Neither is a completion state: `status` +
  // `completed_at` remain THE answer to whether and when, stamped only by
  // lib/jobStatus.completionPatch. Both stay nullable forever — completion must
  // never depend on paperwork.
  /** ⭐ CUSTOMER-VISIBLE. "What was done", rendered verbatim in the portal. */
  completion_summary?: string | null
  /** 🔒 INTERNAL. What the field found that needs attention. Never leaves the
   *  business — absent from get_portal_data, pinned by verify:completion. */
  completion_issue?: string | null
  // Per-visit price. Manual override — when set it wins over the linked quote's
  // cadence price (the one source for what a visit is worth).
  price: number | null
  // ELAPSED minutes on site. THE timing value every engine reads (profitability,
  // routes, pricing calibration).
  //
  // ⭐ ONE CONTRACT, enforced by the database: once a job has work sessions, this
  // IS the sum of their `minutes` — a total that disagrees with its parts is
  // corrected on the way in (see supabase/archive/run/RUN-2026-08-13-work-sessions.sql, and
  // lib/workSession for the doors). A job with no sessions keeps whatever the
  // check-in clock or the owner recorded, exactly as before. null = nothing
  // recorded, never 0.
  actual_minutes: number | null
  // Check-in: ▶ Start stamps started_at (arrival). It is CLEARED when the clock
  // is banked — by completing, or by stopping for the day — and the arrival time
  // lives on from there as the work session's own started_at. So
  // `status === 'in_progress' && started_at === null` is a real and meaningful
  // state: the job is underway but nobody is on the clock right now.
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
  // Which crew runs this visit (RUN-2026-07-15-dispatch-crews). null = unassigned —
  // the single-crew status quo. Orthogonal to crew_size, which stays headcount.
  crew_id?: string | null
  // The OTHER half of the one assignment truth: this visit is one named person's.
  // A visit carries a crew or a person, never both (jobs_one_assignee enforces it
  // in the database). Read them through lib/crewAssignment, never separately.
  technician_id?: string | null
  // `email` joined the pick for change orders: whether an approval ask can be
  // DELIVERED at all is "phone or email", and a phone-only test would have hidden
  // the Send button from every email-only customer.
  // Consent + review-lifecycle columns joined for the day board (Session 80):
  // the completion dialog predicts the job-complete text with THE reach
  // predicate instead of promising a send that consent would block, and the
  // Review door needs requested/reviewed/declined to avoid a duplicate ask.
  customers?: Pick<Customer, 'id' | 'name' | 'phone' | 'email' | 'preferred_days' | 'avoid_days' | 'pref_time_start' | 'pref_time_end'
    | 'sms_opt_in' | 'email_opt_in' | 'message_prefs' | 'reviewed_at' | 'review_requested_at' | 'review_declined_at'>
  properties?: Pick<Property, 'id' | 'address' | 'lat' | 'lng' | 'neighborhood' | 'preferred_days' | 'avoid_days' | 'pref_time_start' | 'pref_time_end'>
}

// ── Work sessions (RUN-2026-08-13-work-sessions) ──────────────────────────────
// One stretch of work, on one job, on one day. A job worked across three days
// has three of these; a 45-minute service call has one, or none if nobody timed
// it. THE itemisation of `jobs.actual_minutes` — see lib/workSession.
//
// ⛔ Not `time_entries`. That is the PAYROLL clock: a person's shift, with a
// snapshot wage, answering "what do I owe this employee". This answers "what
// happened on this job on this day", carries no wage and names no person.

export type WorkSessionSource = 'clock' | 'manual' | 'carried'

export interface WorkSession {
  id: string
  user_id: string
  job_id: string
  /** The day the work happened, in the business's own reckoning. */
  worked_on: string
  /** The clock stretch, when there was one. null for time typed in by hand —
   *  "about 3 hours yesterday" is not a claim about 09:00–12:00. */
  started_at: string | null
  ended_at: string | null
  /** ELAPSED minutes on site. */
  minutes: number
  /** How many people were on site. A COUNT, never a roster. */
  workers: number
  /** Person-minutes — GENERATED in the database as minutes × workers, so the
   *  elapsed/labour distinction has exactly one arithmetic. */
  labour_minutes: number
  /** Short, optional, and about the WORK ("ran out of primer"). Internal. */
  note: string | null
  source: WorkSessionSource
  created_at: string
  updated_at: string
}

// ── Dispatch & Crew Management (RUN-2026-07-15-dispatch-crews) ────────────────
// A crew is an IDENTITY (who runs the route), not a headcount. Jobs point at a
// crew via jobs.crew_id; the dispatch board partitions a day by crew and feeds
// each subset to the SAME route/ETA/capacity engines the schedule already uses.

export interface Crew {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  name: string
  // Palette key (lib/crews CREW_PALETTE) — board chip + map pin hue, not a hex.
  color: string
  day_start: string | null       // HH:mm[:ss]; null = business work_start_time
  day_end: string | null
  capacity_minutes: number | null // explicit daily capacity; null = derive from window
  is_active: boolean
  sort_order: number
  /** Optional crew lead — a MEMBER wearing a hat, not a rank. The database keeps
   *  the pointer honest: it must be an active member of this crew, and it clears
   *  itself the moment they leave the crew or the roster. Never a pay grade. */
  lead_technician_id?: string | null
}

/** One append-only fact: as of `changed_at`, this person's crew became `crew_id`
 *  (null = no crew). Written only by a database trigger — no client role may
 *  insert, update or delete one. It exists so that moving somebody between crews
 *  today cannot restate which crew they belonged to when last week's work
 *  happened. See lib/crewAssignment.crewIdAsOf. */
export interface CrewMembershipChange {
  id: string
  user_id: string
  technician_id: string
  crew_id: string | null
  changed_at: string
}

export type TechnicianStatus = 'available' | 'en_route' | 'on_job' | 'break' | 'off'

export const TECHNICIAN_STATUS_LABELS: Record<TechnicianStatus, string> = {
  available: 'Available',
  en_route: 'En route',
  on_job: 'On job',
  break: 'On break',
  off: 'Off today',
}

// THE employee record. Employees do NOT log in — every row is owned by the
// owner's auth user (same tenancy as customers). `role` is a descriptive job
// title, NOT access control; there is no permissions system to hang it on.
// Never add a rival `employees` table — this is it.
export interface Technician {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  crew_id: string | null
  name: string
  phone: string | null
  email: string | null
  role: string | null
  status: TechnicianStatus
  status_changed_at: string
  is_active: boolean
  /** Default pay rate for the NEXT clock-in. Past shifts keep their own
   *  snapshot (TimeEntry.hourly_rate) — raising this never rewrites history. */
  hourly_wage: number | null
  hired_on: string | null
  ended_on: string | null
  /** Annual PTO allowance in hours. null = no allowance configured, so usage is
   *  tracked but no balance is claimed — never guess someone's entitlement. */
  pto_annual_hours: number | null
  /** Soft-archive: set when they leave the roster; NULL = active. Removing a
   *  technician ARCHIVES — it must never delete. Their time_entries, wage_history
   *  and pto_entries are statutory records (~3yr), and until PAY-1 a delete
   *  CASCADED all three away. Distinct from `is_active`, which is a temporary
   *  "not working right now" toggle; archiving is "no longer employed here". */
  archived_at?: string | null
  // ── Crew Mode (RUN-2026-08-07-crew-mode) ──────────────────────────────────
  /** The Supabase auth user this employee signs in as, or NULL for records-only
   *  (which is every technician until an owner grants app access). Unique across
   *  the whole project: one login is one employee of one business, which is what
   *  keeps `crew_employer()` single-valued.
   *  ⚠️ Being linked is NOT enough to get in — crew_employer() also requires
   *  is_active AND archived_at IS NULL, re-checked on every query. The roster
   *  switches ARE the access control. */
  auth_user_id?: string | null
  /** One-time join code the owner hands out; cleared the instant it is redeemed. */
  invite_code?: string | null
  invite_expires_at?: string | null
  /** When the owner last generated a setup link (owner-provisioned invite).
   *  Whether they have ARRIVED is auth.users.last_sign_in_at, which no owner
   *  client can read — see the crew_access_states() RPC. */
  invite_sent_at?: string | null
}

// ── Paid time ────────────────────────────────────────────────────────────────
// THE paid-time ledger — one row per shift. Distinct from TechnicianStatus:
// `status` is where someone is RIGHT NOW (dispatch), a TimeEntry is what they
// get PAID for. A tech can be 'off' with an open shift (forgot to clock out),
// so hours must never be derived from status.
export interface TimeEntry {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  technician_id: string
  /** Job-linked (costable) or null for general time — yard, travel, shop. */
  job_id: string | null
  clock_in: string
  /** null = still on the clock. At most one open entry per tech (DB-enforced). */
  clock_out: string | null
  break_minutes: number
  /** Pay rate SNAPSHOT stamped at clock-in — the reason payroll history is stable. */
  hourly_rate: number | null
  notes: string | null
  /** DB-generated (clock_out - clock_in - break). null while the shift is open. */
  minutes_worked: number | null
}

// ── Paid time NOT worked ─────────────────────────────────────────────────────
// PTO is a SEPARATE ledger from TimeEntry on purpose. Vacation/holiday hours are
// not "hours worked", so they must never reach an overtime threshold: 40h worked
// + 8h vacation is 40h for OT, not 48h. Storing these as TimeEntry rows would
// make lib/payroll invent overtime on every week containing a day off.
export type PtoKind = 'vacation' | 'sick' | 'holiday' | 'personal' | 'bereavement'

export const PTO_KIND_LABELS: Record<PtoKind, string> = {
  vacation: 'Vacation',
  sick: 'Sick',
  holiday: 'Holiday',
  personal: 'Personal',
  bereavement: 'Bereavement',
}

export interface PtoEntry {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  technician_id: string
  /** 'YYYY-MM-DD' — a day off is a calendar day, not an instant. */
  date: string
  hours: number
  kind: PtoKind
  /** Unpaid leave is still tracked: it's absence, just not money. */
  is_paid: boolean
  /** Rate SNAPSHOT, same rule as TimeEntry.hourly_rate — a raise never
   *  re-values vacation already taken. null = no wage set → hours, no money. */
  hourly_rate: number | null
  /** Set when this row was generated from the holiday calendar. */
  holiday_id: string | null
  notes: string | null
  /** Session 67. 'approved' = counts against planning availability — and the
   *  default, because an owner BOOKING time off is the approval. 'requested' =
   *  a worker asked and nobody has decided; it changes no plan. 'declined' =
   *  kept as a record, never subtracts anyone, never blocks a later booking. */
  status: PtoStatus
  decided_at: string | null
}

export type PtoStatus = 'requested' | 'approved' | 'declined'

export const PTO_STATUS_LABELS: Record<PtoStatus, string> = {
  requested: 'Requested',
  approved: 'Approved',
  declined: 'Declined',
}

// ── A worker's standard week ─────────────────────────────────────────────────
// Session 67. NO ROWS for a worker means their availability is ASSUMED, not
// that they never work — surfaces must label the assumption. A worker who HAS
// rows works only the weekdays holding an `available` one. Dated exceptions are
// PtoEntry rows, never edits here: changing someone's standard Monday next
// month must not rewrite the Mondays already worked.
export interface WorkerAvailability {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  technician_id: string
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number
  available: boolean
  /** 'HH:mm[:ss]'. Both set when available, both null when not. */
  start_time: string | null
  end_time: string | null
}

/** THE holiday calendar for the business. Payroll reads it; nothing guesses it. */
export interface Holiday {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  date: string
  name: string
  is_paid: boolean
  default_hours: number
}

/** Append-only audit trail, written by a DB trigger. NEVER a pricing source —
 *  past shifts carry their own snapshot rate (see TimeEntry.hourly_rate). */
export interface WageHistoryEntry {
  id: string
  created_at: string
  user_id: string
  technician_id: string
  old_wage: number | null
  new_wage: number | null
  note: string | null
  /** Monotonic. Order by this — created_at can tie. */
  seq: number
}

// ── Pay runs: what you ACTUALLY paid, frozen ─────────────────────────────────
// A finalized run snapshots the totals AND the OT rules used to reach them, so
// editing an old shift (or changing the OT rules) can never restate a cheque you
// already cut. Same reasoning as TimeEntry.hourly_rate, one level up.
export interface PayRun {
  id: string
  created_at: string
  user_id: string
  period_start: string
  period_end: string
  period_kind: PayPeriodKind
  finalized_at: string
  note: string | null
  ot_daily_hours: number | null
  ot_weekly_hours: number | null
  ot_multiplier: number
  pay_week_starts_on: number
  regular_minutes: number
  ot_minutes: number
  worked_pay: number
  pto_hours: number
  pto_pay: number
  gross_pay: number
  employee_count: number
}

/** One line per employee — THE pay stub. `technician_name` is snapshot so the
 *  stub survives the employee being deleted (their time entries do not). */
export interface PayRunLine {
  id: string
  created_at: string
  user_id: string
  pay_run_id: string
  technician_id: string | null
  technician_name: string
  technician_role: string | null
  regular_minutes: number
  ot_minutes: number
  blended_rate: number
  regular_pay: number
  ot_pay: number
  pto_hours: number
  pto_pay: number
  gross_pay: number
  shifts: number
  unrated_minutes: number
}

// How often the owner runs payroll. Drives the payroll summary window only —
// it never changes what a shift is worth.
export type PayPeriodKind = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly'

export const PAY_PERIOD_LABELS: Record<PayPeriodKind, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  semimonthly: 'Twice a month',
  monthly: 'Monthly',
}

// One note per (date, crew); crew_id null = the day-level note.
export interface DispatchNote {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  date: string
  crew_id: string | null
  body: string
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
  /** Who is coming — the two assignment columns, written together and never
   *  independently (see lib/crewAssignment). Optional so existing callers that
   *  do not offer the chooser keep working; absent means "leave as it is". */
  crew_id?: string | null
  technician_id?: string | null
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
  // ⭐ Set ONLY by the approval trigger (trg_change_order_apply_approval). Its
  // presence means this money exists because a customer approved a change order:
  // the row is not editable or deletable by any client (RLS), and lib/changeOrders
  // counts it from the change order instead, so it is never counted twice.
  change_order_id?: string | null
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

// Quick-add add-on chips for fast field entry. `recurringByDefault` flips the
// scope chooser to a recurring suggestion (program services). Keys are stable for BI.
// The LISTS live in the trade packs (lib/trades — lawn keeps the founding list
// verbatim, other trades fall back to the neutral pack's); the hardcoded
// ADDON_TEMPLATES that showed every business lawn chips was deleted 2026-07-16.
export interface AddonTemplate { key: string; label: string; recurringByDefault?: boolean }

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
  // The CUSTOMER's note — InvoicePDF renders this in a Notes box. Never put
  // system text or internal reasoning here.
  notes: string | null
  // The OWNER's note — never rendered on a PDF or in the portal. Home for
  // auto-draft provenance and the AutoPay hold flag (see AUTOPAY_HOLD_FLAG), so
  // editing the customer-facing note can't break hold detection.
  internal_notes: string | null
  // Snapshot breakdown for the customer (base service + add-ons + travel). Null
  // on legacy invoices → render the single (service_type, amount) row.
  line_items: InvoiceLineItem[] | null
  // True once the owner hand-edits this draft's breakdown in the invoice editor.
  // syncDraftInvoiceAmounts then leaves the draft alone, so a later job-price
  // change can't silently overwrite the owner's line_items/amount. Defaults false.
  line_items_edited?: boolean
  // ── Deposit / upfront request ──────────────────────────────────────────────
  // The GST-INCLUSIVE amount asked for up front. A deposit is a PARTIAL PAYMENT
  // of THIS invoice — there is no second invoice and no new kind of money row —
  // so only the request is stored. The percentage is derived from the live total
  // (lib/payments/deposit), never stored, so it can't drift. null = none asked.
  deposit_amount?: number | null
  // When the request was SUCCESSFULLY sent. null = asked for but not yet sent,
  // so the UI can never claim "sent" for a delivery that failed.
  deposit_requested_at?: string | null
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
  // TEAL, not a third blue. sent/viewed/partial were blue-400/cyan-400/sky-400 —
  // three adjacent hues at 10px, where the one that differs by MONEY HAVING
  // ARRIVED was the least distinguishable. The list now leans on this pill to
  // answer "which invoice?", so the axis reads as money: amber issued → blue/cyan
  // delivered → teal part-paid → emerald paid → violet overpaid → red overdue.
  partial:   'bg-teal-500/15 text-teal-300 border-teal-500/30',
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
  /** The quote/booking a PRE-INVOICE deposit secures (both recordDeposit legs
   *  carry it). Null on ordinary invoice payments. The scheduling gate derives
   *  "deposit received" from these rows — see lib/payments/depositGate. */
  quote_id?: string | null
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

// ── Money OUT: expenses, vendors, expense categories ─────────────────────────
// The counterpart to Payment above. `payments` is the single source of truth for
// money RECEIVED; these three are money SPENT. They are separate tables (an
// expense has no invoice, and trg_recompute_invoice_paid derives invoice state
// from payment rows) and ONE engine — lib/accounting — reads both.

export interface Vendor {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  name: string
  contact_name: string | null
  phone: string | null
  email: string | null
  website: string | null
  /** The owner's account number with this vendor. */
  account_number: string | null
  notes: string | null
  archived_at: string | null
}

export interface ExpenseCategory {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  name: string
  /**
   * Can the CRA claim be made for this? A parking fine is NOT deductible and is
   * still a real cost. This axis answers "can you claim it", NOT "is it a cost" —
   * that's `kind`.
   */
  tax_deductible: boolean
  /**
   * `operating` = a real business cost → in the P&L.
   * `owner_draw` = a distribution of profit, NOT a cost of earning it → excluded
   * from the P&L, still cash out in cash flow, and a reduction of equity on the
   * balance sheet. Counting a draw as cost turns a profitable month into a fake
   * loss and hits equity twice.
   */
  kind: ExpenseCategoryKind
  /** The QBO/Xero account this maps to — the seam the export layer fills in later. */
  external_account: string | null
  sort_order: number
  archived_at: string | null
}

export type ExpenseCategoryKind = 'operating' | 'owner_draw'

export const EXPENSE_CATEGORY_KINDS: { value: ExpenseCategoryKind; label: string }[] = [
  { value: 'operating', label: 'Business cost' },
  { value: 'owner_draw', label: 'Owner draw (not a cost)' },
]

export interface Expense {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  vendor_id: string | null
  category_id: string | null
  /** Optional job link — job costing falls out of this row, with no second table. */
  job_id: string | null
  /**
   * GROSS — the total paid, exactly as the receipt reads. NEVER net.
   * Cash flow sums this; the P&L sums `amount - tax_amount`. See lib/accounting.
   */
  amount: number
  /** Tax INCLUDED in `amount` (GST paid → an ITC). DB guards tax_amount <= amount. */
  tax_amount: number
  /** When the cost was INCURRED (the accrual date). Always set. */
  bill_date: string
  /**
   * When the CASH LEFT. **NULL = unpaid = accounts payable.**
   *
   * Nullable on purpose, mirroring `payments.paid_at`: both halves of the ledger
   * say "no date = the cash hasn't moved" the same way. Cash-basis reports filter
   * on this, so an unpaid bill is correctly not a cost yet — it's a liability on
   * the balance sheet instead.
   */
  spent_at: string | null
  description: string | null
  payment_method: string | null
  /** Receipt or invoice number from the vendor. */
  reference: string | null
  /** Object path in the private expense-receipts bucket. Read via signed URL only. */
  receipt_path: string | null
  /**
   * This cash bought an ASSET, not an operating cost.
   *
   * Buying a $5,000 mower is $5,000 of cash becoming $5,000 of asset — not a
   * $5,000 cost. Excluded from P&L cost; still real cash out in cash flow; the
   * asset itself lives in `fixed_assets`. Without this the balance sheet fails by
   * exactly the purchase price.
   */
  is_capital: boolean
  notes: string | null
  archived_at: string | null
}

/** An expense with its lookups resolved — what every list and report actually reads. */
export interface ExpenseWithRelations extends Expense {
  vendors?: Pick<Vendor, 'id' | 'name'> | null
  // `external_account` is here for the accountant export, which keys on it. Omitting
  // it from the join types would let the export compile and emit a blank code column
  // for every row — a file that looks complete and maps to nothing.
  expense_categories?: Pick<ExpenseCategory, 'id' | 'name' | 'tax_deductible' | 'kind' | 'external_account'> | null
  jobs?: { id: string; title: string | null; scheduled_date: string | null } | null
}

// Money fields are STRINGS here for the same reason service costs are: Number('')
// is 0, so a numeric field cannot tell "blank" from "zero". On an expense that
// distinction is the difference between "no tax on this receipt" and "I haven't
// entered the tax yet" — both are real, and only the owner knows which.
// Mapped '' → null / 0 explicitly on submit, never by coercion.
export interface ExpenseFormValues {
  vendor_id: string
  category_id: string
  job_id: string
  amount: string
  tax_amount: string
  /** When it was incurred. Required. */
  bill_date: string
  /**
   * `false` = an unpaid bill (A/P): `spent_at` goes NULL and no cash has moved.
   * A separate flag rather than "is spent_at blank", because blank is also what an
   * unfinished form looks like — and the difference is a liability.
   */
  paid: boolean
  /** When the cash left. Ignored unless `paid`. */
  spent_at: string
  /** This cash bought an asset — see Expense.is_capital. */
  is_capital: boolean
  description: string
  payment_method: string
  reference: string
  notes: string
}

// ── Balance sheet: fixed assets ──────────────────────────────────────────────
// A mower isn't an expense the day you buy it — it's an asset that wears out over
// years. Expensing it all in month one understates that month and overstates every
// month after, and leaves the balance sheet claiming the business owns nothing.

export type DepreciationMethod = 'straight_line' | 'declining_balance' | 'none'

// Deliberately NOT labelled "CCA": real CRA capital cost allowance has asset
// classes, the half-year rule and recapture, none of which this computes. These are
// BOOK figures for a balance sheet. Calling them CCA would invite filing on a
// number that isn't one.
export const DEPRECIATION_METHODS: { value: DepreciationMethod; label: string }[] = [
  { value: 'straight_line', label: 'Straight line (same amount each year)' },
  { value: 'declining_balance', label: 'Declining balance (a % of what\'s left)' },
  { value: 'none', label: "Don't depreciate (e.g. land)" },
]

export interface FixedAsset {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  name: string
  /** Same physical thing as an equipment row, seen from the money side. */
  equipment_id: string | null
  vendor_id: string | null
  /** GROSS cost — same convention as expenses.amount. */
  cost: number
  tax_amount: number
  in_service_date: string
  method: DepreciationMethod
  /** Required by the DB when method is straight_line. */
  useful_life_years: number | null
  salvage_value: number
  /** Percent per year, e.g. 20 = 20%. Required by the DB when declining_balance. */
  declining_rate: number | null
  disposed_at: string | null
  disposal_proceeds: number | null
  notes: string | null
  archived_at: string | null
}

export interface FixedAssetWithRelations extends FixedAsset {
  vendors?: Pick<Vendor, 'id' | 'name'> | null
}

export interface FixedAssetFormValues {
  name: string
  vendor_id: string
  cost: string
  tax_amount: string
  in_service_date: string
  method: DepreciationMethod
  useful_life_years: string
  salvage_value: string
  declining_rate: string
  disposed_at: string
  disposal_proceeds: string
  notes: string
}

// ── Balance sheet: liabilities ───────────────────────────────────────────────
// Owner-maintained SNAPSHOTS, not derived: there's no bank feed, so a computed
// loan balance would be fiction that looks like arithmetic. `as_of_date` is
// required so the balance sheet can say how stale it is.

export type LiabilityKind = 'loan' | 'credit_card' | 'line_of_credit' | 'other'

export const LIABILITY_KINDS: { value: LiabilityKind; label: string }[] = [
  { value: 'loan', label: 'Loan' },
  { value: 'credit_card', label: 'Credit card' },
  { value: 'line_of_credit', label: 'Line of credit' },
  { value: 'other', label: 'Other' },
]

export interface Liability {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  name: string
  kind: LiabilityKind
  current_balance: number
  as_of_date: string
  interest_rate: number | null
  notes: string | null
  archived_at: string | null
}

export interface LiabilityFormValues {
  name: string
  kind: LiabilityKind
  current_balance: string
  as_of_date: string
  interest_rate: string
  notes: string
}

export interface VendorFormValues {
  name: string
  contact_name: string
  phone: string
  email: string
  website: string
  account_number: string
  notes: string
}

// How the money left the business. Deliberately NOT PAYMENT_METHODS: that list is
// how customers pay the owner (and carries 'credit', which cannot buy fuel).
// Money out has its own vocabulary — cheque and debit are alive here even though
// they were retired on the money-in side.
export const EXPENSE_PAYMENT_METHODS: { value: string; label: string }[] = [
  { value: 'card', label: 'Card' },
  { value: 'debit', label: 'Debit' },
  { value: 'cash', label: 'Cash' },
  { value: 'etransfer', label: 'E-transfer' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'other', label: 'Other' },
]

export function expensePaymentMethodLabel(method: string | null | undefined): string {
  if (!method) return '—'
  const hit = EXPENSE_PAYMENT_METHODS.find(m => m.value === method)
  return hit ? hit.label : method.charAt(0).toUpperCase() + method.slice(1)
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
  /** ⭐ CUSTOMER-VISIBLE — printed in QuotePDF's Notes box and selected by
   *  get_portal_data. The scope note written FOR the customer. */
  notes: string | null
  /** 🔒 INTERNAL — the owner's price floor and private context. Never on a PDF,
   *  never in the portal payload (lib/noteScope). */
  internal_notes: string | null
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
  // ── ADR-002 · pricing provenance ───────────────────────────────────────────
  // "What priced this quote?" — read via resolveQuoteProvenance(), never by falling
  // back to the live config (that fallback IS the bug ADR-002 removes).
  // All four are null on the 55 pre-ADR quotes and stay that way: unknown is a fact.
  price_source: string | null                 // 'engine' | 'template_rate' | null
  pricing_config_version_id: string | null    // required whenever price_source='engine'
  value_grade: string | null                  // derived state, unreconstructable later
  nearby_count: number | null
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
  // Acceptance snapshot (RUN-2026-07-16c/d): what the customer actually agreed
  // to. Written ONLY by the portal-accept RPC and markWonPatch — app code reads
  // these, never writes them. They existed in the DB for twelve days before
  // being typed here, which is why no owner surface could warn "the customer
  // approved a different number".
  accepted_price: number | null
  // WHICH alternative the customer approved, when the quote offered several.
  // Null on every single-scope quote, which is all of them until an owner turns
  // options on. A composite FK (selected_option_id, id) → quote_options
  // (id, quote_id) makes "belongs to this quote" a database fact rather than a
  // convention, and ON DELETE RESTRICT keeps the approved alternative on the
  // record for good. ⛔ Not the same question as selected_cadence below: that is
  // WHICH SCHEDULE, this is WHICH SCOPE.
  selected_option_id: string | null
  selected_cadence: 'one_time' | 'weekly' | 'biweekly' | 'monthly' | null
  follow_up_count_at_acceptance: number | null
  // ── Deposit-gated scheduling ───────────────────────────────────────────────
  // The RULE: 'percent' of the accepted price, or a 'fixed' dollar figure, that
  // must be COLLECTED (ledger, payments.quote_id rows) before the booking is
  // secured. NULL pair = no deposit required — the quote behaves exactly as it
  // always has. Readiness is DERIVED by lib/payments/depositGate on every read;
  // there is deliberately no deposit_paid column to go stale after a refund.
  deposit_type: 'percent' | 'fixed' | null
  deposit_value: number | null
  // The customer's scheduling PREFERENCE — a request, never an appointment.
  // Written only by portal_set_scheduling_preference while status='accepted';
  // a real visit exists only when the owner schedules one.
  preferred_date: string | null
  preferred_date_2: string | null
  preferred_timing: 'morning' | 'afternoon' | null
  preferred_note: string | null
  // The owner's explicit "schedule without the required deposit" stamp. The
  // deposit stays owed — this records the decision, it doesn't waive the money.
  deposit_override_at: string | null
  service_template_id: string | null
  overgrowth_multiplier: number
  issued_date: string | null
  property_id: string | null
  user_id: string
  // The online-booking capture (submit_booking writes it; null everywhere else).
  // Non-null on a DRAFT is what makes that draft a LEAD (lib/leadResponse door 3)
  // rather than owner work-in-progress — which is why the priority queue's
  // quote_drafts row excludes it. Shape is the booking payload; nothing here
  // reads inside it, so it stays unknown.
  lead_meta?: unknown
  customers?: Pick<Customer, 'id' | 'name' | 'email' | 'phone'>
}

// One service line on a multi-service quote (quote_services child table).
// sort_order 0 is the PRIMARY service (mapped to the classic single-service
// fields in the builder); rows 1+ are additional services. When rows exist they
// are the source of truth; quotes.service_type/initial_price are derived caches
// (primary label + summed net) so the generated quotes.total stays correct.
/** What a quote line IS. A material is not a different kind of ROW — it's a
 *  different kind of LINE, so it rides quote_services rather than a second table
 *  that would need a second price rollup. See lib/quoteMaterials. */
export type QuoteLineKind = 'service' | 'material'

// ── One alternative version of the job ───────────────────────────────────────
// Budget / Recommended / Premium. MUTUALLY EXCLUSIVE with its siblings and with
// QuoteService below: a quote_services row ADDS to the quote total, an option
// row IS the quote total for whoever picks it. The database refuses a quote that
// has both (quote_options_shape_guard), because "is this line on top of my
// option or already inside it?" has no good answer.
// ⛔ V1 options carry no line items of their own — an option is a name, a
// description and a price, which is how an owner actually writes one.
export interface QuoteOption {
  id: string
  created_at: string
  updated_at: string
  quote_id: string
  user_id: string
  /** What the customer picks between — "Budget", "Walls + trim", "Full replacement". */
  name: string
  /** What this tier includes, in the owner's words. Optional. */
  description: string | null
  /** THE price of the whole job at this tier. Never a component of anything. */
  price: number
  sort_order: number
  /** At most one per quote — a partial unique index enforces it. */
  is_recommended: boolean
}

export interface QuoteService {
  id: string
  created_at: string
  user_id: string
  quote_id: string
  /** The line's display NAME. For a service, what you do; for a material, what
   *  you supply ("Mulch"). Historical column name — not a claim about content. */
  service_type: string
  service_template_id: string | null
  quantity: number
  unit: string | null            // any service_units code — see lib/units
  unit_price: number
  est_minutes: number | null
  discount_type: 'amount' | 'percent' | null
  discount_value: number | null
  notes: string | null
  sort_order: number
  /** Defaults to 'service' in the DB, so every pre-existing line keeps its
   *  meaning. A material line is an ESTIMATE ON THE QUOTE: it never reserves,
   *  allocates or deducts stock, and carries no cost. */
  kind: QuoteLineKind
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
  kind: QuoteLineKind
}

/** An option as the builder form holds it. Saved by delete-and-reinsert (the
 *  same shape quote_services uses), so `id` is carried only to render a stable
 *  key and to tell an existing row from a new one — never written back. */
export interface QuoteOptionInput {
  /** Present only for an option already on the quote; blank for a new row. */
  id?: string
  name: string
  description: string
  price: number
  is_recommended: boolean
}

export interface QuoteFormValues {
  customer_id: string
  customer_name: string
  // Optional contact captured when entering a brand-new person manually, so the
  // save flow can create/match the customer (no duplicate) and store contact info.
  customer_phone?: string
  customer_email?: string
  // Optional "how did they find you?" quick-pick shown only for a brand-new
  // person. '' = not sure — a legitimate answer that stays unknown; never required.
  acquisition_source?: string
  address: string
  service_type: string
  service_template_id: string
  overgrowth_multiplier: number
  distance_km: number
  hours: number
  crew_size: number
  rate: number
  travel_fee: number
  /** ⭐ CUSTOMER-VISIBLE — prints on the quote PDF and shows in the portal. */
  notes: string
  /** 🔒 INTERNAL — the owner's price floor and private context (lib/noteScope). */
  internal_notes: string
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
  // ADR-002 · derived state, snapshotted onto the quote at write time.
  //
  // These pass THE test that separates the two kinds of pricing input: "could two
  // quotes written in the SAME SECOND legitimately differ on this?" Yes — the grade
  // comes from live route context (where the jobs happened to be that day), so it is
  // not configuration and can never be versioned as configuration. It is also
  // unreconstructable afterwards: property 0071's measurement snapshot, taken two
  // seconds before its quote, reads the neutral curve while the quote reads A+.
  //
  // null = no grade was computed (the owner never measured). That is a fact, not a
  // gap — do NOT default it to a grade.
  value_grade: string | null
  nearby_count: number | null
  // Additional service lines beyond the primary one (multi-service quotes).
  services: QuoteServiceInput[]
  // ── Alternatives (Budget / Standard / Premium) ────────────────────────────
  // `has_options` is the owner's DECLARED intent — the "Offer multiple options"
  // switch — and it is a separate fact from the array being non-empty. Turning
  // the switch off must leave the rows in the form (so turning it back on
  // doesn't lose the typing) while the save path writes none of them; deriving
  // the mode from `options.length` instead would make "off" and "not typed yet"
  // the same state and silently resurrect a discarded set.
  // ⛔ MUTUALLY EXCLUSIVE with `services`: an option's price IS the whole job,
  // a service line ADDS to it. The database refuses a quote holding both.
  has_options: boolean
  options: QuoteOptionInput[]
  // ── Scheduling deposit (deposit-gated scheduling) ─────────────────────────
  // The owner's per-quote rule: require this much collected before the booking
  // is secured. '' = off (the default — a normal quote gains no extra step).
  // Value semantics follow deposit_type: percent of the accepted price, or
  // fixed dollars. Readiness itself is DERIVED (lib/payments/depositGate).
  deposit_type: '' | 'percent' | 'fixed'
  deposit_value: number
}

export interface CustomerFormValues {
  // Customer V2: the form carries the RELATIONSHIP only — contact,
  // communication, marketing, notes, tags. Addresses live on properties
  // (PropertySelect's find-or-create is THE way one is added); the guided
  // first-property step after creation replaces the old inline address block.
  name: string
  email: string
  phone: string
  notes: string
  acquisition_source: string
  referred_by_customer_id: string
  birthday: string
  anniversary: string
  tags: string[]
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
  // Soft delete. A hard DELETE cascades crm_campaign_log, which is BOTH the audit
  // trail (who we messaged, when) and the per-period dedupe ledger — so an undo
  // would restore a live campaign with an empty ledger and message everyone again.
  archived_at: string | null
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
  // Trade/vertical key (registry: src/lib/trades). Selects seed data and default
  // copy ONLY — engines never branch on it. Optional because rows predate the
  // column in older local snapshots; the DB default is 'lawn_landscaping'.
  business_type?: string
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
  // ── Payroll: overtime rules + pay period ───────────────────────────────────
  // Consumed ONLY by lib/payroll (the one payroll engine). Overtime law is
  // jurisdictional, so both thresholds default to null = "that rule doesn't
  // apply" — EdgeQuote never guesses a threshold and silently inflates pay.
  /** Hours in a DAY after which OT applies. null = no daily rule (e.g. Ontario). */
  ot_daily_hours: number | null
  /** Hours in a WORK WEEK after which OT applies. null = no weekly rule. */
  ot_weekly_hours: number | null
  /** OT pay multiplier (1.5 = time-and-a-half). Never below 1. */
  ot_multiplier: number
  pay_period: PayPeriodKind
  /** Any known period start; biweekly needs it to know WHICH two weeks. */
  pay_period_anchor: string | null
  /** 0=Sun…6=Sat — the OT work-week boundary. Explicit, never assumed. */
  pay_week_starts_on: number
  // Uploaded-logo display scale in percent (100 = default size).
  logo_scale: number | null
  // REVIVED — the owner dashboard's band layout (lib/dashboard/layout), the
  // same {order, hidden} shape it always held. Dead between 019c24c (the old
  // home-dashboard shell it served was removed) and Session 97, which made the
  // explicit call to reuse it rather than add a twin column: same purpose,
  // same shape, no migration. Values the OLD shell stored name deleted card
  // ids; normalizeDashboardLayout drops unknown ids, so a legacy row resolves
  // to the default composition. Read/write ONLY through lib/dashboard/layout.
  // The analytics workspace uses `analytics_layout` below, NOT this.
  dashboard_cards: { order: string[]; hidden: string[] } | null
  // Analytics workspace layout: widget order + hidden set for
  // /dashboard/intelligence. Unknown ids are ignored and missing ids fall back to
  // the default order — see lib/analytics/layout.normalizeLayout.
  analytics_layout: { order: string[]; hidden: string[] } | null
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
  // The CRA requires the supplier's GST/HST registration number on any invoice of
  // $30+ for the CUSTOMER to claim an input tax credit — missing = ITC denied on
  // audit. Also mandatory on a credit note (ETA s.232(3)). null = not registered.
  gst_number?: string | null
  // ── Balance sheet opening position ──
  // Cash is not derivable from a payment ledger alone: it knows every movement
  // since it started, but not what was in the bank the day before. Without these,
  // "cash" is a movement, not a position — so the owner states it once.
  opening_bank_balance?: number | null
  opening_balance_date?: string | null
  /**
   * Owner capital already in the business at the opening date.
   * NULL = unknown, and it stays unknown: the balance sheet reports an unexplained
   * difference rather than plugging this to force Assets = Liabilities + Equity.
   */
  opening_equity?: number | null
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
  // What this service COSTS to deliver, per unit. Both nullable, and null means
  // "never told us" — NOT zero. lib/margin.ts turns them into a margin only when
  // known, so a service with no cost shows no margin instead of claiming 100%.
  unit_cost: number | null      // labour / subcontract
  material_cost: number | null  // materials consumed
  is_favorite: boolean
  // Recurrence eligibility (Session 46) — the ONE place a service may be
  // declared repeatable or one-time. null = the owner hasn't said; suggestions
  // then require behavioural cadence evidence (lib/serviceRecurrence). Never
  // inferred from the service's name.
  recurrence: 'one_time' | 'recurring_ok' | 'usually_recurring' | null
  // Default checklist (Job Forms V1, Session 69): visits created for this
  // service carry it. Resolved lazily at attach time — changing it never
  // rewrites a form already minted on a visit. null = no checklist.
  form_template_id: string | null
}

export interface ServiceTemplateFormValues {
  name: string
  category: string
  default_rate: number
  pricing_display_type: PricingDisplayType
  default_description: string
  notes: string
  is_active: boolean
  // STRINGS on purpose, unlike default_rate. A number-typed field cannot express
  // the difference between "0" and "left blank", and `Number('')` is 0 — which
  // would silently record every untouched service as costing nothing, i.e. 100%
  // margin. Held as text here and mapped '' → null on submit.
  unit_cost: string
  material_cost: string
  is_favorite: boolean
  // '' = not set (maps to null on submit) — same blank-vs-zero discipline as
  // the cost fields above.
  recurrence: string
  // '' = no default checklist (maps to null on submit).
  form_template_id: string
}

// ── Service bundles ──────────────────────────────────────────────────────────
// THREE nouns, deliberately distinct, because this repo has been bitten before
// by one word meaning three things:
//   ServiceTemplate — a CATALOGUE row. ONE service, and the rate it usually
//                     sells at. Owns the price.
//   ServiceBundle   — a named, reusable SET of lines ("Spring Cleanup"). SEEDS
//                     a quote's scope. Owns no price of its own by default.
//   QuoteOption     — Budget/Recommended/Premium: ALTERNATIVE whole-job prices
//                     the customer picks ONE of. An option REPLACES the total;
//                     a bundle seeds the lines that ADD UP to it. The database
//                     refuses a quote holding both.
// ⛔ Do not rename a bundle to a "template" — that noun is the catalogue's.
export interface ServiceBundle {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  /** What the owner picks from the list — "Spring Cleanup", "Move-out clean". */
  name: string
  /** A reminder of what it covers, for the owner. Never shown to a customer. */
  description: string | null
  sort_order: number
}

/** One line a bundle will lay down. Field-for-field the shape of the
 *  `quote_services` row it becomes, so applying one needs no translation. */
export interface ServiceBundleItem {
  id: string
  created_at: string
  user_id: string
  bundle_id: string
  /** The catalogue service this line IS, when it is one. Null = one-off work
   *  named by hand — the same freedom the quote builder already allows. */
  service_template_id: string | null
  /** The line's display name (→ `quote_services.service_type`). */
  name: string
  quantity: number
  unit: string | null
  /** ⭐ NULL means "follow the catalogue rate at apply time" — NOT zero, and
   *  not a promise. A number here is one the owner typed for this bundle; it
   *  seeds the line's unit_price and nothing ever recomputes it. This column
   *  is the whole of the bundle's price semantics: there is no rule, curve or
   *  multiplier anywhere, and no pricing engine is consulted. */
  unit_price: number | null
  est_minutes: number | null
  notes: string | null
  kind: QuoteLineKind
  sort_order: number
}

/** A bundle with its lines, as every surface reads it. */
export interface ServiceBundleWithItems extends ServiceBundle {
  items: ServiceBundleItem[]
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
  gst_number: string
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

// OVERGROWTH_LEVELS and SERVICE_TYPES were deleted here (2026-07-15). Both were
// dead — zero references anywhere in src/, no type alias, no importer — and both
// hardcoded a lawn trade: a fixed 10-service menu and a grass-height multiplier.
// The live equivalents are owner-owned data, not constants: service_templates IS
// the service catalogue, and overgrowth is quotes.overgrowth_multiplier, set from
// the measure tool. Keeping dead lawn lists around is how the next reader
// concludes the platform has a home industry.


// THE owner-facing word for each stored status. Presentation only — the stored
// values are unchanged, and this is the one place the wording lives so every
// surface says the same thing.
//
// `accepted` reads "Approved" because that is literally what the row records: the
// customer consenting. portal_accept_quote sets status='accepted' and snapshots
// accepted_price at the instant of consent. "Accepted" is the database's word for
// it; "Approved" is the owner's.
export const STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Approved',
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

// ── Integrations platform (api_keys / webhook_* / inbound_*) ────────────────
// Rows for the 2026-07-15 integrations migration. API keys never carry the
// plaintext key (hash + display prefix only); endpoint secrets and inbound
// tokens ARE owner-readable — they're the owner's own credentials.

export type ApiScopeName = 'read' | 'write'

export interface ApiKeyRow {
  id: string
  created_at: string
  user_id: string
  name: string
  prefix: string
  scopes: ApiScopeName[]
  last_used_at: string | null
  usage_count: number
  revoked_at: string | null
}

export type WebhookSource = 'manual' | 'api' | 'zapier' | 'make'

export interface WebhookEndpointRow {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  url: string
  description: string | null
  secret: string
  events: string[] // ['*'] or exact event keys
  source: WebhookSource
  active: boolean
  disabled_reason: string | null
  consecutive_failures: number
  last_success_at: string | null
  last_failure_at: string | null
}

export type WebhookDeliveryStatus = 'pending' | 'processing' | 'success' | 'dead'

export interface WebhookDeliveryRow {
  id: string
  created_at: string
  user_id: string
  endpoint_id: string
  event_id: string | null
  event: string
  payload: Record<string, unknown>
  status: WebhookDeliveryStatus
  attempts: number
  next_attempt_at: string
  last_attempt_at: string | null
  delivered_at: string | null
  response_status: number | null
  response_body: string | null
  duration_ms: number | null
  last_error: string | null
}

export type InboundAction = 'lead' | 'customer'

export interface InboundWebhookRow {
  id: string
  created_at: string
  user_id: string
  name: string
  token: string
  action: InboundAction
  active: boolean
  received_count: number
  last_received_at: string | null
}

export interface InboundEventRow {
  id: string
  created_at: string
  user_id: string
  hook_id: string
  ok: boolean
  summary: string | null
  entity_id: string | null
  payload: Record<string, unknown>
}

export interface IntegrationEventRow {
  id: string
  created_at: string
  user_id: string
  event: string
  entity_type: string
  entity_id: string | null
  payload: Record<string, unknown>
}

// ── Custom fields ────────────────────────────────────────────────────────────
// The owner-defined attribute store. `src/lib/customFields.ts` is the engine;
// the constraints in supabase/migrations/*_custom_fields_v1.sql are the law.
//
// ⚠️ These values are INTERNAL — owner screens only. There is deliberately no
// visibility flag on the definition; see the note at the top of customFields.ts
// and src/lib/noteScope.ts for why, and for where exposure would be added later.

/** One field an owner has defined for a kind of record. */
export interface CustomFieldDefinition {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  /** 'customer' | 'property' | 'job' — see CUSTOM_FIELD_ENTITIES. */
  entity: string
  /** Stable slug. Immutable once created; it is the export/import identity. */
  field_key: string
  label: string
  /** See CUSTOM_FIELD_TYPES. */
  field_type: string
  /** Dropdown choices as [{ value, label }]. Empty for every other type. */
  options: { value: string; label: string }[]
  help_text: string | null
  sort_order: number
  /** Archived fields stop being offered and keep every answer they collected. */
  archived_at: string | null
}

/**
 * One answer. Exactly one `value_*` column is set, and which one is decided by
 * `field_type` — enforced by a CHECK, not by whoever wrote the last INSERT.
 */
export interface CustomFieldValue {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  definition_id: string
  entity: string
  field_type: string
  customer_id: string | null
  property_id: string | null
  job_id: string | null
  value_text: string | null
  value_number: number | null
  value_boolean: boolean | null
  value_date: string | null
}
