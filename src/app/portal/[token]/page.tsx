'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { recurrenceLabel } from '@/lib/recurrence'
import { invoiceTotals } from '@/lib/invoiceTotals'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { renderPortalQuoteBlob, renderPortalInvoiceBlob, downloadBlob, viewBlob, printBlob } from '@/lib/portalPdf'
import {
  Home, History, Image as ImageIcon, FileText, Receipt, MessageSquarePlus, Check, Loader2,
  Phone, Globe, Mail, Leaf, CheckCircle2, Navigation, Play, CalendarClock, Repeat, MapPin, Ruler, Sparkles, CreditCard, MessageSquare,
  Eye, Download, Printer, FolderOpen, Search, ArrowUpDown, Activity, Wallet, Star,
} from 'lucide-react'

// ── Premium Customer Portal ─────────────────────────────────────────────────────
// Public, no-login, scoped to the token's customer via get_portal_data. A clean
// service-app experience: a Home overview, live job status, a per-visit timeline
// with photos & invoices, a before/after gallery, and quick service requests.

interface PortalQuote { id: string; quote_number: string; service_type: string; address: string; total: number; initial_price: number | null; subtotal: number | null; weekly_price: number | null; biweekly_price: number | null; monthly_price: number | null; notes: string | null; status: string; created_at: string; issued_date: string | null; crew_size: number | null; hours: number | null; travel_fee: number | null }
interface PortalInvoice { id: string; invoice_number: string; service_type: string | null; amount: number; status: string; issued_date: string | null; due_date: string | null; notes: string | null; address: string | null; line_items: { description: string; amount: number; kind: string }[] | null; job_id: string | null; created_at: string }
interface PortalJob { id: string; recurrence_id: string | null; service_type: string | null; title: string; scheduled_date: string; status: string; on_my_way_at: string | null; started_at: string | null; completed_at: string | null; notes: string | null }
interface PortalRec { id: string; freq: string | null; interval_unit: string | null; interval_count: number | null; end_date: string | null }
interface PortalPhoto { id: string; job_id: string | null; storage_path: string; kind: string; caption: string | null; taken_at: string }
interface PortalPayment { id: string; amount: number; status: string; paid_at: string | null; provider: string; invoice_id: string | null; created_at: string }
interface PortalData {
  customer: { id: string; name: string; email: string | null; phone: string | null; address: string | null; city: string | null; sms_opt_in?: boolean | null; email_opt_in?: boolean | null; reviewed_at?: string | null }
  business: { company_name: string | null; owner_name: string | null; phone: string | null; email_primary: string | null; email_secondary: string | null; website: string | null; logo_url: string | null; logo_scale: number | null; base_address: string | null; terms_text: string | null; review_url?: string | null; gst_percent?: number | null } | null
  property: { address: string | null; city: string | null; province: string | null; lawn_sqft: number | null; fence_length: number | null; neighborhood: string | null; notes: string | null } | null
  quotes: PortalQuote[]; invoices: PortalInvoice[]; jobs: PortalJob[]; recurrences: PortalRec[]; photos: PortalPhoto[]; payments: PortalPayment[]
}

type Tab = 'home' | 'timeline' | 'service' | 'photos' | 'property' | 'documents' | 'quotes' | 'invoices' | 'payments' | 'request'
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

