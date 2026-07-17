import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { commsEnabled, sendSms, sendEmail } from '@/lib/comms/send'

// Communications self-test. Owner-only. NEVER touches customers — the POST sends
// ONLY to the number/email typed into the Settings test page.
//   GET  → diagnostics: which env vars are detected, whether the provider creds
//          validate, and what the scheduled senders ACTUALLY did in the last 48h.
//   POST → send a single test message to a manually-entered recipient.
//
// The credential checks answer "could we send?". They cannot answer "did last
// night's sends go out?" — a cron that dies on a bad query looks identical from
// here. recentSends answers that from the audit log itself, through the caller's
// own session (RLS scopes it to their rows — this is an owner diagnostic, not a
// cron, so it must not hold the service key).

const WINDOW_HOURS = 48
// Bounds the scan. Ordered newest-first, so the per-template timestamps stay
// correct even when a very busy 48h is cut off here.
const MAX_LOG_ROWS = 2000

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

  // Validate the Resend key WITHOUT sending — list domains. Resend has no dedicated
  // "verify key" endpoint, but it distinguishes an unknown key from a real one that
  // is merely restricted to sending, which is exactly the question here: a
  // `restricted_api_key` error means the key AUTHENTICATED and is fine to send with.
  let resendCreds: { valid: boolean; detail: string } | null = null
  if (vars.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY!}` } })
      const j = await res.json().catch(() => ({}))
      if (res.ok) {
        const verified = Array.isArray(j?.data) ? j.data.filter((d: { status?: string }) => d.status === 'verified').map((d: { name?: string }) => d.name) : []
        resendCreds = { valid: true, detail: verified.length ? `Key valid — verified domain(s): ${verified.join(', ')}` : 'Key valid — but NO verified sending domain, so email will be rejected.' }
      } else if (j?.name === 'restricted_api_key') {
        resendCreds = { valid: true, detail: 'Key valid (sending-only key — cannot list domains, which is fine).' }
      } else {
        resendCreds = { valid: false, detail: `Resend rejected the key — ${res.status}${j?.message ? `: ${j.message}` : ''}` }
      }
    } catch (e) {
      resendCreds = { valid: false, detail: e instanceof Error ? e.message : 'request failed' }
    }
  }

  // What actually went out. Ordered newest-first so the first row seen for a
  // template IS its most recent one.
  const since = new Date(Date.now() - WINDOW_HOURS * 3600_000).toISOString()
  const { data: logRows, error: logErr } = await supabase.from('notification_log')
    .select('status, template, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(MAX_LOG_ROWS)
  const rows = (logRows as { status: string; template: string; created_at: string }[] | null) || []
  const byStatus: Record<string, number> = {}
  const lastByTemplate: Record<string, string> = {}
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1
    if (!lastByTemplate[r.template]) lastByTemplate[r.template] = r.created_at
  }
  const recentSends = logErr
    // Say it plainly rather than reporting an empty log — "nothing sent" and "we
    // couldn't look" are the two answers this endpoint exists to tell apart.
    ? { windowHours: WINDOW_HOURS, error: logErr.message }
    : {
        windowHours: WINDOW_HOURS,
        total: rows.length,
        byStatus,
        lastByTemplate,
        lastSendAt: rows[0]?.created_at ?? null,
        truncated: rows.length >= MAX_LOG_ROWS,
      }

  return NextResponse.json({
    enabled,
    vars,
    twilioFrom: mask(process.env.TWILIO_FROM),
    resendFrom: process.env.RESEND_FROM || null,
    twilioCreds,
    resendCreds,
    recentSends,
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
