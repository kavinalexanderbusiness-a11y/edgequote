'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { FEATURE_MODULES, visibleModules } from '@/lib/modules'

// ── ONE loader for per-business module composition ────────────────────────────
// Reads business_settings.enabled_modules and exposes the registry filtered by
// it. Consumers: the command palette (navigation), the Modules settings surface
// (management). The pre-load state is null — which means "all modules", the
// same as a NULL column — so nothing flickers and nothing is hidden by accident.
//
// Semantics worth keeping intact:
//   null  = every module, INCLUDING ones added in future releases (the default)
//   [...] = exactly these non-core keys (core modules always show)
// setEnabled(null) is therefore not the same as setEnabled(allKeys): the first
// opts back into future modules automatically, the second freezes today's set.

export function useModules() {
  const [enabled, setEnabledState] = useState<unknown>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    async function load() {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid) { if (alive) setLoaded(true); return }
      const { data } = await supabase.from('business_settings').select('enabled_modules').eq('user_id', uid).maybeSingle()
      if (!alive) return
      setEnabledState((data as { enabled_modules: unknown } | null)?.enabled_modules ?? null)
      setLoaded(true)
    }
    load()
    // Every consumer (sidebar, palette, settings) refreshes the moment any of
    // them saves a new composition — same event idiom as the command palette.
    const onChanged = () => load()
    window.addEventListener('eq:modules-changed', onChanged)
    return () => { alive = false; window.removeEventListener('eq:modules-changed', onChanged) }
  }, [])

  // Persist a new composition. Optimistic — reverts and reports on failure.
  const setEnabled = useCallback(async (keys: string[] | null): Promise<string | null> => {
    const prev = enabled
    setEnabledState(keys)
    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()
    const uid = session?.user?.id
    if (!uid) { setEnabledState(prev); return 'Not signed in.' }
    const { error } = await supabase.from('business_settings').update({ enabled_modules: keys }).eq('user_id', uid)
    if (error) { setEnabledState(prev); return error.message }
    window.dispatchEvent(new Event('eq:modules-changed'))
    return null
  }, [enabled])

  return { all: FEATURE_MODULES, visible: visibleModules(enabled), enabled, loaded, setEnabled }
}
