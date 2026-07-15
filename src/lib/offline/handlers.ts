// ── Offline replay handlers ──────────────────────────────────────────────────────
// The ONE place every offline-capable mutation says how to replay itself. A call
// site enqueues `{ kind, payload }` via queueOrRun; on reconnect the outbox looks
// up the handler by `kind` and runs it with the stored payload. Handlers must be
// pure "given this payload, perform the real mutation" — they reuse the SAME engine
// the online path uses (the comms API route, the Supabase client), never a copy.
//
// Register once on the client (from the mounted OfflineStatus). Idempotent.

import { createClient } from '@/lib/supabase/client'
import { createDraftInvoiceForCompletedJob, syncDraftInvoiceAmounts } from '@/lib/invoicing'
import { recordPriceChange, addLineItems } from '@/lib/jobPricing'
import type { Job } from '@/types'
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
    const p = payload as {
      id: string; patch: Record<string, unknown>; syncPrice?: boolean; syncReason?: string
      priceAudit?: Parameters<typeof recordPriceChange>[1]
    }
    const supabase = createClient()
    const { error } = await supabase.from('jobs').update(p.patch).eq('id', p.id)
    if (error) throw new Error(error.message)
    // The follow-ups the online path performs, replayed with it — a patch that
    // arrives without them isn't the same mutation, just a piece of one.
    if (p.priceAudit) await recordPriceChange(supabase, p.priceAudit).catch(() => {})
    // Re-pricing a visit that ALREADY has a draft invoice has to carry to the draft,
    // or the customer gets billed yesterday's number. (Only for an existing draft —
    // a job completed offline drafts fresh, at the new price, via job.complete.)
    if (p.syncPrice) await syncDraftInvoiceAmounts(supabase, [p.id], { reason: p.syncReason })
  })

  // P6 — Completing a job is NOT just a jobs patch: online it also drafts the
  // invoice and fires the job-complete message. Replaying only the patch would
  // mean a contractor who finishes a route with no signal reconnects to eight
  // completed jobs and ZERO invoices — the money silently never gets billed. So
  // the whole completion replays here, through the SAME engines the online path
  // calls. Both are safely idempotent: the draft de-dupes on job_id, and the
  // comms route enforces its own opt-in + dedupe, so a retried op is a no-op.
  registerHandler('job.complete', async (payload) => {
    const p = payload as { id: string; patch: Record<string, unknown>; job: Job; notify?: boolean }
    const supabase = createClient()
    const { error } = await supabase.from('jobs').update(p.patch).eq('id', p.id)
    if (error) throw new Error(error.message)
    // Invoice before message: if the draft throws we keep the op queued and retry,
    // rather than having told the customer we're done with nothing to bill them.
    await createDraftInvoiceForCompletedJob(supabase, p.job)
    if (p.notify && p.job.customer_id) {
      await fetch('/api/comms/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: p.job.customer_id, template: 'job_complete', jobId: p.id, dedupe: true }),
      }).catch(() => {})   // a failed courtesy text must not re-run the invoice
    }
  })
  // P7 — Visit add-ons. Extra services sold ON SITE ("do the mulch while you're
  // here") are money, and this used to no-op silently with no signal: the call
  // opened with a network getUser() and bailed on !user, so the contractor typed a
  // charge, tapped save, and nothing happened OR warned them.
  // Replays the add + the draft re-price together — the add-on is only real once the
  // invoice it belongs on knows about it.
  registerHandler('job.addons.add', async (payload) => {
    const p = payload as { opts: Parameters<typeof addLineItems>[1]; syncJobIds: string[] }
    const supabase = createClient()
    await addLineItems(supabase, p.opts)
    await syncDraftInvoiceAmounts(supabase, p.syncJobIds)
  })
  // (Photo uploads have their OWN durable queue — lib/offline/photoStore + the
  // upload queue's scheduler. They're bulk binary with their own retry/pairing
  // rules, so they'd distort this queue's FIFO and its poison-drop would bin a
  // job's only photo. See photoStore's header for the full reasoning.)
}
