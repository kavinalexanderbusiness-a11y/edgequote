// ── Offline outbox ───────────────────────────────────────────────────────────────
// ONE queue for the whole app. When a write can't reach the server (offline), the
// caller enqueues the *intent* here; it's persisted in IndexedDB (survives reloads /
// app close) and replayed automatically on reconnect. There is deliberately no
// per-feature queue — every offline-capable mutation (photos, jobs, quotes,
// messages, notes) funnels through this single engine via `queueOrRun` + a handler
// registered by `kind`. The service worker already covers offline *reads*; this is
// the write half.

import { toast } from '@/lib/toast'

// ── Conflicts ────────────────────────────────────────────────────────────────────
// Replay was last-write-wins: a queued patch overwrote whatever the server held,
// so a price the office corrected while the contractor was offline was silently
// reverted on reconnect. Nobody was told, and the office's number was simply gone.
//
// A handler raises this when the row it meant to patch has MOVED ON — i.e. the
// contractor's edit was based on a version of the row that no longer exists. It is
// NOT retryable: replaying can only overwrite the newer data again. So the op leaves
// the queue and the human is told exactly what didn't apply, which is the only
// correct answer — the machine cannot know whether the driveway or the office is
// right. `intent` is what they tried to change, so the message can say it.
// Entities THIS flush has already written successfully.
//
// Without this, chained offline edits to one row would all falsely conflict: tap
// Start then Undo with no signal, and on reconnect Start replays and advances
// updated_at — so Undo's base version (captured before Start) no longer matches, and
// we'd report a conflict against a change WE had just made a moment earlier. The
// contractor would be told the office edited their job when nobody had.
// A version we ourselves just set is not someone else's edit, so once we hold a row
// this flush, later ops in that chain patch it unguarded. Correct because ops are
// strict FIFO per entity and an entity is blocked the moment one of its ops fails —
// so reaching a later op proves every earlier one landed.
const ownedThisFlush = new Set<string>()
export function isOwnedThisFlush(key: string): boolean { return ownedThisFlush.has(key) }

export class ConflictError extends Error {
  readonly intent: Record<string, unknown>
  readonly conflictKind: 'changed' | 'gone'
  constructor(message: string, intent: Record<string, unknown>, conflictKind: 'changed' | 'gone' = 'changed') {
    super(message)
    this.name = 'ConflictError'
    this.intent = intent
    this.conflictKind = conflictKind
  }
}

export interface OutboxOp {
  id: string
  kind: string            // handler key, e.g. 'message.send'
  payload: unknown
  label: string           // human summary for the UI ("Message to Jane")
  createdAt: number
  attempts: number
  /** Tie-breaker within a millisecond. Date.now() has ~1ms resolution and a
   *  contractor can absolutely tap Complete then Undo inside one: ties fell back to
   *  getAll()'s keyPath order, and the key is a random uuid — so the two replayed in
   *  RANDOM order and the job could end up completed after being undone. Optional
   *  because ops queued by an older build won't carry it. */
  seq?: number
}

// Handlers do the REAL mutation on flush. Registered once at app start (client only),
// keyed by `kind`, so a queued op from a previous session still knows how to replay.
type Handler = (payload: unknown) => Promise<void>
const handlers = new Map<string, Handler>()
export function registerHandler(kind: string, fn: Handler): void { handlers.set(kind, fn) }

const DB_NAME = 'eq-offline'
const STORE = 'outbox'

