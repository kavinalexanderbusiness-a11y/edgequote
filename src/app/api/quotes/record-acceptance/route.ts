import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { termsClaimSentence } from '@/lib/payments/termsTimingConflict'
import { termsClaimRefresh, type StoredTermsClaim } from '@/lib/payments/termsClaimRefresh'
import { isAcceptedOrBeyond } from '@/lib/quoteAcceptance'

/** Money for an owner-facing sentence. Display only — never an authorized figure. */
const money = (n: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(n)

// ── Owner records an acceptance that already happened, off-platform ──────────
//
// THE DEFECT THIS REPAIRS
// S122's acceptance gate refuses to record consent while the stored terms
// classification cannot be trusted — missing, stale, or from an older
// classifier. That is right for the CUSTOMER portal, where a stale verdict means
// we genuinely do not know what the customer is being asked to agree to.
//
// It was wrong here, and it locked an owner out of their own business. The
// invalidation trigger nulls the verdict the moment terms_text changes, and only
// the Settings save rewrites it — so an owner who edited their terms by any
// other route (or before this app version deployed) was left permanently
// unable to record a real customer's real acceptance. In the live case that
// prompted this fix, the owner had just EDITED THEIR TERMS TO REMOVE the
// contradiction we asked them to fix; the classifier's verdict on the new text
// is `no_claim` — no contradiction at all — and they were still refused.
//
// ⛔ THIS IS NOT A BYPASS. The database gate is untouched and still runs. All
// this route does is make the stored verdict CURRENT before asking, using the
// one canonical classifier — the same call the Settings save and the send gate
// make. A genuine contradiction is still refused, by the same code, with the
// same words. `ambiguous` is still refused.
//
// ⛔ Owner-authenticated only. The classification is written for the CALLER'S
// OWN tenant (auth.uid()), under RLS, and this route is not reachable by anon.
// The portal path is deliberately NOT given this self-heal: a customer must
// never be able to trigger a reclassification of the business's terms as a side
// effect of trying to accept. See verify:owner-external-acceptance.
//
// ⛔ terms_text is READ here and never written. The owner's words are theirs.

export const dynamic = 'force-dynamic'

type Body = {
  quoteId?: string
  reason?: string
  optionId?: string | null
  addonIds?: string[] | null
  note?: string | null
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  let body: Body
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'Bad request.' }, { status: 400 }) }
  const quoteId = (body.quoteId || '').trim()
  const reason = (body.reason || '').trim()
  if (!quoteId || !reason) {
    return NextResponse.json({ ok: false, error: 'A quote and how they accepted are both required.' }, { status: 400 })
  }

  // ── 1 · Make the stored verdict current, if it is not ─────────────────────
  // Read the terms as they stand RIGHT NOW. A failed read is not "no terms": it
  // must not silently become a classification of the empty string, which would
  // write `no_claim` over a tenant whose terms we could not see.
  const { data: bs, error: bsErr } = await supabase.from('business_settings')
    .select('terms_text, terms_payment_claim, terms_payment_claim_fingerprint, terms_payment_claim_version')
    .eq('user_id', user.id).maybeSingle()
  if (bsErr) {
    return NextResponse.json({ ok: false, error: 'Could not read your Terms & Conditions — try again.' }, { status: 502 })
  }

  const row = bs as StoredTermsClaim | null

  // ⭐ THE decision, from lib/payments/termsClaimRefresh — the same function the
  // guard exercises, so the test can never pass against a re-implementation of
  // what this route is supposed to do.
  const { claim, stale, patch } = termsClaimRefresh(row)
  const termsText = row?.terms_text ?? null

  let reclassified = false
  if (row != null && stale) {
    // ⛔ `patch` is the three classification columns and nothing else, by
    // construction — terms_text cannot travel through this write.
    const { error: upErr } = await supabase.from('business_settings')
      .update(patch).eq('user_id', user.id)
    if (upErr) {
      return NextResponse.json({ ok: false, error: 'Could not review your Terms & Conditions — try again.' }, { status: 502 })
    }
    reclassified = true
  }

  // `ambiguous` is refused BEFORE the RPC purely so the owner gets a sentence
  // they can act on. The database would refuse it anyway — this is the
  // explanation, not the enforcement.
  if (claim === 'ambiguous') {
    const sentence = termsClaimSentence(termsText)
    return NextResponse.json({
      ok: false, claim, reclassified,
      error: 'Your Terms & Conditions both require a deposit and say none is required, so we cannot tell what this customer agreed to. Edit your terms in Settings so they say one or the other, then record this acceptance again.',
      sentence,
    }, { status: 409 })
  }

  // ── 1b · ⭐⭐ THE MATERIAL-REVISION GUARD ──────────────────────────────────
  // A quote can arrive here already flagged accepted, with NO evidence row, and
  // an `accepted_price` from some earlier state that no longer matches the
  // document. EPS-2026-0152 is exactly that shape live: status accepted,
  // accepted_price 1400, current total 500, zero acceptances.
  //
  // ⛔ The owner clicking "they replied by text" must NOT mint evidence there.
  // Their attestation is about a conversation, not about which VERSION of the
  // document the customer had in front of them — and the record cannot tell us,
  // because there is no record. Writing an acceptance would manufacture consent
  // to the CURRENT $500 document out of a click and a stale number.
  //
  // ⛔ We do not reconstruct consent from accepted_price, and we do not invent a
  // timestamp or a version. We stop and ask a human.
  const { data: qrow, error: qErr } = await supabase.from('quotes')
    .select('status, total, accepted_price')
    .eq('id', quoteId).eq('user_id', user.id).maybeSingle()
  if (qErr) {
    return NextResponse.json({ ok: false, error: 'Could not read that quote — try again.' }, { status: 502 })
  }
  if (qrow) {
    const qq = qrow as { status: string; total: number | null; accepted_price: number | null }
    const { count, error: cErr } = await supabase.from('quote_acceptances')
      .select('id', { count: 'exact', head: true }).eq('quote_id', quoteId)
    // A failed COUNT is not "no evidence" — that answer is what lets this guard
    // be skipped exactly when it matters. Refuse instead of guessing.
    if (cErr) {
      return NextResponse.json({ ok: false, error: 'Could not check this quote’s acceptance history — try again.' }, { status: 502 })
    }
    const priorAmount = Number(qq.accepted_price)
    const currentAmount = Number(qq.total)
    const drifted = Number.isFinite(priorAmount) && priorAmount > 0
      && Number.isFinite(currentAmount) && Math.abs(priorAmount - currentAmount) > 0.005
    if (isAcceptedOrBeyond(qq.status) && (count ?? 0) === 0 && drifted) {
      // ⭐ A refusal, but not a dead end. The owner may genuinely know the
      // customer accepted THIS version — so we hand back exactly what an
      // explicit attestation needs to name: both figures, and the fingerprint of
      // the version being confirmed. The confirmation itself goes through
      // ../confirm-current-acceptance, which re-checks every one of these
      // server-side; nothing here is trusted on the way back in.
      const { data: fp } = await supabase.rpc('quote_material_fingerprint', { p_quote_id: quoteId })
      return NextResponse.json({
        ok: false, claim, reclassified, repairRequired: true,
        priorAmount, currentAmount, currentFingerprint: fp ?? null,
        error: 'This quote changed after acceptance was marked. We don’t have durable evidence of which version the customer accepted, '
          + `so we can’t record their acceptance of the current ${money(currentAmount)} document from a prior ${money(priorAmount)} figure.`,
      }, { status: 409 })
    }
  }

  // ── 2 · The normal, unchanged gate ────────────────────────────────────────
  // Same RPC the dialog always called. It runs quote_record_acceptance, which
  // still performs every S122 check against the (now current) verdict, and every
  // S121 evidence rule. If the terms genuinely contradict this quote's payment
  // schedule, this refuses — exactly as before.
  const { data: acceptanceId, error: rpcErr } = await supabase.rpc('owner_record_customer_acceptance', {
    p_quote_id: quoteId,
    p_reason: reason,
    ...(body.optionId ? { p_option_id: body.optionId } : {}),
    ...(body.addonIds?.length ? { p_addon_ids: body.addonIds } : {}),
    ...(body.note?.trim() ? { p_note: body.note.trim() } : {}),
  })

  if (rpcErr) {
    return NextResponse.json({ ok: false, claim, reclassified, error: rpcErr.message }, { status: 409 })
  }
  // ⚠️ A null id is a REFUSAL, not a quiet success — the RPC returns the new
  // acceptance's id, so "no id" means nothing was recorded. Reporting that as
  // done is how an owner comes to believe a deal is on the record when it is not.
  if (!acceptanceId) {
    return NextResponse.json({
      ok: false, claim, reclassified,
      error: 'Could not record that acceptance — the quote may already be accepted, or it may need to be sent again first.',
    }, { status: 409 })
  }

  return NextResponse.json({ ok: true, acceptanceId, claim, reclassified })
}
