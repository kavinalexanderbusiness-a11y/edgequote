import { NextRequest, NextResponse } from 'next/server'
import { cronSecretOk, serviceClient } from '@/lib/cron/guard'
import { localTodayISO } from '@/lib/utils'
import { loadAccountingData } from '@/lib/accounting/data'
import { composeReport, periodForReport, type ReportKind } from '@/lib/reports/schedule'
import { summarize, summaryHtml } from '@/lib/reports/summary'
import { sendEmail } from '@/lib/comms/send'

// ── Scheduled reports cron ───────────────────────────────────────────────────
// Runs daily. Each enabled schedule sends the period that has just CLOSED, once.
//
// "Once" is the whole problem, and it is solved by the DATA, not by the clock: a
// row is due when the closed period's end date differs from the one already sent
// (report_schedules.last_period_to). So this route can run twice in a minute, be
// retried after a failure, or miss a day entirely, and every owner still gets each
// period exactly once. A "last_sent_at > 7 days ago" rule would drift a little
// later every week and double-send on every retry.
//
// TIMEZONE: the period comes from the SERVER's date (localTodayISO), the same
// convention every other cron here uses, with the schedule hour picked so it lands
// in the owner's morning (11:00 UTC ≈ 5am in Calgary — the launch market). There is
// no per-owner timezone column; when one exists this is the single line to change.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface ScheduleRow {
  id: string
  user_id: string
  kind: ReportKind
  recipient: string | null
  last_period_to: string | null
}

export async function GET(req: NextRequest) {
  if (!cronSecretOk(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const sb = serviceClient()
  if (!sb) return NextResponse.json({ error: 'Set SUPABASE_SERVICE_ROLE_KEY to run scheduled reports.' }, { status: 500 })

  const today = localTodayISO()
  const { data, error } = await sb
    .from('report_schedules')
    .select('id, user_id, kind, recipient, last_period_to')
    .eq('enabled', true)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const rows = (data ?? []) as ScheduleRow[]

  let sent = 0, skipped = 0, failed = 0
  const notes: string[] = []

  for (const row of rows) {
    // The period that has finished — never the one in progress. A "today" report
    // emailed at 5am reports an empty day and reads as a business that died.
    const period = periodForReport(row.kind, today, true)

    // Already sent. The exact check, and the reason this route is safe to re-run.
    if (row.last_period_to === period.to) { skipped++; continue }

    try {
      const accounting = await loadAccountingData(sb, row.user_id)

      // Recipient: the row's override, else the owner's primary address. Resolved
      // at SEND time so changing it in Settings takes effect immediately.
      const to = row.recipient || accounting.settings?.email_primary
      if (!to) {
        failed++
        notes.push(`${row.kind}: no recipient`)
        await sb.from('report_schedules')
          .update({ last_error: 'No recipient — add an email in Settings, or set one on the schedule.' })
          .eq('id', row.id)
        continue
      }

      const report = composeReport(row.kind, today, {
        payments: accounting.payments,
        expenses: accounting.expenses,
        settings: accounting.settings,
        errors: accounting.errors,
      }, { closed: true })

      const s = summarize(report)
      const res = await sendEmail(to, s.subject, summaryHtml(report), s.text)

      // 'disabled' is comms being switched off, not a fault — saying "failed" would
      // send the owner hunting a bug that is a setting. Don't advance either way:
      // the period genuinely hasn't been reported, so it stays due.
      if (!res.sent) {
        const why = res.reason === 'disabled'
          ? 'Email is switched off in Settings, so this report was not sent.'
          : (res.error ?? 'Send failed')
        if (res.reason === 'disabled') skipped++; else failed++
        notes.push(`${row.kind}: ${why}`)
        // last_period_to is NOT advanced — the next run retries this same period,
        // which is exactly what should happen when the mail didn't go out.
        await sb.from('report_schedules').update({ last_error: why }).eq('id', row.id)
        continue
      }

      // Advance ONLY after a confirmed send.
      await sb.from('report_schedules')
        .update({ last_period_to: period.to, last_sent_at: new Date().toISOString(), last_error: null })
        .eq('id', row.id)
      sent++
    } catch (e) {
      // One owner's bad data must not stop every other owner's report.
      failed++
      const msg = e instanceof Error ? e.message : 'Unknown error'
      notes.push(`${row.kind}: ${msg}`)
      await sb.from('report_schedules').update({ last_error: msg }).eq('id', row.id)
    }
  }

  return NextResponse.json({ ok: true, today, considered: rows.length, sent, skipped, failed, notes })
}