function hasIDB(): boolean { return typeof window !== 'undefined' && 'indexedDB' in window }

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// A write resolves when the TRANSACTION COMMITS, not when the request is accepted.
//
// This resolved on `request.onsuccess`, which only means the request was accepted
// INSIDE the transaction — nothing is on disk until it commits. So `await enqueue()`
// returned early and the caller immediately told the contractor "Saved offline —
// it'll sync when you're back". If the phone killed the tab in that gap (which is
// precisely when it happens: you tap Complete and pocket the phone), the op was never
// written and the reassurance was a lie.
// I fixed this exact shape in photoStore and reasoned it was harmless here because "a
// lost intent is re-derivable". It isn't: a lost job.complete means the visit stays
// open and its invoice never drafts, and nobody ever finds out.
// Reads still resolve from the request — there is nothing to commit.
function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(db => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    let result: T
    const r = run(t.objectStore(STORE))
    r.onsuccess = () => { result = r.result; if (mode === 'readonly') resolve(result) }
    r.onerror = () => reject(r.error)
    t.oncomplete = () => { db.close(); resolve(result) }
    // An aborted write (quota, a tab killed mid-commit) must REJECT rather than leave
    // the promise pending forever with a leaked handle.
    t.onabort = () => { db.close(); reject(t.error || new Error('outbox transaction aborted')) }
    t.onerror = () => { db.close(); reject(t.error || new Error('outbox transaction failed')) }
  }))
}

// ── Pub/sub so the indicator reflects queue depth live ──
const subs = new Set<() => void>()
export function subscribe(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn) } }
function notify(): void { subs.forEach(f => { try { f() } catch { /* ignore */ } }) }

// Monotonic within a session — only ever used to order ops that share a millisecond.
let enqueueSeq = 0

function makeId(): string {
  try { return crypto.randomUUID() } catch { return `${Date.now()}-${Math.round(Math.random() * 1e9)}` }
}

export async function enqueue(op: { kind: string; payload: unknown; label: string }): Promise<OutboxOp | null> {
  if (!hasIDB()) return null
  const full: OutboxOp = { id: makeId(), createdAt: Date.now(), seq: ++enqueueSeq, attempts: 0, ...op }
  await tx('readwrite', s => s.add(full))
  notify()
  return full
}

export async function list(): Promise<OutboxOp[]> {
  if (!hasIDB()) return []
  try {
    const all = await tx<OutboxOp[]>('readonly', s => s.getAll() as IDBRequest<OutboxOp[]>)
    // Oldest first (FIFO), seq breaking a same-millisecond tie so Complete-then-Undo
    // always replays in the order the contractor actually tapped them.
    return (all || []).sort((a, b) => a.createdAt - b.createdAt || (a.seq ?? 0) - (b.seq ?? 0))
  } catch { return [] }
}

export async function count(): Promise<number> {
  if (!hasIDB()) return 0
  try { return await tx<number>('readonly', s => s.count()) } catch { return 0 }
}

async function remove(id: string): Promise<void> { await tx('readwrite', s => s.delete(id)); notify() }
async function bumpAttempts(op: OutboxOp): Promise<void> { await tx('readwrite', s => s.put({ ...op, attempts: op.attempts + 1 })); notify() }

let flushing = false

interface FlushResult { done: number; failed: number; left: number }

// A permanently-failing op (e.g. a message to a customer with no phone → 400 forever)
// must not retry on every reconnect for the life of the app. Drop it after this many
// attempts so the queue can't get stuck with a poison op.
const MAX_ATTEMPTS = 6

