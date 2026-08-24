// ── What "your data" means, written down once ────────────────────────────────
// The export is a list of tables, a list of columns per table, and nothing else.
// Keeping that list as DATA (not as a hand-written query per entity) is what
// makes the security property checkable: `scripts/verify-export.ts` reads this
// file and proves no entity fetches a denied column.
//
// ⭐ THE INVARIANT: `select` is EXACTLY the set of columns fetched from the
// database. There is no "fetch it and don't print it" path. A secret this file
// does not name is never read into the process at all — which is a far stronger
// statement than "we remembered to leave it out of the CSV".
//
// ⭐ THE SECOND INVARIANT: every read is a FLAT select against ONE table,
// filtered by the signed-in owner's id. No PostgREST embedded resources, no
// joins. A join is the shape that walks from a row you own to a row you don't;
// there isn't one here to get wrong.

import type { CsvColumn } from '@/lib/csv'

export type ExportRow = Record<string, unknown>

export interface ExportEntity {
  /** Stable key used in manifest.json and the audit record. */
  key: string
  /** Name inside the archive. */
  file: string
  /** The single table this reads. */
  table: string
  /** Human name, used in README.txt. */
  label: string
  /** One line saying what the file IS — especially what its money columns mean. */
  note: string
  /** Deterministic paging key. `pageAll` refuses to page without one. */
  orderBy: string
  /** EXACTLY the columns fetched. Nothing else is read. */
  select: string[]
  /** What lands in the CSV, in order. */
  columns: CsvColumn<ExportRow>[]
  /** Optional row multiplication (one invoice row -> many line-item rows). */
  expand?: (rows: ExportRow[]) => ExportRow[]
}

// ── Columns the export must never fetch ──────────────────────────────────────
// Enforced by verify:export against every entity's `select`. Three families:
//   1. credentials and capability tokens — a portal token IS the login,
//   2. payment-provider handles — Stripe's own object ids, which belong to the
//      Stripe account rather than to the business's records,
//   3. `user_id` — the owner's auth uid. Every row carries the same value, so it
//      adds nothing to a portability archive, and it is the exact identifier a
//      storage-path attack needed in the tenant-boundary audit. Its absence is
//      also the sharpest tenant test available: no auth uid may appear anywhere
//      in the archive, so a foreign row could not hide.
export const DENIED_COLUMNS: readonly string[] = [
  'user_id',
  'auth_user_id',
  'stripe_customer_id',
  'stripe_session_id',
  'stripe_payment_intent',
  'token',
  'booking_token',
  'portal_token',
  'access_token',
  'refresh_token',
  'secret',
  'api_key',
  'key_hash',
  'password',
  'storage_path',
  'receipt_path',
]

/** Substrings that make a column name denied even if not listed verbatim. */
export const DENIED_PATTERNS: readonly string[] = ['token', 'secret', 'password', 'stripe_', 'api_key']

