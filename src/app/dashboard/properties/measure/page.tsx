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

  useEffect(() => {
    async function load() {
      const id = new URLSearchParams(window.location.search).get('id')
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
      <MeasureTool property={property} />
      <PropertyMeasurementHistory propertyId={property.id} />
    </div>
  )
}
