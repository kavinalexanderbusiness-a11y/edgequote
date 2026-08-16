// ── The worker's day, kept on the phone ──────────────────────────────────────
// A cold start in a driveway with no signal used to render "Couldn't load your
// day" — the phone held nothing, so a worker who drove out of coverage between
// stops lost the address of the next one. This is the read half of the
// resilience layer: the LAST GOOD day, on disk, served only when the live read
// fails, and NEVER dressed up as live.
//
// ⭐⭐ CACHED DATA MUST NEVER LOOK LIVE. Everything served from here arrives with
// the moment it was fetched, and the surface is required to say so ("Offline ·
// Last updated 8:42 AM"). A cache that renders identically to a live read is
// worse than no cache: it lets a worker drive to a stop the office moved an hour
// ago while the screen shows the old order with full authority. The banner is
// not decoration — it is the entire justification for storing anything.
//
// ── What is stored, and what is deliberately not ─────────────────────────────
// ⭐ The whitelist below IS the emit list ([[business-data-export-v1]]'s rule: a
// `select` that names its columns cannot silently start carrying a new one). A
// blacklist would leak the day somebody adds a field to crew_day — which is
// exactly how a cache starts holding money. So an unknown field is DROPPED, and
// a guard asserts the shape.
//
// crew_day already returns no money at all (Field Home V1's no-money rule), and
// this file keeps it that way by construction rather than by trust: there is no
// price, no invoice, no balance, no lifetime value, no wage, and no business-wide
// figure in the projection below. What IS here is what a worker cannot do the
// work without — the address, the customer's name and phone, the access notes,
// their crew, and the visit's own lifecycle.
//
// ── Security ─────────────────────────────────────────────────────────────────
// ⭐ Every record is keyed by the AUTH USER it was read for, so a device that
// changes hands cannot serve the previous worker's day to the next one — a
// mismatched key simply misses. Two further bounds, because a key check alone
// would let a REVOKED worker keep a useful copy forever:
//   · a hard TTL (below), so cached work outlives neither the shift nor a
//     same-day revocation by more than a few hours; and
//   · `clearFieldCache()` on sign-out, wiping the day, the drafts and any
//     unsent queue.
// ⛔ None of this is a permission boundary — the RPCs are (crewAccess's rule).
// It bounds how long a phone that can no longer ASK anything stays useful.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CrewDay, CrewStop } from '@/lib/crewAccess'

/**
 * Who this device is signed in as, WITHOUT a network round trip.
 *
 * ⭐ `getSession()` reads the persisted session locally; `getUser()` asks the
 * server. The whole point of the cache is the cold start with no signal, where
 * getUser() cannot answer — so keying on it would make the cache unreadable in
 * precisely the situation it exists for.
 *
 * ⚠️ This is an IDENTITY FOR SCOPING, never an authorization. A local session
 * blob proves which cache belongs to this device, not what its holder may do —
 * that stays with the RPCs (crewAccess's boundary rule).
 */
export async function cacheUserId(supabase: SupabaseClient): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession()
    return data.session?.user?.id ?? null
  } catch { return null }
}

const DB_NAME = 'eq-field'
const STORE = 'today'

// ⭐ A cached day dies with the shift. Long enough that a full working day —
// including the overnight edge of an early start — is always covered; short
// enough that a worker taken off the roster at 9am cannot still be reading
// customer addresses tomorrow. A cache is not a licence, and "indefinite useful
// access from a stale cache" is the exact failure this bounds.
const MAX_AGE_MS = 16 * 60 * 60_000

function hasIDB(): boolean { return typeof window !== 'undefined' && 'indexedDB' in window }

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// Resolves when the TRANSACTION COMMITS — the same rule photoStore and the
// outbox pay for in their own headers. A write that resolves on request success
// has not reached disk, and the caller would be told the day was saved while a
// phone killed in that gap kept nothing.
function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(db => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    let result: T
    const r = run(t.objectStore(STORE))
    r.onsuccess = () => { result = r.result; if (mode === 'readonly') resolve(result) }
    r.onerror = () => reject(r.error)
    t.oncomplete = () => { db.close(); resolve(result) }
    t.onabort = () => { db.close(); reject(t.error || new Error('field cache transaction aborted')) }
    t.onerror = () => { db.close(); reject(t.error || new Error('field cache transaction failed')) }
  }))
}

export interface CachedDay {
  day: CrewDay
  /** When the SERVER answered — the number the banner renders. Not when it was
   *  written to disk: those differ by the write, and the worker is being told
   *  how old the FACTS are. */
  fetchedAt: number
}

interface CacheRec extends CachedDay {
  key: string
  userId: string
}

function keyFor(userId: string, dateISO: string): string { return `${userId}::${dateISO}` }

// ── The projection ───────────────────────────────────────────────────────────
// Field-by-field, so a new key on CrewDay is dropped until somebody adds it here
// on purpose. ⛔ Do not replace this with a spread.

