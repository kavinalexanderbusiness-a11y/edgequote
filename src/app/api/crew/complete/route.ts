import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveAppRole } from '@/lib/crewAccess'
import { createDraftInvoiceForCompletedJob, uncompleteJob } from '@/lib/invoicing'
import { attemptAutoPayCharge } from '@/lib/payments/autopay'
import type { Job } from '@/types'

export const runtime = 'nodejs'          // the service role must never run at the edge
export const dynamic = 'force-dynamic'

// ── Crew completion → the SAME billing handoff the owner's Complete runs ─────
// THE reason this route exists: on every owner door, completing a visit is
// never just a status write — it is status + createDraftInvoiceForCompletedJob
// (idempotent draft, owner reviews before sending) + the AutoPay attempt. A
// crew session may not touch invoices (no table grants, deliberately), so crew
// completion used to stop at the status — and whether a finished visit got
// billed silently depended on WHO pressed Complete. This server boundary runs
// the identical engines with the OWNER's authority, which it derives from the
// verified roster row — never from the request.
//
// WHAT THE CLIENT MAY SAY, exhaustively: a job id, an action, and the same four
// typed lifecycle fields crew_set_visit_status has always accepted. No amount,
// no customer, no property, no owner id — the invoice's price is derived by the
// engine from the job/quote/add-ons rows, and the identities come from the
// verified job row. A crafted body has nowhere to go.
//
// ORDER + IDEMPOTENCY:
//  · complete: the status write goes FIRST, through the EXISTING RPC on the
//    CALLER's session (assignment re-check, optimistic version, refuses
//    cancelled — the same door as always). Only after the RPC says ok does the
//    draft engine run — and it de-dupes on job_id (+ quote_id for one-time) with
//    the partial unique index as the atomic race backstop, so a double-tap or a
//    retried request can never draft twice, and an EXISTING invoice (sent, paid,
//    deposit-carrying) is never touched ('exists' is terminal).
//  · undo: uncompleteJob — the draft dies FIRST (only ever a draft; a sent/paid
//    invoice is left alone and the owner is told), then the status reverts
//    through the same RPC. Interrupted between the halves, the failure mode is
//    "no invoice + still reads completed", which the owner's un-invoiced
//    visibility catches — never a live invoice for un-done work.
//
// HONESTY: a failed draft/undo NEVER claims success anywhere. The worker's
// completion stands (true) and the OWNER gets a notification naming the visit
// that needs manual billing — the same notifications bell every other owner
// alert uses. The crew response carries no invoice details at all: billing is
// not this audience's surface.

interface VisitStateBody {
  status?: unknown; started_at?: unknown; completed_at?: unknown; actual_minutes?: unknown
}

