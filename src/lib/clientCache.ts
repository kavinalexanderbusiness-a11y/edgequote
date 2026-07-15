// ── Client-side stale-while-revalidate cache ─────────────────────────────────────
// Heavy dashboard reports (BI, Revenue Intelligence, Labor) recompute the same
// numbers every visit. Cache the RESULT in sessionStorage so re-opening a page is
// instant — show the cached value immediately, then refresh in the background.
// Scoped to the tab/session; clears on close. Safe no-ops if storage is unavailable.
//
// `{ persist: true }` promotes an entry to localStorage instead. That's for data a
// contractor must still see with no signal after the phone has killed the app —
// sessionStorage dies with the tab, so a driveway cold-start would show an empty
// day. Same key namespace and shape either way; only the backing store differs.

interface Cached<T> { t: number; data: T }

interface CacheOpts { persist?: boolean }

// localStorage survives an app kill; sessionStorage is the tab-scoped default.
// Both can throw (private mode, disabled storage) — every caller treats that as
// "no cache" rather than an error.
function store(opts?: CacheOpts): Storage {
  return opts?.persist ? localStorage : sessionStorage
}

export function readCache<T>(key: string, maxAgeMs: number, opts?: CacheOpts): T | null {
  try {
    const raw = store(opts).getItem('eq:' + key)
    if (!raw) return null
    const c = JSON.parse(raw) as Cached<T>
    if (Date.now() - c.t > maxAgeMs) return null
    return c.data
  } catch { return null }
}

export function writeCache<T>(key: string, data: T, opts?: CacheOpts): void {
  try { store(opts).setItem('eq:' + key, JSON.stringify({ t: Date.now(), data })) } catch { /* quota / private mode */ }
}

export function clearCache(key: string, opts?: CacheOpts): void {
  try { store(opts).removeItem('eq:' + key) } catch { /* ignore */ }
}

// Common TTLs.
export const CACHE_TTL = {
  short: 2 * 60_000,   // 2 min — feeds that change as you act
  medium: 5 * 60_000,  // 5 min — analytics dashboards
  long: 30 * 60_000,   // 30 min — slow-moving data (e.g. weather)
  // 16h — a work day. Only for `persist` field data: out on a route the choice is
  // never "fresh vs stale", it's "this morning's schedule vs a blank screen". The
  // live fetch still overwrites it the moment there's signal.
  field: 16 * 60 * 60_000,
}
