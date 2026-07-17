import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { renderMessage, renderBody, MsgType, MSG_LABELS, type MessagePrefs } from '@/lib/comms/templates'
import { commsEnabled } from '@/lib/comms/send'
import { dispatchToCustomer } from '@/lib/comms/dispatch'
import { logDispatch } from '@/lib/comms/log'
import { ensurePortalToken, portalUrl } from '@/lib/portal'

export const dynamic = 'force-dynamic'
// Same budget reasoning as /api/cron/campaigns: each row costs up to ~2 provider
// calls (10s timeout each) plus a handful of DB round-trips, and a batch can hold
// a whole bulk schedule. The platform default (10-15s) would kill the run after a
// dozen rows and silently strand the rest until the next tick.
export const maxDuration = 300

// One-off deferred sends (Vercel Cron, every 10 minutes → see vercel.json).
// Rows come from the Communications Center's "Send later" (the shared
// SendMessageDialog writes scheduled_messages). Due rows are claimed with a CAS
// (pending → sending) and sent through the SAME pipeline every other sender uses:
// renderMessage/renderBody → dispatchToCustomer (consent + threading) →
// logDispatch (notification_log). Guarded the same way as the other comms crons:
//   • requires CRON_SECRET,
//   • no-ops when comms credentials are absent,
//   • needs SUPABASE_SERVICE_ROLE_KEY to read across owners,
//   • per-customer opt-in is enforced inside dispatch AT SEND TIME (consent is
//     evaluated when the message goes out, not when it was scheduled).

const MAX_PER_RUN = 200

// A row stuck at 'sending' longer than this was claimed by a run that died.
// Comfortably longer than the worst real send (2 provider calls at 10s each).
const STALE_CLAIM_MS = 15 * 60 * 1000

interface ScheduledRow {
  id: string; user_id: string; customer_id: string; job_id: string | null
  template: string; channels: string[]; body: string | null
  vars: { eta?: string | number; dateLabel?: string; timeWindow?: string; address?: string; amount?: string } | null
  send_at: string
}

