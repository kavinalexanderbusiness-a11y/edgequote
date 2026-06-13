'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Customer, Property, Quote, Job, Invoice, JobRecurrence } from '@/types'
import { needsFollowUp, daysSince } from '@/lib/followup'
import { recurrenceLabel, recurringCustomerLabel, buildServicePlans, ServicePlan } from '@/lib/recurrence'
import { jobVisitValue, effectiveFreq } from '@/lib/invoicing'
import { settingsToSeasons, DEFAULT_SEASONS, ServiceSeasons } from '@/lib/seasons'
import { resolvePrefs, prefSummary, hasAnyPref } from '@/lib/preferences'
import { SchedulePrefsFields, PrefsDraft, EMPTY_DRAFT, toDraft, draftToRow } from '@/components/customers/SchedulePrefsFields'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { formatCurrency, formatDate, getInitials } from '@/lib/utils'
import {
  ArrowLeft, Phone, MessageSquare, FilePlus, CalendarPlus, Mail, MapPin, Repeat,
  FileText, Send, RotateCw, CheckCircle2, Wrench, Receipt, DollarSign, Sparkles, Users,
  Edit2, ExternalLink, Ruler, AlertTriangle, StickyNote, Wallet, Timer, CalendarClock,
} from 'lucide-react'

const WON = new Set(['accepted', 'scheduled', 'completed', 'paid'])
const OPEN_INVOICE = new Set(['unpaid', 'sent'])

