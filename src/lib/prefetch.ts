'use client'

import { createClient } from '@/lib/supabase/client'
import { readCache, writeCache, CACHE_TTL } from '@/lib/clientCache'
import type { Customer, Property, Quote, Job, Invoice } from '@/types'

// Warmed payload for a customer's detail page — enough for an instant first paint
// (header, properties, quotes, jobs, invoices). The page revalidates in the
// background and the timeline/referral data fills in a beat later.
export interface CustomerPrefetch {
  customer: Customer
  properties: Property[]
  quotes: Quote[]
  jobs: Job[]
  invoices: Invoice[]
}

export const custCacheKey = (id: string) => `cust:${id}`

const inflight = new Set<string>()

// Warm the cache for a customer's detail page so opening it is instant. STRICTLY
// best-effort and deduped: it no-ops if the data is already cached within the TTL
// or a fetch is already in flight — so sweeping or re-hovering a list never fans
// out into redundant network traffic.
export async function prefetchCustomer(id: string): Promise<void> {
  if (!id || inflight.has(id) || readCache<CustomerPrefetch>(custCacheKey(id), CACHE_TTL.short)) return
  inflight.add(id)
  try {
    const supabase = createClient()
    const [c, p, q, j, i] = await Promise.all([
      supabase.from('customers').select('*').eq('id', id).maybeSingle(),
      supabase.from('properties').select('*').eq('customer_id', id).order('is_primary', { ascending: false }),
      supabase.from('quotes').select('*').eq('customer_id', id).order('created_at', { ascending: false }),
      supabase.from('jobs').select('*').eq('customer_id', id).order('scheduled_date', { ascending: true }),
      supabase.from('invoices').select('*').eq('customer_id', id).order('created_at', { ascending: false }),
    ])
    if (c.data) {
      writeCache<CustomerPrefetch>(custCacheKey(id), {
        customer: c.data as Customer,
        properties: (p.data as Property[]) || [],
        quotes: (q.data as Quote[]) || [],
        jobs: (j.data as Job[]) || [],
        invoices: (i.data as Invoice[]) || [],
      })
    }
  } catch { /* best-effort — the page will load normally */ } finally {
    inflight.delete(id)
  }
}

// Hover-intent handlers: fire `fn` only after the pointer rests `delay`ms over an
// element, and cancel on leave — so a quick sweep across a long list doesn't
// trigger a burst of prefetches. Spread onto a row: {...hoverIntent(() => …)}.
export function hoverIntent(fn: () => void, delay = 120) {
  let t: ReturnType<typeof setTimeout> | null = null
  return {
    onMouseEnter: () => { if (t) clearTimeout(t); t = setTimeout(fn, delay) },
    onMouseLeave: () => { if (t) { clearTimeout(t); t = null } },
  }
}