export async function GET(req: NextRequest) {
  const secret = req.headers.get('authorization')?.replace('Bearer ', '') || new URL(req.url).searchParams.get('secret') || ''
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const enabled = commsEnabled()
  if (!enabled.sms && !enabled.email) {
    console.log('[cron/scheduled-messages] comms disabled — nothing sent')
    return NextResponse.json({ ok: true, disabled: true, note: 'Comms disabled — set Twilio/Resend env vars to enable scheduled sends.' })
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !svc) {
    console.log('[cron/scheduled-messages] no service role key — skipped')
    return NextResponse.json({ ok: true, skipped: true, note: 'Set SUPABASE_SERVICE_ROLE_KEY to enable scheduled sends.' })
  }
  const supabase = createClient(url, svc)
  const nowIso = new Date().toISOString()

  // ── Reap stale claims ───────────────────────────────────────────────────────
  // A run that died between claim and finalize leaves 'sending' forever — and the
  // owner sees a message that never resolves. Ambiguous the same way campaign
  // claims are: the send may have gone out and only the finalize was lost. Resolve
  // against what dispatch actually recorded (it stamps meta.scheduled_id on the
  // threaded bubble). Evidence of a send → finalize as sent. No evidence → release
  // back to pending so this run retries it.
  let reaped = 0
  const staleCutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString()
  // Staleness keys on claimed_at (when a run took the row), NEVER send_at — a
  // backlogged row that was due an hour ago but claimed seconds ago is mid-flight,
  // and releasing it would double-send. Null claimed_at (shouldn't happen, but a
  // hand-edited row could) is treated as stale so it can't wedge forever.
  const { data: staleRows } = await supabase.from('scheduled_messages')
    .select('id, customer_id').eq('status', 'sending')
    .or(`claimed_at.lt.${staleCutoff},claimed_at.is.null`).limit(50)
  for (const row of ((staleRows as { id: string; customer_id: string }[]) || [])) {
    const { data: msg } = await supabase.from('messages')
      .select('id').eq('customer_id', row.customer_id).eq('meta->>scheduled_id', row.id).limit(1)
    if ((msg as unknown[] | null)?.length) {
      await supabase.from('scheduled_messages')
        .update({ status: 'sent', sent_at: nowIso, detail: 'recovered: send confirmed, finalize lost', message_id: (msg as { id: string }[])[0].id })
        .eq('id', row.id).eq('status', 'sending')
    } else {
      await supabase.from('scheduled_messages')
        .update({ status: 'pending', detail: 'claim released after a dead run' })
        .eq('id', row.id).eq('status', 'sending')
    }
    reaped++
  }

  // ── Due rows ────────────────────────────────────────────────────────────────
  const { data: dueRows, error: dueErr } = await supabase.from('scheduled_messages')
    .select('id, user_id, customer_id, job_id, template, channels, body, vars, send_at')
    .eq('status', 'pending').lte('send_at', nowIso)
    .order('send_at').limit(MAX_PER_RUN)
  if (dueErr) {
    // 42P01 = table missing (migration not run yet) — say so instead of a bare 500.
    console.error('[cron/scheduled-messages] due query failed:', dueErr.message)
    return NextResponse.json({ ok: false, error: dueErr.message, note: dueErr.code === '42P01' ? 'Run supabase/RUN-2026-07-15-scheduled-messages.sql' : undefined }, { status: 500 })
  }
  const due = (dueRows as ScheduledRow[]) || []

  // Per-owner business info cache — same shape the campaigns cron uses.
  const bizCache: Record<string, { name: string; templates: Partial<Record<MsgType, string>> | null; reviewUrl: string | null; logoUrl: string | null; website: string | null; phone: string | null; mailingAddress: string | null }> = {}
  async function bizInfo(userId: string) {
    if (bizCache[userId]) return bizCache[userId]
    const { data } = await supabase.from('business_settings').select('company_name, phone, website, logo_url, review_url, message_templates, base_address').eq('user_id', userId).maybeSingle()
    const d = data as { company_name: string | null; phone: string | null; website: string | null; logo_url: string | null; review_url: string | null; message_templates: Partial<Record<MsgType, string>> | null; base_address: string | null } | null
    return (bizCache[userId] = { name: d?.company_name || 'your service provider', templates: d?.message_templates ?? null, reviewUrl: d?.review_url ?? null, logoUrl: d?.logo_url ?? null, website: d?.website ?? null, phone: d?.phone ?? null, mailingAddress: d?.base_address ?? null })
  }

  let processed = 0, sent = 0
  const notes: string[] = []

  for (const row of due) {
    // CAS claim: pending → sending. Vercel Cron is at-least-once; a concurrent run
    // that already claimed this row updates 0 rows here and we skip it — the same
    // reserve-then-send shape the campaigns cron uses, keyed on status instead of
    // a unique insert because each row IS its own single send.
    const { data: claimed } = await supabase.from('scheduled_messages')
      .update({ status: 'sending', claimed_at: new Date().toISOString() }).eq('id', row.id).eq('status', 'pending').select('id')
    if (!(claimed as unknown[] | null)?.length) continue
    processed++

    try {
      const { data: custRow } = await supabase.from('customers')
        .select('id, name, phone, email, sms_opt_in, email_opt_in, message_prefs')
        .eq('id', row.customer_id).eq('user_id', row.user_id).maybeSingle()
      const c = custRow as { id: string; name: string; phone: string | null; email: string | null; sms_opt_in: boolean; email_opt_in: boolean; message_prefs: MessagePrefs | null } | null
      if (!c) {
        await supabase.from('scheduled_messages')
          .update({ status: 'failed', detail: 'customer no longer exists' }).eq('id', row.id).eq('status', 'sending')
        continue
      }

      const template = (row.template in MSG_LABELS ? row.template : 'custom') as MsgType
      const biz = await bizInfo(row.user_id)
      // Mint the portal link unconditionally — the manual route this send was
      // composed on does the same, so a scheduled message renders exactly like
      // the immediate send the owner previewed.
      const token = await ensurePortalToken(supabase, row.user_id, c.id)
      const vars = row.vars || {}
      const msgVars = {
        firstName: c.name,
        businessName: biz.name,
        eta: vars.eta,
        reviewLink: biz.reviewUrl || undefined,
        portalLink: token ? portalUrl(token) : undefined,
        dateLabel: vars.dateLabel,
        amount: vars.amount,
        timeWindow: vars.timeWindow,
        address: vars.address,
        directPhone: biz.phone || undefined,
        logoUrl: biz.logoUrl || undefined,
        website: biz.website || undefined,
        mailingAddress: biz.mailingAddress || undefined,
      }
      const rendered = renderMessage(template, biz.templates, msgVars)
      // Owner-edited text is the message; a fresh template render otherwise —
      // the same bodyOverride semantics as /api/comms/send.
      const out = row.body && row.body.trim() ? renderBody(row.body, msgVars, rendered.subject, template) : rendered

      const res = await dispatchToCustomer(supabase, {
        userId: row.user_id,
        customer: { id: c.id, phone: c.phone, email: c.email, sms_opt_in: c.sms_opt_in, email_opt_in: c.email_opt_in, message_prefs: c.message_prefs },
        channels: row.channels?.length ? row.channels : ['sms', 'email'],
        smsText: out.sms, emailSubject: out.subject, emailHtml: out.html, emailText: out.text,
        template, meta: { scheduled_id: row.id, scheduled_for: row.send_at },
      })
      await logDispatch(supabase, res, { userId: row.user_id, customerId: c.id, jobId: row.job_id, template })

      const overall = res.sentChannels.length ? 'sent' : (res.attempts.every(a => a.status === 'skipped') ? 'skipped' : 'failed')
      const firstDetail = res.attempts.find(a => !a.sent)?.detail ?? null
      await supabase.from('scheduled_messages').update({
        status: overall, sent_at: res.sentChannels.length ? new Date().toISOString() : null,
        detail: firstDetail, message_id: res.messageId,
      }).eq('id', row.id).eq('status', 'sending')
      if (res.sentChannels.length) sent++
    } catch (e) {
      // Finalize the claim we own so it can't sit at 'sending' forever; the reaper
      // only rescues rows a crash left behind.
      await supabase.from('scheduled_messages').update({
        status: 'failed', detail: `run error: ${(e as Error).message}`.slice(0, 300),
      }).eq('id', row.id).eq('status', 'sending')
      notes.push(`Scheduled send failed — ${(e as Error).message}`)
    }
  }

  // Log unconditionally — for a queue sweep the quiet night is the one needing proof.
  console.log(`[cron/scheduled-messages] due=${due.length} processed=${processed} sent=${sent} reaped=${reaped}${notes.length ? ` notes=${notes.length}` : ''}`)
  return NextResponse.json({
    ok: true, due: due.length, processed, sent,
    ...(reaped ? { reaped } : {}),
    ...(notes.length ? { notes } : {}),
  })
}
