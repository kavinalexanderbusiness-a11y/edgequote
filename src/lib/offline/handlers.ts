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
import { registerHandler, ConflictError, isOwnedThisFlush } from './outbox'

let registered = false

// ── Guarded patch — ONE implementation for every kind that updates a row ─────────
// Optimistic concurrency. `baseUpdatedAt` is the row version the contractor's edit was
// based on, captured when they made it. We only write if the server still holds that
// version; if it doesn't, the row changed while they were offline and blindly writing
// would silently revert whoever changed it (usually the office). That was the old
// behaviour: last-write-wins, no trace.
//
// Verified against the live DB before relying on it: customers/jobs/quotes/invoices
// each carry updated_at with a `handle_updated_at` BEFORE UPDATE trigger
// (`new.updated_at = now()`), so the version genuinely advances on every server edit.
//
// The version MUST be the raw string Supabase returned. updated_at is timestamptz
// precision 6 (e.g. 2026-07-15 05:41:07.299074+00); round-tripping it through
// `new Date().toISOString()` truncates to milliseconds, which would match NOTHING and
// turn every single replay into a false conflict.
//
// No baseUpdatedAt → unguarded, exactly as before. That keeps ops queued by older
// builds (and call sites not yet passing a version) working rather than failing them
// all as conflicts.
async function guardedPatch(
  supabase: ReturnType<typeof createClient>,
  table: 'jobs' | 'customers' | 'quotes',
  id: string,
  patch: Record<string, unknown>,
  baseUpdatedAt?: string | null,
): Promise<void> {
  // No version to check against, or the row is one WE already wrote this flush (a
  // chained offline edit — see isOwnedThisFlush): patch it straight. Guarding against
  // a version our own previous op just replaced would invent a conflict.
  const ownKey = `${table.slice(0, -1)}:${id}`   // 'jobs' → 'job:<id>', matching entityKey
  if (!baseUpdatedAt || isOwnedThisFlush(ownKey)) {
    const { error } = await supabase.from(table).update(patch).eq('id', id)
    if (error) throw new Error(error.message)
    return
  }
  const { data, error } = await supabase
    .from(table).update(patch).eq('id', id).eq('updated_at', baseUpdatedAt).select('id')
  if (error) throw new Error(error.message)          // network/RLS → retryable
  if (data && data.length > 0) return                // we held the current version

  // Zero rows means the precondition failed — but that's two different situations, and
  // telling a contractor "someone edited it" about a record that was DELETED would send
  // them looking for something that isn't there. A plain read distinguishes them.
  const { data: still, error: readErr } = await supabase.from(table).select('id').eq('id', id).maybeSingle()
  if (readErr) throw new Error(readErr.message)      // couldn't tell → retry, don't guess
  throw new ConflictError(
    still ? `${table} ${id} changed on the server` : `${table} ${id} no longer exists`,
    patch,
    still ? 'changed' : 'gone',
  )
}

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
    const p = payload as {
      id: string; patch: Record<string, unknown>
      /** Editing a customer's address ALSO moves their primary property (see below). */
      primaryProperty?: Record<string, unknown>
      baseUpdatedAt?: string | null
    }
    const supabase = createClient()
    await guardedPatch(supabase, 'customers', p.id, p.patch, p.baseUpdatedAt)
    // LEGACY branch (Customer V2): the edit form no longer carries an address, so
    // new ops never include primaryProperty — but an op QUEUED OFFLINE before the
    // upgrade still might, and a queued mutation must replay whole or not at all
    // (same rule as job.complete). Keep honouring it until the queue can't
    // possibly hold pre-V2 ops; it costs nothing when absent.
    if (p.primaryProperty) {
      const { error: propErr } = await supabase.from('properties')
        .update(p.primaryProperty).eq('customer_id', p.id).eq('is_primary', true)
      if (propErr) throw new Error(propErr.message)
    }
  })

  // P4 — Quote edits/status. A patch on quotes (same shape as customer.update).
  registerHandler('quote.update', async (payload) => {
    const p = payload as { id: string; patch: Record<string, unknown>; baseUpdatedAt?: string | null }
    const supabase = createClient()
    await guardedPatch(supabase, 'quotes', p.id, p.patch, p.baseUpdatedAt)
  })

  // P5 — Jobs. The HANDLER lives here (shared), but the call sites live in the
  // scheduler, which Session C owns. They only need to call
  // `queueOrRun({ kind:'job.update', payload:{ id, patch } }, run)` — no other import.
  // See docs/OFFLINE_FOR_SESSION_C.md. We register it here so it's always available.
  registerHandler('job.update', async (payload) => {
    const p = payload as {
      id: string; patch: Record<string, unknown>; syncPrice?: boolean; syncReason?: string
      priceAudit?: Parameters<typeof recordPriceChange>[1]
      baseUpdatedAt?: string | null
    }
    const supabase = createClient()
    await guardedPatch(supabase, 'jobs', p.id, p.patch, p.baseUpdatedAt)
    // The follow-ups the online path performs, replayed with it — a patch that
    // arrives without them isn't the same mutation, just a piece of one.
    //
    // The audit row stays best-effort ON PURPOSE, and it's the only thing here that
    // does: the price is the contractor's work, the audit trail is analytics about it.
    // Retrying the op to win an audit row would re-run the patch for a row nobody bills
    // from. It's swallowed loudly here rather than silently — recordPriceChange also
    // absorbs its own insert error internally, so this .catch is a second net.
    if (p.priceAudit) await recordPriceChange(supabase, p.priceAudit).catch(() => {})
    // Re-pricing a visit that ALREADY has a draft invoice has to carry to the draft,
    // or the customer gets billed yesterday's number. (Only for an existing draft —
    // a job completed offline drafts fresh, at the new price, via job.complete.)
    // Reported, not thrown → must be read, or the op is deleted having billed the old
    // amount. Retry is safe: the patch above is a fixed set of fields (idempotent) and
    // the sync recomputes from the job.
    if (p.syncPrice) {
      const { failed } = await syncDraftInvoiceAmounts(supabase, [p.id], { reason: p.syncReason })
      if (failed > 0) throw new Error(`draft re-price failed for job ${p.id}`)
    }
  })

  // P6 — Completing a job is NOT just a jobs patch: online it also drafts the
  // invoice and fires the job-complete message. Replaying only the patch would
  // mean a contractor who finishes a route with no signal reconnects to eight
  // completed jobs and ZERO invoices — the money silently never gets billed. So
  // the whole completion replays here, through the SAME engines the online path
  // calls. Both are safely idempotent: the draft de-dupes on job_id, and the
  // comms route enforces its own opt-in + dedupe, so a retried op is a no-op.
  registerHandler('job.complete', async (payload) => {
    const p = payload as { id: string; patch: Record<string, unknown>; job: Job; notify?: boolean; baseUpdatedAt?: string | null }
    const supabase = createClient()
    await guardedPatch(supabase, 'jobs', p.id, p.patch, p.baseUpdatedAt)
    // Invoice before message: a draft we couldn't create keeps the op queued to retry,
    // rather than having told the customer we're done with nothing to bill them.
    //
    // This MUST read the result. createDraftInvoiceForCompletedJob does not throw — it
    // RETURNS { created:false, reason:'error' } (invoicing.ts:187, :275), and its very
    // first act is a network getUser(). Replay runs at reconnect, when the network is
    // by definition marginal, so the draft was the single most likely step to fail —
    // and failing was indistinguishable from succeeding. The op got deleted either
    // way. That is exactly the outcome the note above claims to prevent: eight
    // completed jobs, zero invoices, no trace.
    // 'exists' and 'no-amount' are terminal successes: the invoice is already there,
    // or the visit has no price and must never draft a $0 invoice. Only 'error' retries.
    const draft = await createDraftInvoiceForCompletedJob(supabase, p.job)
    if (!draft.created && draft.reason === 'error') {
      throw new Error(`draft invoice failed for job ${p.id}`)
    }
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
  // Safe to retry: p.opts carries a groupId minted once at enqueue, so a replay whose
  // insert already landed returns those rows instead of billing the mulch twice.
  registerHandler('job.addons.add', async (payload) => {
    const p = payload as { opts: Parameters<typeof addLineItems>[1]; syncJobIds: string[] }
    const supabase = createClient()
    await addLineItems(supabase, p.opts)   // throws → op stays queued
    // syncDraftInvoiceAmounts reports { changed, failed } and never throws. An add-on
    // the draft invoice doesn't know about isn't billed, so a failed sync must retry —
    // it only ever recomputes an amount from the job, so re-running it is a no-op.
    const { failed } = await syncDraftInvoiceAmounts(supabase, p.syncJobIds)
    if (failed > 0) {
      // Retry ONLY when this add is replay-safe. Ops outlive deploys in IndexedDB, so
      // one queued by a build before groupId existed has no stable identity — retrying
      // it would insert a SECOND add-on rather than re-price the first. For those,
      // accept a stale draft total: it's visible on the invoice and fixable in a tap,
      // whereas a double charge reaches the customer and costs trust to unwind.
      if (p.opts.groupId) throw new Error(`draft re-price failed for ${failed} job(s)`)
    }
  })
  // (Photo uploads have their OWN durable queue — lib/offline/photoStore + the
  // upload queue's scheduler. They're bulk binary with their own retry/pairing
  // rules, so they'd distort this queue's FIFO and its poison-drop would bin a
  // job's only photo. See photoStore's header for the full reasoning.)
}
