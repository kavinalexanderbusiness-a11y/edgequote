// ── Automatic payment receipt ──────────────────────────────────────────────────
// Sent from the Stripe webhook (service-role, NO user session) the moment an
// invoice is actually flipped to paid by an AutoPay charge. Reuses the same comms
// primitives as the owner-driven send route (templates + sendSms/sendEmail) and
// threads the receipt into the customer's conversation + notification_log, so it
// shows up everywhere a normal message does. Server-only.
import type { SupabaseClient } from '@supabase/supabase-js'
import { renderMessage } from '@/lib/comms/templates'
import { dispatchToCustomer } from '@/lib/comms/dispatch'
import { logDispatch } from '@/lib/comms/log'
import { ensurePortalToken, portalUrl } from '@/lib/portal'

function formatAmount(n: number): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(n)
}

// Best-effort: never throws. A receipt that can't send must NOT fail the webhook
// (the payment is already recorded).
//
// Consent is decided by the ONE gate (lib/comms/reach), not here. This used to
// hand-roll its own ladder and had DRIFTED: it never loaded message_prefs, so a
// customer who turned off "Invoices & receipts" in the portal still got texted a
// receipt every month — while the very same category of message from
// cron/invoice-reminders (which goes through dispatch) was correctly skipped. Two
// senders, same customer, same category, opposite answers.
//
// `transactional: true` keeps the one deliberate exemption — email doesn't need
// email_opt_in, because this is a receipt for money the customer just paid (CASL
// s.6(6)(b)) — but states it in the gate instead of achieving it by omission.
export async function sendPaymentReceipt(
  sb: SupabaseClient,
  opts: { userId: string; customerId: string | null; amount: number; origin: string },
): Promise<void> {
  try {
    if (!opts.customerId) return
    const { data: cust } = await sb.from('customers')
      .select('id, name, phone, email, sms_opt_in, email_opt_in, message_prefs')
      .eq('id', opts.customerId).eq('user_id', opts.userId).maybeSingle()
    if (!cust) return
    const c = cust as { id: string; name: string; phone: string | null; email: string | null; sms_opt_in: boolean; email_opt_in: boolean; message_prefs: Record<string, boolean> | null }

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

    // The ONE send path: gate → send → thread the bubble → per-channel attempts.
    // It keeps each channel's provider id, so a receipt that bounces can say so
    // rather than reading "Sent" forever, and logDispatch is the one writer.
    const res = await dispatchToCustomer(sb, {
      userId: opts.userId,
      customer: c,
      channels: ['email', 'sms'],
      smsText: rendered.sms, emailSubject: rendered.subject, emailHtml: rendered.html, emailText: rendered.text,
      template: 'receipt',
      transactional: true,
      meta: { source: 'autopay_receipt' },
    })
    await logDispatch(sb, res, { userId: opts.userId, customerId: opts.customerId, template: 'receipt' })
  } catch (e) {
    console.error('[receipt] send failed:', e)
  }
}

