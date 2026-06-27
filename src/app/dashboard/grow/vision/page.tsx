import { createClient } from '@/lib/supabase/server'
import { aiEnabled } from '@/lib/ai/anthropic'
import { VisionClient, type VisionPropertyLite } from '@/components/grow/vision/VisionClient'
import type { ConfidenceBand, Difficulty } from '@/lib/vision/types'

// AI Vision — the property's AI brain. Server-fetches the owner's properties with
// their photo counts + any existing analysis headline, then hands off to the
// interactive picker. Everything is RLS-scoped to the owner.
export default async function VisionPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null // the dashboard layout already redirects unauthenticated users

  const [propsRes, photosRes, intelRes] = await Promise.all([
    supabase
      .from('properties')
      .select('id, address, neighborhood, lat, lng, customers(name)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false }),
    supabase.from('job_photos').select('property_id').eq('user_id', user.id),
    supabase
      .from('property_intelligence')
      .select('property_id, confidence_band, mowing_difficulty')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false }),
  ])

  // Photo counts per property.
  const photoCounts = new Map<string, number>()
  for (const r of (photosRes.data as { property_id: string | null }[] | null) || []) {
    if (r.property_id) photoCounts.set(r.property_id, (photoCounts.get(r.property_id) || 0) + 1)
  }

  // Latest active analysis headline per property (rows already newest-first).
  const intelByProp = new Map<string, { confidence_band: ConfidenceBand | null; mowing_difficulty: Difficulty | null }>()
  for (const r of (intelRes.data as { property_id: string; confidence_band: ConfidenceBand | null; mowing_difficulty: Difficulty | null }[] | null) || []) {
    if (!intelByProp.has(r.property_id)) intelByProp.set(r.property_id, r)
  }

  const rows = (propsRes.data as Array<{
    id: string; address: string; neighborhood: string | null
    lat: number | null; lng: number | null; customers: { name: string | null } | { name: string | null }[] | null
  }> | null) || []

  const properties: VisionPropertyLite[] = rows.map(p => {
    const cust = Array.isArray(p.customers) ? p.customers[0] : p.customers
    const headline = intelByProp.get(p.id)
    return {
      id: p.id,
      address: p.address,
      neighborhood: p.neighborhood,
      hasLocation: p.lat != null && p.lng != null,
      customerName: cust?.name ?? null,
      photoCount: photoCounts.get(p.id) || 0,
      hasAnalysis: !!headline,
      confidence_band: headline?.confidence_band ?? null,
      mowing_difficulty: headline?.mowing_difficulty ?? null,
    }
  })

  return <VisionClient properties={properties} aiEnabled={aiEnabled()} />
}
