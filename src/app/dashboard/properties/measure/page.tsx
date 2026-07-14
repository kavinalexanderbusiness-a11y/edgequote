'use client'

import { SkeletonRows } from '@/components/ui/Skeleton'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Property } from '@/types'
import { MeasureTool } from '@/components/properties/MeasureTool'
import { PropertyMeasurementHistory } from '@/components/properties/PropertyMeasurementHistory'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'
import { Home } from 'lucide-react'

export default function MeasurePage() {
  const supabase = createClient()
  const [property, setProperty] = useState<Property | null>(null)
  const [loading, setLoading] = useState(true)
  // Pricing only auto-appears when opened from a quote/scheduling workflow
  // (?context=quote). Opening the Measurements page on its own stays focused on
  // the measurement — no pricing.
  const [mode, setMode] = useState<'measure' | 'quote'>('measure')

  useEffect(() => {
    async function load() {
      const params = new URLSearchParams(window.location.search)
      const id = params.get('id')
      const ctx = params.get('context')
      setMode(ctx === 'quote' || ctx === 'pricing' ? 'quote' : 'measure')
      if (!id) { setLoading(false); return }
      const { data: { user } } = await supabase.auth.getUser()
      const { data } = await supabase
        .from('properties')
        .select('*')
        .eq('id', id)
        .eq('user_id', user!.id)
        .single()
      setProperty(data as Property | null)
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loading) return <SkeletonRows count={4} />
  // A bad/missing ?id must still offer a way out — a bare error line was a dead end.
  if (!property) return (
    <div className="max-w-4xl">
      <PageHeader crumb={{ label: 'Properties', href: '/dashboard/properties' }} title="Measure Property" />
      <EmptyState icon={Home} title="Property not found"
        description="This link points at a property that doesn't exist (or isn't yours). Pick one from your list to measure it."
        action={{ label: 'Open Properties', href: '/dashboard/properties' }} />
    </div>
  )

  return (
    <div className="max-w-4xl space-y-6">
      {/* Breadcrumb instead of history-back: this page is deep-linked from
          Customers, Data Quality and the command palette, where back() would
          leave the app or bounce somewhere unhelpful. */}
      <PageHeader crumb={{ label: 'Properties', href: '/dashboard/properties' }}
        title="Measure Property" description={property.address} />
      <MeasureTool property={property} context={mode} />
      <PropertyMeasurementHistory propertyId={property.id} />
    </div>
  )
}
