import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { serviceClient } from '@/lib/cron/guard'
import { commsEnabled, sendEmail } from '@/lib/comms/send'
import { ensurePortalToken, portalUrl } from '@/lib/portal'
import { NEUTRAL_RESULT, normalizeEmail, portalAccessEmail, type PortalLink } from '@/lib/portalAccess'
import { appOrigin, cleanOrigin } from '@/lib/appOrigin'

export const dynamic = 'force-dynamic'

// POST /api/public/portal-access   { email }
//
// "Email me my portal link." The public recovery path for a customer who lost the
// link their provider texted them. No password, no signup, no account — the link
// IS the credential, exactly as it already was.
//
// ── THE SECURITY CONTRACT ────────────────────────────────────────────────────
// 1. The response is byte-identical for a known and an unknown address. There is
//    one success shape (NEUTRAL_RESULT) and it is returned whether we matched
//    nobody, matched one customer, or matched several. Every other status this
//    route can return (400/429/503) is decided BEFORE any lookup happens, so no
//    status code can be used as an oracle either.
// 2. A portal token is never in the response. It goes into the email and nowhere
//    else — not the body, not a header, not a redirect.
// 3. Nothing identifying is logged. Failures log a reason and a counter; never
//    the address, never the token, never a customer id.
// 4. Rate limits count EVERY attempt, matched or not — an enumeration sweep is
//    made of misses, so limiting only the hits would leave the door open.
// 5. A REVOKED portal is not resurrected. ensurePortalToken would happily mint a
//    fresh token for a customer whose access was deliberately withdrawn; this
//    route checks for that first and skips them.
//
// CORS is open because the marketing site posts here directly.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}
export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }) }

// Per-address, per hour: enough for a real person who mistypes and retries, few
// enough that an inbox can't be flooded.
const PER_EMAIL_HOURLY = 4
// Everyone, per hour. A human recovering a link is rare; a sweep is not.
const GLOBAL_HOURLY = 60

const ok = () => NextResponse.json({ ok: true, message: NEUTRAL_RESULT }, { headers: CORS })

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  const email = normalizeEmail(body?.email)
  // Match-independent: a malformed address is rejected without touching the
  // database, so this branch reveals nothing about who exists.
  if (!email) {
    return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400, headers: CORS })
  }

  // Also match-independent. Failing CLOSED here is deliberate: answering with the
  // neutral success while no email can possibly be sent would be the one lie this
  // endpoint must not tell.
  const sb = serviceClient()
  if (!sb || !commsEnabled().email) {
    console.error('[portal-access] unavailable:', !sb ? 'no service-role key' : 'email provider not configured')
    return NextResponse.json(
      { error: 'We can’t send portal links right now. Please try again shortly.' },
      { status: 503, headers: CORS },
    )
  }

  // The rate-limit bucket. A hash, never the address — see the migration's note.
  const emailKey = createHash('sha256').update(email).digest('hex')
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()

  const [{ count: perEmail }, { count: global }] = await Promise.all([
    sb.from('portal_access_requests').select('id', { count: 'exact', head: true })
      .eq('email_key', emailKey).gt('created_at', since),
    sb.from('portal_access_requests').select('id', { count: 'exact', head: true })
      .gt('created_at', since),
  ])
  if ((perEmail ?? 0) >= PER_EMAIL_HOURLY || (global ?? 0) >= GLOBAL_HOURLY) {
    // Counted over attempts, not matches, so this fires the same way for an
    // address that exists and one that doesn't.
    return NextResponse.json(
      { error: 'Too many requests. Please wait a few minutes and try again.' },
      { status: 429, headers: CORS },
    )
  }

  // Record the attempt BEFORE doing the work: a sweep that crashes us mid-lookup
  // must still have spent its slot.
  const { data: attemptRow, error: attemptErr } = await sb
    .from('portal_access_requests').insert({ email_key: emailKey }).select('id').single()
  if (attemptErr) {
    console.error('[portal-access] could not record attempt:', attemptErr.message)
    return NextResponse.json(
      { error: 'We can’t send portal links right now. Please try again shortly.' },
      { status: 503, headers: CORS },
    )
  }
  const attemptId = (attemptRow as { id: string }).id

  // ── The lookup ─────────────────────────────────────────────────────────────
  // Matched on the NORMALISED address at both ends. Archived customers are
  // excluded: the owner removed them, and this endpoint must not be a way back in.
  //
  // SHARED ADDRESSES: every matching customer is collected, not just the first.
  // One address can legitimately be on two records (a couple, a landlord and
  // their tenant, or the same homeowner using two EdgeQuote businesses), and
  // silently picking one would send someone the wrong portal with no way to tell.
  // Isolation is preserved by the token contract, not by this query: each token
  // resolves through get_portal_data to exactly ONE customer, so N links are N
  // separate, separately-scoped portals — never a merged view.
  // Through the definer RPC, not a table filter: PostgREST cannot trim() a column
  // in a filter, so a stored address with padding would silently never match —
  // and this database already holds names like 'Shaune '. The function normalises
  // both sides and is REVOKED from anon/authenticated, so the public anon key
  // cannot be turned into a customer-existence oracle.
  const { data: rows, error: custErr } = await sb.rpc('find_portal_access_customers', { p_email: email })
  if (custErr) {
    console.error('[portal-access] customer lookup failed:', custErr.message)
    return NextResponse.json(
      { error: 'We can’t send portal links right now. Please try again shortly.' },
      { status: 503, headers: CORS },
    )
  }
  const customers = (rows as { customer_id: string; customer_name: string | null; owner_id: string }[]) ?? []

  const origin = cleanOrigin(req.nextUrl?.origin) || appOrigin()
  const links: PortalLink[] = []
  for (const c of customers) {
    // Respect a withdrawn portal. ensurePortalToken only looks for a LIVE token
    // and mints one when it finds none — which would hand a fresh, working link
    // to someone whose access was deliberately revoked.
    const { data: tokens } = await sb
      .from('customer_portal_tokens').select('revoked').eq('customer_id', c.customer_id)
    const rowsT = (tokens as { revoked: boolean }[] | null) ?? []
    if (rowsT.length > 0 && rowsT.every(t => t.revoked)) continue

    const token = await ensurePortalToken(sb, c.owner_id, c.customer_id)
    if (!token) continue
    const { data: biz } = await sb
      .from('business_settings').select('company_name').eq('user_id', c.owner_id).maybeSingle()
    links.push({
      url: portalUrl(token, origin),
      customerName: c.customer_name,
      businessName: (biz as { company_name: string | null } | null)?.company_name ?? null,
    })
  }

  // No match → the neutral answer, and no email. Indistinguishable, by design,
  // from the branch below.
  if (links.length === 0) return ok()

  const msg = portalAccessEmail(links)
  const res = await sendEmail(email, msg.subject, msg.html, msg.text)

  // The truth about the send lives in the ledger, never in the reply. Marking a
  // failed send as `sent` would be the internal lie — the owner would have no way
  // to know a customer asked and got nothing.
  await sb.from('portal_access_requests')
    .update({ matched: true, sent: res.sent })
    .eq('id', attemptId)
  if (!res.sent) {
    // Reason only — no address, no token, no customer id.
    console.error('[portal-access] provider rejected the send:', res.reason, res.error ?? '')
  }

  // Neutral either way. A provider outage must not become the oracle that tells
  // an attacker which addresses are real, and the recipient can simply ask again.
  return ok()
}