export default function PortalPage() {
  const params = useParams()
  const token = String(params?.token || '')
  const supabase = useMemo(() => createClient(), [])
  const [data, setData] = useState<PortalData | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('home')
  const [accepting, setAccepting] = useState<string | null>(null)
  const [reqMsg, setReqMsg] = useState('')
  const [reqBusy, setReqBusy] = useState<string | null>(null)
  const [reqSent, setReqSent] = useState<string | null>(null)
  const [paymentsEnabled, setPaymentsEnabled] = useState(false)
  const [payingId, setPayingId] = useState<string | null>(null)
  const [justPaid, setJustPaid] = useState(false)
  const [consent, setConsentState] = useState<{ sms: boolean; email: boolean } | null>(null)
  const [markedReviewed, setMarkedReviewed] = useState(false)

  async function load() {
    const { data: d } = await supabase.rpc('get_portal_data', { p_token: token })
    // Defensive normalize: an OLDER get_portal_data — or a customer with no rows in a
    // section — can return null/undefined for a collection (Postgres json_agg is null,
    // not []). Coerce EVERY array so the portal can never white-screen on a missing
    // field, no matter how current the database's RPC is.
    const raw = (d ?? null) as Partial<PortalData> | null
    const pd: PortalData | null = raw ? {
      customer: raw.customer ?? { id: '', name: 'Customer', email: null, phone: null, address: null, city: null },
      business: raw.business ?? null,
      property: raw.property ?? null,
      quotes: Array.isArray(raw.quotes) ? raw.quotes : [],
      invoices: Array.isArray(raw.invoices) ? raw.invoices : [],
      jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
      recurrences: Array.isArray(raw.recurrences) ? raw.recurrences : [],
      photos: Array.isArray(raw.photos) ? raw.photos : [],
      payments: Array.isArray(raw.payments) ? raw.payments : [],
    } : null
    setData(pd)
    if (pd) setConsentState({ sms: !!pd.customer?.sms_opt_in, email: !!pd.customer?.email_opt_in })
    setLoading(false)
  }

  // Self-serve consent — updates the customer record immediately (token-scoped RPC).
  async function saveConsent(next: { sms: boolean; email: boolean }) {
    setConsentState(next)
    await supabase.rpc('portal_set_consent', { p_token: token, p_sms_opt_in: next.sms, p_email_opt_in: next.email })
  }

  // Customer confirms they left a review → records it (notifies the owner, stops
  // future review-request messages). Optimistic; token-scoped RPC.
  async function markReviewed() {
    if (markedReviewed) return                 // double-click guard (already confirmed)
    setMarkedReviewed(true)
    await supabase.rpc('portal_mark_reviewed', { p_token: token })
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Payments availability + return-from-Stripe. ?paid=1 → the webhook marks the
  // invoice paid a beat later, so refetch shortly after.
  useEffect(() => {
    fetch('/api/payments/status').then(r => r.json()).then(d => setPaymentsEnabled(!!d.enabled)).catch(() => {})
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('paid') === '1') {
      setJustPaid(true)
      window.history.replaceState({}, '', `/portal/${token}`)
      setTimeout(() => load(), 1500)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function photoUrl(path: string) { return supabase.storage.from('job-photos').getPublicUrl(path).data.publicUrl }

  async function accept(qid: string) {
    if (accepting) return                      // double-click guard
    setAccepting(qid)
    const { data: ok } = await supabase.rpc('portal_accept_quote', { p_token: token, p_quote_id: qid })
    if (ok) setData(d => d ? { ...d, quotes: d.quotes.map(q => q.id === qid ? { ...q, status: 'accepted' } : q) } : d)
    setAccepting(null)
  }
  async function request(message: string, key: string) {
    if (!message.trim()) return
    setReqBusy(key)
    const { data: ok } = await supabase.rpc('portal_request_service', { p_token: token, p_message: message.trim() })
    setReqBusy(null)
    if (ok) { setReqSent(key); if (key === 'custom') setReqMsg(''); setTimeout(() => setReqSent(null), 4000) }
  }
  async function pay(invoiceId: string) {
    if (payingId) return                       // re-entry guard — never start two checkout sessions
    setPayingId(invoiceId)
    try {
      const res = await fetch('/api/portal/pay', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, invoiceId }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok && d.url) { window.location.href = d.url; return }   // redirecting to Stripe — stay disabled
      // Public portal: show a FIXED message — never render a server-provided string.
      alert('Could not start payment. Please try again.')
    } catch {
      alert('Could not start payment. Please try again.')
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
    const outstanding = (data.invoices || []).filter(i => i.status === 'unpaid' || i.status === 'sent').reduce((s, i) => s + Number(i.amount || 0), 0)
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

  if (loading) return <div className="min-h-screen flex items-center justify-center text-ink-muted"><Loader2 className="w-5 h-5 animate-spin" /></div>
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

  const TABS: { key: Tab; label: string; icon: typeof Home; n?: number }[] = [
    { key: 'home', label: 'Home', icon: Home },
    { key: 'timeline', label: 'Timeline', icon: Activity },
    { key: 'service', label: 'Service', icon: History, n: derived.completed.length },
    { key: 'photos', label: 'Photos', icon: ImageIcon, n: data.photos.length },
    { key: 'property', label: 'Property', icon: MapPin },
    { key: 'documents', label: 'Documents', icon: FolderOpen, n: data.quotes.length + data.invoices.length },
    { key: 'quotes', label: 'Quotes', icon: FileText, n: data.quotes.length },
    { key: 'invoices', label: 'Invoices', icon: Receipt, n: data.invoices.length },
    { key: 'payments', label: 'Payments', icon: Wallet, n: data.payments.length },
    { key: 'request', label: 'Request', icon: MessageSquarePlus },
  ]

  return (
    <div className="min-h-screen bg-bg">
      <div className="max-w-lg mx-auto px-4 py-5 pb-28">
        {/* Brand header */}
        <div className="flex items-center gap-3 mb-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {biz?.logo_url ? <img src={biz.logo_url} alt="" className="h-10 w-auto object-contain" /> : <div className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center"><Leaf className="w-5 h-5 text-accent" /></div>}
          <div className="min-w-0">
            <p className="text-base font-bold text-ink truncate">{biz?.company_name || 'Your Service Provider'}</p>
            <p className="text-xs text-ink-muted">Welcome back, {first}</p>
          </div>
        </div>

        {/* Sticky tab bar */}
        <div className="sticky top-0 z-10 -mx-4 px-4 py-2 bg-bg/90 backdrop-blur border-b border-border">
          <div className="flex gap-1.5 overflow-x-auto">
            {TABS.map(t => (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={cn('shrink-0 flex items-center gap-1.5 text-xs font-medium rounded-full px-3 py-2 border transition-colors',
                  tab === t.key ? 'bg-accent text-black border-accent' : 'border-border text-ink-muted hover:text-ink')}>
                <t.icon className="w-3.5 h-3.5" /> {t.label}{t.n != null && t.n > 0 && <span className="opacity-70">{t.n}</span>}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          {justPaid && (
            <div className="mb-3 rounded-card border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 text-sm font-medium px-4 py-3 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> Payment received — thank you! Your invoice will update shortly.
            </div>
          )}
          {tab === 'home' && <HomeTab data={data} derived={derived} biz={biz} onRequest={() => setTab('request')} />}
          {tab === 'home' && biz?.review_url && derived.lastCompleted && !data.customer.reviewed_at && (
            <ReviewCard reviewUrl={biz.review_url} businessName={biz.company_name} reviewed={markedReviewed} onReviewed={markReviewed} />
          )}
          {tab === 'home' && consent && <ConsentCard consent={consent} onSave={saveConsent} />}
          {tab === 'timeline' && <TimelineTab data={data} photosByJob={photosByJob} />}
          {tab === 'service' && <ServiceTab completed={derived.completed} photosByJob={photosByJob} invoiceByJob={invoiceByJob} photoUrl={photoUrl} />}
          {tab === 'photos' && <GalleryTab photosByJob={photosByJob} jobs={data.jobs} photoUrl={photoUrl} />}
          {tab === 'property' && <PropertyTab property={data.property} />}
          {tab === 'payments' && <PaymentsTab payments={data.payments} invoices={data.invoices} outstanding={derived.outstanding} />}
          {tab === 'documents' && <DocumentsTab quotes={data.quotes} invoices={data.invoices} customerName={data.customer.name} fallbackAddress={data.property?.address || data.customer.address || null} business={biz} />}
          {tab === 'quotes' && <QuotesTab quotes={data.quotes} accept={accept} accepting={accepting} customerName={data.customer.name} business={biz} />}
          {tab === 'invoices' && <InvoicesTab invoices={data.invoices} paymentsEnabled={paymentsEnabled} pay={pay} payingId={payingId} gstPercent={Number(data.business?.gst_percent) || 0} customerName={data.customer.name} fallbackAddress={data.property?.address || data.customer.address || null} business={biz} />}
          {tab === 'request' && (
            <RequestTab presets={REQUEST_PRESETS} reqMsg={reqMsg} setReqMsg={setReqMsg} request={request} reqBusy={reqBusy} reqSent={reqSent} biz={biz} />
          )}
        </div>

        <p className="text-center text-[10px] text-ink-faint mt-10">Powered by EdgeQuote</p>
      </div>
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
  return <span className={cn('inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border', m.tone)}><m.icon className="w-3 h-3" /> {m.label}</span>
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
function HomeTab({ data, derived, biz, onRequest }: { data: PortalData; derived: Derived; biz: PortalData['business']; onRequest: () => void }) {
  const next = derived.nextService
  return (
    <div className="space-y-3">
      {/* Next service hero */}
      <div className="rounded-card border border-accent/20 bg-gradient-to-br from-accent/[0.08] to-transparent p-4">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-accent mb-1">Next service</p>
        {next ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="text-lg font-bold text-ink">{next.service_type || next.title}</p>
              <StatusPill s={liveStatusOf(next)} />
            </div>
            <p className="text-sm text-ink-muted mt-0.5">{formatDate(next.scheduled_date)}</p>
            <StatusStepper s={liveStatusOf(next)} />
            {liveStatusOf(next) === 'on_my_way' && <p className="text-xs text-sky-400 mt-2 flex items-center gap-1"><Navigation className="w-3.5 h-3.5" /> Your provider is on the way!</p>}
          </>
        ) : (
          <div>
            <p className="text-sm text-ink-muted mb-3">No upcoming visit scheduled.</p>
            <Button onClick={onRequest} className="w-full sm:w-auto">
              <MessageSquarePlus className="w-4 h-4" /> Request Service
            </Button>
          </div>
        )}
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Outstanding balance" value={formatCurrency(derived.outstanding)} tone={derived.outstanding > 0 ? 'text-amber-400' : 'text-emerald-400'} icon={Receipt} />
        <StatCard label="Last completed" value={derived.lastCompleted ? formatDate(derived.lastCompleted.scheduled_date) : '—'} icon={CheckCircle2} />
      </div>

      {/* Active plan */}
      {derived.plans.length > 0 && (
        <div className="rounded-card border border-border bg-bg-secondary p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-2">Active plan{derived.plans.length !== 1 ? 's' : ''}</p>
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
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-2">Your property</p>
          {data.property.address && <p className="text-sm text-ink flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5 text-ink-faint" /> {data.property.address}{data.property.city ? `, ${data.property.city}` : ''}</p>}
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-xs text-ink-muted">
            {data.property.neighborhood && <span>{data.property.neighborhood}</span>}
            {data.property.lawn_sqft ? <span className="flex items-center gap-1"><Ruler className="w-3 h-3" /> {Number(data.property.lawn_sqft).toLocaleString()} ft² lawn</span> : null}
            {data.property.fence_length ? <span>{data.property.fence_length} ft fence</span> : null}
          </div>
        </div>
      )}

      {/* Contact */}
      {biz && (biz.phone || biz.email_primary) && (
        <div className="flex flex-wrap gap-2">
          {biz.phone && <a href={`tel:${biz.phone}`} className="flex-1 min-w-[120px] flex items-center justify-center gap-1.5 text-sm font-medium rounded-xl border border-border bg-bg-secondary py-2.5 text-ink hover:border-border-strong"><Phone className="w-4 h-4 text-accent" /> Call</a>}
          {biz.email_primary && <a href={`mailto:${biz.email_primary}`} className="flex-1 min-w-[120px] flex items-center justify-center gap-1.5 text-sm font-medium rounded-xl border border-border bg-bg-secondary py-2.5 text-ink hover:border-border-strong"><Mail className="w-4 h-4 text-accent" /> Email</a>}
          {biz.website && <a href={biz.website.startsWith('http') ? biz.website : `https://${biz.website}`} target="_blank" rel="noopener noreferrer" className="flex-1 min-w-[120px] flex items-center justify-center gap-1.5 text-sm font-medium rounded-xl border border-border bg-bg-secondary py-2.5 text-ink hover:border-border-strong"><Globe className="w-4 h-4 text-accent" /> Website</a>}
        </div>
      )}
    </div>
  )
}
function StatCard({ label, value, tone, icon: Icon }: { label: string; value: string; tone?: string; icon: typeof Receipt }) {
  return (
    <div className="rounded-card border border-border bg-bg-secondary p-3.5">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint flex items-center gap-1"><Icon className="w-3 h-3" /> {label}</p>
      <p className={cn('text-lg font-bold mt-1', tone || 'text-ink')}>{value}</p>
    </div>
  )
}

// ── Service timeline (grouped by visit) ──
function ServiceTab({ completed, photosByJob, invoiceByJob, photoUrl }: { completed: PortalJob[]; photosByJob: Map<string, PortalPhoto[]>; invoiceByJob: Map<string, PortalInvoice>; photoUrl: (p: string) => string }) {
  if (completed.length === 0) return <Empty text="No completed visits yet." />
  return (
    <div className="space-y-3">
      {completed.map(j => {
        const photos = photosByJob.get(j.id) || []
        const inv = invoiceByJob.get(j.id)
        return (
          <div key={j.id} className="rounded-card border border-border bg-bg-secondary p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-ink flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4 text-emerald-400" /> {j.service_type || j.title}</p>
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
                <span className="flex items-center gap-2"><span className="font-semibold text-ink">{formatCurrency(Number(inv.amount))}</span><InvoiceStatusPill status={inv.status} /></span>
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
  if (groups.length === 0) return <Empty text="No photos yet — your before & after shots will appear here." />
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
            <p className="text-sm font-semibold text-ink">{j?.service_type || j?.title || 'Visit'}</p>
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

// ── Quotes ──
function QuotesTab({ quotes, accept, accepting, customerName, business }: { quotes: PortalQuote[]; accept: (id: string) => void; accepting: string | null; customerName: string; business: PortalData['business'] }) {
  if (quotes.length === 0) return <Empty text="No quotes yet." />
  return (
    <div className="space-y-3">
      {quotes.map(q => (
        <div key={q.id} className="rounded-card border border-border bg-bg-secondary p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0"><p className="text-sm font-semibold text-ink">{q.service_type}</p><p className="text-xs text-ink-muted">{q.quote_number} · {formatDate(q.created_at)}</p></div>
            <QuoteStatusPill status={q.status} />
          </div>
          <div className="flex flex-wrap gap-2 mt-2">
            {q.weekly_price ? <PriceChip label="Weekly" v={q.weekly_price} /> : null}
            {q.biweekly_price ? <PriceChip label="Bi-weekly" v={q.biweekly_price} /> : null}
            {q.monthly_price ? <PriceChip label="Monthly" v={q.monthly_price} /> : null}
            {!q.weekly_price && !q.biweekly_price && !q.monthly_price ? <PriceChip label="Total" v={q.total} /> : null}
          </div>
          {q.notes && <p className="text-xs text-ink-muted mt-2 whitespace-pre-wrap">{q.notes}</p>}
          <DocActions filename={`${q.quote_number}.pdf`} getBlob={() => renderPortalQuoteBlob(q, customerName, business)} />
          {q.status === 'sent' && <div className="mt-3"><Button size="sm" onClick={() => accept(q.id)} loading={accepting === q.id}><Check className="w-4 h-4" /> Accept this quote</Button></div>}
          {q.status === 'accepted' && <p className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-400"><CheckCircle2 className="w-4 h-4" /> Accepted — thank you!</p>}
        </div>
      ))}
    </div>
  )
}

// ── Invoices ──
function InvoicesTab({ invoices, paymentsEnabled, pay, payingId, gstPercent, customerName, fallbackAddress, business }: {
  invoices: PortalInvoice[]; paymentsEnabled: boolean; pay: (id: string) => void; payingId: string | null; gstPercent: number
  customerName: string; fallbackAddress: string | null; business: PortalData['business']
}) {
  if (invoices.length === 0) return <Empty text="No invoices yet." />
  return (
    <div className="space-y-3">
      {invoices.map(inv => {
        const owing = inv.status === 'unpaid' || inv.status === 'sent'
        const t = invoiceTotals(inv.amount, { gst_percent: gstPercent })
        return (
        <div key={inv.id} className="rounded-card border border-border bg-bg-secondary p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0"><p className="text-sm font-semibold text-ink">{inv.service_type || 'Services'}</p><p className="text-xs text-ink-muted">{inv.invoice_number} · {inv.issued_date ? formatDate(inv.issued_date) : formatDate(inv.created_at)}{inv.due_date ? ` · due ${formatDate(inv.due_date)}` : ''}</p></div>
            <div className="text-right"><p className="text-base font-bold text-ink">{formatCurrency(t.total)}</p><InvoiceStatusPill status={inv.status} /></div>
          </div>
          {inv.line_items && inv.line_items.length > 1 && (
            <div className="mt-2 space-y-0.5">
              {inv.line_items.map((li, i) => <p key={i} className="text-xs flex justify-between gap-3"><span className="text-ink-faint">{li.description}</span><span className="text-ink-muted">{formatCurrency(Number(li.amount))}</span></p>)}
            </div>
          )}
          {t.hasGst && (
            <div className="mt-2 space-y-0.5 text-xs border-t border-border pt-2">
              <p className="flex justify-between gap-3"><span className="text-ink-faint">Subtotal</span><span className="text-ink-muted">{formatCurrency(t.subtotal)}</span></p>
              <p className="flex justify-between gap-3"><span className="text-ink-faint">GST ({t.gstPercent}%)</span><span className="text-ink-muted">{formatCurrency(t.gstAmount)}</span></p>
              <p className="flex justify-between gap-3 font-semibold"><span className="text-ink">Total</span><span className="text-ink">{formatCurrency(t.total)}</span></p>
            </div>
          )}
          <DocActions filename={`${inv.invoice_number}.pdf`} getBlob={() => renderPortalInvoiceBlob(inv, customerName, fallbackAddress, business)} />
          {paymentsEnabled && owing && (
            <div className="mt-3">
              <Button size="sm" onClick={() => pay(inv.id)} loading={payingId === inv.id}>
                <CreditCard className="w-4 h-4" /> Pay {formatCurrency(t.total)}
              </Button>
            </div>
          )}
        </div>
        )
      })}
    </div>
  )
}

// ── Documents (central home for all customer records) ──────────────────────
type DocKind = 'quote' | 'invoice'
interface DocItem { id: string; kind: DocKind; number: string; title: string; date: string; status: string; amount: number; filename: string; getBlob: () => Promise<Blob> }
const KIND_META: Record<DocKind, { label: string; icon: typeof FileText; tone: string }> = {
  quote: { label: 'Quote', icon: FileText, tone: 'text-accent border-accent/25 bg-accent/10' },
  invoice: { label: 'Invoice', icon: Receipt, tone: 'text-sky-400 border-sky-500/25 bg-sky-500/10' },
}
const FUTURE_DOCS = ['Receipts', 'Service reports', 'Photos']

function DocumentsTab({ quotes, invoices, customerName, fallbackAddress, business }: {
  quotes: PortalQuote[]; invoices: PortalInvoice[]; customerName: string; fallbackAddress: string | null; business: PortalData['business']
}) {
  const [cat, setCat] = useState<'all' | DocKind>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest')

  const docs = useMemo<DocItem[]>(() => {
    const q: DocItem[] = quotes.map(qq => ({
      id: 'q' + qq.id, kind: 'quote', number: qq.quote_number, title: qq.service_type || 'Quote',
      date: qq.issued_date || qq.created_at, status: qq.status, amount: Number(qq.total) || 0,
      filename: `${qq.quote_number}.pdf`, getBlob: () => renderPortalQuoteBlob(qq, customerName, business),
    }))
    const inv: DocItem[] = invoices.map(ii => ({
      id: 'i' + ii.id, kind: 'invoice', number: ii.invoice_number, title: ii.service_type || 'Invoice',
      date: ii.issued_date || ii.created_at, status: ii.status, amount: Number(ii.amount) || 0,
      filename: `${ii.invoice_number}.pdf`, getBlob: () => renderPortalInvoiceBlob(ii, customerName, fallbackAddress, business),
    }))
    return [...q, ...inv]
  }, [quotes, invoices, customerName, fallbackAddress, business])

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
            className={cn('text-xs font-medium rounded-full px-3 py-1.5 border transition-colors',
              cat === c.key ? 'bg-accent text-black border-accent' : 'border-border text-ink-muted hover:text-ink')}>
            {c.label}{c.n > 0 && <span className="opacity-70"> {c.n}</span>}
          </button>
        ))}
        {FUTURE_DOCS.map(f => (
          <span key={f} className="text-xs font-medium rounded-full px-3 py-1.5 border border-dashed border-border text-ink-faint inline-flex items-center gap-1">
            {f} <span className="text-[9px] uppercase tracking-wide opacity-80">Soon</span>
          </span>
        ))}
      </div>

      {/* Search + sort */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search documents…"
            className="w-full h-10 pl-9 pr-3 rounded-xl bg-bg-tertiary border border-border text-sm text-ink outline-none focus:border-accent" />
        </div>
        <button type="button" onClick={() => setSort(s => s === 'newest' ? 'oldest' : 'newest')}
          className="h-10 px-3 rounded-xl border border-border bg-bg-tertiary text-sm font-medium text-ink flex items-center gap-1.5 shrink-0 hover:border-border-strong">
          <ArrowUpDown className="w-4 h-4 text-ink-muted" /> {sort === 'newest' ? 'Newest' : 'Oldest'}
        </button>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <Empty text={docs.length === 0 ? 'No documents yet. Your quotes and invoices will appear here.' : 'No documents match your search.'} />
      ) : (
        <div className="space-y-3">{filtered.map(d => <DocRow key={d.id} d={d} />)}</div>
      )}
    </div>
  )
}
function DocRow({ d }: { d: DocItem }) {
  const m = KIND_META[d.kind]
  return (
    <div className="rounded-card border border-border bg-bg-secondary p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-3 min-w-0">
          <div className={cn('w-9 h-9 rounded-lg border flex items-center justify-center shrink-0', m.tone)}><m.icon className="w-4 h-4" /></div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink truncate">{d.title}</p>
            <p className="text-xs text-ink-muted">{m.label} · {d.number} · {formatDate(d.date)}</p>
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-bold text-ink">{formatCurrency(d.amount)}</p>
          {d.kind === 'quote' ? <QuoteStatusPill status={d.status} /> : <InvoiceStatusPill status={d.status} />}
        </div>
      </div>
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
    for (const i of data.invoices) ev.push({ id: 'i' + i.id, at: i.issued_date || i.created_at, icon: Receipt, tone: 'text-ink-muted border-border bg-bg-tertiary', title: `Invoice ${i.invoice_number}`, sub: formatCurrency(Number(i.amount)) })
    for (const p of data.payments) ev.push({ id: 'p' + p.id, at: p.paid_at || p.created_at, icon: CreditCard, tone: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10', title: 'Payment received', sub: formatCurrency(Number(p.amount)) })
    for (const [jid, ps] of photosByJob) { if (jid !== 'none' && ps.length) ev.push({ id: 'ph' + jid, at: ps[0]?.taken_at || '', icon: ImageIcon, tone: 'text-violet-400 border-violet-500/30 bg-violet-500/10', title: `${ps.length} photo${ps.length === 1 ? '' : 's'} added`, sub: null }) }
    return ev.filter(e => e.at).sort((a, b) => b.at.localeCompare(a.at))
  }, [data, photosByJob])

  if (events.length === 0) return <Empty text="No activity yet — your quotes, visits, and payments will appear here." />
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
    return <Empty text="No property details on file yet." />
  }
  return (
    <div className="space-y-3">
      <div className="rounded-card border border-border bg-bg-secondary p-4">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-2">Your property</p>
        {property.address && (
          <p className="text-sm text-ink flex items-start gap-1.5"><MapPin className="w-4 h-4 text-ink-faint shrink-0 mt-0.5" /> <span>{property.address}{property.city ? `, ${property.city}` : ''}{property.province ? `, ${property.province}` : ''}</span></p>
        )}
        <div className="grid grid-cols-2 gap-3 mt-3">
          {property.lawn_sqft ? <StatCard label="Lawn size" value={`${Number(property.lawn_sqft).toLocaleString()} ft²`} icon={Ruler} /> : null}
          {property.fence_length ? <StatCard label="Fence length" value={`${Number(property.fence_length).toLocaleString()} ft`} icon={Ruler} /> : null}
          {property.neighborhood ? <StatCard label="Neighborhood" value={property.neighborhood} icon={MapPin} /> : null}
        </div>
      </div>
      {property.notes && (
        <div className="rounded-card border border-border bg-bg-secondary p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-1.5">Notes from your provider</p>
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
    case 'cheque': return 'Cheque'
    default: return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'Payment'
  }
}
function PaymentsTab({ payments, invoices, outstanding }: { payments: PortalPayment[]; invoices: PortalInvoice[]; outstanding: number }) {
  const invById = new Map(invoices.map(i => [i.id, i]))
  const totalPaid = payments.reduce((s, p) => s + Number(p.amount || 0), 0)
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-card border border-emerald-500/20 bg-emerald-500/[0.06] p-3.5">
          <p className="text-[10px] uppercase tracking-wide text-emerald-400 font-semibold flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Total paid</p>
          <p className="text-lg font-bold text-ink mt-1">{formatCurrency(totalPaid)}</p>
        </div>
        <div className="rounded-card border border-border bg-bg-secondary p-3.5">
          <p className="text-[10px] uppercase tracking-wide text-ink-faint font-semibold flex items-center gap-1"><Receipt className="w-3 h-3" /> Outstanding</p>
          <p className={cn('text-lg font-bold mt-1', outstanding > 0 ? 'text-amber-400' : 'text-emerald-400')}>{formatCurrency(outstanding)}</p>
        </div>
      </div>
      {payments.length === 0 ? (
        <Empty text="No payments yet. Your paid invoices will appear here." />
      ) : payments.map(p => {
        const inv = p.invoice_id ? invById.get(p.invoice_id) : null
        return (
          <div key={p.id} className="rounded-card border border-border bg-bg-secondary p-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-lg border border-emerald-500/25 bg-emerald-500/10 flex items-center justify-center shrink-0"><CheckCircle2 className="w-4 h-4 text-emerald-400" /></div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">{formatCurrency(Number(p.amount))}</p>
                <p className="text-xs text-ink-muted truncate">{p.paid_at ? formatDate(p.paid_at) : formatDate(p.created_at)}{inv ? ` · ${inv.invoice_number}` : ''} · {paymentMethodLabel(p.provider)}</p>
              </div>
            </div>
            <span className="text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border text-emerald-400 border-emerald-500/30 bg-emerald-500/10 shrink-0">Paid</span>
          </div>
        )
      })}
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
                className={cn('h-11 rounded-xl border text-sm font-medium flex items-center justify-center gap-1.5 transition-colors disabled:opacity-60',
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
          <>
            <textarea value={reqMsg} onChange={e => setReqMsg(e.target.value)} rows={3} placeholder="e.g. Can you add a fall cleanup this month?"
              className="w-full bg-bg-tertiary border border-border-strong rounded-lg px-3 py-2 text-sm text-ink outline-none focus:border-accent" />
            <div className="mt-2"><Button size="sm" onClick={() => request(reqMsg, 'custom')} loading={reqBusy === 'custom'} disabled={!reqMsg.trim()}>Send request</Button></div>
          </>
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
      <p className="text-xs text-ink-muted mt-0.5 mb-3">A quick Google review helps {businessName || 'us'} a lot — thank you!</p>
      <div className="flex flex-wrap gap-2">
        <a href={href} target="_blank" rel="noopener noreferrer"
          className="flex-1 min-w-[140px] h-10 rounded-xl bg-accent text-black text-sm font-semibold flex items-center justify-center gap-1.5">
          <Star className="w-4 h-4" /> Leave a review
        </a>
        <button onClick={onReviewed}
          className="flex-1 min-w-[140px] h-10 rounded-xl border border-border bg-bg-tertiary text-sm font-medium text-ink flex items-center justify-center gap-1.5">
          <Check className="w-4 h-4" /> I’ve left my review
        </button>
      </div>
    </div>
  )
}

// ── Message preferences (self-serve consent) ──
function ConsentCard({ consent, onSave }: { consent: { sms: boolean; email: boolean }; onSave: (c: { sms: boolean; email: boolean }) => void }) {
  return (
    <div className="rounded-card border border-border bg-bg-secondary p-4 mt-3">
      <p className="text-sm font-semibold text-ink flex items-center gap-1.5"><MessageSquare className="w-4 h-4 text-accent" /> Message preferences</p>
      <p className="text-xs text-ink-muted mt-0.5 mb-3">Choose how we can reach you — you can change this anytime. Message &amp; data rates may apply to texts.</p>
      <div className="space-y-2">
        <PrefRow label="Text messages (SMS)" icon={MessageSquare} on={consent.sms} onChange={v => onSave({ ...consent, sms: v })} />
        <PrefRow label="Email" icon={Mail} on={consent.email} onChange={v => onSave({ ...consent, email: v })} />
      </div>
    </div>
  )
}
function PrefRow({ label, icon: Icon, on, onChange }: { label: string; icon: typeof Mail; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-tertiary px-3 py-2.5">
      <span className="text-sm text-ink flex items-center gap-2"><Icon className="w-4 h-4 text-ink-muted" /> {label}</span>
      <button onClick={() => onChange(!on)} aria-pressed={on}
        className={cn('relative w-11 h-6 rounded-full transition-colors shrink-0', on ? 'bg-emerald-500' : 'bg-border-strong')}>
        <span className={cn('absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform', on && 'translate-x-5')} />
      </button>
    </div>
  )
}

// ── Document actions (View / Download / Print) — same PDF the dashboard makes ──
function DocActions({ getBlob, filename }: { getBlob: () => Promise<Blob>; filename: string }) {
  const [busy, setBusy] = useState<'view' | 'download' | 'print' | null>(null)
  async function run(kind: 'view' | 'download' | 'print') {
    if (busy) return
    setBusy(kind)
    try {
      const blob = await getBlob()
      if (kind === 'download') downloadBlob(blob, filename)
      else if (kind === 'print') printBlob(blob)
      else viewBlob(blob)
    } catch {
      alert('Could not generate the PDF. Please try again.')
    } finally { setBusy(null) }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-border">
      <DocBtn icon={Eye} label="View" loading={busy === 'view'} disabled={busy !== null} onClick={() => run('view')} />
      <DocBtn icon={Download} label="Download PDF" loading={busy === 'download'} disabled={busy !== null} onClick={() => run('download')} primary />
      <DocBtn icon={Printer} label="Print" loading={busy === 'print'} disabled={busy !== null} onClick={() => run('print')} />
    </div>
  )
}
function DocBtn({ icon: Icon, label, loading, disabled, onClick, primary }: { icon: typeof Eye; label: string; loading?: boolean; disabled?: boolean; onClick: () => void; primary?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} type="button"
      className={cn('flex-1 min-w-[92px] h-10 rounded-xl border text-sm font-semibold flex items-center justify-center gap-1.5 transition-colors disabled:opacity-60',
        primary ? 'border-accent/40 bg-accent/10 text-accent hover:bg-accent/15' : 'border-border bg-bg-tertiary text-ink hover:border-border-strong')}>
      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Icon className="w-4 h-4" />} {label}
    </button>
  )
}

// ── shared bits ──
function Empty({ text }: { text: string }) { return <p className="text-center text-sm text-ink-muted py-12">{text}</p> }
function PriceChip({ label, v }: { label: string; v: number }) {
  return <span className="text-xs rounded-lg border border-border bg-bg-tertiary px-2 py-1"><span className="text-ink-faint">{label}</span> <span className="font-semibold text-ink">{formatCurrency(Number(v))}</span></span>
}
function QuoteStatusPill({ status }: { status: string }) {
  const tone = status === 'accepted' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : status === 'declined' ? 'text-red-400 border-red-500/30 bg-red-500/10' : 'text-amber-400 border-amber-500/30 bg-amber-500/10'
  return <span className={cn('text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border', tone)}>{status}</span>
}
function InvoiceStatusPill({ status }: { status: string }) {
  const tone = status === 'paid' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : 'text-amber-400 border-amber-500/30 bg-amber-500/10'
  return <span className={cn('text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border', tone)}>{status}</span>
}

function groupPhotos(photos: PortalPhoto[]): Map<string, PortalPhoto[]> {
  const m = new Map<string, PortalPhoto[]>()
  for (const p of photos) { const k = p.job_id || 'none'; if (!m.has(k)) m.set(k, []); m.get(k)!.push(p) }
  return m
}
