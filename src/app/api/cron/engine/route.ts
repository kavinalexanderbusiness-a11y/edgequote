import { NextRequest, NextResponse } from 'next/server'
import { cronSecretOk, serviceClient } from '@/lib/cron/guard'
import { AUTOMATION_RULES } from '@/lib/automation/rules'
import { decide } from '@/lib/automation/decide'
import { localTodayISO } from '@/lib/utils'

export const dynamic = 'force-dynamic'
// 300, matching every other shipped cron.
export const maxDuration = 300

// ── The automation engine (Vercel Cron → see vercel.json) ────────────────────
// THE consumer half. Reads today's rows from `automation_signals`, asks
// lib/automation/decide whether each rule may act, and writes the verdict to
// `automation_runs`.
//
// IT CANNOT SEND. There is no dispatch import in this file and no send path
// behind it — deliberately, and it should stay that way until the run log has been
// watched for a while. Today every rule is registered at `suggest`, so every
// verdict is `suppressed / mode_suggest`: the condition was real, the rule saw it,
// and nobody has granted it authority to act. That is the product as it stands —
// now written down instead of implied.
//
// `fired` is therefore unreachable, and THREE independent gates keep it that way
// rather than one comment asking nicely — because "the engine can't send" was only
// ever true by accident of no rule being promoted:
//   1. This route cannot know the OWNER's local hour (no timezone column exists), so
//      it passes `hour: 'unknown'` and decide() fails closed on quiet hours.
//   2. This route can't count a subject's recent actions, so it passes
//      `recentActionsForSubject: 'unknown'` and decide() fails closed again.
//   3. No RuleAction kind has a dispatcher (DISPATCHERS is empty), so nothing is
//      firable even once (1) and (2) are satisfied by real data.
// Each covers the window the others leave open: fixing one does not accidentally arm
// the engine. All three must be deliberately opened for a message to exist.
//
// Note the ORDER decide() checks them in: quiet hours precedes the frequency cap, so a
// rule promoted today would report `quiet_hours` — gate (1) — and gate (2) would never
// be reached to speak. Two silences with different names, and the run log only ever
// shows the first.
//
// What this buys before a single message changes: the owner (and we) can read
// "here is what an automation WOULD have done last night, and why it didn't" for
// as long as it takes to trust it. Promotion to `auto` is then a one-field change
// against evidence, not a leap.
//
// Idempotent: one row per (user, rule, subject, day).

interface SignalRow {
  id: string
  user_id: string
  signal: string
  subject_type: string
  subject_id: string
}

// The dispatchers that actually exist. EMPTY, and that is the point: nothing in
// this repo reads RuleAction and turns it into a send — there is no dispatcher at
// all. So a rule promoted to `auto` today would sail through decide(), be recorded
// as `fired`, and send NOTHING. That inverts the run log's entire contract: "if it
// isn't in the log it didn't happen" becomes "the log claims things that didn't
// happen", and the evidence the promotion decision rests on is fiction.
//
// Making it structural rather than a comment: an action with no dispatcher is not
// firable, whatever its mode says. `fired` stays unreachable until someone builds
// the send path and registers it here — at which point this check stops suppressing
// on its own, deliberately.
// Object.create(null) rather than {}: with a plain object literal, `kind in DISPATCHERS`
// walks the prototype chain, so `'toString' in {}` is TRUE. A future RuleAction.kind
// that collided with an Object.prototype member would have been waved through the LAST
// gate standing between a promoted rule and a claim it sent something it didn't. Only a
// closed union kept that theoretical today; a null prototype closes it permanently.
const DISPATCHERS: Record<string, unknown> = Object.create(null)

// PostgREST caps a response at 1000 rows without erroring, so the unbounded read
// this replaces evaluated an arbitrary 1000 of today's signals across ALL owners
// and silently ignored the rest — and with no ORDER BY, *which* ones varied run to
// run. `id` orders it deterministically so paging can't skip or repeat a row.
const PAGE_ROWS = 1000

type Client = NonNullable<ReturnType<typeof serviceClient>>

