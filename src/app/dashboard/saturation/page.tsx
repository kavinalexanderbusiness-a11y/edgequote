'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { loadAnalyticsCore } from '@/lib/analyticsData'
import { loadTravelModel } from '@/lib/travelLearning'
import { Coord, geocodeAddress } from '@/lib/geo'
import {
  ProfitJob, ProfitQuote, ProfitContext, RecInfo, GRADE_COLORS,
  dayProfitability, gradeRoute, neighborhoodKey, neighborhoodProfitability, jobValue,
} from '@/lib/profitability'
import { SaturationMap, SatPoint, SatHood, SatLayer } from '@/components/saturation/SaturationMap'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Banner } from '@/components/ui/Banner'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { FilterPill } from '@/components/ui/FilterPill'
import { SkeletonTiles } from '@/components/ui/Skeleton'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { format } from 'date-fns'
import { Trophy, Sprout, TrendingDown, TrendingUp, Users, Repeat, FileText, MapPin, Navigation } from 'lucide-react'

type SatJob = ProfitJob & { property_id: string | null }
interface PropRow { id: string; customer_id: string; address: string; lat: number | null; lng: number | null; city: string | null; postal_code: string | null; neighborhood: string | null }
interface QRow { id: string; status: string; customer_id: string | null; property_id: string | null; customer_name: string; total: number | null; initial_price: number | null; weekly_price: number | null; biweekly_price: number | null; monthly_price: number | null }

