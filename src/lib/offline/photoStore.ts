// ── Durable pending-photo store ──────────────────────────────────────────────────
// The bytes half of the upload queue. lib/uploadQueue owns scheduling (concurrency,
// backoff, pairing, the tray); this owns *survival* — the photo itself, on disk, so
// a job's before/after still uploads after the phone kills the app in a driveway.
//
// Why this exists at all: the queue used to hold `File` objects in a module-level
// array and documented that they "can't survive a full page reload, browser
// security". That isn't so — IndexedDB persists Blob/File through the structured
// clone algorithm, no permission required. The whole loss window was a misreading.
//
// Why its OWN database and not the `eq-offline` outbox:
//   • The outbox queues *intents* (small JSON-ish payloads) and replays them by
//     kind. Photos are bulk binary with their own scheduler; they'd distort the
//     outbox's FIFO ("a create replays before the edits that depend on it") and its
//     MAX_ATTEMPTS poison-drop would silently bin a contractor's only shot of a job.
//   • Adding a store to `eq-offline` means an version bump, and both modules open
//     that DB independently — whoever opens first at the old version wins and the
//     other throws. A separate DB has no migration to coordinate.
// Same engine boundary as before, just durable: one photo queue, one blob store.

import type { PhotoKind } from '@/types'
import type { JobRow } from '@/lib/beforeafter/autopair'
import type { QueueCtx } from '@/lib/uploadQueue'

// What we persist. The blob is ALREADY downscaled (lib/photos.downscale runs at
// enqueue): a phone JPEG is ~4MB, the downscale ~300KB, and a contractor can shoot
// six photos a stop across a ten-stop route with no signal. Storing originals would
// put ~240MB on disk to upload ~18MB — quota risk for no gain, since the upload
// downscales anyway. Re-downscaling the stored blob later is a cheap no-op:
// downscale() returns its input untouched once the image is already within maxDim.
export interface PendingPhotoRec {
  id: string
  sig: string                  // dedupe signature (name|size|lastModified)
  blob: Blob                   // downscaled bytes
  name: string                 // original filename (extension drives content-type)
  kind: PhotoKind
  ctx: QueueCtx
  groupId: string
  label: string
  pairJob: JobRow | null
  takenAt: string | null       // EXIF capture time, read BEFORE the downscale drops EXIF
  contentHash: string | null
  attempts: number
  createdAt: number
}

const DB_NAME = 'eq-photo-queue'
const STORE = 'pending'

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

// Resolves when the TRANSACTION COMMITS, not when the request succeeds.
//
// This module is sold as owning survival, and its durability signal used to fire
// before durability existed: it resolved on `request.onsuccess`, which only means the
// request was accepted INSIDE the transaction — the bytes are not on disk until the
// transaction commits. `await putPending(...)` therefore returned while the write was
// still in flight, and a phone that died in that gap lost the photo silently while
// the UI said "Saved". (The outbox's tx() has the same shape; there it's harmless,
// because a lost intent is re-derivable and a lost photo is not — the lawn is mown.)
// Reads still resolve from the request: there is nothing to commit.
function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(db => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    let result: T
    const r = run(t.objectStore(STORE))
    r.onsuccess = () => { result = r.result; if (mode === 'readonly') resolve(result) }
    r.onerror = () => reject(r.error)
    t.oncomplete = () => { db.close(); resolve(result) }
    // A write that aborts (quota, a killed tab mid-commit) must REJECT, not hang.
    // Previously neither of these was handled, so the promise stayed pending forever
    // and its db handle leaked — enough of them blocks a future openDB upgrade.
    t.onabort = () => { db.close(); reject(t.error || new Error('idb transaction aborted')) }
    t.onerror = () => { db.close(); reject(t.error || new Error('idb transaction failed')) }
  }))
}

// Every call is best-effort. Persistence is a safety net under the in-memory queue,
// never a gate in front of it: if the disk is full or IDB is blocked (private mode,
// some webviews), the upload still runs for this session — it just won't survive a
// restart. Failing the upload because we couldn't write a backup would trade a rare
// loss for a certain one.
// Returns TRUE only when the bytes are genuinely committed to disk.
//
// This used to swallow every failure and return void, so the caller could not tell a
// stored photo from an unstored one — and the tile said "Saved — uploads when you're
// back" either way. On a full disk or in a locked-down webview that is the single
// most damaging sentence in the app: it's the reason a contractor DOESN'T re-shoot,
// and the lawn is already mown. Still best-effort (a failure never blocks the
// in-session upload), but now it's an honest answer the UI can use.
export async function putPending(rec: PendingPhotoRec): Promise<boolean> {
  if (!hasIDB()) return false
  try { await tx('readwrite', s => s.put(rec)); return true } catch { return false }
}

// Age out records that are never going to upload. Unbounded growth is itself a
// data-loss path: a poison photo from six weeks ago (its job deleted, its user
// re-logged-in) sits on disk forever, and the quota it holds is quota TODAY's photo
// can't have — a silent putPending failure caused by yesterday's garbage.
// Generous on purpose: a photo is unrecreatable, so we'd rather carry it for a month
// than bin it early. Anything this old has had dozens of reconnects to succeed.
const MAX_AGE_MS = 30 * 24 * 60 * 60_000
export async function sweepPending(now: number): Promise<number> {
  if (!hasIDB()) return 0
  try {
    const all = await allPending()
    const stale = all.filter(r => now - r.createdAt > MAX_AGE_MS)
    for (const r of stale) await dropPending(r.id)
    return stale.length
  } catch { return 0 }
}

export async function allPending(): Promise<PendingPhotoRec[]> {
  if (!hasIDB()) return []
  try {
    const all = await tx<PendingPhotoRec[]>('readonly', s => s.getAll() as IDBRequest<PendingPhotoRec[]>)
    return (all || []).sort((a, b) => a.createdAt - b.createdAt)   // oldest first
  } catch { return [] }
}

export async function dropPending(id: string): Promise<void> {
  if (!hasIDB()) return
  try { await tx('readwrite', s => s.delete(id)) } catch { /* ignore */ }
}

export async function bumpPendingAttempts(id: string, attempts: number): Promise<void> {
  if (!hasIDB()) return
  try {
    const rec = await tx<PendingPhotoRec | undefined>('readonly', s => s.get(id) as IDBRequest<PendingPhotoRec | undefined>)
    if (rec) await tx('readwrite', s => s.put({ ...rec, attempts }))
  } catch { /* ignore */ }
}
