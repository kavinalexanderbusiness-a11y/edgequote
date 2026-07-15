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

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(db => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const r = run(t.objectStore(STORE))
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
    t.oncomplete = () => db.close()
  }))
}

// Every call is best-effort. Persistence is a safety net under the in-memory queue,
// never a gate in front of it: if the disk is full or IDB is blocked (private mode,
// some webviews), the upload still runs for this session — it just won't survive a
// restart. Failing the upload because we couldn't write a backup would trade a rare
// loss for a certain one.
export async function putPending(rec: PendingPhotoRec): Promise<void> {
  if (!hasIDB()) return
  try { await tx('readwrite', s => s.put(rec)) } catch { /* quota / blocked — session-only */ }
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
