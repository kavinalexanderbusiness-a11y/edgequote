// THE integration event catalog — the single source of truth for what events
// exist, what their payloads carry, and what the /api/v1 serializers return.
//
// The actual capture happens in DB triggers (supabase/RUN-2026-07-15-
// integrations-platform.sql, capture_integration_event) because domain writes
// come from the dashboard, the customer portal RPCs, the public booking API,
// Stripe webhooks AND crons — triggers are the only choke point they share.
// This file mirrors those payloads for the app side: docs, Zapier samples,
// endpoint validation, and the /api/v1 field lists. payloadKeys here MUST
// match the jsonb_build_object calls in the migration — verify:integrations
// pins serializer/docs/sample agreement so a drift is a failing check.
//
// Pure module: no server imports, safe for client components and tsx scripts.

export type IntegrationEntity =
  | 'customer'
  | 'quote'
  | 'job'
  | 'invoice'
  | 'payment'
  | 'request'

export interface IntegrationEventDef {
  key: string // 'quote.accepted' — entity.action, stable API surface
  entity: IntegrationEntity
  label: string
  description: string
  /** Exact keys the DB trigger snapshot carries for this event. */
  payloadKeys: string[]
  /** A realistic sample used by docs, Zapier perform samples and test sends. */
  sample: Record<string, unknown>
}

const CUSTOMER_KEYS = ['id', 'name', 'email', 'phone', 'address', 'city', 'acquisition_source', 'created_at']
const QUOTE_KEYS = ['id', 'quote_number', 'customer_id', 'customer_name', 'service_type', 'status', 'total', 'address', 'created_at']
const JOB_KEYS = ['id', 'customer_id', 'title', 'service_type', 'status', 'scheduled_date', 'price', 'crew_id', 'created_at']
const INVOICE_KEYS = ['id', 'invoice_number', 'customer_id', 'customer_name', 'status', 'amount', 'amount_paid', 'due_date', 'created_at']
const PAYMENT_KEYS = ['id', 'customer_id', 'invoice_id', 'amount', 'currency', 'method', 'kind', 'paid_at', 'created_at']
const REQUEST_KEYS = ['id', 'customer_id', 'message', 'status', 'created_at']

const IDS = {
  customer: '9f4e2c1a-0000-4000-8000-000000000001',
  quote: '9f4e2c1a-0000-4000-8000-000000000002',
  job: '9f4e2c1a-0000-4000-8000-000000000003',
  invoice: '9f4e2c1a-0000-4000-8000-000000000004',
  payment: '9f4e2c1a-0000-4000-8000-000000000005',
  request: '9f4e2c1a-0000-4000-8000-000000000006',
}

const SAMPLE_CUSTOMER = {
  id: IDS.customer, name: 'Jordan Miller', email: 'jordan@example.com',
  phone: '403-555-0142', address: '128 Aspen Ridge Way SW', city: 'Calgary',
  acquisition_source: 'website', created_at: '2026-07-15T16:20:00Z',
}
const SAMPLE_QUOTE = {
  id: IDS.quote, quote_number: 'Q-1042', customer_id: IDS.customer,
  customer_name: 'Jordan Miller', service_type: 'Lawn Mowing', status: 'sent',
  total: 65, address: '128 Aspen Ridge Way SW', created_at: '2026-07-15T16:25:00Z',
}
const SAMPLE_JOB = {
  id: IDS.job, customer_id: IDS.customer, title: 'Lawn Mowing — 128 Aspen Ridge Way SW',
  service_type: 'Lawn Mowing', status: 'scheduled', scheduled_date: '2026-07-18',
  price: 65, crew_id: null, created_at: '2026-07-15T16:30:00Z',
}
const SAMPLE_INVOICE = {
  id: IDS.invoice, invoice_number: 'INV-2088', customer_id: IDS.customer,
  customer_name: 'Jordan Miller', status: 'unpaid', amount: 65, amount_paid: 0,
  due_date: '2026-07-25', created_at: '2026-07-18T22:10:00Z',
}