// The heartbeat. Wrapped because logging the failure must never BE the failure: a run
// that worked is not allowed to report failure because its proof-of-life row didn't
// land (see chase.ts on the same trap).
async function heartbeat(supabase: Client, row: Record<string, unknown>): Promise<void> {
  try {
    const { error } = await supabase.from('automation_sweeps').upsert(row, { onConflict: 'job,ran_on' })
    if (error) console.error('[cron/engine] heartbeat write failed:', error.message)
  } catch (e) {
    console.error('[cron/engine] heartbeat write threw:', e instanceof Error ? e.message : e)
  }
}

export async function GET(req: NextRequest) {
  if (!cronSecretOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const startedAt = Date.now()
  // Vercel's own request id, so a log line and its heartbeat row can be pinned to the
  // one invocation that wrote them.
  const requestId = req.headers.get('x-vercel-id')

  const supabase = serviceClient()
  if (!supabase) {
    // A missing key is a BROKEN DEPLOY, not a no-op: this answered 200 while evaluating
    // nothing. It is also the one failure the heartbeat can never record, because
    // writing the row needs the client we don't have — so this log line is the record.
    console.error('[cron/engine] SUPABASE_SERVICE_ROLE_KEY is missing or unreadable — the engine did not run, and it cannot write an automation_sweeps row to say so. This log line is the only record.')
    return NextResponse.json(
      { ok: false, error: 'no service client', note: 'Set SUPABASE_SERVICE_ROLE_KEY to enable the engine.' },
      { status: 503 },
    )
  }

  const today = localTodayISO()

  // Every exit lands here: one log line and one heartbeat row, unconditionally — the
  // quiet night is exactly the night that needs proof it happened.
  // The sweep columns are shared with the signals job, so they are mapped honestly:
  // this job DETECTS nothing, so `detected` is what it took IN (today's signals) and
  // `written` is the verdicts it recorded.
  const finish = async (r: {
    ok: boolean; owners: number; signals: number; evaluated: number; written: number; fired: number
    error?: string; note?: string; status?: number
  }): Promise<NextResponse> => {
    const ms = Date.now() - startedAt
    const summary = {
      ok: r.ok, owners: r.owners, signals: r.signals, evaluated: r.evaluated,
      written: r.written, fired: r.fired, ms, requestId,
      ...(r.error ? { error: r.error } : {}),
    }
    console.log('[cron/engine] run:', JSON.stringify(summary))
    await heartbeat(supabase, {
      job: 'engine', ran_on: today, ok: r.ok,
      owners: r.owners, detected: r.signals, written: r.written, ms,
      error: r.error ? r.error.slice(0, 200) : null,
      request_id: requestId,
      // Set explicitly, not left to the column default: the PK is (job, ran_on), so a
      // re-run today UPDATEs, and `default now()` only fires on INSERT. Without this the
      // row would carry the first run's timestamp beside the latest run's verdict.
      ran_at: new Date().toISOString(),
    })
    return NextResponse.json(
      { ok: r.ok, signals: r.signals, evaluated: r.evaluated, written: r.written, fired: r.fired, sent: 0, ...(r.error ? { error: r.error } : {}), ...(r.note ? { note: r.note } : {}) },
      { status: r.status ?? 200 },
    )
  }

  const signals: SignalRow[] = []
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await supabase
      .from('automation_signals')
      .select('id, user_id, signal, subject_type, subject_id')
      .eq('detected_on', today)
      .order('id')
      .range(from, from + PAGE_ROWS - 1)
    // The note is for an operator, and the scheduler throws the body away — so the
    // remediation hint has to reach the log to be reachable at all.
    if (error) {
      console.error('[cron/engine] reading automation_signals failed:', error.message, '— run RUN-2026-07-14-automation-signals.sql if the table is missing.')
      return finish({
        ok: false, owners: 0, signals: 0, evaluated: 0, written: 0, fired: 0,
        error: error.message, note: 'Run RUN-2026-07-14-automation-signals.sql', status: 500,
      })
    }
    const batch = (data as SignalRow[] | null) || []
    signals.push(...batch)
    if (batch.length < PAGE_ROWS) break
  }
  // Owners represented in today's signals — the only owner count this job can honestly
  // claim, since unlike the sweep it never enumerates them.
  const ownerCount = new Set(signals.map(s => s.user_id)).size
  if (!signals.length) return finish({ ok: true, owners: 0, signals: 0, evaluated: 0, written: 0, fired: 0 })

  // Per-run counters, keyed by rule — the blast-radius cap in RuleConstraints.
  const actionsThisRun: Record<string, number> = {}
  const runs: Record<string, unknown>[] = []
  let fired = 0

  for (const s of signals) {
    for (const rule of AUTOMATION_RULES) {
      if (rule.signal !== s.signal) continue

      // Both unknowns are honest, not placeholders, and both fail closed.
      //  • recentActionsForSubject: this route does not count automation_runs' fired
      //    rows yet, so it says so. Passing 0 (as it used to) claimed a history had been
      //    checked and quietly disabled the per-customer cap.
      //  • hour: business_settings has no timezone column, so the OWNER's local hour is
      //    not knowable here — see decide()'s doc on `hour` for why the server's
      //    plausible-looking value was worse than admitting that. Revisit when a
      //    timezone column exists; until then there is no honest number to pass.
      const decided = decide({
        rule,
        hour: 'unknown',
        recentActionsForSubject: 'unknown',
        actionsThisRun: actionsThisRun[rule.key] ?? 0,
        alreadyDeduped: false,
      })

      // THE LAST GATE: an action with no dispatcher cannot be `fired`, whatever
      // decide() said. Ordered after decide() on purpose — when a rule is held at
      // `suggest`, the useful reason is `mode_suggest` ("waiting to be trusted"), and
      // logging `mode_off` for it would erase the one distinction the run log exists
      // to make (see automation_runs' schema comment and RunRecord.suppressedReason).
      // So this only overrides the verdict that is actually dangerous: a rule with
      // authority to act, and nothing to act WITH. `mode_off` is the honest word for
      // it — the engine has no authority to perform an action that does not exist.
      // hasOwnProperty rather than `in`, belt AND braces with the null prototype above:
      // this stays correct if DISPATCHERS is ever redeclared as a plain literal.
      const verdict: typeof decided = decided.fire && !Object.prototype.hasOwnProperty.call(DISPATCHERS, rule.action.kind)
        ? { fire: false, reason: 'mode_off' }
        : decided

      if (verdict.fire) {
        fired++
        actionsThisRun[rule.key] = (actionsThisRun[rule.key] ?? 0) + 1
      }

      runs.push({
        user_id: s.user_id,
        rule_key: rule.key,
        signal_id: s.id,
        subject_type: s.subject_type,
        subject_id: s.subject_id,
        evaluated_on: today,
        decision: verdict.fire ? 'fired' : 'suppressed',
        suppressed_reason: verdict.fire ? null : verdict.reason,
      })
    }
  }

  let written = 0
  for (let i = 0; i < runs.length; i += 500) {
    const chunk = runs.slice(i, i + 500)
    const { error: wErr } = await supabase
      .from('automation_runs')
      .upsert(chunk, { onConflict: 'user_id,rule_key,subject_id,evaluated_on', ignoreDuplicates: false })
    // A missing table IS a broken deploy. 200 here meant the run log could be
    // written nowhere, every night, behind a green cron check.
    if (wErr) {
      console.error('[cron/engine] writing automation_runs failed:', wErr.message, '— run RUN-2026-07-15-automation-runs.sql if the table is missing.')
      return finish({
        ok: false, owners: ownerCount, signals: signals.length, evaluated: runs.length, written, fired,
        error: wErr.message, note: 'Run RUN-2026-07-15-automation-runs.sql', status: 500,
      })
    }
    written += chunk.length
  }

  // `fired` is 0, and both gates above are why. It is reported so the day it stops
  // being 0 is visible, rather than something we find out from a customer.
  return finish({ ok: true, owners: ownerCount, signals: signals.length, evaluated: runs.length, written, fired })
}
