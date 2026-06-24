'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Property, BusinessSettings, Job, JobRecurrence } from '@/types'
import { buildServicePlans, ServicePlan } from '@/lib/recurrence'
import { settingsToSeasons } from '@/lib/seasons'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { formatDate, formatCurrency, localTodayISO } from '@/lib/utils'
import { pricingConfigFromSettings, pricingPackage, buildSavedRecommendation, estimateVisitMinutes, latestSavedRecommendation, recommendationIsStale } from '@/lib/pricing'
import { LocatedJob, fetchLocatedUpcomingJobs, nearbyJobCount } from '@/lib/geo'
import { JobPhotos } from '@/components/photos/JobPhotos'
import { MapPin, Home, User, Ruler, History, RefreshCw, Trophy, DollarSign, CheckCircle2, Receipt, Timer, CalendarClock, AlertTriangle, Repeat, Camera, FileText } from 'lucide-react'

// Per-property performance, aggregated from completed jobs + invoices. Reuses
// existing data — no new tables, no new pricing math.
interface PropPerf {
  lifetimeRevenue: number   // sum of paid invoices for this property
  completedVisits: number
  avgInvoice: number        // avg paid invoice amount
  avgActualMin: number | null
  lastServiceDate: string | null
}
type PerfJob = { property_id: string | null; status: string; scheduled_date: string; actual_minutes: number | null }
type PerfInvoice = { property_id: string | null; amount: number | null; status: string }
type InvoiceRow = { id: string; property_id: string | null; invoice_number: string; amount: number | null; status: string; issued_date: string | null; created_at: string }
type QuoteRow = { id: string; property_id: string | null; quote_number: string; total: number | null; status: string; created_at: string }
type LastQuote = { id: string; quote_number: string; total: number; status: string; date: string }
type LastInvoice = { id: string; invoice_number: string; status: string; date: string }

function buildPerformance(jobs: PerfJob[], invoices: PerfInvoice[]): Record<string, PropPerf> {
  const out: Record<string, PropPerf> = {}
  const ensure = (id: string): PropPerf =>
    (out[id] ||= { lifetimeRevenue: 0, completedVisits: 0, avgInvoice: 0, avgActualMin: null, lastServiceDate: null })

  // Completed visits + actual-time + last service from jobs.
  const durSum: Record<string, number> = {}
  const durCount: Record<string, number> = {}
  for (const j of jobs) {
    if (!j.property_id || j.status !== 'completed') continue
    const p = ensure(j.property_id)
    p.completedVisits++
    if (!p.lastServiceDate || j.scheduled_date > p.lastServiceDate) p.lastServiceDate = j.scheduled_date
    if (Number(j.actual_minutes) > 0) {
      durSum[j.property_id] = (durSum[j.property_id] || 0) + Number(j.actual_minutes)
      durCount[j.property_id] = (durCount[j.property_id] || 0) + 1
    }
  }
  for (const id of Object.keys(durCount)) out[id].avgActualMin = Math.round(durSum[id] / durCount[id])

  // Lifetime revenue + avg invoice from PAID invoices.
  const paidSum: Record<string, number> = {}
  const paidCount: Record<string, number> = {}
  for (const inv of invoices) {
    if (!inv.property_id || inv.status !== 'paid') continue
    const amt = Number(inv.amount) || 0
    ensure(inv.property_id)
    paidSum[inv.property_id] = (paidSum[inv.property_id] || 0) + amt
    paidCount[inv.property_id] = (paidCount[inv.property_id] || 0) + 1
  }
  for (const id of Object.keys(paidSum)) {
    out[id].lifetimeRevenue = Math.round(paidSum[id])
    out[id].avgInvoice = Math.round(paidSum[id] / paidCount[id])
  }
  return out
}

