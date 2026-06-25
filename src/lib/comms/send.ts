// ── Communications send layer ──────────────────────────────────────────────────
// SMS via Twilio, email via Resend. DISABLED by default: every send is a no-op
// that returns { sent:false, reason:'disabled' } until the relevant credentials
// are present in the environment. So nothing can send by accident, and the rest
// of the app (manual buttons, the cron) can be wired now and "just work" the
// moment the keys are added. Server-only — never import into a client component.

export interface SendResult { sent: boolean; reason: 'sent' | 'disabled' | 'error'; id?: string; error?: string }

// Which channels are live (i.e. credentials configured). `push` is the forward-
// looking third channel — wired through the whole pipeline (UI chips, the send
// route, logging) but always reports disabled until a push provider is added, so
// the rest of the app can offer it today without anything actually firing.
export function commsEnabled(): { sms: boolean; email: boolean; push: boolean } {
  return {
    sms: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM),
    email: !!(process.env.RESEND_API_KEY && process.env.RESEND_FROM),
    push: false, // no push provider configured yet — future expansion point
  }
}

// Future push channel. Returns disabled until a provider (e.g. web-push / FCM /
// APNs) is wired in here — the single place push delivery will live.
export async function sendPush(_to: string, _title: string, _body: string): Promise<SendResult> {
  return { sent: false, reason: 'disabled' }
}

// Abort an external request that hangs, so a stalled provider can never block the
// caller (the Stripe webhook, the daily cron, or a manual send). 10s is well above
// Twilio/Resend's normal sub-second latency. On timeout the fetch throws AbortError,
// which the callers' catch blocks turn into a clean "timed out" error.
const COMMS_TIMEOUT_MS = 10_000
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), COMMS_TIMEOUT_MS)
  try { return await fetch(url, { ...init, signal: ctrl.signal }) }
  finally { clearTimeout(t) }
}
// A failed send's error string — names a provider timeout distinctly so logs/usage
// stats can tell a hung connection apart from a provider rejection.
function sendError(provider: string, e: unknown): SendResult {
  const aborted = e instanceof Error && e.name === 'AbortError'
  return { sent: false, reason: 'error', error: aborted ? `${provider} request timed out after ${COMMS_TIMEOUT_MS / 1000}s` : (e instanceof Error ? e.message : `${provider.toLowerCase()} failed`) }
}

export async function sendSms(to: string, body: string): Promise<SendResult> {
  if (!commsEnabled().sms) return { sent: false, reason: 'disabled' }
  if (!to) return { sent: false, reason: 'error', error: 'no recipient' }
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID!
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN!}`).toString('base64')
    const res = await fetchWithTimeout(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
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
    return sendError('Twilio', e)
  }
}

export async function sendEmail(to: string, subject: string, html: string, text: string): Promise<SendResult> {
  if (!commsEnabled().email) return { sent: false, reason: 'disabled' }
  if (!to) return { sent: false, reason: 'error', error: 'no recipient' }
  try {
    const res = await fetchWithTimeout('https://api.resend.com/emails', {
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
    return sendError('Resend', e)
  }
}
