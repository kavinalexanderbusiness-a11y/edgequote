'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { confirm as confirmDialog } from '@/lib/confirm'
import { ConfirmHost } from '@/components/ui/ConfirmHost'
import { buildServicePlans, type ServicePlan } from '@/lib/recurrence'
import { jobVisitValue } from '@/lib/invoicing'
import { settingsToSeasons } from '@/lib/seasons'
import type { Job, JobRecurrence } from '@/types'
import { invoiceTotals } from '@/lib/invoiceTotals'
import { serviceLineTotals } from '@/lib/quoteServices'
import { formatCurrency, formatDate, cn, localTodayISO, parseLocalDate } from '@/lib/utils'
import { displayQuoteStatus } from '@/lib/quoteStatus'
import type { QuoteStatus } from '@/types'
import { Button } from '@/components/ui/Button'
import { renderPortalQuoteBlob, renderPortalInvoiceBlob, renderPortalReceiptBlob, downloadBlob, viewBlob, printBlob } from '@/lib/portalPdf'
import { receiptNumberFor } from '@/lib/payments/ledger'
import { cardExpLabel, cardExpiryState } from '@/lib/payments/card'
import {
  Home, History, Image as ImageIcon, FileText, Receipt, MessageSquarePlus, Check, Loader2,
  Phone, Globe, Mail, Leaf, CheckCircle2, Navigation, Play, CalendarClock, Repeat, MapPin, Ruler, Sparkles, CreditCard, MessageSquare,
  Eye, Download, Printer, FolderOpen, Search, ArrowUpDown, Activity, Wallet, Star, Zap, ShieldCheck, Trash2, X, Landmark, Banknote, Copy, Clock, AlertTriangle,
  Send, CalendarPlus, SkipForward, PauseCircle, XCircle,
} from 'lucide-react'

// ── Premium Customer Portal ─────────────────────────────────────────────────────
// Public, no-login, scoped to the token's customer via get_portal_data. A clean
// service-app experience: a Home overview, live job status, a per-visit timeline
// with photos & invoices, a before/after gallery, two-way messages, and
// self-service requests (services, appointments, reschedules, plan changes) —
// every request threads into the owner's ONE Messages hub and waits for a human
// yes; the portal never mutates the schedule or a plan on its own.

interface PortalQuoteService { service_type: string; quantity: number; unit: string | null; unit_price: number; est_minutes: number | null; discount_type: 'amount' | 'percent' | null; discount_value: number | null; notes: string | null; sort_order: number }
// `valid_until` is the date this price stops standing. Null = it never lapses (every
// quote sent before expiry stamping began). Expiry is DERIVED from it via
// lib/quoteStatus — never stored on status — so the portal reads the same field and
// reaches the same answer as the owner's screens, with no second rule to drift.
// `property_id` is the canonical FK to the property this quote is actually FOR. It is
// optional because 4 of 62 live rows predate property linking — a legacy quote answers
// `null`, and callers must degrade to the quote's own `address` text rather than
// borrowing another property's facts.
interface PortalQuote { id: string; quote_number: string; service_type: string; address: string; property_id?: string | null; total: number; initial_price: number | null; subtotal: number | null; weekly_price: number | null; biweekly_price: number | null; monthly_price: number | null; notes: string | null; status: string; created_at: string; issued_date: string | null; valid_until: string | null; crew_size: number | null; hours: number | null; travel_fee: number | null; services?: PortalQuoteService[] | null }
// `property_id` null is the HONEST answer for an invoice spanning several properties —
// never infer one, or a combined invoice prints one address as if it were the whole bill.
interface PortalInvoice { id: string; invoice_number: string; service_type: string | null; amount: number; status: string; issued_date: string | null; due_date: string | null; notes: string | null; address: string | null; property_id?: string | null; line_items: { description: string; amount: number; kind: string }[] | null; job_id: string | null; created_at: string; discount_type?: 'amount' | 'percent' | null; discount_value?: number | null; amount_paid?: number | null }
// property_id/quote_id/price/is_initial_visit exist so buildServicePlans + jobVisitValue
// (the SAME engines the owner's customer page runs) can be fed real data here.
interface PortalJob { id: string; recurrence_id: string | null; property_id: string | null; quote_id: string | null; price: number | null; is_initial_visit: boolean | null; service_type: string | null; title: string; scheduled_date: string; status: string; on_my_way_at: string | null; started_at: string | null; completed_at: string | null; notes: string | null }
interface PortalRec { id: string; freq: string | null; interval_unit: string | null; interval_count: number | null; start_date: string | null; end_date: string | null; end_count: number | null }
interface PortalPhoto { id: string; job_id: string | null; storage_path: string; kind: string; caption: string | null; taken_at: string }
interface PortalPayment { id: string; amount: number; status: string; paid_at: string | null; provider: string; invoice_id: string | null; created_at: string; kind?: string }
interface PortalCard { brand: string | null; last4: string | null; exp_month: number | null; exp_year: number | null }
// The owner's OWN catalogue (service_templates), surfaced by get_portal_data. This
// is what makes ONE portal fit any field-service business: a pool company's
// customers are offered pool visits, a window cleaner's are offered window
// cleaning. Optional so a portal served by an older RPC still renders.
interface PortalService { name: string; category: string | null; default_rate: number | null; pricing_display_type: string | null; default_description: string | null }
// One of the customer's properties, from the canonical properties table. `id` is what a
// quote/invoice row's property_id points at — this array is the ONLY way a card can name
// its own address or area. `lawn_sqft` is a historical column NAME holding a measured
// AREA of any kind (a driveway, a roof); never surface the word "lawn" from it.
interface PortalProperty { id: string; address: string | null; city: string | null; province: string | null; postal_code: string | null; lawn_sqft: number | null; fence_length: number | null; neighborhood: string | null; is_primary: boolean | null }
// One row of the customer's conversation with the business — the SAME messages
// table the owner's Messages hub reads, fetched lazily by the Messages tab via a
// token-scoped RPC (portal_get_messages) so get_portal_data stays untouched.
// direction is from the OWNER's perspective: 'inbound' = the customer speaking.
interface PortalMessage { id: string; direction: string; channel: string; body: string; created_at: string }
interface PortalData {
  // review_declined_at: the customer's own "No thanks". Read here so a decline saved on
  // a previous visit keeps the review card down — without it, "no" would only last as
  // long as the tab.
  customer: { id: string; name: string; email: string | null; phone: string | null; address: string | null; city: string | null; sms_opt_in?: boolean | null; email_opt_in?: boolean | null; reviewed_at?: string | null; review_declined_at?: string | null; autopay_enabled?: boolean | null }
  business: { company_name: string | null; owner_name: string | null; phone: string | null; email_primary: string | null; email_secondary: string | null; website: string | null; logo_url: string | null; logo_scale: number | null; base_address: string | null; terms_text: string | null; review_url?: string | null; etransfer_email?: string | null; gst_percent?: number | null; service_seasons?: unknown } | null
  // `property` (singular) is the PRIMARY property and stays exactly as it was — Home's
  // "Your property" card, the Property tab and the invoice/receipt PDF fallbacks all
  // read it. It is the right answer to "where does this customer mainly live", and the
  // WRONG answer to "what is this quote for" — that is what `properties` + a row's own
  // property_id are for. Keeping both means this change cannot regress the old readers.
  property: { address: string | null; city: string | null; province: string | null; lawn_sqft: number | null; fence_length: number | null; neighborhood: string | null; notes: string | null } | null
  // Every property, primary first (same ordering as `property`, so properties[0] is it).
  // Optional: a portal served by an older RPC has no such key and must still render.
  properties?: PortalProperty[] | null
  quotes: PortalQuote[]; invoices: PortalInvoice[]; jobs: PortalJob[]; recurrences: PortalRec[]; photos: PortalPhoto[]; payments: PortalPayment[]
  payment_method?: PortalCard | null
  // Optional: a portal whose RPC predates the services key still works — the
  // Request tab falls back to its free-text ask.
  services?: PortalService[] | null
}

type Tab = 'home' | 'timeline' | 'service' | 'photos' | 'property' | 'documents' | 'payments' | 'messages' | 'request'
type LiveStatus = 'scheduled' | 'on_my_way' | 'in_progress' | 'completed'

interface Derived {
  upcoming: PortalJob[]; completed: PortalJob[]; nextService: PortalJob | null
  lastCompleted: PortalJob | null; outstanding: number
  // ServicePlan comes from THE shared engine (lib/recurrence.buildServicePlans).
  // nextJobId rides alongside: the concrete visit behind nextVisitDate — what a
  // "skip next visit" request points at, so the owner knows exactly which job.
  plans: (ServicePlan & { nextJobId: string | null })[]
}

// Every customer action below is a REQUEST that threads into the owner's ONE
// Messages hub (service_requests → sr_to_conversation) — nothing in the portal
// mutates jobs or plans directly. The message string is what the owner reads;
// the structured fields exist so their side can grow one-tap actions later.
type SubmitRequestFn = (opts: {
  message: string; kind: 'service' | 'appointment' | 'reschedule' | 'plan_change'
  preferredDate?: string | null; jobId?: string | null; recurrenceId?: string | null
  details?: Record<string, unknown> | null
}) => Promise<boolean>

// What a customer can request comes from the owner's OWN catalogue
// (service_templates, via get_portal_data) — never a hardcoded list. The portal
// used to offer Mulch / Spring Cleanup / Fall Cleanup / Weed Control /
// Landscaping to everyone, so a pool company's customers were offered lawn work
// their company doesn't sell and couldn't request the work it does.
//
// Capped so the tab stays a decision, not a catalogue dump; the free-text
// "Something else?" ask below covers the rest and always works.
const MAX_REQUEST_PRESETS = 8

function liveStatusOf(j: PortalJob): LiveStatus {
  if (j.completed_at || j.status === 'completed') return 'completed'
  if (j.started_at || j.status === 'in_progress') return 'in_progress'
  if (j.on_my_way_at) return 'on_my_way'
  return 'scheduled'
}

// Defensive normalize: an OLDER get_portal_data — or a customer with no rows in a section —
// can return null/undefined for a collection (Postgres json_agg is null, not []). Coerce
// EVERY array so the portal can never white-screen. Shared by the server fetch (initialData)
// and the client revalidation below.
function normalizePortal(d: unknown): PortalData | null {
  const raw = (d ?? null) as Partial<PortalData> | null
  if (!raw) return null
  return {
    customer: raw.customer ?? { id: '', name: 'Customer', email: null, phone: null, address: null, city: null },
    business: raw.business ?? null,
    property: raw.property ?? null,
    properties: Array.isArray(raw.properties) ? raw.properties : [],
    // `services` was in the RPC but NOT in this literal, so data.services was always
    // undefined and the Request tab's presets — the owner's own catalogue, the thing
    // that makes this portal fit a pool company — never rendered once since the RPC
    // shipped them. Same failure mode this function invites for every key: rebuilding
    // the object by hand means a key the server sends is dropped silently, and tsc
    // can't catch it because every field it feeds is optional.
    services: Array.isArray(raw.services) ? raw.services : [],
    quotes: Array.isArray(raw.quotes) ? raw.quotes : [],
    invoices: Array.isArray(raw.invoices) ? raw.invoices : [],
    jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
    recurrences: Array.isArray(raw.recurrences) ? raw.recurrences : [],
    photos: Array.isArray(raw.photos) ? raw.photos : [],
    payments: Array.isArray(raw.payments) ? raw.payments : [],
    payment_method: raw.payment_method ?? null,
  }
}

