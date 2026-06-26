import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { serviceKeysFor as keysFor } from './services'

// ── AI Vision — purchase history (READ-ONLY CRM integration) ──────────────────
// Reads what a customer has ever BOUGHT so opportunity detection can flag
// never-purchased services and the CRM block can recommend them naturally. This
// only READS existing tables (jobs / quotes / invoices / job_line_items) — it
// never edits CRM, pricing or payments code. Returns canonical service keys
// (vocabulary in lib/vision/services).

export interface PurchaseHistory {
  purchased: Set<string>          // canonical service keys ever bought/quoted
  hasCustomer: boolean
}

// Everything the customer has ever been sold or quoted (across all properties).
export async function loadPurchaseHistory(
  supabase: SupabaseClient,
  userId: string,
  customerId: string | null,
): Promise<PurchaseHistory> {
  const purchased = new Set<string>()
  if (!customerId) return { purchased, hasCustomer: false }

  const [jobsRes, quotesRes, invoicesRes] = await Promise.all([
    supabase.from('jobs').select('id, service_type, title').eq('user_id', userId).eq('customer_id', customerId),
    supabase.from('quotes').select('service_type').eq('user_id', userId).eq('customer_id', customerId),
    supabase.from('invoices').select('service_type, line_items').eq('user_id', userId).eq('customer_id', customerId),
  ])

  const jobs = (jobsRes.data as { id: string; service_type: string | null; title: string | null }[] | null) || []
  for (const j of jobs) { keysFor(j.service_type).forEach(k => purchased.add(k)); keysFor(j.title).forEach(k => purchased.add(k)) }

  for (const q of (quotesRes.data as { service_type: string | null }[] | null) || []) keysFor(q.service_type).forEach(k => purchased.add(k))

  for (const inv of (invoicesRes.data as { service_type: string | null; line_items: { description?: string }[] | null }[] | null) || []) {
    keysFor(inv.service_type).forEach(k => purchased.add(k))
    for (const li of inv.line_items || []) keysFor(li.description).forEach(k => purchased.add(k))
  }

  // Line items on the customer's jobs (the richest signal — normalized service_key).
  const jobIds = jobs.map(j => j.id)
  if (jobIds.length) {
    const { data } = await supabase.from('job_line_items').select('service_key, description').eq('user_id', userId).in('job_id', jobIds)
    for (const li of (data as { service_key: string | null; description: string | null }[] | null) || []) {
      keysFor(li.service_key).forEach(k => purchased.add(k))
      keysFor(li.description).forEach(k => purchased.add(k))
    }
  }

  return { purchased, hasCustomer: true }
}

// Rough $ value per canonical service, read from the owner's own service templates
// (READ-ONLY — never touches pricing logic). Used only to rank opportunities; null
// when no matching template exists.
export async function loadServiceValues(supabase: SupabaseClient, userId: string): Promise<Map<string, number>> {
  const values = new Map<string, number>()
  const { data } = await supabase.from('service_templates').select('name, default_rate, is_active').eq('user_id', userId)
  for (const t of (data as { name: string | null; default_rate: number | null; is_active: boolean | null }[] | null) || []) {
    if (t.is_active === false || t.default_rate == null) continue
    for (const k of keysFor(t.name)) {
      // keep the highest matching template rate as the value hint
      if (!values.has(k) || (values.get(k) || 0) < t.default_rate) values.set(k, t.default_rate)
    }
  }
  return values
}
