import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { renderMessage, MsgType, type MessagePrefs } from '@/lib/comms/templates'
import { commsEnabled } from '@/lib/comms/send'
import { dispatchToCustomer } from '@/lib/comms/dispatch'
import { ensurePortalToken, portalUrl } from '@/lib/portal'
import { resolveAutomations, Automations } from '@/lib/comms/automations'
import { dueForAutoReminder, resolveReminderPolicy, type ReminderPolicy, type RemindableInvoice } from '@/lib/payments/dunning'
import { invoiceBalance } from '@/lib/payments/ledger'
import type { FeeSettings } from '@/lib/invoiceTotals'
import { formatCurrency, localTodayISO } from '@/lib/utils'

export const dynamic = 'force-dynamic'

// ── Automatic invoice reminders (Vercel Cron → see vercel.json) ──────────────
// Chases invoices that are past due and still owe money, using the existing
// payment_reminder template. Same guards as every other scheduled sender:
//   • requires CRON_SECRET,
//   • no-ops when comms credentials are absent,
//   • needs SUPABASE_SERVICE_ROLE_KEY to read across owners,
//   • OFF unless the owner turns it on (automations.invoice_reminder),
//   • per-customer opt-in + granular consent enforced by dispatchToCustomer,
//   • every send, skip and failure written to notification_log.
//
// It owns no opinion about who is overdue — lib/payments/ledger's
// displayInvoiceStatus is the single engine for that (the same call the invoices
// list, dashboard and portal read), so this cron can never chase someone the
// screens show as paid.
//
// WHEN CHASING STOPS (all of it falls out of the ledger, no second list):
//   paid / overpaid → balance clears → no longer 'overdue'.
//   cancelled       → terminal in displayInvoiceStatus.
//   draft           → never 'overdue' (only unpaid/sent/partial qualify).
//   not yet due     → due_date hasn't passed.
//   exhausted       → reminder_count reached the owner's maximum.
// Requires RUN-2026-07-14-invoice-reminders.sql (last_reminded_at, reminder_count).

interface ReminderCustomer {
  name: string; phone: string | null; email: string | null
  sms_opt_in: boolean; email_opt_in: boolean; message_prefs?: MessagePrefs | null
}
type ReminderRow = RemindableInvoice & {
  id: string; user_id: string; customer_id: string | null; invoice_number: string
  customers: ReminderCustomer | null
}

