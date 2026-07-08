'use client'
import { toast } from '@/lib/toast'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Customer } from '@/types'
import { format } from 'date-fns'
import { Coord, haversineKm, geocodeAddressDetailed } from '@/lib/geo'
import {
  ProfitJob, ProfitQuote, ProfitContext, RecInfo, neighborhoodKey, neighborhoodProfitability,
} from '@/lib/profitability'
import { ensureCustomerAndProperty } from '@/lib/customers'
import { AddressAutocomplete } from '@/components/ui/AddressAutocomplete'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { Target, MapPin, Plus, Phone, FileText, Check, X, Trash2, Sprout, UserPlus } from 'lucide-react'

type LeadStatus = 'prospect' | 'contacted' | 'quoted' | 'won' | 'lost'

interface Lead {
  id: string
  created_at: string
  address: string
  latitude: number | null
  longitude: number | null
  neighborhood: string | null
  notes: string | null
  status: LeadStatus
  source_customer_id: string | null
  converted_customer_id: string | null
}

interface PropRow { id: string; customer_id: string; address: string; lat: number | null; lng: number | null; city: string | null; postal_code: string | null; neighborhood: string | null }

const STATUS_META: Record<LeadStatus, { label: string; cls: string }> = {
  prospect: { label: 'Prospect', cls: 'text-sky-300 border-sky-400/30 bg-sky-400/10' },
  contacted: { label: 'Contacted', cls: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
  quoted: { label: 'Quoted', cls: 'text-violet-300 border-violet-400/30 bg-violet-400/10' },
  won: { label: 'Won', cls: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
  lost: { label: 'Lost', cls: 'text-ink-faint border-border bg-bg-tertiary' },
}

export default function NeighborsPage() {
  const supabase = createClient()
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [leads, setLeads] = useState<Lead[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [properties, setProperties] = useState<PropRow[]>([])
  const [jobs, setJobs] = useState<ProfitJob[]>([])
  const [ctx, setCtx] = useState<ProfitContext>({ quotesById: {}, recById: {}, base: null, today: format(new Date(), 'yyyy-MM-dd') })
  const [pendingByHood, setPendingByHood] = useState<Record<string, number>>({})
  const [newAddress, setNewAddress] = useState('')
  const [adding, setAdding] = useState(false)
  const [working, setWorking] = useState<string | null>(null)

  async function load() {
    // Local session read — no auth round-trip before the data batch below.
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) { setLoading(false); return }
    const [lRes, cRes, pRes, jRes, qRes, rRes] = await Promise.all([
      supabase.from('neighbor_leads').select('*').eq('user_id', user.id).order('created_at', { ascending: false }),
      supabase.from('customers').select('*').eq('user_id', user.id).order('name'),
      supabase.from('properties').select('id, customer_id, address, lat, lng, city, postal_code, neighborhood').eq('user_id', user.id),
      supabase.from('jobs').select('id, scheduled_date, status, service_type, quote_id, recurrence_id, duration_minutes, actual_minutes, price, customer_id, properties(lat, lng, city, postal_code, neighborhood)').eq('user_id', user.id),
      supabase.from('quotes').select('id, status, property_id, total, initial_price, weekly_price, biweekly_price, monthly_price').eq('user_id', user.id),
      supabase.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', user.id),
    ])
    setLeads((lRes.data as Lead[]) || [])
    setCustomers((cRes.data as Customer[]) || [])
    const props = (pRes.data as PropRow[]) || []
    setProperties(props)

    const quotesById: Record<string, ProfitQuote> = {}
    for (const q of (qRes.data as (ProfitQuote & { id: string })[]) || []) quotesById[q.id] = q
    const recById: Record<string, RecInfo> = {}
    for (const r of (rRes.data as (RecInfo & { id: string })[]) || []) recById[r.id] = { freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count }
    setCtx({ quotesById, recById, base: null, today: format(new Date(), 'yyyy-MM-dd') })
    setJobs(((jRes.data as unknown as Array<Record<string, any>>) || []).map(j => ({
      id: j.id, scheduled_date: j.scheduled_date, status: j.status, service_type: j.service_type,
      quote_id: j.quote_id, recurrence_id: j.recurrence_id, duration_minutes: j.duration_minutes,
      actual_minutes: j.actual_minutes, price: j.price, customer_id: j.customer_id,
      lat: j.properties?.lat ?? null, lng: j.properties?.lng ?? null,
      city: j.properties?.city ?? null, postal_code: j.properties?.postal_code ?? null,
      neighborhood: j.properties?.neighborhood ?? null,
    })))
    // Pending quote demand per hood (warm areas to knock).
    const pend: Record<string, number> = {}
    const propsById = new Map(props.map(p => [p.id, p]))
    for (const q of (qRes.data as unknown as Array<{ status: string; property_id: string | null }>) || []) {
      if (q.status !== 'draft' && q.status !== 'sent') continue
      const p = q.property_id ? propsById.get(q.property_id) : null
      if (!p) continue
      const k = neighborhoodKey(p.postal_code, p.city, p.neighborhood)
      pend[k] = (pend[k] || 0) + 1
    }
    setPendingByHood(pend)
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Where to knock: expansion targets from the SAME hood engine as the map ──
  const targets = useMemo(() => {
    const hoods = neighborhoodProfitability(jobs, ctx).filter(h => h.key !== 'Unknown')
    const avgRevPerJob = hoods.length ? hoods.reduce((s, h) => s + h.revPerJob * h.jobs, 0) / Math.max(1, hoods.reduce((s, h) => s + h.jobs, 0)) : 0
    return hoods
      .map(h => ({
        ...h,
        pending: pendingByHood[h.key] || 0,
        // Anchor customer to knock around (their named property in this hood).
        anchor: properties.find(p => neighborhoodKey(p.postal_code, p.city, p.neighborhood) === h.key && p.lat != null),
        kind: (pendingByHood[h.key] || 0) > 0 ? 'warm' as const
          : h.customers <= 2 && h.revPerJob >= avgRevPerJob ? 'expand' as const
          : h.customers >= 4 ? 'dominate' as const : null,
      }))
      .filter(t => t.kind !== null)
      .sort((a, b) => b.pending - a.pending || b.revPerJob - a.revPerJob)
      .slice(0, 4)
  }, [jobs, ctx, pendingByHood, properties])

  // ── Add a lead: geocode + auto-anchor to the nearest existing property ──
  async function addLead() {
    const addr = newAddress.trim()
    if (!addr) return
    setAdding(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const geo = await geocodeAddressDetailed(addr)
      let source: PropRow | null = null
      if (geo) {
        let best: { p: PropRow; km: number } | null = null
        for (const p of properties) {
          if (p.lat == null || p.lng == null) continue
          const km = haversineKm({ lat: geo.lat, lng: geo.lng } as Coord, { lat: p.lat, lng: p.lng })
          if (!best || km < best.km) best = { p, km }
        }
        if (best && best.km <= 2) source = best.p // anchor only when genuinely a neighbor
      }
      const { error } = await supabase.from('neighbor_leads').insert({
        user_id: user!.id,
        address: geo ? addr : addr,
        latitude: geo?.lat ?? null,
        longitude: geo?.lng ?? null,
        neighborhood: geo?.neighborhood ?? null,
        source_customer_id: source?.customer_id ?? null,
        source_property_id: source?.id ?? null,
        status: 'prospect',
      })
      if (error) toast.error('Could not add lead: ' + error.message)
      else { setNewAddress(''); await load() }
    } finally { setAdding(false) }
  }

  async function setStatus(lead: Lead, status: LeadStatus) {
    setWorking(lead.id)
    const { error } = await supabase.from('neighbor_leads').update({ status }).eq('id', lead.id)
    if (error) toast.error('Could not update: ' + error.message)
    else setLeads(prev => prev.map(l => l.id === lead.id ? { ...l, status } : l))
    setWorking(null)
  }

  // Conversion is the ONLY moment a customer record is created — through the one
  // find-or-create engine, linked back via converted_customer_id.
  async function convertLead(lead: Lead, thenQuote: boolean) {
    const name = prompt(`Customer name for ${lead.address}?`)
    if (!name?.trim()) return
    setWorking(lead.id)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const ensured = await ensureCustomerAndProperty(
        supabase, user!.id, { customerId: null, name: name.trim(), address: lead.address }, customers,
      )
      await supabase.from('neighbor_leads').update({
        status: thenQuote ? 'quoted' : 'won',
        converted_customer_id: ensured.customerId,
      }).eq('id', lead.id)
      if (thenQuote) router.push(`/dashboard/quotes/new?customer=${ensured.customerId}`)
      else await load()
    } catch (e) { toast.error('Could not convert: ' + (e instanceof Error ? e.message : 'error')) }
    finally { setWorking(null) }
  }

  async function deleteLead(lead: Lead) {
    const { data: row } = await supabase.from('neighbor_leads').select('*').eq('id', lead.id).maybeSingle()
    await supabase.from('neighbor_leads').delete().eq('id', lead.id)
    setLeads(prev => prev.filter(l => l.id !== lead.id))
    if (row) toast.undo(`Deleted lead ${lead.address}`, async () => { await supabase.from('neighbor_leads').insert(row); setLeads(prev => [lead, ...prev]) })
  }

  const counts = useMemo(() => {
    const c: Record<LeadStatus, number> = { prospect: 0, contacted: 0, quoted: 0, won: 0, lost: 0 }
    for (const l of leads) c[l.status]++
    const decided = c.won + c.lost
    return { ...c, conversion: decided > 0 ? Math.round((c.won / decided) * 100) : 0 }
  }, [leads])

  const customerName = (id: string | null) => customers.find(c => c.id === id)?.name ?? null

  if (loading) return <div className="text-center py-16 text-sm text-ink-muted">Loading neighbor leads…</div>

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Neighbor Leads" description="Turn strong routes into denser routes — knock the doors next to your best customers" />

      {/* Funnel metrics */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        {(Object.keys(STATUS_META) as LeadStatus[]).map(s => (
          <div key={s} className="rounded-lg border border-border bg-bg-tertiary px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-ink-faint">{STATUS_META[s].label}</p>
            <p className="text-lg font-bold text-ink">{counts[s]}</p>
          </div>
        ))}
        <div className="rounded-lg border border-border bg-bg-tertiary px-3 py-2">
          <p className="text-[10px] uppercase tracking-wide text-ink-faint">Conversion</p>
          <p className="text-lg font-bold text-accent">{counts.conversion}%</p>
        </div>
      </div>

      {/* Where to knock — straight from the shared neighborhood engine */}
      {targets.length > 0 && (
        <Card>
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Sprout className="w-4 h-4 text-violet-300" />
            <h2 className="text-sm font-semibold text-ink">Where to knock next</h2>
          </div>
          <CardBody className="space-y-2">
            {targets.map(t => (
              <div key={t.key} className="rounded-xl border border-border p-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-sm font-bold text-ink flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5 text-ink-faint" /> {t.key}</p>
                  <span className={cn('text-[10px] font-semibold uppercase tracking-wide border rounded px-1.5 py-0.5',
                    t.kind === 'warm' ? 'text-amber-400 border-amber-500/30 bg-amber-500/10'
                      : t.kind === 'expand' ? 'text-violet-300 border-violet-400/40 bg-violet-400/10'
                      : 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10')}>
                    {t.kind === 'warm' ? `${t.pending} pending quote${t.pending !== 1 ? 's' : ''} — warm` : t.kind === 'expand' ? 'Expand here' : 'Dominate it'}
                  </span>
                </div>
                <p className="text-xs text-ink-muted mt-1">
                  {t.customers} customer{t.customers !== 1 ? 's' : ''} · {formatCurrency(t.revenue)} booked · {formatCurrency(t.revPerJob)}/job
                  {t.anchor && <> · knock around <span className="text-ink font-medium">{customerName(t.anchor.customer_id) || t.anchor.address}</span></>}
                </p>
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      {/* Add a lead */}
      <Card>
        <CardBody className="flex flex-col sm:flex-row gap-2 sm:items-end">
          <div className="flex-1">
            <AddressAutocomplete
              label="Add a neighbor lead (door knock, flyer, referral)"
              placeholder="125 Main Street, Calgary, AB"
              value={newAddress}
              onChange={setNewAddress}
              onSelect={p => setNewAddress(p.formatted)}
            />
          </div>
          <Button onClick={addLead} loading={adding} disabled={!newAddress.trim()}>
            <Plus className="w-4 h-4" /> Add lead
          </Button>
        </CardBody>
      </Card>

      {/* Leads */}
      {leads.length === 0 ? (
        <Card><CardBody className="text-center py-10 text-sm text-ink-muted">
          No leads yet. After a job, knock the two doors either side and add them here — the truck is already parked.
        </CardBody></Card>
      ) : (
        <div className="space-y-2">
          {leads.map(l => {
            const src = customerName(l.source_customer_id)
            const busy = working === l.id
            return (
              <Card key={l.id}>
                <CardBody className="space-y-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink truncate">{l.address}</p>
                      <p className="text-xs text-ink-muted mt-0.5">
                        {l.neighborhood && <span className="text-ink font-medium">{l.neighborhood} · </span>}
                        Added {formatDate(l.created_at)}
                        {src && <> · neighbor of <span className="text-ink">{src}</span></>}
                        {l.converted_customer_id && <> · <span className="text-emerald-400">converted</span></>}
                      </p>
                    </div>
                    <span className={cn('text-[10px] font-semibold uppercase tracking-wide border rounded px-1.5 py-0.5 shrink-0', STATUS_META[l.status].cls)}>
                      {STATUS_META[l.status].label}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap">
                    {l.status === 'prospect' && (
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => setStatus(l, 'contacted')}>
                        <Phone className="w-3.5 h-3.5" /> Contacted
                      </Button>
                    )}
                    {(l.status === 'prospect' || l.status === 'contacted') && (
                      <Button size="sm" loading={busy} onClick={() => convertLead(l, true)}>
                        <FileText className="w-3.5 h-3.5" /> Convert &amp; quote
                      </Button>
                    )}
                    {l.status === 'quoted' && !l.converted_customer_id && (
                      <Button size="sm" loading={busy} onClick={() => convertLead(l, false)}>
                        <UserPlus className="w-3.5 h-3.5" /> Convert — won
                      </Button>
                    )}
                    {l.status === 'quoted' && l.converted_customer_id && (
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => setStatus(l, 'won')}>
                        <Check className="w-3.5 h-3.5" /> Won
                      </Button>
                    )}
                    {l.status !== 'won' && l.status !== 'lost' && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setStatus(l, 'lost')}>
                        <X className="w-3.5 h-3.5" /> Lost
                      </Button>
                    )}
                    {l.converted_customer_id && (
                      <Button size="sm" variant="ghost" onClick={() => router.push(`/dashboard/customers/${l.converted_customer_id}`)}>
                        Open customer
                      </Button>
                    )}
                    <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(l.address)}`} target="_blank" rel="noopener noreferrer"
                      className="h-8 px-2.5 rounded-lg border border-border text-xs font-medium flex items-center gap-1 text-ink-muted hover:text-ink">
                      <MapPin className="w-3.5 h-3.5" /> Map
                    </a>
                    <Button size="sm" variant="ghost" className="ml-auto hover:text-red-400" onClick={() => deleteLead(l)} title="Delete lead">
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </CardBody>
              </Card>
            )
          })}
        </div>
      )}

      <p className="text-xs text-ink-faint flex items-start gap-1.5">
        <Target className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        Prospects stay separate from customers — a customer record is only created when you convert, and the lead keeps the link.
      </p>
    </div>
  )
}
