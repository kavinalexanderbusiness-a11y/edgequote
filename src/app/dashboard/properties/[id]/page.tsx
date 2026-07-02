'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { Customer, Invoice, Job, JobRecurrence, Property, Quote } from '@/types'
import { crewCostPerHour, visitEconomics } from '@/lib/economics'
import { pricingConfigFromSettings, pricingPackage } from '@/lib/pricing'
import { buildServicePlans, ServicePlan } from '@/lib/recurrence'
import { settingsToSeasons, DEFAULT_SEASONS } from '@/lib/seasons'
import { listPhotos, type JobPhotoView } from '@/lib/photos'
import type { PropertyTwin } from '@/lib/vision/types'
import { TwinPanel } from '@/components/grow/vision/TwinPanel'
import { Timeline } from '@/components/ui/Timeline'
import {
  eventsFromQuotes, eventsFromJobs, eventsFromInvoices, fetchTimelineExtras, sortTimeline, type TimelineEvent,
} from '@/lib/timeline'
import { PropertyMeasurementHistory } from '@/components/properties/PropertyMeasurementHistory'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { StatTile } from '@/components/ui/StatTile'
import { PageSkeleton } from '@/components/ui/Skeleton'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { formatCurrency, formatDate, localTodayISO } from '@/lib/utils'
import { JOB_STATUS_COLORS, JOB_STATUS_LABELS } from '@/types'
import { cn } from '@/lib/utils'
import {
  ArrowLeft, MapPin, Ruler, Eye, FilePlus, CalendarPlus, Leaf, Home, DollarSign,
  TrendingUp, Timer, Wallet, CalendarClock, Camera, Repeat, Target, History,
} from 'lucide-react'

// ── Property page — the property's home ─────────────────────────────────────────
// ONE place that shows everything about a single property: what it is (sizes,
// measurements), what it's worth (revenue, profit, the customer's value), what's
// happening (visits, photos, timeline) and what the AI knows (the digital twin).
// Every number comes from an EXISTING engine — economics, pricing, recurrence,
// the vision twin — never a local re-implementation.

type InvRow = Invoice & { amount_paid?: number | null }

// Collected dollars for one invoice: the ledger's amount_paid when the payment
// migration is live, else the classic status check.
function collected(inv: InvRow): number {
  if (inv.amount_paid != null) return Number(inv.amount_paid)
  return inv.status === 'paid' ? Number(inv.amount) : 0
}