export function PortalClient({ token, initialData }: { token: string; initialData: unknown }) {
  const supabase = useMemo(() => createClient(), [])
  // Seeded from the server fetch → real content on first paint (no spinner). load() below
  // only runs as a fallback / for post-payment revalidation.
  const [data, setData] = useState<PortalData | null>(() => normalizePortal(initialData))
  const [loading, setLoading] = useState(initialData == null)
  const [tab, setTab] = useState<Tab>('home')
  const [accepting, setAccepting] = useState<string | null>(null)
  const [reqMsg, setReqMsg] = useState('')
  const [reqBusy, setReqBusy] = useState<string | null>(null)
  const [reqSent, setReqSent] = useState<string | null>(null)
  const [paymentsEnabled, setPaymentsEnabled] = useState(false)
  const [payingId, setPayingId] = useState<string | null>(null)
  // 'confirming' = the customer came back from Stripe but our ledger hasn't recorded it
  // yet; 'confirmed' = a new payment row actually landed. Never conflate the two.
  const [justPaid, setJustPaid] = useState<'confirming' | 'confirmed' | null>(null)
  const [justAccepted, setJustAccepted] = useState(false)
  // The Documents tab opens pre-filtered to what the customer came for (the
  // signpost filters to quotes, the balance path to invoices).
  const [docsCat, setDocsCat] = useState<'all' | 'quote' | 'invoice'>('all')
  // One inline error surface for portal actions (pay / accept / request) — fixed,
  // friendly copy near the top of the content, never a browser alert.
  const [actionError, setActionError] = useState<string | null>(null)
  const [consent, setConsentState] = useState<{ sms: boolean; email: boolean } | null>(() => {
    const pd = normalizePortal(initialData)
    return pd ? { sms: !!pd.customer?.sms_opt_in, email: !!pd.customer?.email_opt_in } : null
  })
  const [markedReviewed, setMarkedReviewed] = useState(false)
  // Seeded from the customer record, so a decline saved on an earlier visit keeps the
  // card down — the whole point of persisting it.
  const [reviewDeclined, setReviewDeclined] = useState(() => !!normalizePortal(initialData)?.customer?.review_declined_at)

  async function load() {
    const { data: d } = await supabase.rpc('get_portal_data', { p_token: token })
    const pd = normalizePortal(d)
    setData(pd)
    if (pd) setConsentState({ sms: !!pd.customer?.sms_opt_in, email: !!pd.customer?.email_opt_in })
    setLoading(false)
    return pd
  }

  // Self-serve consent — updates the customer record immediately (token-scoped RPC).
  // `prefs` carries the per-category choices (reminders / invoices / estimates /
  // marketing / seasonal); omitted = leave stored categories unchanged.
  async function saveConsent(next: { sms: boolean; email: boolean }, prefs?: Record<string, boolean>) {
    const prev = consent
    setConsentState(next)
    const { data: ok, error } = await supabase.rpc('portal_set_consent', { p_token: token, p_sms_opt_in: next.sms, p_email_opt_in: next.email, p_prefs: prefs ?? null })
    if (error || !ok) {
      setConsentState(prev)                    // roll back — never show a state the server didn't save
      setActionError('We couldn’t save your message preferences — please try again.')
    }
  }

  // Customer confirms they left a review → records it (notifies the owner, stops
  // future review-request messages). Optimistic with rollback; token-scoped RPC.
  async function markReviewed() {
    if (markedReviewed) return                 // double-click guard (already confirmed)
    setMarkedReviewed(true)
    const { data: ok, error } = await supabase.rpc('portal_mark_reviewed', { p_token: token })
    if (error || !ok) setMarkedReviewed(false)
  }
  // "No thanks" — the customer declining to be asked. This used to be React state that
  // died with the tab: the card returned on their next visit and api/cron/notifications
  // kept sending review requests, because it suppresses on customers.review_declined_at
  // and nothing here could write it. Saying no has to mean no, or the button is theatre.
  // Same token-scoped shape as markReviewed; no new rule — the cron already honours this
  // column, and the owner's ReviewLifecycle already writes it.
  async function declineReview() {
    if (reviewDeclined) return                 // double-click guard
    setReviewDeclined(true)
    const { data: ok, error } = await supabase.rpc('portal_decline_review', { p_token: token })
    // Rolling back means the card reappears — right, because the decline wasn't saved.
    // Silently keeping it hidden would repeat the exact bug this fixes.
    if (error || !ok) { setReviewDeclined(false); setActionError('We couldn’t save that — please try again.') }
  }
  // Server already provided initialData → no client fetch on first paint. Only fetch here
  // as a fallback (e.g. a direct client navigation where the server skipped it).
  useEffect(() => { if (initialData == null) load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Payments availability + return-from-Stripe. ?paid=1 → the webhook marks the
  // invoice paid a beat later, so refetch shortly after.
  useEffect(() => {
    fetch('/api/payments/status').then(r => r.json()).then(d => setPaymentsEnabled(!!d.enabled)).catch(() => {})
    if (typeof window !== 'undefined') {
      const sp = new URLSearchParams(window.location.search)
      if (sp.get('paid') === '1') {
        // ?paid=1 only means the customer reached Stripe's return URL — the WEBHOOK is
        // what records the money. Asserting "Payment received" from this param alone is a
        // guess: if the webhook is misconfigured, Stripe took the payment, our ledger never
        // learned, and the customer holds a green success banner while the balance below it
        // still reads the full amount. Confirm against the reloaded ledger before claiming
        // it — the dashboard already refuses to tell this lie (invoices/page.tsx:164-167).
        const before = data?.payments.length ?? 0
        setJustPaid('confirming')
        window.history.replaceState({}, '', `/portal/${token}`)
        setTimeout(async () => {
          const pd = await load()
          setJustPaid((pd?.payments.length ?? 0) > before ? 'confirmed' : 'confirming')
        }, 1500)
      }
      // Back from the hosted card-setup page — the webhook saves the card a beat
      // later, so reload shortly to show it.
      if (sp.get('cardsaved') === '1') {
        setTab('payments')
        window.history.replaceState({}, '', `/portal/${token}`)
        setTimeout(() => load(), 1500)
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function photoUrl(path: string) { return supabase.storage.from('job-photos').getPublicUrl(path).data.publicUrl }

  async function accept(qid: string) {
    if (accepting) return                      // double-click guard
    // Approving commits the customer to a quote value — mirror the confirm we ask
    // before removing a card, so a stray tap can't accept a job by accident.
    const q = data?.quotes.find(x => x.id === qid)
    const svc = (q?.service_type || '').trim()
    // Never ask someone to approve an amount without showing it. The dialog named the
    // service but not the price, so the homeowner's last step before committing money
    // was the only one that didn't mention money — and nothing told them that approving
    // isn't paying, which is the thing they're most afraid of when they tap.
    const amount = Number(q?.total) || 0
    const plan = q ? ([
      Number(q.weekly_price) > 0 ? `${formatCurrency(Number(q.weekly_price))} per weekly visit` : null,
      Number(q.biweekly_price) > 0 ? `${formatCurrency(Number(q.biweekly_price))} per bi-weekly visit` : null,
      Number(q.monthly_price) > 0 ? `${formatCurrency(Number(q.monthly_price))} per month` : null,
    ].filter(Boolean)[0] as string | undefined) : undefined
    const gst = Number(data?.business?.gst_percent) || 0
    const what = svc ? `${svc} for ${formatCurrency(amount)}` : formatCurrency(amount)
    const confirmed = await confirmDialog({
      title: `Approve ${formatCurrency(amount)}?`,
      message: [
        `You're approving ${what}${gst > 0 ? `, plus GST (${gst}%) added on your invoice` : ''}.`,
        plan ? `Ongoing visits after that are ${plan}.` : null,
        `Approving doesn't charge you — we'll confirm a date with you first, and you'll only get an invoice after the work is done.`,
      ].filter(Boolean).join(' '),
      confirmLabel: `Approve ${formatCurrency(amount)}`,
    })
    if (!confirmed) return
    setAccepting(qid)
    setActionError(null)
    const { data: ok } = await supabase.rpc('portal_accept_quote', { p_token: token, p_quote_id: qid })
    if (ok) {
      setData(d => d ? { ...d, quotes: d.quotes.map(q => q.id === qid ? { ...q, status: 'accepted' } : q) } : d)
      // Close the loop — the customer must SEE their approval registered and
      // know what happens next (same pattern as the payment-received banner).
      setJustAccepted(true)
    }
    else setActionError('We couldn’t record your approval — please try again, or reply to any message from us and we’ll take care of it.')
    setAccepting(null)
  }
  async function request(message: string, key: string) {
    if (!message.trim()) return
    setReqBusy(key)
    setActionError(null)
    const { data: ok } = await supabase.rpc('portal_request_service', { p_token: token, p_message: message.trim() })
    setReqBusy(null)
    if (ok) { setReqSent(key); if (key === 'custom') setReqMsg(''); setTimeout(() => setReqSent(null), 4000) }
    else setActionError('Your request didn’t go through — please try again, or call us directly.')
  }
  // Structured requests (appointment / reschedule / plan change) — same pipeline as
  // request() above, carrying the structure alongside the human-readable message.
  // The RPC re-verifies that any referenced job/plan belongs to this token's customer.
  const submitRequest: SubmitRequestFn = async (opts) => {
    setActionError(null)
    const { data: ok, error } = await supabase.rpc('portal_submit_request', {
      p_token: token, p_message: opts.message, p_kind: opts.kind,
      p_preferred_date: opts.preferredDate ?? null, p_job_id: opts.jobId ?? null,
      p_recurrence_id: opts.recurrenceId ?? null, p_details: opts.details ?? null,
    })
    if (error || !ok) { setActionError('Your request didn’t go through — please try again, or call us directly.'); return false }
    return true
  }
  // The customer opened this invoice (PDF or pay) — stamp viewed_at once so the
  // owner's list shows 'Viewed'. Fire-and-forget; idempotent server-side.
  function markInvoiceViewed(invoiceId: string) {
    supabase.rpc('portal_mark_invoice_viewed', { p_token: token, p_invoice_id: invoiceId }).then(() => {}, () => {})
  }
  async function pay(invoiceId: string) {
    if (payingId) return                       // re-entry guard — never start two checkout sessions
    setPayingId(invoiceId)
    markInvoiceViewed(invoiceId)
    try {
      const res = await fetch('/api/portal/pay', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, invoiceId }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok && d.url) { window.location.href = d.url; return }   // redirecting to Stripe — stay disabled
      // Public portal: show a FIXED message — never render a server-provided string.
      setActionError('We couldn’t start the payment — please try again in a moment, or contact us and we’ll sort it out.')
    } catch {
      setActionError('We couldn’t start the payment — please try again in a moment, or contact us and we’ll sort it out.')
    }
    setPayingId(null)   // only reached on failure — a successful redirect already left the page
  }

  // ── derived ──
  const derived = useMemo<Derived | null>(() => {
    if (!data) return null
    const todayISO = format(new Date(), 'yyyy-MM-dd')
    const jobs = data.jobs || []
    const upcoming = jobs.filter(j => j.scheduled_date >= todayISO && j.status !== 'completed').sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))
    // Sorted by when the work HAPPENED, not when it was planned — otherwise a
    // rain-delayed visit sits below one it actually followed, and lastCompleted (which
    // also gates the review card) can name the wrong visit entirely.
    const completed = jobs.filter(j => j.status === 'completed').sort((a, b) => visitDay(b).localeCompare(visitDay(a)))
    const nextService = upcoming[0] || null
    const lastCompleted = completed[0] || null
    // Outstanding = unpaid BALANCE (total − payments recorded) across issued invoices,
    // so partial payments and discounts are reflected. Same engine as the dashboard.
    const gstPct = Number(data.business?.gst_percent) || 0
    const outstanding = (data.invoices || []).filter(i => i.status !== 'draft' && i.status !== 'cancelled').reduce((s, i) => {
      const total = invoiceTotals(i.amount, { gst_percent: gstPct }, { type: i.discount_type, value: i.discount_value }).total
      return s + Math.max(0, Math.round((total - (Number(i.amount_paid) || 0)) * 100) / 100)
    }, 0)
    // Service plans come from THE shared engine (lib/recurrence.buildServicePlans) —
    // the exact function the owner's customer page runs, so the two can never
    // disagree about a plan. It reads the RECURRENCE as the source of truth rather
    // than inferring from upcoming jobs, which is what used to make a plan vanish
    // from the portal the moment its scheduled horizon ran out. A series with no
    // future visits now reports paused:true instead of disappearing.
    const seasons = settingsToSeasons(data.business?.service_seasons)
    const quoteById = new Map(data.quotes.map(q => [q.id, q]))
    // THE per-visit valuation (lib/invoicing.jobVisitValue), identical to the
    // owner's planValueOf — so "$65/visit" here is the same number they see.
    const planValueOf = (j: Job) => {
      const q = j.quote_id ? quoteById.get(j.quote_id) : null
      const freq = data.recurrences.find(r => r.id === j.recurrence_id)?.freq ?? null
      return jobVisitValue(j.price, q as unknown as Record<string, unknown>, freq, j.is_initial_visit)
    }
    // nextJobId rides alongside the engine's plan: the concrete visit a "skip next
    // visit" request points at. `upcoming` is already date-sorted, so the first
    // match IS the plan's next visit — the same job nextVisitDate names.
    const plans = buildServicePlans(
      data.recurrences as unknown as JobRecurrence[],
      jobs as unknown as Job[],
      seasons,
      todayISO,
      planValueOf,
    ).map(p => ({ ...p, nextJobId: upcoming.find(j => j.recurrence_id === p.recurrenceId)?.id || null }))
    return { upcoming, completed, nextService, lastCompleted, outstanding, plans }
  }, [data])

  if (loading) return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 text-center px-8">
      <div className="w-11 h-11 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center"><Leaf className="w-5 h-5 text-accent-text" /></div>
      <p className="text-sm text-ink-muted flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading your account…</p>
    </div>
  )
  if (!data || !derived) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-8 text-center">
        <Leaf className="w-10 h-10 text-ink-faint mb-3" />
        <p className="text-lg font-semibold text-ink">This link isn’t valid</p>
        <p className="text-sm text-ink-muted mt-1">It may have expired. Please contact your service provider for a new link.</p>
      </div>
    )
  }

  const biz = data.business
  // The services this business actually offers, in the owner's own order. Empty
  // when the catalogue is empty OR when an older get_portal_data served this
  // page — both degrade to the free-text ask rather than to someone else's
  // service list.
  const requestPresets = (data.services ?? [])
    .map(s => s.name?.trim())
    .filter((n): n is string => !!n)
    .slice(0, MAX_REQUEST_PRESETS)
  const first = (data.customer?.name || '').trim().split(' ')[0] || 'there'
  const photosByJob = groupPhotos(data.photos)
  const invoiceByJob = new Map((data.invoices || []).filter(i => i.job_id).map(i => [i.job_id as string, i]))

  // Ordered by how often a customer reaches for each: Home first, then Documents
  // (their central records hub) immediately after, then the things they act on (pay
  // invoices, accept quotes, manage payments), then service history & photos, then
  // the rest. Tabs whose section would be EMPTY are hidden (a fresh quote
  // recipient sees Home/Documents/Request, not five dead ends) — each appears
  // as soon as it has content.
  // Documents IS the quotes+invoices hub (search, filters, pay & accept on the
  // row) — no separate Invoices/Quotes tabs repeating the same records.
  const hasProperty = !!(data.property && (data.property.address || data.property.lawn_sqft || data.property.fence_length || data.property.neighborhood))
  const TABS: { key: Tab; label: string; icon: typeof Home; n?: number }[] = ([
    { key: 'home', label: 'Home', icon: Home },
    // Count what the tab actually SHOWS — DocumentsTab hides draft invoices (the owner's
    // unfinished work), so counting them here would promise a document that isn't there.
    { key: 'documents', label: 'Documents', icon: FolderOpen, n: data.quotes.length + data.invoices.filter(i => i.status !== 'draft').length },
    { key: 'payments', label: 'Payments', icon: Wallet, n: data.payments.length },
    { key: 'service', label: 'Service', icon: History, n: derived.completed.length },
    { key: 'photos', label: 'Photos', icon: ImageIcon, n: data.photos.length },
    { key: 'timeline', label: 'Timeline', icon: Activity },
    { key: 'property', label: 'Property', icon: MapPin },
    // Messages is always visible — like Request, the empty state IS the invitation
    // (the composer), not a dead end.
    { key: 'messages', label: 'Messages', icon: MessageSquare },
    { key: 'request', label: 'Request', icon: MessageSquarePlus },
  ] as { key: Tab; label: string; icon: typeof Home; n?: number }[]).filter(t =>
    t.key === 'payments' ? (data.payments.length > 0 || (data.invoices || []).length > 0) :
    t.key === 'service' ? derived.completed.length > 0 :
    t.key === 'photos' ? data.photos.length > 0 :
    t.key === 'property' ? hasProperty :
    t.key === 'timeline' ? (data.quotes.length + data.jobs.length + data.invoices.length + data.payments.length + data.photos.length) > 0 :
    true)

  return (
    <div className="min-h-screen bg-bg">
      <div className="max-w-lg mx-auto px-4 py-5 pb-28">
        {/* Brand header */}
        <div className="flex items-center gap-3 mb-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {biz?.logo_url ? <img src={biz.logo_url} alt="" className="h-10 w-auto object-contain" /> : <div className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center"><Leaf className="w-5 h-5 text-accent-text" /></div>}
          <div className="min-w-0">
            <p className="text-base font-bold text-ink truncate tracking-tight">{biz?.company_name || 'Your Service Provider'}</p>
            {/* Plain "Welcome" — a first-time quote recipient has never been here. */}
            <p className="text-xs text-ink-muted">Welcome, {first}</p>
          </div>
        </div>

        {/* Sticky tab bar */}
        <div className="sticky top-0 z-10 -mx-4 px-4 py-2 bg-bg/90 backdrop-blur border-b border-border">
          <div className="flex gap-1.5 overflow-x-auto">
            {TABS.map(t => (
              <button key={t.key} onClick={() => { if (t.key === 'documents') setDocsCat('all'); setTab(t.key) }}
                className={cn('shrink-0 flex items-center gap-1.5 text-xs font-medium rounded-full px-3 py-2 border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                  tab === t.key ? 'bg-accent text-black border-accent' : 'border-border text-ink-muted hover:text-ink')}>
                <t.icon className="w-3.5 h-3.5" /> {t.label}{t.n != null && t.n > 0 && <span className="opacity-70 tabular-nums">{t.n}</span>}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          {justPaid === 'confirmed' && (
            <div className="mb-3 rounded-card border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 text-sm px-4 py-3 flex items-start justify-between gap-3">
              <span className="flex items-start gap-2 font-medium">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <span>Payment received — thank you!{' '}
                  <button onClick={() => setTab('payments')} className="underline underline-offset-2 hover:opacity-80">View your receipt →</button>
                </span>
              </span>
              <button onClick={() => setJustPaid(null)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100"><X className="w-4 h-4" /></button>
            </div>
          )}
          {justPaid === 'confirming' && (
            <div className="mb-3 rounded-card border border-border bg-bg-tertiary text-ink-muted text-sm px-4 py-3 flex items-start justify-between gap-3">
              <span className="flex items-start gap-2 font-medium">
                <Clock className="w-4 h-4 shrink-0 mt-0.5" />
                <span>Checkout completed — confirming your payment…{' '}
                  <span className="font-normal">Your receipt will appear here once it&rsquo;s confirmed. You don&rsquo;t need to pay again.</span>
                </span>
              </span>
              <button onClick={() => setJustPaid(null)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100"><X className="w-4 h-4" /></button>
            </div>
          )}
          {justAccepted && (
            <div className="mb-3 rounded-card border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 text-sm font-medium px-4 py-3 flex items-start justify-between gap-3">
              {/* "We'll be in touch" is the line that leaves people wondering for a week.
                  Say who will reach out and — more useful — where the answer will appear,
                  so they can check instead of wait. */}
              <span className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <span>Quote approved — thank you!{' '}
                  <span className="font-normal">{biz?.company_name || 'We'}&rsquo;ll contact you to agree a date. Once it&rsquo;s booked, your visit appears on this page — nothing else to do for now.</span>
                </span>
              </span>
              <button onClick={() => setJustAccepted(false)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100"><X className="w-4 h-4" /></button>
            </div>
          )}
          {actionError && (
            <div className="mb-3 rounded-card border border-red-500/25 bg-red-500/10 text-red-400 text-sm font-medium px-4 py-3 flex items-start justify-between gap-3">
              <span>{actionError}</span>
              <button onClick={() => setActionError(null)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100"><X className="w-4 h-4" /></button>
            </div>
          )}
          {tab === 'home' && <HomeTab suppressApproved={justAccepted} data={data} derived={derived} biz={biz} onRequest={() => setTab('request')}
            paymentsEnabled={paymentsEnabled} pay={pay} payingId={payingId}
            onOpenInvoices={() => { setDocsCat('invoice'); setTab('documents') }}
            onReviewQuotes={() => { setDocsCat('quote'); setTab('documents') }}
            onMessages={() => setTab('messages')} submitRequest={submitRequest} />}
          {tab === 'home' && biz?.review_url && derived.lastCompleted && !data.customer.reviewed_at && !reviewDeclined && (
            <ReviewCard reviewUrl={biz.review_url} businessName={biz.company_name} reviewed={markedReviewed} onReviewed={markReviewed} onDecline={declineReview} />
          )}
          {tab === 'home' && consent && <ConsentCard token={token} consent={consent} onSave={saveConsent} />}
          {tab === 'timeline' && <TimelineTab data={data} photosByJob={photosByJob} />}
          {tab === 'service' && <ServiceTab completed={derived.completed} photosByJob={photosByJob} invoiceByJob={invoiceByJob} photoUrl={photoUrl} gstPct={Number(data.business?.gst_percent) || 0} onOpenPhotos={() => setTab('photos')} />}
          {tab === 'photos' && <GalleryTab photosByJob={photosByJob} jobs={data.jobs} photoUrl={photoUrl} />}
          {tab === 'property' && <PropertyTab property={data.property} />}
          {tab === 'payments' && <PaymentsTab customerName={data.customer.name} fallbackAddress={data.property?.address || data.customer.address || null} business={biz} payments={data.payments} invoices={data.invoices} outstanding={derived.outstanding}
            token={token} paymentsEnabled={paymentsEnabled} card={data.payment_method ?? null} autopayEnabled={!!data.customer.autopay_enabled} onChanged={load} />}
          {tab === 'documents' && <DocumentsTab quotes={data.quotes} invoices={data.invoices} customerName={data.customer.name} fallbackAddress={data.property?.address || data.customer.address || null} properties={data.properties ?? []} business={biz} onInvoiceOpen={markInvoiceViewed}
            paymentsEnabled={paymentsEnabled} pay={pay} payingId={payingId} accept={accept} accepting={accepting} initialCat={docsCat} />}
          {tab === 'messages' && <MessagesTab token={token} businessName={biz?.company_name || null} />}
          {tab === 'request' && (
            <RequestTab presets={requestPresets} reqMsg={reqMsg} setReqMsg={setReqMsg} request={request} reqBusy={reqBusy} reqSent={reqSent} biz={biz} submitRequest={submitRequest} />
          )}
        </div>

        <p className="text-center text-[10px] text-ink-faint mt-10">Powered by EdgeQuote</p>
      </div>
      {/* Styled confirmation dialogs (card removal, etc.) — same experience as the app. */}
      <ConfirmHost />
    </div>
  )
}

// ── Live status ──
const STATUS_META: Record<LiveStatus, { label: string; icon: typeof Play; tone: string }> = {
  scheduled: { label: 'Scheduled', icon: CalendarClock, tone: 'text-ink-muted border-border bg-bg-tertiary' },
  on_my_way: { label: 'On My Way', icon: Navigation, tone: 'text-sky-400 border-sky-500/30 bg-sky-500/10' },
  in_progress: { label: 'In Progress', icon: Play, tone: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
  completed: { label: 'Completed', icon: CheckCircle2, tone: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
}
// THE day a visit actually happened. A rained-out visit is scheduled for Tuesday and
// completed on Thursday — and the customer remembers Thursday, because that's when
// someone was in their garden. Reading scheduled_date instead put the wrong visit at
// the top of "Last completed" and printed a date they know is wrong, while the Timeline
// (which already reads completed_at) printed the right one. One visit, one date.
function visitDay(j: { scheduled_date: string; completed_at: string | null }): string {
  return j.completed_at ? j.completed_at.slice(0, 10) : j.scheduled_date
}

// "Thursday, July 17" is a fact nobody converts in their head; "Tomorrow" is the
// answer they actually wanted. The absolute date stays — this sits beside it and
// answers "how soon?". Beyond two weeks the countdown stops being useful and the
// date carries it alone, so this returns null rather than "In 43 days".
function daysAwayLabel(dateISO: string, todayISO: string): string | null {
  const days = Math.round((parseLocalDate(dateISO).getTime() - parseLocalDate(todayISO).getTime()) / 86_400_000)
  if (days < 0 || days > 14) return null
  return days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `In ${days} days`
}

function StatusPill({ s }: { s: LiveStatus }) {
  const m = STATUS_META[s]
  return <span className={cn('inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border', m.tone)}><m.icon className="w-3 h-3" /> {m.label}</span>
}
function StatusStepper({ s }: { s: LiveStatus }) {
  const order: LiveStatus[] = ['scheduled', 'on_my_way', 'in_progress', 'completed']
  const idx = order.indexOf(s)
  return (
    <div className="flex items-center gap-1 mt-3">
      {order.map((step, i) => (
        <div key={step} className="flex-1 flex items-center gap-1">
          <div className={cn('h-1.5 flex-1 rounded-full', i <= idx ? 'bg-accent' : 'bg-border')} />
        </div>
      ))}
    </div>
  )
}

// ── Home ──
function HomeTab({ data, derived, biz, onRequest, paymentsEnabled, pay, payingId, onOpenInvoices, onReviewQuotes, suppressApproved, onMessages, submitRequest }: {
  data: PortalData; derived: Derived; biz: PortalData['business']; onRequest: () => void
  paymentsEnabled: boolean; pay: (id: string) => void; payingId: string | null; onOpenInvoices: () => void; onReviewQuotes: () => void
  suppressApproved?: boolean
  onMessages: () => void; submitRequest: SubmitRequestFn
}) {
  const next = derived.nextService
  // A quote awaiting approval is usually WHY the customer opened this link —
  // signpost it up top instead of making them discover the Documents tab.
  // An EXPIRED quote is not awaiting anything: this hero says "Your quote is ready ·
  // $2,150 — review and approve when you're ready" and taps through to a Documents row
  // that now says the price has lapsed. Same engine as that row, so the two agree.
  const awaiting = (data.quotes || []).filter(q =>
    displayQuoteStatus({ status: q.status as QuoteStatus, valid_until: q.valid_until }, localTodayISO()) === 'sent')
  // A pure prospect (quote in hand, no visits or invoices yet) came to review
  // the quote — skip the empty "no visit scheduled" hero and $0/— stat cards
  // that would push it down and invite the wrong action.
  const prospect = awaiting.length > 0 && !next && derived.completed.length === 0 && (data.invoices || []).length === 0
  // Approved but nothing on the calendar yet — reassure instead of the generic
  // "no upcoming visit" message (they just said yes; the ball is in our court).
  const approvedPending = !next && !suppressApproved && (data.quotes || []).some(q => q.status === 'accepted')
  // A PARTIALLY paid invoice must reach checkout too (server charges only the remaining balance).
  const owing = (data.invoices || []).filter(i => i.status === 'unpaid' || i.status === 'sent' || i.status === 'partial')
  // Tapping the balance goes straight to paying: one owing invoice + online payments
  // on → open its checkout directly; otherwise jump to the Invoices tab to pick one.
  function payOutstanding() {
    if (payingId) return
    if (paymentsEnabled && owing.length === 1) pay(owing[0].id)
    else onOpenInvoices()
  }
  return (
    <div className="space-y-3">
      {/* Quote awaiting approval — one tap to the Documents tab, pre-filtered to quotes */}
      {awaiting.length > 0 && (
        <button type="button" onClick={onReviewQuotes}
          className="w-full text-left rounded-card border border-amber-500/30 bg-amber-500/10 p-4 hover:border-amber-500/50 active:scale-[0.99] transition-colors card-lift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-400 flex items-center justify-center shrink-0"><FileText className="w-4 h-4" /></div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink truncate">
                  {awaiting.length === 1
                    ? (awaiting[0].service_type ? `Your ${awaiting[0].service_type} quote is ready` : 'Your quote is ready')
                    : `${awaiting.length} quotes are ready for your review`}
                </p>
                <p className="text-xs text-ink-muted">
                  {awaiting.length === 1 ? `${formatCurrency(Number(awaiting[0].total) || 0)} — review and approve when you're ready` : `Review and approve when you're ready`}
                </p>
                {awaiting.length === 1 && (
                  <p className="text-[11px] text-ink-faint mt-0.5">Valid until {formatDate(new Date(new Date(awaiting[0].issued_date || awaiting[0].created_at).getTime() + 30 * 86400000).toISOString().slice(0, 10))}</p>
                )}
              </div>
            </div>
            <span className="text-xs font-semibold text-amber-400 shrink-0">Review →</span>
          </div>
        </button>
      )}

      {/* Next service hero (hidden for a pure prospect — the quote card above is their whole visit) */}
      {!prospect && (
      <div className="rounded-card border border-accent/20 hero-aurora p-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-accent-text mb-1">Next service</p>
        {next ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="text-lg font-bold text-ink tracking-tight">{next.service_type || next.title}</p>
              <StatusPill s={liveStatusOf(next)} />
            </div>
            <p className="text-sm text-ink-muted mt-0.5">
              {formatDate(next.scheduled_date)}
              {(() => { const a = daysAwayLabel(next.scheduled_date, localTodayISO()); return a ? <span className="text-ink font-medium"> · {a}</span> : null })()}
            </p>
            <StatusStepper s={liveStatusOf(next)} />
            {liveStatusOf(next) === 'on_my_way' && <p className="text-xs text-sky-400 mt-2 flex items-center gap-1"><Navigation className="w-3.5 h-3.5" /> Your provider is on the way!</p>}
            {/* Rescheduling used to mean composing a free-text message from scratch.
                Only offered while the visit is still merely scheduled — once someone
                is on their way, a date-change form is the wrong tool. */}
            {liveStatusOf(next) === 'scheduled' && <RescheduleRequest key={next.id} job={next} submitRequest={submitRequest} />}
          </>
        ) : approvedPending ? (
          <div>
            <p className="text-sm font-semibold text-ink flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> Your quote has been approved.
            </p>
            {/* This is the screen someone stares at for days after saying yes. "Will contact
                you shortly" gives them nothing to do but wonder — tell them where the answer
                will land and that reaching out is welcome. */}
            <p className="text-sm text-ink-muted mt-1">
              We&rsquo;re arranging your first visit. The date will appear here as soon as it&rsquo;s booked
              {biz && (biz.phone || biz.email_primary) ? ' — and you can call or email us any time using the buttons below.' : '.'}
            </p>
          </div>
        ) : (
          <div>
            <p className="text-sm text-ink-muted mb-3">No upcoming visit scheduled.</p>
            <Button onClick={onRequest} className="w-full sm:w-auto">
              <MessageSquarePlus className="w-4 h-4" /> Request a service
            </Button>
          </div>
        )}
      </div>
      )}

      {/* Stat cards — the balance is tappable straight to payment when money is owed */}
      {!prospect && (
      <div className="grid grid-cols-2 gap-3">
        {derived.outstanding > 0 ? (
          <button type="button" onClick={payOutstanding} disabled={payingId !== null}
            className="text-left rounded-card border border-amber-500/30 bg-amber-500/[0.06] p-3.5 transition-colors hover:border-amber-500/50 active:scale-[0.99] disabled:opacity-60 card-lift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
            {/* "Outstanding" is collections vocabulary — it lands like an accusation on the
                one tile someone reads when they're already tense about money. */}
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint flex items-center gap-1"><Receipt className="w-3 h-3" /> Amount due</p>
            <p className="text-lg font-bold mt-1 text-amber-400 tabular-nums">{formatCurrency(derived.outstanding)}</p>
            <span className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-accent-text">
              {payingId ? <Loader2 className="w-3 h-3 animate-spin" /> : <CreditCard className="w-3 h-3" />}
              {paymentsEnabled ? (owing.length === 1 ? `Pay ${owing[0].invoice_number}` : 'View & pay') : 'View invoices'}
            </span>
            {/* This tile jumps straight to Stripe when exactly one invoice is owing, so it
                needs the same reassurance the Documents row already carries — otherwise
                tapping a number to "see what it's made of" lands you on a payment page. */}
            {paymentsEnabled && owing.length === 1 && (
              <span className="mt-1 flex items-start gap-1 text-[10px] text-ink-faint">
                <ShieldCheck className="w-2.5 h-2.5 text-emerald-400 shrink-0 mt-0.5" /> Secure checkout by Stripe — you&rsquo;ll confirm on the next screen.
              </span>
            )}
          </button>
        ) : (
          <StatCard label="Amount due" value={formatCurrency(0)} tone="text-emerald-400" icon={Receipt} />
        )}
        <StatCard label="Last completed" value={derived.lastCompleted ? formatDate(visitDay(derived.lastCompleted)) : '—'} icon={CheckCircle2} />
      </div>
      )}

      {/* Your service plan — straight from the shared engine, so every fact here
          (cadence, day, window, next visit, price) is the same one the owner sees. */}
      {derived.plans.length > 0 && (
        <div className="rounded-card border border-border bg-bg-secondary p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint mb-2.5">
            Your service plan{derived.plans.length !== 1 ? 's' : ''}
          </p>
          <div className="space-y-2.5">
            {derived.plans.map(p => (
              <div key={p.recurrenceId}>
                <PlanRow p={p} />
                {/* The way out, on the plan itself. These SEND A REQUEST the owner
                    confirms — the plan doesn't change until a human says so, and the
                    copy says exactly that. Free-text "send us a message" stays below
                    for everything these don't cover. */}
                <PlanActions plan={p} businessName={biz?.company_name || null} submitRequest={submitRequest} />
              </div>
            ))}
          </div>
          {/* An ongoing arrangement with no visible way out is what makes people feel
              trapped — the buttons above are that way out. This line covers the asks
              that aren't a button (change frequency, different day of week, …). */}
          <p className="text-xs text-ink-muted mt-2.5 pt-2.5 border-t border-border/60">
            Anything else about your plan?{' '}
            <button type="button" onClick={onMessages} className="text-accent-text font-medium hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">Send us a message</button>
            {biz?.phone ? <> or call <a href={`tel:${biz.phone}`} className="text-accent-text font-medium hover:underline">{biz.phone}</a>.</> : '.'}
          </p>
        </div>
      )}

      {/* Property summary */}
      {data.property && (data.property.address || data.property.lawn_sqft) && (
        <div className="rounded-card border border-border bg-bg-secondary p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint mb-2">Your property</p>
          {data.property.address && <p className="text-sm text-ink flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5 text-ink-faint" /> {data.property.address}{data.property.city ? `, ${data.property.city}` : ''}</p>}
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-xs text-ink-muted">
            {data.property.neighborhood && <span>{data.property.neighborhood}</span>}
            {/* lawn_sqft holds a MEASURED AREA — the column name is historical and
                stays (it's returned by get_portal_data and read in 74 places), but
                the label must not tell a pool company we measured their lawn. */}
            {data.property.lawn_sqft ? <span className="flex items-center gap-1"><Ruler className="w-3 h-3" /> {Number(data.property.lawn_sqft).toLocaleString()} sq ft measured</span> : null}
            {data.property.fence_length ? <span>{data.property.fence_length} ft fence</span> : null}
          </div>
        </div>
      )}

      {/* Contact */}
      {biz && (biz.phone || biz.email_primary) && (
        <div className="flex flex-wrap gap-2">
          {biz.phone && <a href={`tel:${biz.phone}`} className="flex-1 min-w-[120px] flex items-center justify-center gap-1.5 text-sm font-medium rounded-xl border border-border bg-bg-secondary py-2.5 text-ink hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"><Phone className="w-4 h-4 text-accent-text" /> Call</a>}
          {biz.email_primary && <a href={`mailto:${biz.email_primary}`} className="flex-1 min-w-[120px] flex items-center justify-center gap-1.5 text-sm font-medium rounded-xl border border-border bg-bg-secondary py-2.5 text-ink hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"><Mail className="w-4 h-4 text-accent-text" /> Email</a>}
          {biz.website && <a href={biz.website.startsWith('http') ? biz.website : `https://${biz.website}`} target="_blank" rel="noopener noreferrer" className="flex-1 min-w-[120px] flex items-center justify-center gap-1.5 text-sm font-medium rounded-xl border border-border bg-bg-secondary py-2.5 text-ink hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"><Globe className="w-4 h-4 text-accent-text" /> Website</a>}
        </div>
      )}
    </div>
  )
}
// One recurring plan, as the shared engine reports it. Everything shown is a fact
// the engine derived — nothing is inferred here.
//
// `paused` means the series has history but no future visit booked. That is the
// honest word for it: we don't know it's cancelled (it may just be between
// seasons, or the schedule may not be built out yet), so we say what's true —
// no visits are booked — and put the way to ask right next to it. The old card
// simply hid such a plan, which is how a customer on a live plan could open the
// portal and be told nothing about it at all.
function PlanRow({ p }: { p: ServicePlan }) {
  const perVisit = p.recurringPrice ?? p.initialPrice
  return (
    <div className="rounded-xl border border-border bg-bg-tertiary/40 px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        <span className={cn('w-7 h-7 rounded-lg border flex items-center justify-center shrink-0 mt-0.5',
          p.paused ? 'border-border bg-bg-tertiary text-ink-faint' : 'border-accent/25 bg-accent/10 text-accent-text')}>
          <Repeat className="w-3.5 h-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink flex flex-wrap items-center gap-x-2 gap-y-1">
            {p.serviceName}
            <span className="text-xs font-medium text-ink-muted">· {p.cadenceLabel}</span>
            {p.paused && (
              <span className="text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border border-border text-ink-faint">
                No visits booked
              </span>
            )}
          </p>
          {/* Only render a fact the engine actually resolved — a missing weekday or
              window means it wasn't consistent/configured, not that it's unknown-blank. */}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-muted">
            {p.weekday && <span>Usually {p.weekday}</span>}
            {p.windowLabel && <span className="before:content-['·'] before:mr-2 first:before:hidden">{p.windowLabel}</span>}
            {perVisit != null && perVisit > 0 && (
              <span className="before:content-['·'] before:mr-2 first:before:hidden tabular-nums">{formatCurrency(perVisit)}/visit</span>
            )}
          </div>
          <p className="text-xs mt-1.5">
            {p.nextVisitDate ? (
              <span className="text-ink">
                Next visit <span className="font-semibold">{formatDate(p.nextVisitDate)}</span>
                {p.remaining > 1 && <span className="text-ink-muted"> · {p.remaining} booked</span>}
              </span>
            ) : (
              <span className="text-ink-muted">No upcoming visits booked yet.</span>
            )}
          </p>
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, tone, icon: Icon }: { label: string; value: string; tone?: string; icon: typeof Receipt }) {
  return (
    <div className="rounded-card border border-border bg-bg-secondary p-3.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint flex items-center gap-1"><Icon className="w-3 h-3" /> {label}</p>
      <p className={cn('text-lg font-bold mt-1 tabular-nums', tone || 'text-ink')}>{value}</p>
    </div>
  )
}

// ── Reschedule request (on the next-visit hero) ────────────────────────────────
// A quiet link that unfolds into a two-field form. It sends a REQUEST — the visit
// stays exactly where it is until the owner confirms, and the confirmation copy
// says so, because "I tapped a button" must never be mistaken for "it moved".
// Keyed by job id from the parent, so a different next visit gets a fresh form.
function RescheduleRequest({ job, submitRequest }: { job: PortalJob; submitRequest: SubmitRequestFn }) {
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  if (sent) return (
    <p className="text-xs text-emerald-400 mt-3 pt-3 border-t border-border/40 flex items-start gap-1.5">
      <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>Request sent — we&rsquo;ll confirm your new date here and by message. Your visit stays on {formatDate(job.scheduled_date)} until then.</span>
    </p>
  )
  if (!open) return (
    <p className="text-xs text-ink-muted mt-3 pt-3 border-t border-border/40">
      Date doesn&rsquo;t work?{' '}
      <button type="button" onClick={() => setOpen(true)} className="text-accent-text font-medium hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
        Request a different date
      </button>
    </p>
  )
  return (
    <form className="mt-3 pt-3 border-t border-border/40 space-y-2"
      onSubmit={async e => {
        e.preventDefault()
        if (!date || busy) return
        setBusy(true)
        const svc = job.service_type || job.title
        const ok = await submitRequest({
          kind: 'reschedule', jobId: job.id, preferredDate: date,
          message: `Reschedule request: ${svc} on ${formatDate(job.scheduled_date)} — could we move it to ${formatDate(date)}?${note.trim() ? ` ${note.trim()}` : ''}`,
        })
        setBusy(false)
        if (ok) setSent(true)
      }}>
      <label className="block text-xs font-medium text-ink" htmlFor="resched-date">What date works better?</label>
      <input id="resched-date" type="date" required value={date} min={localTodayISO()} onChange={e => setDate(e.target.value)}
        className="w-full h-10 px-3 rounded-xl bg-bg-tertiary border border-border-strong text-base sm:text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
      <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} aria-label="Anything we should know?" placeholder="Anything we should know? (optional)"
        className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
      <div className="flex items-center gap-2">
        <Button size="sm" type="submit" loading={busy} disabled={!date}><CalendarClock className="w-4 h-4" /> Send request</Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>Never mind</Button>
      </div>
      <p className="text-[11px] text-ink-faint">This sends a request — your visit stays booked as is until we confirm the new date with you.</p>
    </form>
  )
}

// ── Plan actions (skip next / pause / cancel — all requests, never mutations) ──
function PlanActions({ plan, businessName, submitRequest }: {
  plan: Derived['plans'][number]; businessName: string | null; submitRequest: SubmitRequestFn
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const who = businessName || 'we'
  async function act(action: 'skip_next' | 'pause' | 'cancel') {
    if (busy) return
    const copy = action === 'skip_next' ? {
      title: 'Skip your next visit?',
      confirm: `This sends a request to skip your ${plan.serviceName} visit${plan.nextVisitDate ? ` on ${formatDate(plan.nextVisitDate)}` : ''}. Nothing changes until ${who === 'we' ? 'we confirm' : `${who} confirms`} with you — the rest of your plan stays as is.`,
      msg: `Plan change request: please skip my next ${plan.serviceName} visit${plan.nextVisitDate ? ` on ${formatDate(plan.nextVisitDate)}` : ''}. Keep the rest of my ${plan.cadenceLabel.toLowerCase()} plan as is.`,
      done: `Request sent — your visit${plan.nextVisitDate ? ` on ${formatDate(plan.nextVisitDate)}` : ''} stays booked until we confirm the skip with you.`,
    } : action === 'pause' ? {
      title: 'Pause your plan?',
      confirm: `This sends a request to pause your ${plan.cadenceLabel.toLowerCase()} ${plan.serviceName} plan. Nothing changes until ${who === 'we' ? 'we confirm' : `${who} confirms`} with you.`,
      msg: `Plan change request: please pause my ${plan.cadenceLabel.toLowerCase()} ${plan.serviceName} plan for now — I'll be in touch about starting it back up.`,
      done: 'Pause request sent — we’ll confirm with you before anything changes.',
    } : {
      title: 'Cancel your plan?',
      confirm: `This sends a cancellation request for your ${plan.cadenceLabel.toLowerCase()} ${plan.serviceName} plan. ${who === 'we' ? 'We' : who}’ll be in touch to confirm — nothing is cancelled until then.`,
      msg: `Plan change request: I'd like to cancel my ${plan.cadenceLabel.toLowerCase()} ${plan.serviceName} plan. Please confirm the cancellation with me.`,
      done: 'Cancellation request sent — we’ll be in touch to confirm.',
    }
    const confirmed = await confirmDialog({ title: copy.title, message: copy.confirm, confirmLabel: 'Send request', destructive: action === 'cancel' })
    if (!confirmed) return
    setBusy(action)
    const ok = await submitRequest({
      kind: 'plan_change', recurrenceId: plan.recurrenceId,
      jobId: action === 'skip_next' ? plan.nextJobId : null,
      details: { action }, message: copy.msg,
    })
    setBusy(null)
    if (ok) setSent(copy.done)
  }
  if (sent) return (
    <p className="text-xs text-emerald-400 mt-2 pl-[22px] flex items-start gap-1.5">
      <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" /> <span>{sent}</span>
    </p>
  )
  const btn = 'inline-flex items-center gap-1 text-xs font-medium rounded-lg border border-border bg-bg-tertiary px-2.5 py-1.5 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'
  return (
    <div className="flex flex-wrap gap-1.5 mt-2 pl-[22px]">
      {plan.nextVisitDate && plan.nextJobId && (
        <button type="button" disabled={busy !== null} onClick={() => act('skip_next')} className={cn(btn, 'text-ink-muted hover:text-ink hover:border-border-strong')}>
          {busy === 'skip_next' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <SkipForward className="w-3.5 h-3.5" />} Skip next visit
        </button>
      )}
      <button type="button" disabled={busy !== null} onClick={() => act('pause')} className={cn(btn, 'text-ink-muted hover:text-ink hover:border-border-strong')}>
        {busy === 'pause' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PauseCircle className="w-3.5 h-3.5" />} Pause plan
      </button>
      <button type="button" disabled={busy !== null} onClick={() => act('cancel')} className={cn(btn, 'text-red-400/70 hover:text-red-400 hover:border-red-500/30')}>
        {busy === 'cancel' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />} Cancel plan
      </button>
    </div>
  )
}

// ── Service timeline (grouped by visit) ──
function ServiceTab({ completed, photosByJob, invoiceByJob, photoUrl, gstPct, onOpenPhotos }: { completed: PortalJob[]; photosByJob: Map<string, PortalPhoto[]>; invoiceByJob: Map<string, PortalInvoice>; photoUrl: (p: string) => string; gstPct: number; onOpenPhotos: () => void }) {
  if (completed.length === 0) return <Empty icon={History} text="No completed visits yet — your service history will appear here after your first visit." />
  return (
    <div className="space-y-3">
      {completed.map(j => {
        const photos = photosByJob.get(j.id) || []
        const inv = invoiceByJob.get(j.id)
        return (
          <div key={j.id} className="rounded-card border border-border bg-bg-secondary p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-ink tracking-tight flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4 text-emerald-400" /> {j.service_type || j.title}</p>
              <span className="text-xs text-ink-muted">{formatDate(visitDay(j))}</span>
            </div>
            {/* started_at/completed_at were already in the payload and never rendered — so
                "we were there" was an assertion with no substance behind it. Showing the
                real window is the difference between a claim and a record. Only shown when
                both stamps exist and the span is sane (a forgotten 'start' would otherwise
                report an 11-hour visit). */}
            {(() => {
              const st = j.started_at ? new Date(j.started_at).getTime() : null
              const en = j.completed_at ? new Date(j.completed_at).getTime() : null
              if (!st || !en || en <= st) return null
              const mins = Math.round((en - st) / 60000)
              if (mins < 1 || mins > 600) return null
              const span = mins < 60 ? `${mins} min` : `${Number((mins / 60).toFixed(1))} hr`
              return (
                <p className="text-xs text-ink-muted mt-1 flex items-center gap-1.5">
                  <Clock className="w-3 h-3 text-ink-faint shrink-0" />
                  On site {new Date(j.started_at!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  {' – '}{new Date(j.completed_at!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  <span className="text-ink-faint">· {span}</span>
                </p>
              )
            })()}
            {/* A preview, not the whole set — the Photos tab is the full gallery (grouped
                by visit, before/after columns). This grid silently rendered the first 4 and
                dropped the rest: a visit with 10 photos showed 4 and gave no hint the other
                6 existed. The crew took them for the customer; hiding them makes the work
                look smaller than it was. The last tile carries the overflow and hands off
                to the real gallery rather than growing a second viewer here. */}
            {photos.length > 0 && (
              <div className="grid grid-cols-4 gap-1.5 mt-3">
                {photos.slice(0, 4).map((p, i) => {
                  const hidden = photos.length - 4
                  const isOverflow = i === 3 && hidden > 0
                  if (isOverflow) return (
                    <button key={p.id} type="button" onClick={onOpenPhotos}
                      aria-label={`View all ${photos.length} photos from this visit`}
                      className="relative aspect-square rounded-lg overflow-hidden border border-border bg-bg-tertiary group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={photoUrl(p.storage_path)} alt="" loading="lazy" className="w-full h-full object-cover" />
                      <span className="absolute inset-0 bg-black/60 group-hover:bg-black/50 transition-colors flex items-center justify-center text-sm font-semibold text-white tabular-nums">
                        +{hidden}
                      </span>
                    </button>
                  )
                  return (
                    <a key={p.id} href={photoUrl(p.storage_path)} target="_blank" rel="noopener noreferrer" className="aspect-square rounded-lg overflow-hidden border border-border bg-bg-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={photoUrl(p.storage_path)} alt="" loading="lazy" className="w-full h-full object-cover" />
                    </a>
                  )
                })}
              </div>
            )}
            {j.notes && <p className="text-xs text-ink-muted mt-2.5 whitespace-pre-wrap border-l-2 border-border pl-2">{j.notes}</p>}
            {inv && (
              <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-border text-xs">
                <span className="text-ink-muted flex items-center gap-1"><Receipt className="w-3.5 h-3.5" /> {inv.invoice_number}</span>
                <span className="flex items-center gap-2"><span className="font-semibold text-ink">{formatCurrency(invoiceTotals(inv.amount, { gst_percent: gstPct }, { type: inv.discount_type, value: inv.discount_value }).total)}</span><InvoiceStatusPill status={inv.status} /></span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Before & After gallery (grouped by job) ──
function GalleryTab({ photosByJob, jobs, photoUrl }: { photosByJob: Map<string, PortalPhoto[]>; jobs: PortalJob[]; photoUrl: (p: string) => string }) {
  const jobById = new Map(jobs.map(j => [j.id, j]))
  const groups = [...photosByJob.entries()].filter(([, ps]) => ps.length > 0)
    .sort((a, b) => (b[1][0]?.taken_at || '').localeCompare(a[1][0]?.taken_at || ''))
  if (groups.length === 0) return <Empty icon={ImageIcon} text="No photos yet — your before & after shots will appear here." />
  return (
    <div className="space-y-4">
      {groups.map(([jobId, ps]) => {
        const before = ps.filter(p => p.kind === 'before')
        const after = ps.filter(p => p.kind === 'after')
        const other = ps.filter(p => p.kind !== 'before' && p.kind !== 'after')
        const j = jobById.get(jobId)
        const hasBA = before.length > 0 && after.length > 0
        return (
          <div key={jobId} className="rounded-card border border-border bg-bg-secondary p-4">
            <p className="text-sm font-semibold text-ink tracking-tight">{j?.service_type || j?.title || 'Visit'}</p>
            {/* Dated by when the visit HAPPENED, like every other surface — photos taken
                on Thursday must not be filed under the Tuesday it was booked for. */}
            <p className="text-xs text-ink-faint mb-2.5">{j ? formatDate(visitDay(j)) : ''}</p>
            {hasBA ? (
              <div className="grid grid-cols-2 gap-2">
                <GalleryCol label="Before" photos={before} photoUrl={photoUrl} />
                <GalleryCol label="After" photos={after} photoUrl={photoUrl} />
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-1.5">
                {[...before, ...after, ...other].map(p => <Thumb key={p.id} p={p} photoUrl={photoUrl} />)}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
function GalleryCol({ label, photos, photoUrl }: { label: string; photos: PortalPhoto[]; photoUrl: (p: string) => string }) {
  return (
    <div>
      <p className={cn('text-[10px] font-bold uppercase tracking-wide mb-1', label === 'Before' ? 'text-amber-400' : 'text-emerald-400')}>{label}</p>
      <div className="space-y-1.5">{photos.map(p => <Thumb key={p.id} p={p} photoUrl={photoUrl} wide />)}</div>
    </div>
  )
}
function Thumb({ p, photoUrl, wide }: { p: PortalPhoto; photoUrl: (s: string) => string; wide?: boolean }) {
  return (
    <a href={photoUrl(p.storage_path)} target="_blank" rel="noopener noreferrer" className={cn('block rounded-lg overflow-hidden border border-border bg-bg-tertiary', wide ? 'aspect-video' : 'aspect-square')}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photoUrl(p.storage_path)} alt={p.caption || ''} loading="lazy" className="w-full h-full object-cover" />
    </a>
  )
}


// ── Documents (central home for all customer records) ──────────────────────
type DocKind = 'quote' | 'invoice'
// rawId/balance power the row's actions — Documents is THE records hub, so paying
// an invoice or accepting a quote happens right on the row (no separate tabs).
// `amountNote` qualifies the headline figure. It exists because this ONE list renders two
// different kinds of number in identical type: invoice amounts include GST, quote totals
// don't. The PDF says "Plus GST — added on your invoice"; the row a customer actually
// approves from said nothing, so the first bill looked like a bait-and-switch.
// `explain` answers "why does this cost this?" in the customer's own terms. It carries
// only facts about THEIR property and THEIR job — never the owner's rate, margin, floor
// or win-rate. (`rate` isn't in the portal projection, and deriving it from
// subtotal ÷ man_hours would expose the owner's hourly pricing to the person paying it.)
// `status` on a quote is the DISPLAY status (lib/quoteStatus), not the stored one — so
// an expired quote arrives here as 'expired' rather than 'sent'. That is what makes the
// Accept button disappear on its own: `canAccept` already tests for 'sent', so there is
// no second expiry check anywhere in the render path to forget or contradict.
// `expiredOn` is the date it lapsed, shown so the customer knows this isn't a glitch.
// `propertyId` is the row's OWN link, stored raw (unresolved) — the grouping memo is the
// single place that decides whether it names a property this payload actually carried.
// `address` is what that resolves to for a human: see resolveDocAddress.
interface DocItem { id: string; rawId: string; kind: DocKind; number: string; title: string; date: string; status: string; expiredOn?: string; validUntil?: string | null; dueDate?: string | null; amount: number; amountNote?: string; balance: number; filename: string; getBlob: () => Promise<Blob>; lines?: { label: string; amount: number }[]; explain?: string[]; propertyId?: string | null; address?: string | null }
const KIND_META: Record<DocKind, { label: string; icon: typeof FileText; tone: string }> = {
  quote: { label: 'Quote', icon: FileText, tone: 'text-accent-text border-accent/25 bg-accent/10' },
  invoice: { label: 'Invoice', icon: Receipt, tone: 'text-sky-400 border-sky-500/25 bg-sky-500/10' },
}
// The bucket for a document that doesn't name a property we know. A UUID can never
// collide with it, so it can share the group map's key space.
const NO_PROPERTY = 'no-property'

// THE address resolver for this tab — the one answer to "which address identifies this
// document", asked identically by quotes and invoices so the fallback chain exists once.
//
// The canonical properties.address WINS whenever property_id resolves. A quote/invoice
// carries its own `address` TEXT, copied at creation and never re-synced: most of those
// copies differ from the property they belong to only in formatting ("SW" vs
// "Southwest", a doubled ", AB"), but some name a different street outright. Grouping on
// a stale copy would split one property into two headings, and printing it under a
// heading claiming to name the property would be a quiet lie. So the copy is a FALLBACK,
// not a second opinion: it answers only when property_id is null (a legacy row) or
// points at a property this payload didn't carry.
function resolveDocAddress(propsById: Map<string, PortalProperty>, propertyId: string | null | undefined, ownAddress: string | null | undefined): string | null {
  const canonical = (propertyId ? propsById.get(propertyId) : null)?.address?.trim()
  if (canonical) return canonical
  return ownAddress?.trim() || null
}


function DocumentsTab({ quotes, invoices, customerName, fallbackAddress, properties, business, onInvoiceOpen, paymentsEnabled, pay, payingId, accept, accepting, initialCat }: {
  quotes: PortalQuote[]; invoices: PortalInvoice[]; customerName: string; fallbackAddress: string | null
  // The customer's properties — NOT a single measured area. This used to be
  // `lawnSqft: number | null`, lifted off the PRIMARY property and then applied to
  // every quote in the map below, which is how a $40 quote for a 407 sq ft lawn came
  // to claim it was "priced for your measured 10,369 sq ft". A per-row fact has to be
  // resolved per row, so the row's own property_id is the only thing that may answer.
  properties: PortalProperty[]; business: PortalData['business']
  onInvoiceOpen?: (invoiceId: string) => void
  paymentsEnabled: boolean; pay: (invoiceId: string) => void; payingId: string | null
  accept: (quoteId: string) => void; accepting: string | null
  initialCat?: 'all' | DocKind
}) {
  // Pre-filtered entry (the Home signpost lands on quotes, the balance path on
  // invoices) — the customer arrives looking at what they came for.
  const [cat, setCat] = useState<'all' | DocKind>(initialCat ?? 'all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest')

  const gstPct = Number(business?.gst_percent) || 0
  const today = localTodayISO()
  // THE property lookup for this tab. A row names its own property or it names none —
  // there is no "close enough" here, because the nearest wrong answer (the primary) is
  // exactly the bug being fixed.
  const propsById = useMemo(() => new Map(properties.map(p => [p.id, p])), [properties])
  const docs = useMemo<DocItem[]>(() => {
    const q: DocItem[] = quotes.map(qq => {
      // The property THIS quote is for. Null for a legacy quote with no property_id —
      // in which case every property-derived fact below stays silent.
      const qProp = qq.property_id ? propsById.get(qq.property_id) ?? null : null
      const qSqft = Number(qProp?.lawn_sqft) || 0
      // Multi-service quotes get a per-service breakdown on the row (same
      // serviceLineTotals math as the builder/PDF), so the customer sees what
      // makes up the total instead of a lump sum under one service name.
      const svc = (qq.services || []).slice().sort((a, b) => a.sort_order - b.sort_order)
      const svcLines = svc.length > 1
        ? [
            ...svc.map(s => ({
              label: Number(s.quantity) > 1 ? `${s.service_type} × ${Number(s.quantity)}` : s.service_type,
              amount: serviceLineTotals(s).net,
            })),
            ...(Number(qq.travel_fee) > 0 ? [{ label: 'Travel fee', amount: Number(qq.travel_fee) }] : []),
          ]
        : []
      // Ongoing plan pricing is material to the approval — show it on the row,
      // not only inside the PDF.
      const planLines = [
        Number(qq.weekly_price) > 0 ? { label: 'Weekly plan (per visit)', amount: Number(qq.weekly_price) } : null,
        Number(qq.biweekly_price) > 0 ? { label: 'Bi-weekly plan (per visit)', amount: Number(qq.biweekly_price) } : null,
        // "(per visit)" is NOT optional here. Its two siblings carry it, so dropping it read
        // as deliberate — "Monthly plan · $260" says $260/month, all in. The PDF calls the
        // same number "Monthly visit · per visit". At 4 visits/month that's a 4x misread the
        // customer only discovers on their first bill.
        Number(qq.monthly_price) > 0 ? { label: 'Monthly plan (per visit)', amount: Number(qq.monthly_price) } : null,
      ].filter((l): l is { label: string; amount: number } => l !== null)
      const allLines = [...svcLines, ...planLines]
      const lines = allLines.length > 0 ? allLines : undefined
      // "Why does it cost this?" — answered from what we measured about THIS property and
      // THIS job. The line-item breakdown above only renders for multi-service quotes,
      // which in practice is almost none of them, so for a typical quote the customer was
      // handed a single number and no reasoning at all. Every fact here is about them:
      // their lawn, their visit, their crew. Nothing here exposes the owner's rate.
      const manHours = Number(qq.hours) > 0 && Number(qq.crew_size) > 0 ? Number(qq.hours) * Number(qq.crew_size) : 0
      const fmtHrs = (h: number) => h < 1 ? `${Math.round(h * 60)} minutes` : h === 1 ? '1 hour' : `${Number(h.toFixed(1))} hours`
      const explainBits = [
        // The measured area, not "your lawn" — the same number explains a
        // driveway to a pressure washer's customer or a deck to a stainer's.
        //
        // It is THIS quote's property's area, resolved through this quote's own
        // property_id. It used to be the primary property's area applied to every
        // quote, which under the heading "What's behind this price" vouched for a
        // number that wasn't the customer's — a $40 quote for 407 sq ft told them it
        // was priced for 10,369. When the property is unknown (a legacy quote) the
        // claim is DROPPED, not defaulted: we can be silent about the area, but we
        // cannot be wrong about it while claiming to explain their price.
        qSqft > 0 ? `Priced for your measured ${qSqft.toLocaleString()} sq ft — measured, not guessed.` : null,
        manHours > 0
          ? `About ${fmtHrs(manHours)} of work${Number(qq.crew_size) > 1 ? `, with a crew of ${Number(qq.crew_size)}` : ''}.`
          : null,
        Number(qq.travel_fee) > 0 ? `Includes a ${formatCurrency(Number(qq.travel_fee))} travel charge to reach your property.` : null,
        planLines.length > 0 ? 'Your first visit is priced above; ongoing visits are charged at the plan rate shown.' : null,
        'Nothing is charged when you approve — you’ll get an invoice once the work is done.',
      ].filter((s): s is string => !!s)
      // THE shared expiry engine — the same call the owner's quote page and quote list
      // make. A lapsed quote surfaces as 'expired' here, which is what removes the Accept
      // button (canAccept tests for 'sent') and swaps the pill, with no separate check.
      // PortalQuote.status is `string` on purpose — it's RPC JSON, so the portal doesn't
      // presume the union. displayQuoteStatus only branches on 'sent', and any other
      // value falls through unchanged, so narrowing here is safe rather than a guess.
      const display = displayQuoteStatus({ status: qq.status as QuoteStatus, valid_until: qq.valid_until }, today)
      const expired = display === 'expired'
      return {
        id: 'q' + qq.id, rawId: qq.id, kind: 'quote' as const, number: qq.quote_number, title: qq.service_type || 'Quote',
        date: qq.issued_date || qq.created_at, status: display, expiredOn: expired ? qq.valid_until || undefined : undefined,
        validUntil: qq.valid_until,
        amount: Number(qq.total) || 0,
        amountNote: gstPct > 0 ? `+ GST (${gstPct}%) — added on your invoice` : undefined, balance: 0,
        filename: `${qq.quote_number}.pdf`, getBlob: () => renderPortalQuoteBlob(qq, customerName, business), lines,
        // Identity, not decoration: the address is what tells a landlord which of their
        // six quotes this is. It never becomes the row's `title` — `service_type` is a
        // real disambiguator, and 5 of the 7 multi-quote customers have every quote on
        // ONE property, where the address would say nothing and the service/date/status
        // say everything.
        propertyId: qq.property_id ?? null, address: resolveDocAddress(propsById, qq.property_id, qq.address),
        // Don't justify a price that no longer stands — explaining it would invite the
        // customer to act on a number we're about to tell them we can't honour.
        explain: !expired && explainBits.length > 1 ? explainBits : undefined,
      }
    })
    // A DRAFT invoice is the owner's unfinished work — a number they're still deciding on.
    // get_portal_data filters draft QUOTES (`status <> 'draft'`) but its invoices
    // projection has no status filter, and two other places compensate client-side (the
    // outstanding balance, and the pay gate) — this list was simply missed, so a customer
    // could sit looking at a bill that hadn't been issued and couldn't be paid. Quotes set
    // the precedent: drafts are private until sent.
    const inv: DocItem[] = invoices.filter(ii => ii.status !== 'draft').map(ii => {
      // Same balance math as the dashboard: discounted+GST total − payments recorded.
      const total = invoiceTotals(ii.amount, { gst_percent: gstPct }, { type: ii.discount_type, value: ii.discount_value }).total
      const balance = Math.max(0, Math.round((total - (Number(ii.amount_paid) || 0)) * 100) / 100)
      // 'overdue' is a DISPLAY overlay derived from due_date — never stored — exactly the
      // shape the ledger uses for invoices and quoteStatus uses for expiry. Until now
      // due_date sat in the payload and was rendered NOWHERE: an invoice three weeks late
      // looked identical to one issued this morning, both wearing the same amber "Due".
      // So the portal knew the customer was late and didn't tell them — they'd find out
      // from a chasing text instead, which is the worst possible order to learn it in.
      const overdue = balance > 0 && !!ii.due_date && ii.due_date < today && ii.status !== 'cancelled'
      return {
        id: 'i' + ii.id, rawId: ii.id, kind: 'invoice' as const, number: ii.invoice_number, title: ii.service_type || 'Invoice',
        date: ii.issued_date || ii.created_at, status: overdue ? 'overdue' : ii.status, dueDate: ii.due_date, amount: total, balance,
        // A partial payment is the customer's own money already on this bill — not showing
        // it made the row look like they'd paid nothing.
        amountNote: Number(ii.amount_paid) > 0 && balance > 0 ? `${formatCurrency(Number(ii.amount_paid))} already paid` : undefined,
        filename: `${ii.invoice_number}.pdf`, getBlob: () => { onInvoiceOpen?.(ii.id); return renderPortalInvoiceBlob(ii, customerName, fallbackAddress, business) },
        // Same resolver as the quote above. An invoice that spans several properties
        // answers null on purpose (see PortalInvoice) — it lands in the neutral bucket
        // rather than being filed under whichever address happened to be copied onto it.
        propertyId: ii.property_id ?? null, address: resolveDocAddress(propsById, ii.property_id, ii.address),
      }
    })
    return [...q, ...inv]
    // propsById is a dep: the payload arrives from a server prefetch AND a client
    // revalidation, so a customer's properties can land after first paint. Omitting it
    // would leave the rows explaining the price with whatever was known then.
  }, [quotes, invoices, customerName, fallbackAddress, business, onInvoiceOpen, gstPct, propsById])

  const counts = { all: docs.length, quote: docs.filter(d => d.kind === 'quote').length, invoice: docs.filter(d => d.kind === 'invoice').length }

  const filtered = useMemo(() => {
    const ql = query.trim().toLowerCase()
    let list = cat === 'all' ? docs : docs.filter(d => d.kind === cat)
    if (ql) list = list.filter(d =>
      d.number.toLowerCase().includes(ql) || d.title.toLowerCase().includes(ql) ||
      d.status.toLowerCase().includes(ql) || KIND_META[d.kind].label.toLowerCase().includes(ql) ||
      // A landlord searches the way they think: "Elm St", not "Q-1043". The RESOLVED
      // address, so what they type matches what the heading shows them.
      (d.address || '').toLowerCase().includes(ql))
    return [...list].sort((a, b) => sort === 'newest' ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date))
  }, [docs, cat, query, sort])

  // Address as an anchor only earns its space when there's a choice to make. One property
  // (40 of 47 customers) means every heading would repeat the address they gave us —
  // so they keep today's flat list, unchanged. Two or more, and the list groups.
  const grouped = properties.length > 1
  // Built FROM `filtered`, so cat/query/sort are applied once and grouping composes with
  // them instead of forking them. Group order follows `properties` (primary first — the
  // RPC's own ordering), with the unknown bucket trailing; a group with nothing left in
  // it after filtering doesn't render a heading over empty space.
  const groups = useMemo(() => {
    if (!grouped) return null
    const byKey = new Map<string, DocItem[]>()
    for (const d of filtered) {
      const key = d.propertyId && propsById.has(d.propertyId) ? d.propertyId : NO_PROPERTY
      const bucket = byKey.get(key)
      if (bucket) bucket.push(d); else byKey.set(key, [d])
    }
    const out = properties.filter(p => byKey.has(p.id)).map(p => ({
      key: p.id, label: p.address?.trim() || 'Property', isPrimary: !!p.is_primary, items: byKey.get(p.id)!,
    }))
    const rest = byKey.get(NO_PROPERTY)
    // Neutral and LAST: these documents are unfiled, not misfiled. Naming them after an
    // address we couldn't confirm is the one thing this whole change exists to stop.
    if (rest) out.push({ key: NO_PROPERTY, label: 'Other documents', isPrimary: false, items: rest })
    return out
  }, [grouped, filtered, properties, propsById])

  const CATS: { key: 'all' | DocKind; label: string; n: number }[] = [
    { key: 'all', label: 'All', n: counts.all },
    { key: 'quote', label: 'Quotes', n: counts.quote },
    { key: 'invoice', label: 'Invoices', n: counts.invoice },
  ]

  return (
    <div className="space-y-3">
      {/* Count + category filters */}
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink">{docs.length} document{docs.length === 1 ? '' : 's'}</p>
        <p className="text-xs text-ink-faint">Showing {filtered.length}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {CATS.map(c => (
          <button key={c.key} onClick={() => setCat(c.key)} type="button"
            className={cn('text-xs font-medium rounded-full px-3 py-1.5 border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
              cat === c.key ? 'bg-accent text-black border-accent' : 'border-border text-ink-muted hover:text-ink')}>
            {c.label}{c.n > 0 && <span className="opacity-70 tabular-nums"> {c.n}</span>}
          </button>
        ))}
      </div>

      {/* Search + sort */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search documents…" aria-label="Search documents"
            className="w-full h-10 pl-9 pr-3 rounded-xl bg-bg-tertiary border border-border-strong text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
        </div>
        <Button variant="secondary" size="sm" className="shrink-0" onClick={() => setSort(s => s === 'newest' ? 'oldest' : 'newest')}>
          <ArrowUpDown className="w-4 h-4 text-ink-muted" /> {sort === 'newest' ? 'Newest' : 'Oldest'}
        </Button>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <Empty icon={docs.length === 0 ? FolderOpen : Search} text={docs.length === 0 ? 'No documents yet — your quotes and invoices will appear here.' : 'No documents match your search.'} />
      ) : groups ? (
        <div className="space-y-5">
          {groups.map(g => (
            <div key={g.key} className="space-y-3">
              {/* The heading carries the address; the rows keep saying what they always
                  said. Service + date + status stay the disambiguators, because a
                  customer can hold two quotes on one property that differ by nothing
                  else — address alone would render them as identical twins. */}
              <div className="flex items-center gap-1.5 px-0.5">
                <MapPin className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                <p className="text-xs font-semibold text-ink tracking-tight truncate">{g.label}</p>
                {g.isPrimary && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border border-border text-ink-faint shrink-0">
                    Primary
                  </span>
                )}
                <span className="text-xs text-ink-faint tabular-nums ml-auto shrink-0">{g.items.length}</span>
              </div>
              {g.items.map(d => <DocRow key={d.id} d={d} paymentsEnabled={paymentsEnabled} pay={pay} payingId={payingId} accept={accept} accepting={accepting} />)}
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3">{filtered.map(d => <DocRow key={d.id} d={d} paymentsEnabled={paymentsEnabled} pay={pay} payingId={payingId} accept={accept} accepting={accepting} />)}</div>
      )}
    </div>
  )
}
function DocRow({ d, paymentsEnabled, pay, payingId, accept, accepting }: {
  d: DocItem
  paymentsEnabled: boolean; pay: (invoiceId: string) => void; payingId: string | null
  accept: (quoteId: string) => void; accepting: string | null
}) {
  const m = KIND_META[d.kind]
  // The one action each document actually needs, right on the row: a sent quote
  // can be accepted; an invoice with a balance can be paid.
  // `d.status` is the DISPLAY status, so an expired quote is not 'sent' and loses its
  // Accept button here without a second expiry test.
  const canAccept = d.kind === 'quote' && d.status === 'sent'
  const isExpired = d.kind === 'quote' && d.status === 'expired'
  const canPay = d.kind === 'invoice' && paymentsEnabled && d.balance > 0 && d.status !== 'draft' && d.status !== 'cancelled'
  // Quotes hold their price for 30 days from issue — show that window so approval feels timely.
  const validUntil = new Date(new Date(d.date).getTime() + 30 * 86400000).toISOString().slice(0, 10)
  return (
    <div className="rounded-card border border-border bg-bg-secondary p-4 card-lift">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-3 min-w-0">
          <div className={cn('w-9 h-9 rounded-lg border flex items-center justify-center shrink-0', m.tone)}><m.icon className="w-4 h-4" /></div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink truncate tracking-tight">{d.title}</p>
            <p className="text-xs text-ink-muted">{m.label} · {d.number} · {formatDate(d.date)}</p>
            {/* When it's due — the row showed only the ISSUE date, so "am I late?" was
                unanswerable from the one screen built to answer it. */}
            {d.kind === 'invoice' && d.dueDate && d.balance > 0 && (
              <p className={cn('text-xs mt-0.5', d.status === 'overdue' ? 'text-red-400 font-medium' : 'text-ink-muted')}>
                {d.status === 'overdue' ? `Was due ${formatDate(d.dueDate)}` : `Due ${formatDate(d.dueDate)}`}
              </p>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-bold text-ink tabular-nums">{formatCurrency(d.amount)}</p>
          {d.amountNote && <p className="text-[11px] text-ink-faint mt-0.5">{d.amountNote}</p>}
          {/* How long the price stands, said while it still does — the row already
              explains a LAPSED price; the live one deserves its date too. Only on
              quotes that carry one (expiry stamping began 2026-07; older quotes
              never lapse and get no line). */}
          {canAccept && d.validUntil && <p className="text-[11px] text-ink-faint mt-0.5">Valid until {formatDate(d.validUntil)}</p>}
          {d.kind === 'quote' ? <QuoteStatusPill status={d.status} /> : <InvoiceStatusPill status={d.status} />}
        </div>
      </div>
      {d.lines && d.lines.length > 0 && (
        <div className="mt-3 pt-2.5 border-t border-border/60 space-y-1">
          {d.lines.map((l, i) => (
            <div key={i} className="flex items-center justify-between gap-3 text-xs">
              <span className="text-ink-muted truncate">{l.label}</span>
              <span className="text-ink shrink-0 tabular-nums">{formatCurrency(l.amount)}</span>
            </div>
          ))}
        </div>
      )}
      {/* What's behind the number. Shown on the quote the customer is deciding on — a
          price with no reasoning is the thing people call to argue about. */}
      {d.explain && d.explain.length > 0 && canAccept && (
        <div className="mt-3 pt-3 border-t border-border/60">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint mb-1.5">What&rsquo;s behind this price</p>
          <ul className="space-y-1">
            {d.explain.map((line, i) => (
              <li key={i} className="text-xs text-ink-muted flex items-start gap-1.5">
                <Check className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" /> {line}
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* An expired quote takes the Accept button's place — the customer is told plainly
          that the price no longer stands, rather than being left to tap a button that
          would commit them to a number we can't honour. No extension is offered here:
          whether to stand by an old price is the owner's call, made on their side. */}
      {isExpired && (
        <div className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-3 flex items-start gap-2">
          <Clock className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-ink-muted">
            <span className="text-ink font-medium">This quote has expired.</span> Please contact us for an updated quote.
            {d.expiredOn ? <span className="text-ink-faint"> It was valid until {formatDate(d.expiredOn)}.</span> : null}
          </p>
        </div>
      )}
      {(canAccept || canPay) && (
        <div className="mt-3">
          {canAccept && (
            <>
              <Button className="w-full sm:w-auto" onClick={() => accept(d.rawId)} loading={accepting === d.rawId}><Check className="w-4 h-4" /> Approve — {formatCurrency(d.amount)}</Button>
              <p className="text-[11px] text-ink-faint mt-1.5">You&rsquo;ll confirm on the next step — we&rsquo;ll then reach out to schedule.</p>
            </>
          )}
          {canPay && (
            <>
              <Button className="w-full sm:w-auto" onClick={() => pay(d.rawId)} loading={payingId === d.rawId}><CreditCard className="w-4 h-4" /> Pay {formatCurrency(d.balance)}</Button>
              <p className="text-[11px] text-ink-faint mt-1.5 flex items-center gap-1"><ShieldCheck className="w-3 h-3 text-emerald-400 shrink-0" /> Secure checkout by Stripe — you&rsquo;ll confirm on the next screen.</p>
            </>
          )}
        </div>
      )}
      <DocActions filename={d.filename} getBlob={d.getBlob} />
    </div>
  )
}

// ── Timeline (one unified activity feed: quotes, visits, invoices, payments, photos) ──
interface TLEvent { id: string; at: string; icon: typeof Home; tone: string; title: string; sub: string | null }
function TimelineTab({ data, photosByJob }: { data: PortalData; photosByJob: Map<string, PortalPhoto[]> }) {
  const events = useMemo<TLEvent[]>(() => {
    const ev: TLEvent[] = []
    // This event is stamped at the date the quote was SENT, so that's what its title has
    // to say. "Quote Q-123 accepted" dated the day it went out is a small lie the eye
    // doesn't catch — the customer approved it days later. The outcome belongs in the
    // subtitle, where it reads as current state rather than as something that happened
    // at this point on the line. Tone follows the same rule: amber means "this still
    // wants you", so a declined or lapsed quote must not wear it.
    const todayISO = localTodayISO()
    for (const q of data.quotes) {
      const st = displayQuoteStatus({ status: q.status as QuoteStatus, valid_until: q.valid_until }, todayISO)
      const outcome = st === 'accepted' ? 'Approved'
        : st === 'declined' ? 'Declined'
        : st === 'expired' ? 'Expired'
        : st === 'sent' ? 'Awaiting your approval'
        : null
      ev.push({
        id: 'q' + q.id, at: q.issued_date || q.created_at, icon: FileText,
        tone: st === 'accepted' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
          : st === 'sent' ? 'text-amber-400 border-amber-500/30 bg-amber-500/10'
          : 'text-ink-muted border-border bg-bg-tertiary',
        title: `Quote ${q.quote_number} sent`,
        sub: [q.service_type || null, outcome].filter(Boolean).join(' · ') || null,
      })
    }
    for (const j of data.jobs) {
      if (j.completed_at || j.status === 'completed') ev.push({ id: 'jc' + j.id, at: j.completed_at || j.scheduled_date, icon: CheckCircle2, tone: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10', title: `${j.service_type || j.title} completed`, sub: null })
      else ev.push({ id: 'js' + j.id, at: j.scheduled_date, icon: CalendarClock, tone: 'text-sky-400 border-sky-500/30 bg-sky-500/10', title: `${j.service_type || j.title} scheduled`, sub: null })
    }
    // Draft invoices are the owner's unfinished work and are filtered out of the customer's
    // Documents list — they must not leak onto the timeline either.
    for (const i of data.invoices.filter(i => i.status !== 'draft')) {
      const total = invoiceTotals(i.amount, { gst_percent: Number(data.business?.gst_percent) || 0 }, { type: i.discount_type, value: i.discount_value }).total
      const settled = i.status === 'paid' || i.status === 'overpaid'
      ev.push({
        id: 'i' + i.id, at: i.issued_date || i.created_at, icon: Receipt,
        tone: 'text-ink-muted border-border bg-bg-tertiary',
        title: `Invoice ${i.invoice_number} issued`,
        // The amount alone left the customer to cross-reference whether they'd paid it.
        sub: `${formatCurrency(total)}${settled ? ' · Paid' : i.status === 'cancelled' ? ' · Cancelled' : ' · Due'}`,
      })
    }
    // The PaymentsTab keeps credits out of the receipt list and renders negatives as
    // "Refund" — the timeline did neither, so a $200 refund read as a green "Payment
    // received · -$200.00" and an account credit read as money we'd taken. No refunds
    // exist yet; this is the day-one behaviour when one does.
    for (const p of data.payments) {
      if (p.kind === 'credit') continue
      const refund = Number(p.amount) < 0
      ev.push({
        id: 'p' + p.id, at: p.paid_at || p.created_at, icon: CreditCard,
        tone: refund ? 'text-red-400 border-red-500/30 bg-red-500/10' : 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
        title: refund ? 'Refund issued' : `Payment received · ${paymentMethodLabel(p.provider)}`,
        sub: formatCurrency(Math.abs(Number(p.amount))),
      })
    }
    for (const [jid, ps] of photosByJob) { if (jid !== 'none' && ps.length) ev.push({ id: 'ph' + jid, at: ps[0]?.taken_at || '', icon: ImageIcon, tone: 'text-violet-400 border-violet-500/30 bg-violet-500/10', title: `${ps.length} photo${ps.length === 1 ? '' : 's'} added`, sub: null }) }
    return ev.filter(e => e.at).sort((a, b) => b.at.localeCompare(a.at))
  }, [data, photosByJob])

  if (events.length === 0) return <Empty icon={Activity} text="No activity yet — your quotes, visits, and payments will appear here." />
  return (
    <div className="relative pl-7">
      <div className="absolute left-[11px] top-1.5 bottom-1.5 w-px bg-border" />
      <div className="space-y-2.5">
        {events.map(e => (
          <div key={e.id} className="relative">
            <div className={cn('absolute -left-7 top-1 w-[22px] h-[22px] rounded-full border flex items-center justify-center', e.tone)}><e.icon className="w-3 h-3" /></div>
            <div className="rounded-card border border-border bg-bg-secondary px-3.5 py-2.5">
              <p className="text-sm font-medium text-ink">{e.title}</p>
              <p className="text-[11px] text-ink-faint mt-0.5">{e.sub ? <span className="text-ink-muted">{e.sub} · </span> : null}{formatDate(e.at)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Property details ──
function PropertyTab({ property }: { property: PortalData['property'] }) {
  if (!property || (!property.address && !property.lawn_sqft && !property.fence_length && !property.neighborhood)) {
    return <Empty icon={MapPin} text="No property details on file yet — we'll add them after your first visit or measurement." />
  }
  return (
    <div className="space-y-3">
      <div className="rounded-card border border-border bg-bg-secondary p-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint mb-2">Your property</p>
        {property.address && (
          <p className="text-sm text-ink flex items-start gap-1.5"><MapPin className="w-4 h-4 text-ink-faint shrink-0 mt-0.5" /> <span>{property.address}{property.city ? `, ${property.city}` : ''}{property.province ? `, ${property.province}` : ''}</span></p>
        )}
        <div className="grid grid-cols-2 gap-3 mt-3">
          {property.lawn_sqft ? <StatCard label="Measured area" value={`${Number(property.lawn_sqft).toLocaleString()} sq ft`} icon={Ruler} /> : null}
          {property.fence_length ? <StatCard label="Fence length" value={`${Number(property.fence_length).toLocaleString()} ft`} icon={Ruler} /> : null}
          {property.neighborhood ? <StatCard label="Neighborhood" value={property.neighborhood} icon={MapPin} /> : null}
        </div>
      </div>
      {property.notes && (
        <div className="rounded-card border border-border bg-bg-secondary p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint mb-1.5">Notes from your provider</p>
          <p className="text-sm text-ink-muted whitespace-pre-wrap">{property.notes}</p>
        </div>
      )}
    </div>
  )
}

// ── Payment history ──
function paymentMethodLabel(provider: string): string {
  switch (provider) {
    case 'stripe': return 'Card'
    case 'etransfer': return 'E-transfer'
    case 'cash': return 'Cash'
    default: return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'Payment'
  }
}
function PaymentsTab({ payments, invoices, outstanding, token, paymentsEnabled, card, autopayEnabled, onChanged, customerName, fallbackAddress, business }: {
  payments: PortalPayment[]; invoices: PortalInvoice[]; outstanding: number
  token: string; paymentsEnabled: boolean; card: PortalCard | null; autopayEnabled: boolean; onChanged: () => void
  customerName: string; fallbackAddress: string | null; business: PortalData['business']
}) {
  // Receipt download — re-rendered from the ledger row on demand, so every receipt
  // stays PERMANENTLY available (nothing stored, nothing to lose).
  const [receiptBusy, setReceiptBusy] = useState<string | null>(null)
  const [receiptErr, setReceiptErr] = useState<string | null>(null)
  async function downloadReceipt(p: PortalPayment, inv: PortalInvoice) {
    setReceiptBusy(p.id); setReceiptErr(null)
    try {
      downloadBlob(await renderPortalReceiptBlob(p, inv, customerName, fallbackAddress, business), `${receiptNumberFor(p.id)}.pdf`)
    } catch {
      // "The button stays available to retry" was the old rationale — but from the outside
      // this was: tap, spinner, spinner stops, nothing. No file, no message, no reason to
      // think a second tap would differ. This is the one action someone takes to PROVE
      // they paid; it must never end in silence. DocActions already handles the identical
      // failure this way.
      setReceiptErr(p.id)
    }
    setReceiptBusy(null)
  }
  const invById = new Map(invoices.map(i => [i.id, i]))
  // Receipts (money movements) vs the customer-credit ledger — kept apart so totals
  // and history stay honest.
  const receipts = payments.filter(p => p.kind !== 'credit')
  // Refunds are negative rows in the ledger. Netting them into "Total paid" makes the
  // headline contradict the list directly beneath it — pay $500, get refunded $500, and
  // the tile reads "Total paid $0.00" above a row showing the $500 you paid. Show what
  // was paid, and name the refund separately.
  const totalPaid = receipts.filter(p => Number(p.amount) > 0).reduce((s, p) => s + Number(p.amount), 0)
  const refunded = Math.abs(receipts.filter(p => Number(p.amount) < 0).reduce((s, p) => s + Number(p.amount), 0))
  const availableCredit = Math.round(payments.filter(p => p.kind === 'credit').reduce((s, p) => s + Number(p.amount || 0), 0) * 100) / 100

  // ── Ways to pay ── copy-to-clipboard for the e-transfer details. The recipient
  // is ONLY the business-configured Interac email (Settings → Payments & Fees) —
  // never a generic contact email, which may not be bank-registered for e-transfers.
  const [copied, setCopied] = useState<string | null>(null)
  async function copyText(key: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(null), 2000) } catch { /* clipboard blocked — button just no-ops */ }
  }
  const etransferEmail = (business?.etransfer_email || '').trim()
  // Which invoice(s) an e-transfer should reference — exact number when there's
  // one owing invoice, generic guidance when several.
  const owingNums = invoices.filter(i => i.status === 'unpaid' || i.status === 'sent' || i.status === 'partial').map(i => i.invoice_number)
  return (
    <div className="space-y-3">
      {/* ── Ways to pay — Card / E-transfer / Cash (cheque retired). E-transfer
          details come from Business Settings (one source of truth). ── */}
      <div className="rounded-card border border-border bg-bg-secondary p-4 space-y-3">
        <p className="text-[10px] uppercase tracking-[0.14em] text-ink-faint font-semibold">Ways to pay</p>
        <div className="flex items-start gap-3">
          <span aria-hidden><CreditCard className="w-4 h-4" /></span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">Card</p>
            <p className="text-xs text-ink-muted">{paymentsEnabled ? 'Pay any invoice securely online with the Pay button.' : 'Ask us for a secure card payment link.'}</p>
            {paymentsEnabled && <p className="text-[11px] text-ink-faint mt-1 flex items-center gap-1"><ShieldCheck className="w-3 h-3 text-emerald-400 shrink-0" /> Secure checkout by Stripe — your card details never touch us.</p>}
          </div>
        </div>
        {/* Only advertise e-transfer once the business has set its address —
            never show a customer owner-facing setup instructions. */}
        {etransferEmail && (
        <div className="flex items-start gap-3 border-t border-border pt-3">
          <span aria-hidden><Landmark className="w-4 h-4" /></span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink">E-transfer</p>
            <p className="text-xs text-ink-muted">Recipient: <span className="font-medium text-ink">{business?.company_name || 'Your service provider'}</span></p>
            <p className="text-xs text-ink-muted mt-1">Send payment to:</p>
            <p className="text-sm font-semibold text-accent-text break-all">{etransferEmail}</p>
            {owingNums.length === 1 && (
              <p className="text-xs text-ink-muted mt-1">Please include invoice number <span className="font-semibold text-ink">{owingNums[0]}</span> in the e-transfer message.</p>
            )}
            {owingNums.length > 1 && (
              <p className="text-xs text-ink-muted mt-1">Please include your invoice number (e.g. <span className="font-semibold text-ink">{owingNums[0]}</span>) in the e-transfer message.</p>
            )}
            <div className="flex flex-wrap gap-2 mt-2">
              <Button size="sm" variant="secondary" onClick={() => copyText('email', etransferEmail)}>
                {copied === 'email' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {copied === 'email' ? 'Copied' : 'Copy email'}
              </Button>
              {outstanding > 0 && (
                <Button size="sm" variant="secondary" onClick={() => copyText('amount', outstanding.toFixed(2))}>
                  {copied === 'amount' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {copied === 'amount' ? 'Copied' : `Copy amount (${formatCurrency(outstanding)})`}
                </Button>
              )}
            </div>
            {/* Sending money to a copy-pasted address is the loneliest moment in this
                product. The old line described OUR balance updating; it never told the
                customer they'd hear anything, or what to do if they didn't. Give them the
                evidence trail and a deadline at which it's right to chase us. */}
            <p className="text-[11px] text-ink-faint mt-2">
              E-transfers usually arrive within a few hours. Once we accept it, your payment appears in your history below with a receipt you can download.
              If you don&rsquo;t see it within one business day, give us a call and we&rsquo;ll track it down.
            </p>
          </div>
        </div>
        )}
        <div className="flex items-start gap-3 border-t border-border pt-3">
          <span aria-hidden><Banknote className="w-4 h-4" /></span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">Cash</p>
            {/* "send your receipt" promised an automatic send; for cash/e-transfer the
                receipt is a button the owner may never press. Point at what IS guaranteed:
                the payment history, which is written the moment the payment is recorded. */}
            <p className="text-xs text-ink-muted">Pay your crew in person at your next visit. We&rsquo;ll record it, and your payment and receipt will appear in your history below.</p>
          </div>
        </div>
      </div>
      {paymentsEnabled && <AutoPayCard token={token} card={card} autopayEnabled={autopayEnabled} onChanged={onChanged} />}
      {availableCredit > 0 && (
        <div className="rounded-card border border-accent/25 bg-accent/[0.06] p-3.5 flex items-center justify-between gap-3">
          <p className="text-[10px] uppercase tracking-[0.14em] text-accent-text font-semibold flex items-center gap-1"><Wallet className="w-3 h-3" /> Available credit</p>
          <p className="text-lg font-bold text-accent-text tabular-nums">{formatCurrency(availableCredit)}</p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-card border border-emerald-500/20 bg-emerald-500/[0.06] p-3.5">
          <p className="text-[10px] uppercase tracking-[0.14em] text-emerald-400 font-semibold flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Total paid</p>
          <p className="text-lg font-bold text-ink mt-1 tabular-nums">{formatCurrency(totalPaid)}</p>
          {refunded > 0 && <p className="text-[11px] text-ink-faint mt-0.5 tabular-nums">{formatCurrency(refunded)} refunded</p>}
        </div>
        <div className="rounded-card border border-border bg-bg-secondary p-3.5">
          {/* Same figure as the Home tile, so it must carry the same name — one number
              with two labels ("Outstanding" here, "Amount due" there) reads as two
              different numbers. "Outstanding" is also collections vocabulary. */}
          <p className="text-[10px] uppercase tracking-[0.14em] text-ink-faint font-semibold flex items-center gap-1"><Receipt className="w-3 h-3" /> Amount due</p>
          <p className={cn('text-lg font-bold mt-1 tabular-nums', outstanding > 0 ? 'text-amber-400' : 'text-emerald-400')}>{formatCurrency(outstanding)}</p>
        </div>
      </div>

      {/* The receipts below were an unheaded list hanging off the totals — name it, so
          it reads as a record you can rely on rather than a loose pile of rows. */}
      {receipts.length > 0 && (
        <p className="text-[10px] uppercase tracking-[0.14em] text-ink-faint font-semibold pt-1">
          Payment history{receipts.length > 1 ? ` · ${receipts.length} payments` : ''}
        </p>
      )}
      {receipts.length === 0 ? (
        <Empty icon={Receipt} text="No payments yet — once you pay an invoice, your receipts will live here." />
      ) : receipts.map(p => {
        const inv = p.invoice_id ? invById.get(p.invoice_id) : null
        return (
          <div key={p.id} className="rounded-card border border-border bg-bg-secondary p-4 flex flex-col sm:flex-row sm:items-center gap-3">
            {/* Details + status — the badge stays with the details on every width. */}
            <div className="flex items-center justify-between gap-3 min-w-0 flex-1">
              <div className="flex items-center gap-3 min-w-0">
                <div className={cn('w-9 h-9 rounded-lg border flex items-center justify-center shrink-0', Number(p.amount) < 0 ? 'border-red-500/25 bg-red-500/10' : 'border-emerald-500/25 bg-emerald-500/10')}><CheckCircle2 className={cn('w-4 h-4', Number(p.amount) < 0 ? 'text-red-400' : 'text-emerald-400')} /></div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink tabular-nums">{Number(p.amount) < 0 ? '−' : ''}{formatCurrency(Math.abs(Number(p.amount)))}</p>
                  <p className="text-xs text-ink-muted truncate">{p.paid_at ? formatDate(p.paid_at) : formatDate(p.created_at)}{inv ? ` · ${inv.invoice_number}` : ''} · {Number(p.amount) < 0 ? 'Refund' : paymentMethodLabel(p.provider)}</p>
                </div>
              </div>
              <span className={cn('shrink-0 text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border', Number(p.amount) < 0 ? 'text-red-400 border-red-500/30 bg-red-500/10' : 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10')}>{Number(p.amount) < 0 ? 'Refunded' : 'Paid'}</span>
            </div>
            {/* Receipt download — a quiet utility action (the paid status is the
                story), full-width on mobile, right-aligned on desktop. */}
            {inv && (
              <div className="w-full sm:w-auto shrink-0">
                <Button size="sm" variant="secondary" className="w-full sm:w-auto"
                  onClick={() => downloadReceipt(p, inv)} loading={receiptBusy === p.id}>
                  <Download className="w-4 h-4" /> Download {Number(p.amount) < 0 ? 'refund ' : ''}receipt
                </Button>
                {receiptErr === p.id && <p className="text-xs text-red-400 mt-1 sm:text-right">Couldn&rsquo;t build the receipt — please try again.</p>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Card on file + AutoPay (customer self-serve) ──
function AutoPayCard({ token, card, autopayEnabled, onChanged }: {
  token: string; card: PortalCard | null; autopayEnabled: boolean; onChanged: () => void
}) {
  const [autopay, setAutopay] = useState(autopayEnabled)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { setAutopay(autopayEnabled) }, [autopayEnabled])

  async function addCard() {
    setBusy('card'); setErr(null)
    try {
      const res = await fetch('/api/portal/setup-card', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
      const d = await res.json().catch(() => ({}))
      if (res.ok && d.url) { window.location.href = d.url; return }   // hosted Stripe setup
      setErr('Could not start card setup. Please try again.')
    } catch { setErr('Could not start card setup. Please try again.') }
    setBusy(null)
  }
  async function removeCard() {
    const ok = await confirmDialog({ title: 'Remove your saved card?', message: 'AutoPay will be turned off. You can add a card again anytime.', confirmLabel: 'Remove card', destructive: true })
    if (!ok) return
    setBusy('remove'); setErr(null)
    try {
      const res = await fetch('/api/portal/remove-card', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
      if (res.ok) { setAutopay(false); onChanged() } else setErr('Could not remove the card.')
    } finally { setBusy(null) }
  }
  async function toggle() {
    if (!card && !autopay) { setErr('Add a card first to use AutoPay.'); return }
    const next = !autopay
    setAutopay(next); setErr(null)   // optimistic
    const res = await fetch('/api/portal/autopay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, enabled: next }) })
    const d = await res.json().catch(() => ({}))
    if (!d.ok) { setAutopay(!next); setErr('Could not update AutoPay.'); return }
    onChanged()
  }
  const exp = cardExpLabel(card)
  const expState = cardExpiryState(card)
  const brand = card?.brand ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1) : 'Card'

  return (
    <div className="rounded-card border border-border bg-bg-secondary p-4">
      <p className="text-sm font-semibold text-ink flex items-center gap-1.5"><CreditCard className="w-4 h-4 text-accent-text" /> Payment method &amp; AutoPay</p>
      {/* Saving a card is the largest ask in this portal, and it used to be answered with
          one sentence about Stripe — which addresses a fear the customer doesn't have.
          What they actually want to know is WHEN, HOW MUCH, and HOW TO STOP. All three are
          true of the engine today (autopay.ts only charges invoices tied to a recurring
          visit, after completion, for that visit's amount) — the portal just never said so.
          Note this reassurance must render BEFORE the Add-card button, not only after. */}
      <p className="text-xs text-ink-muted mt-0.5 mb-3">Your card is stored securely by Stripe — never by us.</p>
      <ul className="text-xs text-ink-muted mb-3 space-y-1">
        <li className="flex items-start gap-1.5"><Check className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" /> We charge only the invoice from each recurring visit — after that visit is done, for that visit&rsquo;s amount.</li>
        <li className="flex items-start gap-1.5"><Check className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" /> One-off jobs and extra work are never charged automatically — we&rsquo;ll always ask you first.</li>
        <li className="flex items-start gap-1.5"><Check className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" /> Every charge gets a receipt, and shows up in your payment history here.</li>
        <li className="flex items-start gap-1.5"><Check className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" /> Turn AutoPay off or remove your card any time — it takes effect right away.</li>
      </ul>
      {card ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-tertiary px-3 py-2.5">
          <span className="text-sm text-ink flex items-center gap-2 min-w-0">
            <CreditCard className="w-4 h-4 text-ink-muted shrink-0" />
            <span className="truncate">{brand} •••• {card.last4 || '????'}{exp ? ` · ${exp}` : ''}</span>
          </span>
          <div className="flex items-center gap-3 shrink-0">
            <button onClick={addCard} disabled={busy !== null} className="text-xs font-medium text-accent-text hover:underline disabled:opacity-50 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">Replace</button>
            <button onClick={removeCard} disabled={busy !== null} className="text-xs font-medium text-red-400/70 hover:text-red-400 disabled:opacity-50 flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"><Trash2 className="w-3.5 h-3.5" /> Remove</button>
          </div>
        </div>
      ) : (
        <Button className="w-full" onClick={addCard} disabled={busy !== null} loading={busy === 'card'}>
          <CreditCard className="w-4 h-4" /> Add a card
        </Button>
      )}
      <div className="flex items-center justify-between gap-3 mt-3 rounded-lg border border-border bg-bg-tertiary px-3 py-2.5">
        <span className="text-sm text-ink flex items-center gap-2"><Zap className="w-4 h-4 text-accent-text" /> AutoPay recurring invoices</span>
        <button onClick={toggle} disabled={!card && !autopay} aria-pressed={autopay} aria-label="AutoPay recurring invoices"
          className={cn('relative w-11 h-6 rounded-full transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50', autopay ? 'bg-accent' : 'bg-border-strong', (!card && !autopay) && 'opacity-40 cursor-not-allowed')}>
          <span className={cn('absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform', autopay && 'translate-x-5')} />
        </button>
      </div>
      {/* The customer is the only person who can actually fix an expiring card, and this
          is the only screen where they see it. Silence here means their next visit
          declines and they find out from a chase message instead. */}
      {card && (expState === 'expired' || expState === 'expiring') && (
        <p className="text-xs text-amber-400 mt-2 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            {expState === 'expired'
              ? <>This card expired{exp ? ` in ${exp}` : ''}, so AutoPay can&rsquo;t charge it. Tap <strong>Replace</strong> to add a current one.</>
              : <>This card expires{exp ? ` in ${exp}` : ' soon'}. Tap <strong>Replace</strong> to keep AutoPay running without a gap.</>}
          </span>
        </p>
      )}
      {card && expState !== 'expired' && <p className="text-[11px] text-ink-faint mt-2 flex items-center gap-1"><ShieldCheck className="w-3 h-3 text-emerald-400" /> Secured by Stripe. You can remove your card or turn off AutoPay anytime.</p>}
      {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
    </div>
  )
}

// ── Request ──
function RequestTab({ presets, reqMsg, setReqMsg, request, reqBusy, reqSent, biz, submitRequest }: {
  presets: string[]; reqMsg: string; setReqMsg: (s: string) => void
  request: (msg: string, key: string) => void; reqBusy: string | null; reqSent: string | null; biz: PortalData['business']
  submitRequest: SubmitRequestFn
}) {
  return (
    <div className="space-y-3">
      {/* Only render the picker when this business actually has a catalogue.
          An empty grid under "Tap a service" would read as broken; the free-text
          ask below is always available and does the same job. */}
      {presets.length > 0 && (
      <div className="rounded-card border border-border bg-bg-secondary p-4">
        <p className="text-sm font-semibold text-ink flex items-center gap-1.5"><Sparkles className="w-4 h-4 text-accent-text" /> Request a service</p>
        <p className="text-xs text-ink-muted mt-0.5 mb-3">Tap a service to request a quote — {biz?.company_name || 'we'}’ll be in touch.</p>
        <div className="grid grid-cols-2 gap-2">
          {presets.map(p => {
            const key = `preset:${p}`
            const sent = reqSent === key
            return (
              <button key={p} onClick={() => request(`Service request: ${p} quote`, key)} disabled={reqBusy !== null || sent}
                className={cn('h-11 rounded-xl border text-sm font-medium flex items-center justify-center gap-1.5 transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                  sent ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : 'border-border bg-bg-tertiary text-ink hover:border-accent/40')}>
                {reqBusy === key ? <Loader2 className="w-4 h-4 animate-spin" /> : sent ? <Check className="w-4 h-4" /> : null}
                {sent ? 'Requested' : p}
              </button>
            )
          })}
        </div>
      </div>
      )}

      <AppointmentCard presets={presets} biz={biz} submitRequest={submitRequest} />

      <div className="rounded-card border border-border bg-bg-secondary p-4">
        <p className="text-sm font-semibold text-ink mb-1">{presets.length > 0 ? 'Something else?' : 'Request a service'}</p>
        {reqSent === 'custom' ? (
          <p className="text-sm text-emerald-400 flex items-center gap-1.5 py-2"><CheckCircle2 className="w-4 h-4" /> Request sent — we’ll be in touch soon.</p>
        ) : (
          <form onSubmit={e => { e.preventDefault(); if (reqMsg.trim() && reqBusy !== 'custom') request(reqMsg, 'custom') }}>
            <textarea value={reqMsg} onChange={e => setReqMsg(e.target.value)} rows={3} aria-label="Your request" placeholder="e.g. Can you add a fall cleanup this month?"
              className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-3 text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
            <div className="mt-2"><Button size="sm" type="submit" loading={reqBusy === 'custom'} disabled={!reqMsg.trim()}>Send request</Button></div>
          </form>
        )}
      </div>
    </div>
  )
}

// ── Appointment request (a visit on a date, not just "a service sometime") ────
// The preset buttons above ask for a QUOTE; this asks for a VISIT — with the date
// preference that makes it schedulable. Free text alone forced customers to
// narrate a date ("sometime the week of the 20th, mornings") that the owner then
// re-typed into the calendar; preferred_date arrives structured now.
function AppointmentCard({ presets, biz, submitRequest }: { presets: string[]; biz: PortalData['business']; submitRequest: SubmitRequestFn }) {
  const [svc, setSvc] = useState('')
  const [date, setDate] = useState('')
  const [win, setWin] = useState<'anytime' | 'morning' | 'afternoon'>('anytime')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const inputCls = 'w-full h-10 px-3 rounded-xl bg-bg-tertiary border border-border-strong text-base sm:text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20'
  if (sent) return (
    <div className="rounded-card border border-emerald-500/30 bg-emerald-500/[0.06] p-4">
      <p className="text-sm font-semibold text-emerald-400 flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" /> Appointment request sent</p>
      {/* "We'll be in touch" leaves people watching their phone — say where the
          answer lands. The booked visit appears on the Home tab like every other. */}
      <p className="text-xs text-ink-muted mt-1">{biz?.company_name || 'We'}&rsquo;ll confirm a time with you. Once it&rsquo;s booked, the visit shows up right here in your portal.</p>
      <Button size="sm" variant="secondary" className="mt-3" onClick={() => { setSent(false); setDate(''); setNote('') }}>Request another time</Button>
    </div>
  )
  return (
    <div className="rounded-card border border-border bg-bg-secondary p-4">
      <p className="text-sm font-semibold text-ink flex items-center gap-1.5"><CalendarPlus className="w-4 h-4 text-accent-text" /> Request an appointment</p>
      <p className="text-xs text-ink-muted mt-0.5 mb-3">Pick a day that suits you — {biz?.company_name || 'we'}&rsquo;ll confirm the time.</p>
      <form className="space-y-2"
        onSubmit={async e => {
          e.preventDefault()
          if (!date || busy) return
          setBusy(true)
          const ok = await submitRequest({
            kind: 'appointment', preferredDate: date,
            details: { window: win, service: svc || null },
            message: `Appointment request: ${svc || 'a visit'} — preferred ${formatDate(date)}${win !== 'anytime' ? `, ${win}` : ''}.${note.trim() ? ` ${note.trim()}` : ''}`,
          })
          setBusy(false)
          if (ok) setSent(true)
        }}>
        {presets.length > 0 && (
          <div>
            <label className="block text-xs font-medium text-ink mb-1" htmlFor="appt-svc">Service</label>
            <select id="appt-svc" value={svc} onChange={e => setSvc(e.target.value)} className={inputCls}>
              <option value="">Not sure yet</option>
              {presets.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs font-medium text-ink mb-1" htmlFor="appt-date">Preferred date</label>
            <input id="appt-date" type="date" required value={date} min={localTodayISO()} onChange={e => setDate(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink mb-1" htmlFor="appt-win">Time of day</label>
            <select id="appt-win" value={win} onChange={e => setWin(e.target.value as 'anytime' | 'morning' | 'afternoon')} className={inputCls}>
              <option value="anytime">Anytime</option>
              <option value="morning">Morning</option>
              <option value="afternoon">Afternoon</option>
            </select>
          </div>
        </div>
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} aria-label="Anything we should know?" placeholder="Anything we should know? (optional)"
          className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
        <Button size="sm" type="submit" loading={busy} disabled={!date}><CalendarPlus className="w-4 h-4" /> Request this day</Button>
        <p className="text-[11px] text-ink-faint">This sends a request — nothing is booked until we confirm with you.</p>
      </form>
    </div>
  )
}

// ── Messages (the customer's copy of the ONE conversation) ────────────────────
// Reads the SAME messages table the owner's Messages hub writes — outbound texts
// the business sent, requests the customer made, and portal chat, one thread.
// Sending inserts an inbound 'portal' message; the existing triggers bump the
// owner's unread and raise their notification. Nothing here touches lib/comms —
// this tab never SENDS to a phone or inbox, it just writes the shared record.
function MessagesTab({ token, businessName }: { token: string; businessName: string | null }) {
  const supabase = useMemo(() => createClient(), [])
  const [msgs, setMsgs] = useState<PortalMessage[] | null>(null)
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const threadRef = useRef<HTMLDivElement | null>(null)

  // Load on open + a modest poll so an owner reply appears without a manual
  // refresh. 30s is deliberate: portal tabs are short-lived and anon.
  useEffect(() => {
    let alive = true
    async function loadMsgs() {
      const { data } = await supabase.rpc('portal_get_messages', { p_token: token })
      if (alive) setMsgs(m => (Array.isArray(data) ? (data as PortalMessage[]) : (m ?? [])))
    }
    loadMsgs()
    const t = setInterval(loadMsgs, 30_000)
    return () => { alive = false; clearInterval(t) }
  }, [token, supabase])

  // Keep the newest message in view — scroll the thread box, never the page.
  const count = msgs?.length ?? 0
  useEffect(() => { const el = threadRef.current; if (el) el.scrollTop = el.scrollHeight }, [count])

  async function send() {
    const text = body.trim()
    if (!text || sending) return
    setSending(true); setErr(null)
    const { data: ok, error } = await supabase.rpc('portal_send_message', { p_token: token, p_body: text })
    if (error || !ok) {
      setErr('Your message didn’t send — please try again, or call us directly.')
    } else {
      setBody('')
      // Show it immediately, then reconcile with the server copy (which also
      // picks up anything that arrived meanwhile).
      setMsgs(m => [...(m ?? []), { id: `local-${Date.now()}`, direction: 'inbound', channel: 'portal', body: text, created_at: new Date().toISOString() }])
      setTimeout(async () => {
        const { data } = await supabase.rpc('portal_get_messages', { p_token: token })
        if (Array.isArray(data)) setMsgs(data as PortalMessage[])
      }, 1200)
    }
    setSending(false)
  }

  // Day separators — a thread without dates turns "did they reply yesterday or
  // last month?" into archaeology.
  const rows = useMemo(() => {
    const out: ({ kind: 'day'; key: string; label: string } | { kind: 'msg'; m: PortalMessage })[] = []
    let lastDay = ''
    for (const m of msgs ?? []) {
      const day = (m.created_at || '').slice(0, 10)
      if (day && day !== lastDay) { out.push({ kind: 'day', key: 'd' + day, label: formatDate(day) }); lastDay = day }
      out.push({ kind: 'msg', m })
    }
    return out
  }, [msgs])

  const who = businessName || 'Your service provider'
  return (
    <div className="space-y-3">
      <div className="rounded-card border border-border bg-bg-secondary">
        {msgs === null ? (
          <p className="text-sm text-ink-muted flex items-center gap-2 px-4 py-8 justify-center"><Loader2 className="w-4 h-4 animate-spin" /> Loading your messages…</p>
        ) : rows.length === 0 ? (
          <div className="py-10 px-6 text-center">
            <MessageSquare className="w-7 h-7 text-ink-faint mx-auto mb-2.5" />
            <p className="text-sm text-ink-muted max-w-xs mx-auto">No messages yet — write to us below and we&rsquo;ll reply right here.</p>
          </div>
        ) : (
          <div ref={threadRef} className="max-h-[26rem] overflow-y-auto px-3.5 py-3 space-y-2">
            {rows.map(r => r.kind === 'day' ? (
              <p key={r.key} className="text-center text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint pt-2">{r.label}</p>
            ) : (
              <MessageBubble key={r.m.id} m={r.m} who={who} />
            ))}
          </div>
        )}
      </div>

      {/* Composer — same shape as the Request tab's ask, plus the promise of where
          the reply lands. */}
      <div className="rounded-card border border-border bg-bg-secondary p-4">
        <form onSubmit={e => { e.preventDefault(); send() }}>
          <textarea value={body} onChange={e => setBody(e.target.value)} rows={2} aria-label="Your message" placeholder={`Message ${businessName || 'us'}…`}
            className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-3 text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
          <div className="flex items-center justify-between gap-3 mt-2">
            <p className="text-[11px] text-ink-faint">Goes straight to {businessName ? `${businessName}’s` : 'our'} inbox — replies appear right here.</p>
            <Button size="sm" type="submit" loading={sending} disabled={!body.trim()}><Send className="w-4 h-4" /> Send</Button>
          </div>
        </form>
        {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
      </div>
    </div>
  )
}
function MessageBubble({ m, who }: { m: PortalMessage; who: string }) {
  // direction is the OWNER's perspective — 'inbound' is the customer speaking.
  const mine = m.direction === 'inbound'
  const time = m.created_at ? new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
  const via = m.channel === 'sms' ? ' · by text' : m.channel === 'email' ? ' · by email' : ''
  return (
    <div className={cn('max-w-[85%]', mine ? 'ml-auto' : 'mr-auto')}>
      <div className={cn('rounded-2xl border px-3.5 py-2.5', mine ? 'bg-accent/15 border-accent/25 rounded-br-md' : 'bg-bg-tertiary border-border rounded-bl-md')}>
        <p className="text-sm text-ink whitespace-pre-wrap break-words">{m.body}</p>
      </div>
      <p className={cn('text-[10px] text-ink-faint mt-0.5 px-1', mine ? 'text-right' : 'text-left')}>
        {mine ? 'You' : who}{time ? ` · ${time}` : ''}{via}
      </p>
    </div>
  )
}

// ── Review ask (only after a completed visit, hidden once they've reviewed) ──
function ReviewCard({ reviewUrl, businessName, reviewed, onReviewed, onDecline }: { reviewUrl: string; businessName: string | null; reviewed: boolean; onReviewed: () => void; onDecline: () => void }) {
  const href = reviewUrl.startsWith('http') ? reviewUrl : `https://${reviewUrl}`
  // Both buttons used to mean "yes", so the only way to decline was to lie ("I've left my
  // review") or to ignore a card that never went away. "No thanks" was then added as a
  // door — but a session-local one: it died with the tab while the review-request cron
  // (which suppresses on review_declined_at) kept messaging them. It now writes that
  // column through portal_decline_review, so declining is honoured everywhere the owner's
  // own decline already is. The parent owns the hidden state, since the answer outlives
  // this component.
  if (reviewed) {
    return (
      <div className="rounded-card border border-emerald-500/30 bg-emerald-500/[0.06] p-4 mt-3">
        <p className="text-sm font-semibold text-emerald-400 flex items-center gap-1.5"><Star className="w-4 h-4" /> Thank you for your review!</p>
        <p className="text-xs text-ink-muted mt-0.5">We really appreciate you taking the time.</p>
      </div>
    )
  }
  return (
    <div className="rounded-card border border-amber-400/30 bg-amber-400/[0.06] p-4 mt-3">
      <p className="text-sm font-semibold text-ink flex items-center gap-1.5"><Star className="w-4 h-4 text-amber-400" /> Enjoying the service?</p>
      <p className="text-xs text-ink-muted mt-0.5 mb-3">
        If we did right by you, a quick review means a lot to a small business like {businessName || 'ours'}. Totally optional — it won&rsquo;t affect your service either way.
      </p>
      <div className="flex flex-wrap gap-2">
        <a href={href} target="_blank" rel="noopener noreferrer"
          className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-2 font-medium rounded-xl transition-all duration-150 bg-accent text-black hover:bg-accent-hover active:scale-[0.98] shadow-sm px-4 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
          <Star className="w-4 h-4" /> Leave a review
        </a>
        <Button variant="secondary" className="flex-1 min-w-[140px]" onClick={onReviewed}>
          <Check className="w-4 h-4" /> Already did — thanks!
        </Button>
        <Button variant="ghost" className="flex-1 min-w-[100px]" onClick={onDecline}>
          No thanks
        </Button>
      </div>
    </div>
  )
}

// ── Message preferences (self-serve consent) ──
function ConsentCard({ token, consent, onSave }: { token: string; consent: { sms: boolean; email: boolean }; onSave: (c: { sms: boolean; email: boolean }, prefs?: Record<string, boolean>) => void }) {
  // Per-category preferences (customers.message_prefs) — loaded lazily so
  // get_portal_data stays untouched; a missing key means "yes" (inherit).
  const supabase = useMemo(() => createClient(), [])
  const [prefs, setPrefs] = useState<Record<string, boolean> | null>(null)
  useEffect(() => {
    let alive = true
    supabase.rpc('portal_get_prefs', { p_token: token })
      .then(({ data }) => { if (alive) setPrefs((data as Record<string, boolean>) || {}) }, () => { if (alive) setPrefs({}) })
    return () => { alive = false }
  }, [token, supabase])

  const CATS: [string, string][] = [
    ['reminders', 'Appointment reminders & updates'],
    ['estimates', 'Estimates & quotes'],
    ['invoices', 'Invoices & receipts'],
    ['seasonal', 'Seasonal reminders'],
    ['marketing', 'Offers & news'],
  ]
  function toggleCat(k: string) {
    const next = { ...(prefs || {}), [k]: !(prefs?.[k] !== false) }
    setPrefs(next)
    onSave(consent, next)
  }

  return (
    <div className="rounded-card border border-border bg-bg-secondary p-4 mt-3">
      <p className="text-sm font-semibold text-ink flex items-center gap-1.5"><MessageSquare className="w-4 h-4 text-accent-text" /> Message preferences</p>
      <p className="text-xs text-ink-muted mt-0.5 mb-3">Choose how we can reach you — you can change this anytime. Message &amp; data rates may apply to texts.</p>
      <div className="space-y-2">
        <PrefRow label="Text messages (SMS)" icon={MessageSquare} on={consent.sms} onChange={v => onSave({ ...consent, sms: v })} />
        <PrefRow label="Email" icon={Mail} on={consent.email} onChange={v => onSave({ ...consent, email: v })} />
      </div>
      {prefs !== null && (consent.sms || consent.email) && (
        <div className="mt-3 pt-3 border-t border-border space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">What we message you about</p>
          {CATS.map(([k, label]) => (
            <PrefRow key={k} label={label} icon={MessageSquare} on={prefs[k] !== false} onChange={() => toggleCat(k)} />
          ))}
        </div>
      )}
    </div>
  )
}
function PrefRow({ label, icon: Icon, on, onChange }: { label: string; icon: typeof Mail; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-tertiary px-3 py-2.5">
      <span className="text-sm text-ink flex items-center gap-2"><Icon className="w-4 h-4 text-ink-muted" /> {label}</span>
      <button onClick={() => onChange(!on)} aria-pressed={on} aria-label={label}
        className={cn('relative w-11 h-6 rounded-full transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50', on ? 'bg-accent' : 'bg-border-strong')}>
        <span className={cn('absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform', on && 'translate-x-5')} />
      </button>
    </div>
  )
}

// ── Document actions (View / Download / Print) — same PDF the dashboard makes ──
function DocActions({ getBlob, filename }: { getBlob: () => Promise<Blob>; filename: string }) {
  const [busy, setBusy] = useState<'view' | 'download' | 'print' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  async function run(kind: 'view' | 'download' | 'print') {
    if (busy) return
    setBusy(kind); setErr(null)
    try {
      const blob = await getBlob()
      if (kind === 'download') downloadBlob(blob, filename)
      else if (kind === 'print') printBlob(blob)
      else viewBlob(blob)
    } catch {
      setErr('Could not generate the PDF — please try again.')
    } finally { setBusy(null) }
  }
  return (
    <div className="mt-3 pt-3 border-t border-border">
      <div className="flex flex-wrap items-center gap-2">
        <DocBtn icon={Eye} label="View" loading={busy === 'view'} disabled={busy !== null} onClick={() => run('view')} />
        <DocBtn icon={Download} label="Download PDF" loading={busy === 'download'} disabled={busy !== null} onClick={() => run('download')} primary />
        <DocBtn icon={Printer} label="Print" loading={busy === 'print'} disabled={busy !== null} onClick={() => run('print')} />
      </div>
      {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
    </div>
  )
}
// Compact utility row — quiet on purpose, so it never outweighs the Accept/Pay
// CTA above it. Download PDF gets a secondary tint; View/Print stay ghost.
function DocBtn({ icon: Icon, label, loading, disabled, onClick, primary }: { icon: typeof Eye; label: string; loading?: boolean; disabled?: boolean; onClick: () => void; primary?: boolean }) {
  return (
    <Button size="sm" variant={primary ? 'secondary' : 'ghost'} loading={loading} disabled={disabled} onClick={onClick} className="flex-1 min-w-[92px]">
      {!loading && <Icon className="w-4 h-4" />} {label}
    </Button>
  )
}

// ── shared bits ──
function Empty({ text, icon: Icon = Sparkles }: { text: string; icon?: typeof Home }) {
  return (
    <div className="rounded-card border border-dashed border-border bg-bg-secondary/40 py-10 px-6 text-center">
      <Icon className="w-7 h-7 text-ink-faint mx-auto mb-2.5" />
      <p className="text-sm text-ink-muted max-w-xs mx-auto">{text}</p>
    </div>
  )
}
function PriceChip({ label, v }: { label: string; v: number }) {
  return <span className="text-xs rounded-lg border border-border bg-bg-tertiary px-2 py-1"><span className="text-ink-faint">{label}</span> <span className="font-semibold text-ink">{formatCurrency(Number(v))}</span></span>
}
function QuoteStatusPill({ status }: { status: string }) {
  // Homeowner-friendly labels — never leak raw internal statuses into the portal.
  const map: Record<string, { label: string; tone: string }> = {
    accepted:  { label: 'Approved',               tone: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
    scheduled: { label: 'Scheduled',              tone: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
    completed: { label: 'Completed',              tone: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
    paid:      { label: 'Completed',              tone: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
    declined:  { label: 'Declined',               tone: 'text-red-400 border-red-500/30 bg-red-500/10' },
    sent:      { label: 'Awaiting your approval', tone: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
    // Derived, never stored (lib/quoteStatus). Deliberately NOT red: an expired quote
    // isn't a rejection or a failure — the price simply lapsed, and asking for a fresh
    // one is a normal thing to do.
    expired:   { label: 'Expired',                tone: 'text-ink-muted border-border bg-bg-tertiary' },
  }
  const m = map[status] ?? { label: 'Quote', tone: 'text-ink-muted border-border bg-bg-tertiary' }
  return <span className={cn('text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border', m.tone)}>{m.label}</span>
}
function InvoiceStatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; tone: string }> = {
    paid:     { label: 'Paid',           tone: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
    overpaid: { label: 'Overpaid',       tone: 'text-violet-400 border-violet-500/30 bg-violet-500/10' },
    partial:  { label: 'Partially Paid', tone: 'text-sky-400 border-sky-500/30 bg-sky-500/10' },
    // Customer language: an issued invoice is simply "Due" — 'sent'/'unpaid' are
    // owner-side workflow states that mean nothing to the payer.
    sent:     { label: 'Due',            tone: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
    unpaid:   { label: 'Due',            tone: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
    // Derived from due_date, never stored — same overlay pattern as quote expiry. Red
    // because it's genuinely time-sensitive, but the copy stays neutral: being late
    // happens, and the row right here is how they fix it.
    overdue:  { label: 'Past due',       tone: 'text-red-400 border-red-500/30 bg-red-500/10' },
    cancelled:{ label: 'Cancelled',      tone: 'text-ink-muted border-border bg-bg-tertiary' },
    // Same rule as sent/unpaid above: "Draft" is an owner-side workflow word. To the payer
    // it reads as a bill they can't pay and can't act on — a mistake, or a threat.
    draft:    { label: 'Not yet issued',  tone: 'text-ink-muted border-border bg-bg-tertiary' },
  }
  const m = map[status] || { label: 'Due', tone: 'text-amber-400 border-amber-500/30 bg-amber-500/10' }
  return <span className={cn('text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border', m.tone)}>{m.label}</span>
}

function groupPhotos(photos: PortalPhoto[]): Map<string, PortalPhoto[]> {
  const m = new Map<string, PortalPhoto[]>()
  for (const p of photos) { const k = p.job_id || 'none'; if (!m.has(k)) m.set(k, []); m.get(k)!.push(p) }
  return m
}