function stopProjection(s: CrewStop): CrewStop {
  return {
    id: s.id,
    title: s.title,
    service_type: s.service_type,
    scheduled_date: s.scheduled_date,
    start_time: s.start_time,
    duration_minutes: s.duration_minutes,
    crew_size: s.crew_size,
    status: s.status,
    started_at: s.started_at,
    completed_at: s.completed_at,
    actual_minutes: s.actual_minutes,
    on_my_way_at: s.on_my_way_at,
    route_order: s.route_order,
    // ⭐ Load-bearing for the write half: an offline action needs the row version
    // it was based on, or the reconciliation engine has no base to compare and
    // every queued write would look `superseded` on reconnect.
    updated_at: s.updated_at,
    notes: s.notes,
    completion_summary: s.completion_summary,
    completion_issue: s.completion_issue,
    customer: s.customer ? { name: s.customer.name, phone: s.customer.phone } : null,
    property: s.property
      ? { address: s.property.address, lat: s.property.lat, lng: s.property.lng }
      : null,
    // ⭐ COUNTS ONLY — the checklist summary, never a single field's content
    // (crew_job_forms loads the real form on tap). A worker offline still needs
    // to see "3 of 7 · 2 required open" to know what is outstanding, and the
    // numbers carry no customer data and nothing business-wide.
    //
    // ⚠️ This field arrived on CrewStop from the job-forms feature AFTER this
    // projection was written, and the whitelist did exactly its job: it dropped
    // it, silently and safely, until a human decided. That is the trade the
    // whitelist exists to make — a missing count offline, rather than an
    // unreviewed field landing on a phone that may be lost. ⛔ Same review is
    // owed to the NEXT field crew_day grows; do not switch this to a spread.
    // `undefined` is normalised to null (payloads predating the feature).
    checklist: s.checklist
      ? {
          forms: s.checklist.forms, items: s.checklist.items, done: s.checklist.done,
          required: s.checklist.required, required_done: s.checklist.required_done,
          waived: s.checklist.waived,
        }
      : null,
  }
}

/** ⭐ Whitelist projection. Anything crew_day grows later is dropped here until
 *  a human decides it belongs on a phone that may be lost or handed over. */
export function projectDayForCache(day: CrewDay): CrewDay {
  return {
    date: day.date,
    me: day.me ? { id: day.me.id, name: day.me.name, role: day.me.role, status: day.me.status } : null,
    crew: day.crew
      ? { id: day.crew.id, name: day.crew.name, color: day.crew.color, day_start: day.crew.day_start }
      : null,
    // The employer's name and the office number — what a worker needs to say who
    // they are at a gate and to call in a problem. ⛔ Nothing business-WIDE: no
    // totals, no roster beyond this crew, no settings.
    business: day.business
      ? { name: day.business.name, phone: day.business.phone, work_start_time: day.business.work_start_time }
      : null,
    teammates: (day.teammates || []).map(t => ({ id: t.id, name: t.name, role: t.role })),
    day_note: day.day_note,
    crew_note: day.crew_note,
    stops: (day.stops || []).map(stopProjection),
  }
}

/** Best-effort, always. A cache that refuses to write must never break the live
 *  path — the day is already on screen; this only decides whether it survives
 *  the next cold start. */
export async function writeCachedDay(userId: string, dateISO: string, day: CrewDay, fetchedAt: number): Promise<boolean> {
  if (!hasIDB() || !userId) return false
  try {
    const rec: CacheRec = { key: keyFor(userId, dateISO), userId, day: projectDayForCache(day), fetchedAt }
    await tx('readwrite', s => s.put(rec))
    return true
  } catch { return false }
}

/**
 * The last good day for THIS user and date, or null.
 *
 * Returns null — never a stale record — when the entry has outlived MAX_AGE_MS,
 * and deletes it on the way past so an expired day cannot be resurrected by a
 * clock change. ⛔ A caller must not be able to opt out of the expiry: it is the
 * bound on a revoked worker's remaining access.
 */
export async function readCachedDay(userId: string, dateISO: string, now = Date.now()): Promise<CachedDay | null> {
  if (!hasIDB() || !userId) return null
  try {
    const rec = await tx<CacheRec | undefined>('readonly', s => s.get(keyFor(userId, dateISO)) as IDBRequest<CacheRec | undefined>)
    if (!rec) return null
    // A record whose user does not match is not ours to serve. The key already
    // encodes it; this is the belt to that braces, and it costs one comparison.
    if (rec.userId !== userId) return null
    if (isExpired(rec.fetchedAt, now)) { void dropCachedDay(userId, dateISO); return null }
    return { day: rec.day, fetchedAt: rec.fetchedAt }
  } catch { return null }
}

/** Exported so the guard can assert the bound without reaching into IndexedDB. */
export function isExpired(fetchedAt: number, now = Date.now()): boolean {
  return now - fetchedAt > MAX_AGE_MS
}

export const FIELD_CACHE_MAX_AGE_MS = MAX_AGE_MS

export async function dropCachedDay(userId: string, dateISO: string): Promise<void> {
  if (!hasIDB()) return
  try { await tx('readwrite', s => s.delete(keyFor(userId, dateISO))) } catch { /* ignore */ }
}

/**
 * ⭐ Wipe every cached day. Called on sign-out, and on the one other occasion
 * that matters: when the database ANSWERS that this account is no longer on a
 * roster ({ kind: 'revoked' }). A revocation the phone has actually heard must
 * not leave yesterday's customer addresses readable on it.
 *
 * ⛔ Deliberately does NOT touch the write queue — unsent work is the worker's,
 * and destroying it silently is the failure this whole session exists to
 * prevent. Sign-out clears that separately, after telling them what is unsent.
 */
export async function clearCachedDays(): Promise<void> {
  if (!hasIDB()) return
  try { await tx('readwrite', s => s.clear()) } catch { /* ignore */ }
}

// ── The one sentence a cached render must carry ──────────────────────────────
/** "Last updated 8:42 AM" — the honest half of serving a cache. Local time,
 *  because a worker reads it against their own watch. */
export function lastUpdatedLabel(fetchedAt: number): string {
  const d = new Date(fetchedAt)
  const h = d.getHours()
  const m = String(d.getMinutes()).padStart(2, '0')
  return `Last updated ${((h + 11) % 12) + 1}:${m} ${h < 12 ? 'AM' : 'PM'}`
}
