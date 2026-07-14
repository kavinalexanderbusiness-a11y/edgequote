// ── Offline replay handlers ──────────────────────────────────────────────────────
// The ONE place every offline-capable mutation says how to replay itself. A call
// site enqueues `{ kind, payload }` via queueOrRun; on reconnect the outbox looks
// up the handler by `kind` and runs it with the stored payload. Handlers must be
// pure "given this payload, perform the real mutation" — they reuse the SAME engine
// the online path uses (the comms API route, the Supabase client), never a copy.
//
// Register once on the client (from the mounted OfflineStatus). Idempotent.

import { createClient } from '@/lib/supabase/client'
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
  // (Photo uploads are online-only again after the merge — main's photo experience
  // handles capture/dedup/EXIF directly, so there is no photo.upload replay handler.)
}
