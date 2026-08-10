import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { sendEmail, commsEnabled } from '@/lib/comms/send'
import { renderMessage } from '@/lib/comms/templates'
import { dispatchToCustomer } from '@/lib/comms/dispatch'
import { logDispatch, logSend } from '@/lib/comms/log'

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
// The owner alert is one-per-booking, so an hourly ceiling only ever bites on
// abuse. Counted per BUSINESS over notification_log, the same window shape
// /api/public/portal-access uses.
const OWNER_ALERT_HOURLY = 20
/** notification_log.template for the owner's "new booking" alert. Also the
 *  dedupe key, with the quote id in `detail`. */
const OWNER_ALERT_TEMPLATE = 'booking_alert'

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

  const out: Record<string, boolean> = {}

  // Both sends now need the quote, so resolve it ONCE, scoped to this token's
  // business. Without a service key nothing below can be verified, and an
  // unverifiable send is exactly what this route used to do.
  const quoteId = String(body.quoteId || '').trim()
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!quoteId || !svc) return NextResponse.json({ ok: true, skipped: 'no verifiable booking' })

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, svc)
  // Scope the quote to THIS token's business, so a valid token can't be used to
  // trigger a send against some other owner's customer.
  const { data: bizRow } = await admin.from('business_settings')
    .select('user_id').eq('booking_token', token).eq('booking_enabled', true).maybeSingle()
  const userId = (bizRow as { user_id: string } | null)?.user_id
  const { data: qRow } = userId
    ? await admin.from('quotes')
        .select('id, user_id, customer_id, quote_number, service_type, address, created_at')
        .eq('id', quoteId).eq('user_id', userId).maybeSingle()
    : { data: null }
  const quote = qRow as {
    customer_id: string | null; quote_number: string | null
    service_type: string | null; address: string | null; created_at: string
  } | null
  if (!userId || !quote) return NextResponse.json({ ok: true, skipped: 'no such booking' })

  // ── 1. Owner alert ──────────────────────────────────────────────────────────
  // ⚠️ SECURITY — this block used to be the hole the note above describes, one
  // level up. It needed no quoteId at all: the ONLY gate was the booking token,
  // which is public by construction (it is the /book/<token> URL a business
  // publishes on its own website), and every word of the email — including the
  // SUBJECT LINE — came from the request body. So anyone could POST in a loop and
  // send a business owner unlimited messages that they wrote, from this app's own
  // sending domain, wearing the exact template that owner is trained to act on.
  // Nothing was written to notification_log either, so the owner had no record
  // that any of it happened.
  //
  // Now it is the same shape as the customer confirmation below: the caller may
  // name a quote id and nothing else, and every value in the email is read back
  // out of the quote/customer rows that submit_booking actually persisted. Two
  // further limits make the send un-amplifiable:
  //   • ONE alert per quote, ever (deduped on notification_log), so a replayed
  //     request is a no-op rather than a second email; and
  //   • an hourly ceiling per business, so even a flood of genuine bookings
  //     cannot be turned into a mail bomb.
  // The alert is also LOGGED now, which it never was — the owner can see it.
  if (enabled.email && biz.email_primary) {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const [{ data: already }, { count: recent }] = await Promise.all([
      admin.from('notification_log').select('id')
        .eq('user_id', userId).eq('template', OWNER_ALERT_TEMPLATE).eq('detail', quoteId).limit(1),
      admin.from('notification_log').select('id', { count: 'exact', head: true })
        .eq('user_id', userId).eq('template', OWNER_ALERT_TEMPLATE).gt('created_at', since),
    ])
    if (already && already.length > 0) {
      out.owner = false   // already alerted for this booking — replay is a no-op
    } else if ((recent ?? 0) >= OWNER_ALERT_HOURLY) {
      out.owner = false
      await logSend(admin, {
        userId, customerId: quote.customer_id, channel: 'email', template: OWNER_ALERT_TEMPLATE,
        status: 'skipped', detail: quoteId,
      })
    } else {
      // Every field below comes from a row this business owns. The request body
      // contributes nothing but the quote id.
      let customerName: string | null = null
      if (quote.customer_id) {
        const { data: c } = await admin.from('customers')
          .select('name').eq('id', quote.customer_id).eq('user_id', userId).maybeSingle()
        customerName = (c as { name: string | null } | null)?.name ?? null
      }
      const serviceRaw = quote.service_type || 'Service'
      const nameRaw = customerName || 'New customer'
      const addressRaw = quote.address || '—'
      const quoteNumRaw = quote.quote_number || '—'
      const html = `<p>🔔 You have a new online booking.</p><ul><li><b>Service:</b> ${esc(serviceRaw)}</li><li><b>Name:</b> ${esc(nameRaw)}</li><li><b>Address:</b> ${esc(addressRaw)}</li><li><b>Quote:</b> ${esc(quoteNumRaw)}</li></ul><p>It's saved as a new <b>sent</b> quote — review it in Quotes, confirm the price, and schedule the first visit.</p>`
      const text = `New online booking\nService: ${serviceRaw}\nName: ${nameRaw}\nAddress: ${addressRaw}\nQuote: ${quoteNumRaw}\nReview it in Quotes.`
      const r = await sendEmail(biz.email_primary, `🔔 New online booking — ${nameRaw} · ${serviceRaw}`, html, text)
      out.owner = !!r.sent
      // Logged whether it sent or not: the dedupe above reads this row, so a
      // failed send must still spend the booking's one slot rather than leaving
      // a retry loop open.
      await logSend(admin, {
        userId, customerId: quote.customer_id, channel: 'email', template: OWNER_ALERT_TEMPLATE,
        status: r.sent ? 'sent' : 'error', detail: quoteId,
        provider: r.sent ? 'resend' : null, providerId: r.sent ? (r.id ?? null) : null,
      })
    }
  }

  // ── 2. Customer confirmation ────────────────────────────────────────────────
  // Resolved from the quote, never from the request body. See the security note above.
  {
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
          // From the QUOTE, not the body. This was the last caller-controlled
          // string left in the route, and it was the worst-placed one: it went
          // into a message delivered to a real customer over the business's own
          // number, so a crafted request could put arbitrary words in front of
          // someone else's customer under that business's name.
          address: quote.address || '',
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