function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface TimelineEvent {
  at: string
  kind: 'quote_created' | 'quote_sent' | 'followup' | 'quote_accepted' | 'job_scheduled' | 'job_completed' | 'invoice_created' | 'invoice_paid'
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
}

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const supabase = createClient()

  const [customer, setCustomer] = useState<Customer | null>(null)
  const [referrer, setReferrer] = useState<{ id: string; name: string } | null>(null)
  const [referredCustomers, setReferredCustomers] = useState<{ id: string; name: string }[]>([])
  const [referredRevenue, setReferredRevenue] = useState(0)
  const [properties, setProperties] = useState<Property[]>([])
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [recurrences, setRecurrences] = useState<JobRecurrence[]>([])
  const [seasons, setSeasons] = useState<ServiceSeasons>(DEFAULT_SEASONS)
  const [pausing, setPausing] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

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

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      const [cRes, pRes, qRes, jRes, iRes] = await Promise.all([
        supabase.from('customers').select('*').eq('id', id).eq('user_id', user!.id).single(),
        supabase.from('properties').select('*').eq('customer_id', id).order('is_primary', { ascending: false }),
        supabase.from('quotes').select('*').eq('customer_id', id).order('created_at', { ascending: false }),
        supabase.from('jobs').select('*').eq('customer_id', id).order('scheduled_date', { ascending: true }),
        supabase.from('invoices').select('*').eq('customer_id', id).order('created_at', { ascending: false }),
      ])
      const cust = cRes.data as Customer | null
      setCustomer(cust)
      setNotesValue(cust?.notes || '')
      setProperties((pRes.data as Property[]) || [])
      setQuotes((qRes.data as Quote[]) || [])
      setJobs((jRes.data as Job[]) || [])
      setInvoices((iRes.data as Invoice[]) || [])

      if (cust?.referred_by_customer_id) {
        const { data } = await supabase.from('customers').select('id, name').eq('id', cust.referred_by_customer_id).maybeSingle()
        if (data) setReferrer(data as { id: string; name: string })
      }
      // Advocates: who this customer referred, and the revenue they generated.
      const { data: referred } = await supabase.from('customers').select('id, name').eq('referred_by_customer_id', id)
      const referredList = (referred as { id: string; name: string }[]) || []
      setReferredCustomers(referredList)
      if (referredList.length > 0) {
        const { data: rq } = await supabase.from('quotes').select('total, status').in('customer_id', referredList.map(r => r.id))
        const rev = ((rq as { total: number; status: string }[]) || [])
          .filter(q => WON.has(q.status)).reduce((s, q) => s + Number(q.total || 0), 0)
        setReferredRevenue(rev)
      }
      const { data: recs } = await supabase.from('job_recurrences').select('*').eq('customer_id', id)
      if (recs) setRecurrences(recs as JobRecurrence[])

      const { data: settings } = await supabase.from('business_settings').select('service_seasons').eq('user_id', user!.id).maybeSingle()
      setSeasons(settingsToSeasons((settings as { service_seasons: unknown } | null)?.service_seasons))

      setLoading(false)
    }
    load()
  }, [id])

  async function saveNotes() {
    if (!customer) return
    setSavingNotes(true)
    await supabase.from('customers').update({ notes: notesValue || null }).eq('id', customer.id)
    setCustomer({ ...customer, notes: notesValue || null })
    setSavingNotes(false)
    setEditingNotes(false)
  }

  function startEditPrefs() {
    setPrefsDraft(toDraft(customer))
    setEditingPrefs(true)
  }
  async function savePrefs() {
    if (!customer) return
    setSavingPrefs(true)
    const row = draftToRow(prefsDraft)
    const { error } = await supabase.from('customers').update(row).eq('id', customer.id)
    if (!error) setCustomer({ ...customer, ...row })
    setSavingPrefs(false)
    setEditingPrefs(false)
  }

  function startEditPropPrefs(p: Property) {
    setPropPrefsDraft(toDraft(p))
    setEditingPropPrefs(p.id)
  }
  async function savePropPrefs(propId: string) {
    setSavingPropPrefs(true)
    const row = draftToRow(propPrefsDraft)
    const { error } = await supabase.from('properties').update(row).eq('id', propId)
    if (!error) setProperties(prev => prev.map(p => p.id === propId ? { ...p, ...row } : p))
    setSavingPropPrefs(false)
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
    if (!confirm(`Pause ${plan.serviceName}? This cancels ${futureIds.length} upcoming visit${futureIds.length !== 1 ? 's' : ''}. Past visits are kept, and you can schedule it again anytime.`)) return
    setPausing(plan.recurrenceId)
    const { error } = await supabase.from('jobs').update({ status: 'cancelled' }).in('id', futureIds)
    if (error) alert('Could not pause: ' + error.message)
    else setJobs(prev => prev.map(j => futureIds.includes(j.id) ? { ...j, status: 'cancelled' } : j))
    setPausing(null)
  }

  if (loading) return <div className="text-center py-16 text-sm text-ink-muted">Loading customer...</div>
  if (!customer) return <div className="text-center py-16 text-sm text-red-400">Customer not found.</div>

  const today = localToday()
  // Per-visit valuation so plans can show the initial vs recurring price.
  const quotesByIdLocal: Record<string, Quote> = {}
  for (const q of quotes) quotesByIdLocal[q.id] = q
  const recsByIdLocal: Record<string, JobRecurrence> = {}
  for (const r of recurrences) recsByIdLocal[r.id] = r
  const planValueOf = (j: Job) => {
    const q = j.quote_id ? quotesByIdLocal[j.quote_id] : null
    const rec = j.recurrence_id ? recsByIdLocal[j.recurrence_id] : null
    const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
    return jobVisitValue(j.price, q as unknown as Record<string, unknown>, freq, j.is_initial_visit)
  }
  const servicePlans = buildServicePlans(recurrences, jobs, seasons, today, planValueOf)

  // ── Revenue (three separate truths) ──
  const wonQuotes = quotes.filter(q => WON.has(q.status))
  const bookedRevenue = wonQuotes.reduce((s, q) => s + Number(q.total || 0), 0)
  const collectedRevenue = invoices.filter(i => i.status === 'paid').reduce((s, i) => s + Number(i.amount || 0), 0)
  const outstandingRevenue = invoices.filter(i => OPEN_INVOICE.has(i.status)).reduce((s, i) => s + Number(i.amount || 0), 0)
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
    openItems.push({ key: `inv-${inv.id}`, icon: Receipt, label: `${overdue ? 'Overdue' : 'Unpaid'} invoice ${inv.invoice_number}`, sub: `${formatCurrency(Number(inv.amount))}${inv.due_date ? ` · due ${formatDate(inv.due_date)}` : ''}`, href: '/dashboard/invoices', tone: overdue ? 'text-red-400' : 'text-amber-400' })
  }

  // ── Timeline ──
  const events: TimelineEvent[] = []
  for (const q of quotes) {
    events.push({ at: q.created_at, kind: 'quote_created', title: `Quote ${q.quote_number} created`, sub: `${q.service_type} · ${formatCurrency(Number(q.total))}`, href: `/dashboard/quotes/${q.id}` })
    if (q.sent_at) events.push({ at: q.sent_at, kind: 'quote_sent', title: `Quote ${q.quote_number} sent`, href: `/dashboard/quotes/${q.id}` })
    if (q.last_followed_up_at) events.push({ at: q.last_followed_up_at, kind: 'followup', title: `Followed up on ${q.quote_number}`, sub: `${q.follow_up_count} total`, href: `/dashboard/quotes/${q.id}` })
    if (WON.has(q.status)) events.push({ at: q.updated_at, kind: 'quote_accepted', title: `Quote ${q.quote_number} accepted`, sub: formatCurrency(Number(q.total)), href: `/dashboard/quotes/${q.id}` })
  }
  for (const j of jobs) {
    events.push({ at: j.created_at, kind: 'job_scheduled', title: `Job scheduled — ${j.title}`, sub: `for ${formatDate(j.scheduled_date)}` })
    if (j.status === 'completed') events.push({ at: j.updated_at, kind: 'job_completed', title: `Job completed — ${j.title}` })
  }
  for (const inv of invoices) {
    events.push({ at: inv.created_at, kind: 'invoice_created', title: `Invoice ${inv.invoice_number} created`, sub: formatCurrency(Number(inv.amount)) })
    if (inv.status === 'paid') events.push({ at: inv.updated_at, kind: 'invoice_paid', title: `Invoice ${inv.invoice_number} paid`, sub: formatCurrency(Number(inv.amount)) })
  }
  events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())

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
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => router.back()} className="text-ink-muted hover:text-ink transition-colors">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <PageHeader title={customer.name} description={`Customer since ${formatDate(customer.created_at)}`} />
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
              </div>
            </div>
          </div>

          {/* Quick actions — one tap, large targets */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Link href={`/dashboard/quotes/new?customer=${customer.id}`} className="h-11 rounded-xl flex items-center justify-center gap-1.5 text-sm font-medium bg-accent text-black hover:opacity-90 transition-opacity">
              <FilePlus className="w-4 h-4" /> New Quote
            </Link>
            <Link href={`/dashboard/schedule?customer=${customer.id}`} className="h-11 rounded-xl flex items-center justify-center gap-1.5 text-sm font-medium border border-border bg-surface text-ink hover:border-border-strong transition-colors">
              <CalendarPlus className="w-4 h-4" /> Schedule
            </Link>
            <a href={phone ? `tel:${phone}` : undefined} aria-disabled={!phone} className={`h-11 rounded-xl flex items-center justify-center gap-1.5 text-sm font-medium border transition-colors ${phone ? 'bg-surface border-border text-ink hover:border-border-strong' : 'border-border text-ink-faint pointer-events-none opacity-40'}`}>
              <Phone className="w-4 h-4" /> Call
            </a>
            <a href={phone ? `sms:${phone}` : undefined} aria-disabled={!phone} className={`h-11 rounded-xl flex items-center justify-center gap-1.5 text-sm font-medium border transition-colors ${phone ? 'bg-surface border-border text-ink hover:border-border-strong' : 'border-border text-ink-faint pointer-events-none opacity-40'}`}>
              <MessageSquare className="w-4 h-4" /> Text
            </a>
          </div>
        </CardBody>
      </Card>

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
            <div className="space-y-2">
              <textarea
                value={notesValue}
                onChange={e => setNotesValue(e.target.value)}
                rows={4}
                autoFocus
                placeholder="Gate codes, dog info, preferred contact, billing notes, access instructions, equipment restrictions..."
                className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all"
              />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={saveNotes} loading={savingNotes}>Save</Button>
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
                <Button size="sm" onClick={savePrefs} loading={savingPrefs}>Save</Button>
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

      {/* Open items — what needs action */}
      <Card className={openItems.length > 0 ? 'border-amber-500/30' : ''}>
        <CardHeader className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          <h2 className="text-sm font-semibold text-ink">Open Items</h2>
          {openItems.length > 0 && <span className="ml-auto text-xs font-semibold text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-full px-2 py-0.5">{openItems.length}</span>}
        </CardHeader>
        <CardBody className="p-0">
          {openItems.length === 0 ? (
            <p className="px-5 py-6 text-center text-sm text-ink-muted">Nothing needs action right now. 🎉</p>
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

      {/* Revenue + service history */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {revenueCards.map(c => {
          const Icon = c.icon
          return (
            <Card key={c.label} className="p-4 sm:p-5">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">{c.label}</p>
                <Icon className={`w-4 h-4 ${c.color}`} />
              </div>
              <p className="text-xl sm:text-2xl font-bold text-ink tracking-tight mt-2">{c.value}</p>
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
            <p className="text-sm text-ink-muted">No upcoming visits scheduled.</p>
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
              <p className="text-sm text-ink-muted">No history yet.</p>
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
              <p className="text-sm text-ink-muted">No properties on file.</p>
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
                  {/* Property actions — one tap each */}
                  <div className="grid grid-cols-4 gap-1.5 mt-3">
                    <a href={mapsUrl} target="_blank" rel="noopener noreferrer" title="Open in Google Maps" className="h-9 rounded-lg flex items-center justify-center gap-1 text-[11px] font-medium border border-border bg-surface text-ink-muted hover:text-ink hover:border-border-strong transition-colors">
                      <ExternalLink className="w-3.5 h-3.5" /> Maps
                    </a>
                    <Link href={`/dashboard/quotes/new?customer=${customer.id}`} title="New quote" className="h-9 rounded-lg flex items-center justify-center gap-1 text-[11px] font-medium border border-border bg-surface text-ink-muted hover:text-ink hover:border-border-strong transition-colors">
                      <FilePlus className="w-3.5 h-3.5" /> Quote
                    </Link>
                    <Link href={`/dashboard/schedule?customer=${customer.id}`} title="Schedule job" className="h-9 rounded-lg flex items-center justify-center gap-1 text-[11px] font-medium border border-border bg-surface text-ink-muted hover:text-ink hover:border-border-strong transition-colors">
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
                          <Button size="sm" onClick={() => savePropPrefs(p.id)} loading={savingPropPrefs}>Save</Button>
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

      {/* Referrals — advocates this customer brought in */}
      {referredCustomers.length > 0 && (
        <Card>
          <CardHeader className="flex items-center gap-2">
            <Users className="w-4 h-4 text-accent" />
            <h2 className="text-sm font-semibold text-ink">Referrals from {customer.name.split(' ')[0]}</h2>
            <span className="ml-auto text-xs text-ink-muted">{referredCustomers.length} referred · <span className="text-accent font-semibold">{formatCurrency(referredRevenue)}</span> generated</span>
          </CardHeader>
          <CardBody>
            <div className="flex flex-wrap gap-2">
              {referredCustomers.map(r => (
                <Link key={r.id} href={`/dashboard/customers/${r.id}`} className="text-xs flex items-center gap-1 text-ink border border-border rounded-lg px-2.5 py-1 hover:border-border-strong transition-colors">
                  {r.name}
                </Link>
              ))}
            </div>
          </CardBody>
        </Card>
      )}
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
        <Link href={`/dashboard/schedule?customer=${customerId}`}
          className="text-xs font-medium px-2.5 py-1 rounded-lg border border-border bg-surface text-ink hover:border-border-strong transition-colors">
          View schedule
        </Link>
        {!plan.paused && plan.nextVisitDate && (
          <Link href={`/dashboard/schedule?focus=${plan.recurrenceId}`}
            className="text-xs font-medium px-2.5 py-1 rounded-lg border border-border bg-surface text-ink hover:border-border-strong transition-colors">
            Edit schedule
          </Link>
        )}
        {!plan.paused && plan.remaining > 0 && (
          <Button variant="ghost" size="sm" loading={pausing} onClick={onPause} className="hover:text-amber-400">
            Pause schedule
          </Button>
        )}
        {plan.paused && (
          <Link href={`/dashboard/schedule?customer=${customerId}`}
            className="text-xs font-medium px-2.5 py-1 rounded-lg border border-emerald-500/25 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors">
            Resume / reschedule
          </Link>
        )}
      </div>
    </div>
  )
}
