import type { createClient } from '@/lib/supabase/client'
import type { Job, InvoiceLineItem, JobLineItem } from '@/types'
import { localTodayISO, maxNumericSuffix } from '@/lib/utils'
import { applyDiscount, type DiscountType } from '@/lib/invoiceTotals'
import { addDays, format, parseISO } from 'date-fns'

type Supa = ReturnType<typeof createClient>

export interface AutoInvoiceResult {
  created: boolean
  invoiceNumber?: string
  reason?: 'not-recurring' | 'exists' | 'no-amount' | 'error'
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
// `isInitial` = the anchor visit of a recurring series; it derives the quote's
// INITIAL price (freq treated as null) rather than the cadence price, so the
// first visit can show $150 while the rest derive $65. Defaults false →
// identical behaviour for every existing caller (backward compatible).
export function jobVisitValue(jobPrice: number | null | undefined, quote: Record<string, unknown> | null | undefined, freq: string | null, isInitial = false): number {
  const p = Number(jobPrice)
  if (Number.isFinite(p) && p > 0) return p
  return quoteVisitAmount(quote, isInitial ? null : freq)
}

// Human label for the base service line on an invoice/breakdown ("Weekly Mowing").
function serviceLineLabel(serviceType: string | null | undefined, freq: string | null, isInitial: boolean): string {
  const base = serviceType || 'Services rendered'
  if (isInitial) return `Initial visit — ${base}`
  if (!freq) return base
  const cap = freq.charAt(0).toUpperCase() + freq.slice(1)
  return `${cap} ${base}`
}

// THE single definition of what an invoice should show + total: the base visit
// value (job price > quote) plus every add-on, plus a separate travel charge
// when the quote bills travel separately. Used by the draft + the sync so the
// breakdown and the amount can never disagree.
// THE invoice number generator. Sequential INV-#### from the highest EXISTING
// number — a row count would reissue a number after any delete and two invoices
// would share it (duplicate customer-facing documents). Every path that mints an
// invoice — the completed-job auto-draft, converting a quote, and manual creation
// — calls this, so the sequence can't fork.
export async function nextInvoiceNumber(supabase: Supa, userId: string): Promise<string> {
  const { data } = await supabase.from('invoices').select('invoice_number').eq('user_id', userId)
  const next = maxNumericSuffix(((data as { invoice_number: string }[]) || []).map(n => n.invoice_number)) + 1
  return `INV-${String(next).padStart(4, '0')}`
}

export function buildInvoiceLineItems(opts: {
  serviceType: string | null
  baseAmount: number
  freq: string | null
  isInitial: boolean
  addons?: Pick<JobLineItem, 'description' | 'amount'>[] | null
  quote?: Record<string, unknown> | null
}): { lineItems: InvoiceLineItem[]; total: number } {
  const lines: InvoiceLineItem[] = []
  const base = Math.round(opts.baseAmount)
  if (base > 0) lines.push({ description: serviceLineLabel(opts.serviceType, opts.freq, opts.isInitial), amount: base, kind: 'service' })
  for (const a of opts.addons || []) {
    const amt = Math.round(Number(a.amount) || 0)
    if (amt !== 0) lines.push({ description: a.description, amount: amt, kind: 'addon' })
  }
  // Separate travel charge only when the quote opted to bill it separately —
  // otherwise it's already inside the cadence price (don't double-count).
  const q = opts.quote
  if (q && q.show_travel_separately && Number(q.travel_fee) > 0) {
    lines.push({ description: 'Travel charge', amount: Math.round(Number(q.travel_fee)), kind: 'travel' })
  }
  const total = lines.reduce((s, l) => s + l.amount, 0)
  return { lineItems: lines, total }
}

// Keep DRAFT invoices in sync with their job's price — the JOB is the source of
// truth, so changing a visit's price (anywhere) re-prices its not-yet-issued
// invoice automatically. Only DRAFT invoices are touched; sent/paid invoices are
// immutable history. Idempotent: an invoice whose amount already matches is left
// alone. Optionally records the reason on the invoice note.
//
// Returns { changed, failed } — NOT a bare count. Supabase resolves on a failed
// write, so the old `changed++`-after-an-unchecked-update counted invoices it had
// no evidence it re-priced, and callers then told the owner "its draft invoice was
// re-priced to match" while the draft still held the old amount — which AutoPay
// would go on to charge. A caller that ignores the result is unchanged; a caller
// that reports to the owner MUST distinguish these two numbers.
export async function syncDraftInvoiceAmounts(
  supabase: Supa,
  jobIds: string[],
  opts?: { reason?: string },
): Promise<{ changed: number; failed: number }> {
  const ids = [...new Set(jobIds.filter(Boolean))]
  if (ids.length === 0) return { changed: 0, failed: 0 }
  const { data: invData } = await supabase.from('invoices').select('id, job_id, amount, notes, line_items, discount_type, discount_value').in('job_id', ids).eq('status', 'draft')
  const invoices = (invData as { id: string; job_id: string; amount: number; notes: string | null; line_items: InvoiceLineItem[] | null; discount_type: DiscountType | null; discount_value: number | null }[] | null) || []
  if (invoices.length === 0) return { changed: 0, failed: 0 }

  const jobIdsWithInv = [...new Set(invoices.map(i => i.job_id))]
  type JobRow = { id: string; price: number | null; quote_id: string | null; recurrence_id: string | null; is_initial_visit: boolean; service_type: string | null }
  const { data: jobData } = await supabase.from('jobs').select('id, price, quote_id, recurrence_id, is_initial_visit, service_type').in('id', jobIdsWithInv)
  const jobsById: Record<string, JobRow> = {}
  for (const j of (jobData as JobRow[] | null) || []) jobsById[j.id] = j

  const quoteIds = [...new Set(Object.values(jobsById).map(j => j.quote_id).filter((x): x is string => !!x))]
  const recIds = [...new Set(Object.values(jobsById).map(j => j.recurrence_id).filter((x): x is string => !!x))]
  const quotesById: Record<string, Record<string, unknown>> = {}
  const recById: Record<string, { freq: string | null; interval_unit: string | null; interval_count: number | null }> = {}
  // Add-ons on these visits feed both the amount and the breakdown.
  const addonsByJob: Record<string, Pick<JobLineItem, 'description' | 'amount'>[]> = {}
  // These three reads all derive from the already-resolved jobs (independent of each
  // other) — run them together instead of three serial round-trips on every price edit.
  await Promise.all([
    (async () => { if (!quoteIds.length) return; const { data } = await supabase.from('quotes').select('*').in('id', quoteIds); for (const q of (data as Record<string, unknown>[]) || []) quotesById[q.id as string] = q })(),
    (async () => { if (!recIds.length) return; const { data } = await supabase.from('job_recurrences').select('id, freq, interval_unit, interval_count').in('id', recIds); for (const r of (data as { id: string; freq: string | null; interval_unit: string | null; interval_count: number | null }[]) || []) recById[r.id] = r })(),
    (async () => { const { data } = await supabase.from('job_line_items').select('job_id, description, amount').in('job_id', jobIdsWithInv); for (const a of (data as { job_id: string; description: string; amount: number }[]) || []) (addonsByJob[a.job_id] ||= []).push({ description: a.description, amount: a.amount }) })(),
  ])

  let changed = 0, failed = 0
  for (const inv of invoices) {
    const j = jobsById[inv.job_id]
    if (!j) continue
    const quote = j.quote_id ? quotesById[j.quote_id] : null
    const rec = j.recurrence_id ? recById[j.recurrence_id] : null
    const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
    const base = jobVisitValue(j.price, quote, freq, j.is_initial_visit)
    const { lineItems, total } = buildInvoiceLineItems({ serviceType: j.service_type, baseAmount: base, freq, isInitial: j.is_initial_visit, addons: addonsByJob[inv.job_id], quote })
    // line_items stay the GROSS services; the stored amount is the NET, so a manual
    // discount on this draft is preserved when its job price changes (one engine).
    const { net } = applyDiscount(Math.round(total), { type: inv.discount_type, value: inv.discount_value })
    const amount = Math.round(net)
    const prev = Math.round(Number(inv.amount))
    const sameLines = JSON.stringify(inv.line_items ?? null) === JSON.stringify(lineItems)
    if (!(amount > 0) || (amount === prev && sameLines)) continue
    const patch: Record<string, unknown> = { amount, line_items: lineItems }
    if (opts?.reason?.trim() && amount !== prev) patch.notes = `${inv.notes ? inv.notes + ' · ' : ''}Re-priced $${prev} → $${amount} — ${opts.reason.trim()}`
    const { error } = await supabase.from('invoices').update(patch).eq('id', inv.id)
    if (error) { failed++; continue }
    changed++
  }
  return { changed, failed }
}

// When a billable job is completed — a one-time job OR a recurring visit — create a
// DRAFT invoice for it, pulling customer/property/service/pricing from the job and
// its originating quote. Never sends. De-dupes by job_id so a visit can't be
// double-invoiced, and (for one-time jobs) by quote_id so it can't collide with a
// manual "Convert to Invoice". An unpriced job drafts nothing (never a $0 invoice).
export async function createDraftInvoiceForCompletedJob(supabase: Supa, job: Job): Promise<AutoInvoiceResult> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { created: false, reason: 'error' }

