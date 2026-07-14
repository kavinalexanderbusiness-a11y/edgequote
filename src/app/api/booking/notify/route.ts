import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { sendEmail, commsEnabled } from '@/lib/comms/send'

export const dynamic = 'force-dynamic'

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c))

// Best-effort owner alert for a new online booking. No-op (still 200) when email
// isn't configured — the booking already created a quote + service_request, so a
// failed email never loses the lead.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const token = String(body.token || '')
  if (!token) return NextResponse.json({ ok: false })
  if (!commsEnabled().email) return NextResponse.json({ ok: true, skipped: 'email disabled' })

  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  const { data } = await anon.rpc('get_booking_business', { p_token: token })
  const biz = data as { email_primary?: string | null; company_name?: string | null } | null
  if (!biz?.email_primary) return NextResponse.json({ ok: true, skipped: 'no owner email' })

  const name = esc(body.name), address = esc(body.address), cadence = esc(body.cadence), quote = esc(body.quoteNumber)
  const service = esc(body.service || 'Lawn Mowing')
  const html = `<p>🌱 You have a new online booking.</p><ul><li><b>Service:</b> ${service}</li><li><b>Name:</b> ${name}</li><li><b>Address:</b> ${address}</li><li><b>Plan:</b> ${cadence}</li><li><b>Quote:</b> ${quote}</li></ul><p>It's saved as a new <b>sent</b> quote — review it in Quotes, confirm the price, and schedule the first visit.</p>`
  const text = `New online booking\nService: ${body.service || 'Lawn Mowing'}\nName: ${body.name}\nAddress: ${body.address}\nPlan: ${body.cadence}\nQuote: ${body.quoteNumber}\nReview it in Quotes.`
  await sendEmail(biz.email_primary, `🌱 New online booking — ${body.name || 'customer'} · ${body.service || 'Lawn Mowing'}`, html, text)
  return NextResponse.json({ ok: true })
}
