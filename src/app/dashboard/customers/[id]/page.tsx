'use client'
import { toast } from '@/lib/toast'
import { confirm as confirmDialog } from '@/lib/confirm'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { queueOrRun } from '@/lib/offline/outbox'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { readCache, writeCache, CACHE_TTL } from '@/lib/clientCache'
import { custCacheKey, type CustomerPrefetch } from '@/lib/prefetch'
import { Customer, Property, Quote, Job, Invoice, JobRecurrence } from '@/types'
import { WebsiteLead } from '@/lib/leads'
import { LeadSummary } from '@/components/leads/LeadSummary'
import { JobPhotos } from '@/components/photos/JobPhotos'
import { bookingPhotosFromQuotes } from '@/lib/bookingPhotos'
import { needsFollowUp, daysSince } from '@/lib/followup'
import { recurrenceLabel, recurringCustomerLabel, buildServicePlans, ServicePlan } from '@/lib/recurrence'
import { jobVisitValue, effectiveFreq } from '@/lib/invoicing'
import { settingsToSeasons, DEFAULT_SEASONS, ServiceSeasons } from '@/lib/seasons'
import { resolvePrefs, prefSummary, hasAnyPref } from '@/lib/preferences'
import { SchedulePrefsFields, PrefsDraft, EMPTY_DRAFT, toDraft, draftToRow } from '@/components/customers/SchedulePrefsFields'
import { SendMessageDialog } from '@/components/comms/SendMessageDialog'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Textarea'
import { SkeletonTiles, SkeletonRows } from '@/components/ui/Skeleton'
import { formatCurrency, formatDate, getInitials } from '@/lib/utils'
import { ensurePortalToken, portalUrl } from '@/lib/portal'
import { CustomerComms } from '@/components/customers/CustomerComms'
import { CommsHealth } from '@/components/customers/CommsHealth'
import { ReviewLifecycle } from '@/components/customers/ReviewLifecycle'
import { ReferralPanel } from '@/components/customers/ReferralPanel'
import { ConversationThread } from '@/components/messages/ConversationThread'
import { PaymentMethodCard } from '@/components/payments/PaymentMethodCard'
import {
  ArrowLeft, Phone, MessageSquare, FilePlus, CalendarPlus, Mail, MapPin, Repeat,
  FileText, Send, RotateCw, CheckCircle2, Wrench, Receipt, DollarSign, Sparkles, Users,
  Edit2, ExternalLink, Ruler, AlertTriangle, StickyNote, Wallet, Timer, CalendarClock,
  Link2, Check, Cake, PartyPopper, Camera,
} from 'lucide-react'

const WON = new Set(['accepted', 'scheduled', 'completed', 'paid'])
const OPEN_INVOICE = new Set(['unpaid', 'sent', 'partial'])

function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
// Month + day from a 'YYYY-MM-DD' string (no timezone drift) — e.g. "Jun 25".
function mdLabel(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null
  const p = String(dateStr).slice(0, 10).split('-')
  const m = Number(p[1]), d = Number(p[2])
  if (!m || !d) return null
  return `${MONTHS[m - 1]} ${d}`
}

interface TimelineEvent {
  at: string
  kind: 'quote_created' | 'quote_sent' | 'followup' | 'quote_accepted' | 'job_scheduled' | 'job_completed' | 'invoice_created' | 'invoice_paid' | 'message_in' | 'message_out' | 'payment' | 'portal_request'
  title: string
  sub?: string
  href?: string
}

