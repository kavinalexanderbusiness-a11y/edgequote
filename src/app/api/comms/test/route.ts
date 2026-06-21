import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { commsEnabled, sendSms, sendEmail } from '@/lib/comms/send'

// Communications self-test. Owner-only. NEVER touches customers — the POST sends
// ONLY to the number/email typed into the Settings test page.
//   GET  → diagnostics: which env vars are detected + whether Twilio creds validate.
//   POST → send a single test message to a manually-entered recipient.

function mask(s: string | undefined): string | null {
  if (!s) return null
  return s.length <= 4 ? '••' : `${s.slice(0, 2)}••••${s.slice(-2)}`
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const vars = {
    TWILIO_ACCOUNT_SID: !!process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: !!process.env.TWILIO_AUTH_TOKEN,
    TWILIO_FROM: !!process.env.TWILIO_FROM,
    RESEND_API_KEY: !!process.env.RESEND_API_KEY,
    RESEND_FROM: !!process.env.RESEND_FROM,
  }
  const enabled = commsEnabled()

  // Validate Twilio credentials WITHOUT sending — fetch the account resource.
  let twilioCreds: { valid: boolean; detail: string } | null = null
  if (vars.TWILIO_ACCOUNT_SID && vars.TWILIO_AUTH_TOKEN) {
    try {
      const sid = process.env.TWILIO_ACCOUNT_SID!
      const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN!}`).toString('base64')
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, { headers: { Authorization: `Basic ${auth}` } })
      if (res.ok) {
        const j = await res.json().catch(() => ({}))
        twilioCreds = { valid: true, detail: `Account "${j.friendly_name ?? sid}" — status ${j.status ?? 'active'}` }
      } else {
        const t = await res.text().catch(() => '')
        let msg = `${res.status}`
        try { const j = JSON.parse(t); if (j?.message) msg = `${res.status} (code ${j.code ?? '?'}): ${j.message}` } catch { if (t) msg += `: ${t.slice(0, 200)}` }
        twilioCreds = { valid: false, detail: `Twilio rejected the credentials — ${msg}` }
      }
    } catch (e) {
      twilioCreds = { valid: false, detail: e instanceof Error ? e.message : 'request failed' }
    }
  }

  return NextResponse.json({
    enabled,
    vars,
    twilioFrom: mask(process.env.TWILIO_FROM),
    resendFrom: process.env.RESEND_FROM || null,
    twilioCreds,
    appUrl: process.env.NEXT_PUBLIC_APP_URL || null,
  })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const to = String(body.to || '').trim()
  const channel = body.channel === 'email' ? 'email' : 'sms'
  if (!to) return NextResponse.json({ error: 'Enter a recipient.' }, { status: 400 })

  const enabled = commsEnabled()
  if (channel === 'sms' && !enabled.sms) {
    return NextResponse.json({ sent: false, reason: 'disabled', error: 'SMS is disabled — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM.' })
  }
  if (channel === 'email' && !enabled.email) {
    return NextResponse.json({ sent: false, reason: 'disabled', error: 'Email is disabled — set RESEND_API_KEY and RESEND_FROM.' })
  }

  const stamp = new Date().toISOString().slice(11, 16)
  const result = channel === 'sms'
    ? await sendSms(to, `✅ EdgeQuote test SMS (${stamp}). Your Twilio setup is working.`)
    : await sendEmail(to, 'EdgeQuote test email ✅', '<p>✅ Your Resend setup is working.</p>', '✅ Your Resend setup is working.')

  return NextResponse.json({ channel, ...result })
}
