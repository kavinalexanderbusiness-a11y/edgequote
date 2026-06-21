// ── Communications send layer ──────────────────────────────────────────────────
// SMS via Twilio, email via Resend. DISABLED by default: every send is a no-op
// that returns { sent:false, reason:'disabled' } until the relevant credentials
// are present in the environment. So nothing can send by accident, and the rest
// of the app (manual buttons, the cron) can be wired now and "just work" the
// moment the keys are added. Server-only — never import into a client component.

export interface SendResult { sent: boolean; reason: 'sent' | 'disabled' | 'error'; id?: string; error?: string }

// Which channels are live (i.e. credentials configured).
export function commsEnabled(): { sms: boolean; email: boolean } {
  return {
    sms: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM),
    email: !!(process.env.RESEND_API_KEY && process.env.RESEND_FROM),
  }
}

export async function sendSms(to: string, body: string): Promise<SendResult> {
  if (!commsEnabled().sms) return { sent: false, reason: 'disabled' }
  if (!to) return { sent: false, reason: 'error', error: 'no recipient' }
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID!
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN!}`).toString('base64')
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM!, Body: body }),
    })
    if (!res.ok) {
      // Surface Twilio's exact error (e.g. {"code":21211,"message":"Invalid 'To' Number"}).
      const detail = await res.text().catch(() => '')
      let msg = `Twilio ${res.status}`
      try { const j = JSON.parse(detail); if (j?.message) msg = `Twilio ${res.status} (code ${j.code ?? '?'}): ${j.message}` } catch { if (detail) msg += `: ${detail.slice(0, 300)}` }
      return { sent: false, reason: 'error', error: msg }
    }
    const data = await res.json()
    return { sent: true, reason: 'sent', id: data.sid }
  } catch (e) {
    return { sent: false, reason: 'error', error: e instanceof Error ? e.message : 'sms failed' }
  }
}

export async function sendEmail(to: string, subject: string, html: string, text: string): Promise<SendResult> {
  if (!commsEnabled().email) return { sent: false, reason: 'disabled' }
  if (!to) return { sent: false, reason: 'error', error: 'no recipient' }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY!}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.RESEND_FROM!, to, subject, html, text }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      let msg = `Resend ${res.status}`
      try { const j = JSON.parse(detail); if (j?.message) msg = `Resend ${res.status}: ${j.message}` } catch { if (detail) msg += `: ${detail.slice(0, 300)}` }
      return { sent: false, reason: 'error', error: msg }
    }
    const data = await res.json()
    return { sent: true, reason: 'sent', id: data.id }
  } catch (e) {
    return { sent: false, reason: 'error', error: e instanceof Error ? e.message : 'email failed' }
  }
}