  // Prevent duplicates — one invoice per completed visit (job_id is the atomic key;
  // a partial unique index on invoices(job_id) is the race backstop further down).
  const { data: existing } = await supabase.from('invoices').select('id').eq('job_id', job.id).limit(1)
  if (existing && existing.length > 0) return { created: false, reason: 'exists' }

  // A one-time job billed from a quote yields exactly ONE invoice. That quote may
  // already have been turned into an invoice manually (the "Convert to Invoice" path
  // stamps quote_id but no job_id), so dedupe by quote_id too — otherwise completing
  // the job would double-bill the customer. Recurring jobs intentionally skip this:
  // many visits share one quote_id and each visit is invoiced separately.
  if (!job.recurrence_id && job.quote_id) {
    const { data: q } = await supabase.from('invoices').select('id').eq('quote_id', job.quote_id).limit(1)
    if (q && q.length > 0) return { created: false, reason: 'exists' }
  }

  // Recurrence cadence drives which quoted price applies (interval-aware). A one-time
  // job has no recurrence → freq stays null and the first-visit price applies.
  let freq: string | null = null
  if (job.recurrence_id) {
    const { data: rec } = await supabase.from('job_recurrences').select('freq, interval_unit, interval_count').eq('id', job.recurrence_id).maybeSingle()
    const r = rec as { freq: string | null; interval_unit: string | null; interval_count: number | null } | null
    freq = effectiveFreq(r?.freq ?? null, r?.interval_unit ?? null, r?.interval_count ?? null)
  }

