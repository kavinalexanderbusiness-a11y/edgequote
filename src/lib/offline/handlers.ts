// ── Offline replay handlers ──────────────────────────────────────────────────────
// The ONE place every offline-capable mutation says how to replay itself. A call
// site enqueues `{ kind, payload }` via queueOrRun; on reconnect the outbox looks
// up the handler by `kind` and runs it with the stored payload. Handlers must be
// pure "given this payload, perform the real mutation" — they reuse the SAME engine
// the online path uses (the comms API route, the Supabase client), never a copy.
//
// Register once on the client (from the mounted OfflineStatus). Idempotent.

import { createClient } from '@/lib/supabase/client'
import { uploadPhoto } from '@/lib/photos'
import type { PhotoKind } from '@/types'
import { registerHandler } from './outbox'

let registered = false

export function registerOfflineHandlers(): void {
  if (registered) return
  registered = true

  // P1 — Messages. Replays through the SAME comms sender the online path uses
  // (/api/messages/send). A 5xx keeps the op queued for the next flush; a
  // "saved but not delivered" response still persisted the message → treat as done.
  registerHandler('message.send', async (payload) => {
    const p = payload as { customerId: string; body: string; internal?: boolean; clientMessageId?: string }
    // Forward the SAME clientMessageId captured when the send was queued. The server
    // reserves on it, so replaying a queued op (even across reloads or two tabs) can
    // never dispatch a second SMS — it dedupes to a no-op.
    const res = await fetch('/api/messages/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: p.customerId, body: p.body, internal: !!p.internal, clientMessageId: p.clientMessageId }),
    })
    if (!res.ok) throw new Error(`message.send replay failed (${res.status})`)
  })

  // P2 + P3 — Customer notes AND profile edits are the same mutation: a patch on
  // customers. One handler covers name/phone/email/address/notes — no per-field queue.
  registerHandler('customer.update', async (payload) => {
    const p = payload as { id: string; patch: Record<string, unknown> }
    const supabase = createClient()
    const { error } = await supabase.from('customers').update(p.patch).eq('id', p.id)
    if (error) throw new Error(error.message)
  })

  // P4 — Quote edits/status. A patch on quotes (same shape as customer.update).
  registerHandler('quote.update', async (payload) => {
    const p = payload as { id: string; patch: Record<string, unknown> }
    const supabase = createClient()
    const { error } = await supabase.from('quotes').update(p.patch).eq('id', p.id)
    if (error) throw new Error(error.message)
  })

  // P5 — Jobs. The HANDLER lives here (shared), but the call sites live in the
  // scheduler, which Session C owns. They only need to call
  // `queueOrRun({ kind:'job.update', payload:{ id, patch } }, run)` — no other import.
  // See docs/OFFLINE_FOR_SESSION_C.md. We register it here so it's always available.
  registerHandler('job.update', async (payload) => {
    const p = payload as { id: string; patch: Record<string, unknown> }
    const supabase = createClient()
    const { error } = await supabase.from('jobs').update(p.patch).eq('id', p.id)
    if (error) throw new Error(error.message)
  })

  // P6 — Photos. Replays through the SAME pipeline (lib/photos.uploadPhoto) — no
  // second upload engine. The stable `uploadId` makes the storage path deterministic
  // so a replay dedupes (never a second file/row). The File/Blob was persisted in the
  // outbox (IndexedDB structured clone) so it survives reloads; EXIF, metadata, the
  // AI-Vision job_photos rows, and marketing before/after pairing are all preserved
  // because the exact same rows are created.
  registerHandler('photo.upload', async (payload) => {
    const p = payload as {
      uploadId: string; userId: string; propertyId: string | null; jobId: string | null
      customerId: string | null; kind: PhotoKind; caption: string | null; takenAt: string; file: File | Blob
    }
    const supabase = createClient()
    const file = p.file instanceof File ? p.file : new File([p.file], `${p.uploadId}.jpg`, { type: (p.file as Blob).type || 'image/jpeg' })
    const row = await uploadPhoto(supabase, {
      userId: p.userId, file, propertyId: p.propertyId, jobId: p.jobId, customerId: p.customerId,
      kind: p.kind, caption: p.caption, uploadId: p.uploadId, takenAt: p.takenAt,
    })
    if (!row) throw new Error('photo.upload replay failed')
  })
}
