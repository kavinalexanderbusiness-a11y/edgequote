'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  FEATURE_MODULES, visibleModules, installedKeys, normalizeEnabled,
  installSet, uninstallSet, uninstallBlockers, stampMeta, readMeta,
  dependencyClosure, moduleByKey, type ModuleMetaMap,
} from '@/lib/modules'

// ── ONE loader for per-business module composition ────────────────────────────
// Reads business_settings.enabled_modules + module_meta and exposes the
// registry filtered by them, plus the install/uninstall workflow. Consumers:
// the sidebar and command palette (navigation) and the Modules settings
// surface (management). The pre-load state is null — "all modules", the same
// as a NULL column — so nothing flickers and nothing is hidden by accident.
//
// Storage semantics (see lib/modules):
//   enabled_modules null = every module, INCLUDING future releases (default)
//   enabled_modules [..] = exactly these non-core keys (core always shows)
//   module_meta          = { key: { v: installedVersion, at: ISO } } — the
//                          update system's memory of what each business has.

export function useModules() {
  const [enabled, setEnabledState] = useState<unknown>(null)
  const [meta, setMeta] = useState<ModuleMetaMap>({})
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    async function load() {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid) { if (alive) setLoaded(true); return }
      const { data } = await supabase.from('business_settings').select('enabled_modules, module_meta').eq('user_id', uid).maybeSingle()
      if (!alive) return
      const d = data as { enabled_modules: unknown; module_meta: unknown } | null
      setEnabledState(d?.enabled_modules ?? null)
      setMeta(readMeta(d?.module_meta))
      setLoaded(true)
    }
    load()
    // Every consumer (sidebar, palette, settings) refreshes the moment any of
    // them saves a new composition — same event idiom as the command palette.
    const onChanged = () => load()
    window.addEventListener('eq:modules-changed', onChanged)
    return () => { alive = false; window.removeEventListener('eq:modules-changed', onChanged) }
  }, [])

  // One writer for both columns — optimistic, reverts and reports on failure.
  const persist = useCallback(async (
    nextEnabled: string[] | null,
    nextMeta: ModuleMetaMap,
  ): Promise<string | null> => {
    const prevEnabled = enabled
    const prevMeta = meta
    setEnabledState(nextEnabled)
    setMeta(nextMeta)
    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()
    const uid = session?.user?.id
    if (!uid) { setEnabledState(prevEnabled); setMeta(prevMeta); return 'Not signed in.' }
    const { error } = await supabase.from('business_settings')
      .update({ enabled_modules: nextEnabled, module_meta: nextMeta }).eq('user_id', uid)
    if (error) { setEnabledState(prevEnabled); setMeta(prevMeta); return error.message }
    window.dispatchEvent(new Event('eq:modules-changed'))
    return null
  }, [enabled, meta])

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
