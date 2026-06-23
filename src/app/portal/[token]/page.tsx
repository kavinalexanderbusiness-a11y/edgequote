'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { recurrenceLabel } from '@/lib/recurrence'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import {
  Home, History, Image as ImageIcon, FileText, Receipt, MessageSquarePlus, Check, Loader2,
  Phone, Globe, Mail, Leaf, CheckCircle2, Navigation, Play, CalendarClock, Repeat, MapPin, Ruler, Sparkles, CreditCard,
} from 'lucide-react'

// ── Premium Customer Portal ─────────────────────────────────────────────────────
// Public, no-login, scoped to the token's customer via get_portal_data. A clean
// service-app experience: a Home overview, live job status, a per-visit timeline
// with photos & invoices, a before/after gallery, and quick service requests.

interface PortalQuote { id: string; quote_number: string; service_type: string; address: string; total: number; initial_price: number | null; weekly_price: number | null; biweekly_price: number | null; monthly_price: number | null; notes: string | null; status: string; created_at: string }
interface PortalInvoice { id: string; invoice_number: string; service_type: string | null; amount: number; status: string; issued_date: string | null; due_date: string | null; line_items: { description: string; amount: number; kind: string }[] | null; job_id: string | null; created_at: string }
interface PortalJob { id: string; recurrence_id: string | null; service_type: string | null; title: string; scheduled_date: string; status: string; on_my_way_at: string | null; started_at: string | null; completed_at: string | null; notes: string | null }
interface PortalRec { id: string; freq: string | null; interval_unit: string | null; interval_count: number | null; end_date: string | null }
interface PortalPhoto { id: string; job_id: string | null; storage_path: string; kind: string; caption: string | null; taken_at: string }
interface PortalData {
  customer: { id: string; name: string; email: string | null; phone: string | null; address: string | null; city: string | null }
  business: { company_name: string | null; owner_name: string | null; phone: string | null; email_primary: string | null; website: string | null; logo_url: string | null } | null
  property: { address: string | null; city: string | null; province: string | null; lawn_sqft: number | null; fence_length: number | null; neighborhood: string | null } | null
  quotes: PortalQuote[]; invoices: PortalInvoice[]; jobs: PortalJob[]; recurrences: PortalRec[]; photos: PortalPhoto[]
}

type Tab = 'home' | 'service' | 'photos' | 'quotes' | 'invoices' | 'request'
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

  async function load() {
    const { data: d } = await supabase.rpc('get_portal_data', { p_token: token })
    setData((d as PortalData | null) ?? null)
    setLoading(false)
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
    setPayingId(invoiceId)
    try {
      const res = await fetch('/api/portal/pay', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, invoiceId }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok && d.url) { window.location.href = d.url; return }
      // Public portal: show a FIXED message — never render a server-provided string.
      alert('Could not start payment. Please try again.')
    } catch {
      alert('Could not start payment. Please try again.')
    } finally { setPayingId(null) }
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
  const first = data.customer.name.split(' ')[0]
  const photosByJob = groupPhotos(data.photos)
  const invoiceByJob = new Map((data.invoices || []).filter(i => i.job_id).map(i => [i.job_id as string, i]))

  const TABS: { key: Tab; label: string; icon: typeof Home; n?: number }[] = [
    { key: 'home', label: 'Home', icon: Home },
    { key: 'service', label: 'Service', icon: History, n: derived.completed.length },
    { key: 'photos', label: 'Photos', icon: ImageIcon, n: data.photos.length },
    { key: 'quotes', label: 'Quotes', icon: FileText, n: data.quotes.length },
    { key: 'invoices', label: 'Invoices', icon: Receipt, n: data.invoices.length },
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
          {tab === 'home' && <HomeTab data={data} derived={derived} biz={biz} />}
          {tab === 'service' && <ServiceTab completed={derived.completed} photosByJob={photosByJob} invoiceByJob={invoiceByJob} photoUrl={photoUrl} />}
          {tab === 'photos' && <GalleryTab photosByJob={photosByJob} jobs={data.jobs} photoUrl={photoUrl} />}
          {tab === 'quotes' && <QuotesTab quotes={data.quotes} accept={accept} accepting={accepting} />}
          {tab === 'invoices' && <InvoicesTab invoices={data.invoices} paymentsEnabled={paymentsEnabled} pay={pay} payingId={payingId} />}
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
function HomeTab({ data, derived, biz }: { data: PortalData; derived: Derived; biz: PortalData['business'] }) {
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
          <p className="text-sm text-ink-muted">No upcoming visit scheduled. Tap <span className="font-medium text-ink">Request</span> to book one.</p>
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
function QuotesTab({ quotes, accept, accepting }: { quotes: PortalQuote[]; accept: (id: string) => void; accepting: string | null }) {
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
          {q.status === 'sent' && <div className="mt-3"><Button size="sm" onClick={() => accept(q.id)} loading={accepting === q.id}><Check className="w-4 h-4" /> Accept this quote</Button></div>}
          {q.status === 'accepted' && <p className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-400"><CheckCircle2 className="w-4 h-4" /> Accepted — thank you!</p>}
        </div>
      ))}
    </div>
  )
}

// ── Invoices ──
function InvoicesTab({ invoices, paymentsEnabled, pay, payingId }: {
  invoices: PortalInvoice[]; paymentsEnabled: boolean; pay: (id: string) => void; payingId: string | null
}) {
  if (invoices.length === 0) return <Empty text="No invoices yet." />
  return (
    <div className="space-y-3">
      {invoices.map(inv => {
        const owing = inv.status === 'unpaid' || inv.status === 'sent'
        return (
        <div key={inv.id} className="rounded-card border border-border bg-bg-secondary p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0"><p className="text-sm font-semibold text-ink">{inv.service_type || 'Services'}</p><p className="text-xs text-ink-muted">{inv.invoice_number} · {inv.issued_date ? formatDate(inv.issued_date) : formatDate(inv.created_at)}{inv.due_date ? ` · due ${formatDate(inv.due_date)}` : ''}</p></div>
            <div className="text-right"><p className="text-base font-bold text-ink">{formatCurrency(Number(inv.amount))}</p><InvoiceStatusPill status={inv.status} /></div>
          </div>
          {inv.line_items && inv.line_items.length > 1 && (
            <div className="mt-2 space-y-0.5">
              {inv.line_items.map((li, i) => <p key={i} className="text-xs flex justify-between gap-3"><span className="text-ink-faint">{li.description}</span><span className="text-ink-muted">{formatCurrency(Number(li.amount))}</span></p>)}
            </div>
          )}
          {paymentsEnabled && owing && (
            <div className="mt-3">
              <Button size="sm" onClick={() => pay(inv.id)} loading={payingId === inv.id}>
                <CreditCard className="w-4 h-4" /> Pay {formatCurrency(Number(inv.amount))}
              </Button>
            </div>
          )}
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