const EVENT_META: Record<TimelineEvent['kind'], { icon: typeof FileText; color: string }> = {
  quote_created:   { icon: FileText,     color: 'text-ink-muted bg-surface border-border' },
  quote_sent:      { icon: Send,         color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
  followup:        { icon: RotateCw,     color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  quote_accepted:  { icon: CheckCircle2, color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  job_scheduled:   { icon: CalendarPlus, color: 'text-accent bg-accent/10 border-accent/20' },
  job_completed:   { icon: Wrench,       color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  invoice_created: { icon: Receipt,      color: 'text-ink-muted bg-surface border-border' },
  invoice_paid:    { icon: DollarSign,   color: 'text-accent bg-accent/10 border-accent/20' },
  message_in:      { icon: MessageSquare,color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
  message_out:     { icon: Send,         color: 'text-ink-muted bg-surface border-border' },
  payment:         { icon: DollarSign,   color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  portal_request:  { icon: StickyNote,   color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
}

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [tick, setTick] = useState(0)   // bump to re-run load() (used by realtime)

  const [customer, setCustomer] = useState<Customer | null>(null)
  const [referrer, setReferrer] = useState<{ id: string; name: string } | null>(null)
  const [referredRevenue, setReferredRevenue] = useState(0)
  const [properties, setProperties] = useState<Property[]>([])
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [recurrences, setRecurrences] = useState<JobRecurrence[]>([])
  const [lead, setLead] = useState<WebsiteLead | null>(null)
  const [extraTimeline, setExtraTimeline] = useState<TimelineEvent[]>([])
  const [seasons, setSeasons] = useState<ServiceSeasons>(DEFAULT_SEASONS)
  const [gstPercent, setGstPercent] = useState(0)
  const [pausing, setPausing] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [portalBusy, setPortalBusy] = useState(false)
  const [portalCopied, setPortalCopied] = useState(false)
  const [showMessage, setShowMessage] = useState(false)

  async function copyPortalLink() {
    if (!customer) return
    setPortalBusy(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const token = await ensurePortalToken(supabase, user.id, customer.id)
      if (!token) { toast.error('Could not create the portal link. Run the customer-portal migration first.'); return }
      const url = portalUrl(token)
      try { await navigator.clipboard.writeText(url) } catch { toast('Portal link (copy manually): ' + url, { duration: 20000 }) }
      setPortalCopied(true); setTimeout(() => setPortalCopied(false), 2500)
    } finally { setPortalBusy(false) }
  }

  const [editingNotes, setEditingNotes] = useState(false)
  const [notesValue, setNotesValue] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)

  // Scheduling preferences (customer default + per-property override).
  const [editingPrefs, setEditingPrefs] = useState(false)
  const [prefsDraft, setPrefsDraft] = useState<PrefsDraft>(EMPTY_DRAFT)
  const [savingPrefs, setSavingPrefs] = useState(false)
  const [editingPropPrefs, setEditingPropPrefs] = useState<string | null>(null)
  const [propPrefsDraft, setPropPrefsDraft] = useState<PrefsDraft>(EMPTY_DRAFT)
  const [savingPropPrefs, setSavingPropPrefs] = useState(false)

  // Instant paint from a warm cache (hover prefetch on the list, or a prior
  // visit). The load effect below revalidates right after, so it's never stale-stuck.
  useEffect(() => {
    const cached = readCache<CustomerPrefetch>(custCacheKey(id), CACHE_TTL.short)
    if (cached?.customer) {
      setCustomer(cached.customer)
      setNotesValue(cached.customer.notes || '')
      setProperties(cached.properties)
      setQuotes(cached.quotes)
      setJobs(cached.jobs)
      setInvoices(cached.invoices)
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    async function load() {
      // Local session read (no GoTrue round-trip). ONE batch for everything that
      // depends only on the customer id / user id — the referrer name + referred-revenue
      // are the only reads that need a prior result, so they run in a tiny second
      // round-trip below. This replaces ~5 serial hops that also re-ran in full on every
      // realtime refresh.
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      const [cRes, pRes, qRes, jRes, iRes, refRes, recRes, mRes, payRes, srRes, setRes, lRes] = await Promise.all([
        supabase.from('customers').select('*').eq('id', id).eq('user_id', user!.id).single(),
        supabase.from('properties').select('*').eq('customer_id', id).order('is_primary', { ascending: false }),
        supabase.from('quotes').select('*').eq('customer_id', id).order('created_at', { ascending: false }),
        supabase.from('jobs').select('*').eq('customer_id', id).order('scheduled_date', { ascending: true }),
        supabase.from('invoices').select('*').eq('customer_id', id).order('created_at', { ascending: false }),
        // Advocates this customer referred (needs only id).
        supabase.from('customers').select('id, name').eq('referred_by_customer_id', id),
        supabase.from('job_recurrences').select('*').eq('customer_id', id),
        // Unified timeline sources — degrade gracefully if a table isn't present yet.
        // Payments carry kind/method/notes so credit/refund movements label correctly.
        supabase.from('messages').select('direction, channel, body, created_at').eq('customer_id', id).order('created_at', { ascending: false }).limit(50),
        supabase.from('payments').select('amount, status, kind, method, notes, created_at').eq('customer_id', id),
        supabase.from('service_requests').select('message, created_at').eq('customer_id', id),
        supabase.from('business_settings').select('service_seasons, gst_percent').eq('user_id', user!.id).maybeSingle(),
        // Newest website lead — the full intake detail (service/address/budget/schedule/contact/source).
        supabase.from('website_leads').select('*').eq('customer_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      ])
      // A transient/network error must NOT render as "Customer not found." Only a
      // genuine no-rows result (.single() → PGRST116) means the customer is truly gone.
      if (cRes.error && cRes.error.code !== 'PGRST116') { setLoadError('Could not load this customer — check your connection.'); setLoading(false); return }
      setLoadError(null)
      const cust = cRes.data as Customer | null
      setCustomer(cust)
      setNotesValue(cust?.notes || '')
      setProperties((pRes.data as Property[]) || [])
      setQuotes((qRes.data as Quote[]) || [])
      setJobs((jRes.data as Job[]) || [])
      setInvoices((iRes.data as Invoice[]) || [])
      // Warm the cache so the next open (or a back-nav) paints instantly.
      if (cust) writeCache<CustomerPrefetch>(custCacheKey(id), {
        customer: cust, properties: (pRes.data as Property[]) || [], quotes: (qRes.data as Quote[]) || [],
        jobs: (jRes.data as Job[]) || [], invoices: (iRes.data as Invoice[]) || [],
      })

      if (recRes.data) setRecurrences(recRes.data as JobRecurrence[])
      setLead((lRes.data as WebsiteLead | null) ?? null)
      setSeasons(settingsToSeasons((setRes.data as { service_seasons: unknown } | null)?.service_seasons))
      setGstPercent(Number((setRes.data as { gst_percent?: number | null } | null)?.gst_percent) || 0)

      const extra: TimelineEvent[] = []
      for (const m of (mRes.data as { direction: string; channel: string; body: string | null; created_at: string }[]) || []) {
        if (m.direction === 'internal') continue // internal notes live in the notes card
        const inbound = m.direction === 'inbound'
        const chan = m.channel === 'email' ? 'email' : m.channel === 'portal' ? 'portal message' : 'SMS'
        extra.push({ at: m.created_at, kind: inbound ? 'message_in' : 'message_out', title: `${inbound ? 'Received' : 'Sent'} ${chan}`, sub: (m.body || '').slice(0, 90), href: '/dashboard/messages' })
      }
      // The ledger holds payments AND customer-credit movements (kind='credit') AND
      // reversals (negative payments) — label each correctly instead of "Payment received".
      for (const p of (payRes.data as { amount: number; status: string; kind: string; method: string | null; notes: string | null; created_at: string }[]) || []) {
        if (p.status !== 'paid') continue
        const amt = Number(p.amount) || 0
        if (p.kind === 'credit') {
          extra.push({ at: p.created_at, kind: 'payment', title: amt >= 0 ? `Credit added · ${formatCurrency(Math.abs(amt))}` : `Credit applied · ${formatCurrency(Math.abs(amt))}`, sub: p.notes || undefined })
        } else if (amt < 0) {
          extra.push({ at: p.created_at, kind: 'payment', title: `Refund · ${formatCurrency(Math.abs(amt))}`, sub: p.notes || undefined })
        } else {
          extra.push({ at: p.created_at, kind: 'payment', title: 'Payment received', sub: `${formatCurrency(amt)}${p.method && p.method !== 'stripe' ? ` · ${p.method}` : ''}` })
        }
      }
      for (const sr of (srRes.data as { message: string; created_at: string }[]) || []) {
        const msg = sr.message || ''
        const isLead = /^new .* lead/i.test(msg)
        extra.push({ at: sr.created_at, kind: 'portal_request', title: isLead ? 'Website lead' : 'Portal service request', sub: msg.slice(0, 160), href: '/dashboard/messages' })
      }
      setExtraTimeline(extra)

      // Dependent tail — the ONLY reads that need a prior result: the referrer's name
      // (needs cust.referred_by_customer_id) and the revenue from people this customer
      // referred (needs the referred list). Run them together, not serially.
      const referredList = (refRes.data as { id: string; name: string }[]) || []
      const [referrerRes, referredRevRes] = await Promise.all([
        cust?.referred_by_customer_id
          ? supabase.from('customers').select('id, name').eq('id', cust.referred_by_customer_id).maybeSingle()
          : null,
        referredList.length > 0
          ? supabase.from('quotes').select('total, status').in('customer_id', referredList.map(r => r.id))
          : null,
      ])
      if (referrerRes?.data) setReferrer(referrerRes.data as { id: string; name: string })
      if (referredRevRes?.data) {
        const rev = (referredRevRes.data as { total: number; status: string }[])
          .filter(q => WON.has(q.status)).reduce((s, q) => s + Number(q.total || 0), 0)
        setReferredRevenue(rev)
      }

      setLoading(false)
    }
    load()
  }, [id, tick]) // eslint-disable-line react-hooks/exhaustive-deps

  // Live timeline: a new message, payment, quote/job/invoice change, or portal
  // request for THIS customer re-runs load() — no refresh. Tables must be on the
  // realtime publication (migration 2026-06-24d); unpublished ones just stay quiet.
  const reload = () => setTick(t => t + 1)
  const custFilter = id ? `customer_id=eq.${id}` : null
  useRealtimeRefresh('quotes', custFilter, reload)
  useRealtimeRefresh('jobs', custFilter, reload)
  useRealtimeRefresh('invoices', custFilter, reload)
  useRealtimeRefresh('messages', custFilter, reload)
  useRealtimeRefresh('payments', custFilter, reload)
  useRealtimeRefresh('service_requests', custFilter, reload)
  useRealtimeRefresh('customers', id ? `id=eq.${id}` : null, reload)

  async function saveNotes() {
    if (!customer) return
    setSavingNotes(true)
    const patch = { notes: notesValue || null }
    try {
      const outcome = await queueOrRun(
        { kind: 'customer.update', payload: { id: customer.id, patch }, label: `Note · ${customer.name}` },
        async () => { const { error } = await supabase.from('customers').update(patch).eq('id', customer.id); if (error) throw new Error(error.message) },
      )
      setCustomer({ ...customer, notes: patch.notes })
      setEditingNotes(false)
      if (outcome === 'queued') toast.info('Saved offline — syncs when you’re back online.')
    } catch (e) {
      toast.error('Could not save the note: ' + (e instanceof Error ? e.message : 'unknown error'))   // keep the editor open
    } finally { setSavingNotes(false) }
  }

  function startEditPrefs() {
    setPrefsDraft(toDraft(customer))
    setEditingPrefs(true)
  }
  async function savePrefs() {
    if (!customer) return
    setSavingPrefs(true)
    const row = draftToRow(prefsDraft)
    try {
      const outcome = await queueOrRun(
        { kind: 'customer.update', payload: { id: customer.id, patch: row }, label: `Edit · ${customer.name}` },
        async () => { const { error } = await supabase.from('customers').update(row).eq('id', customer.id); if (error) throw new Error(error.message) },
      )
      setCustomer({ ...customer, ...row })
      if (outcome === 'queued') toast.info('Saved offline — syncs when you’re back online.')
    } catch { toast.error('Could not save changes.') }
    finally { setSavingPrefs(false); setEditingPrefs(false) }
  }

  function startEditPropPrefs(p: Property) {
    setPropPrefsDraft(toDraft(p))
    setEditingPropPrefs(p.id)
  }
  async function savePropPrefs(propId: string) {
    setSavingPropPrefs(true)
    const row = draftToRow(propPrefsDraft)
    const { error } = await supabase.from('properties').update(row).eq('id', propId)
    setSavingPropPrefs(false)
    if (error) {
      // Keep the editor open so the edit isn't lost — same behavior as saveNotes/savePrefs.
      toast.error('Could not save the override: ' + error.message)
      return
    }
    setProperties(prev => prev.map(p => p.id === propId ? { ...p, ...row } : p))
    setEditingPropPrefs(null)
  }

  // Pause a schedule: cancel its FUTURE scheduled/in-progress visits (past visits
  // and the recurrence row are preserved, so it can be rebuilt later). Reuses the
  // jobs.status='cancelled' system — no new "paused" state needed.
  async function pauseSchedule(plan: ServicePlan) {
    const todayISO = localToday()
    const futureIds = jobs
      .filter(j => j.recurrence_id === plan.recurrenceId && j.scheduled_date >= todayISO && (j.status === 'scheduled' || j.status === 'in_progress'))
      .map(j => j.id)
    if (futureIds.length === 0) return
    const ok = await confirmDialog({
      title: `Pause ${plan.serviceName}?`,
      message: `This cancels ${futureIds.length} upcoming visit${futureIds.length !== 1 ? 's' : ''}. Past visits are kept, and you can schedule it again anytime.`,
      confirmLabel: 'Pause plan',
    })
    if (!ok) return
    setPausing(plan.recurrenceId)
    const { error } = await supabase.from('jobs').update({ status: 'cancelled' }).in('id', futureIds)
    if (error) toast.error('Could not pause: ' + error.message)
    else setJobs(prev => prev.map(j => futureIds.includes(j.id) ? { ...j, status: 'cancelled' } : j))
    setPausing(null)
  }

  // Heavy derivations, memoized and hoisted above the guards (Rules of Hooks) so editing
  // the controlled Notes / Prefs inputs on this page doesn't rebuild the service plans and
  // the full activity timeline on every keystroke — only when the underlying data changes.
  // Photos the customer attached during online booking (stored as URLs on the draft
  // quote's lead_meta.photos). Rendered read-only through the shared gallery/lightbox.
  const bookingPhotos = useMemo(() => bookingPhotosFromQuotes(quotes as unknown as { lead_meta?: unknown; created_at?: string | null }[]), [quotes])

  const servicePlans = useMemo(() => {
    const t = localToday()
    const quotesById: Record<string, Quote> = {}
    for (const q of quotes) quotesById[q.id] = q
    const recsById: Record<string, JobRecurrence> = {}
    for (const r of recurrences) recsById[r.id] = r
    const planValueOf = (j: Job) => {
      const q = j.quote_id ? quotesById[j.quote_id] : null
      const rec = j.recurrence_id ? recsById[j.recurrence_id] : null
      const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
      return jobVisitValue(j.price, q as unknown as Record<string, unknown>, freq, j.is_initial_visit)
    }
    return buildServicePlans(recurrences, jobs, seasons, t, planValueOf)
  }, [quotes, recurrences, jobs, seasons])

  const events = useMemo(() => {
    // GST-inclusive invoice amounts, so the timeline agrees with the Invoices page + portal.
    const gstMult = 1 + (Number(gstPercent) || 0) / 100
    const arr: TimelineEvent[] = []
    for (const q of quotes) {
      arr.push({ at: q.created_at, kind: 'quote_created', title: `Quote ${q.quote_number} created`, sub: `${q.service_type} · ${formatCurrency(Number(q.total))}`, href: `/dashboard/quotes/${q.id}` })
      if (q.sent_at) arr.push({ at: q.sent_at, kind: 'quote_sent', title: `Quote ${q.quote_number} sent`, href: `/dashboard/quotes/${q.id}` })
      if (q.last_followed_up_at) arr.push({ at: q.last_followed_up_at, kind: 'followup', title: `Followed up on ${q.quote_number}`, sub: `${q.follow_up_count} total`, href: `/dashboard/quotes/${q.id}` })
      if (WON.has(q.status)) arr.push({ at: q.updated_at, kind: 'quote_accepted', title: `Quote ${q.quote_number} accepted`, sub: formatCurrency(Number(q.total)), href: `/dashboard/quotes/${q.id}` })
    }
    for (const j of jobs) {
      arr.push({ at: j.created_at, kind: 'job_scheduled', title: `Job scheduled — ${j.title}`, sub: `for ${formatDate(j.scheduled_date)}` })
      if (j.status === 'completed') arr.push({ at: j.updated_at, kind: 'job_completed', title: `Job completed — ${j.title}` })
    }
    for (const inv of invoices) {
      arr.push({ at: inv.created_at, kind: 'invoice_created', title: `Invoice ${inv.invoice_number} created`, sub: formatCurrency(Math.round(Number(inv.amount) * gstMult * 100) / 100) })
      if (inv.status === 'paid') arr.push({ at: inv.updated_at, kind: 'invoice_paid', title: `Invoice ${inv.invoice_number} paid`, sub: formatCurrency(Math.round(Number(inv.amount) * gstMult * 100) / 100) })
    }
    arr.push(...extraTimeline) // messages, payments, portal requests
    arr.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    return arr
  }, [quotes, jobs, invoices, extraTimeline, gstPercent])

  if (loading) return <div className="max-w-5xl mx-auto space-y-6"><SkeletonTiles count={4} /><SkeletonRows count={5} /></div>
  // Cached customer (if any) keeps showing on a revalidation blip; only when there's
  // genuinely nothing to show do we branch error-vs-not-found.
  if (!customer) return loadError ? (
    <div className="text-center py-16 text-sm">
      <p className="text-red-400">{loadError}</p>
      <Button size="sm" variant="secondary" className="mt-2" onClick={reload}>Retry</Button>
    </div>
  ) : (
    <div className="text-center py-16 text-sm">
      <p className="text-red-400">Customer not found — they may have been deleted.</p>
      <Link href="/dashboard/customers" className="mt-2 inline-block underline font-medium text-accent">Back to Customers</Link>
    </div>
  )

  const today = localToday()

  // ── Revenue (three separate truths) ──
  const wonQuotes = quotes.filter(q => WON.has(q.status))
  const bookedRevenue = wonQuotes.reduce((s, q) => s + Number(q.total || 0), 0)
  // Collected = money actually received (ledger amount_paid, incl. partial payments);
  // Outstanding = remaining balance across issued invoices.
  const collectedRevenue = invoices.reduce((s, i) => s + (Number(i.amount_paid) || 0), 0)
  // GST-inclusive + cancelled excluded — agrees with the Invoices page ledger math.
  const custGstMult = 1 + (Number(gstPercent) || 0) / 100
  const outstandingRevenue = invoices
    .filter(i => i.status !== 'draft' && i.status !== 'cancelled')
    .reduce((s, i) => s + Math.max(0, Math.round((Number(i.amount || 0) * custGstMult - (Number(i.amount_paid) || 0)) * 100) / 100), 0)
  const avgJobValue = wonQuotes.length > 0 ? bookedRevenue / wonQuotes.length : 0

  // ── Upcoming + retention ──
  const upcoming = jobs
    .filter(j => j.scheduled_date >= today && (j.status === 'scheduled' || j.status === 'in_progress'))
    .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))
  const nextVisit = upcoming[0] || null
  const completed = jobs.filter(j => j.status === 'completed')
  const lastServicedDate = completed.length > 0
    ? completed.map(j => j.scheduled_date).sort().slice(-1)[0]
    : null
  const lastServicedDays = daysSince(lastServicedDate)
  const hasRecurring = recurrences.length > 0 || jobs.some(j => j.recurrence_id)
  const primaryRec = recurrences[0] || null
  const recurringStatus = primaryRec
    ? recurringCustomerLabel(primaryRec.interval_unit, primaryRec.interval_count, primaryRec.freq)
    : hasRecurring ? 'Recurring' : null
  const remainingVisits = (rid: string) =>
    jobs.filter(j => j.recurrence_id === rid && j.scheduled_date >= today && (j.status === 'scheduled' || j.status === 'in_progress')).length

  const warnings: { tone: 'red' | 'amber'; text: string }[] = []
  if (hasRecurring && upcoming.length === 0) {
    warnings.push({ tone: 'red', text: 'Recurring customer with no future visits scheduled — their series has run out.' })
  } else if (upcoming.length === 0 && completed.length > 0) {
    warnings.push({ tone: 'amber', text: 'No upcoming visits scheduled.' })
  }
  if (lastServicedDays != null && lastServicedDays > 60) {
    warnings.push({ tone: 'amber', text: `Last serviced ${lastServicedDays} days ago — may be worth a check-in.` })
  }

  // ── Open items (what needs action) ──
  interface OpenItem { key: string; icon: typeof FileText; label: string; sub: string; href: string; tone: string }
  const openItems: OpenItem[] = []
  for (const q of quotes.filter(needsFollowUp)) {
    openItems.push({ key: `fu-${q.id}`, icon: RotateCw, label: `Follow up: ${q.quote_number}`, sub: `${q.service_type} · ${formatCurrency(Number(q.total))}${q.sent_at ? ` · sent ${daysSince(q.sent_at)}d ago` : ''}`, href: `/dashboard/quotes/${q.id}`, tone: 'text-amber-400' })
  }
  for (const q of quotes.filter(q => q.status === 'accepted')) {
    openItems.push({ key: `sch-${q.id}`, icon: CalendarPlus, label: `Schedule: ${q.quote_number}`, sub: `${q.service_type} · ${formatCurrency(Number(q.total))}`, href: `/dashboard/schedule?quote=${q.id}`, tone: 'text-accent' })
  }
  for (const inv of invoices.filter(i => OPEN_INVOICE.has(i.status))) {
    const overdue = !!inv.due_date && inv.due_date < today
    // Deep-link straight to the focused invoice — landing on the unfiltered list
    // meant re-finding the invoice you just tapped.
    openItems.push({ key: `inv-${inv.id}`, icon: Receipt, label: `${overdue ? 'Overdue' : 'Unpaid'} invoice ${inv.invoice_number}`, sub: `${formatCurrency(Math.round(Number(inv.amount) * custGstMult * 100) / 100)}${inv.due_date ? ` · due ${formatDate(inv.due_date)}` : ''}`, href: `/dashboard/invoices?invoice=${encodeURIComponent(inv.invoice_number)}`, tone: overdue ? 'text-red-400' : 'text-amber-400' })
  }

  const phone = customer.phone
  const isHighValue = bookedRevenue >= 2000

  // Service history from check-in/check-out data — real durations, not estimates.
  const timedVisits = completed.filter(j => Number(j.actual_minutes) > 0)
  const avgDuration = timedVisits.length
    ? Math.round(timedVisits.reduce((s, j) => s + Number(j.actual_minutes), 0) / timedVisits.length)
    : null

  const revenueCards = [
    { label: 'Booked Revenue', value: formatCurrency(bookedRevenue), sub: 'Won quotes', icon: DollarSign, color: 'text-accent' },
    { label: 'Collected', value: formatCurrency(collectedRevenue), sub: 'Invoices paid', icon: Wallet, color: 'text-emerald-400' },
    { label: 'Outstanding', value: formatCurrency(outstandingRevenue), sub: 'Billed, unpaid', icon: AlertTriangle, color: 'text-amber-400' },
    {
      label: 'Service History',
      value: `${completed.length} visit${completed.length !== 1 ? 's' : ''}`,
      sub: `${avgDuration != null ? `~${avgDuration} min avg` : 'No timed visits yet'}${lastServicedDate ? ` · last ${formatDate(lastServicedDate)}` : ''}`,
      icon: Timer, color: 'text-sky-400',
    },
  ]

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => router.back()} aria-label="Go back" className="text-ink-muted hover:text-ink transition-colors rounded p-1 -m-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <PageHeader title={customer.name} description={`Customer since ${formatDate(customer.created_at)}`} />
        <Button size="sm" variant="secondary" className="ml-auto shrink-0" loading={portalBusy}
          title="Copy a private link the customer can use to view quotes, invoices, history & photos and accept quotes"
          onClick={copyPortalLink}>
          {portalCopied ? <><Check className="w-3.5 h-3.5" /> Link copied</> : <><Link2 className="w-3.5 h-3.5" /> Copy portal link</>}
        </Button>
      </div>

      {/* Retention warnings — top, highly visible */}
      {warnings.map((w, i) => (
        <div key={i} className={`flex items-center gap-2 text-sm rounded-xl px-4 py-2.5 border ${w.tone === 'red' ? 'text-red-400 bg-red-500/10 border-red-500/20' : 'text-amber-400 bg-amber-500/10 border-amber-500/20'}`}>
          <AlertTriangle className="w-4 h-4 shrink-0" /> {w.text}
        </div>
      ))}

      {/* Identity + quick actions */}
      <Card>
        <CardBody className="space-y-4">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-full bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
              <span className="text-base font-bold text-accent">{getInitials(customer.name)}</span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-lg font-bold text-ink">{customer.name}</p>
                {isHighValue && (
                  <span className="text-[10px] uppercase tracking-wide text-accent border border-accent/30 bg-accent/10 rounded px-1.5 py-0.5 font-semibold flex items-center gap-1">
                    <Sparkles className="w-3 h-3" /> High value
                  </span>
                )}
                {recurringStatus && (
                  <span className="text-[10px] uppercase tracking-wide text-emerald-400 border border-emerald-500/30 bg-emerald-500/10 rounded px-1.5 py-0.5 font-semibold flex items-center gap-1">
                    <Repeat className="w-3 h-3" /> {recurringStatus}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-x-4 gap-y-1 mt-1 flex-wrap text-sm">
                {customer.phone && <a href={`tel:${customer.phone}`} className="flex items-center gap-1 text-accent hover:underline"><Phone className="w-3.5 h-3.5" />{customer.phone}</a>}
                {customer.email && <a href={`mailto:${customer.email}`} className="flex items-center gap-1 text-ink-muted hover:text-ink"><Mail className="w-3.5 h-3.5" />{customer.email}</a>}
              </div>
              <div className="flex items-center gap-x-3 gap-y-1 mt-1.5 flex-wrap">
                {customer.acquisition_source && (
                  <span className="text-[10px] uppercase tracking-wide text-ink-muted border border-border rounded px-1.5 py-0.5">{customer.acquisition_source}</span>
                )}
                {referrer && (
                  <Link href={`/dashboard/customers/${referrer.id}`} className="text-xs text-ink-muted hover:text-ink flex items-center gap-1">
                    <Users className="w-3 h-3" /> Referred by {referrer.name}
                  </Link>
                )}
                {lastServicedDays != null && (
                  <span className="text-xs text-ink-faint">Last serviced {lastServicedDays}d ago</span>
                )}
                {mdLabel(customer.birthday) && (
                  <span className="text-xs text-ink-faint flex items-center gap-1"><Cake className="w-3 h-3" /> {mdLabel(customer.birthday)}</span>
                )}
                {mdLabel(customer.anniversary) && (
                  <span className="text-xs text-ink-faint flex items-center gap-1"><PartyPopper className="w-3 h-3" /> {mdLabel(customer.anniversary)}</span>
                )}
              </div>
            </div>
          </div>

          {/* Quick actions — one tap, large targets */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Link href={`/dashboard/quotes/new?customer=${customer.id}`} className="h-11 rounded-xl flex items-center justify-center gap-1.5 text-sm font-medium bg-accent text-black hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
              <FilePlus className="w-4 h-4" /> New quote
            </Link>
            <Link href={`/dashboard/schedule?customer=${customer.id}`} className="h-11 rounded-xl flex items-center justify-center gap-1.5 text-sm font-medium border border-border bg-surface text-ink hover:border-border-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
              <CalendarPlus className="w-4 h-4" /> Schedule
            </Link>
            <a href={phone ? `tel:${phone}` : undefined} aria-disabled={!phone} className={`h-11 rounded-xl flex items-center justify-center gap-1.5 text-sm font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${phone ? 'bg-surface border-border text-ink hover:border-border-strong' : 'border-border text-ink-faint pointer-events-none opacity-50'}`}>
              <Phone className="w-4 h-4" /> Call
            </a>
            {/* Opens the ONE shared Send Message dialog (templates + editable body,
                logged to the thread) — not a device-only sms: deep link. */}
            <button onClick={() => setShowMessage(true)}
              className="h-11 rounded-xl flex items-center justify-center gap-1.5 text-sm font-medium border bg-surface border-border text-ink hover:border-border-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
              <MessageSquare className="w-4 h-4" /> Message
            </button>
          </div>
          <SendMessageDialog open={showMessage} onClose={() => setShowMessage(false)}
            customerId={customer.id} customerName={customer.name} />
        </CardBody>
      </Card>

      {/* Website lead — the full intake detail (service · address · budget · schedule
          · contact · source), shown identically to the Messages inbox card. */}
      {lead && <LeadSummary lead={lead} />}

      {/* Photos the customer attached when booking — the SAME read-only gallery +
          lightbox (thumbnails · enlarge · download) used everywhere else. */}
      {bookingPhotos.length > 0 && (
        <Card>
          <CardHeader className="flex items-center gap-2">
            <Camera className="w-4 h-4 text-accent" />
            <h2 className="text-sm font-semibold text-ink">Customer photos</h2>
            <span className="ml-auto text-xs text-ink-faint">{bookingPhotos.length} from booking</span>
          </CardHeader>
          <CardBody>
            <JobPhotos propertyId={null} variant="gallery" readOnly initialPhotos={bookingPhotos} />
          </CardBody>
        </Card>
      )}

      {/* Open items — "what needs action for this customer" comes FIRST, right under
          the identity card (it was buried five cards deep). */}
      <Card className={openItems.length > 0 ? 'border-amber-500/30' : ''}>
        <CardHeader className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          <h2 className="text-sm font-semibold text-ink">Open Items</h2>
          {openItems.length > 0 && <span className="ml-auto text-xs font-semibold text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-full px-2 py-0.5">{openItems.length}</span>}
        </CardHeader>
        <CardBody className="p-0">
          {openItems.length === 0 ? (
            <InlineEmpty className="py-6">Nothing needs action right now.</InlineEmpty>
          ) : (
            <div className="divide-y divide-border">
              {openItems.map(item => {
                const Icon = item.icon
                return (
                  <Link key={item.key} href={item.href} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-raised transition-colors">
                    <Icon className={`w-4 h-4 shrink-0 ${item.tone}`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink truncate">{item.label}</p>
                      <p className="text-xs text-ink-muted truncate">{item.sub}</p>
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Communication health — opt-in/contact mismatches (only shows when relevant) */}
      <CommsHealth customer={customer} onChange={patch => setCustomer({ ...customer, ...patch })} />

      {/* Conversation — two-way SMS + portal thread */}
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-ink">Conversation</h2>
          <p className="text-xs text-ink-faint mt-0.5">Two-way SMS &amp; portal messages with this customer.</p>
        </CardHeader>
        <CardBody>
          <div className="h-[440px]"><ConversationThread customerId={customer.id} /></div>
        </CardBody>
      </Card>

      {/* Communication — consent + history */}
      <CustomerComms customerId={customer.id} smsOptIn={!!customer.sms_opt_in} emailOptIn={!!customer.email_opt_in} />

      {/* Review lifecycle — ask, then record the outcome (stops asking once done) */}
      <ReviewLifecycle customer={customer} onChange={patch => setCustomer({ ...customer, ...patch })} />

      {/* Notes & access info — prominent, quick-edit */}
      <Card>
        <CardHeader className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><StickyNote className="w-4 h-4 text-accent" /> Notes & Access Info</h2>
          {!editingNotes && (
            <button onClick={() => setEditingNotes(true)} className="text-xs text-accent hover:underline flex items-center gap-1">
              <Edit2 className="w-3 h-3" /> Edit
            </button>
          )}
        </CardHeader>
        <CardBody>
          {editingNotes ? (
            <div className="space-y-3">
              <Textarea
                value={notesValue}
                onChange={e => setNotesValue(e.target.value)}
                rows={4}
                autoFocus
                placeholder="Gate codes, dog info, preferred contact, billing notes, access instructions, equipment restrictions..."
              />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={saveNotes} loading={savingNotes}>Save note</Button>
                <Button size="sm" variant="ghost" onClick={() => { setNotesValue(customer.notes || ''); setEditingNotes(false) }}>Cancel</Button>
              </div>
            </div>
          ) : customer.notes ? (
            <p className="text-sm text-ink whitespace-pre-wrap">{customer.notes}</p>
          ) : (
            <button onClick={() => setEditingNotes(true)} className="text-sm text-ink-faint hover:text-ink-muted transition-colors">
              No notes yet — add gate codes, dog info, access instructions…
            </button>
          )}
        </CardBody>
      </Card>

      {/* Scheduling preferences — customer-wide default (properties can override) */}
      <Card>
        <CardHeader className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><CalendarClock className="w-4 h-4 text-accent" /> Scheduling Preferences</h2>
          {!editingPrefs && (
            <button onClick={startEditPrefs} className="text-xs text-accent hover:underline flex items-center gap-1">
              <Edit2 className="w-3 h-3" /> Edit
            </button>
          )}
        </CardHeader>
        <CardBody>
          {editingPrefs ? (
            <div className="space-y-3">
              <SchedulePrefsFields value={prefsDraft} onChange={setPrefsDraft} />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={savePrefs} loading={savingPrefs}>Save preferences</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditingPrefs(false)}>Cancel</Button>
              </div>
            </div>
          ) : prefSummary(resolvePrefs(customer)) ? (
            <p className="text-sm text-ink">{prefSummary(resolvePrefs(customer))}</p>
          ) : (
            <button onClick={startEditPrefs} className="text-sm text-ink-faint hover:text-ink-muted transition-colors text-left">
              No preferences set — add preferred/avoid days or a time window (e.g. “always Fridays, mornings”).
            </button>
          )}
        </CardBody>
      </Card>

      {/* Payment method + AutoPay (card-on-file for recurring customers) */}
      <PaymentMethodCard customer={customer} onCustomerChange={patch => setCustomer({ ...customer, ...patch })} />

      {/* Revenue + service history */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {revenueCards.map(c => {
          const Icon = c.icon
          return (
            <Card key={c.label} className="p-4 sm:p-5">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-semibold text-ink-muted uppercase tracking-[0.14em]">{c.label}</p>
                <Icon className={`w-4 h-4 ${c.color}`} />
              </div>
              <p className="text-xl sm:text-2xl font-bold text-ink tracking-tight tabular-nums mt-2">{c.value}</p>
              <p className="text-xs text-ink-faint mt-1">{c.sub}</p>
            </Card>
          )
        })}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-muted -mt-2">
        <span>Accepted jobs: <span className="text-ink font-medium">{wonQuotes.length}</span> of {quotes.length}</span>
        <span>Avg job value: <span className="text-ink font-medium">{formatCurrency(avgJobValue)}</span></span>
        <span>Invoices: <span className="text-ink font-medium">{invoices.length}</span></span>
      </div>

      {/* Current Service Plan — the recurring schedule at a glance */}
      {servicePlans.length > 0 && (
        <Card>
          <CardHeader className="flex items-center gap-2">
            <Repeat className="w-4 h-4 text-accent" />
            <h2 className="text-sm font-semibold text-ink">Current Service Plan</h2>
          </CardHeader>
          <CardBody className="space-y-3">
            {servicePlans.map(plan => (
              <ServicePlanRow
                key={plan.recurrenceId}
                plan={plan}
                customerId={id}
                pausing={pausing === plan.recurrenceId}
                onPause={() => pauseSchedule(plan)}
              />
            ))}
          </CardBody>
        </Card>
      )}

      {/* Upcoming work */}
      <Card>
        <CardHeader className="flex items-center gap-2">
          <CalendarPlus className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold text-ink">Upcoming Work</h2>
          {nextVisit && <span className="ml-auto text-xs text-ink-muted">Next visit: <span className="text-accent font-semibold">{formatDate(nextVisit.scheduled_date)}</span></span>}
        </CardHeader>
        <CardBody className="space-y-3">
          {recurrences.length > 0 && servicePlans.length === 0 && (
            <div className="flex flex-wrap gap-2">
              {recurrences.map(r => {
                const remaining = remainingVisits(r.id)
                return (
                  <span key={r.id} className="text-xs flex items-center gap-1 text-accent border border-accent/20 bg-accent/10 rounded-lg px-2.5 py-1">
                    <Repeat className="w-3 h-3" /> {recurrenceLabel(r.interval_unit, r.interval_count, r.freq)}
                    {r.end_date ? ` until ${formatDate(r.end_date)}` : r.end_count ? ` · ${remaining} of ${r.end_count} left` : ' · ongoing'}
                    {!r.end_date && !r.end_count && remaining > 0 ? ` · ${remaining} upcoming` : ''}
                  </span>
                )
              })}
            </div>
          )}
          {upcoming.length === 0 ? (
            // Empty state leads to the fix, not just the fact (the warning banner
            // above already states it).
            <p className="text-sm text-ink-muted">
              No upcoming visits scheduled.{' '}
              <Link href={`/dashboard/schedule?customer=${customer.id}`} className="text-accent font-medium hover:underline">Schedule a visit →</Link>
            </p>
          ) : (
            <div className="divide-y divide-border -mx-2">
              {upcoming.map(j => (
                <div key={j.id} className="flex items-center justify-between px-2 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink truncate flex items-center gap-1.5">
                      {j.recurrence_id && <Repeat className="w-3 h-3 text-ink-faint shrink-0" />}{j.title}
                    </p>
                    {j.service_type && <p className="text-xs text-ink-muted truncate">{j.service_type}</p>}
                  </div>
                  <span className="text-sm text-ink-muted shrink-0">{formatDate(j.scheduled_date)}</span>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Timeline */}
        <Card>
          <CardHeader><h2 className="text-sm font-semibold text-ink">Timeline</h2></CardHeader>
          <CardBody>
            {events.length === 0 ? (
              <InlineEmpty className="py-6">No history yet.</InlineEmpty>
            ) : (
              <div className="space-y-3">
                {events.map((e, i) => {
                  const meta = EVENT_META[e.kind]
                  const Icon = meta.icon
                  const row = (
                    <div className="flex items-start gap-3">
                      <div className={`w-7 h-7 rounded-lg border flex items-center justify-center shrink-0 ${meta.color}`}>
                        <Icon className="w-3.5 h-3.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-ink">{e.title}</p>
                        <p className="text-xs text-ink-faint">{formatDate(e.at)}{e.sub ? ` · ${e.sub}` : ''}</p>
                      </div>
                    </div>
                  )
                  return e.href
                    ? <Link key={i} href={e.href} className="block hover:opacity-80 transition-opacity">{row}</Link>
                    : <div key={i}>{row}</div>
                })}
              </div>
            )}
          </CardBody>
        </Card>

        {/* Properties */}
        <Card>
          <CardHeader className="flex items-center gap-2">
            <MapPin className="w-4 h-4 text-accent" />
            <h2 className="text-sm font-semibold text-ink">Properties</h2>
          </CardHeader>
          <CardBody className="space-y-3">
            {properties.length === 0 ? (
              <InlineEmpty className="py-6">No properties on file.</InlineEmpty>
            ) : properties.map(p => {
              const jobCount = jobs.filter(j => j.property_id === p.id).length
              const measures = [
                p.lawn_sqft != null && `Lawn ${p.lawn_sqft} ft²`,
                p.fence_length != null && `Fence ${p.fence_length} ft`,
                p.mulch_area != null && `Mulch ${p.mulch_area} ft²`,
                p.rock_area != null && `Rock ${p.rock_area} ft²`,
                p.driveway_area != null && `Driveway ${p.driveway_area} ft²`,
                p.lot_size != null && `Lot ${p.lot_size} ft²`,
              ].filter(Boolean) as string[]
              const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.address)}`
              return (
                <div key={p.id} className="rounded-xl border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium text-ink">{p.address}{p.is_primary ? ' · primary' : ''}</p>
                    <span className="text-xs text-ink-muted shrink-0">{jobCount} job{jobCount !== 1 ? 's' : ''}</span>
                  </div>
                  {measures.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {measures.map(m => <span key={m} className="text-[11px] text-ink-muted bg-surface border border-border rounded px-1.5 py-0.5">{m}</span>)}
                    </div>
                  )}
                  <p className="text-[11px] text-ink-faint mt-2">
                    {p.lat != null && p.lng != null ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : 'No coordinates yet'}
                  </p>
                  {/* Property actions — one tap each (2-up on phones for bigger targets) */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mt-3">
                    <a href={mapsUrl} target="_blank" rel="noopener noreferrer" title="Open in Google Maps" className="h-9 rounded-lg flex items-center justify-center gap-1 text-[11px] font-medium border border-border bg-surface text-ink-muted hover:text-ink hover:border-border-strong transition-colors">
                      <ExternalLink className="w-3.5 h-3.5" /> Maps
                    </a>
                    <Link href={`/dashboard/quotes/new?customer=${customer.id}&property=${p.id}`} title="New quote" className="h-9 rounded-lg flex items-center justify-center gap-1 text-[11px] font-medium border border-border bg-surface text-ink-muted hover:text-ink hover:border-border-strong transition-colors">
                      <FilePlus className="w-3.5 h-3.5" /> Quote
                    </Link>
                    <Link href={`/dashboard/schedule?customer=${customer.id}&property=${p.id}`} title="Schedule job" className="h-9 rounded-lg flex items-center justify-center gap-1 text-[11px] font-medium border border-border bg-surface text-ink-muted hover:text-ink hover:border-border-strong transition-colors">
                      <CalendarPlus className="w-3.5 h-3.5" /> Job
                    </Link>
                    <Link href={`/dashboard/properties/measure?id=${p.id}`} title="Re-measure property" className="h-9 rounded-lg flex items-center justify-center gap-1 text-[11px] font-medium border border-border bg-surface text-ink-muted hover:text-ink hover:border-border-strong transition-colors">
                      <Ruler className="w-3.5 h-3.5" /> Measure
                    </Link>
                  </div>

                  {/* Scheduling override for this property (falls back to the customer default) */}
                  <div className="mt-3 pt-3 border-t border-border">
                    {editingPropPrefs === p.id ? (
                      <div className="space-y-3">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint flex items-center gap-1.5">
                          <CalendarClock className="w-3.5 h-3.5 text-accent" /> Scheduling override
                        </p>
                        <SchedulePrefsFields value={propPrefsDraft} onChange={setPropPrefsDraft} />
                        <div className="flex items-center gap-2">
                          <Button size="sm" onClick={() => savePropPrefs(p.id)} loading={savingPropPrefs}>Save override</Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingPropPrefs(null)}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => startEditPropPrefs(p)} className="w-full text-left flex items-center gap-1.5 text-[11px] text-ink-muted hover:text-ink transition-colors">
                        <CalendarClock className="w-3.5 h-3.5 text-accent shrink-0" />
                        <span className="min-w-0 truncate">
                          {hasAnyPref(p)
                            ? <>Override: {prefSummary(resolvePrefs(null, p))}</>
                            : prefSummary(resolvePrefs(customer))
                              ? <>Using customer default · {prefSummary(resolvePrefs(customer))}</>
                              : 'Set a scheduling override'}
                        </span>
                        <Edit2 className="w-3 h-3 shrink-0 ml-auto opacity-50" />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </CardBody>
        </Card>
      </div>

      {/* Referrals — advocates this customer brought in (with statuses + rewards) */}
      <ReferralPanel customer={customer} referrer={referrer} referredRevenue={referredRevenue} />
    </div>
  )
}

// One recurring schedule, summarised — visible without opening the calendar.
function ServicePlanRow({ plan, customerId, pausing, onPause }: {
  plan: ServicePlan; customerId: string; pausing: boolean; onPause: () => void
}) {
  return (
    <div className={`rounded-xl border p-3 ${plan.paused ? 'border-border bg-bg-tertiary' : 'border-accent/20 bg-accent/5'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-ink flex items-center gap-1.5">
            <Repeat className={`w-3.5 h-3.5 shrink-0 ${plan.paused ? 'text-ink-faint' : 'text-accent'}`} />
            {plan.serviceName}
            {plan.paused && <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint border border-border rounded px-1.5 py-0.5">Paused</span>}
          </p>
          <p className="text-xs text-ink-muted mt-0.5">
            {plan.cadenceLabel}
            {plan.weekday && <> · {plan.weekday}</>}
            {plan.windowLabel && <> · {plan.windowLabel}</>}
          </p>
          <p className="text-xs mt-0.5">
            {plan.paused
              ? <span className="text-ink-faint">No upcoming visits — schedule it again to resume</span>
              : <span className="text-accent font-semibold">{plan.remaining} visit{plan.remaining !== 1 ? 's' : ''} remaining{plan.nextVisitDate ? ` · next ${formatDate(plan.nextVisitDate)}` : ''}</span>}
          </p>
          {/* Initial vs recurring pricing — only when they actually differ */}
          {(plan.recurringPrice ?? 0) > 0 && (
            <p className="text-[11px] text-ink-muted mt-0.5">
              {plan.initialPrice != null && plan.initialPrice !== plan.recurringPrice
                ? <>First visit <span className="font-semibold text-ink">{formatCurrency(plan.initialPrice)}</span>, then <span className="font-semibold text-ink">{formatCurrency(plan.recurringPrice!)}</span>/visit</>
                : <><span className="font-semibold text-ink">{formatCurrency(plan.recurringPrice!)}</span>/visit</>}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 mt-2.5">
        {/* One entry into the schedule — focuses this plan when it has an upcoming visit. */}
        <Link
          href={!plan.paused && plan.nextVisitDate ? `/dashboard/schedule?focus=${plan.recurrenceId}` : `/dashboard/schedule?customer=${customerId}`}
          className="inline-flex items-center justify-center gap-2 font-medium rounded-xl transition-all duration-150 bg-surface border border-border-strong text-ink hover:bg-surface-raised active:scale-[0.98] px-3.5 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
          Open schedule
        </Link>
        {!plan.paused && plan.remaining > 0 && (
          <Button variant="ghost" size="sm" loading={pausing} onClick={onPause}>
            Pause schedule
          </Button>
        )}
        {plan.paused && (
          <Link href={`/dashboard/schedule?customer=${customerId}`}
            className="inline-flex items-center justify-center gap-2 font-medium rounded-xl transition-all duration-150 bg-surface border border-border-strong text-ink hover:bg-surface-raised active:scale-[0.98] px-3.5 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
            Resume schedule
          </Link>
        )}
      </div>
    </div>
  )
}
