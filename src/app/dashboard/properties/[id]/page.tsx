'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Property } from '@/types'
import { buildTimeline, timelineForProperty } from '@/lib/timeline'
import { loadPropertyTimelineSources } from '@/lib/timelineData'
import { TimelineCard } from '@/components/timeline/TimelineCard'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Textarea } from '@/components/ui/Textarea'
import { AddressAutocomplete } from '@/components/ui/AddressAutocomplete'
import { getPropertyContext, type PropertyIntelligence } from '@/lib/ai/propertyContext'
import { toast } from '@/lib/toast'
import { Home, Ruler, FileText, User, MapPin, Edit2, StickyNote, Sparkles } from 'lucide-react'

// The history of ONE address. The properties list already shows what a property IS
// (health, plan, performance, pricing, latest measurement) — this shows what
// HAPPENED there, which nothing else in the app does.
//
// Same engine as the customer timeline, one filter deeper: build the customer's
// full history, then narrow to this address. Customer-level events (a payment isn't
// "at" an address) are excluded by timelineForProperty rather than repeated under
// every address the customer owns.
export default function PropertyDetailPage() {
  const { id } = useParams<{ id: string }>()
  const supabase = useMemo(() => createClient(), [])
  const [tick, setTick] = useState(0)

  const [property, setProperty] = useState<Property | null>(null)
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null)
  const [events, setEvents] = useState<ReturnType<typeof buildTimeline>>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Latest ACTIVE AI analysis of this property, through THE one read seam
  // (lib/ai/propertyContext) — never re-run, only surfaced. Null = no card.
  const [insight, setInsight] = useState<PropertyIntelligence | null>(null)
  // Customer V2: the property owns its address — edited HERE, one table, one write.
  const [editingAddress, setEditingAddress] = useState(false)
  const [addrDraft, setAddrDraft] = useState({ address: '', city: '', province: '', postal: '' })
  const [savingAddress, setSavingAddress] = useState(false)
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesDraft, setNotesDraft] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)

  useEffect(() => {
    let active = true
    async function load() {
      // Opening a different property must not paint the previous one's history under
      // the new address while this runs.
      setLoading(true)
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      // No session is a load failure, not a reason to sit on a skeleton forever.
      if (!user) { if (active) { setLoadError('Could not load this property — check your connection.'); setLoading(false) } return }

      const propRes = await supabase.from('properties')
        .select('*, customers(id, name)')
        .eq('id', id).eq('user_id', user.id).maybeSingle()

      // A transient failure must not render as "property not found" — only a genuine
      // no-rows result means it's gone.
      if (propRes.error) { if (active) { setLoadError('Could not load this property — check your connection.'); setLoading(false) } return }
      const prop = propRes.data as (Property & { customers?: { id: string; name: string } | { id: string; name: string }[] | null }) | null
      if (!prop) { if (active) { setProperty(null); setLoadError(null); setLoading(false) } return }
      const cust = Array.isArray(prop.customers) ? prop.customers[0] ?? null : prop.customers ?? null
      if (active) { setLoadError(null); setProperty(prop); setCustomer(cust) }

      const [sources, setRes, ctx] = await Promise.all([
        loadPropertyTimelineSources(supabase, user.id, id),
        supabase.from('business_settings').select('gst_percent').eq('user_id', user.id).maybeSingle(),
        getPropertyContext(supabase, id),
      ])
      if (active) setInsight(ctx)
      const all = buildTimeline({
        ...sources,
        gstPercent: Number((setRes.data as { gst_percent?: number | null } | null)?.gst_percent) || 0,
      })
      // Every row was fetched by property, so this is a guard, not the mechanism:
      // it holds the invariant if a customer-level source is ever added above.
      if (active) { setEvents(timelineForProperty(all, id)); setLoading(false) }
    }
    // A thrown request must surface as an error, not a permanent skeleton.
    load().catch(() => { if (active) { setLoadError('Could not load this property — check your connection.'); setLoading(false) } })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, tick])

  // A new/changed quote or job at this address lands without a refresh. Photos and
  // measurements are NOT live — job_photos isn't on the realtime publication, so
  // claiming it here would be a comment writing a cheque the DB won't cash.
  const reload = () => setTick(t => t + 1)
  const propFilter = id ? `property_id=eq.${id}` : null
  useRealtimeRefresh('quotes', propFilter, reload)
  useRealtimeRefresh('jobs', propFilter, reload)
  useRealtimeRefresh('invoices', propFilter, reload)
  useRealtimeRefresh('properties', id ? `id=eq.${id}` : null, reload)

  async function saveAddress() {
    if (!property || !addrDraft.address.trim()) return
    setSavingAddress(true)
    // lat/lng/neighborhood are DERIVED from the address — a changed address must
    // reset them or routing keeps driving to the old coordinates. The next page
    // that needs a location re-geocodes lazily (the settings form's own pattern).
    const { error } = await supabase.from('properties').update({
      address: addrDraft.address.trim(),
      city: addrDraft.city.trim() || null,
      province: addrDraft.province.trim() || null,
      postal_code: addrDraft.postal.trim() || null,
      lat: null, lng: null, neighborhood: null,
    }).eq('id', property.id)
    setSavingAddress(false)
    if (error) { toast.error('Could not save the address: ' + error.message); return }
    setEditingAddress(false)
    toast.success('Address updated — it re-locates on the next route or measurement.')
    reload()
  }

  async function saveNotes() {
    if (!property) return
    setSavingNotes(true)
    const { error } = await supabase.from('properties').update({ notes: notesDraft.trim() || null }).eq('id', property.id)
    setSavingNotes(false)
    if (error) { toast.error('Could not save the notes: ' + error.message); return }
    setEditingNotes(false)
    reload()
  }

  if (loading) return <div className="max-w-3xl mx-auto space-y-6"><SkeletonRows count={5} /></div>

  if (!property) return (
    <div className="max-w-3xl mx-auto">
      <PageHeader crumb={{ label: 'Properties', href: '/dashboard/properties' }} title="Property" />
      {loadError ? (
        <div className="text-center py-16 text-sm">
          <p className="text-red-400">{loadError}</p>
          <Button size="sm" variant="secondary" className="mt-2" onClick={reload}>Retry</Button>
        </div>
      ) : (
        <EmptyState icon={Home} title="Property not found"
          description="This link points at a property that doesn't exist (or isn't yours)."
          action={{ label: 'Open Properties', href: '/dashboard/properties' }} />
      )}
    </div>
  )

  const place = [property.city, property.province, property.postal_code].filter(Boolean).join(', ')

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <PageHeader crumb={{ label: 'Properties', href: '/dashboard/properties' }}
        title={property.address || 'Property'} description={place || undefined} />

      {/* Identity only — the properties list owns the full dossier, so this doesn't
          restate health, pricing or performance. */}
      <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-xs text-ink-muted">
        {customer && (
          <Link href={`/dashboard/customers/${customer.id}`} className="inline-flex items-center gap-1.5 hover:text-ink transition-colors">
            <User className="w-3.5 h-3.5 text-ink-faint" /> {customer.name}
          </Link>
        )}
        {property.lawn_sqft ? (
          <span className="inline-flex items-center gap-1.5">
            <Ruler className="w-3.5 h-3.5 text-ink-faint" />
            <span className="font-semibold text-ink tabular-nums">{Number(property.lawn_sqft).toLocaleString()} ft²</span> lawn
          </span>
        ) : null}
        {property.lat && property.lng ? (
          <span className="inline-flex items-center gap-1.5 text-accent-text"><MapPin className="w-3.5 h-3.5" /> Located</span>
        ) : null}
        <button type="button"
          onClick={() => {
            setAddrDraft({ address: property.address || '', city: property.city || '', province: property.province || '', postal: property.postal_code || '' })
            setEditingAddress(v => !v)
          }}
          className="inline-flex items-center gap-1 text-ink-faint hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded">
          <Edit2 className="w-3 h-3" /> Edit address
        </button>
      </div>

      {/* Customer V2: THE address editor — the property owns its address, so a
          correction happens here, on one table, and can never half-apply across
          a customer row again. */}
      {editingAddress && (
        <Card>
          <CardBody className="space-y-3">
            <AddressAutocomplete
              label="Property address"
              placeholder="123 Main Street"
              value={addrDraft.address}
              onChange={v => setAddrDraft(d => ({ ...d, address: v }))}
              onSelect={p => setAddrDraft({ address: p.address, city: p.city || '', province: p.province || '', postal: p.postal || '' })}
            />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <input value={addrDraft.city} onChange={e => setAddrDraft(d => ({ ...d, city: e.target.value }))} placeholder="City"
                className="rounded-xl border border-border-strong bg-bg-tertiary px-3 py-2 text-sm text-ink placeholder:text-ink-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all" aria-label="City" />
              <input value={addrDraft.province} onChange={e => setAddrDraft(d => ({ ...d, province: e.target.value }))} placeholder="Province"
                className="rounded-xl border border-border-strong bg-bg-tertiary px-3 py-2 text-sm text-ink placeholder:text-ink-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all" aria-label="Province" />
              <input value={addrDraft.postal} onChange={e => setAddrDraft(d => ({ ...d, postal: e.target.value }))} placeholder="Postal code"
                className="rounded-xl border border-border-strong bg-bg-tertiary px-3 py-2 text-sm text-ink placeholder:text-ink-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all" aria-label="Postal code" />
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button size="sm" variant="ghost" type="button" onClick={() => setEditingAddress(false)}>Cancel</Button>
              <Button size="sm" type="button" loading={savingAddress} disabled={!addrDraft.address.trim()} onClick={saveAddress}>Save address</Button>
            </div>
          </CardBody>
        </Card>
      )}

      {/* Latest AI analysis — read through THE propertyContext seam, shown only
          when one exists. Reused, never re-run (the BeforeAfterStudio pattern). */}
      {insight && (insight.summary || (insight.detections?.length ?? 0) > 0) && (
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><Sparkles className="w-4 h-4 text-accent-text" /> AI property insight</h2>
          </CardHeader>
          <CardBody className="space-y-2">
            {insight.summary && <p className="text-sm text-ink-muted">{insight.summary}</p>}
            {(insight.detections?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {insight.detections!.slice(0, 8).map(d => (
                  <span key={d} className="text-[11px] text-ink-muted border border-border rounded-lg px-2 py-0.5 bg-bg-tertiary">{d}</span>
                ))}
              </div>
            )}
            <p className="text-[11px] text-ink-faint">From a prior AI analysis — reused here, not re-run.</p>
          </CardBody>
        </Card>
      )}

      {/* Property notes — CUSTOMER-FACING: the portal renders these under "Notes
          from your provider". Say so, so nobody parks a gate code here (that's
          the customer's private notes field on their profile). */}
      <Card>
        <CardHeader className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><StickyNote className="w-4 h-4 text-accent-text" /> Property notes</h2>
          {!editingNotes && (
            <button type="button" onClick={() => { setNotesDraft(property.notes || ''); setEditingNotes(true) }}
              className="text-xs text-ink-muted hover:text-ink transition-colors inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded">
              <Edit2 className="w-3 h-3" /> Edit
            </button>
          )}
        </CardHeader>
        <CardBody>
          {editingNotes ? (
            <div className="space-y-3">
              <Textarea value={notesDraft} onChange={e => setNotesDraft(e.target.value)} rows={3} autoFocus
                placeholder="Anything worth knowing about this property…" />
              <p className="text-[11px] text-ink-faint">Visible to the customer on their portal (“Notes from your provider”). Private notes belong on the customer’s profile.</p>
              <div className="flex items-center justify-end gap-2">
                <Button size="sm" variant="ghost" type="button" onClick={() => setEditingNotes(false)}>Cancel</Button>
                <Button size="sm" type="button" loading={savingNotes} onClick={saveNotes}>Save notes</Button>
              </div>
            </div>
          ) : property.notes ? (
            <p className="text-sm text-ink-muted whitespace-pre-wrap">{property.notes}</p>
          ) : (
            <p className="text-sm text-ink-faint">No notes yet — anything you write here also shows on the customer’s portal.</p>
          )}
        </CardBody>
      </Card>

      {/* Quick actions live in the timeline header — the two things you reach for
          from a property's history, using the same links as the properties list. */}
      <TimelineCard
        key={id}
        events={events}
        title="Property timeline"
        emptyText="Nothing has happened at this address yet."
        actions={
          <>
            <Link href={`/dashboard/properties/measure?id=${property.id}`}
              className="text-[11px] font-medium px-2 py-1 rounded-lg border border-border bg-surface text-ink hover:border-border-strong transition-colors inline-flex items-center gap-1">
              <Ruler className="w-3 h-3" /> Measure
            </Link>
            {property.customer_id && (
              <Link href={`/dashboard/quotes/new?customer=${property.customer_id}&property=${property.id}`}
                className="text-[11px] font-medium px-2 py-1 rounded-lg border border-border bg-surface text-ink hover:border-border-strong transition-colors inline-flex items-center gap-1">
                <FileText className="w-3 h-3" /> Quote
              </Link>
            )}
          </>
        }
      />
    </div>
  )
}
