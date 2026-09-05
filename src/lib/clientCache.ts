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
//
// ── OWNED BY ONE ACCOUNT ──────────────────────────────────────────────────────
// Every entry is stamped with the account that FETCHED it, and a read answers only
// for that same account. Before this, keys were bare (`eq:revintel`) and nothing
// cleared them at sign-out: in the same tab, account A's signed-out
// sessionStorage was account B's first paint of Revenue Intelligence, the BI
// report, the customer/quote/invoice lists and business memory (2–5 min TTL) —
// and the persisted field bundle (A's jobs, quotes, change orders, settings;
// 36 h TTL) survived an app kill into B's cold start, offline included. Nothing
// remote: this is one device, two accounts.
//
// THE LEASE. A write cannot ask "who is signed in now?" — a slow report fetch
// started by A can land after A signed out and B signed in (login is a client
// navigation; this module survives it), and a stamp taken at write time would
// certify A's numbers as B's. Review reproduced exactly that against the first
// version of this file. So the owner is captured where the FETCH STARTS
// (`cacheLease()`), carried to the write, and the write lands only if that lease
// is still the current one: same owner AND same generation. Any owner change —
// adopt, sign-out, the sign-out clear — advances the generation, so nothing
// fetched under an earlier account, or an earlier session of the same account,
// can ever be stamped as the current one. A write with no lease writes nothing.
//
// The owner is whoever the dashboard layout verified server-side
// (components/layout/CacheOwner adopts it during render, before any page's
// useState initializer reads, and again in its effect so React StrictMode's
// dev-only cleanup cannot leave it unset). A mismatch or a legacy unstamped entry
// reads as "no cache" and is dropped; the same account keeps its own entries —
// its offline bundle included. Explicit sign-out clears this module's entries
// only, recognised by envelope shape, never other storage. On the server the
// owner is never set: this is a per-tab fact, not a per-process one.

interface Cached<T> { t: number; data: T; o?: string }

interface CacheOpts { persist?: boolean }

/** Who a fetch was started for. Take it with cacheLease() BEFORE the first
 *  await of a load, pass it to writeCache when the data lands. */
export interface CacheLease { readonly owner: string; readonly gen: number }

interface WriteOpts extends CacheOpts {
  /** REQUIRED for the write to happen: the lease taken when the fetch began. A
   *  missing or stale lease writes nothing (fail closed). Optional in the type
   *  only so that callers not yet threaded compile — they cache nothing. */
  lease?: CacheLease | null
}

const PREFIX = 'eq:'

// THE signed-in account, as verified by the dashboard layout. null = unknown
// (outside the dashboard, on the server, or before the layout rendered): reads
// say "no cache" and writes are skipped.
let owner: string | null = null
// Advances on every owner change; a lease from an earlier generation is stale.
let gen = 0

/** Set by components/layout/CacheOwner; null on unmount. */
export function setCacheOwner(id: string | null): void {
  if (id === owner) return
  owner = id
  gen++
}
export function getCacheOwner(): string | null { return owner }

/** The owner as of now, or null when none is known. Take it at fetch start. */
export function cacheLease(): CacheLease | null {
  return owner ? { owner, gen } : null
}

// The last account this DEVICE rendered the dashboard for. Kept outside the
// `eq:` namespace (so a sign-out clear does not erase it) and compared on every
// adoption: a different id means the account changed since the last write —
// whether the previous one signed out or its session simply expired — and the
// whole namespace is dropped before the new owner is named. This is also what
// closes the one offline path the stamp alone cannot: the service worker keeps
// a field shell whose HTML names the account that last loaded it online, so an
// offline cold start after an account change would otherwise adopt the OLD id
// and serve the old bundle. The marker outlives the shell, so the mismatch is
// seen and the stale bundle goes. The same account keeps everything.
const MARKER = 'eq-owner'

/** Adopt `id` as the owner, clearing the namespace first if this device last
 *  served a different account (or none on record). Idempotent for the current
 *  owner. A no-op on the server: CacheOwner is a client component and renders
 *  there too, and a process-wide owner would be a cross-tenant fact. */
export function adoptCacheOwner(id: string): void {
  if (typeof window === 'undefined') return
  if (id === owner) return
  let last: string | null = null
  try { last = localStorage.getItem(MARKER) } catch { /* no storage: nothing to compare, nothing cached either */ }
  if (last !== id) {
    clearOwnedCaches()
    try { localStorage.setItem(MARKER, id) } catch { /* ignore */ }
  }
  owner = id
  gen++
}

