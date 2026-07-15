// ── Automatic payment receipt ──────────────────────────────────────────────────
// Sent from the Stripe webhook (service-role, NO user session) the moment an
// invoice is actually flipped to paid by an AutoPay charge. Reuses the same comms
// primitives as the owner-driven send route (templates + sendSms/sendEmail) and
// threads the receipt into the customer's conversation + notification_log, so it
// shows up everywhere a normal message does. Server-only.
import type { SupabaseClient } from '@supabase/supabase-js'
import { renderMessage } from '@/lib/comms/templates'
import { sendSms, sendEmail, commsEnabled } from '@/lib/comms/send'
import { logSend } from '@/lib/comms/log'
import { getOrCreateConversation } from '@/lib/comms/conversation'
import { SKIP_REASON } from '@/lib/comms/skipReasons'
import { ensurePortalToken, portalUrl } from '@/lib/portal'

function formatAmount(n: number): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(n)
}

// Best-effort: never throws. A receipt that can't send must NOT fail the webhook
// (the payment is already recorded). Respects consent — SMS needs sms_opt_in; email
// is treated as transactional (a receipt for money the customer just paid).
export async function sendPaymentReceipt(
  sb: SupabaseClient,
  opts: { userId: string; customerId: string | null; amount: number; origin: string },
): Promise<void> {
  try {
    if (!opts.customerId) return
    const { data: cust } = await sb.from('customers')
      .select('id, name, phone, email, sms_opt_in').eq('id', opts.customerId).eq('user_id', opts.userId).maybeSingle()
    if (!cust) return
    const c = cust as { id: string; name: string; phone: string | null; email: string | null; sms_opt_in: boolean }

    const { data: bizRow } = await sb.from('business_settings')
      .select('company_name, review_url, message_templates').eq('user_id', opts.userId).maybeSingle()
    const biz = bizRow as { company_name: string | null; review_url: string | null; message_templates: Record<string, string> | null } | null

    const token = await ensurePortalToken(sb, opts.userId, opts.customerId)
    const rendered = renderMessage('receipt', biz?.message_templates, {
      firstName: c.name,
      businessName: biz?.company_name || 'Your service provider',
      amount: formatAmount(opts.amount),
      portalLink: token ? portalUrl(token, opts.origin) : undefined,
      reviewLink: biz?.review_url || undefined,
    })

    // Keep each channel's provider id — a receipt that bounces must be able to say
    // so, rather than reading "Sent" forever.
    const sent: string[] = []
    const ids: Record<string, { provider: string; id: string | null }> = {}
    if (c.email) {
      const r = await sendEmail(c.email, rendered.subject, rendered.html, rendered.text)
      if (r.sent) { sent.push('email'); ids.email = { provider: 'resend', id: r.id ?? null } }
    }
    if (c.sms_opt_in && c.phone) {
      const r = await sendSms(c.phone, rendered.sms)
      if (r.sent) { sent.push('sms'); ids.sms = { provider: 'twilio', id: r.id ?? null } }
    }

    // Thread the receipt into the conversation + audit log, mirroring the send route.
    let messageId: string | null = null
    if (sent.length) {
      const convoId = await getOrCreateConversation(sb, opts.userId, opts.customerId)
      if (convoId) {
        const primary = ids[sent[0]]
        const msgBase = { user_id: opts.userId, conversation_id: convoId, customer_id: opts.customerId, direction: 'outbound', channel: sent[0], body: rendered.sms, status: 'sent', meta: { template: 'receipt' } }
        let { data: m } = await sb.from('messages')
          .insert({ ...msgBase, provider: primary?.provider ?? null, provider_message_id: primary?.id ?? null })
          .select('id').single()
        // Pre-migration fallback: never lose the bubble over a missing column.
        if (!m) ({ data: m } = await sb.from('messages').insert(msgBase).select('id').single())
        messageId = (m as { id: string } | null)?.id ?? null
      }
    }
    for (const ch of ['email', 'sms']) {
      const wasSent = sent.includes(ch)
      // Log the attempt only for live channels (skip noise when comms are disabled).
      const live = ch === 'email' ? commsEnabled().email : commsEnabled().sms
      if (!live) continue
      // Truthful canonical skip reason (receipts: email is transactional → only the
      // address can be missing; SMS still respects opt-in).
      const detail = wasSent ? null
        : ch === 'email' ? SKIP_REASON.NO_EMAIL
        : !c.sms_opt_in ? SKIP_REASON.NO_OPT_IN : SKIP_REASON.NO_PHONE
      await logSend(sb, {
        userId: opts.userId, customerId: opts.customerId, channel: ch, template: 'receipt',
        status: wasSent ? 'sent' : 'skipped', detail,
        messageId: wasSent ? messageId : null,
        provider: ids[ch]?.provider ?? null, providerId: ids[ch]?.id ?? null,
      })
    }
  } catch (e) {
    console.error('[receipt] send failed:', e)
  }
}