export const INTEGRATION_EVENTS: IntegrationEventDef[] = [
  {
    key: 'customer.created', entity: 'customer', label: 'Customer created',
    description: 'A new customer was added — from the dashboard, a CSV import, the booking page, or an inbound webhook.',
    payloadKeys: CUSTOMER_KEYS, sample: SAMPLE_CUSTOMER,
  },
  {
    key: 'quote.created', entity: 'quote', label: 'Quote created',
    description: 'A quote was raised for a customer.',
    payloadKeys: QUOTE_KEYS, sample: SAMPLE_QUOTE,
  },
  {
    key: 'quote.accepted', entity: 'quote', label: 'Quote accepted',
    description: 'A customer accepted a quote — from the customer portal or marked by you.',
    payloadKeys: QUOTE_KEYS, sample: { ...SAMPLE_QUOTE, status: 'accepted' },
  },
  {
    key: 'quote.declined', entity: 'quote', label: 'Quote declined',
    description: 'A quote was declined.',
    payloadKeys: QUOTE_KEYS, sample: { ...SAMPLE_QUOTE, status: 'declined' },
  },
  {
    key: 'job.created', entity: 'job', label: 'Job created',
    description: 'A job landed on the schedule.',
    payloadKeys: JOB_KEYS, sample: SAMPLE_JOB,
  },
  {
    key: 'job.completed', entity: 'job', label: 'Job completed',
    description: 'A job was marked done.',
    payloadKeys: [...JOB_KEYS, 'completed_at', 'actual_minutes'],
    sample: { ...SAMPLE_JOB, status: 'completed', completed_at: '2026-07-18T19:45:00Z', actual_minutes: 42 },
  },
  {
    key: 'invoice.created', entity: 'invoice', label: 'Invoice created',
    description: 'An invoice was raised (including auto-drafted invoices on job completion).',
    payloadKeys: INVOICE_KEYS, sample: SAMPLE_INVOICE,
  },
  {
    key: 'invoice.paid', entity: 'invoice', label: 'Invoice paid',
    description: 'An invoice reached fully paid — derived from the payments ledger, so card, cash and e-transfer all count.',
    payloadKeys: [...INVOICE_KEYS, 'paid_at'],
    sample: { ...SAMPLE_INVOICE, status: 'paid', amount_paid: 65, paid_at: '2026-07-19T14:05:00Z' },
  },
  {
    key: 'payment.recorded', entity: 'payment', label: 'Payment recorded',
    description: 'A payment hit the ledger — Stripe checkout, portal payment, AutoPay, or recorded manually.',
    payloadKeys: PAYMENT_KEYS,
    sample: {
      id: IDS.payment, customer_id: IDS.customer, invoice_id: IDS.invoice, amount: 65,
      currency: 'CAD', method: 'card', kind: 'payment', paid_at: '2026-07-19T14:05:00Z',
      created_at: '2026-07-19T14:05:01Z',
    },
  },
  {
    key: 'request.created', entity: 'request', label: 'Service request received',
    description: 'A new lead or service request arrived — website form, customer portal, or inbound webhook.',
    payloadKeys: REQUEST_KEYS,
    sample: {
      id: IDS.request, customer_id: IDS.customer,
      message: 'Could you quote weekly mowing for our back yard as well?',
      status: 'new', created_at: '2026-07-15T16:40:00Z',
    },
  },
]

/** The synthetic event used by the "Send test" tool — never captured from data. */
export const TEST_EVENT = 'test.ping'
export const TEST_SAMPLE: Record<string, unknown> = {
  message: 'Test delivery from EdgeQuote — your endpoint is wired up.',
}

export const EVENT_KEYS = INTEGRATION_EVENTS.map((e) => e.key)

const byKey = new Map(INTEGRATION_EVENTS.map((e) => [e.key, e]))
export function eventByKey(key: string): IntegrationEventDef | null {
  return byKey.get(key) ?? null
}

/**
 * Validate an endpoint's event selection: either exactly ['*'] or a non-empty
 * list of known event keys. Returns an error message, or null when valid.
 */
export function validateEventSelection(events: unknown): string | null {
  if (!Array.isArray(events) || events.length === 0) return 'Pick at least one event (or all events).'
  if (events.includes('*')) return events.length === 1 ? null : "Use '*' alone, or list specific events."
  const unknown = events.filter((e) => !byKey.has(String(e)))
  if (unknown.length > 0) return `Unknown event${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`
  return null
}

/**
 * The exact JSON body an endpoint receives. `id` is the event id — stable
 * across retries, so consumers can use it as an idempotency key.
 */
export function deliveryBody(input: { id: string; event: string; createdAt: string; data: Record<string, unknown> }) {
  return { id: input.id, event: input.event, created_at: input.createdAt, data: input.data }
}

export function sampleDeliveryBody(eventKey: string) {
  const def = byKey.get(eventKey)
  return deliveryBody({
    id: '9f4e2c1a-0000-4000-8000-00000000e0e0',
    event: eventKey,
    createdAt: '2026-07-15T16:45:00Z',
    data: def ? def.sample : TEST_SAMPLE,
  })
}

/**
 * Per-entity field lists the /api/v1 reads return — a superset of every
 * event payload for that entity, so webhook payloads and API responses
 * describe entities identically.
 */
export const SERIALIZED_FIELDS: Record<IntegrationEntity, string[]> = {
  customer: CUSTOMER_KEYS,
  quote: QUOTE_KEYS,
  job: [...JOB_KEYS, 'completed_at', 'actual_minutes'],
  invoice: [...INVOICE_KEYS, 'paid_at'],
  payment: PAYMENT_KEYS,
  request: REQUEST_KEYS,
}

/** Pick the serialized shape of an entity row (drops everything else). */
export function serializeEntity(entity: IntegrationEntity, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of SERIALIZED_FIELDS[entity]) out[k] = row[k] ?? null
  return out
}
