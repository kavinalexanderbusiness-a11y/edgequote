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
// Group ids must be unique ACROSS SESSIONS, not just within one. `g${++groupSeq}`
// restarted at "g1" every launch while rehydrated photos kept last session's "g1",
// so maybeFinishGroup filtered both sessions into one group: pairJob became
// yesterday's job, and ensurePair could write a before/after pair spanning two
// different properties — yesterday's "before" beside today's "after". It also
// inherited that group's notifiedGroups entry, so the new batch finished with no
// toast at all, and clearDone('g1') emptied the other session's tiles.
const SESSION = (() => {
  try { return crypto.randomUUID().slice(0, 8) } catch { return String(Date.now() % 1e8) }
})()
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
    void dropWhenPersisted(id)                                       // it's on the server now
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
  const groupId = `g-${SESSION}-${++groupSeq}`
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
      // Park it as 'paused' when we're ALREADY offline. pump() returns early with no
      // signal and only the `offline` EVENT set paused — and that event fires on the
      // transition, not the state. So a photo shot while offline stayed 'queued'
      // forever and the tile rendered a bare spinner: the honest "Saved — uploads
      // when you're back" copy never showed in the one scenario it was written for.
      status: online() ? 'queued' : 'paused',
      attempts: 0, takenAt: e.takenAt ?? null, contentHash: e.contentHash ?? null,
    })
  }
  if (added.length) {
    items = [...items, ...added]; emit(); pump()
    void persist(added)
  }
  return groupId
}

// Shrink then store. Downscaling first is what makes persistence affordable, and the
// upload reuses the SAME blob (see below) so it costs one encode, not two.
//
// `persisted` tracks which items have their bytes committed. It exists because
// dropPending raced persist: on wifi an upload finished in ~200ms and called
// dropPending on a record persist hadn't written yet (~300ms), so the delete hit
// nothing and the write landed AFTER — an orphan record for an already-uploaded
// photo, which the next launch faithfully rehydrated and uploaded a SECOND time.
// The old comment claimed "whichever finishes first, the other is a no-op". It wasn't.
const persisted = new Set<string>()
const persistDone = new Map<string, Promise<void>>()

async function persist(list: QueueItem[]): Promise<void> {
  for (const it of list) {
    const p = (async () => {
      try {
        const blob = await downscale(it.file)
        // Swap the item onto the downscaled bytes. persist() used to store the small
        // blob but leave item.file as the original 4MB File, so run() handed THAT to
        // uploadPhoto, which downscaled from scratch again — two full 12MP decode+
        // encode passes per photo on the main thread, competing with visualHash's
        // third, and lengthening the very window where the photo isn't yet on disk.
        // The "one encode total" claim only ever held on the rehydrated path.
        patch(it.id, { file: new File([blob], it.file.name, { type: blob.type || it.file.type }) })
        await putPending({
          id: it.id, sig: it.sig, blob, name: it.file.name, kind: it.kind, ctx: it.ctx,
          groupId: it.groupId, label: it.label, pairJob: it.pairJob,
          takenAt: it.takenAt ?? null, contentHash: it.contentHash ?? null, attempts: it.attempts,
          createdAt: Date.now(),
        })
        persisted.add(it.id)
      } catch { /* best-effort — the in-memory upload still runs this session */ }
    })()
    persistDone.set(it.id, p)
    await p
  }
}

// Drop a record only once we know there IS one. Awaiting the in-flight persist first
// is what closes the orphan race above; if persistence never succeeded there's simply
// nothing to delete.
async function dropWhenPersisted(id: string): Promise<void> {
  const p = persistDone.get(id)
  if (p) await p.catch(() => {})
  persistDone.delete(id)
  if (persisted.has(id)) { persisted.delete(id); await dropPending(id) }
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
  void dropWhenPersisted(id)
  emit()
}

export function clearDone(groupId?: string) {
  const drop = items.filter(i => i.status === 'done' && (!groupId || i.groupId === groupId))
  if (!drop.length) return
  for (const d of drop) { try { URL.revokeObjectURL(d.previewUrl) } catch { /* ignore */ } }
  items = items.filter(i => !drop.includes(i))
  // Belt and braces: a 'done' item already dropped its record on success. This only
  // matters if the tray outlived a write that failed silently.
  for (const d of drop) void dropWhenPersisted(d.id)
  emit()
}

// ── Resume ───────────────────────────────────────────────────────────────────────
// The outbox wakes on online + visibilitychange + a 30s interval (OfflineStatus)
// precisely because mobile browsers fire `online` unreliably — a phone that regains
// signal while the tab is backgrounded often never fires it at all. This queue had
// ONLY the event, so on reconnect the job writes synced and the queue indicator
// cleared while the photos sat paused: everything LOOKED synced and the contractor
// drove away. They weren't lost (they're on disk, and rehydrate catches them next
// launch) — but rehydrate runs once per load, so within a long shift they stalled.
// Same three triggers now; resume() is a no-op when there's nothing parked.
function resume(): void {
  if (!online()) return
  let woke = false
  for (const it of items) if (it.status === 'paused') { patch(it.id, { status: 'queued' }); woke = true }
  if (woke || items.some(i => i.status === 'queued')) pump()
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', resume)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resume() })
  window.setInterval(resume, 30_000)
  window.addEventListener('offline', () => {
    for (const it of items) if (it.status === 'queued') patch(it.id, { status: 'paused' })
  })
}
