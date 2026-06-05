'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { BusinessSettings, ServiceTemplate, TravelFeeTier } from '@/types'

export function useBusinessData() {
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [templates, setTemplates] = useState<ServiceTemplate[]>([])
  const [tiers, setTiers] = useState<TravelFeeTier[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const supabase = createClient()

  const refresh = useCallback(async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setError('Not signed in'); setLoading(false); return }

      const [settingsRes, templatesRes, tiersRes] = await Promise.all([
        supabase.from('business_settings').select('*').eq('user_id', user.id).maybeSingle(),
        supabase.from('service_templates').select('*').eq('user_id', user.id).order('sort_order'),
        supabase.from('travel_fee_tiers').select('*').eq('user_id', user.id).order('sort_order'),
      ])

      setSettings(settingsRes.data)
      setTemplates(templatesRes.data || [])
      setTiers(tiersRes.data || [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load business data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  return { settings, templates, tiers, loading, error, refresh }
}