  // Originating quote → pricing + fallbacks for customer/address.
  let quote: Record<string, unknown> | null = null
  if (job.quote_id) {
    const { data: q } = await supabase.from('quotes').select('*').eq('id', job.quote_id).maybeSingle()
    quote = q as Record<string, unknown> | null
  }

  // Base visit value + any add-on services on this visit → amount + breakdown.
  const base = jobVisitValue(job.price, quote, freq, job.is_initial_visit)
  const { data: addonRows } = await supabase.from('job_line_items').select('description, amount').eq('job_id', job.id)
  const addons = (addonRows as Pick<JobLineItem, 'description' | 'amount'>[] | null) || []
  const { lineItems, total } = buildInvoiceLineItems({ serviceType: job.service_type, baseAmount: base, freq, isInitial: job.is_initial_visit, addons, quote })
  const amount = Math.round(total)
  // Never draft a $0 invoice — an unpriced visit pollutes billing history forever.
  if (!(amount > 0)) return { created: false, reason: 'no-amount' }

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

  const invoiceNumber = await nextInvoiceNumber(supabase, user.id)

  // Local dates — evening completions must not stamp tomorrow (UTC) as issued.
  const today = localTodayISO()
  const dueISO = format(addDays(parseISO(today), 14), 'yyyy-MM-dd')

  const { data: created, error } = await supabase.from('invoices').insert({
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
    line_items: lineItems,
    status: 'draft',
    issued_date: today,
    due_date: dueISO,
    // Provenance is for the OWNER, not the customer. This used to go in `notes`,
    // which InvoicePDF prints — so every auto-drafted invoice told the customer
    // "Auto-generated from completed weekly visit on 2026-07-10". `notes` is left
    // empty for the owner to write something the customer should actually read.
    internal_notes: `Auto-generated from completed ${job.recurrence_id ? `${freq || 'recurring'} visit` : 'job'} on ${job.scheduled_date}.`,
  }).select('id').single()