export default function PropertyDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [tick, setTick] = useState(0)

  const [property, setProperty] = useState<Property | null>(null)
  const [customer, setCustomer] = useState<Pick<Customer, 'id' | 'name'> | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [invoices, setInvoices] = useState<InvRow[]>([])
  const [customerInvoices, setCustomerInvoices] = useState<InvRow[]>([])
  const [twin, setTwin] = useState<PropertyTwin | null>(null)
  const [photos, setPhotos] = useState<JobPhotoView[]>([])
  const [plans, setPlans] = useState<ServicePlan[]>([])
  const [extraEvents, setExtraEvents] = useState<TimelineEvent[]>([])
  const [pricing, setPricing] = useState<ReturnType<typeof pricingPackage> | null>(null)
  const [crewCost, setCrewCost] = useState(crewCostPerHour(null))
  const [notFound, setNotFound] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data: prop } = await supabase
        .from('properties').select('*, customers(id, name)')
        .eq('id', id).eq('user_id', user.id).maybeSingle()
      if (!active) return
      if (!prop) { setNotFound(true); setLoading(false); return }
      const p = prop as Property & { customers: Pick<Customer, 'id' | 'name'> | null }
      setProperty(p)
      setCustomer(p.customers ?? null)

      const [jRes, qRes, iRes, ciRes, rRes, phRes, twinRes, sRes] = await Promise.all([
        supabase.from('jobs').select('*').eq('property_id', id).order('scheduled_date', { ascending: false }),
        supabase.from('quotes').select('*').eq('property_id', id).order('created_at', { ascending: false }),
        supabase.from('invoices').select('*').eq('property_id', id),
        p.customer_id ? supabase.from('invoices').select('*').eq('customer_id', p.customer_id) : Promise.resolve({ data: null }),
        p.customer_id ? supabase.from('job_recurrences').select('*').eq('customer_id', p.customer_id) : Promise.resolve({ data: null }),
        listPhotos(supabase, user.id, { propertyId: id }),
        supabase.from('property_twin').select('*').eq('property_id', id).maybeSingle(),
        supabase.from('business_settings')
          .select('crew_cost_per_hour, pricing_base_charge, pricing_mow_rate, pricing_recommended_mult, pricing_premium_mult, pricing_travel_rate, service_seasons')
          .eq('user_id', user.id).maybeSingle(),
      ])
      if (!active) return

      const loadedJobs = (jRes.data as Job[]) || []
      setJobs(loadedJobs)
      setQuotes((qRes.data as Quote[]) || [])
      setInvoices((iRes.data as InvRow[]) || [])
      setCustomerInvoices((ciRes.data as InvRow[]) || [])
      setPhotos(phRes)
      setTwin((twinRes.data as unknown as PropertyTwin) ?? null)

      const settings = sRes.data as {
        crew_cost_per_hour: number | null; pricing_base_charge: number | null; pricing_mow_rate: number | null
        pricing_recommended_mult: number | null; pricing_premium_mult: number | null; pricing_travel_rate: number | null
        service_seasons: unknown
      } | null
      setCrewCost(crewCostPerHour(settings?.crew_cost_per_hour))
      // Suggested plan from THE pricing engine (only meaningful with a lawn size).
      if (p.lawn_sqft && Number(p.lawn_sqft) > 0) {
        setPricing(pricingPackage(Number(p.lawn_sqft), pricingConfigFromSettings(settings), { nearbyCount: 0, neighborhoodName: p.neighborhood }))
      }
      // Current recurring plan(s) at THIS property (same engine the plans list uses).
      const recs = (rRes.data as JobRecurrence[]) || []
      const seasons = settings ? settingsToSeasons(settings.service_seasons) : DEFAULT_SEASONS
      setPlans(buildServicePlans(recs, loadedJobs, seasons, localTodayISO()).filter(pl => pl.propertyId === id || pl.propertyId === null))

      // Property-scoped timeline extras (vision, photos, price changes, weather).
      setExtraEvents(await fetchTimelineExtras(supabase, {
        propertyId: id,
        jobs: loadedJobs.map(j => ({ id: j.id, title: j.title, scheduled_date: j.scheduled_date, property_id: j.property_id })),
        properties: [{ id: p.id, address: p.address }],
      }))
      setLoading(false)
    }
    load()
    return () => { active = false }
  }, [id, tick]) // eslint-disable-line react-hooks/exhaustive-deps

  // Live: visits, billing and the AI twin all refresh in place.
  const reload = () => setTick(t => t + 1)
  const propFilter = id ? `property_id=eq.${id}` : null
  useRealtimeRefresh('jobs', propFilter, reload)
  useRealtimeRefresh('invoices', propFilter, reload)
  useRealtimeRefresh('property_twin', propFilter, reload)
  useRealtimeRefresh('property_intelligence', propFilter, reload)

  if (loading) return <PageSkeleton tiles={4} rows={6} />
  if (notFound || !property) {
    return <EmptyState icon={MapPin} title="Property not found" description="It may have been removed, or belong to another account." action={{ label: 'Back to properties', onClick: () => router.push('/dashboard/properties') }} />
  }

  // ── Value (existing engines only) ──
  const completed = jobs.filter(j => j.status === 'completed')
  const upcoming = jobs.filter(j => j.scheduled_date >= localTodayISO() && (j.status === 'scheduled' || j.status === 'in_progress'))
    .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))
  const revenue = invoices.reduce((s, inv) => s + collected(inv), 0)
  const onSiteMinutes = completed.reduce((s, j) => s + (Number(j.actual_minutes) || Number(j.duration_minutes) || 0), 0)
  const econ = visitEconomics(revenue, onSiteMinutes, 0, crewCost) // labour-only (no drive attribution per property)
  const customerValue = customerInvoices.reduce((s, inv) => s + collected(inv), 0)
  const timedVisits = completed.filter(j => Number(j.actual_minutes) > 0)
  const avgMinutes = timedVisits.length ? Math.round(timedVisits.reduce((s, j) => s + Number(j.actual_minutes), 0) / timedVisits.length) : null
  const activePlans = plans.filter(pl => !pl.paused && pl.remaining > 0)

  const events = sortTimeline([
    ...eventsFromQuotes(quotes),
    ...eventsFromJobs(jobs),
    ...eventsFromInvoices(invoices),
    ...extraEvents,
  ])

  const beforeAfter = photos.filter(ph => ph.kind !== 'general')
  const gallery = (beforeAfter.length ? beforeAfter : photos).slice(0, 12)

  const fmtSqft = (n: number | null) => (n != null && Number(n) > 0 ? `${Math.round(Number(n)).toLocaleString()} ft²` : '—')
  const quickAction = 'h-9 rounded-lg flex items-center justify-center gap-1.5 text-xs font-medium border border-border bg-surface text-ink-muted hover:text-ink hover:border-border-strong transition-colors px-3'

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => router.back()} aria-label="Back" className="text-ink-muted hover:text-ink transition-colors">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <PageHeader
          title={property.address}
          description={[customer?.name, property.neighborhood || property.city].filter(Boolean).join(' · ') || 'Property'}
        />
      </div>

      {/* One-tap actions */}
      <div className="flex flex-wrap gap-2">
        {customer && (
          <Link href={`/dashboard/customers/${customer.id}`} className={quickAction}><MapPin className="w-3.5 h-3.5" /> Customer</Link>
        )}
        <Link href={`/dashboard/properties/measure?id=${property.id}`} className={quickAction}><Ruler className="w-3.5 h-3.5" /> Measure</Link>
        <Link href={`/dashboard/grow/vision?property=${property.id}`} className={quickAction}><Eye className="w-3.5 h-3.5" /> AI Vision</Link>
        {customer && (
          <>
            <Link href={`/dashboard/quotes/new?customer=${customer.id}`} className={quickAction}><FilePlus className="w-3.5 h-3.5" /> Quote</Link>
            <Link href={`/dashboard/schedule?customer=${customer.id}`} className={quickAction}><CalendarPlus className="w-3.5 h-3.5" /> Schedule</Link>
          </>
        )}
      </div>

      {/* What it is + what it's worth */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Lawn size" value={fmtSqft(property.lawn_sqft)} icon={Leaf} sub={property.fence_length ? `fence ${Math.round(Number(property.fence_length)).toLocaleString()} ft` : undefined} />
        <StatTile label="Lot size" value={fmtSqft(property.lot_size)} icon={Home} sub={[property.mulch_area && `mulch ${Math.round(Number(property.mulch_area)).toLocaleString()}`, property.driveway_area && `drive ${Math.round(Number(property.driveway_area)).toLocaleString()}`].filter(Boolean).join(' · ') || undefined} />
        <StatTile label="Revenue" value={formatCurrency(revenue)} icon={DollarSign} tone="accent" sub="collected at this property" />
        <StatTile label="Profit" value={formatCurrency(econ.profit)} icon={TrendingUp} tone={econ.profit >= 0 ? 'success' : 'danger'} sub={onSiteMinutes > 0 ? `${econ.margin}% margin · labour only` : 'no timed visits yet'} />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Visits" value={String(completed.length)} icon={Timer} sub={avgMinutes != null ? `~${avgMinutes} min avg` : undefined} />
        <StatTile label="Next visit" value={upcoming[0] ? formatDate(upcoming[0].scheduled_date) : '—'} icon={CalendarClock} sub={upcoming[0]?.title} />
        <StatTile label="Customer value" value={formatCurrency(customerValue)} icon={Wallet} sub="lifetime collected" />
        <StatTile label="Photos" value={String(photos.length)} icon={Camera} sub={beforeAfter.length ? `${beforeAfter.length} before/after` : undefined} />
      </div>

      {/* The digital twin — everything the AI knows about this property */}
      {twin ? (
        <TwinPanel twin={twin} />
      ) : (
        <Card className="p-6">
          <EmptyState
            icon={Eye}
            title="No AI read yet"
            description="Run AI Vision to build this property's digital twin — condition, change over time, opportunities and a maintenance forecast."
            action={{ label: 'Analyze with AI Vision', onClick: () => router.push(`/dashboard/grow/vision?property=${property.id}`) }}
          />
        </Card>
      )}

      {/* Service plan — current (recurrence engine) or suggested (pricing engine) */}
      <Card>
        <CardHeader className="flex items-center gap-2">
          <Repeat className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold text-ink">{activePlans.length ? 'Current service plan' : 'Suggested service plan'}</h2>
        </CardHeader>
        <CardBody>
          {activePlans.length > 0 ? (
            <div className="space-y-2">
              {activePlans.map(pl => (
                <Link key={pl.recurrenceId} href={`/dashboard/schedule?focus=${pl.recurrenceId}`} className="flex items-center justify-between gap-3 rounded-xl border border-border p-3 hover:border-accent/40 transition-colors">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">{pl.serviceName} · {pl.cadenceLabel}{pl.weekday ? ` · ${pl.weekday}` : ''}</p>
                    <p className="text-xs text-ink-muted mt-0.5">{pl.remaining} visit{pl.remaining !== 1 ? 's' : ''} booked{pl.nextVisitDate ? ` · next ${formatDate(pl.nextVisitDate)}` : ''}</p>
                  </div>
                  {pl.recurringPrice != null && <span className="text-sm font-bold text-ink shrink-0">{formatCurrency(pl.recurringPrice)}/visit</span>}
                </Link>
              ))}
            </div>
          ) : pricing ? (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                {pricing.options.map(o => (
                  <div key={o.cadence} className={cn('rounded-xl border p-3 text-center', o.cadence === pricing.recommended.cadence ? 'border-accent/40 bg-accent/[0.06]' : 'border-border bg-surface')}>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{o.cadence === 'biweekly' ? 'Every 2 weeks' : o.cadence}</p>
                    <p className="text-lg font-black text-ink mt-1">{formatCurrency(o.price)}</p>
                    <p className="text-[10px] text-ink-faint">{formatCurrency(o.annual)}/season</p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-ink-muted">
                Recommended: <span className="font-semibold text-ink capitalize">{pricing.recommended.cadence === 'biweekly' ? 'every 2 weeks' : pricing.recommended.cadence}</span>
                {pricing.recommended.reasons[0] ? ` — ${pricing.recommended.reasons[0]}` : ''}
              </p>
            </div>
          ) : (
            <InlineEmpty icon={Ruler}>Measure the lawn to see suggested recurring pricing.</InlineEmpty>
          )}
        </CardBody>
      </Card>

      <div className="grid lg:grid-cols-2 gap-6 items-start">
        {/* Everything that ever happened here */}
        <Card>
          <CardHeader className="flex items-center gap-2">
            <History className="w-4 h-4 text-accent" />
            <h2 className="text-sm font-semibold text-ink">Timeline</h2>
          </CardHeader>
          <CardBody>
            <Timeline events={events} emptyText="No history yet — visits, invoices, photos and AI analyses will appear here." />
          </CardBody>
        </Card>

        <div className="space-y-6 min-w-0">
          {/* Before / after gallery */}
          <Card>
            <CardHeader className="flex items-center gap-2">
              <Camera className="w-4 h-4 text-accent" />
              <h2 className="text-sm font-semibold text-ink">Photos</h2>
            </CardHeader>
            <CardBody>
              {gallery.length === 0 ? (
                <InlineEmpty icon={Camera}>No photos yet — before/after shots from visits show up here.</InlineEmpty>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {gallery.map(ph => (
                    <div key={ph.id} className="relative aspect-square rounded-lg overflow-hidden border border-border">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={ph.url} alt={`${ph.kind} photo${ph.taken_at ? ` from ${formatDate(ph.taken_at)}` : ''}`} loading="lazy" className="w-full h-full object-cover" />
                      {ph.kind !== 'general' && (
                        <span className={cn('absolute bottom-1 left-1 text-[9px] font-bold uppercase tracking-wide px-1 py-0.5 rounded', ph.kind === 'before' ? 'bg-black/70 text-white' : 'bg-accent text-black')}>{ph.kind}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {photos.length > gallery.length && <p className="text-[11px] text-ink-faint mt-2">{photos.length - gallery.length} more in the customer portal & studio.</p>}
            </CardBody>
          </Card>

          {/* Visit history */}
          <Card>
            <CardHeader className="flex items-center gap-2">
              <Timer className="w-4 h-4 text-accent" />
              <h2 className="text-sm font-semibold text-ink">Visits</h2>
            </CardHeader>
            <CardBody>
              {jobs.length === 0 ? (
                <InlineEmpty icon={CalendarPlus}>No visits yet.</InlineEmpty>
              ) : (
                <div className="space-y-2">
                  {jobs.slice(0, 8).map(j => (
                    <div key={j.id} className="flex items-center justify-between gap-3 text-sm">
                      <div className="min-w-0">
                        <p className="text-ink truncate">{j.title}</p>
                        <p className="text-xs text-ink-faint">{formatDate(j.scheduled_date)}{Number(j.actual_minutes) > 0 ? ` · ${j.actual_minutes} min` : ''}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {j.price != null && <span className="text-xs font-semibold text-ink">{formatCurrency(Number(j.price))}</span>}
                        <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded-full border', JOB_STATUS_COLORS[j.status])}>{JOB_STATUS_LABELS[j.status]}</span>
                      </div>
                    </div>
                  ))}
                  {jobs.length > 8 && <p className="text-[11px] text-ink-faint">{jobs.length - 8} older visits in the timeline.</p>}
                </div>
              )}
            </CardBody>
          </Card>

          {/* Measurement history (existing component) */}
          <Card>
            <CardHeader className="flex items-center gap-2">
              <Ruler className="w-4 h-4 text-accent" />
              <h2 className="text-sm font-semibold text-ink">Measurements</h2>
            </CardHeader>
            <CardBody>
              <PropertyMeasurementHistory propertyId={property.id} />
            </CardBody>
          </Card>

          {/* Nearby opportunities — the neighbors engine owns this */}
          <Link href="/dashboard/neighbors">
            <Card className="p-4 hover:border-accent/40 transition-colors">
              <SectionHeading icon={Target} title="Nearby opportunities" sub="Door-knock prospects around this property — Neighbor Leads" className="mb-0" />
            </Card>
          </Link>
        </div>
      </div>
    </div>
  )
}
