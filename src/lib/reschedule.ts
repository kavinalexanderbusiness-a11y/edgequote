import { format, parseISO } from 'date-fns'
import { DisruptionReason, DISRUPTION_META } from '@/lib/disruption'
import { newClientMessageId } from '@/lib/comms/idempotency'

// ── Reschedule notification (foundation) ─────────────────────────────────────────
// When jobs are moved — rain delay, equipment, absence, holiday or emergency —
// notify affected customers of the new date. REUSES the existing comms pipeline
// (/api/comms/send) — opt-in gated, logged into the customer timeline + message
// center, portal-link aware, and disabled-safe until Twilio/Resend creds exist. No
// new sender, no scheduler. The reason picks the right template (weather → the
// rain-delay copy; everything else → "rescheduled") via DISRUPTION_META.

export interface RescheduleNotice {
  customerId: string
  toDate: string                 // yyyy-MM-dd — the new visit date
  fromDate?: string              // yyyy-MM-dd — the original date (for "{{old_date}}")
  reason?: DisruptionReason      // default 'weather'
  jobId?: string | null
  channels?: ('sms' | 'email')[] // default both
}

export interface NotifyResult { customerId: string; ok: boolean; error?: string }

export async function notifyReschedule(n: RescheduleNotice): Promise<NotifyResult> {
  try {
    const fmt = (iso: string) => format(parseISO(iso + 'T00:00:00'), 'EEEE, MMM d')
    const template = DISRUPTION_META[n.reason ?? 'weather'].template
    const res = await fetch('/api/comms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: n.customerId, template, jobId: n.jobId ?? null,
        channels: n.channels ?? ['sms', 'email'],
        vars: { dateLabel: fmt(n.toDate), oldDateLabel: n.fromDate ? fmt(n.fromDate) : undefined },
        clientMessageId: newClientMessageId(), // one id per notice → a re-fire can't double-send
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return { customerId: n.customerId, ok: false, error: json.error || `HTTP ${res.status}` }
    return { customerId: n.customerId, ok: true }
  } catch (e) {
    return { customerId: n.customerId, ok: false, error: e instanceof Error ? e.message : 'failed' }
  }
}

// Notify a whole set of moved customers (e.g. "move all of Thursday"). Sequential
// to stay gentle on the comms provider; each is independently opt-in gated.
export async function notifyRescheduleBatch(notices: RescheduleNotice[]): Promise<NotifyResult[]> {
  const out: NotifyResult[] = []
  for (const n of notices) out.push(await notifyReschedule(n))
  return out
}