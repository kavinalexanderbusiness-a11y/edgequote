import type { SupabaseClient } from '@supabase/supabase-js'
import type { Quote, QuoteService } from '@/types'
import { splitServices, serviceLineTotals } from '@/lib/quoteServices'
import { addLineItems } from '@/lib/jobPricing'
import { toast } from '@/lib/toast'
import { localTodayISO } from '@/lib/utils'

// ── Quote → scheduled job (ONE engine) ───────────────────────────────────────
// Every "schedule this quote" entry point (the quote page's Schedule button and
// the dashboard's "Accepted — not yet scheduled" card) MUST create the same
// job: property resolved, duration = primary hours + extras' minutes, extras as
// job_line_items, price = primary net when extras exist, quote bumped
// accepted→scheduled. Anything less silently drops crew time and revenue the
// customer already approved.
export async function scheduleQuoteAsJob(
  supabase: SupabaseClient,
  userId: string,
  quote: Quote,
  opts?: { date?: string; services?: QuoteService[] },
): Promise<{ jobId: string | null; error: string | null }> {
  // The quote's property, else the customer's primary.
  let propertyId: string | null = quote.property_id
  if (!propertyId && quote.customer_id) {
    const { data: props } = await supabase
      .from('properties').select('id')
      .eq('customer_id', quote.customer_id)
      .order('is_primary', { ascending: false }).limit(1)
    if (props && props.length > 0) propertyId = props[0].id
  }

  // Callers that already hold the service rows pass them; everyone else gets
  // them fetched here so multi-service quotes can never lose their add-ons.
  let services = opts?.services
  if (!services) {
    const { data } = await supabase
      .from('quote_services').select('*')
      .eq('quote_id', quote.id).order('sort_order')
    services = (data as QuoteService[]) || []
  }

  // Multi-service: the visit covers every line, so the job's duration includes
  // the additional services' estimated minutes (primary = hours×60 as before).
  const { primary: primaryLine, extras: extraLines } = splitServices(services)
  const extraMinutes = extraLines.reduce((m, s) => m + (Number(s.est_minutes) || 0), 0)
  // An unknown duration is NULL — never 0. QuoteBuilder defaults `hours` to 0 to mean
  // "not estimated yet" (unknown hours is not 2 hours, the same way an unknown cost is
  // not $0), but `hours` is ALSO the only duration source for scheduling — so writing
  // hours×60 unguarded stamps a 0-minute visit onto the calendar. That is the same
  // unknown-is-zero bug, one seam downstream. NULL is what "we don't know yet" looks
  // like in this nullable column, and every reader already coalesces it to
  // DEFAULT_JOB_MIN. We do NOT write 45 here: that would invent a number at the point
  // of record, which is exactly what the principle forbids — the fallback belongs to
  // the readers, who present it as an assumption, not to the DB, which states facts.
  //
  // extraMinutes is deliberately NOT used as a fallback total when hours is unknown:
  // `0 + extraMinutes` asserts the PRIMARY service takes no time, which is the very
  // bug being fixed. Unknown primary + known extras is still an unknown total, so the
  // honest write is NULL. (The extras' minutes remain on their quote_services rows.)
  const hours = Number(quote.hours)
  const durationMinutes = Number.isFinite(hours) && hours > 0
    ? Math.round(hours * 60) + extraMinutes
    : null
  const { data: newJob, error } = await supabase.from('jobs').insert({
    user_id: userId,
    customer_id: quote.customer_id,
    property_id: propertyId,
    quote_id: quote.id,
    title: `${quote.service_type} — ${quote.customer_name}`,
    service_type: quote.service_type,
    scheduled_date: opts?.date || localTodayISO(),
    duration_minutes: durationMinutes,
    crew_size: quote.crew_size,
    status: 'scheduled',
    notes: quote.notes,
    // Multi-service quotes: the job's base value is the PRIMARY line only; the
    // extras become job_line_items below. quote.initial_price caches primary +
    // extras, so leaving price null would double-count once add-ons exist.
    ...(extraLines.length && primaryLine ? { price: serviceLineTotals(primaryLine).net } : {}),
  }).select('id').single()
  if (error || !newJob) return { jobId: null, error: error?.message || 'unknown error' }

  // Extras → the EXISTING job add-on rows (one engine: lib/jobPricing
  // addLineItems — same shape the visit add-on flow, invoice auto-draft and BI
  // already consume). Base(primary) + add-ons(extras) = the quote total.
  // addLineItems throws now, so this must catch — but NOT via `error`. Both callers
  // read `{ error }` as "the job could not be created" and prefix it with exactly
  // that, so returning an extras failure there would print "Could not create job: the
  // visit was scheduled…" and leave the quote showing 'accepted' when the job exists
  // and the quote was already advanced below. The job is real; only its extras are
  // missing. Report that on its own channel and let the caller's success path run.
  try {
    for (const s of extraLines) {
      const qty = Number(s.quantity) > 0 ? Number(s.quantity) : 1
      await addLineItems(supabase, {
        userId,
        targetJobIds: [newJob.id as string],
        description: `${s.service_type}${qty !== 1 ? ` ×${qty}` : ''}`,
        amount: serviceLineTotals(s).net,
        serviceType: s.service_type,
        recurring: false,
      })
    }
  } catch (e) {
    // Was silent before (the insert error was swallowed), which quietly under-billed
    // a multi-service quote — the base landed, the extras didn't, nobody knew.
    toast.error(`Scheduled, but the extra services couldn’t be added${e instanceof Error ? `: ${e.message}` : ''}. Add them from the visit.`)
  }

  if (quote.status === 'accepted') {
    await supabase.from('quotes').update({ status: 'scheduled' }).eq('id', quote.id)
  }
  return { jobId: newJob.id as string, error: null }
}
