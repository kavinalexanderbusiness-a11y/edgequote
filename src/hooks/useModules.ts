'use client'

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  FEATURE_MODULES, visibleModules, installedKeys, normalizeEnabled,
  installSet, uninstallSet, uninstallBlockers, stampMeta, readMeta,
  dependencyClosure, moduleByKey, type ModuleMetaMap,
} from '@/lib/modules'

// ── ONE loader for per-business module composition ────────────────────────────
// Reads business_settings.enabled_modules + module_meta and exposes the
// registry filtered by them, plus the install/uninstall workflow. Consumers:
// the sidebar, bottom nav and command palette (navigation — mounted on EVERY
// dashboard page) and the marketplace/settings surfaces (management).
//
// Shared store, same shape as useBusinessData: all consumers read ONE
// module-level snapshot, concurrent mounts dedupe to a single network
// round-trip, and a revisit paints from the last snapshot instantly while a
// background revalidate keeps it honest. Before this, every consumer ran its
// own getSession + business_settings query on every mount — three identical
// round-trips per page load just to draw navigation. The hook's return shape
// is unchanged, so it stays a drop-in for all callers.
//
// The pre-load state is null — "all modules", the same as a NULL column — so
// nothing flickers and nothing is hidden by accident.
//
// Storage semantics (see lib/modules):
//   enabled_modules null = every module, INCLUDING future releases (default)
//   enabled_modules [..] = exactly these non-core keys (core always shows)
//   module_meta          = { key: { v: installedVersion, at: ISO } } — the
//                          update system's memory of what each business has.

interface ModulesSnapshot {
  enabled: unknown
  meta: ModuleMetaMap
}

let store: ModulesSnapshot | null = null
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

function emit() { for (const l of Array.from(listeners)) l() }
function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb) } }
function getSnapshot() { return store }
function getServerSnapshot() { return null }

// Stale-while-revalidate: every mount calls this, but concurrent callers share
// one round-trip and an existing snapshot keeps serving until fresh data lands.
function loadModules(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid) { store = store ?? { enabled: null, meta: {} }; emit(); return }
      const { data } = await supabase.from('business_settings').select('enabled_modules, module_meta').eq('user_id', uid).maybeSingle()
      const d = data as { enabled_modules: unknown; module_meta: unknown } | null
      store = { enabled: d?.enabled_modules ?? null, meta: readMeta(d?.module_meta) }
      emit()
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

export function useModules() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const enabled = snap?.enabled ?? null
  const meta = snap?.meta ?? {}
  const loaded = snap !== null

  useEffect(() => {
    loadModules()
    // Every consumer refreshes the moment any of them saves a new composition —
    // same event idiom as before; with the shared store one reload now feeds
    // every consumer at once.
    const onChanged = () => { loadModules() }
    window.addEventListener('eq:modules-changed', onChanged)
    return () => { window.removeEventListener('eq:modules-changed', onChanged) }
  }, [])

  // One writer for both columns — optimistic through the shared store (every
  // consumer sees the change immediately), reverts and reports on failure.
  const persist = useCallback(async (
    nextEnabled: string[] | null,
    nextMeta: ModuleMetaMap,
  ): Promise<string | null> => {
    const prev = store
    store = { enabled: nextEnabled, meta: nextMeta }
    emit()
    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()
    const uid = session?.user?.id
    if (!uid) { store = prev; emit(); return 'Not signed in.' }
    const { error } = await supabase.from('business_settings')
      .update({ enabled_modules: nextEnabled, module_meta: nextMeta }).eq('user_id', uid)
    if (error) { store = prev; emit(); return error.message }
    window.dispatchEvent(new Event('eq:modules-changed'))
    return null
  }, [])

  // Install a module: pulls in its dependency closure atomically and stamps
  // each newly-installed module's version. Returns an error message or null.
  const install = useCallback(async (key: string): Promise<string | null> => {
    const current = installedKeys(enabled)
    const next = installSet(current, key)
    const added = next.filter(k => !current.includes(k))
    return persist(normalizeEnabled(next), stampMeta(meta, added.length ? added : [key]))
  }, [enabled, meta, persist])

  // Uninstall a module: refused while installed modules depend on it — the
  // error names them, so the owner knows exactly what to remove first.
  const uninstall = useCallback(async (key: string): Promise<string | null> => {
    const m = moduleByKey(key)
    if (m?.core) return `${m.label} is a core module and can't be removed.`
    const current = installedKeys(enabled)
    const blockers = uninstallBlockers(current, key)
    if (blockers.length) {
      return `${m?.label ?? key} is needed by ${blockers.map(b => b.label).join(', ')} — remove ${blockers.length === 1 ? 'that module' : 'those modules'} first.`
    }
    return persist(normalizeEnabled(uninstallSet(current, key)), meta)
  }, [enabled, meta, persist])

  // Acknowledge a module update (the "Updated" badge) — stamps current version.
  const acknowledgeUpdate = useCallback(async (key: string): Promise<string | null> => {
    return persist(Array.isArray(enabled) ? installedKeys(enabled) : null, stampMeta(meta, [key]))
  }, [enabled, meta, persist])

  return {
    all: FEATURE_MODULES,
    visible: visibleModules(enabled),
    installed: installedKeys(enabled),
    enabled,
    meta,
    loaded,
    install,
    uninstall,
    acknowledgeUpdate,
    /** Preview helper for UIs: what else an install would bring along. */
    wouldInstall: (key: string) => dependencyClosure(key).filter(k => !installedKeys(enabled).includes(k)),
  }
}
