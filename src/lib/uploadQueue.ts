import { createClient } from '@/lib/supabase/client'
import { uploadPhoto, downscale } from '@/lib/photos'
import type { PhotoKind } from '@/types'
import { ensurePair, type JobRow } from '@/lib/beforeafter/autopair'
import { visualHash } from '@/lib/dedup'
import { toast } from '@/lib/toast'
import { putPending, allPending, dropPending, bumpPendingAttempts } from '@/lib/offline/photoStore'

// ── Background upload queue — ONE engine for "uploads that keep going" ────────────
// A module-level external store (subscribe/emit, mirrors lib/toast) consumed by a
// single <UploadQueueWidget/> mounted in the dashboard layout — so uploads continue
// while you navigate anywhere in EdgeQuote, with progress shown in ONE place.
//   • Optimistic: items appear instantly (local object-URL previews).
//   • Parallel with a concurrency cap; retries failures with backoff.
//   • Pauses on offline, RESUMES on reconnect — and now SURVIVES a restart: every
//     pending photo's bytes are persisted to IndexedDB (lib/offline/photoStore) and
//     rehydrated on load. (The old note here said File handles "can't survive a full
//     page reload, browser security". They can: IndexedDB stores Blob/File via
//     structured clone. That misreading was the entire data-loss window — a phone
//     backgrounding the tab mid-route silently binned the job's photos.)
//   • Never uploads the same photo twice (signature dedup, restored on rehydrate).
//   • Reuses lib/photos.uploadPhoto (job_photos + the job-photos bucket) and
//     autopair.ensurePair (marketing_assets). AI Vision/portal/Studio read those
//     same rows — no new storage, no parallel photo system.

export interface QueueCtx { userId: string; propertyId: string | null; jobId: string | null; customerId: string | null }
export interface EnqueueItem { file: File; kind: PhotoKind; takenAt?: string | null; contentHash?: string | null }
export interface EnqueueGroup {
  ctx: QueueCtx
  items: EnqueueItem[]
  pairJob?: JobRow | null   // when set + the group yields a before AND an after → auto-pair
  label?: string            // property/customer label for the widget + finish toast
}

export type QueueStatus = 'queued' | 'uploading' | 'done' | 'error' | 'paused'
export interface QueueItem {
  id: string
  sig: string
  file: File
  previewUrl: string
  kind: PhotoKind
  ctx: QueueCtx
  groupId: string
  label: string
  pairJob: JobRow | null
  status: QueueStatus
  attempts: number
  error?: string
  rowId?: string
  takenAt: string | null
  contentHash: string | null   // visual hash (lib/dedup) — durable dedup, stored on the row
}

const MAX_CONCURRENT = 3
const MAX_ATTEMPTS = 4

let items: QueueItem[] = []
const EMPTY: QueueItem[] = []
const listeners = new Set<() => void>()
const seenSigs = new Set<string>()      // session dedup — never upload the same photo twice
const notifiedGroups = new Set<string>()
let groupSeq = 0
let supa: ReturnType<typeof createClient> | null = null
const client = () => (supa ||= createClient())

function emit() { items = [...items]; for (const l of Array.from(listeners)) l() }
export function subscribeUploads(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb) } }
export function getUploadItems(): QueueItem[] { return items }
export function getUploadServerSnapshot(): QueueItem[] { return EMPTY }

function patch(id: string, p: Partial<QueueItem>) {
  let changed = false
  items = items.map(i => { if (i.id !== id) return i; changed = true; return { ...i, ...p } })
  if (changed) emit()
}

const online = () => typeof navigator === 'undefined' || navigator.onLine
const backoff = (attempts: number) => Math.min(30_000, 800 * 2 ** attempts)

function pump() {
  if (!online()) return
  let slots = MAX_CONCURRENT - items.filter(i => i.status === 'uploading').length
  for (const it of items) {
    if (slots <= 0) break
    if (it.status === 'queued') { slots--; void run(it.id) }
  }
}

