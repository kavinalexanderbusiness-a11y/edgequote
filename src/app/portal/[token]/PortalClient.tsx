'use client'

import { useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { confirm as confirmDialog } from '@/lib/confirm'
import { ConfirmHost } from '@/components/ui/ConfirmHost'
import { recurrenceLabel } from '@/lib/recurrence'
import { invoiceTotals } from '@/lib/invoiceTotals'
import { serviceLineTotals } from '@/lib/quoteServices'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { renderPortalQuoteBlob, renderPortalInvoiceBlob, renderPortalReceiptBlob, downloadBlob, viewBlob, printBlob } from '@/lib/portalPdf'
import { receiptNumberFor } from '@/lib/payments/ledger'
import {
  Home, History, Image as ImageIcon, FileText, Receipt, MessageSquarePlus, Check, Loader2,
  Phone, Globe, Mail, Leaf, CheckCircle2, Navigation, Play, CalendarClock, Repeat, MapPin, Ruler, Sparkles, CreditCard, MessageSquare,
  Eye, Download, Printer, FolderOpen, Search, ArrowUpDown, Activity, Wallet, Star, Zap, ShieldCheck, Trash2, X, Landmark, Banknote, Copy,
} from 'lucide-react'

// ── Premium Customer Portal ─────────────────────────────────────────────────────
// Public, no-login, scoped to the token's customer via get_portal_data. A clean
// service-app experience: a Home overview, live job status, a per-visit timeline
// with photos & invoices, a before/after gallery, and quick service requests.

interface PortalQuoteService { service_type: string; quantity: number; unit: string | null; unit_price: number; est_minutes: number | null; discount_type: 'amount' | 'percent' | null; discount_value: number | null; notes: string | null; sort_order: number }
interface PortalQuote { id: string; quote_number: string; service_type: string; address: string; total: number; initial_price: number | null; subtotal: number | null; weekly_price: number | null; biweekly_price: number | null; monthly_price: number | null; notes: string | null; status: string; created_at: string; issued_date: string | null; crew_size: number | null; hours: number | null; travel_fee: number | null; services?: PortalQuoteService[] | null }
interface PortalInvoice { id: string; invoice_number: string; service_type: string | null; amount: number; status: string; issued_date: string | null; due_date: string | null; notes: string | null; address: string | null; line_items: { description: string; amount: number; kind: string }[] | null; job_id: string | null; created_at: string; discount_type?: 'amount' | 'percent' | null; discount_value?: number | null; amount_paid?: number | null }
interface PortalJob { id: string; recurrence_id: string | null; service_type: string | null; title: string; scheduled_date: string; status: string; on_my_way_at: string | null; started_at: string | null; completed_at: string | null; notes: string | null }
interface PortalRec { id: string; freq: string | null; interval_unit: string | null; interval_count: number | null; end_date: string | null }
interface PortalPhoto { id: string; job_id: string | null; storage_path: string; kind: string; caption: string | null; taken_at: string }
interface PortalPayment { id: string; amount: number; status: string; paid_at: string | null; provider: string; invoice_id: string | null; created_at: string; kind?: string }
interface PortalCard { brand: string | null; last4: string | null; exp_month: number | null; exp_year: number | null }
interface PortalData {
  customer: { id: string; name: string; email: string | null; phone: string | null; address: string | null; city: string | null; sms_opt_in?: boolean | null; email_opt_in?: boolean | null; reviewed_at?: string | null; autopay_enabled?: boolean | null }
  business: { company_name: string | null; owner_name: string | null; phone: string | null; email_primary: string | null; email_secondary: string | null; website: string | null; logo_url: string | null; logo_scale: number | null; base_address: string | null; terms_text: string | null; review_url?: string | null; etransfer_email?: string | null; gst_percent?: number | null } | null
  property: { address: string | null; city: string | null; province: string | null; lawn_sqft: number | null; fence_length: number | null; neighborhood: string | null; notes: string | null } | null
  quotes: PortalQuote[]; invoices: PortalInvoice[]; jobs: PortalJob[]; recurrences: PortalRec[]; photos: PortalPhoto[]; payments: PortalPayment[]
  payment_method?: PortalCard | null
}

type Tab = 'home' | 'timeline' | 'service' | 'photos' | 'property' | 'documents' | 'payments' | 'request'
type LiveStatus = 'scheduled' | 'on_my_way' | 'in_progress' | 'completed'

interface Derived {
  upcoming: PortalJob[]; completed: PortalJob[]; nextService: PortalJob | null
  lastCompleted: PortalJob | null; outstanding: number
  plans: { id: string; label: string; service: string }[]
}

const REQUEST_PRESETS = ['Mulch', 'Spring Cleanup', 'Fall Cleanup', 'Weed Control', 'Landscaping']

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
  const [justPaid, setJustPaid] = useState(false)
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

  async function load() {
    const { data: d } = await supabase.rpc('get_portal_data', { p_token: token })
    const pd = normalizePortal(d)
    setData(pd)
    if (pd) setConsentState({ sms: !!pd.customer?.sms_opt_in, email: !!pd.customer?.email_opt_in })
    setLoading(false)
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
        setJustPaid(true)
        window.history.replaceState({}, '', `/portal/${token}`)
        setTimeout(() => load(), 1500)
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
    const confirmed = await confirmDialog({
      title: 'Approve this quote?',
      message: svc
        ? `You're approving ${svc}. We'll follow up to schedule your first visit.`
        : `We'll follow up to schedule your first visit once you approve.`,
      confirmLabel: 'Approve quote',
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
    const completed = jobs.filter(j => j.status === 'completed').sort((a, b) => b.scheduled_date.localeCompare(a.scheduled_date))
    const nextService = upcoming[0] || null
    const lastCompleted = completed[0] || null
    // Outstanding = unpaid BALANCE (total − payments recorded) across issued invoices,
    // so partial payments and discounts are reflected. Same engine as the dashboard.
    const gstPct = Number(data.business?.gst_percent) || 0
    const outstanding = (data.invoices || []).filter(i => i.status !== 'draft' && i.status !== 'cancelled').reduce((s, i) => {
      const total = invoiceTotals(i.amount, { gst_percent: gstPct }, { type: i.discount_type, value: i.discount_value }).total
      return s + Math.max(0, Math.round((total - (Number(i.amount_paid) || 0)) * 100) / 100)
    }, 0)
    // Active plans: recurrences that still have an upcoming visit.
    const recById = new Map(data.recurrences.map(r => [r.id, r]))
    const activeRecIds = [...new Set(upcoming.map(j => j.recurrence_id).filter(Boolean) as string[])]
    const plans = activeRecIds.map(id => {
      const r = recById.get(id)
      const sample = jobs.find(j => j.recurrence_id === id)
      return { id, label: r ? recurrenceLabel(r.interval_unit as 'day' | 'week' | 'month' | null, r.interval_count, r.freq) : 'Recurring', service: sample?.service_type || sample?.title || 'Service' }
    })
    return { upcoming, completed, nextService, lastCompleted, outstanding, plans }
  }, [data])

  if (loading) return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 text-center px-8">
      <div className="w-11 h-11 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center"><Leaf className="w-5 h-5 text-accent" /></div>
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
    { key: 'documents', label: 'Documents', icon: FolderOpen, n: data.quotes.length + data.invoices.length },
    { key: 'payments', label: 'Payments', icon: Wallet, n: data.payments.length },
    { key: 'service', label: 'Service', icon: History, n: derived.completed.length },
    { key: 'photos', label: 'Photos', icon: ImageIcon, n: data.photos.length },
    { key: 'timeline', label: 'Timeline', icon: Activity },
    { key: 'property', label: 'Property', icon: MapPin },
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
          {biz?.logo_url ? <img src={biz.logo_url} alt="" className="h-10 w-auto object-contain" /> : <div className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center"><Leaf className="w-5 h-5 text-accent" /></div>}
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
          {justPaid && (
            <div className="mb-3 rounded-card border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 text-sm px-4 py-3 flex items-start justify-between gap-3">
              <span className="flex items-start gap-2 font-medium">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <span>Payment received — thank you!{' '}
                  {data.payments.length > 0
                    ? <button onClick={() => setTab('payments')} className="underline underline-offset-2 hover:opacity-80">View your receipt →</button>
                    : <span className="font-normal">Your receipt will be ready here shortly.</span>}
                </span>
              </span>
              <button onClick={() => setJustPaid(false)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100"><X className="w-4 h-4" /></button>
            </div>
          )}
          {justAccepted && (
            <div className="mb-3 rounded-card border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 text-sm font-medium px-4 py-3 flex items-start justify-between gap-3">
              <span className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> Quote approved — thank you! We’ll be in touch to schedule your service.</span>
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
            onReviewQuotes={() => { setDocsCat('quote'); setTab('documents') }} />}
          {tab === 'home' && biz?.review_url && derived.lastCompleted && !data.customer.reviewed_at && (
            <ReviewCard reviewUrl={biz.review_url} businessName={biz.company_name} reviewed={markedReviewed} onReviewed={markReviewed} />
          )}
          {tab === 'home' && consent && <ConsentCard token={token} consent={consent} onSave={saveConsent} />}
          {tab === 'timeline' && <TimelineTab data={data} photosByJob={photosByJob} />}
          {tab === 'service' && <ServiceTab completed={derived.completed} photosByJob={photosByJob} invoiceByJob={invoiceByJob} photoUrl={photoUrl} gstPct={Number(data.business?.gst_percent) || 0} />}
          {tab === 'photos' && <GalleryTab photosByJob={photosByJob} jobs={data.jobs} photoUrl={photoUrl} />}
          {tab === 'property' && <PropertyTab property={data.property} />}
          {tab === 'payments' && <PaymentsTab customerName={data.customer.name} fallbackAddress={data.property?.address || data.customer.address || null} business={biz} payments={data.payments} invoices={data.invoices} outstanding={derived.outstanding}
            token={token} paymentsEnabled={paymentsEnabled} card={data.payment_method ?? null} autopayEnabled={!!data.customer.autopay_enabled} onChanged={load} />}
          {tab === 'documents' && <DocumentsTab quotes={data.quotes} invoices={data.invoices} customerName={data.customer.name} fallbackAddress={data.property?.address || data.customer.address || null} business={biz} onInvoiceOpen={markInvoiceViewed}
            paymentsEnabled={paymentsEnabled} pay={pay} payingId={payingId} accept={accept} accepting={accepting} initialCat={docsCat} />}
          {tab === 'request' && (
            <RequestTab presets={REQUEST_PRESETS} reqMsg={reqMsg} setReqMsg={setReqMsg} request={request} reqBusy={reqBusy} reqSent={reqSent} biz={biz} />
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
function HomeTab({ data, derived, biz, onRequest, paymentsEnabled, pay, payingId, onOpenInvoices, onReviewQuotes, suppressApproved }: {
  data: PortalData; derived: Derived; biz: PortalData['business']; onRequest: () => void
  paymentsEnabled: boolean; pay: (id: string) => void; payingId: string | null; onOpenInvoices: () => void; onReviewQuotes: () => void
  suppressApproved?: boolean
}) {
  const next = derived.nextService
  // A quote awaiting approval is usually WHY the customer opened this link —
  // signpost it up top instead of making them discover the Documents tab.
  const awaiting = (data.quotes || []).filter(q => q.status === 'sent')
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
              </div>
            </div>
            <span className="text-xs font-semibold text-amber-400 shrink-0">Review →</span>
          </div>
        </button>
      )}

      {/* Next service hero (hidden for a pure prospect — the quote card above is their whole visit) */}
      {!prospect && (
      <div className="rounded-card border border-accent/20 hero-aurora p-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-accent mb-1">Next service</p>
        {next ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="text-lg font-bold text-ink tracking-tight">{next.service_type || next.title}</p>
              <StatusPill s={liveStatusOf(next)} />
            </div>
            <p className="text-sm text-ink-muted mt-0.5">{formatDate(next.scheduled_date)}</p>
            <StatusStepper s={liveStatusOf(next)} />
            {liveStatusOf(next) === 'on_my_way' && <p className="text-xs text-sky-400 mt-2 flex items-center gap-1"><Navigation className="w-3.5 h-3.5" /> Your provider is on the way!</p>}
          </>
        ) : approvedPending ? (
          <div>
            <p className="text-sm font-semibold text-ink flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> Your quote has been approved.
            </p>
            <p className="text-sm text-ink-muted mt-1">We&rsquo;re scheduling your service and will contact you shortly.</p>
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
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint flex items-center gap-1"><Receipt className="w-3 h-3" /> Outstanding balance</p>
            <p className="text-lg font-bold mt-1 text-amber-400 tabular-nums">{formatCurrency(derived.outstanding)}</p>
            <span className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-accent">
              {payingId ? <Loader2 className="w-3 h-3 animate-spin" /> : <CreditCard className="w-3 h-3" />}
              {paymentsEnabled ? (owing.length === 1 ? 'Pay now' : 'View & pay') : 'View invoices'}
            </span>
          </button>
        ) : (
          <StatCard label="Outstanding balance" value={formatCurrency(0)} tone="text-emerald-400" icon={Receipt} />
        )}
        <StatCard label="Last completed" value={derived.lastCompleted ? formatDate(derived.lastCompleted.scheduled_date) : '—'} icon={CheckCircle2} />
      </div>
      )}

      {/* Active plan */}
      {derived.plans.length > 0 && (
        <div className="rounded-card border border-border bg-bg-secondary p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint mb-2">Active plan{derived.plans.length !== 1 ? 's' : ''}</p>
          <div className="space-y-1.5">
            {derived.plans.map(p => (
              <div key={p.id} className="flex items-center gap-2 text-sm">
                <Repeat className="w-3.5 h-3.5 text-accent shrink-0" />
                <span className="text-ink font-medium">{p.service}</span>
                <span className="text-ink-muted">· {p.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Property summary */}
      {data.property && (data.property.address || data.property.lawn_sqft) && (
        <div className="rounded-card border border-border bg-bg-secondary p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint mb-2">Your property</p>
          {data.property.address && <p className="text-sm text-ink flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5 text-ink-faint" /> {data.property.address}{data.property.city ? `, ${data.property.city}` : ''}</p>}
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-xs text-ink-muted">
            {data.property.neighborhood && <span>{data.property.neighborhood}</span>}
            {data.property.lawn_sqft ? <span className="flex items-center gap-1"><Ruler className="w-3 h-3" /> {Number(data.property.lawn_sqft).toLocaleString()} sq ft lawn</span> : null}
            {data.property.fence_length ? <span>{data.property.fence_length} ft fence</span> : null}
          </div>
        </div>
      )}

      {/* Contact */}
      {biz && (biz.phone || biz.email_primary) && (
        <div className="flex flex-wrap gap-2">
          {biz.phone && <a href={`tel:${biz.phone}`} className="flex-1 min-w-[120px] flex items-center justify-center gap-1.5 text-sm font-medium rounded-xl border border-border bg-bg-secondary py-2.5 text-ink hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"><Phone className="w-4 h-4 text-accent" /> Call</a>}
          {biz.email_primary && <a href={`mailto:${biz.email_primary}`} className="flex-1 min-w-[120px] flex items-center justify-center gap-1.5 text-sm font-medium rounded-xl border border-border bg-bg-secondary py-2.5 text-ink hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"><Mail className="w-4 h-4 text-accent" /> Email</a>}
          {biz.website && <a href={biz.website.startsWith('http') ? biz.website : `https://${biz.website}`} target="_blank" rel="noopener noreferrer" className="flex-1 min-w-[120px] flex items-center justify-center gap-1.5 text-sm font-medium rounded-xl border border-border bg-bg-secondary py-2.5 text-ink hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"><Globe className="w-4 h-4 text-accent" /> Website</a>}
        </div>
      )}
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

// ── Service timeline (grouped by visit) ──
function ServiceTab({ completed, photosByJob, invoiceByJob, photoUrl, gstPct }: { completed: PortalJob[]; photosByJob: Map<string, PortalPhoto[]>; invoiceByJob: Map<string, PortalInvoice>; photoUrl: (p: string) => string; gstPct: number }) {
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
              <span className="text-xs text-ink-muted">{formatDate(j.scheduled_date)}</span>
            </div>
            {photos.length > 0 && (
              <div className="grid grid-cols-4 gap-1.5 mt-3">
                {photos.slice(0, 4).map(p => (
                  <a key={p.id} href={photoUrl(p.storage_path)} target="_blank" rel="noopener noreferrer" className="aspect-square rounded-lg overflow-hidden border border-border bg-bg-tertiary">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={photoUrl(p.storage_path)} alt="" loading="lazy" className="w-full h-full object-cover" />
                  </a>
                ))}
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
            <p className="text-xs text-ink-faint mb-2.5">{j ? formatDate(j.scheduled_date) : ''}</p>
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
interface DocItem { id: string; rawId: string; kind: DocKind; number: string; title: string; date: string; status: string; amount: number; balance: number; filename: string; getBlob: () => Promise<Blob>; lines?: { label: string; amount: number }[] }
const KIND_META: Record<DocKind, { label: string; icon: typeof FileText; tone: string }> = {
  quote: { label: 'Quote', icon: FileText, tone: 'text-accent border-accent/25 bg-accent/10' },
  invoice: { label: 'Invoice', icon: Receipt, tone: 'text-sky-400 border-sky-500/25 bg-sky-500/10' },
}


function DocumentsTab({ quotes, invoices, customerName, fallbackAddress, business, onInvoiceOpen, paymentsEnabled, pay, payingId, accept, accepting, initialCat }: {
  quotes: PortalQuote[]; invoices: PortalInvoice[]; customerName: string; fallbackAddress: string | null; business: PortalData['business']
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
  const docs = useMemo<DocItem[]>(() => {
    const q: DocItem[] = quotes.map(qq => {
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
        Number(qq.monthly_price) > 0 ? { label: 'Monthly plan', amount: Number(qq.monthly_price) } : null,
      ].filter((l): l is { label: string; amount: number } => l !== null)
      const allLines = [...svcLines, ...planLines]
      const lines = allLines.length > 0 ? allLines : undefined
      return {
        id: 'q' + qq.id, rawId: qq.id, kind: 'quote' as const, number: qq.quote_number, title: qq.service_type || 'Quote',
        date: qq.issued_date || qq.created_at, status: qq.status, amount: Number(qq.total) || 0, balance: 0,
        filename: `${qq.quote_number}.pdf`, getBlob: () => renderPortalQuoteBlob(qq, customerName, business), lines,
      }
    })
    const inv: DocItem[] = invoices.map(ii => {
      // Same balance math as the dashboard: discounted+GST total − payments recorded.
      const total = invoiceTotals(ii.amount, { gst_percent: gstPct }, { type: ii.discount_type, value: ii.discount_value }).total
      const balance = Math.max(0, Math.round((total - (Number(ii.amount_paid) || 0)) * 100) / 100)
      return {
        id: 'i' + ii.id, rawId: ii.id, kind: 'invoice' as const, number: ii.invoice_number, title: ii.service_type || 'Invoice',
        date: ii.issued_date || ii.created_at, status: ii.status, amount: total, balance,
        filename: `${ii.invoice_number}.pdf`, getBlob: () => { onInvoiceOpen?.(ii.id); return renderPortalInvoiceBlob(ii, customerName, fallbackAddress, business) },
      }
    })
    return [...q, ...inv]
  }, [quotes, invoices, customerName, fallbackAddress, business, onInvoiceOpen, gstPct])

  const counts = { all: docs.length, quote: docs.filter(d => d.kind === 'quote').length, invoice: docs.filter(d => d.kind === 'invoice').length }

  const filtered = useMemo(() => {
    const ql = query.trim().toLowerCase()
    let list = cat === 'all' ? docs : docs.filter(d => d.kind === cat)
    if (ql) list = list.filter(d =>
      d.number.toLowerCase().includes(ql) || d.title.toLowerCase().includes(ql) ||
      d.status.toLowerCase().includes(ql) || KIND_META[d.kind].label.toLowerCase().includes(ql))
    return [...list].sort((a, b) => sort === 'newest' ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date))
  }, [docs, cat, query, sort])

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
  const canAccept = d.kind === 'quote' && d.status === 'sent'
  const canPay = d.kind === 'invoice' && paymentsEnabled && d.balance > 0 && d.status !== 'draft' && d.status !== 'cancelled'
  return (
    <div className="rounded-card border border-border bg-bg-secondary p-4 card-lift">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-3 min-w-0">
          <div className={cn('w-9 h-9 rounded-lg border flex items-center justify-center shrink-0', m.tone)}><m.icon className="w-4 h-4" /></div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink truncate tracking-tight">{d.title}</p>
            <p className="text-xs text-ink-muted">{m.label} · {d.number} · {formatDate(d.date)}</p>
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-bold text-ink tabular-nums">{formatCurrency(d.amount)}</p>
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
      {(canAccept || canPay) && (
        <div className="mt-3">
          {canAccept && (
            <Button className="w-full sm:w-auto" onClick={() => accept(d.rawId)} loading={accepting === d.rawId}><Check className="w-4 h-4" /> Accept this quote</Button>
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
    for (const q of data.quotes) ev.push({
      id: 'q' + q.id, at: q.issued_date || q.created_at, icon: FileText,
      tone: q.status === 'accepted' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : 'text-amber-400 border-amber-500/30 bg-amber-500/10',
      title: `Quote ${q.quote_number} ${q.status === 'accepted' ? 'accepted' : q.status === 'declined' ? 'declined' : 'sent'}`, sub: q.service_type || null,
    })
    for (const j of data.jobs) {
      if (j.completed_at || j.status === 'completed') ev.push({ id: 'jc' + j.id, at: j.completed_at || j.scheduled_date, icon: CheckCircle2, tone: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10', title: `${j.service_type || j.title} completed`, sub: null })
      else ev.push({ id: 'js' + j.id, at: j.scheduled_date, icon: CalendarClock, tone: 'text-sky-400 border-sky-500/30 bg-sky-500/10', title: `${j.service_type || j.title} scheduled`, sub: null })
    }
    for (const i of data.invoices) ev.push({ id: 'i' + i.id, at: i.issued_date || i.created_at, icon: Receipt, tone: 'text-ink-muted border-border bg-bg-tertiary', title: `Invoice ${i.invoice_number}`, sub: formatCurrency(invoiceTotals(i.amount, { gst_percent: Number(data.business?.gst_percent) || 0 }, { type: i.discount_type, value: i.discount_value }).total) })
    for (const p of data.payments) ev.push({ id: 'p' + p.id, at: p.paid_at || p.created_at, icon: CreditCard, tone: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10', title: 'Payment received', sub: formatCurrency(Number(p.amount)) })
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
          {property.lawn_sqft ? <StatCard label="Lawn size" value={`${Number(property.lawn_sqft).toLocaleString()} sq ft`} icon={Ruler} /> : null}
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
  async function downloadReceipt(p: PortalPayment, inv: PortalInvoice) {
    setReceiptBusy(p.id)
    try {
      downloadBlob(await renderPortalReceiptBlob(p, inv, customerName, fallbackAddress, business), `${receiptNumberFor(p.id)}.pdf`)
    } catch { /* transient render failure — button stays available to retry */ }
    setReceiptBusy(null)
  }
  const invById = new Map(invoices.map(i => [i.id, i]))
  // Receipts (money movements) vs the customer-credit ledger — kept apart so totals
  // and history stay honest.
  const receipts = payments.filter(p => p.kind !== 'credit')
  const totalPaid = receipts.reduce((s, p) => s + Number(p.amount || 0), 0)
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
            <p className="text-sm font-semibold text-accent break-all">{etransferEmail}</p>
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
            <p className="text-[11px] text-ink-faint mt-2">E-transfers are usually received within a few hours — your balance updates here once we accept it.</p>
          </div>
        </div>
        )}
        <div className="flex items-start gap-3 border-t border-border pt-3">
          <span aria-hidden><Banknote className="w-4 h-4" /></span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">Cash</p>
            <p className="text-xs text-ink-muted">Pay in person at your next visit — we&rsquo;ll record it and send your receipt.</p>
          </div>
        </div>
      </div>
      {paymentsEnabled && <AutoPayCard token={token} card={card} autopayEnabled={autopayEnabled} onChanged={onChanged} />}
      {availableCredit > 0 && (
        <div className="rounded-card border border-accent/25 bg-accent/[0.06] p-3.5 flex items-center justify-between gap-3">
          <p className="text-[10px] uppercase tracking-[0.14em] text-accent font-semibold flex items-center gap-1"><Wallet className="w-3 h-3" /> Available credit</p>
          <p className="text-lg font-bold text-accent tabular-nums">{formatCurrency(availableCredit)}</p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-card border border-emerald-500/20 bg-emerald-500/[0.06] p-3.5">
          <p className="text-[10px] uppercase tracking-[0.14em] text-emerald-400 font-semibold flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Total paid</p>
          <p className="text-lg font-bold text-ink mt-1 tabular-nums">{formatCurrency(totalPaid)}</p>
        </div>
        <div className="rounded-card border border-border bg-bg-secondary p-3.5">
          <p className="text-[10px] uppercase tracking-[0.14em] text-ink-faint font-semibold flex items-center gap-1"><Receipt className="w-3 h-3" /> Outstanding</p>
          <p className={cn('text-lg font-bold mt-1 tabular-nums', outstanding > 0 ? 'text-amber-400' : 'text-emerald-400')}>{formatCurrency(outstanding)}</p>
        </div>
      </div>

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
              <Button size="sm" variant="secondary" className="w-full sm:w-auto shrink-0"
                onClick={() => downloadReceipt(p, inv)} loading={receiptBusy === p.id}>
                <Download className="w-4 h-4" /> Download {Number(p.amount) < 0 ? 'refund ' : ''}receipt
              </Button>
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
  const exp = card?.exp_month && card?.exp_year ? `${String(card.exp_month).padStart(2, '0')}/${String(card.exp_year).slice(-2)}` : null
  const brand = card?.brand ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1) : 'Card'

  return (
    <div className="rounded-card border border-border bg-bg-secondary p-4">
      <p className="text-sm font-semibold text-ink flex items-center gap-1.5"><CreditCard className="w-4 h-4 text-accent" /> Payment method &amp; AutoPay</p>
      <p className="text-xs text-ink-muted mt-0.5 mb-3">Save a card to pay recurring invoices automatically. Your card is stored securely by Stripe — never by us.</p>
      {card ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-tertiary px-3 py-2.5">
          <span className="text-sm text-ink flex items-center gap-2 min-w-0">
            <CreditCard className="w-4 h-4 text-ink-muted shrink-0" />
            <span className="truncate">{brand} •••• {card.last4 || '????'}{exp ? ` · ${exp}` : ''}</span>
          </span>
          <div className="flex items-center gap-3 shrink-0">
            <button onClick={addCard} disabled={busy !== null} className="text-xs font-medium text-accent hover:underline disabled:opacity-50 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">Replace</button>
            <button onClick={removeCard} disabled={busy !== null} className="text-xs font-medium text-red-400/70 hover:text-red-400 disabled:opacity-50 flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"><Trash2 className="w-3.5 h-3.5" /> Remove</button>
          </div>
        </div>
      ) : (
        <Button className="w-full" onClick={addCard} disabled={busy !== null} loading={busy === 'card'}>
          <CreditCard className="w-4 h-4" /> Add a card
        </Button>
      )}
      <div className="flex items-center justify-between gap-3 mt-3 rounded-lg border border-border bg-bg-tertiary px-3 py-2.5">
        <span className="text-sm text-ink flex items-center gap-2"><Zap className="w-4 h-4 text-accent" /> AutoPay recurring invoices</span>
        <button onClick={toggle} disabled={!card && !autopay} aria-pressed={autopay} aria-label="AutoPay recurring invoices"
          className={cn('relative w-11 h-6 rounded-full transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50', autopay ? 'bg-accent' : 'bg-border-strong', (!card && !autopay) && 'opacity-40 cursor-not-allowed')}>
          <span className={cn('absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform', autopay && 'translate-x-5')} />
        </button>
      </div>
      {card && <p className="text-[11px] text-ink-faint mt-2 flex items-center gap-1"><ShieldCheck className="w-3 h-3 text-emerald-400" /> Secured by Stripe. You can remove your card or turn off AutoPay anytime.</p>}
      {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
    </div>
  )
}

// ── Request ──
function RequestTab({ presets, reqMsg, setReqMsg, request, reqBusy, reqSent, biz }: {
  presets: string[]; reqMsg: string; setReqMsg: (s: string) => void
  request: (msg: string, key: string) => void; reqBusy: string | null; reqSent: string | null; biz: PortalData['business']
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-card border border-border bg-bg-secondary p-4">
        <p className="text-sm font-semibold text-ink flex items-center gap-1.5"><Sparkles className="w-4 h-4 text-accent" /> Request a service</p>
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

      <div className="rounded-card border border-border bg-bg-secondary p-4">
        <p className="text-sm font-semibold text-ink mb-1">Something else?</p>
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

// ── Review ask (only after a completed visit, hidden once they've reviewed) ──
function ReviewCard({ reviewUrl, businessName, reviewed, onReviewed }: { reviewUrl: string; businessName: string | null; reviewed: boolean; onReviewed: () => void }) {
  const href = reviewUrl.startsWith('http') ? reviewUrl : `https://${reviewUrl}`
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
      <p className="text-xs text-ink-muted mt-0.5 mb-3">A quick review helps {businessName || 'your service provider'} a lot — thank you!</p>
      <div className="flex flex-wrap gap-2">
        <a href={href} target="_blank" rel="noopener noreferrer"
          className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-2 font-medium rounded-xl transition-all duration-150 bg-accent text-black hover:bg-accent-hover active:scale-[0.98] shadow-sm px-4 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
          <Star className="w-4 h-4" /> Leave a review
        </a>
        <Button variant="secondary" className="flex-1 min-w-[140px]" onClick={onReviewed}>
          <Check className="w-4 h-4" /> I’ve left my review
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
      <p className="text-sm font-semibold text-ink flex items-center gap-1.5"><MessageSquare className="w-4 h-4 text-accent" /> Message preferences</p>
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
    cancelled:{ label: 'Cancelled',      tone: 'text-ink-muted border-border bg-bg-tertiary' },
    draft:    { label: 'Draft',          tone: 'text-ink-muted border-border bg-bg-tertiary' },
  }
  const m = map[status] || { label: 'Due', tone: 'text-amber-400 border-amber-500/30 bg-amber-500/10' }
  return <span className={cn('text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border', m.tone)}>{m.label}</span>
}

function groupPhotos(photos: PortalPhoto[]): Map<string, PortalPhoto[]> {
  const m = new Map<string, PortalPhoto[]>()
  for (const p of photos) { const k = p.job_id || 'none'; if (!m.has(k)) m.set(k, []); m.get(k)!.push(p) }
  return m
}
