'use client'

import { useSyncExternalStore, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cacheLease, getCacheOwner, isCurrentLease, readCache, writeCache, CACHE_TTL, type CacheLease } from '@/lib/clientCache'
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
//
// ── OWNED BY ONE ACCOUNT, IN MEMORY TOO ──────────────────────────────────────
// The snapshot below is consulted BEFORE the persistent cache, so an
// owner-checked readCache cannot protect it. Review traced the chain: A loads,
// A signs out, B signs in (a client navigation — this module survives), B's
// first render reads A's settings/templates/tiers from `store`, `readCache` is
// never asked because `store` is set, and the 2-minute freshness gate skips the
// fetch — A's company name, owner name and phone in B's editable Settings form,
// with no network activity at all. So the snapshot carries the account it was
// loaded for and is served only while lib/clientCache names that same account
// (the dashboard layout adopts the owner during render, before any consumer
// renders — there is no first foreign paint). A different owner sees "no
// snapshot" and loads its own; the in-flight fetch is reused only for the
// account and generation it was started for; a completion whose lease is no
// longer current applies nothing, in memory or on disk. Fails closed.

interface Snapshot {
  settings: BusinessSettings | null
  templates: ServiceTemplate[]
  tiers: TravelFeeTier[]
}

const CACHE_KEY = 'business-data'

let store: Snapshot | null = null
let storeOwner: string | null = null       // whose snapshot `store` is
let loadedAt = 0
let lastError: string | null = null
let inFlight: Promise<Snapshot | null> | null = null
let inFlightLease: CacheLease | null = null // whom the in-flight fetch was started for
const listeners = new Set<() => void>()

function emit() { for (const l of Array.from(listeners)) l() }
function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb) } }

// Is the snapshot in memory this account's? Pure: reads answer null for a
// foreign snapshot without touching it; the effect path drops it.
function owned(): boolean { return store !== null && storeOwner === getCacheOwner() }

/** The snapshot for the CURRENT account, or null. (Exported for the guard; the hook reads it.) */
export function peekBusinessData(): Snapshot | null { return owned() ? store : null }

// Drop a snapshot that is not this account's. Called before anything that
// serves or loads, so the memory can never outlive the account it belongs to.
function dropForeign(): void {
  if (store !== null && storeOwner !== getCacheOwner()) { store = null; storeOwner = null; loadedAt = 0; lastError = null }
}

async function fetchBusinessData(): Promise<Snapshot | null> {
  const supabase = createClient()
  // getSession (local read), not getUser (network hop): the id only scopes RLS-filtered reads.
  const { data: { session } } = await supabase.auth.getSession()
  const user = session?.user
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

/** One shared, deduped load — deduped only within the account and generation
 *  it was started for. force=true bypasses the in-flight share (refresh()).
 *  (Exported for the guard; the hook calls it.) */
export function loadBusinessData(force = false): Promise<Snapshot | null> {
  dropForeign()
  if (inFlight && !force && isCurrentLease(inFlightLease)) return inFlight
  const lease = cacheLease()
  const p = fetchBusinessData()
    .then(snap => {
      // Fetched for an account (or a session of it) that is no longer current:
      // apply nothing, anywhere. The current account's own load will land.
      if (!isCurrentLease(lease)) return snap
      if (snap) { store = snap; storeOwner = lease!.owner; loadedAt = Date.now(); lastError = null; writeCache(CACHE_KEY, snap, { lease }) }
      else { lastError = 'Not signed in' }
      emit()
      return snap
    })
    .catch(err => { if (isCurrentLease(lease)) { lastError = err instanceof Error ? err.message : 'Failed to load business data'; emit() } return null })
    .finally(() => { if (inFlight === p) { inFlight = null; inFlightLease = null } })
  inFlight = p
  inFlightLease = lease
  return p
}

/** What a consumer's mount does: hydrate this account's snapshot from the
 *  persistent cache if memory is empty, then revalidate unless fresh.
 *  (Exported for the guard; the hook's effect calls it.) */
export function ensureBusinessData(): void {
  dropForeign()
  if (!store) {
    const cached = readCache<Snapshot>(CACHE_KEY, CACHE_TTL.medium) // owner-checked: only this account's
    if (cached) { store = cached; storeOwner = getCacheOwner(); loadedAt = 0; emit() } // loadedAt=0 → stale → background revalidate
  }
  const fresh = store && Date.now() - loadedAt < CACHE_TTL.short
  if (!fresh) void loadBusinessData()
}

export function useBusinessData() {
  // getServerSnapshot returns null so SSR/first hydration render shows loading;
  // the client store takes over immediately after.
  const snap = useSyncExternalStore(subscribe, peekBusinessData, () => null)

  useEffect(() => { ensureBusinessData() }, [])

  const refresh = useCallback(() => loadBusinessData(true).then(() => undefined), [])

  return {
    settings: snap?.settings ?? null,
    templates: snap?.templates ?? [],
    tiers: snap?.tiers ?? [],
    loading: snap === null && lastError === null,
    error: lastError,
    refresh,
  }
}
