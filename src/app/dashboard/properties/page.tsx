'use client'
import { toast } from '@/lib/toast'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Property, BusinessSettings, Job, JobRecurrence } from '@/types'
import { buildServicePlans, ServicePlan } from '@/lib/recurrence'
import { settingsToSeasons } from '@/lib/seasons'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { formatDate, formatCurrency, localTodayISO } from '@/lib/utils'
import { pricingConfigFromSettings, pricingPackage, buildSavedRecommendation, estimateVisitMinutes, latestSavedRecommendation, recommendationIsStale, pricingConfidence } from '@/lib/pricing'
import { resolvePrefs, prefSummary, type PrefSource } from '@/lib/preferences'
import { computePropertyHealth } from '@/lib/propertyHealth'
import { getPropertyContexts } from '@/lib/ai/propertyContext'
import { LocatedJob, fetchLocatedUpcomingJobs, nearbyJobCount } from '@/lib/geo'
import { JobPhotos } from '@/components/photos/JobPhotos'
import { listPhotosForProperties, type JobPhotoView } from '@/lib/photos'
import { MapPin, Home, User, Ruler, History, RefreshCw, Trophy, DollarSign, CheckCircle2, Receipt, Timer, CalendarClock, AlertTriangle, Repeat, Camera, FileText, Clock, StickyNote, ShieldCheck, CalendarPlus, Lightbulb } from 'lucide-react'

// Quote statuses that count as a "won" price — the accepted-price memory.
const QUOTE_WON = new Set(['accepted', 'scheduled', 'completed', 'paid'])

// Per-property performance, aggregated from completed jobs + invoices. Reuses
// existing data — no new tables, no new pricing math.
interface PropPerf {
  lifetimeRevenue: number   // sum of paid invoices for this property
  completedVisits: number
  avgInvoice: number        // avg paid invoice amount
  avgActualMin: number | null
  lastActualMin: number | null  // actual minutes of the most recent timed completed visit
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
    (out[id] ||= { lifetimeRevenue: 0, completedVisits: 0, avgInvoice: 0, avgActualMin: null, lastActualMin: null, lastServiceDate: null })

