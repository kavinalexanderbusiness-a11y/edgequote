'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Property } from '@/types'
import { MeasureTool } from '@/components/properties/MeasureTool'
import { PropertyMeasurementHistory } from '@/components/properties/PropertyMeasurementHistory'
import { PageHeader } from '@/components/layout/PageHeader'
import { ArrowLeft } from 'lucide-react'

export default function MeasurePage() {
  const router = useRouter()
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

  if (loading) return <div className="text-center py-16 text-sm text-ink-muted">Loading...</div>
  if (!property) return <div className="text-center py-16 text-sm text-red-400">Property not found.</div>

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => router.back()} className="text-ink-muted hover:text-ink transition-colors">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <PageHeader title="Measure Property" description={property.address} />
      </div>
      <MeasureTool property={property} context={mode} />
      <PropertyMeasurementHistory propertyId={property.id} />
    </div>
  )
}
