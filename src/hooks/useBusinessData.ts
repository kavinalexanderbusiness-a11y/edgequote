'use client'

import { useSyncExternalStore, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { readCache, writeCache, CACHE_TTL } from '@/lib/clientCache'
import type { BusinessSettings, ServiceTemplate, TravelFeeTier } from '@/types'

// ── Shared business-data store ───────────────────────────────────────────────
// settings / templates / tiers are near-static yet read by many surfaces (quote
// builder, schedule, dashboard, settings cards…). Previously EVERY consumer ran
// its own 3-query fetch on mount. This module shares ONE fetch + a stale-while-
// revalidate cache across all consumers:
//   • revisits paint instantly from the sessionStorage cache (no spinner),
//   • concurrent mounts dedupe to a single network round-trip (one in-flight),
//   • any refresh() (e.g. after editing a template) updates EVERY consumer.
// The hook's return shape is unchanged, so it stays a drop-in for all callers.

interface Snapshot {
  settings: BusinessSettings | null
  templates: ServiceTemplate[]
  tiers: TravelFeeTier[]
}

const CACHE_KEY = 'business-data'

let store: Snapshot | null = null
let loadedAt = 0
let lastError: string | null = null
let inFlight: Promise<Snapshot | null> | null = null
const listeners = new Set<() => void>()

function emit() { for (const l of Array.from(listeners)) l() }
function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb) } }

async function fetchBusinessData(): Promise<Snapshot | null> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const [settingsRes, templatesRes, tiersRes] = await Promise.all([
    supabase.from('business_settings').select('*').eq('user_id', user.id).maybeSingle(),
    supabase.from('service_templates').select('*').eq('user_id', user.id).order('sort_order'),
    supabase.from('travel_fee_tiers').select('*').eq('user_id', user.id).order('sort_order'),
  ])
  return {
    settings: (settingsRes.data as BusinessSettings | null) ?? null,
    templates: (templatesRes.data as ServiceTemplate[]) || [],
    tiers: (tiersRes.data as TravelFeeTier[]) || [],
  }
}

// One shared, deduped load. force=true bypasses the in-flight share (used by refresh()).
function load(force = false): Promise<Snapshot | null> {
  if (inFlight && !force) return inFlight
  const p = fetchBusinessData()
    .then(snap => {
      if (snap) { store = snap; loadedAt = Date.now(); lastError = null; writeCache(CACHE_KEY, snap) }
      else { lastError = 'Not signed in' }
      emit()
      return snap
    })
    .catch(err => { lastError = err instanceof Error ? err.message : 'Failed to load business data'; emit(); return null })
    .finally(() => { if (inFlight === p) inFlight = null })
  inFlight = p
  return p
}

export function useBusinessData() {
  // getServerSnapshot returns null so SSR/first hydration render shows loading;
  // the client store takes over immediately after.
  const snap = useSyncExternalStore(subscribe, () => store, () => null)

  useEffect(() => {
    // First consumer: hydrate instantly from sessionStorage, then revalidate.
    if (!store) {
      const cached = readCache<Snapshot>(CACHE_KEY, CACHE_TTL.medium)
      if (cached) { store = cached; loadedAt = 0; emit() } // loadedAt=0 → stale → background revalidate
    }
    const fresh = store && Date.now() - loadedAt < CACHE_TTL.short
    if (!fresh) load()
  }, [])

  const refresh = useCallback(() => load(true).then(() => undefined), [])

  return {
    settings: snap?.settings ?? null,
    templates: snap?.templates ?? [],
    tiers: snap?.tiers ?? [],
    loading: snap === null && lastError === null,
    error: lastError,
    refresh,
  }
}
