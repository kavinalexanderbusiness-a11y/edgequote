'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { resolveSmsPricing, DEFAULT_SMS_PRICING, type SmsPricing } from './segments'

// One shared, lazily-loaded copy of the owner's SMS pricing config. Every <SmsCost>
// instance reads it via the hook, but it's fetched ONCE (module-cached) — so a page
// full of composers makes a single query. Falls back to the defaults if the column
// isn't migrated yet, so nothing breaks pre-migration.
let _cache: SmsPricing | null = null
let _promise: Promise<SmsPricing> | null = null

export async function loadSmsPricing(): Promise<SmsPricing> {
  if (_cache) return _cache
  if (!_promise) {
    _promise = (async () => {
      try {
        const supabase = createClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return DEFAULT_SMS_PRICING
        const { data } = await supabase.from('business_settings').select('sms_pricing').eq('user_id', user.id).maybeSingle()
        _cache = resolveSmsPricing((data as { sms_pricing?: unknown } | null)?.sms_pricing)
        return _cache
      } catch {
        return DEFAULT_SMS_PRICING   // column not migrated / offline → safe defaults
      }
    })()
  }
  return _promise
}

// Call after saving new pricing so composers pick up the change without a reload.
export function invalidateSmsPricing(next?: SmsPricing) {
  _cache = next ?? null
  _promise = next ? Promise.resolve(next) : null
}

export function useSmsPricing(): SmsPricing {
  const [pricing, setPricing] = useState<SmsPricing>(_cache ?? DEFAULT_SMS_PRICING)
  useEffect(() => {
    let active = true
    loadSmsPricing().then(p => { if (active) setPricing(p) })
    return () => { active = false }
  }, [])
  return pricing
}
