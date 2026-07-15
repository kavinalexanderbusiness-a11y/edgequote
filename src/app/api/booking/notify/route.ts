import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { sendEmail, sendSms, commsEnabled } from '@/lib/comms/send'
import { renderMessage } from '@/lib/comms/templates'

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
  // Rendered through the SAME template engine every other message uses, so it lands in
  // the branded shell with the business logo and contact footer — not a bespoke one-off.
  const custEmail = String(body.email || '').trim()
  const custPhone = String(body.phone || '').trim()
  if (custEmail || custPhone) {
    const msg = renderMessage('booking_received', null, {
      firstName: String(body.name || ''),
      businessName: biz.company_name || 'your service provider',
      address: String(body.address || ''),
      confirmationNumber: String(body.quoteNumber || ''),
      directPhone: biz.phone || '',
      logoUrl: biz.logo_url || '',
      website: biz.website || '',
    })
    // Email is the durable copy (it survives a closed tab); SMS only when they gave a
    // phone AND ticked consent on the form — a confirmation must never be the thing that
    // texts someone who didn't ask to be texted.
    if (enabled.email && custEmail) {
      const r = await sendEmail(custEmail, msg.subject, msg.html, msg.text)
      out.customerEmail = !!r.sent
    }
    if (enabled.sms && custPhone && body.smsConsent === true) {
      const r = await sendSms(custPhone, msg.sms)
      out.customerSms = !!r.sent
    }
  }

  return NextResponse.json({ ok: true, sent: out })
}