// ── Cell formatting ──────────────────────────────────────────────────────────
// One default so every file reads the same way. Dates arrive from PostgREST as
// ISO-8601 strings and are passed through untouched — ISO is the one date format
// every spreadsheet and every importer agrees on. Numbers stay numbers so a
// spreadsheet can sum a column without a text-to-number step.
function cell(v: unknown): string | number | null {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (Array.isArray(v)) return v.map(x => (x == null ? '' : String(x))).join('; ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** A column read straight off the row. `name` is both the header and the source. */
function col(name: string): CsvColumn<ExportRow> {
  return { label: name, value: (r) => cell(r[name]) }
}

/** Every column of `select`, in order — the common case. */
function cols(names: string[]): CsvColumn<ExportRow>[] {
  return names.map(col)
}

// ── The entities ─────────────────────────────────────────────────────────────
// Ordered so a reader meets them the way the business works: who you serve,
// where, what you quoted, what you did, what you billed, what you were paid.

const CUSTOMERS = [
  'id', 'created_at', 'updated_at', 'name', 'email', 'phone',
  'address', 'city', 'province', 'postal_code', 'notes', 'tags',
  'acquisition_source', 'referred_by_customer_id',
  'preferred_days', 'avoid_days', 'pref_time_start', 'pref_time_end',
  'sms_opt_in', 'email_opt_in', 'photo_marketing_consent', 'photo_marketing_consent_at',
  'autopay_enabled', 'autopay_charge_mode',
  'review_requested_at', 'review_source', 'review_rating', 'review_declined_at',
  'birthday', 'anniversary', 'last_contacted_at', 'archived_at',
]

const PROPERTIES = [
  'id', 'created_at', 'updated_at', 'customer_id',
  'address', 'city', 'province', 'postal_code', 'neighborhood', 'lat', 'lng',
  'google_place_id', 'is_primary',
  'lot_size', 'lawn_sqft', 'fence_length', 'mulch_area', 'rock_area', 'driveway_area',
  'property_travel_distance_km', 'property_travel_fee',
  'preferred_days', 'avoid_days', 'pref_time_start', 'pref_time_end', 'notes',
]

const LEADS = [
  'id', 'created_at', 'submitted_at', 'status', 'customer_id', 'quote_id',
  'contact_name', 'contact_first', 'contact_last', 'email', 'phone', 'preferred_contact',
  'address', 'city', 'province', 'postal_code', 'lat', 'lng',
  'requested_services', 'frequency', 'yard_condition', 'lawn_sqft',
  'website_estimated_price', 'travel_distance_km', 'travel_fee',
  'budget', 'preferred_schedule', 'notes',
]

const QUOTES = [
  'id', 'created_at', 'updated_at', 'quote_number', 'status',
  'customer_id', 'customer_name', 'property_id', 'address', 'service_type',
  'issued_date', 'valid_until', 'sent_at',
  'hours', 'crew_size', 'rate', 'man_hours', 'measured_sqft',
  'travel_distance_km', 'travel_fee', 'subtotal', 'total',
  'initial_price', 'accepted_price', 'selected_cadence', 'selected_option_id',
  'weekly_price', 'biweekly_price', 'monthly_price',
  'price_source', 'pricing_confidence', 'value_grade',
  'follow_up_count', 'last_followed_up_at', 'accepted_after_followup', 'notes',
]

const QUOTE_SERVICES = [
  'id', 'created_at', 'quote_id', 'service_type', 'kind',
  'quantity', 'unit', 'unit_price', 'est_minutes',
  'discount_type', 'discount_value', 'sort_order', 'notes',
]

const QUOTE_OPTIONS = [
  'id', 'created_at', 'updated_at', 'quote_id',
  'name', 'description', 'price', 'sort_order', 'is_recommended',
]

const VISITS = [
  'id', 'created_at', 'updated_at', 'customer_id', 'property_id', 'quote_id', 'recurrence_id',
  'title', 'service_type', 'status', 'scheduled_date', 'start_time', 'end_time',
  'duration_minutes', 'actual_minutes', 'crew_size', 'price',
  'started_at', 'completed_at', 'on_my_way_at', 'is_initial_visit', 'route_order', 'notes',
]

const RECURRING_JOBS = [
  'id', 'created_at', 'customer_id', 'freq',
  'interval_unit', 'interval_count', 'start_date', 'end_date', 'end_count',
]

const VISIT_LINE_ITEMS = [
  'id', 'created_at', 'job_id', 'description', 'amount',
  'service_key', 'service_category', 'recurring', 'group_id',
]

const INVOICES = [
  'id', 'created_at', 'updated_at', 'invoice_number', 'status',
  'customer_id', 'customer_name', 'property_id', 'quote_id', 'job_id',
  'address', 'service_type',
  'amount', 'amount_paid', 'discount_type', 'discount_value',
  'deposit_amount', 'deposit_requested_at',
  'issued_date', 'due_date', 'paid_at', 'payment_method',
  'viewed_at', 'last_reminded_at', 'reminder_count', 'notes', 'internal_notes',
]

const PAYMENTS = [
  'id', 'created_at', 'customer_id', 'invoice_id',
  'amount', 'currency', 'status', 'provider', 'method', 'kind', 'paid_at', 'notes',
]

const EXPENSES = [
  'id', 'created_at', 'updated_at', 'job_id', 'vendor_id', 'category_id',
  'amount', 'tax_amount', 'spent_at', 'bill_date',
  'description', 'payment_method', 'reference', 'is_capital', 'notes', 'archived_at',
]

const VENDORS = [
  'id', 'created_at', 'name', 'contact_name', 'phone', 'email', 'website',
  'account_number', 'notes', 'archived_at',
]

const EXPENSE_CATEGORIES = [
  'id', 'created_at', 'name', 'kind', 'tax_deductible', 'external_account', 'sort_order', 'archived_at',
]

const FOLLOW_UPS = [
  'id', 'created_at', 'updated_at', 'customer_id', 'quote_id',
  'due_on', 'reason', 'status', 'source', 'completed_at',
]

// `options` is jsonb and exports as its JSON text — the choice list is part of
// what the field IS, and a dropdown answer is meaningless without it.
const CUSTOM_FIELD_DEFINITIONS = [
  'id', 'created_at', 'updated_at', 'entity', 'field_key', 'label', 'field_type',
  'options', 'help_text', 'sort_order', 'archived_at',
]

const CUSTOM_FIELD_VALUES = [
  'id', 'created_at', 'updated_at', 'definition_id', 'entity', 'field_type',
  'customer_id', 'property_id', 'job_id',
  'value_text', 'value_number', 'value_boolean', 'value_date',
]

const PHOTOS = [
  'id', 'created_at', 'job_id', 'property_id', 'customer_id',
  'kind', 'caption', 'taken_at', 'content_hash',
]

export const EXPORT_ENTITIES: ExportEntity[] = [
  {
    key: 'customers', file: 'customers.csv', table: 'customers', label: 'Customers',
    note: 'Everyone you serve. referred_by_customer_id points at another row in this file.',
    orderBy: 'id', select: CUSTOMERS, columns: cols(CUSTOMERS),
  },
  {
    key: 'properties', file: 'properties.csv', table: 'properties', label: 'Service locations',
    note: 'The addresses you work at. customer_id points at customers.csv. Measurements are in the units the app stores them in (square feet, linear feet).',
    orderBy: 'id', select: PROPERTIES, columns: cols(PROPERTIES),
  },
  {
    key: 'leads', file: 'leads.csv', table: 'website_leads', label: 'Leads',
    note: 'Enquiries from your website and booking page. customer_id / quote_id are filled once a lead becomes one. website_estimated_price is what the public page showed the visitor, not a price you set.',
    orderBy: 'id', select: LEADS, columns: cols(LEADS),
  },
  {
    key: 'quotes', file: 'quotes.csv', table: 'quotes', label: 'Quotes',
    note: 'total is the quote total as stored by the app. accepted_price is what the customer actually accepted, when they did. Nothing here is recalculated on export.',
    orderBy: 'id', select: QUOTES, columns: cols(QUOTES),
  },
  {
    key: 'quote_services', file: 'quote-services.csv', table: 'quote_services', label: 'Quote services',
    note: 'The service lines that make up a quote. quote_id points at quotes.csv.',
    orderBy: 'id', select: QUOTE_SERVICES, columns: cols(QUOTE_SERVICES),
  },
  {
    key: 'quote_options', file: 'quote-options.csv', table: 'quote_options', label: 'Quote options',
    note: 'Good/better/best options offered on a quote. quotes.selected_option_id names the one chosen.',
    orderBy: 'id', select: QUOTE_OPTIONS, columns: cols(QUOTE_OPTIONS),
  },
  {
    key: 'recurring_jobs', file: 'recurring-jobs.csv', table: 'job_recurrences', label: 'Recurring jobs',
    note: 'The ongoing arrangement — "every 2 weeks from May". Each occurrence it produced is a row in visits.csv (visits.recurrence_id).',
    orderBy: 'id', select: RECURRING_JOBS, columns: cols(RECURRING_JOBS),
  },
  {
    key: 'visits', file: 'visits.csv', table: 'jobs', label: 'Visits',
    note: 'One row per scheduled visit — this is the app\'s "jobs" table, and a row in it is a single occurrence. price is the price set for that visit. actual_minutes is blank when nobody recorded time; it is never a zero.',
    orderBy: 'id', select: VISITS, columns: cols(VISITS),
  },
  {
    key: 'visit_line_items', file: 'visit-line-items.csv', table: 'job_line_items', label: 'Visit line items',
    note: 'Extra priced lines attached to a visit. job_id points at visits.csv.',
    orderBy: 'id', select: VISIT_LINE_ITEMS, columns: cols(VISIT_LINE_ITEMS),
  },
  {
    key: 'invoices', file: 'invoices.csv', table: 'invoices', label: 'Invoices',
    note: 'amount is the stored invoice subtotal — your revenue for the invoice, after any discount and BEFORE sales tax. amount_paid is how much has been recorded against it. status is the stored status. No balance column is included: see README.',
    orderBy: 'id', select: INVOICES, columns: cols(INVOICES),
  },
  {
    key: 'invoice_line_items', file: 'invoice-line-items.csv', table: 'invoices', label: 'Invoice line items',
    note: 'The line items stored on each invoice, one row per line. Flattened from the invoice record; the amounts are copied exactly and are not re-totalled.',
    orderBy: 'id',
    select: ['id', 'invoice_number', 'line_items'],
    columns: [
      { label: 'invoice_id', value: (r) => cell(r.invoice_id) },
      { label: 'invoice_number', value: (r) => cell(r.invoice_number) },
      { label: 'line_number', value: (r) => cell(r.line_number) },
      { label: 'kind', value: (r) => cell(r.kind) },
      { label: 'description', value: (r) => cell(r.description) },
      { label: 'amount', value: (r) => cell(r.amount) },
    ],
    expand: (rows) => rows.flatMap((r) => {
      const items = Array.isArray(r.line_items) ? r.line_items : []
      return items.map((raw, i) => {
        const item = (raw ?? {}) as Record<string, unknown>
        return {
          invoice_id: r.id,
          invoice_number: r.invoice_number,
          line_number: i + 1,
          kind: item.kind ?? null,
          description: item.description ?? null,
          amount: item.amount ?? null,
        }
      })
    }),
  },
  {
    key: 'payments', file: 'payments.csv', table: 'payments', label: 'Payments',
    note: 'The record of money received. This is the ledger: one row per payment, against an invoice where there is one. Card processor reference ids are deliberately not included.',
    orderBy: 'id', select: PAYMENTS, columns: cols(PAYMENTS),
  },
  {
    key: 'expenses', file: 'expenses.csv', table: 'expenses', label: 'Expenses',
    note: 'What you spent. amount excludes tax_amount. vendor_id and category_id point at vendors.csv and expense-categories.csv. Receipt images are not included.',
    orderBy: 'id', select: EXPENSES, columns: cols(EXPENSES),
  },
  {
    key: 'vendors', file: 'vendors.csv', table: 'vendors', label: 'Vendors',
    note: 'Who you buy from — included so expenses.vendor_id resolves to a name.',
    orderBy: 'id', select: VENDORS, columns: cols(VENDORS),
  },
  {
    key: 'expense_categories', file: 'expense-categories.csv', table: 'expense_categories', label: 'Expense categories',
    note: 'Your expense categories — included so expenses.category_id resolves to a name.',
    orderBy: 'id', select: EXPENSE_CATEGORIES, columns: cols(EXPENSE_CATEGORIES),
  },
  {
    key: 'follow_ups', file: 'follow-ups.csv', table: 'follow_ups', label: 'Follow-ups',
    note: 'Reminders you set for yourself to get back to someone. Not the automatic quote chaser.',
    orderBy: 'id', select: FOLLOW_UPS, columns: cols(FOLLOW_UPS),
  },
  {
    key: 'photos', file: 'photos.csv', table: 'job_photos', label: 'Photos (details only)',
    note: 'A row per job photo you have taken. THE IMAGE FILES ARE NOT IN THIS ARCHIVE — see README. content_hash identifies the image itself.',
    orderBy: 'id', select: PHOTOS, columns: cols(PHOTOS),
  },
  // ── Custom fields ──────────────────────────────────────────────────────────
  // Two files rather than extra columns on customers.csv / properties.csv /
  // visits.csv, for the reason the invariant at the top of this file states: every
  // read here is a FLAT select against ONE table. Folding runtime-defined
  // attributes into another entity's row would need a join and would make each of
  // those files' column set depend on the account being exported.
  //
  // Together they are self-describing: the definitions file says what each field
  // IS, and every value names its definition_id plus the id of the record it is
  // about, so the association survives the round trip without consulting EdgeHQ.
  {
    key: 'custom_field_definitions', file: 'custom-fields.csv', table: 'custom_field_definitions',
    label: 'Custom fields',
    note: 'The fields you defined yourself. entity says what kind of record each is about; field_key is its stable name; archived_at means it is retired but its answers are kept.',
    orderBy: 'id', select: CUSTOM_FIELD_DEFINITIONS, columns: cols(CUSTOM_FIELD_DEFINITIONS),
  },
  {
    key: 'custom_field_values', file: 'custom-field-values.csv', table: 'custom_field_values',
    label: 'Custom field answers',
    note: 'One row per answer. definition_id points at custom-fields.csv; exactly one of customer_id / property_id / job_id names the record it is about, and exactly one value_ column is filled, chosen by field_type.',
    orderBy: 'id', select: CUSTOM_FIELD_VALUES, columns: cols(CUSTOM_FIELD_VALUES),
  },
]

/** Machine-readable statement of what an archive deliberately leaves out. */
export const EXPORT_EXCLUSIONS: { what: string; why: string }[] = [
  { what: 'Photo, receipt and document files', why: 'Only their details are exported. Bundling originals can run to gigabytes and is not safe to build in one request — planned separately.' },
  { what: 'Customer portal links', why: 'A portal link is a password. Exporting one would put working logins to your customers\' records in a file.' },
  { what: 'Card processor reference ids', why: 'Stripe\'s own identifiers for customers, sessions and payments belong to the payment account, not to your records. The money itself is in payments.csv.' },
  { what: 'API keys, webhook secrets and connected social accounts', why: 'These are credentials.' },
  { what: 'Your EdgeQuote account id', why: 'It appears on every row and says nothing about your business. Leaving it out means no account identifier appears anywhere in this archive.' },
  { what: 'Message and notification history', why: 'Not part of this first export — planned separately.' },
  { what: 'Staff, timesheets and payroll', why: 'Not part of this first export — planned separately.' },
  { what: 'Settings, pricing configuration and templates', why: 'These describe how EdgeQuote is set up rather than what your business did.' },
]

export const EXPORT_FORMAT_VERSION = 1