async function run(id: string) {
  const it = items.find(i => i.id === id)
  if (!it || it.status === 'uploading') return
  patch(id, { status: 'uploading' })
  let row: { id: string } | null = null
  try {
    // Compute the visual hash off the enqueue path (cheap 8×8 canvas) so durable
    // dedup rides along with the upload without ever blocking the UI.
    const hash = it.contentHash ?? await visualHash(it.file).catch(() => null)
    if (hash && !it.contentHash) patch(id, { contentHash: hash })
    row = await uploadPhoto(client(), {
      userId: it.ctx.userId, file: it.file, propertyId: it.ctx.propertyId,
      jobId: it.ctx.jobId, customerId: it.ctx.customerId, kind: it.kind, takenAt: it.takenAt,
      contentHash: hash,
    })
  } catch { row = null }

  const cur = items.find(i => i.id === id)
  if (!cur) return
  if (row) {
    patch(id, { status: 'done', rowId: row.id, error: undefined })
    void dropPending(id)                                             // it's on the server now
  } else {
    const attempts = cur.attempts + 1
    if (!online()) {
      patch(id, { status: 'paused', attempts })                       // wait for reconnect
    } else if (attempts < MAX_ATTEMPTS) {
      patch(id, { status: 'queued', attempts, error: 'retrying…' })   // auto-retry with backoff
      void bumpPendingAttempts(id, attempts)
      window.setTimeout(pump, backoff(attempts))
    } else {
      // Out of attempts: keep the bytes. The tray still offers Retry, and a photo
      // is the one thing here that cannot be recreated later — the lawn is mown.
      patch(id, { status: 'error', attempts, error: 'Upload failed' })
      void bumpPendingAttempts(id, attempts)
    }
  }
  maybeFinishGroup(it.groupId)
  pump()
}

// When every item in a group is terminal, auto-pair (if a before+after both landed),
// notify once, and tell any open gallery to refresh.
async function maybeFinishGroup(groupId: string) {
  const grp = items.filter(i => i.groupId === groupId)
  if (!grp.length || grp.some(i => i.status === 'queued' || i.status === 'uploading' || i.status === 'paused')) return
  if (notifiedGroups.has(groupId)) return
  notifiedGroups.add(groupId)

  const done = grp.filter(i => i.status === 'done')
  const failed = grp.filter(i => i.status === 'error')
  const job = grp[0].pairJob
  const befores = done.filter(i => i.kind === 'before')
  const afters = done.filter(i => i.kind === 'after')
  let paired = false
  if (job && grp[0].ctx.userId && befores.length && afters.length && befores[0].rowId && afters[afters.length - 1].rowId) {
    try {
      paired = await ensurePair(client(), {
        userId: grp[0].ctx.userId, job,
        beforePhotoId: befores[0].rowId!, afterPhotoId: afters[afters.length - 1].rowId!,
      }, Date.now())
    } catch { /* best-effort */ }
  }

  if (done.length) toast(`${done.length} photo${done.length !== 1 ? 's' : ''} uploaded${paired ? ' · before/after paired' : ''}${grp[0].label ? ` · ${grp[0].label}` : ''}`, { tone: 'success' })
  if (failed.length) toast(`${failed.length} upload${failed.length !== 1 ? 's' : ''} failed — open the upload tray to retry`, { tone: 'error' })

  if (typeof window !== 'undefined') {
    const propertyIds = Array.from(new Set(grp.map(i => i.ctx.propertyId).filter(Boolean)))
    const jobIds = Array.from(new Set(grp.map(i => i.ctx.jobId).filter(Boolean)))
    window.dispatchEvent(new CustomEvent('eq:upload-complete', { detail: { groupId, propertyIds, jobIds, photoIds: done.map(d => d.rowId) } }))
  }
  // Auto-clear a fully-successful group shortly after, so the tray empties itself.
  if (!failed.length) window.setTimeout(() => clearDone(groupId), 4000)
}

// ── public API ───────────────────────────────────────────────────────────────────
export function enqueueUploads(group: EnqueueGroup): string {
  const groupId = `g${++groupSeq}`
  const added: QueueItem[] = []
  for (const e of group.items) {
    const f = e.file
    const sig = `${f.name}|${f.size}|${f.lastModified}`
    if (seenSigs.has(sig)) continue           // never upload the same photo twice
    seenSigs.add(sig)
    added.push({
      id: `${groupId}-${added.length}-${Math.random().toString(36).slice(2, 7)}`,
      sig, file: f, previewUrl: URL.createObjectURL(f), kind: e.kind,
      ctx: group.ctx, groupId, label: group.label || '', pairJob: group.pairJob ?? null,
      status: 'queued', attempts: 0, takenAt: e.takenAt ?? null, contentHash: e.contentHash ?? null,
    })
  }
  if (added.length) {
    items = [...items, ...added]; emit(); pump()
    // Persist in the background: stays synchronous for callers, and the upload is
    // already racing anyway — whichever finishes first, the other is a no-op (a
    // completed upload drops its record; a persisted record for a completed upload
    // is dropped on success).
    void persist(added)
  }
  return groupId
}

