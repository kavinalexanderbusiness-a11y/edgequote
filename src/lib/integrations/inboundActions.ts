// What an inbound webhook DOES with a payload. Two actions:
//   'customer' — find-or-create the customer
//   'lead'     — find-or-create the customer, then raise a service_request
//                (the existing trg_sr_to_conversation trigger threads it into
//                Messages, and request.created fires like any other lead)
//
// Dedup mirrors the semantics of submit_website_lead / book_service (the
// existing intake doors): phone last-10 first, then exact email — so a Zapier
// action and the website form agree on who's a returning customer.
//
// normalizeInboundPayload is pure (verify:integrations exercises it);
// runInboundAction takes the service-role client from the route.

import type { SupabaseClient } from '@supabase/supabase-js'
import { ensurePropertyForCustomer } from '@/lib/customers'

export interface InboundLeadInput {
  name: string | null
  email: string | null
  phone: string | null
  address: string | null
  city: string | null
  province: string | null
  postal_code: string | null
  message: string | null
  source: string | null
}

const pick = (obj: Record<string, unknown>, keys: string[]): string | null => {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && keys.includes(k)) return String(v)
  }
  return null
}

/** Map the field-name dialects of common form/automation tools onto ours. */
export function normalizeInboundPayload(payload: Record<string, unknown>): InboundLeadInput {
  return {
    name: pick(payload, ['name', 'full_name', 'fullName', 'customer_name', 'Name']),
    email: pick(payload, ['email', 'email_address', 'Email', '_replyto']),
    phone: pick(payload, ['phone', 'phone_number', 'phoneNumber', 'tel', 'mobile', 'Phone']),
    address: pick(payload, ['address', 'street', 'street_address', 'address1', 'Address']),
    city: pick(payload, ['city', 'City']),
    province: pick(payload, ['province', 'state', 'Province']),
    postal_code: pick(payload, ['postal_code', 'postalCode', 'zip', 'zip_code', 'postcode']),
    message: pick(payload, ['message', 'notes', 'comments', 'description', 'details', 'Message']),
    source: pick(payload, ['source', 'utm_source']),
  }
}

export interface InboundResult {
  ok: boolean
  status: number
  summary: string
  customerId?: string
  propertyId?: string | null
  requestId?: string
  deduped?: boolean
}

/**
 * Find-or-create a customer with intake's dedup semantics (phone last-10 →
 * exact email), then guarantee the property linkage — every app-side creation
 * path runs ensureCustomerAndProperty now (multi-property, c260380), and the
 * integration doors must not be the one place a customer can exist without a
 * property. Shared by inbound webhooks and POST /api/v1/customers.
 */
export async function findOrCreateCustomer(
  sb: SupabaseClient,
  userId: string,
  input: Partial<InboundLeadInput> & { notes?: string | null },
): Promise<{ id: string; propertyId: string | null; deduped: boolean } | { error: string }> {
  let customerId: string | null = null
  let deduped = false

  // Suffix match on the generated customers.phone_digits column (trigram-
  // indexed) — the same canonical digits the rest of the app searches on.
  const phoneDigits = (input.phone ?? '').replace(/\D/g, '').slice(-10)
  if (phoneDigits.length === 10) {
    const { data } = await sb.from('customers').select('id')
      .eq('user_id', userId).like('phone_digits', `%${phoneDigits}`)
      .order('created_at', { ascending: false }).limit(1)
    if (data?.[0]) { customerId = data[0].id; deduped = true }
  }
  if (!customerId && input.email) {
    const { data } = await sb.from('customers').select('id').eq('user_id', userId).ilike('email', input.email).limit(1)
    if (data?.[0]) { customerId = data[0].id; deduped = true }
  }
  if (!customerId) {
    const { data, error } = await sb.from('customers').insert({
      user_id: userId,
      name: input.name ?? input.email ?? input.phone ?? 'New lead',
      email: input.email ?? null, phone: input.phone ?? null,
      address: input.address ?? null, city: input.city ?? null,
      province: input.province ?? 'AB',
      postal_code: input.postal_code ?? null,
      ...(input.notes ? { notes: input.notes } : {}),
      acquisition_source: input.source ?? 'webhook',
    }).select('id').single()
    if (error || !data) return { error: error?.message ?? 'unknown insert failure' }
    customerId = data.id as string
  }
  if (!customerId) return { error: 'could not resolve a customer' }

  // THE app engine for property find-or-create (address canonicalization,
  // is_primary on first) — never a second matching implementation. Without a
  // usable address it just resolves the primary property; no writes.
  const { propertyId } = await ensurePropertyForCustomer(
    sb as Parameters<typeof ensurePropertyForCustomer>[0], userId, customerId,
    { address: input.address, city: input.city, province: input.province, postal_code: input.postal_code },
  )
  return { id: customerId, propertyId, deduped }
}

export async function runInboundAction(
  sb: SupabaseClient,
  userId: string,
  action: 'lead' | 'customer',
  input: InboundLeadInput,
  hookName: string,
): Promise<InboundResult> {
  if (!input.name && !input.email && !input.phone) {
    return { ok: false, status: 422, summary: 'Rejected: payload needs at least one of name, email, phone.' }
  }

  const found = await findOrCreateCustomer(sb, userId, input)
  if ('error' in found) return { ok: false, status: 500, summary: `Failed to create customer: ${found.error}` }
  const customerId = found.id
  const deduped = found.deduped

  if (action === 'customer') {
    return {
      ok: true, status: 200, customerId, propertyId: found.propertyId, deduped,
      summary: `${deduped ? 'Matched existing' : 'Created'} customer${input.name ? ` "${input.name}"` : ''}.`,
    }
  }

  const { data: reqRow, error: reqErr } = await sb.from('service_requests').insert({
    user_id: userId, customer_id: customerId,
    message: input.message ?? `New lead received via webhook "${hookName}".`,
    status: 'new',
  }).select('id').single()
  if (reqErr || !reqRow) return { ok: false, status: 500, summary: `Customer saved but request failed: ${reqErr?.message ?? 'unknown'}` }

  return {
    ok: true, status: 200, customerId, propertyId: found.propertyId, requestId: reqRow.id, deduped,
    summary: `${deduped ? 'Matched existing' : 'Created'} customer${input.name ? ` "${input.name}"` : ''} and raised a service request.`,
  }
}
