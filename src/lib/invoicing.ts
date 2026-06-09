import type { createClient } from '@/lib/supabase/client'
import type { Job } from '@/types'

type Supa = ReturnType<typeof createClient>

export interface AutoInvoiceResult {
  created: boolean
  invoiceNumber?: string
  reason?: 'not-recurring' | 'exists' | 'error'
}

// Resolve a recurring cadence to weekly/biweekly/monthly. The legacy `freq`
// column is null for any non-legacy interval (every 3 weeks, every 10 days,
// every 2 months…), so derive from interval_unit/count and map custom cadences
// to the NEAREST standard per-visit price — never the first-visit price.
export function effectiveFreq(freq: string | null, unit?: string | null, count?: number | null): string | null {
  if (freq) return freq
  if (unit === 'week' && (count ?? 1) === 1) return 'weekly'
  if (unit === 'week' && (count ?? 1) === 2) return 'biweekly'
  if (unit === 'week') return (count ?? 0) >= 4 ? 'monthly' : 'biweekly' // every 3wk≈biweekly, 4wk+≈monthly
  if (unit === 'month') return 'monthly'
  if (unit === 'day') return 'weekly'
  return null
}

// The value of ONE visit of a job, from its originating quote. For a recurring
// job the cadence price applies; otherwise the first-visit price. One source of
// truth for "what is this visit worth" — used by invoicing, daily revenue and
// route profitability.
export function quoteVisitAmount(quote: Record<string, unknown> | null | undefined, freq: string | null): number {
  if (!quote) return 0
  const byFreq =
    freq === 'weekly' ? Number(quote.weekly_price)
    : freq === 'biweekly' ? Number(quote.biweekly_price)
    : freq === 'monthly' ? Number(quote.monthly_price)
    : NaN
  if (Number.isFinite(byFreq) && byFreq > 0) return byFreq
  // Recurring visit but the matching cadence price is blank → use ANY recurring
  // price before falling back to the (often setup-inflated) first-visit/total.
  if (freq) {
    const anyRec = [quote.weekly_price, quote.biweekly_price, quote.monthly_price]
      .map(Number).find(n => Number.isFinite(n) && n > 0)
    if (anyRec) return anyRec
  }
  return Number(quote.initial_price) || Number(quote.total) || 0
}

// A visit's value with the job-level manual price taking precedence over the
// quote-derived price. THE single definition of "what is this visit worth".
export function jobVisitValue(jobPrice: number | null | undefined, quote: Record<string, unknown> | null | undefined, freq: string | null): number {
  const p = Number(jobPrice)
  if (Number.isFinite(p) && p > 0) return p
  return quoteVisitAmount(quote, freq)
}

// When a recurring visit is completed, create a DRAFT invoice for that visit,
// pulling customer/property/service/pricing from the originating quote.
// Never sends. De-dupes by job_id so a visit can't be double-invoiced.
export async function createDraftInvoiceForCompletedJob(supabase: Supa, job: Job): Promise<AutoInvoiceResult> {
  if (!job.recurrence_id) return { created: false, reason: 'not-recurring' }

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { created: false, reason: 'error' }

  // Prevent duplicates — one invoice per completed visit.
  const { data: existing } = await supabase.from('invoices').select('id').eq('job_id', job.id).limit(1)
  if (existing && existing.length > 0) return { created: false, reason: 'exists' }

  // Recurrence cadence drives which quoted price applies (interval-aware).
  const { data: rec } = await supabase.from('job_recurrences').select('freq, interval_unit, interval_count').eq('id', job.recurrence_id).maybeSingle()
  const r = rec as { freq: string | null; interval_unit: string | null; interval_count: number | null } | null
  const freq = effectiveFreq(r?.freq ?? null, r?.interval_unit ?? null, r?.interval_count ?? null)

  // Originating quote → pricing + fallbacks for customer/address.
  let quote: Record<string, unknown> | null = null
  if (job.quote_id) {
    const { data: q } = await supabase.from('quotes').select('*').eq('id', job.quote_id).maybeSingle()
    quote = q as Record<string, unknown> | null
  }

  const amount = jobVisitValue(job.price, quote, freq)

  // Customer + property details (denormalised onto the invoice for history).
  let customerName = ''
  let address: string | null = null
  if (job.customer_id) {
    const { data: c } = await supabase.from('customers').select('name').eq('id', job.customer_id).maybeSingle()
    customerName = (c as { name: string } | null)?.name || ''
  }
  if (job.property_id) {
    const { data: p } = await supabase.from('properties').select('address').eq('id', job.property_id).maybeSingle()
    address = (p as { address: string } | null)?.address || null
  }
  if (!customerName && quote) customerName = String(quote.customer_name || '')
  if (!address && quote) address = (quote.address as string) ?? null

  // Sequential INV-#### number.
  const { count } = await supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('user_id', user.id)
  const invoiceNumber = `INV-${String((count || 0) + 1).padStart(4, '0')}`

  const today = new Date().toISOString().slice(0, 10)
  const due = new Date()
  due.setDate(due.getDate() + 14)

  const { error } = await supabase.from('invoices').insert({
    user_id: user.id,
    quote_id: job.quote_id,
    customer_id: job.customer_id,
    property_id: job.property_id,
    job_id: job.id,
    invoice_number: invoiceNumber,
    customer_name: customerName,
    address,
    service_type: job.service_type,
    amount,
    status: 'draft',
    issued_date: today,
    due_date: due.toISOString().slice(0, 10),
    notes: `Auto-generated from completed ${freq || 'recurring'} visit on ${job.scheduled_date}.`,
  })

  if (error) return { created: false, reason: 'error' }
  return { created: true, invoiceNumber }
}