  // Completed visits + actual-time + last service from jobs.
  const durSum: Record<string, number> = {}
  const durCount: Record<string, number> = {}
  const lastActualDate: Record<string, string> = {} // newest timed visit per property
  for (const j of jobs) {
    if (!j.property_id || j.status !== 'completed') continue
    const p = ensure(j.property_id)
    p.completedVisits++
    if (!p.lastServiceDate || j.scheduled_date > p.lastServiceDate) p.lastServiceDate = j.scheduled_date
    if (Number(j.actual_minutes) > 0) {
      durSum[j.property_id] = (durSum[j.property_id] || 0) + Number(j.actual_minutes)
      durCount[j.property_id] = (durCount[j.property_id] || 0) + 1
      if (!lastActualDate[j.property_id] || j.scheduled_date >= lastActualDate[j.property_id]) {
        lastActualDate[j.property_id] = j.scheduled_date
        p.lastActualMin = Number(j.actual_minutes)
      }
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
  // Property memory derived from existing tables — no new schema.
  const [nextVisitByProp, setNextVisitByProp] = useState<Record<string, { date: string; count: number }>>({})
  const [quotePricingByProp, setQuotePricingByProp] = useState<Record<string, { quoted: number; accepted: number; lastAccepted: { total: number; quote_number: string; date: string } | null }>>({})
  // Which properties already have an AI Vision analysis (fault-tolerant: empty when
  // the feature/table isn't present). Feeds the health score; never required.
  const [hasVisionByProp, setHasVisionByProp] = useState<Record<string, boolean>>({})
  // Photos for every property, fetched in ONE batched query (not N self-fetching
  // galleries) and handed to each card as initialPhotos.
  const [photosByProp, setPhotosByProp] = useState<Record<string, JobPhotoView[]>>({})
  const [photosLoaded, setPhotosLoaded] = useState(false) // false → let each card self-fetch (batch failed)
  const [recalcId, setRecalcId] = useState<string | null>(null)

  const supabase = createClient()

  useEffect(() => {
    async function fetchProperties() {
      const { data: { user } } = await supabase.auth.getUser()
      const [pRes, sRes, located, jRes, iRes, planJRes, rRes, qRes] = await Promise.all([
        supabase
          .from('properties')
          .select('*, customers(id, name, email, phone, preferred_days, avoid_days, pref_time_start, pref_time_end)')
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

      // Next upcoming visit + upcoming count per property (from the jobs already fetched).
      const today = localTodayISO()
      const nextV: Record<string, { date: string; count: number }> = {}
      for (const j of (jRes.data as PerfJob[]) || []) {
        if (!j.property_id || (j.status !== 'scheduled' && j.status !== 'in_progress') || j.scheduled_date < today) continue
        const cur = nextV[j.property_id]
        if (!cur) nextV[j.property_id] = { date: j.scheduled_date, count: 1 }
        else { cur.count++; if (j.scheduled_date < cur.date) cur.date = j.scheduled_date }
      }
      setNextVisitByProp(nextV)

      // Pricing memory: how many times quoted, how many accepted, and the last
      // accepted price — the real signal for future pricing (reuses qRes).
      const qp: Record<string, { quoted: number; accepted: number; lastAccepted: { total: number; quote_number: string; date: string } | null }> = {}
      for (const q of (qRes.data as QuoteRow[]) || []) {
        if (!q.property_id) continue
        const e = (qp[q.property_id] ||= { quoted: 0, accepted: 0, lastAccepted: null })
        e.quoted++
        if (QUOTE_WON.has(q.status)) {
          e.accepted++
          if (!e.lastAccepted || q.created_at > e.lastAccepted.date) e.lastAccepted = { total: Number(q.total) || 0, quote_number: q.quote_number, date: q.created_at }
        }
      }
      setQuotePricingByProp(qp)

      // Group service plans by property (one recurring series may touch a property).
      const seasons = settingsToSeasons(settingsRow?.service_seasons)
      const planJobs = (planJRes.data as Job[]) || []
      const allPlans = buildServicePlans((rRes.data as JobRecurrence[]) || [], planJobs, seasons, localTodayISO())
      const byProp: Record<string, ServicePlan[]> = {}
      for (const plan of allPlans) if (plan.propertyId) (byProp[plan.propertyId] ||= []).push(plan)
      setPlansByProp(byProp)

      // AI Vision reuse — which properties already have an analysis (one query,
      // fault-tolerant: empty map if the table/feature isn't present). Feeds the
      // health score; nothing breaks when AI Vision hasn't been wired in yet.
      const propIds = ((pRes.data as Property[]) || []).map(p => p.id)
      // ONE batched photo read for every property (replaces N per-card gallery
      // fetches) + AI Vision presence — in parallel.
      const [visionMap, photoRes] = await Promise.all([
        getPropertyContexts(supabase, propIds).catch(() => new Map()),
        listPhotosForProperties(supabase, user!.id, propIds).then(m => ({ ok: true, m })).catch(() => ({ ok: false, m: {} as Record<string, JobPhotoView[]> })),
      ])
      if (visionMap.size) setHasVisionByProp(Object.fromEntries(propIds.map(id => [id, visionMap.has(id)])))
      // Only seed the cards from the batch if it succeeded; on failure leave photosLoaded
      // false so each card falls back to its own fetch (no false "No photos yet").
      if (photoRes.ok) { setPhotosByProp(photoRes.m); setPhotosLoaded(true) }
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
      if (error) toast.error('Could not recalculate: ' + error.message)
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
        <SkeletonRows count={6} />
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
            // Property memory (all derived from data already loaded).
            const prefText = prefSummary(resolvePrefs(property.customers as unknown as PrefSource | null, property as unknown as PrefSource))
            const nextVisit = nextVisitByProp[property.id]
            const qp = quotePricingByProp[property.id]
            const nearby = property.lat != null && property.lng != null ? nearbyJobCount({ lat: property.lat, lng: property.lng }, locatedJobs).count : 0
            const confidence = saved ? pricingConfidence({ hasMeasurement: true, nearbyComparables: nearby }) : null
            const estMin = perf?.avgActualMin ?? saved?.rec.est_minutes ?? null
            const estFromActual = perf?.avgActualMin != null
            const measured = !!saved || Number(property.lawn_sqft) > 0
            const hasWonQuote = (qp?.accepted ?? 0) > 0

            // Active recurring service (the dominant non-paused plan).
            const activePlan = plans.find(p => !p.paused) ?? null
            // Last actual visit vs the estimate (when both exist).
            const estDur = saved?.rec.est_minutes ?? null
            const durDelta = perf?.lastActualMin != null && estDur != null ? perf.lastActualMin - estDur : null
            // Pricing drift: what was last accepted/quoted vs what we'd recommend now.
            const lastPriceVal = qp?.lastAccepted?.total ?? lastQuote?.total ?? null
            const recOneTime = saved?.rec.one_time ?? null
            const drift = lastPriceVal && lastPriceVal > 0 && recOneTime ? Math.round(((recOneTime - lastPriceVal) / lastPriceVal) * 100) : null
            const driftBig = drift != null && Math.abs(drift) >= 15
            // ── One Property Health score → one recommendation → one primary
            // action. Consolidates every signal above so the card guides instead
            // of listing (reuses the one lib/propertyHealth engine). ──
            const daysSinceISO = (iso: string) => Math.floor((Date.now() - new Date(iso + 'T00:00:00').getTime()) / 86400000)
            const health = computePropertyHealth({
              hasCustomer: !!property.customer_id,
              measured,
              measurementStale: stale,
              located: property.lat != null && property.lng != null,
              pricingConfidence: confidence,
              completedVisits: perf?.completedVisits ?? 0,
              hasActiveRecurring: !!activePlan,
              recurringNothingScheduled: !!activePlan && !nextVisit,
              daysSinceLastService: perf?.lastServiceDate ? daysSinceISO(perf.lastServiceDate) : null,
              hasUpcoming: !!nextVisit,
              hasWonQuote,
              quotedCount: qp?.quoted ?? 0,
              pricingDriftPct: drift,
              hasVision: !!hasVisionByProp[property.id],
            })
            const measureHref = `/dashboard/properties/measure?id=${property.id}`
            const actionHref = health.action === 'quote' ? `/dashboard/quotes/new?customer=${property.customer_id}&property=${property.id}`
              : health.action === 'schedule' ? `/dashboard/schedule?customer=${property.customer_id}&property=${property.id}`
              : measureHref
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
                        {activePlan && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border uppercase tracking-wide bg-accent/10 text-accent border-accent/20">
                            <Repeat className="w-2.5 h-2.5" /> {activePlan.cadenceLabel}
                          </span>
                        )}
                        {/* One overall health score — measurement, pricing, history, recurring, scheduling, AI Vision */}
                        <span title="Property health — measurement freshness, pricing confidence, service history, recurring status, scheduling & AI Vision"
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                            health.tone === 'good' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                            : health.tone === 'warn' ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                            : health.tone === 'new' ? 'border-sky-500/30 bg-sky-500/10 text-sky-300'
                            : 'border-accent/20 bg-accent/10 text-accent'}`}>
                          ♥ {health.score} · {health.label}
                        </span>
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
                      {property.lawn_sqft ? (
                        <p className="text-xs text-ink-muted flex items-center gap-1.5">
                          <Ruler className="w-3 h-3 text-ink-faint shrink-0" />
                          <span className="font-semibold text-ink">{Number(property.lawn_sqft).toLocaleString()} ft²</span> lawn
                          {property.fence_length ? <span className="text-ink-faint">· {property.fence_length} ft fence</span> : null}
                        </p>
                      ) : property.fence_length ? (
                        <p className="text-xs text-ink-faint flex items-center gap-1.5"><Ruler className="w-3 h-3 shrink-0" /> {property.fence_length} ft fence</p>
                      ) : null}
                      {last && (
                        <p className="text-xs text-ink-faint flex items-center gap-1">
                          <History className="w-3 h-3 shrink-0" />
                          Measured {formatDate(last.date)}
                          {hist.length > 1 && <span>· {hist.length}× measured</span>}
                          {Array.isArray(property.lawn_polygon) && property.lawn_polygon.length > 0 && <span className="text-accent">· boundary saved</span>}
                          {stale && <span className="text-amber-400">· may be outdated</span>}
                        </p>
                      )}
                      {(perf?.lastServiceDate || nextVisit) && (
                        <p className="text-xs text-ink-faint flex items-center gap-1">
                          <CalendarClock className="w-3 h-3 shrink-0 text-accent" />
                          {perf?.lastServiceDate && <>Last service {formatDate(perf.lastServiceDate)}</>}
                          {perf?.lastServiceDate && nextVisit && <span> · </span>}
                          {nextVisit && <>Next {formatDate(nextVisit.date)}{nextVisit.count > 1 ? ` (${nextVisit.count})` : ''}</>}
                        </p>
                      )}
                      {prefText && (
                        <p className="text-xs text-ink-faint flex items-center gap-1">
                          <Clock className="w-3 h-3 shrink-0" /> {prefText}
                        </p>
                      )}
                      {property.notes && (
                        <p className="text-xs text-ink-faint flex items-start gap-1">
                          <StickyNote className="w-3 h-3 shrink-0 mt-0.5" /> <span className="line-clamp-2">{property.notes}</span>
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-stretch gap-1.5 shrink-0 w-[150px]">
                    {/* The ONE primary action for this property's current state. */}
                    {health.action === 'recalc' ? (
                      <Button size="sm" loading={recalcId === property.id} onClick={() => recalculate(property)} className="w-full">
                        <RefreshCw className="w-3.5 h-3.5" /> {health.actionLabel}
                      </Button>
                    ) : (
                      <Link href={actionHref}>
                        <Button size="sm" className="w-full">
                          {health.action === 'quote' ? <FileText className="w-3.5 h-3.5" />
                            : health.action === 'schedule' ? <CalendarPlus className="w-3.5 h-3.5" />
                            : <Ruler className="w-3.5 h-3.5" />}
                          {health.actionLabel}
                        </Button>
                      </Link>
                    )}
                    {/* Quiet utility — re-measuring is always one tap away, but never competes as the primary. */}
                    {health.action !== 'measure' && health.action !== 'remeasure' && (
                      <Link href={measureHref} className="text-[11px] text-ink-faint hover:text-ink text-right">Re-measure</Link>
                    )}
                    {property.lat && property.lng ? (
                      <p className="text-xs text-accent font-medium text-right">📍 Located</p>
                    ) : (
                      <p className="text-xs text-ink-faint text-right">No coords yet</p>
                    )}
                  </div>
                </div>

                {/* THE single highest-priority recommendation — what to do next,
                    not a wall of equal nudges. The matching primary action button
                    lives in the action column. */}
                {health.recommendation && (
                  <div className={`mt-3 flex items-center gap-2 rounded-xl border px-3 py-2 ${health.tone === 'warn' ? 'border-amber-500/30 bg-amber-500/10' : 'border-accent/25 bg-accent/[0.06]'}`}>
                    {health.tone === 'warn'
                      ? <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                      : <Lightbulb className="w-4 h-4 text-accent shrink-0" />}
                    <p className="text-xs text-ink flex-1 min-w-0">{health.recommendation}</p>
                  </div>
                )}

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

                {/* Pricing memory — what this property has been quoted and accepted
                    before (the real signal for what they'll pay next time). */}
                {qp && qp.quoted > 0 && (
                  <div className="mt-3 rounded-xl border border-border bg-bg-tertiary px-3 py-2 flex items-center gap-x-3 gap-y-1 flex-wrap text-xs">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Pricing memory</span>
                    {qp.lastAccepted ? (
                      <span className="text-emerald-400 font-medium inline-flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> Last accepted {formatCurrency(qp.lastAccepted.total)} · {qp.lastAccepted.quote_number}
                      </span>
                    ) : (
                      <span className="text-ink-muted">No accepted quote yet</span>
                    )}
                    <span className="text-ink-faint">{qp.quoted} quoted · {qp.accepted} accepted</span>
                    {drift != null && recOneTime != null && (
                      <span className={driftBig ? 'text-amber-400 font-medium' : 'text-ink-faint'} title="Current recommended one-time vs the last price">
                        now ~{formatCurrency(recOneTime)} ({drift > 0 ? '+' : ''}{drift}%)
                      </span>
                    )}
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
                    {/* Estimated visit length + pricing confidence */}
                    {(estMin != null || confidence) && (
                      <div className="flex items-center gap-3 flex-wrap mt-2 pt-2 border-t border-accent/15 text-[11px] text-ink-muted">
                        {durDelta != null && estDur != null && perf?.lastActualMin != null ? (
                          <span className="inline-flex items-center gap-1" title="Last actual visit vs the estimate">
                            <Timer className="w-3 h-3" /> Last visit {perf.lastActualMin}m vs ~{estDur}m est
                            <span className={durDelta > 10 ? 'text-amber-400' : durDelta < -5 ? 'text-emerald-400' : 'text-ink-faint'}>({durDelta > 0 ? '+' : ''}{durDelta}m)</span>
                          </span>
                        ) : estMin != null ? (
                          <span className="inline-flex items-center gap-1"><Timer className="w-3 h-3" /> Est. visit ~{estMin} min{estFromActual ? <span className="text-ink-faint"> · avg of {perf!.completedVisits}</span> : null}</span>
                        ) : null}
                        {confidence && (
                          <span className="inline-flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> {confidence[0].toUpperCase() + confidence.slice(1)} confidence</span>
                        )}
                      </div>
                    )}
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
                  <JobPhotos propertyId={property.id} customerId={property.customer_id} variant="gallery" initialPhotos={photosLoaded ? (photosByProp[property.id] || []) : undefined} />
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