export default function PropertiesPage() {
  const router = useRouter()
  const [properties, setProperties] = useState<Property[]>([])
  const [loading, setLoading] = useState(true)
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [locatedJobs, setLocatedJobs] = useState<LocatedJob[]>([])
  const [perfByProp, setPerfByProp] = useState<Record<string, PropPerf>>({})
  const [lastQuoteByProp, setLastQuoteByProp] = useState<Record<string, LastQuote>>({})
  const [lastInvoiceByProp, setLastInvoiceByProp] = useState<Record<string, LastInvoice>>({})
  const [plansByProp, setPlansByProp] = useState<Record<string, ServicePlan[]>>({})
  const [recalcId, setRecalcId] = useState<string | null>(null)

  const supabase = createClient()

  useEffect(() => {
    async function fetchProperties() {
      const { data: { user } } = await supabase.auth.getUser()
      const [pRes, sRes, located, jRes, iRes, planJRes, rRes, qRes] = await Promise.all([
        supabase
          .from('properties')
          .select('*, customers(id, name, email, phone)')
          .eq('user_id', user!.id)
          .order('created_at', { ascending: false }),
        supabase.from('business_settings').select('*').eq('user_id', user!.id).maybeSingle(),
        fetchLocatedUpcomingJobs(supabase, user!.id),
        supabase.from('jobs').select('property_id, status, scheduled_date, actual_minutes').eq('user_id', user!.id),
        supabase.from('invoices').select('id, property_id, invoice_number, amount, status, issued_date, created_at').eq('user_id', user!.id),
        // Recurring visits (full fields buildServicePlans needs) + their series.
        supabase.from('jobs').select('id, property_id, recurrence_id, service_type, scheduled_date, status').not('recurrence_id', 'is', null).eq('user_id', user!.id),
        supabase.from('job_recurrences').select('*').eq('user_id', user!.id),
        // Last quote per property (most recent non-draft).
        supabase.from('quotes').select('id, property_id, quote_number, total, status, created_at').eq('user_id', user!.id).neq('status', 'draft'),
      ])
      const settingsRow = sRes.data as BusinessSettings | null
      setProperties((pRes.data as Property[]) || [])
      setSettings(settingsRow)
      setLocatedJobs(located)
      setPerfByProp(buildPerformance((jRes.data as PerfJob[]) || [], (iRes.data as PerfInvoice[]) || []))

      // Last quote + last invoice per property (reuses the fetches above — no new tables).
      const lastQ: Record<string, LastQuote> = {}
      for (const q of (qRes.data as QuoteRow[]) || []) {
        if (!q.property_id) continue
        const cur = lastQ[q.property_id]
        if (!cur || q.created_at > cur.date) lastQ[q.property_id] = { id: q.id, quote_number: q.quote_number, total: Number(q.total) || 0, status: q.status, date: q.created_at }
      }
      setLastQuoteByProp(lastQ)
      const lastI: Record<string, LastInvoice> = {}
      for (const inv of (iRes.data as InvoiceRow[]) || []) {
        if (!inv.property_id) continue
        const d = inv.issued_date || inv.created_at
        const cur = lastI[inv.property_id]
        if (!cur || d > cur.date) lastI[inv.property_id] = { id: inv.id, invoice_number: inv.invoice_number, status: inv.status, date: d }
      }
      setLastInvoiceByProp(lastI)

      // Group service plans by property (one recurring series may touch a property).
      const seasons = settingsToSeasons(settingsRow?.service_seasons)
      const planJobs = (planJRes.data as Job[]) || []
      const allPlans = buildServicePlans((rRes.data as JobRecurrence[]) || [], planJobs, seasons, localTodayISO())
      const byProp: Record<string, ServicePlan[]> = {}
      for (const plan of allPlans) if (plan.propertyId) (byProp[plan.propertyId] ||= []).push(plan)
      setPlansByProp(byProp)
      setLoading(false)
    }
    fetchProperties()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-run the pricing engine on the saved measurement with TODAY's rates and
  // route context — appends a new snapshot (history preserved, never overwritten).
  async function recalculate(p: Property) {
    const latest = latestSavedRecommendation(p.measurement_history)
    const sqft = latest?.sqft || Number(p.lawn_sqft) || 0
    if (sqft <= 0) return
    setRecalcId(p.id)
    try {
      const cfg = pricingConfigFromSettings(settings)
      const nearby = p.lat != null && p.lng != null ? nearbyJobCount({ lat: p.lat, lng: p.lng }, locatedJobs).count : 0
      const pkg = pricingPackage(sqft, cfg, { overgrowth: 1, nearbyCount: nearby, neighborhoodName: p.neighborhood })
      const rec = buildSavedRecommendation(pkg, estimateVisitMinutes(sqft), { hood: p.neighborhood })
      const hist = Array.isArray(p.measurement_history) ? p.measurement_history : []
      const snapshot = { date: new Date().toISOString(), total_sqft: sqft, recommendation: rec }
      const nextHistory = [...hist, snapshot]
      const { error } = await supabase.from('properties').update({ measurement_history: nextHistory }).eq('id', p.id)
      if (error) alert('Could not recalculate: ' + error.message)
      else setProperties(prev => prev.map(x => x.id === p.id ? { ...x, measurement_history: nextHistory as Property['measurement_history'] } : x))
    } finally { setRecalcId(null) }
  }

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="Properties"
        description={`${properties.length} propert${properties.length !== 1 ? 'ies' : 'y'} on file`}
      />

      {loading ? (
        <div className="text-center py-16 text-sm text-ink-muted">Loading properties...</div>
      ) : properties.length === 0 ? (
        <EmptyState
          icon={Home}
          title="No properties yet"
          description="Properties are created automatically when you add a customer or save a quote. Add your first customer to get started."
          action={{ label: 'Add a customer', onClick: () => router.push('/dashboard/customers') }}
        />
      ) : (
        <div className="space-y-3">
          {properties.map(property => {
            const hist = Array.isArray(property.measurement_history) ? property.measurement_history : []
            const last = hist.length ? hist[hist.length - 1] : null
            const saved = latestSavedRecommendation(hist)
            const stale = saved ? recommendationIsStale(saved.date, Date.now()) : false
            const perf = perfByProp[property.id]
            const hasPerf = perf && (perf.completedVisits > 0 || perf.lifetimeRevenue > 0)
            const lastQuote = lastQuoteByProp[property.id]
            const lastInvoice = lastInvoiceByProp[property.id]
            const plans = plansByProp[property.id] || []
            return (
            <Card key={property.id}>
              <CardBody>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 mt-0.5">
                      <Home className="w-4 h-4 text-accent" />
                    </div>
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-ink">{property.address}</p>
                        {property.is_primary && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border uppercase tracking-wide bg-accent-dim text-accent border-accent/20">
                            Primary
                          </span>
                        )}
                      </div>
                      {(property.city || property.province) && (
                        <p className="text-xs text-ink-muted flex items-center gap-1">
                          <MapPin className="w-3 h-3" />
                          {[property.city, property.province, property.postal_code].filter(Boolean).join(', ')}
                        </p>
                      )}
                      {property.customers && (
                        <p className="text-xs text-ink-faint flex items-center gap-1">
                          <User className="w-3 h-3" />
                          {property.customers.name}
                        </p>
                      )}
                      {(property.lawn_sqft || property.fence_length) && (
                        <p className="text-xs text-ink-faint">
                          {property.lawn_sqft ? `Lawn ${property.lawn_sqft} ft²` : ''}
                          {property.lawn_sqft && property.fence_length ? ' · ' : ''}
                          {property.fence_length ? `Fence ${property.fence_length} ft` : ''}
                        </p>
                      )}
                      {last && (
                        <p className="text-xs text-ink-faint flex items-center gap-1">
                          <History className="w-3 h-3" />
                          Last measured {formatDate(last.date)} · {(last.total_sqft ?? last.lawn_sqft ?? 0).toLocaleString()} ft²
                          {hist.length > 1 && <span className="text-ink-faint">· {hist.length} measurements</span>}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2 shrink-0">
                    <Link href={`/dashboard/properties/measure?id=${property.id}`}>
                      <Button variant="secondary" size="sm">
                        <Ruler className="w-3.5 h-3.5" /> Measure
                      </Button>
                    </Link>
                    {property.lat && property.lng ? (
                      <p className="text-xs text-accent font-medium">📍 Located</p>
                    ) : (
                      <p className="text-xs text-ink-faint">No coords yet</p>
                    )}
                  </div>
                </div>

                {/* Current Service Plan — the recurring schedule at a glance */}
                {plans.length > 0 && (
                  <div className="mt-3 space-y-1.5">
                    {plans.map(plan => (
                      <div key={plan.recurrenceId}
                        className={`rounded-xl border px-3 py-2 flex items-center justify-between gap-3 ${plan.paused ? 'border-border bg-bg-tertiary' : 'border-accent/20 bg-accent/5'}`}>
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-ink flex items-center gap-1.5 truncate">
                            <Repeat className={`w-3 h-3 shrink-0 ${plan.paused ? 'text-ink-faint' : 'text-accent'}`} />
                            {plan.serviceName}
                            {plan.paused && <span className="text-[9px] font-semibold uppercase tracking-wide text-ink-faint border border-border rounded px-1 py-0.5">Paused</span>}
                          </p>
                          <p className="text-[11px] text-ink-muted truncate">
                            {plan.cadenceLabel}{plan.weekday && ` · ${plan.weekday}`}{plan.windowLabel && ` · ${plan.windowLabel}`}
                            {!plan.paused && ` · ${plan.remaining} visit${plan.remaining !== 1 ? 's' : ''} remaining`}
                          </p>
                        </div>
                        {property.customer_id && (
                          <Link href={`/dashboard/schedule?focus=${plan.recurrenceId}`}
                            className="text-[11px] font-medium px-2 py-1 rounded-lg border border-border bg-surface text-ink hover:border-border-strong transition-colors shrink-0">
                            View
                          </Link>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Performance — this property as a business asset */}
                {hasPerf && (
                  <div className="mt-3 rounded-xl border border-border bg-bg-tertiary px-3 py-2.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted mb-1.5">Performance</p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                      <PerfStat icon={DollarSign} label="Lifetime revenue" value={formatCurrency(perf.lifetimeRevenue)} tone="text-accent" />
                      <PerfStat icon={CheckCircle2} label="Completed visits" value={String(perf.completedVisits)} />
                      <PerfStat icon={Receipt} label="Avg invoice" value={perf.avgInvoice > 0 ? formatCurrency(perf.avgInvoice) : '—'} />
                      <PerfStat icon={Timer} label="Avg service time" value={perf.avgActualMin != null ? `${perf.avgActualMin} min` : '—'} />
                      <PerfStat icon={CalendarClock} label="Last service" value={perf.lastServiceDate ? formatDate(perf.lastServiceDate) : '—'} />
                    </div>
                  </div>
                )}

                {/* Last quote + last invoice — most recent paperwork at a glance */}
                {(lastQuote || lastInvoice) && (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {lastQuote ? (
                      <Link href={`/dashboard/quotes/${lastQuote.id}`} className="rounded-xl border border-border bg-bg-tertiary px-3 py-2 hover:border-border-strong transition-colors">
                        <p className="text-[10px] uppercase tracking-wide text-ink-faint flex items-center gap-1"><FileText className="w-3 h-3" /> Last quote</p>
                        <p className="text-sm font-semibold text-ink truncate">{lastQuote.quote_number} · {formatCurrency(lastQuote.total)}</p>
                        <p className="text-[10px] text-ink-faint">{formatDate(lastQuote.date)} · {lastQuote.status}</p>
                      </Link>
                    ) : <div />}
                    {lastInvoice ? (
                      <Link href="/dashboard/invoices" className="rounded-xl border border-border bg-bg-tertiary px-3 py-2 hover:border-border-strong transition-colors">
                        <p className="text-[10px] uppercase tracking-wide text-ink-faint flex items-center gap-1"><Receipt className="w-3 h-3" /> Last invoice</p>
                        <p className="text-sm font-semibold text-ink truncate">{lastInvoice.invoice_number}</p>
                        <p className="text-[10px] text-ink-faint">{formatDate(lastInvoice.date)} · {lastInvoice.status}</p>
                      </Link>
                    ) : <div />}
                  </div>
                )}

                {/* Latest measurement — the saved pricing source of truth */}
                {saved && (
                  <div className="mt-3 rounded-xl border border-accent/20 bg-accent/5 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-accent">
                        Latest measurement · {saved.sqft.toLocaleString()} ft² · Calculated {formatDate(saved.date)}
                      </p>
                      <Button variant="ghost" size="sm" loading={recalcId === property.id} onClick={() => recalculate(property)} title="Re-run pricing with today's rates and route context">
                        <RefreshCw className="w-3.5 h-3.5" /> Recalculate
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-1.5">
                      {([['One-Time', saved.rec.one_time, 'one_time'], ['Weekly', saved.rec.weekly, 'weekly'], ['Bi-Weekly', saved.rec.biweekly, 'biweekly'], ['Monthly', saved.rec.monthly, 'monthly']] as const).map(([label, price, key]) => (
                        <div key={label} className={`rounded-lg border px-2 py-1.5 ${saved.rec.cadence === key ? 'border-accent/50 bg-accent/10' : 'border-border bg-bg-tertiary'}`}>
                          <p className="text-[10px] uppercase tracking-wide text-ink-faint flex items-center gap-1">{label}{saved.rec.cadence === key && <Trophy className="w-2.5 h-2.5 text-accent" />}</p>
                          <p className="text-sm font-bold text-ink">${price}</p>
                        </div>
                      ))}
                    </div>
                    {stale && (
                      <p className="mt-2 text-xs text-amber-400 flex items-center gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        Pricing recommendations may be outdated. Consider recalculating.
                      </p>
                    )}
                  </div>
                )}

                {/* Photos — visual service history (before/after, proof of work) */}
                <div className="mt-3 rounded-xl border border-border bg-bg-tertiary px-3 py-2.5">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted mb-2 flex items-center gap-1.5">
                    <Camera className="w-3.5 h-3.5" /> Photos
                  </p>
                  <JobPhotos propertyId={property.id} customerId={property.customer_id} variant="gallery" />
                </div>
              </CardBody>
            </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

function PerfStat({ icon: Icon, label, value, tone }: { icon: typeof DollarSign; label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-2 py-1.5">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint flex items-center gap-1">
        <Icon className="w-3 h-3" /> {label}
      </p>
      <p className={`text-sm font-bold ${tone || 'text-ink'}`}>{value}</p>
    </div>
  )
}