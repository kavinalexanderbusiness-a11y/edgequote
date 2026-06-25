// ── Client-side stale-while-revalidate cache ─────────────────────────────────────
// Heavy dashboard reports (BI, Revenue Intelligence, Labor) recompute the same
// numbers every visit. Cache the RESULT in sessionStorage so re-opening a page is
// instant — show the cached value immediately, then refresh in the background.
// Scoped to the tab/session; clears on close. Safe no-ops if storage is unavailable.

interface Cached<T> { t: number; data: T }

export function readCache<T>(key: string, maxAgeMs: number): T | null {
  try {
    const raw = sessionStorage.getItem('eq:' + key)
    if (!raw) return null
    const c = JSON.parse(raw) as Cached<T>
    if (Date.now() - c.t > maxAgeMs) return null
    return c.data
  } catch { return null }
}

export function writeCache<T>(key: string, data: T): void {
  try { sessionStorage.setItem('eq:' + key, JSON.stringify({ t: Date.now(), data })) } catch { /* quota / private mode */ }
}

export function clearCache(key: string): void {
  try { sessionStorage.removeItem('eq:' + key) } catch { /* ignore */ }
}

// Common TTLs.
export const CACHE_TTL = {
  short: 2 * 60_000,   // 2 min — feeds that change as you act
  medium: 5 * 60_000,  // 5 min — analytics dashboards
  long: 30 * 60_000,   // 30 min — slow-moving data (e.g. weather)
}