type HoodTag = 'saturated' | 'warm' | 'expand' | 'growing'
const TAG_META: Record<HoodTag, { label: string; cls: string }> = {
  saturated: { label: 'Saturated — protect it', cls: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
  warm: { label: 'Warm demand — close quotes', cls: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
  expand: { label: 'Expand here', cls: 'text-violet-400 border-violet-400/40 bg-violet-400/10' },
  growing: { label: 'Growing', cls: 'text-ink-muted border-border bg-bg-tertiary' },
}

interface HoodRow {
  key: string
  lat: number | null
  lng: number | null
  revenue: number
  jobs: number
  customers: number
  recurringCustomers: number
  revPerJob: number
  revPerHour: number
  pendingQuotes: number
  pendingValue: number
  decidedQuotes: number
  conversionPct: number
  tag: HoodTag
  color: string
}

const LAYER_DEFS: { key: SatLayer; label: string }[] = [
  { key: 'customers', label: 'Customers' },
  { key: 'recurring', label: 'Recurring' },
  { key: 'revenue', label: 'Revenue density' },
  { key: 'hoods', label: 'Route density' },
  { key: 'quotes', label: 'Quotes' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'opportunity', label: 'Opportunities' },
]

export default function SaturationPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [jobs, setJobs] = useState<SatJob[]>([])
  const [properties, setProperties] = useState<PropRow[]>([])
  const [quotes, setQuotes] = useState<QRow[]>([])
  const [customersById, setCustomersById] = useState<Record<string, string>>({})
  const [ctx, setCtx] = useState<ProfitContext>({ quotesById: {}, recById: {}, base: null, today: format(new Date(), 'yyyy-MM-dd') })
  const [layers, setLayers] = useState<Record<SatLayer, boolean>>({
    customers: true, recurring: true, revenue: false, hoods: true, quotes: false, accepted: false, opportunity: true,
  })
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      try {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) { setLoadError('Session expired — sign in again.'); return }
      const [core, pRes, cRes, sRes, travel] = await Promise.all([
        loadAnalyticsCore(supabase),
        supabase.from('properties').select('id, customer_id, address, lat, lng, city, postal_code, neighborhood').eq('user_id', user!.id),
        supabase.from('customers').select('id, name').eq('user_id', user!.id),
        supabase.from('business_settings').select('base_lat, base_lng, base_address').eq('user_id', user!.id).maybeSingle(),
        loadTravelModel(supabase),
      ])

      const quotesById: Record<string, ProfitQuote> = {}
      for (const q of (core?.quotes as unknown as (ProfitQuote & { id: string })[]) || []) quotesById[q.id] = q
      const recById: Record<string, RecInfo> = {}
      for (const r of (core?.recurrences as unknown as (RecInfo & { id: string })[]) || []) recById[r.id] = { freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count }

      setJobs(((core?.jobs as unknown as Array<Record<string, any>>) || []).map(j => ({
        id: j.id, scheduled_date: j.scheduled_date, status: j.status, service_type: j.service_type,
        quote_id: j.quote_id, recurrence_id: j.recurrence_id, duration_minutes: j.duration_minutes,
        actual_minutes: j.actual_minutes, price: j.price, customer_id: j.customer_id, property_id: j.property_id,
        lat: j.properties?.lat ?? null, lng: j.properties?.lng ?? null,
        city: j.properties?.city ?? null, postal_code: j.properties?.postal_code ?? null,
        neighborhood: j.properties?.neighborhood ?? null,
      })))
      setProperties((pRes.data as PropRow[]) || [])
      setQuotes((core?.quotes as unknown as QRow[]) || [])
      const names: Record<string, string> = {}
      for (const c of (cRes.data as { id: string; name: string }[]) || []) names[c.id] = c.name
      setCustomersById(names)

      const s = sRes.data as { base_lat: number | null; base_lng: number | null; base_address: string | null } | null
      let base: Coord | null = s?.base_lat != null && s?.base_lng != null ? { lat: s.base_lat, lng: s.base_lng } : null
      if (!base && s?.base_address) {
        const c = await geocodeAddress(s.base_address)
        if (c) { base = c; await supabase.from('business_settings').update({ base_lat: c.lat, base_lng: c.lng }).eq('user_id', user!.id) }
      }
      setCtx({ quotesById, recById, base, today: format(new Date(), 'yyyy-MM-dd'), speed: travel })
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : 'Could not load the map data.')
      } finally {
        setLoading(false) // never strand the page on the spinner
      }
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const model = useMemo(() => {
    const active = jobs.filter(j => j.status !== 'cancelled')
    const propsById: Record<string, PropRow> = {}
    for (const p of properties) propsById[p.id] = p

    // Booked revenue + recurring flag per PROPERTY (one valuation engine). A
    // customer with a home + a rental in different areas must not show their
    // full revenue (or a recurring badge) on both pins — jobs carry property_id,
    // so credit each visit to the lawn it actually happens on.
    const revenueByProperty: Record<string, number> = {}
    const recurringProps = new Set<string>()
    for (const j of active) {
      if (j.property_id) revenueByProperty[j.property_id] = (revenueByProperty[j.property_id] || 0) + jobValue(j, ctx)
      if (j.recurrence_id && j.property_id) recurringProps.add(j.property_id)
    }

    // ── Map points ──
    const points: SatPoint[] = []
    // One point per located property, classed customer vs recurring.
    for (const p of properties) {
      if (p.lat == null || p.lng == null) continue
      const name = customersById[p.customer_id] || 'Customer'
      const rev = Math.round(revenueByProperty[p.id] || 0)
      const recurring = recurringProps.has(p.id)
      points.push({
        lat: p.lat, lng: p.lng, kind: recurring ? 'recurring' : 'customer',
        title: name, sub: `${p.address} · ${formatCurrency(rev)} booked${recurring ? ' · recurring' : ''}`,
        revenue: rev,
      })
    }
    // Quote demand points (pending = draft/sent; accepted = accepted/scheduled).
    for (const q of quotes) {
      const p = q.property_id ? propsById[q.property_id] : null
      if (!p || p.lat == null || p.lng == null) continue
      const kind = q.status === 'draft' || q.status === 'sent' ? 'quote'
        : q.status === 'accepted' || q.status === 'scheduled' ? 'accepted' : null
      if (!kind) continue
      points.push({
        lat: p.lat, lng: p.lng, kind,
        title: q.customer_name, sub: `${kind === 'quote' ? 'Pending quote' : 'Accepted'} · ${formatCurrency(Number(q.total) || 0)}`,
        revenue: Number(q.total) || 0,
      })
    }

    // ── Neighborhoods (shared engine: same FSA grouping everywhere) ──
    const hoodsBase = neighborhoodProfitability(active, ctx)

    // Centroids from located jobs per hood.
    const centroid: Record<string, { lat: number; lng: number; n: number }> = {}
    for (const j of active) {
      if (j.lat == null || j.lng == null) continue
      const k = neighborhoodKey(j.postal_code, j.city, j.neighborhood)
      const e = (centroid[k] ||= { lat: 0, lng: 0, n: 0 })
      e.lat += j.lat; e.lng += j.lng; e.n++
    }
    // Recurring customers per hood — only via properties that actually HAVE
    // recurring work, so a customer's other addresses don't inflate other areas.
    const recurringByHood: Record<string, Set<string>> = {}
    for (const p of properties) {
      if (!recurringProps.has(p.id)) continue
      const k = neighborhoodKey(p.postal_code, p.city, p.neighborhood)
      ;(recurringByHood[k] ||= new Set()).add(p.customer_id)
    }
    // Quote demand + conversion per hood (decided = anything past draft).
    const pendingByHood: Record<string, { n: number; value: number }> = {}
    const convByHood: Record<string, { decided: number; won: number }> = {}
    for (const q of quotes) {
      const p = q.property_id ? propsById[q.property_id] : null
      if (!p) continue
      const k = neighborhoodKey(p.postal_code, p.city, p.neighborhood)
      if (q.status === 'draft' || q.status === 'sent') {
        const e = (pendingByHood[k] ||= { n: 0, value: 0 })
        e.n++; e.value += Number(q.total) || 0
      }
      if (q.status !== 'draft') {
        const c = (convByHood[k] ||= { decided: 0, won: 0 })
        c.decided++
        if (q.status === 'accepted' || q.status === 'scheduled' || q.status === 'completed' || q.status === 'paid') c.won++
      }
    }

    const avgRevPerJob = hoodsBase.length
      ? hoodsBase.reduce((s, h) => s + h.revPerJob * h.jobs, 0) / Math.max(1, hoodsBase.reduce((s, h) => s + h.jobs, 0))
      : 0

    const hoods: HoodRow[] = hoodsBase.map(h => {
      const c = centroid[h.key]
      const pending = pendingByHood[h.key] || { n: 0, value: 0 }
      const conv = convByHood[h.key] || { decided: 0, won: 0 }
      const recur = recurringByHood[h.key]?.size || 0
      const tag: HoodTag = h.customers >= 4 ? 'saturated'
        : pending.value > 0 ? 'warm'
        : h.customers <= 2 && h.revPerJob >= avgRevPerJob ? 'expand'
        : 'growing'
      // Grade via the ONE grading engine. Hood $/hr has NO drive time in it, so
      // pass hasDriveData=false — same C-cap the day engine applies without drive
      // data, so an area can never out-grade the routes that serve it.
      const grade = gradeRoute(h.revPerHour, 10, 3, false)
      return {
        key: h.key, lat: c ? c.lat / c.n : null, lng: c ? c.lng / c.n : null,
        revenue: h.revenue, jobs: h.jobs, customers: h.customers,
        recurringCustomers: recur, revPerJob: h.revPerJob, revPerHour: h.revPerHour,
        pendingQuotes: pending.n, pendingValue: Math.round(pending.value),
        decidedQuotes: conv.decided,
        conversionPct: conv.decided > 0 ? Math.round((conv.won / conv.decided) * 100) : 0,
        tag, color: GRADE_COLORS[grade],
      }
    })

    const mapHoods: SatHood[] = hoods
      .filter(h => h.lat != null && h.lng != null)
      .map(h => ({ key: h.key, lat: h.lat as number, lng: h.lng as number, revenue: h.revenue, customers: h.customers, jobs: h.jobs, color: h.color, opportunity: h.tag === 'expand' || h.tag === 'warm' }))

    // ── Strongest / weakest routes (shared day engine) ──
    const byDate: Record<string, SatJob[]> = {}
    for (const j of active) (byDate[j.scheduled_date] ||= []).push(j)
    const routes = Object.entries(byDate)
      .map(([date, dj]) => dayProfitability(date, dj, ctx))
      .filter(r => r.jobsTotal >= 2 && r.revPerHour > 0)
      .sort((a, b) => b.revPerHour - a.revPerHour)
    const strongest = routes.slice(0, 2)
    const weakest = routes.length > 2 ? routes.slice(-2).reverse() : []

    // 'Unknown' = jobs missing postal+city. It can't be knocked or flyered —
    // keep it out of rankings and point at Data Quality instead.
    const known = hoods.filter(h => h.key !== 'Unknown')
    const unknownHood = hoods.find(h => h.key === 'Unknown') ?? null
    const opportunities = known.filter(h => h.tag === 'expand' || h.tag === 'warm')
      .sort((a, b) => b.pendingValue - a.pendingValue || b.revPerJob - a.revPerJob)
    const best = [...known].sort((a, b) => b.revenue - a.revenue).slice(0, 3)

    // Neighborhood intelligence — the winner per business question. One line each;
    // all from the same hood rows so the names/numbers match the map and lists.
    const top = <T,>(arr: T[], score: (t: T) => number) =>
      arr.reduce<T | null>((b, x) => (score(x) > 0 && (!b || score(x) > score(b)) ? x : b), null)
    const intel = {
      revenue: top(known, h => h.revenue),
      density: top(known, h => h.jobs),
      recurring: top(known, h => h.recurringCustomers),
      conversion: top(known.filter(h => h.decidedQuotes >= 2), h => h.conversionPct),
      growth: opportunities[0] ?? null,
    }

    return { points, hoods, mapHoods, best, opportunities, strongest, weakest, unknownHood, intel }
  }, [jobs, properties, quotes, customersById, ctx])

  if (loading) return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader crumb={{ label: 'Grow', href: '/dashboard/grow' }} title="Saturation Map" description="Where your customers, revenue and routes concentrate — and where to grow next." />
      <SkeletonTiles count={4} />
    </div>
  )

  const m = model

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader crumb={{ label: 'Grow', href: '/dashboard/grow' }} title="Saturation Map" description="Where your customers, revenue and routes concentrate — and where to grow next." />

      {loadError && (
        <Banner tone="danger">
          {loadError} <button onClick={() => window.location.reload()} className="underline font-medium ml-1">Retry</button>
        </Banner>
      )}

      {/* Layer toggles */}
      <div className="flex flex-wrap items-center gap-1.5">
        {LAYER_DEFS.map(l => (
          <FilterPill key={l.key} active={layers[l.key]} onClick={() => setLayers(prev => ({ ...prev, [l.key]: !prev[l.key] }))}>
            {l.label}
          </FilterPill>
        ))}
      </div>

      <SaturationMap points={m.points} hoods={m.mapHoods} layers={layers} base={ctx.base} />

      {!ctx.base && (
        <p className="text-xs text-amber-400">Set a base address in Settings to anchor the map and route math.</p>
      )}

      {/* Neighborhood intelligence — one winner per business question */}
      {(m.intel.revenue || m.intel.density || m.intel.recurring || m.intel.conversion || m.intel.growth) && (
        <Card>
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <span className="w-6 h-6 rounded-md bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0"><Trophy className="w-3.5 h-3.5 text-accent-text" /></span>
            <h2 className="text-sm font-semibold text-ink tracking-tight">Neighborhood intelligence</h2>
            <span className="flex-1 h-px bg-border" aria-hidden />
          </div>
          <CardBody className="p-0">
            <div className="divide-y divide-border">
              {m.intel.revenue && <IntelRow label="Top revenue" hood={m.intel.revenue.key} stat={formatCurrency(m.intel.revenue.revenue) + ' booked'} />}
              {m.intel.density && <IntelRow label="Highest density" hood={m.intel.density.key} stat={`${m.intel.density.jobs} stops · ${m.intel.density.customers} customers`} />}
              {m.intel.recurring && <IntelRow label="Best recurring" hood={m.intel.recurring.key} stat={`${m.intel.recurring.recurringCustomers} recurring customer${m.intel.recurring.recurringCustomers !== 1 ? 's' : ''}`} />}
              {m.intel.conversion && <IntelRow label="Best conversion" hood={m.intel.conversion.key} stat={`${m.intel.conversion.conversionPct}% of ${m.intel.conversion.decidedQuotes} quotes won`} />}
              {m.intel.growth && <IntelRow label="Biggest growth opportunity" hood={m.intel.growth.key} stat={m.intel.growth.pendingValue > 0 ? `${formatCurrency(m.intel.growth.pendingValue)} in pending quotes` : `${formatCurrency(m.intel.growth.revPerJob)}/job, only ${m.intel.growth.customers} customer${m.intel.growth.customers !== 1 ? 's' : ''}`} />}
            </div>
          </CardBody>
        </Card>
      )}

      {/* Actionable panels */}
      <div className="grid lg:grid-cols-2 gap-4">
        {/* Where to get more customers */}
        <Card>
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <span className="w-6 h-6 rounded-md bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0"><Sprout className="w-3.5 h-3.5 text-accent-text" /></span>
            <h2 className="text-sm font-semibold text-ink tracking-tight">Where to get more customers</h2>
            <span className="flex-1 h-px bg-border" aria-hidden />
          </div>
          <CardBody className="space-y-2.5">
            {m.opportunities.length === 0 ? (
              <InlineEmpty className="py-4">No clear expansion signal yet — add more priced, located jobs.</InlineEmpty>
            ) : m.opportunities.slice(0, 5).map(h => (
              <div key={h.key} className="rounded-card border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-bold text-ink flex items-center gap-2"><MapPin className="w-3.5 h-3.5 text-ink-faint" /> {h.key}</p>
                  <span className={cn('text-[10px] font-semibold uppercase tracking-wide border rounded px-1.5 py-0.5', TAG_META[h.tag].cls)}>{TAG_META[h.tag].label}</span>
                </div>
                <p className="text-xs text-ink-muted mt-1.5">
                  {h.tag === 'warm'
                    ? <>{h.pendingQuotes} pending quote{h.pendingQuotes !== 1 ? 's' : ''} worth <span className="text-amber-400 font-semibold">{formatCurrency(h.pendingValue)}</span> — close them to densify this area.</>
                    : <>Only {h.customers} customer{h.customers !== 1 ? 's' : ''} here but strong value (<span className="text-ink font-medium">{formatCurrency(h.revPerJob)}/job</span>) — knock neighbors, drop flyers, ask for referrals.</>}
                </p>
                <p className="text-[11px] text-ink-faint mt-1 tabular-nums">{formatCurrency(h.revenue)} booked · {h.recurringCustomers} recurring · ${h.revPerHour}/hr</p>
              </div>
            ))}
          </CardBody>
        </Card>

        {/* Best neighborhoods */}
        <Card>
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <span className="w-6 h-6 rounded-md bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0"><Trophy className="w-3.5 h-3.5 text-accent-text" /></span>
            <h2 className="text-sm font-semibold text-ink tracking-tight">Best neighborhoods</h2>
            <span className="flex-1 h-px bg-border" aria-hidden />
          </div>
          <CardBody className="space-y-2.5">
            {m.best.length === 0 ? (
              <InlineEmpty className="py-4">No neighborhood data yet.</InlineEmpty>
            ) : m.best.map((h, i) => (
              <div key={h.key} className="flex items-center gap-3 rounded-card border border-border p-3">
                <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0" style={{ background: h.color + '33', color: h.color }}>{i + 1}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-bold text-ink">{h.key}</p>
                    <p className="text-sm font-bold text-accent-text tabular-nums">{formatCurrency(h.revenue)}</p>
                  </div>
                  <p className="text-[11px] text-ink-muted mt-0.5 flex items-center gap-x-3 flex-wrap tabular-nums">
                    <span className="flex items-center gap-1"><Users className="w-3 h-3" />{h.customers}</span>
                    <span className="flex items-center gap-1"><Repeat className="w-3 h-3" />{h.recurringCustomers} recurring</span>
                    <span>{formatCurrency(h.revPerJob)}/job</span>
                    <span>${h.revPerHour}/hr</span>
                    {h.pendingQuotes > 0 && <span className="flex items-center gap-1 text-amber-400"><FileText className="w-3 h-3" />{h.pendingQuotes} pending</span>}
                  </p>
                </div>
              </div>
            ))}
          </CardBody>
        </Card>
      </div>

      {/* Strongest / weakest routes */}
      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <span className="w-6 h-6 rounded-md bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0"><TrendingUp className="w-3.5 h-3.5 text-accent-text" /></span>
            <h2 className="text-sm font-semibold text-ink tracking-tight">Strongest routes</h2>
            <span className="flex-1 h-px bg-border" aria-hidden />
          </div>
          <CardBody className="space-y-2">
            {m.strongest.length === 0 ? <InlineEmpty className="py-4">Not enough multi-stop days yet.</InlineEmpty>
              : m.strongest.map(r => <RouteLine key={r.date} date={r.date} grade={r.grade} revenue={r.revenue} revPerHour={r.revPerHour} stops={r.stops} />)}
          </CardBody>
        </Card>
        <Card>
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <span className="w-6 h-6 rounded-md bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0"><TrendingDown className="w-3.5 h-3.5 text-accent-text" /></span>
            <h2 className="text-sm font-semibold text-ink tracking-tight">Weakest routes</h2>
            <span className="flex-1 h-px bg-border" aria-hidden />
          </div>
          <CardBody className="space-y-2">
            {m.weakest.length === 0 ? <InlineEmpty className="py-4">Nothing weak enough to flag.</InlineEmpty>
              : m.weakest.map(r => <RouteLine key={r.date} date={r.date} grade={r.grade} revenue={r.revenue} revPerHour={r.revPerHour} stops={r.stops} />)}
          </CardBody>
        </Card>
      </div>

      {m.unknownHood && (
        <p className="text-xs text-amber-400">
          {m.unknownHood.jobs} job{m.unknownHood.jobs !== 1 ? 's' : ''} have no postal code/city and can&apos;t be mapped to a neighborhood — fix them in{' '}
          <Link href="/dashboard/data-quality" className="underline">Data Quality</Link>.
        </p>
      )}
      <p className="text-xs text-ink-faint">
        Neighborhood = postal area (FSA), valued by the same engines as <Link href="/dashboard/profitability" className="text-accent-text hover:underline">Profitability</Link> and <Link href="/dashboard/routes" className="text-accent-text hover:underline">Routes</Link>. Area $/hr excludes drive time, so area grades cap at C — day grades on Profitability include driving.
      </p>
    </div>
  )
}

