// ── Send-outcome summariser ─────────────────────────────────────────────────
// Turn the /api/comms/send response into ONE human line. Shared by every send
// surface (SendMessageDialog, JobMessages) so the outcome wording is identical
// wherever a message is sent from.

export interface SendOutcome { ok: boolean; text: string }

export function summarizeSendOutcome(data: { results?: Record<string, { sent?: boolean; reason?: string; error?: string }> }): SendOutcome {
  const r = data.results || {}
  const label = (ch: string) => ch === 'sms' ? 'SMS' : ch === 'email' ? 'email' : ch
  const sent = Object.entries(r).filter(([, v]) => v.sent).map(([ch]) => label(ch))
  if (sent.length) return { ok: true, text: `Sent by ${sent.join(' & ')} — saved to the customer's timeline.` }
  const reasons = Object.values(r).map(v => v.reason)
  if (reasons.includes('no-optin')) return { ok: false, text: 'This customer hasn’t opted in — turn on SMS/email on their profile.' }
  if (reasons.includes('disabled')) return { ok: false, text: 'Messaging isn’t set up yet — finish setup in Settings → Messaging.' }
  const err = Object.values(r).find(v => v.error)?.error
  if (err) return { ok: false, text: err }
  return { ok: false, text: 'Nothing sent (no phone/email on file).' }
}
