'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Customer, Property, Quote, Job, Invoice, JobRecurrence, RECUR_FREQ_LABELS } from '@/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { formatCurrency, formatDate, getInitials } from '@/lib/utils'
import {
  ArrowLeft, Phone, MessageSquare, FilePlus, CalendarPlus, Mail, MapPin, Repeat,
  FileText, Send, RotateCw, CheckCircle2, Wrench, Receipt, DollarSign, Sparkles, Users,
} from 'lucide-react'

const WON = new Set(['accepted', 'scheduled', 'completed', 'paid'])

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
  const [properties, setProperties] = useState<Property[]>([])
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [recurrences, setRecurrences] = useState<JobRecurrence[]>([])
  const [loading, setLoading] = useState(true)

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
      setProperties((pRes.data as Property[]) || [])
      setQuotes((qRes.data as Quote[]) || [])
      setJobs((jRes.data as Job[]) || [])
      setInvoices((iRes.data as Invoice[]) || [])

      // Optional lookups — tolerate not-yet-migrated columns/tables.
      if (cust?.referred_by_customer_id) {
        const { data } = await supabase.from('customers').select('id, name').eq('id', cust.referred_by_customer_id).maybeSingle()
        if (data) setReferrer(data as { id: string; name: string })
      }
      const { data: recs } = await supabase.from('job_recurrences').select('*').eq('customer_id', id)
      if (recs) setRecurrences(recs as JobRecurrence[])

      setLoading(false)
    }
    load()
  }, [id])

  if (loading) return <div className="text-center py-16 text-sm text-ink-muted">Loading customer...</div>
  if (!customer) return <div className="text-center py-16 text-sm text-red-400">Customer not found.</div>

  // ── Lifetime value ──
  const wonQuotes = quotes.filter(q => WON.has(q.status))
  const totalRevenue = wonQuotes.reduce((s, q) => s + Number(q.total || 0), 0)
  const avgJobValue = wonQuotes.length > 0 ? totalRevenue / wonQuotes.length : 0
  const paidTotal = invoices.filter(i => i.status === 'paid').reduce((s, i) => s + Number(i.amount || 0), 0)

  // ── Upcoming work ──
  const today = localToday()
  const upcoming = jobs
    .filter(j => j.scheduled_date >= today && (j.status === 'scheduled' || j.status === 'in_progress'))
    .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))
  const nextVisit = upcoming[0] || null

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
  const isHighValue = totalRevenue >= 2000

  const stats = [
    { label: 'Total Revenue', value: formatCurrency(totalRevenue), sub: 'booked (won quotes)' },
    { label: 'Accepted Jobs', value: String(wonQuotes.length), sub: `of ${quotes.length} quote${quotes.length !== 1 ? 's' : ''}` },
    { label: 'Avg Job Value', value: formatCurrency(avgJobValue), sub: 'per won quote' },
    { label: 'Invoices', value: String(invoices.length), sub: `${formatCurrency(paidTotal)} paid` },
  ]

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => router.back()} className="text-ink-muted hover:text-ink transition-colors">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <PageHeader title={customer.name} description={`Customer since ${formatDate(customer.created_at)}`} />
      </div>

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

      {/* Lifetime value */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map(s => (
          <Card key={s.label} className="p-5">
            <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">{s.label}</p>
            <p className="text-2xl font-bold text-ink tracking-tight mt-2">{s.value}</p>
            <p className="text-xs text-ink-faint mt-1">{s.sub}</p>
          </Card>
        ))}
      </div>

      {/* Upcoming work */}
      <Card>
        <CardHeader className="flex items-center gap-2">
          <CalendarPlus className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold text-ink">Upcoming Work</h2>
          {nextVisit && <span className="ml-auto text-xs text-ink-muted">Next visit: <span className="text-accent font-semibold">{formatDate(nextVisit.scheduled_date)}</span></span>}
        </CardHeader>
        <CardBody className="space-y-3">
          {recurrences.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {recurrences.map(r => (
                <span key={r.id} className="text-xs flex items-center gap-1 text-accent border border-accent/20 bg-accent/10 rounded-lg px-2.5 py-1">
                  <Repeat className="w-3 h-3" /> {RECUR_FREQ_LABELS[r.freq]}{r.end_date ? ` until ${formatDate(r.end_date)}` : ' · ongoing'}
                </span>
              ))}
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
                </div>
              )
            })}
          </CardBody>
        </Card>
      </div>
    </div>
  )
}
