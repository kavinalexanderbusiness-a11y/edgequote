'use client'

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  FALLBACK_TIME_ZONE, isValidTimeZone, safeTimeZone, tenantTodayISO,
} from '@/lib/tenantTime'

// ── One clock for the whole dashboard ────────────────────────────────────────
//
// ⭐⭐ WHY A PROVIDER AND NOT A HELPER EACH PAGE CALLS. The bug this exists to
// remove is not that any one surface computed the date wrongly — it is that
// several surfaces each computed it INDEPENDENTLY and got different answers at
// the same moment. The Dashboard, the Schedule and Weather could show three
// different days: one read the device's clock, one read UTC, one read a value
// derived a third way. A shared helper would still have been called at three
// different instants with three different assumptions.
//
// So the zone is read ONCE, here, and "what day is it" is answered once, for
// everybody, from the same value.
//
// ⭐ THE ZONE ALREADY EXISTED. `business_settings.timezone` is IANA, NOT NULL,
// and defaults to 'America/Edmonton'. Before this it had exactly one reader in
// the entire application (lib/comms/governor's quiet hours). Nothing new is
// being stored; a setting the product already had is finally being consulted.
//
// ⚠️ `ready` is not decoration. Until the row is read we do not know the
// business's zone, and rendering "Today" from a guess is exactly how the wrong
// day gets shown for the first few hundred milliseconds of every page load —
// which is worse than a skeleton, because it looks like an answer.

interface TenantTime {
  /** The business's IANA zone. Always usable; falls back rather than throwing. */
  timeZone: string
  /** yyyy-MM-dd in the business's zone. Re-derived as the day rolls over. */
  todayISO: string
  /** False until the tenant's row has actually been read. */
  ready: boolean
  /** True when the stored value was missing or unusable and the fallback is in play. */
  usingFallback: boolean
}

const Ctx = createContext<TenantTime>({
  timeZone: FALLBACK_TIME_ZONE,
  todayISO: tenantTodayISO(FALLBACK_TIME_ZONE),
  ready: false,
  usingFallback: true,
})

export function TenantTimeProvider({ children }: { children: React.ReactNode }) {
  const [timeZone, setTimeZone] = useState<string>(FALLBACK_TIME_ZONE)
  const [ready, setReady] = useState(false)
  const [usingFallback, setUsingFallback] = useState(true)
  // Bumped by the rollover timer below so `todayISO` recomputes.
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { if (alive) setReady(true); return }
      const { data, error } = await supabase
        .from('business_settings').select('timezone').eq('user_id', user.id).maybeSingle()
      if (!alive) return
      // ⚠️ A FAILED READ IS NOT "no timezone". It keeps the fallback AND keeps
      // saying so through `usingFallback`, so a surface that cares can tell the
      // difference between "this business is in Edmonton" and "we could not ask".
      const stored = error ? null : (data as { timezone: string | null } | null)?.timezone ?? null
      setTimeZone(safeTimeZone(stored))
      setUsingFallback(!isValidTimeZone(stored))
      setReady(true)
    })()
    return () => { alive = false }
  }, [])

  // ── The day has to roll over on its own ────────────────────────────────────
  // A dashboard left open overnight — which is most of them, on a yard office
  // monitor — would otherwise keep saying "Today" about yesterday until someone
  // reloaded. Checking once a minute is enough for a date boundary and costs
  // nothing; it compares the DERIVED date, so it fires on the tenant's midnight
  // rather than the device's.
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  const value = useMemo<TenantTime>(() => ({
    timeZone,
    todayISO: tenantTodayISO(timeZone),
    ready,
    usingFallback,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [timeZone, ready, usingFallback, tick])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/**
 * THE tenant clock. Every surface that says "today" reads it from here.
 *
 * ⛔ Do not fall back to `localTodayISO()` in a component. That reads the
 * DEVICE's zone in the browser and UTC on the server, which is the disagreement
 * this provider exists to end.
 */
export function useTenantTime(): TenantTime {
  return useContext(Ctx)
}

/** Shorthand for the common case. */
export function useTenantToday(): string {
  return useContext(Ctx).todayISO
}