export async function GET(req: NextRequest) {
  const secret = req.headers.get('authorization')?.replace('Bearer ', '') || new URL(req.url).searchParams.get('secret') || ''
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const enabled = commsEnabled()
  if (!enabled.sms && !enabled.email) {
    return NextResponse.json({ ok: true, disabled: true, note: 'Comms disabled — set Twilio/Resend env vars to enable scheduled sends.' })
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !svc) {
    return NextResponse.json({ ok: true, skipped: true, note: 'Set SUPABASE_SERVICE_ROLE_KEY to enable scheduled sends.' })
  }
  const supabase = createClient(url, svc)
  const today = localTodayISO()

  // Only invoices that can still owe money. 'overdue' is then decided by the
  // ledger, not by this query — the filter is just to keep the scan small.
  const sel = 'id, user_id, customer_id, invoice_number, status, due_date, amount, amount_paid, discount_type, discount_value, viewed_at, last_reminded_at, reminder_count, customers(name, phone, email, sms_opt_in, email_opt_in, message_prefs)'
  const { data: rows, error } = await supabase.from('invoices').select(sel).in('status', ['unpaid', 'sent', 'partial'])
  if (error) {
    // Most likely the reminder columns aren't there yet — say so plainly instead
    // of failing as an opaque 500.
    return NextResponse.json({ ok: false, error: error.message, note: 'Run supabase/RUN-2026-07-14-invoice-reminders.sql.' }, { status: 500 })
  }
  const invoices = ((rows as unknown as ReminderRow[]) || []).filter(i => i.customer_id && i.customers)
  if (invoices.length === 0) return NextResponse.json({ ok: true, chased: 0, sent: 0, skipped: 0, failed: 0 })

  const bizCache: Record<string, { name: string; templates: Partial<Record<MsgType, string>> | null; logoUrl: string | null; website: string | null; phone: string | null; automations: Automations; policy: ReminderPolicy; fees: FeeSettings }> = {}
  async function bizInfo(userId: string) {
    if (bizCache[userId]) return bizCache[userId]
    const { data } = await supabase.from('business_settings')
      .select('company_name, phone, website, logo_url, message_templates, automations, payment_fee_strategy, fee_recovery_percent, gst_percent')
      .eq('user_id', userId).maybeSingle()
    const d = data as ({ company_name: string | null; phone: string | null; website: string | null; logo_url: string | null; message_templates: Partial<Record<MsgType, string>> | null; automations: unknown } & FeeSettings) | null
    return (bizCache[userId] = {
      name: d?.company_name || 'Edge Property Services',
      templates: d?.message_templates ?? null,
      logoUrl: d?.logo_url ?? null,
      website: d?.website ?? null,
      phone: d?.phone ?? null,
      automations: resolveAutomations(d?.automations),
      policy: resolveReminderPolicy(d?.automations),
      // The SAME fee/GST settings every balance is computed with, so the reminder
      // can never disagree with the amount shown on the invoice or the portal.
      fees: { payment_fee_strategy: d?.payment_fee_strategy ?? null, fee_recovery_percent: d?.fee_recovery_percent ?? null, gst_percent: d?.gst_percent ?? null },
    })
  }

  let sent = 0, skipped = 0, chased = 0, failed = 0
  // Longest-overdue first, so a partial run always chases the stalest money first.
  const ordered = [...invoices].sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''))

  for (const inv of ordered) {
    const info = await bizInfo(inv.user_id)
    if (!info.automations.invoice_reminder) continue                            // owner hasn't switched it on
    if (!dueForAutoReminder(inv, info.fees, today, info.policy)) continue        // ledger decides overdue; policy decides cadence

    // ── Claim before sending ──────────────────────────────────────────────────
    // Compare-and-swap on the exact reminder_count we read, re-asserting that the
    // invoice is still chaseable in the same statement. Two overlapping cron runs
    // both see it as due, but only one UPDATE can match — the loser gets zero rows
    // and moves on, so an invoice can never be reminded twice. Moving
    // last_reminded_at also re-anchors the policy, which is what spaces the next
    // reminder by delayDays.
    const seen = inv.reminder_count ?? 0
    const { data: claimed } = await supabase.from('invoices')
      .update({ last_reminded_at: new Date().toISOString(), reminder_count: seen + 1 })
      .eq('id', inv.id).eq('reminder_count', seen).in('status', ['unpaid', 'sent', 'partial'])
      .select('id')
    if (!claimed || claimed.length === 0) continue   // another run got it, or it was paid mid-run
    chased++

    // One bad invoice must never abort the batch — the rest of the owner's book
    // would go unchased until tomorrow. A throw is recorded like any other failure
    // so the attempt it consumed is visible rather than silent.
    try {
      const token = await ensurePortalToken(supabase, inv.user_id, inv.customer_id!)
      const { balance } = invoiceBalance(inv, info.fees)
      const msg = renderMessage('payment_reminder', info.templates, {
        firstName: inv.customers!.name,
        businessName: info.name,
        invoiceLink: token ? portalUrl(token) : undefined,
        amount: formatCurrency(balance),
        logoUrl: info.logoUrl || undefined,
        website: info.website || undefined,
        directPhone: info.phone || undefined,
      })

      // The shared dispatcher enforces granular consent (payment_reminder maps to
      // the 'invoices' category) + per-channel opt-in and threads the message into
      // the customer's conversation — identical to a manual send. It returns one
      // attempt per channel for us to log.
      const res = await dispatchToCustomer(supabase, {
        userId: inv.user_id,
        customer: { id: inv.customer_id!, ...inv.customers! },
        channels: ['sms', 'email'],
        smsText: msg.sms, emailSubject: msg.subject, emailHtml: msg.html, emailText: msg.text,
        template: 'payment_reminder',
        meta: { invoice_id: inv.id, invoice_number: inv.invoice_number, reminder_number: seen + 1, balance, automated: true },
      })
      for (const a of res.attempts) {
        await supabase.from('notification_log').insert({
          user_id: inv.user_id, customer_id: inv.customer_id, channel: a.channel,
          template: 'payment_reminder', status: a.status, detail: a.detail, message_id: res.messageId,
        })
      }
      if (res.sentChannels.length) sent++; else skipped++
    } catch (e) {
      failed++
      await supabase.from('notification_log').insert({
        user_id: inv.user_id, customer_id: inv.customer_id, channel: 'sms',
        template: 'payment_reminder', status: 'failed',
        detail: e instanceof Error ? e.message.slice(0, 200) : 'reminder failed',
      })
    }
  }

  return NextResponse.json({ ok: true, chased, sent, skipped, failed })
}
