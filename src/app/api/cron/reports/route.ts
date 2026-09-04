import { NextRequest, NextResponse } from 'next/server'
import { cronSecretOk, serviceClient } from '@/lib/cron/guard'
import { withCronSweep, counts } from '@/lib/cron/heartbeat'
import { loadTenantZones, todayForTenant } from '@/lib/tenantTimeServer'
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
// TIMEZONE: the period comes from EACH OWNER'S OWN DATE, derived from
// business_settings.timezone (IANA). It used to come from the SERVER's date —
// UTC on Vercel — and this header used to end "there is no per-owner timezone
// column; when one exists this is the single line to change". There was one, and
// nothing but the quiet-hours governor had ever read it. Session 121.
//
// ⚠️ THE SCHEDULE HOUR IS STILL GLOBAL and still UTC: vercel.json fires this at
// 12:00 UTC, chosen to land in the morning for the launch market. That is fine
// while every tenant is in one region and becomes wrong when they are not — a
// tenant in Auckland would get their morning report in the evening. The DATE is
// now correct for every tenant; the DELIVERY HOUR is a scheduling problem
// (per-tenant fan-out, or an hourly sweep that picks the tenants whose local
// hour has just struck) and is deliberately out of this session's scope.

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

  const { data, error } = await sb
    .from('report_schedules')
    .select('id, user_id, kind, recipient, last_period_to')
    .eq('enabled', true)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const rows = (data ?? []) as ScheduleRow[]

  // ── ⭐⭐ ONE DATE PER TENANT, NOT ONE PER RUN (Session 121) ────────────────
  // The header above this file used to end "There is no per-owner timezone
  // column; when one exists this is the single line to change." There is one —
  // business_settings.timezone, IANA, NOT NULL — and it had been sitting unread
  // by everything except the quiet-hours governor. This is that line.
  //
  // It matters because a report's PERIOD is derived from the date: a weekly
  // report generated against the server's UTC date closes the owner's week on
  // the wrong day for every tenant west of Greenwich, and the last day's takings
  // land in the following week's email.
  //
  // One read for every tenant in this sweep, never a query per row.
  const zoneRead = await loadTenantZones(sb, [...new Set(rows.map(r => r.user_id))])
  // ⛔ A report's PERIOD comes from the date. On a failed zone read every tenant
  // would be dated by the fallback and could be emailed a week that closed on the
  // wrong day — so nothing is sent at all.
  if (!zoneRead.ok) {
    return NextResponse.json({ ok: false, error: zoneRead.error, note: 'Tenant zones could not be read — no reports were sent.' }, { status: 500 })
  }
  const zones = zoneRead.zones
  const now = new Date()

  let sent = 0, skipped = 0, failed = 0
  const notes: string[] = []

  for (const row of rows) {
    const today = todayForTenant(zones, row.user_id, now)
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

  // `today` is per-tenant now, so there is no single one to report. The count of
  // DISTINCT tenant dates in this sweep is the honest summary — and it is the
  // number that goes from 1 to 2 as the sweep straddles a midnight somewhere.
  const tenantDates = [...new Set(rows.map(r => todayForTenant(zones, r.user_id, now)))].sort()
  return NextResponse.json({ ok: failed === 0, tenantDates, considered: rows.length, sent, skipped, failed, notes })
}

// Before this, a run that sent nothing left NO trace anywhere: no console line, no
// automation_sweeps row, and — because it calls sendEmail directly rather than going
// through logDispatch — no notification_log row either.
export const GET = withCronSweep('reports', handler, b => counts(b, undefined, 'considered', 'sent'))
