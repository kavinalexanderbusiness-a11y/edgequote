import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { termsClaimRefresh, type StoredTermsClaim } from '@/lib/payments/termsClaimRefresh'

// ── The owner's explicit attestation about the CURRENT version ───────────────
//
// The ordinary owner path (../record-acceptance) REFUSES a quote flagged
// accepted with zero evidence and a moved price, because a click cannot say
// which version the customer saw. This is the deliberate way through: the owner
// names the current amount and confirms it.
//
// ⛔ NOT a status override, and not a bypass of anything. It writes REAL
// evidence, of kind owner_on_behalf, through the canonical writer — so every
// S121 evidence rule and the S122 contradiction gate still apply. The database
// function owns the bounds and the atomicity; this route exists to (a) keep the
// terms classification current, exactly as the sibling route does, and (b) turn
// the RPC's structured refusal into a sentence the owner can act on.
//
// ⛔ Tenant identity is derived server-side by the RPC from auth.uid(). No
// tenant is accepted from the client, and there is no anon grant.

export const dynamic = 'force-dynamic'

type Body = {
  quoteId?: string
  reason?: string
  note?: string | null
  /** The material fingerprint the owner was LOOKING AT when they confirmed. */
  expectedFingerprint?: string
  /** The amount named on the confirmation they ticked. */
  expectedAmount?: number
}

/** The RPC's structured refusals, in the owner's language. */
function explain(reason: string, r: Record<string, unknown>): string {
  switch (reason) {
    case 'not_authenticated': return 'Your session has expired — sign in and try again.'
    case 'reason_required': return 'Choose how the customer accepted before confirming.'
    case 'not_found': return 'That quote could not be found.'
    case 'status_not_repairable':
      return `This repair only applies to a quote still at Accepted — this one is ${String(r.status ?? 'further along')}. `
        + 'Reconciling a scheduled, completed or paid job needs a closer look than this can safely give.'
    case 'work_scheduled':
      return 'This quote already has work on the schedule, so its commercial terms can’t be rewritten here.'
    case 'unpriced':
      return 'This quote has no price yet — add one, or mark it No charge, before recording an acceptance.'
    case 'invoice_amount_mismatch':
      return 'An invoice has already been issued for a different amount. Reconcile the invoice first — this can’t quietly change which figure is true.'
    case 'fingerprint_mismatch':
      return 'This quote changed while you had it open, so the version you confirmed is no longer the current one. Reopen it and check the amount before confirming.'
    case 'amount_mismatch':
      return `The amount changed while you had it open (it is now ${r.current_amount}). Reopen it and confirm the current figure.`
    case 'evidence_exists':
      return r.kind === 'customer'
        ? 'The customer’s own acceptance is already on record for this quote — nothing needs repairing.'
        : 'An acceptance is already on record for this quote, so a second one can’t be added beside it.'
    default: return 'Could not record that acceptance.'
  }
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  let body: Body
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'Bad request.' }, { status: 400 }) }
  const quoteId = (body.quoteId || '').trim()
  const reason = (body.reason || '').trim()
  const note = (body.note || '').trim()
  const fp = (body.expectedFingerprint || '').trim()
  const amount = Number(body.expectedAmount)
  if (!quoteId || !reason || !fp || !Number.isFinite(amount)) {
    return NextResponse.json({ ok: false, error: 'A quote, a method, the version you saw and the amount you confirmed are all required.' }, { status: 400 })
  }
  // ⭐ The note is REQUIRED here, unlike the ordinary path. This attestation
  // exists because the record disagreed with itself; the one thing the record
  // will never recover on its own is why the owner believes the current version
  // is the one that was accepted.
  if (!note) {
    return NextResponse.json({ ok: false, error: 'Add a short note saying how you know the customer accepted this version.' }, { status: 400 })
  }

  // Keep the terms verdict current first — same self-heal as the sibling route,
  // same canonical classifier, same three columns, same tenant scoping. Without
  // it the RPC's call to quote_record_acceptance would fail closed on a stale
  // classification and the owner would meet the S122b bug again by another door.
  const { data: bs, error: bsErr } = await supabase.from('business_settings')
    .select('terms_text, terms_payment_claim, terms_payment_claim_fingerprint, terms_payment_claim_version')
    .eq('user_id', user.id).maybeSingle()
  if (bsErr) {
    return NextResponse.json({ ok: false, error: 'Could not read your Terms & Conditions — try again.' }, { status: 502 })
  }
  const { stale, patch } = termsClaimRefresh(bs as StoredTermsClaim | null)
  if (bs != null && stale) {
    const { error: upErr } = await supabase.from('business_settings').update(patch).eq('user_id', user.id)
    if (upErr) {
      return NextResponse.json({ ok: false, error: 'Could not review your Terms & Conditions — try again.' }, { status: 502 })
    }
  }

  const { data, error } = await supabase.rpc('owner_confirm_current_acceptance', {
    p_quote_id: quoteId,
    p_reason: reason,
    p_note: note,
    p_expected_fingerprint: fp,
    p_expected_amount: amount,
  })

  // A raised exception is the contradiction gate (or an S121 rule) refusing —
  // its message is already written for a human and is passed through unchanged.
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 409 })
  }
  const r = (data ?? {}) as Record<string, unknown>
  if (!r.ok) {
    return NextResponse.json({
      ok: false, reason: r.reason, error: explain(String(r.reason ?? ''), r),
    }, { status: 409 })
  }
  return NextResponse.json({
    ok: true, acceptanceId: r.acceptance_id, amount: r.amount, idempotent: !!r.idempotent,
  })
}