function IntelRow({ label, hood, stat }: { label: string; hood: string; stat: string }) {
  return (
    <div className="px-4 py-2.5 flex items-center gap-3">
      <span className="text-xs text-ink-muted w-44 shrink-0">{label}</span>
      <span className="text-sm font-bold text-ink min-w-0 truncate flex items-center gap-1.5">
        <MapPin className="w-3.5 h-3.5 text-accent-text shrink-0" /> {hood}
      </span>
      <span className="ml-auto text-xs text-ink-muted shrink-0 tabular-nums">{stat}</span>
    </div>
  )
}

function RouteLine({ date, grade, revenue, revPerHour, stops }: { date: string; grade: keyof typeof GRADE_COLORS; revenue: number; revPerHour: number; stops: number }) {
  return (
    <div className="flex items-center gap-3 rounded-card border border-border px-3 py-2.5">
      <div className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-black shrink-0"
        style={{ backgroundColor: GRADE_COLORS[grade] + '22', color: GRADE_COLORS[grade], border: `1px solid ${GRADE_COLORS[grade]}55` }}>
        {grade}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">{formatDate(date)}</p>
        <p className="text-[11px] text-ink-muted tabular-nums">{stops} stops · ${revPerHour}/hr</p>
      </div>
      <p className="text-sm font-bold text-accent-text shrink-0 tabular-nums">{formatCurrency(revenue)}</p>
      <Link href="/dashboard/routes" className="text-ink-faint hover:text-ink shrink-0" title="Analyze this route" aria-label="Analyze this route">
        <Navigation className="w-4 h-4" />
      </Link>
    </div>
  )
}
