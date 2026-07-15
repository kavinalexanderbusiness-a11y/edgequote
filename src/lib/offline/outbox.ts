// ── Offline outbox ───────────────────────────────────────────────────────────────
// ONE queue for the whole app. When a write can't reach the server (offline), the
// caller enqueues the *intent* here; it's persisted in IndexedDB (survives reloads /
// app close) and replayed automatically on reconnect. There is deliberately no
// per-feature queue — every offline-capable mutation (photos, jobs, quotes,
// messages, notes) funnels through this single engine via `queueOrRun` + a handler
// registered by `kind`. The service worker already covers offline *reads*; this is
// the write half.

import { toast } from '@/lib/toast'

export interface OutboxOp {
  id: string
  kind: string            // handler key, e.g. 'message.send'
  payload: unknown
  label: string           // human summary for the UI ("Message to Jane")
  createdAt: number
  attempts: number
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

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(db => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const r = run(t.objectStore(STORE))
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
    t.oncomplete = () => db.close()
  }))
}

// ── Pub/sub so the indicator reflects queue depth live ──
const subs = new Set<() => void>()
export function subscribe(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn) } }
function notify(): void { subs.forEach(f => { try { f() } catch { /* ignore */ } }) }

function makeId(): string {
  try { return crypto.randomUUID() } catch { return `${Date.now()}-${Math.round(Math.random() * 1e9)}` }
}

export async function enqueue(op: { kind: string; payload: unknown; label: string }): Promise<OutboxOp | null> {
  if (!hasIDB()) return null
  const full: OutboxOp = { id: makeId(), createdAt: Date.now(), attempts: 0, ...op }
  await tx('readwrite', s => s.add(full))
  notify()
  return full
}

export async function list(): Promise<OutboxOp[]> {
  if (!hasIDB()) return []
  try {
    const all = await tx<OutboxOp[]>('readonly', s => s.getAll() as IDBRequest<OutboxOp[]>)
    return (all || []).sort((a, b) => a.createdAt - b.createdAt) // oldest first (FIFO)
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
  try {
    const ops = await list()   // oldest-first
    for (const op of ops) {
      const h = handlers.get(op.kind)
      if (!h) continue
      try { await h(op.payload); await remove(op.id); done++ }
      catch {
        if (op.attempts + 1 >= MAX_ATTEMPTS) { await remove(op.id); reportDropped(op) }  // poison op — stop retrying forever, but say so
        else await bumpAttempts(op)
        failed++
      }
    }
  } finally { flushing = false }
  const left = await count()
  notify()
  return { done, failed, left }
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

function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  // fetch() throws a TypeError ("Failed to fetch") when the network is unreachable.
  return e instanceof TypeError
}