// Shrink then store. Downscaling first is what makes persistence affordable, and
// the upload re-runs downscale on the smaller blob as a pass-through (see
// photos.downscale) — so this costs one encode total, not two.
async function persist(list: QueueItem[]): Promise<void> {
  for (const it of list) {
    try {
      const blob = await downscale(it.file)
      await putPending({
        id: it.id, sig: it.sig, blob, name: it.file.name, kind: it.kind, ctx: it.ctx,
        groupId: it.groupId, label: it.label, pairJob: it.pairJob,
        takenAt: it.takenAt ?? null, contentHash: it.contentHash ?? null, attempts: it.attempts,
        createdAt: Date.now(),
      })
    } catch { /* best-effort — the in-memory upload still runs this session */ }
  }
}

// ── Restart recovery ─────────────────────────────────────────────────────────────
// On load, anything still on disk goes back in the queue and uploads. Runs once,
// lazily, from the mounted tray (see UploadQueueWidget) so it never fires during SSR.
// Rehydrated items start 'queued'; pump() parks them as 'paused' if we're offline and
// the existing `online` listener releases them on reconnect — the same path a photo
// taken this session follows, so there's one resume rule, not two.
let rehydrated = false
export async function rehydrateUploads(): Promise<number> {
  if (rehydrated || typeof window === 'undefined') return 0
  rehydrated = true
  const recs = await allPending()
  if (!recs.length) return 0
  const restored: QueueItem[] = []
  for (const r of recs) {
    if (seenSigs.has(r.sig)) continue          // already back in the queue this session
    seenSigs.add(r.sig)
    // Rebuild a File from the stored bytes so the rest of the pipeline (uploadPhoto,
    // visualHash) sees exactly what it would have seen before the restart.
    const file = new File([r.blob], r.name, { type: r.blob.type || 'image/jpeg' })
    restored.push({
      id: r.id, sig: r.sig, file, previewUrl: URL.createObjectURL(r.blob), kind: r.kind,
      ctx: r.ctx, groupId: r.groupId, label: r.label, pairJob: r.pairJob,
      // Attempts reset: the last run died with the app, not on the merits. A photo
      // that has genuinely been rejected MAX_ATTEMPTS times is already off the disk.
      status: 'queued', attempts: 0, error: undefined,
      takenAt: r.takenAt, contentHash: r.contentHash,
    })
  }
  if (restored.length) {
    items = [...items, ...restored]; emit(); pump()
    toast(`Resuming ${restored.length} photo${restored.length !== 1 ? 's' : ''} from your last session`, { tone: 'info' })
  }
  return restored.length
}

export function retryUpload(id: string) {
  const it = items.find(i => i.id === id)
  if (!it || (it.status !== 'error' && it.status !== 'paused')) return
  notifiedGroups.delete(it.groupId)          // allow the group to re-notify on its next finish
  patch(id, { status: 'queued', attempts: 0, error: undefined })
  pump()
}

export function retryAllFailed() {
  for (const it of items) if (it.status === 'error' || it.status === 'paused') { notifiedGroups.delete(it.groupId); patch(it.id, { status: 'queued', attempts: 0, error: undefined }) }
  pump()
}

// Dismiss is the ONLY way a not-yet-uploaded photo leaves the queue — an explicit
// "I don't want this one". That's what makes it safe to drop the bytes too.
export function dismissUpload(id: string) {
  const it = items.find(i => i.id === id)
  if (!it) return
  try { URL.revokeObjectURL(it.previewUrl) } catch { /* ignore */ }
  seenSigs.delete(it.sig)                     // allow a deliberate re-drop later
  items = items.filter(i => i.id !== id)
  void dropPending(id)
  emit()
}

export function clearDone(groupId?: string) {
  const drop = items.filter(i => i.status === 'done' && (!groupId || i.groupId === groupId))
  if (!drop.length) return
  for (const d of drop) { try { URL.revokeObjectURL(d.previewUrl) } catch { /* ignore */ } }
  items = items.filter(i => !drop.includes(i))
  // Belt and braces: a 'done' item already dropped its record on success. This only
  // matters if the tray outlived a write that failed silently.
  for (const d of drop) void dropPending(d.id)
  emit()
}

// Resume on reconnect; reflect offline state.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    for (const it of items) if (it.status === 'paused') patch(it.id, { status: 'queued' })
    pump()
  })
  window.addEventListener('offline', () => {
    for (const it of items) if (it.status === 'queued') patch(it.id, { status: 'paused' })
  })
}
