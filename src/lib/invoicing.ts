import type { createClient } from '@/lib/supabase/client'
import type { Job } from '@/types'

type Supa = ReturnType<typeof createClient>

export interface AutoInvoiceResult {
  created: boolean
  invoiceNumber?: string
  reason?: 'not-recurring' | 'exists' | 'error'
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

  // Recurrence cadence drives which quoted price applies.
  const { data: rec } = await supabase.from('job_recurrences').select('freq').eq('id', job.recurrence_id).maybeSingle()
  const freq = (rec as { freq: string } | null)?.freq ?? null

  // Originating quote → pricing + fallbacks for customer/address.
  let quote: Record<string, unknown> | null = null
  if (job.quote_id) {
    const { data: q } = await supabase.from('quotes').select('*').eq('id', job.quote_id).maybeSingle()
    quote = q as Record<string, unknown> | null
  }

  let amount = 0
  if (quote) {
    const byFreq =
      freq === 'weekly' ? Number(quote.weekly_price)
      : freq === 'biweekly' ? Number(quote.biweekly_price)
      : freq === 'monthly' ? Number(quote.monthly_price)
      : NaN
    amount = Number.isFinite(byFreq) && byFreq > 0
      ? byFreq
      : Number(quote.initial_price) || Number(quote.total) || 0
  }

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