// localStorage survives an app kill; sessionStorage is the tab-scoped default.
// Both can throw (private mode, disabled storage) — every caller treats that as
// "no cache" rather than an error.
function store(opts?: CacheOpts): Storage {
  return opts?.persist ? localStorage : sessionStorage
}

export function readCache<T>(key: string, maxAgeMs: number, opts?: CacheOpts): T | null {
  try {
    const s = store(opts)
    const raw = s.getItem(PREFIX + key)
    if (!raw) return null
    const c = JSON.parse(raw) as Cached<T>
    // Not this account's entry (another account's, or written before stamping
    // existed): never serve it. With a known owner it is also removed, so a
    // shared device does not keep carrying it; with no owner known yet it is
    // left alone — it may well be this account's, read too early.
    if (!owner || c.o !== owner) {
      if (owner) s.removeItem(PREFIX + key)
      return null
    }
    if (Date.now() - c.t > maxAgeMs) return null
    return c.data
  } catch { return null }
}

/** Store `data` for the account the lease names — only if that lease is still
 *  current (same owner, same generation). Stamped with the LEASE's owner. */
export function writeCache<T>(key: string, data: T, opts?: WriteOpts): void {
  const lease = opts?.lease
  if (!lease || !owner || lease.owner !== owner || lease.gen !== gen) return
  try { store(opts).setItem(PREFIX + key, JSON.stringify({ t: Date.now(), data, o: lease.owner } satisfies Cached<T>)) } catch { /* quota / private mode */ }
}

export function clearCache(key: string, opts?: CacheOpts): void {
  try { store(opts).removeItem(PREFIX + key) } catch { /* ignore */ }
}

// This module's entries are recognised by SHAPE, not by prefix alone: other
// modules keep their own `eq:`-prefixed keys (autosave drafts, the upload queue,
// palette recents, photo context, learned models) that a sign-out must not
// touch. An entry is ours only if it is exactly the envelope this file writes —
// `{ t, data }` (legacy, unstamped) or `{ t, data, o }`.
function isEnvelope(raw: string | null): boolean {
  if (!raw) return false
  try {
    const v = JSON.parse(raw) as Record<string, unknown> | null
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false
    const keys = Object.keys(v)
    return typeof v.t === 'number' && 'data' in v && keys.every(k => k === 't' || k === 'data' || k === 'o')
  } catch { return false }
}

/** Remove every entry THIS MODULE wrote from both stores — envelope-shaped
 *  `eq:` keys — and nothing else. Called on explicit sign-out (and when this
 *  device adopts a different account) so a shared device is not left holding
 *  the departing account's reports and field bundle. Also advances the
 *  generation: a fetch still in flight for the departing account must not
 *  refill what was just cleared. */
export function clearOwnedCaches(): void {
  gen++
  for (const persist of [false, true]) {
    try {
      const s = store({ persist })
      const doomed: string[] = []
      for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k && k.startsWith(PREFIX) && isEnvelope(s.getItem(k))) doomed.push(k) }
      for (const k of doomed) s.removeItem(k)
    } catch { /* ignore */ }
  }
}

// Common TTLs.
export const CACHE_TTL = {
  short: 2 * 60_000,   // 2 min — feeds that change as you act
  medium: 5 * 60_000,  // 5 min — analytics dashboards
  long: 30 * 60_000,   // 30 min — slow-moving data (e.g. weather)
  // 36h — for `persist` field data. Out on a route the choice is never "fresh vs
  // stale", it's "this morning's schedule vs a blank screen".
  //
  // Why not 16h: the clock starts at the last SUCCESSFUL WRITE, not at the workday.
  // Last signal 5pm Tuesday, cold start 10am Wednesday = 17h → readCache returned
  // null → the day board painted nothing, on the exact morning the cache existed
  // for. And the data wasn't even stale: the bundle spans today ± 7 days, so a
  // Tuesday-evening write already CONTAINS Wednesday's jobs. Expiring it threw away
  // good work.
  // 36h covers "worked late, no signal overnight, start the next morning" — the real
  // shape of the gap — while still refusing to pass a genuinely abandoned bundle off
  // as today. The live fetch overwrites it the moment there's signal, and a failed
  // load says so in the banner rather than silently painting old work as current.
  field: 36 * 60 * 60_000,
}
