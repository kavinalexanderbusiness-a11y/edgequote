'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { fieldBorder } from '@/components/ui/fieldStyles'
import { PageContainer } from '@/components/layout/PageContainer'
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
import { CustomFieldsSection } from '@/components/customFields/CustomFieldsSection'
import { Textarea } from '@/components/ui/Textarea'
import { AddressAutocomplete } from '@/components/ui/AddressAutocomplete'
import { getPropertyContext, type PropertyIntelligence } from '@/lib/ai/propertyContext'
import { LocationSummaryCard } from '@/components/properties/LocationSummaryCard'
import { loadLocationSummary } from '@/lib/locationSummaryData'
import type { LocationSummary } from '@/lib/locationSummary'
import { toast } from '@/lib/toast'
import { Home, Ruler, FileText, User, MapPin, Edit2, StickyNote, Sparkles, CalendarPlus, CalendarClock } from 'lucide-react'

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
  // Read inside load()'s synchronous head to decide skeleton-vs-repaint without
  // making `load` depend on them (which would re-run it).
  const loadedIdRef = useRef<string | null>(null)
  const propertyRef = useRef<Property | null>(null)
  propertyRef.current = property
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null)
  const [events, setEvents] = useState<ReturnType<typeof buildTimeline>>([])
  // Sources whose read failed — the card names them rather than letting a short
  // history read as the whole history.
  const [missing, setMissing] = useState<string[]>([])
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
  // This address's operational memory. Null while it is still being read — the
  // card renders its own small placeholder rather than blanking the page, and it
  // carries its OWN failure state (visitsUnknown) so a broken visit read says so
  // instead of reading as "never serviced".
  const [summary, setSummary] = useState<LocationSummary | null>(null)
  // The customer's OTHER locations — one-tap hops between a landlord's addresses
  // without the round trip through their profile. Navigation sugar: a failed read
  // renders no chips (a missing shortcut, not a wrong claim).
  const [siblings, setSiblings] = useState<{ id: string; address: string; is_primary: boolean }[]>([])

  useEffect(() => {
    let active = true
    async function load() {
      // Skeleton ONLY when there is nothing trustworthy on screen: a genuine
      // property switch (its predecessor's history must never sit under the new
      // address — the guarantee this check exists for) or a retry from the
      // error/not-found state, where Retry would otherwise look dead.
      // A background refresh — a realtime echo, a live quote at this address —
      // repaints in place instead of blanking the page mid-read and unmounting
      // an open, autofocused editor. Same rule the customer profile already
      // follows: skeleton on first mount, never on a refresh.
      const isSwitch = loadedIdRef.current !== id
      loadedIdRef.current = id   // set at START, so a Retry doesn't re-skeleton
      if (isSwitch || !propertyRef.current) setLoading(true)
      // The summary is ABOUT one address, so a switch must clear it before the
      // new read lands — the predecessor's "next visit" sitting under a new
      // address is the same guarantee the skeleton rule above exists for.
      if (isSwitch) setSummary(null)
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

      const [tl, setRes, ctx, loc, sibRes] = await Promise.all([
        loadPropertyTimelineSources(supabase, user.id, id),
        supabase.from('business_settings').select('gst_percent').eq('user_id', user.id).maybeSingle(),
        getPropertyContext(supabase, id),
        // Its own read, under its own failure contract — see lib/locationSummaryData
        // for why this does not ride on the timeline's sources. A thrown request
        // becomes an UNKNOWN summary, never an empty one.
        loadLocationSummary(supabase, user.id, id)
          .catch((): LocationSummary => ({
            visitsUnknown: true, lastVisit: null, nextVisit: null, completedCount: null,
            services: [], typicalDuration: null, timedVisits: null, photoCount: null,
          })),
        // Sibling locations for the switcher — primary first, same order as every
        // other picker. Tenant-scoped like the property read above.
        prop.customer_id
          ? supabase.from('properties').select('id, address, is_primary').eq('customer_id', prop.customer_id).eq('user_id', user.id).neq('id', id).order('is_primary', { ascending: false }).order('address')
          : Promise.resolve({ data: null, error: null }),
      ])
      // Two independent honesty contracts, both preserved: `missing` names the
      // timeline sources that failed, `summary.visitsUnknown` says the summary's
      // own visit read did. Neither can speak for the other.
      if (active) {
        setInsight(ctx); setMissing(tl.missing); setSummary(loc)
        setSiblings((sibRes.data as { id: string; address: string; is_primary: boolean }[] | null) ?? [])
      }
      const all = buildTimeline({
        ...tl.sources,
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
    // Patch what we just wrote instead of re-running the whole loader. The
    // nulls matter: lat/lng/neighborhood were cleared above, so the "Located"
    // pin must stop claiming a position we no longer have. Patched only AFTER
    // the error check — these are direct writes with no offline queue, so
    // optimistic state must never outlive a failed one. The live `properties`
    // subscription still delivers the echo as the backstop.
    setProperty(p => p ? {
      ...p,
      address: addrDraft.address.trim(),
      city: addrDraft.city.trim() || null,
      province: addrDraft.province.trim() || null,
      postal_code: addrDraft.postal.trim() || null,
      lat: null, lng: null, neighborhood: null,
    } : p)
  }

  // PRIVATE notes about the place. Separate write from saveNotes below and
  // deliberately so: that one is the customer's copy. Returns whether it stuck,
  // so the card only leaves edit mode on a write that actually landed — and the
  // optimistic patch happens AFTER the error check, never before.
  async function saveInternalNotes(v: string): Promise<boolean> {
    if (!property) return false
    const next = v.trim() || null
    const { error } = await supabase.from('properties').update({ internal_notes: next }).eq('id', property.id)
    if (error) { toast.error('Could not save the access notes: ' + error.message); return false }
    setProperty(p => p ? { ...p, internal_notes: next } : p)
    return true
  }

  async function saveNotes() {
    if (!property) return
    setSavingNotes(true)
    const { error } = await supabase.from('properties').update({ notes: notesDraft.trim() || null }).eq('id', property.id)
    setSavingNotes(false)
    if (error) { toast.error('Could not save the notes: ' + error.message); return }
    setEditingNotes(false)
    setProperty(p => p ? { ...p, notes: notesDraft.trim() || null } : p)
  }

  if (loading) return <PageContainer width="narrow"><SkeletonRows count={5} /></PageContainer>

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
    <PageContainer width="narrow">
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

      {/* The customer's other locations — hop between a landlord's addresses
          without the round trip through their profile. Absent for the common
          one-location customer, capped for the forty-address landlord (the
          full list lives on the profile's Properties card, one tap away). */}
      {siblings.length > 0 && customer && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-ink-faint">{customer.name.split(' ')[0]}’s other locations:</span>
          {siblings.slice(0, 6).map(s => (
            <Link key={s.id} href={`/dashboard/properties/${s.id}`}
              className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1 text-[11px] font-medium text-ink-muted hover:text-ink hover:border-border-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              <Home className="w-3 h-3 shrink-0 text-ink-faint" aria-hidden />
              {s.address}{s.is_primary ? ' · primary' : ''}
            </Link>
          ))}
          {siblings.length > 6 && (
            <Link href={`/dashboard/customers/${customer.id}`} className="text-[11px] text-accent-text hover:underline">
              +{siblings.length - 6} more
            </Link>
          )}
        </div>
      )}

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
                className={`rounded-xl border bg-bg-tertiary px-3 py-2 text-sm text-ink placeholder:text-ink-faint outline-none transition-all ${fieldBorder()}`} aria-label="City" />
              <input value={addrDraft.province} onChange={e => setAddrDraft(d => ({ ...d, province: e.target.value }))} placeholder="Province"
                className={`rounded-xl border bg-bg-tertiary px-3 py-2 text-sm text-ink placeholder:text-ink-faint outline-none transition-all ${fieldBorder()}`} aria-label="Province" />
              <input value={addrDraft.postal} onChange={e => setAddrDraft(d => ({ ...d, postal: e.target.value }))} placeholder="Postal code"
                className={`rounded-xl border bg-bg-tertiary px-3 py-2 text-sm text-ink placeholder:text-ink-faint outline-none transition-all ${fieldBorder()}`} aria-label="Postal code" />
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button size="sm" variant="ghost" type="button" onClick={() => setEditingAddress(false)}>Cancel</Button>
              <Button size="sm" type="button" loading={savingAddress} disabled={!addrDraft.address.trim()} onClick={saveAddress}>Save address</Button>
            </div>
          </CardBody>
        </Card>
      )}

      {/* What this address remembers. FIRST after identity, because it is the
          only block on this page that is useful while standing at the gate —
          everything below it (AI insight, customer-facing notes, the full
          timeline) is desk reading. */}
      <LocationSummaryCard
        summary={summary}
        internalNotes={property.internal_notes ?? null}
        onSaveInternalNotes={saveInternalNotes}
        onRetry={reload}
        photosHref="#property-history"
      />

      {/* Whatever this business records about a service location — a gate code, a
          building type. Sits with the other at-the-gate information rather than
          down among the desk reading. */}
      <CustomFieldsSection entity="property" recordId={property.id} />

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
          <h2 className="text-sm font-semibold text-ink flex items-center gap-2">
            <StickyNote className="w-4 h-4 text-accent-text" /> Property notes
            {/* The visibility is part of the NAME, not a caption revealed while
                editing. Two note fields now live on this page and the only thing
                that distinguishes them is who reads them, so both say so at rest. */}
            <span className="text-xs font-normal text-ink-faint">· shared with the customer</span>
          </h2>
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
                // ⌘/Ctrl+Enter saves, Escape cancels — same keyboard contract as
                // ui/Modal and the customer-profile note editor. Mirrors the buttons below.
                onKeyDown={e => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (!savingNotes) saveNotes() }
                  else if (e.key === 'Escape') { e.preventDefault(); setEditingNotes(false) }
                }}
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
            <p className="text-sm text-ink-faint">No notes yet — anything you write here also shows on the customer’s portal. Gate codes and access details belong in “Access &amp; site notes” above.</p>
          )}
        </CardBody>
      </Card>

      {/* Quick actions live in the timeline header — the things you reach for from a
          property's history, using the SAME deep links the customer profile's per-
          property cards use (?customer&property), so the target opens pre-scoped to
          THIS address, not the customer's primary. Quote and Schedule need a customer
          (a quote/visit is billed to someone); Measure is about the address alone. */}
      {/* The summary's photo door targets this — the photos ARE timeline events,
          so the honest destination is the history that already renders them
          rather than a second gallery that would have to stay in sync. */}
      <div id="property-history" className="scroll-mt-4">
      <TimelineCard
        key={id}
        events={events}
        missing={missing}
        onRetry={reload}
        title="Property timeline"
        emptyText="Nothing has happened at this address yet."
        actions={
          <>
            {property.customer_id && (
              <Link href={`/dashboard/quotes/new?customer=${property.customer_id}&property=${property.id}`}
                className="text-[11px] font-medium px-2 py-1 rounded-lg border border-border bg-surface text-ink hover:border-border-strong transition-colors inline-flex items-center gap-1">
                <FileText className="w-3 h-3" /> Quote
              </Link>
            )}
            {property.customer_id && (
              // The gap this closes: you could measure and quote a property here, but to
              // book a visit for it you had to leave for the customer profile and re-pick
              // the address. The schedule route already pre-fills the property from
              // ?property= (the profile's own Schedule link proves it).
              <Link href={`/dashboard/schedule?customer=${property.customer_id}&property=${property.id}`}
                className="text-[11px] font-medium px-2 py-1 rounded-lg border border-border bg-surface text-ink hover:border-border-strong transition-colors inline-flex items-center gap-1">
                <CalendarPlus className="w-3 h-3" /> Schedule
              </Link>
            )}
            {property.customer_id && (
              // A visit to price the work, not to do it. CalendarClock rather
              // than the Ruler this page already spends on Measure — two rulers
              // side by side would read as one feature.
              <Link href={`/dashboard/schedule?estimate=new&customer=${property.customer_id}&property=${property.id}`}
                title="Book a visit to look at the work and quote it"
                className="text-[11px] font-medium px-2 py-1 rounded-lg border border-border bg-surface text-ink hover:border-border-strong transition-colors inline-flex items-center gap-1">
                <CalendarClock className="w-3 h-3" /> Estimate
              </Link>
            )}
            <Link href={`/dashboard/properties/measure?id=${property.id}`}
              className="text-[11px] font-medium px-2 py-1 rounded-lg border border-border bg-surface text-ink hover:border-border-strong transition-colors inline-flex items-center gap-1">
              <Ruler className="w-3 h-3" /> Measure
            </Link>
          </>
        }
      />
      </div>
    </PageContainer>
  )
}