async function notifyOwner(
  admin: NonNullable<ReturnType<typeof createAdminClient>>,
  p: { ownerId: string; type: string; jobId: string; customerId: string | null; title: string; body: string },
): Promise<void> {
  // Once per (type, job) — a retried request must not stack bells.
  const { data: dup } = await admin.from('notifications').select('id')
    .eq('user_id', p.ownerId).eq('type', p.type).eq('entity_id', p.jobId).limit(1)
  if (dup && dup.length) return
  await admin.from('notifications').insert({
    user_id: p.ownerId, type: p.type, title: p.title, body: p.body,
    customer_id: p.customerId, entity_type: 'job', entity_id: p.jobId,
    href: '/dashboard/schedule',
  })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })

  const role = await resolveAppRole(supabase)
  if (role !== 'crew') return NextResponse.json({ error: 'Only crew members complete visits here.' }, { status: 403 })

  const body = await req.json().catch(() => null) as {
    jobId?: unknown; action?: unknown; baseUpdatedAt?: unknown; next?: VisitStateBody; prev?: VisitStateBody
  } | null
  const jobId = String(body?.jobId || '')
  const action = body?.action === 'undo' ? 'undo' : body?.action === 'complete' ? 'complete' : null
  const baseUpdatedAt = String(body?.baseUpdatedAt || '')
  if (!jobId || !action || !baseUpdatedAt) return NextResponse.json({ error: 'bad request' }, { status: 400 })

  const admin = createAdminClient()
  if (!admin) return NextResponse.json({ error: 'Completing visits isn’t available right now.' }, { status: 503 })

  // The worker, per the roster switches — the same predicate crew_technician_id()
  // enforces in SQL. A failed read refuses; it is never "checked out fine".
  const { data: tech, error: techErr } = await admin.from('technicians')
    .select('id, user_id, crew_id')
    .eq('auth_user_id', user.id).eq('is_active', true).is('archived_at', null)
    .maybeSingle()
  if (techErr) return NextResponse.json({ error: 'Couldn’t verify your crew access — try again.' }, { status: 502 })
  const t = tech as { id: string; user_id: string; crew_id: string | null } | null
  if (!t || !t.crew_id) return NextResponse.json({ error: 'Your account is no longer active on a crew.' }, { status: 403 })

  // The visit, proven to be this crew's work for this employer. Owner identity
  // for everything below comes from THIS row.
  const { data: jobRow, error: jobErr } = await admin.from('jobs')
    .select('*')
    .eq('id', jobId).eq('user_id', t.user_id).eq('crew_id', t.crew_id)
    .neq('status', 'cancelled')
    .maybeSingle()
  if (jobErr) return NextResponse.json({ error: 'Couldn’t check that visit — try again.' }, { status: 502 })
  if (!jobRow) return NextResponse.json({ error: 'That visit isn’t on your board.' }, { status: 404 })
  const job = jobRow as Job
  const ownerId = t.user_id

  // The typed lifecycle fields, exactly as crew_set_visit_status has always
  // taken them (labor stats, not billing — the invoice amount never reads them).
  const rpcParams = (s: VisitStateBody | undefined, status: string) => ({
    p_job_id: jobId,
    p_status: status,
    p_base_updated_at: baseUpdatedAt,
    p_started_at: (s?.started_at as string | null) ?? null,
    p_completed_at: (s?.completed_at as string | null) ?? null,
    p_actual_minutes: s?.actual_minutes == null ? null : Number(s.actual_minutes),
  })

  if (action === 'complete') {
    // 1 — status, through the SAME door as always (caller's session: the RPC
    // re-checks assignment and the optimistic version itself).
    const { data: rpcData, error: rpcErr } = await supabase.rpc('crew_set_visit_status', rpcParams(body?.next, 'completed'))
    if (rpcErr) return NextResponse.json({ error: rpcErr.message }, { status: 502 })
    const rpc = rpcData as { ok?: boolean; updated_at?: string } | null
    if (!rpc?.ok) return NextResponse.json({ ok: false, stale: true }, { status: 409 })

    // 2 — THE billing handoff, identical to the owner's: draft (idempotent),
    // then the AutoPay attempt (the engine gates everything and no-ops when
    // not eligible; the charge never blocks or un-does the completion).
    //
    // The engine drafts from the ROW THE RPC JUST WROTE — re-read, never a
    // hand-assembled echo of the request. This is also what keeps the one-stamp
    // rule true here: nothing in this route composes a completed status; the
    // only writer was crew_set_visit_status applying completionPatch's values.
    const { data: freshRow, error: freshErr } = await admin.from('jobs')
      .select('*').eq('id', jobId).eq('user_id', ownerId).maybeSingle()
    if (freshErr || !freshRow) {
      // The completion is real (the RPC said ok); the billing needs the owner.
      await notifyOwner(admin, {
        ownerId, type: 'crew_complete_uninvoiced', jobId, customerId: job.customer_id ?? null,
        title: 'Completed visit needs an invoice',
        body: `${job.title || 'A visit'} was completed by your crew, but the invoice step could not run. Invoice it from the schedule.`,
      }).catch(() => {})
      return NextResponse.json({ ok: true, updatedAt: rpc.updated_at })
    }
    const draft = await createDraftInvoiceForCompletedJob(admin, freshRow as Job, { ownerId })
    if (draft.created && draft.invoiceId) {
      await attemptAutoPayCharge(admin, { invoiceId: draft.invoiceId, userId: ownerId, manual: false }).catch(() => {})
    } else if (draft.reason === 'error') {
      // The completion is real; the billing needs the owner's hand. Say so where
      // the owner actually looks — never silently, never to the worker.
      await notifyOwner(admin, {
        ownerId, type: 'crew_complete_uninvoiced', jobId, customerId: job.customer_id ?? null,
        title: 'Completed visit needs an invoice',
        body: `${job.title || 'A visit'} was completed by your crew, but the draft invoice could not be created. Invoice it from the schedule.`,
      }).catch(() => {})
    }
    // 'exists' and 'no-amount' are terminal non-events, exactly as on the owner
    // path (an unpriced visit is already surfaced by the day board's
    // "done with no price" line).
    return NextResponse.json({ ok: true, updatedAt: rpc.updated_at })
  }

  // action === 'undo' — the inverse as ONE operation: draft dies first (admin,
  // owner-scoped, drafts only), status reverts second through the crew RPC.
  const res = await uncompleteJob(admin, {
    jobId,
    patch: {},   // unused: applyPatch below carries the real revert
    applyPatch: async () => {
      const { data: rpcData, error: rpcErr } = await supabase.rpc('crew_set_visit_status',
        rpcParams(body?.prev, String((body?.prev?.status as string | undefined) ?? 'scheduled')))
      if (rpcErr) throw new Error(rpcErr.message)
      const rpc = rpcData as { ok?: boolean } | null
      if (!rpc?.ok) throw new Error('This visit changed — refresh and try again.')
    },
  })
  if (res.error || !res.reverted) {
    return NextResponse.json({ error: res.error || 'Couldn’t undo that — refresh and try again.' }, { status: 502 })
  }
  if (res.invoiceLocked) {
    // Un-done work whose bill already went out is the owner's call to make.
    await notifyOwner(admin, {
      ownerId, type: 'crew_uncomplete_invoiced', jobId, customerId: job.customer_id ?? null,
      title: 'Un-done visit already invoiced',
      body: `${job.title || 'A visit'} was un-completed by your crew, but invoice ${res.invoiceNumber || ''} had already gone out. Cancel or credit it if the work wasn’t done.`,
    }).catch(() => {})
  }
  return NextResponse.json({ ok: true })
}