// …but never drop it QUIETLY. Dropping is the only path here that destroys work, and
// it used to happen with no trace at all: a queued "Complete Jane's lawn" that kept
// failing simply disappeared — the job stayed open, its invoice was never drafted,
// and the contractor had already driven away certain it was done. The op is still
// dropped (a poison op must not retry forever), but the person who made it is told
// exactly what didn't stick, so they can redo it. Named `label` for that reason.
// Conflicts are told, never swallowed — and the message carries the VALUES they tried
// to set, because the op is gone from the queue and this toast is the only remaining
// record of the work. Without it "never lose data" would be false: their edit would
// vanish as silently as the overwrite we just prevented.
function reportConflict(op: OutboxOp, err: ConflictError): void {
  const what = Object.entries(err.intent)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k.replace(/_/g, ' ')} → ${String(v)}`)
    .join(', ')
  const why = err.conflictKind === 'gone'
    ? 'it was deleted while you were offline'
    : 'it changed on another device while you were offline'
  toast(
    `“${op.label}” wasn’t applied — ${why}.${what ? ` Your change (${what}) was not saved.` : ''} Check the record and redo it if it still applies.`,
    { tone: 'error', duration: 20000 },
  )
}

function reportDropped(op: OutboxOp): void {
  // Long duration + error tone: this is the one message here a contractor cannot
  // afford to scroll past — the work is gone and only they can redo it.
  toast(`Couldn’t sync “${op.label}” — it didn’t save. Please do it again.`, { tone: 'error', duration: 12000 })
}

// Replay everything, OLDEST FIRST (FIFO) — so a create always replays before the
// edits that depend on it. A succeeded op is removed; a failed one stays for the
// next flush (attempts incremented) until it exhausts MAX_ATTEMPTS, then it's dropped.
// An op with no registered handler is left untouched (a newer build may register it).
// Never throws.
async function doFlush(): Promise<FlushResult> {
  if (flushing) return { done: 0, failed: 0, left: await count() }
  flushing = true
  let done = 0, failed = 0
  // Entities whose earlier op failed THIS round. See the ordering note below.
  const blocked = new Set<string>()
  ownedThisFlush.clear()   // scoped to this flush only — a later flush re-verifies
  try {
    const ops = await list()   // oldest-first
    for (const op of ops) {
      const h = handlers.get(op.kind)
      if (!h) continue
      // ORDERING. The loop used to `continue` past a failure, so a later op for the
      // SAME entity could land while an earlier one hadn't: tap Start, tap Undo, and
      // if Start failed transiently while Undo succeeded, the next flush replayed
      // Start — the job ends in_progress after the contractor explicitly undid it.
      // FIFO only held on the happy path. Blocking is per-entity, not global, so one
      // stuck op can't dam the whole queue.
      const key = entityKey(op)
      if (key && blocked.has(key)) { failed++; continue }
      try { await h(op.payload); await remove(op.id); done++; if (key) ownedThisFlush.add(key) }
      catch (err) {
        if (key) blocked.add(key)
        failed++
        // A conflict can NEVER succeed by retrying — the server row has moved on, and
        // replaying would just overwrite the newer data we refused to clobber. Take it
        // out of the queue and hand it to the human, who is the only one who can know
        // whether the driveway or the office is right. The entity stays blocked for
        // this round so later ops built on the same stale version don't land either.
        if (err instanceof ConflictError) { await remove(op.id); reportConflict(op, err); continue }
        // A NETWORK failure is not the op's fault, so it must not cost it an attempt.
        // Flushes fire on online + focus + visibilitychange + every 30s, and every
        // failure used to increment: six flaky reconnects — reachable in about three
        // MINUTES of the patchy coverage this queue exists for — silently destroyed a
        // completed job. MAX_ATTEMPTS is meant to bin a POISON op (an RLS or
        // validation error that can never succeed), not to punish bad signal. So an
        // op with no signal simply waits, forever if need be: it is on disk, and the
        // contractor's work outlives any number of failed reconnects.
        if (isNetworkError(err)) continue
        if (op.attempts + 1 >= MAX_ATTEMPTS) { await remove(op.id); reportDropped(op) }  // poison op — stop retrying forever, but say so
        else await bumpAttempts(op)
      }
    }
  } finally { flushing = false }
  const left = await count()
  notify()
  return { done, failed, left }
}

// Which record an op mutates, for per-entity ordering. Most kinds carry the row id;
// a kind without one (e.g. message.send) is never ordered against another op, so it
// blocks nothing.
function entityKey(op: OutboxOp): string | null {
  const p = op.payload as { id?: unknown } | null
  const id = p && typeof p === 'object' ? p.id : undefined
  return typeof id === 'string' && id ? `${op.kind.split('.')[0]}:${id}` : null
}

// Cross-tab safety: only ONE tab flushes at a time, so a replayed op can never run
// twice concurrently. Web Locks serialize across tabs when available; where they are
// NOT (older Safari / some webviews) only the in-process `flushing` flag applies, which
// guards a single tab but not concurrent flushes across tabs. For SENDS this residual
// gap is closed regardless of locks by server-side idempotency: message.send carries a
// stable clientMessageId and the comms routes reserve it atomically (message_sends PK),
// so two tabs replaying the same queued send dispatch the SMS/email at most once.
export async function flush(): Promise<FlushResult> {
  if (!hasIDB()) return { done: 0, failed: 0, left: 0 }
  const locks = (navigator as unknown as { locks?: { request(name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<FlushResult>): Promise<FlushResult> } }).locks
  if (locks?.request) {
    return locks.request('eq-outbox-flush', { ifAvailable: true }, async (lock) => {
      if (!lock) return { done: 0, failed: 0, left: await count() } // another tab holds it
      return doFlush()
    })
  }
  return doFlush()
}

// The pattern every offline-capable mutation uses: run it now when online; when
// offline (or the call fails at the network layer), stash it and report 'queued'.
// Returns 'ran' | 'queued'. Non-network errors from `run` still throw (real errors
// shouldn't be silently queued).
export async function queueOrRun(
  op: { kind: string; payload: unknown; label: string },
  run: () => Promise<void>,
  // queueOnRunError (default true): whether a run() that throws a *network* error while
  // navigator.onLine is still true should be queued. Set FALSE for non-idempotent sends
  // (e.g. an SMS): a lost RESPONSE after the server may have already committed must NOT
  // be re-queued (→ no duplicate send) — it's rethrown so the caller can surface/retry.
  // True offline (handled first) is always safe to queue: nothing was sent.
  opts?: { queueOnRunError?: boolean },
): Promise<'ran' | 'queued'> {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  if (offline && hasIDB()) { await enqueue(op); return 'queued' }
  try {
    await run()
    return 'ran'
  } catch (e) {
    // Only queue genuine connectivity failures — not validation/permission errors, and
    // not non-idempotent sends whose response was merely lost.
    if (hasIDB() && isNetworkError(e) && (opts?.queueOnRunError ?? true)) { await enqueue(op); return 'queued' }
    throw e
  }
}

// The message a browser gives a dead fetch. Deliberately a list of EXACT phrases, not
// a loose "network" match: anything broader would start queueing genuine validation
// and permission errors, which can never succeed on retry and would burn MAX_ATTEMPTS
// before being dropped — trading a visible failure for a silent one.
//   Chrome  "Failed to fetch"
//   Firefox "NetworkError when attempting to fetch resource."
//   Safari  "Load failed" / "The Internet connection appears to be offline."
//   undici  "fetch failed"
const NETWORK_MESSAGE = /failed to fetch|networkerror when attempting|load failed|fetch failed|network request failed|internet connection appears to be offline|err_internet_disconnected|err_network_changed|err_name_not_resolved/i

// Would this error have been fixed by having signal?
//
// `navigator.onLine === false` only means the OS sees no interface. It is famously
// TRUE on a captive portal — the hotel/coffee-shop wifi a contractor's phone joins by
// itself at the edge of a job — where every request dies at a login page. And
// supabase-js does NOT throw on a dead fetch: it RETURNS { error }, and our call sites
// then `throw new Error(error.message)`, which is a plain Error, not a TypeError.
// So the old check missed both halves of the commonest real-world outage: onLine lied,
// the error wasn't a TypeError, and the write was never queued. The contractor got a
// "couldn't save" banner on a phone in their pocket, and the work was gone.
function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  // fetch() throws a TypeError ("Failed to fetch") when the network is unreachable.
  if (e instanceof TypeError) return true
  // …but a rethrown supabase error is a plain Error carrying the same text.
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  return msg ? NETWORK_MESSAGE.test(msg) : false
}