  if (error || !created) {
    // The partial unique index on invoices(job_id) is the ATOMIC backstop against a
    // double-complete of the same visit (e.g. a mobile double-tap of "Done" racing
    // two inserts): the loser hits a 23505 unique violation, which we treat as a
    // benign "already invoiced" — NOT an error. Crucially, triggerAutoPay is only
    // reached on a SUCCESSFUL insert below, so a duplicate visit can never produce a
    // second invoice and therefore can never produce a second AutoPay charge.
    if ((error as { code?: string } | null)?.code === '23505') return { created: false, reason: 'exists' }
    return { created: false, reason: 'error' }
  }

  // AutoPay: this is the single point a recurring invoice is "finalized", so attempt
  // the off-session charge here. The /api/payments/autopay route gates EVERYTHING
  // (AutoPay enabled, charge-mode, saved card, anomaly safety check, idempotency)
  // and no-ops when not eligible — so this is a safe fire-and-forget. Invoice
  // creation never depends on, or is blocked by, the charge.
  triggerAutoPay((created as { id: string }).id)

  return { created: true, invoiceNumber }
}

// ── Un-completing a job — the exact inverse, as ONE operation ─────────────────
// Completing a job is never just a status: it drafts an invoice, and that draft
// fires AutoPay. So UN-completing can never be just a status either. It used to
// be: the undo enqueued a plain `job.update` carrying only the reverted fields,
// and the draft was deleted by a line inside the online closure. Offline, that
// closure never ran — so on reconnect the queue replayed "complete" (draft
// created → AutoPay charged) and then "revert status", leaving a live invoice
// for a visit the contractor had explicitly un-done. The customer gets charged
// for work the schedule says didn't happen.
//
// ORDER IS THE SAFETY PROPERTY. The draft goes FIRST, the status second:
//  • delete → revert, interrupted: no invoice, job still reads completed. The
//    un-invoiced queue surfaces it. Nobody is charged for un-done work.
//  • revert → delete, interrupted: job reads scheduled and a live invoice bills
//    for it. That is precisely the defect above.
// Both halves are idempotent, so a retried replay is safe: the delete no-ops
// once the draft is gone, and the patch is the same fixed set of fields.
export interface UncompleteResult {
  reverted: boolean
  /** A draft invoice existed and was removed. */
  draftDeleted: boolean
  /** The invoice is no longer a draft (sent, or AutoPay already charged it), so
   *  it was LEFT ALONE — deleting it would destroy real billing history. The
   *  caller must tell the owner: there is money owing on an un-done visit. */
  invoiceLocked: boolean
  invoiceNumber?: string
  error?: string
}

export async function uncompleteJob(
  supabase: Supa,
  opts: { jobId: string; patch: Record<string, unknown> },
): Promise<UncompleteResult> {
  const out: UncompleteResult = { reverted: false, draftDeleted: false, invoiceLocked: false }

  // 1. The invoice this completion created, if it still exists.
  const { data: invRows, error: readErr } = await supabase
    .from('invoices').select('id, invoice_number, status').eq('job_id', opts.jobId).limit(1)
  if (readErr) return { ...out, error: readErr.message }

  const inv = (invRows as { id: string; invoice_number: string; status: string }[] | null)?.[0]
  if (inv) {
    if (inv.status === 'draft') {
      // Scoped to draft in the DELETE too, not just the read above: between the
      // two, AutoPay may have settled it. A status filter that matches nothing
      // is a no-op, which is the correct outcome — never a deleted payment.
      const { error: delErr } = await supabase
        .from('invoices').delete().eq('id', inv.id).eq('status', 'draft')
      if (delErr) return { ...out, error: delErr.message, invoiceNumber: inv.invoice_number }
      out.draftDeleted = true
    } else {
      // Sent, or already charged. Leave it standing and say so.
      out.invoiceLocked = true
    }
    out.invoiceNumber = inv.invoice_number
  }

  // 2. Only now revert the visit itself.
  const { error: jobErr } = await supabase.from('jobs').update(opts.patch).eq('id', opts.jobId)
  if (jobErr) return { ...out, error: jobErr.message }
  out.reverted = true
  return out
}

// Fire-and-forget AutoPay trigger (browser only — uses the owner's session cookie).
// Swallows every error: a failed/uncharged invoice simply stays a draft to collect
// manually, exactly as before AutoPay existed.
function triggerAutoPay(invoiceId: string): void {
  if (typeof window === 'undefined') return
  try {
    void fetch('/api/payments/autopay', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoiceId }),
    }).catch(() => {})
  } catch { /* never let an AutoPay attempt break invoice creation */ }
}
