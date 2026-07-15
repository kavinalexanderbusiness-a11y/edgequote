import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { sendEmail, commsEnabled } from '@/lib/comms/send'
import { renderMessage } from '@/lib/comms/templates'
import { dispatchToCustomer } from '@/lib/comms/dispatch'
import { logDispatch } from '@/lib/comms/log'

export const dynamic = 'force-dynamic'

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c))

// Two sends for one online booking:
//   1. the owner alert (a new lead landed), and
//   2. the CUSTOMER confirmation — the thing that makes this feel like a real business.
//
// Until (2) existed the only send here went to the owner's inbox, so a homeowner who
// closed the tab was left with nothing to prove they'd booked. Both are best-effort and
// this route always 200s: submit_booking already created the quote + service_request, so
// a failed email must never look like a failed booking.
//
// ⚠️ SECURITY — why the confirmation reads the database instead of the request body.
// This endpoint is PUBLIC: its only gate is the booking token, which is visible in the
// /book/<token> URL. It used to send SMS to `body.phone` because `body.smsConsent === true`
// — both supplied by the caller — with `body.address` interpolated into the message. That
// made it an open, branded SMS relay: anyone could text arbitrary strangers from the
// owner's number, with attacker-controlled content, and nothing was written to
// notification_log so the owner could never see it. The victim had no customers row, so
// even STOP could not reach them.
//
// Now: the caller supplies a quote id, we resolve the REAL customer that submit_booking
// created for it (verifying the quote belongs to this token's business), and send through
// dispatchToCustomer — the one send path, which honours consent and writes the audit
// trail. A consent boolean never arrives over the wire again. booking_received is
// msgCategory `null` (transactional), so a genuine confirmation is still delivered.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const token = String(body.token || '')
  if (!token) return NextResponse.json({ ok: false })
  const enabled = commsEnabled()
  if (!enabled.email && !enabled.sms) return NextResponse.json({ ok: true, skipped: 'comms disabled' })

  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  const { data } = await anon.rpc('get_booking_business', { p_token: token })
  const biz = data as {
    email_primary?: string | null; company_name?: string | null
    phone?: string | null; logo_url?: string | null; website?: string | null
  } | null
  if (!biz) return NextResponse.json({ ok: true, skipped: 'invalid token' })

  const service = esc(body.service || 'Lawn Mowing')
  const out: Record<string, boolean> = {}

  // ── 1. Owner alert ──────────────────────────────────────────────────────────
  if (enabled.email && biz.email_primary) {
    const name = esc(body.name), address = esc(body.address), cadence = esc(body.cadence), quote = esc(body.quoteNumber)
    const html = `<p>🌱 You have a new online booking.</p><ul><li><b>Service:</b> ${service}</li><li><b>Name:</b> ${name}</li><li><b>Address:</b> ${address}</li><li><b>Plan:</b> ${cadence}</li><li><b>Quote:</b> ${quote}</li></ul><p>It's saved as a new <b>sent</b> quote — review it in Quotes, confirm the price, and schedule the first visit.</p>`
    const text = `New online booking\nService: ${body.service || 'Lawn Mowing'}\nName: ${body.name}\nAddress: ${body.address}\nPlan: ${body.cadence}\nQuote: ${body.quoteNumber}\nReview it in Quotes.`
    const r = await sendEmail(biz.email_primary, `🌱 New online booking — ${body.name || 'customer'} · ${body.service || 'Lawn Mowing'}`, html, text)
    out.owner = !!r.sent
  }

  // ── 2. Customer confirmation ────────────────────────────────────────────────
  // Resolved from the quote, never from the request body. See the security note above.
  const quoteId = String(body.quoteId || '').trim()
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (quoteId && svc) {
    const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, svc)
    // Scope the quote to THIS token's business, so a valid token can't be used to
    // trigger a confirmation against some other owner's customer.
    const { data: bizRow } = await admin.from('business_settings')
      .select('user_id').eq('booking_token', token).eq('booking_enabled', true).maybeSingle()
    const userId = (bizRow as { user_id: string } | null)?.user_id
    const { data: qRow } = userId
      ? await admin.from('quotes').select('id, user_id, customer_id, quote_number')
          .eq('id', quoteId).eq('user_id', userId).maybeSingle()
      : { data: null }
    const quote = qRow as { customer_id: string | null; quote_number: string | null } | null

    if (quote?.customer_id) {
      const { data: cRow } = await admin.from('customers')
        .select('id, name, phone, email, sms_opt_in, email_opt_in, message_prefs')
        .eq('id', quote.customer_id).eq('user_id', userId!).maybeSingle()
      const cust = cRow as {
        id: string; name: string | null; phone: string | null; email: string | null
        sms_opt_in: boolean; email_opt_in: boolean; message_prefs: Record<string, boolean> | null
      } | null

      if (cust) {
        // Rendered through the SAME template engine every other message uses, so it lands
        // in the branded shell with the business logo and contact footer.
        const msg = renderMessage('booking_received', null, {
          firstName: cust.name || '',
          businessName: biz.company_name || 'your service provider',
          address: String(body.address || ''),
          confirmationNumber: quote.quote_number || '',
          directPhone: biz.phone || '',
          logoUrl: biz.logo_url || '',
          website: biz.website || '',
        })
        // The ONE send path: consent-gated, threaded into the customer's conversation,
        // and logged — so the owner can see the confirmation that went out.
        const res = await dispatchToCustomer(admin, {
          userId: userId!,
          customer: cust,
          channels: ['sms', 'email'],
          smsText: msg.sms, emailSubject: msg.subject, emailHtml: msg.html, emailText: msg.text,
          template: 'booking_received',
          meta: { source: 'booking', quote_id: quoteId },
        })
        await logDispatch(admin, res, { userId: userId!, customerId: cust.id, template: 'booking_received' })
        out.customerSms = res.sentChannels.includes('sms')
        out.customerEmail = res.sentChannels.includes('email')
      }
    }
  }

  return NextResponse.json({ ok: true, sent: out })
}
