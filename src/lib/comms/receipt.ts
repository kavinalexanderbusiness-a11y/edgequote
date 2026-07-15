// ── Automatic payment receipt ──────────────────────────────────────────────────
// Sent from the Stripe webhook (service-role, NO user session) the moment an
// invoice is actually flipped to paid by an AutoPay charge. Reuses the same comms
// primitives as the owner-driven send route (templates + sendSms/sendEmail) and
// threads the receipt into the customer's conversation + notification_log, so it
// shows up everywhere a normal message does. Server-only.
import type { SupabaseClient } from '@supabase/supabase-js'
import { renderMessage } from '@/lib/comms/templates'
import { commsEnabled } from '@/lib/comms/send'
import { dispatchToCustomer } from '@/lib/comms/dispatch'
import { logDispatch } from '@/lib/comms/log'
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
    // email_opt_in is deliberately NOT read: a receipt is transactional (see the
    // `transactional` flag below). message_prefs likewise.

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

    // THE one dispatch pipeline. Email first (the receipt's primary channel — the
    // threaded bubble records whichever sends first), and `transactional` so email
    // reaches the customer regardless of marketing preferences. SMS still honours
    // sms_opt_in inside dispatch, exactly as before.
    //
    // Only LIVE channels are attempted, so a deployment with comms half-configured
    // logs nothing for the dead one — the long-standing behaviour here.
    const live = commsEnabled()
    const channels = [...(live.email ? ['email'] : []), ...(live.sms ? ['sms'] : [])]
    if (!channels.length) return

    const res = await dispatchToCustomer(sb, {
      userId: opts.userId,
      customer: {
        id: c.id, phone: c.phone, email: c.email,
        sms_opt_in: c.sms_opt_in,
        email_opt_in: true,   // ignored under `transactional`; set true so intent is explicit
        message_prefs: null,
      },
      channels,
      smsText: rendered.sms,
      emailSubject: rendered.subject,
      emailHtml: rendered.html,
      emailText: rendered.text,
      template: 'receipt',
      transactional: true,
    })
    await logDispatch(sb, res, { userId: opts.userId, customerId: opts.customerId, template: 'receipt' })
  } catch (e) {
    console.error('[receipt] send failed:', e)
  }
}

