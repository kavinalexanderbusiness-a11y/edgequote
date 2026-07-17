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
import { Home, Ruler, FileText, User, MapPin } from 'lucide-react'

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

      const [sources, setRes] = await Promise.all([
        loadPropertyTimelineSources(supabase, user.id, id),
        supabase.from('business_settings').select('gst_percent').eq('user_id', user.id).maybeSingle(),
      ])
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
      </div>

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
