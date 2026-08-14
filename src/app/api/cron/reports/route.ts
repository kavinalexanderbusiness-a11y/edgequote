import { NextRequest, NextResponse } from 'next/server'
import { cronSecretOk, serviceClient } from '@/lib/cron/guard'
import { withCronSweep, counts } from '@/lib/cron/heartbeat'
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

async function handler(req: NextRequest) {
  // 403, like every other cron. This route answered 401 alone, which reads as "log in"
  // for an endpoint no human ever authenticates against.
  if (!cronSecretOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const sb = serviceClient()
  if (!sb) return NextResponse.json({ ok: false, error: 'Set SUPABASE_SERVICE_ROLE_KEY to run scheduled reports.' }, { status: 500 })

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

    // Already sent. A cheap PRE-FILTER, never the guard — see the claim below.
    if (row.last_period_to === period.to) { skipped++; continue }

    // ── CLAIM BEFORE SENDING ──────────────────────────────────────────────────
    // The pre-filter above is a read, and the advance used to be an unconditional
    // write after the email went out. Vercel Cron is AT-LEAST-ONCE, so two
    // overlapping invocations both read the old `last_period_to`, both passed the
    // filter, and both emailed the owner the same monthly report. Sequential retries
    // were always safe; concurrent ones were not, and nothing here could tell.
    //
    // Advancing FIRST, conditional on the exact value we read, makes the database the
    // serialization point: both runs issue the same UPDATE and only one can match a
    // row. The loser sees zero rows and passes over, exactly as the pre-filter would.
    // Same shape as the quote and invoice chasers' compare-and-swap.
    //
    // `.is` rather than `.eq` for the first-ever run: PostgREST renders `.eq(col, null)`
    // as `col = null`, which is NULL in SQL and therefore never matches — so every
    // never-yet-sent schedule would silently fail to claim, forever.
    const claim = sb.from('report_schedules').update({ last_period_to: period.to }).eq('id', row.id)
    const { data: won } = await (row.last_period_to === null
      ? claim.is('last_period_to', null)
      : claim.eq('last_period_to', row.last_period_to)).select('id')
    if (!won || won.length === 0) { skipped++; continue }

    // Hand the period back when the mail did NOT go out, so the next run retries it —
    // the behaviour the old code got by simply not advancing. Guarded on the value the
    // claim wrote, so a concurrent run that has since re-claimed this schedule can't
    // have its claim torn up underneath it.
    const release = async (why: string): Promise<void> => {
      await sb.from('report_schedules')
        .update({ last_period_to: row.last_period_to, last_error: why })
        .eq('id', row.id).eq('last_period_to', period.to)
    }

    // Hoisted so the catch can tell "threw having sent nothing" (release the period)
    // from "threw after the owner already has the email" (absolutely do not).
    let delivered = false
    try {
      const accounting = await loadAccountingData(sb, row.user_id)

      // Recipient: the row's override, else the owner's primary address. Resolved
      // at SEND time so changing it in Settings takes effect immediately.
      const to = row.recipient || accounting.settings?.email_primary
      if (!to) {
        failed++
        notes.push(`${row.kind}: no recipient`)
        await release('No recipient — add an email in Settings, or set one on the schedule.')
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
      delivered = res.sent

      // 'disabled' is comms being switched off, not a fault — saying "failed" would
      // send the owner hunting a bug that is a setting. Release either way: the period
      // genuinely hasn't been reported, so it stays due.
      if (!res.sent) {
        const why = res.reason === 'disabled'
          ? 'Email is switched off in Settings, so this report was not sent.'
          : (res.error ?? 'Send failed')
        if (res.reason === 'disabled') skipped++; else failed++
        notes.push(`${row.kind}: ${why}`)
        await release(why)
        continue
      }

      // The period is already claimed; only the send timestamp is left to record.
      await sb.from('report_schedules')
        .update({ last_sent_at: new Date().toISOString(), last_error: null })
        .eq('id', row.id)
      sent++
    } catch (e) {
      // One owner's bad data must not stop every other owner's report.
      failed++
      const msg = e instanceof Error ? e.message : 'Unknown error'
      notes.push(`${row.kind}: ${msg}`)
      // A throw AFTER the email went out must keep the period claimed — releasing it
      // would mail the owner the same report again tomorrow, the very thing claiming
      // first exists to prevent. When in doubt, stay silent rather than repeat.
      if (delivered) await sb.from('report_schedules').update({ last_error: msg }).eq('id', row.id)
      else await release(msg)
    }
  }

  return NextResponse.json({ ok: failed === 0, today, considered: rows.length, sent, skipped, failed, notes })
}

// Before this, a run that sent nothing left NO trace anywhere: no console line, no
// automation_sweeps row, and — because it calls sendEmail directly rather than going
// through logDispatch — no notification_log row either.
export const GET = withCronSweep('reports', handler, b => counts(b, undefined, 'considered', 'sent'))
