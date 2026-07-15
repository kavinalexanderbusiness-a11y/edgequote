import { NextRequest, NextResponse } from 'next/server'
import { cronSecretOk, serviceClient } from '@/lib/cron/guard'
import { AUTOMATION_RULES } from '@/lib/automation/rules'
import { decide } from '@/lib/automation/decide'
import { localTodayISO } from '@/lib/utils'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

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
// `fired` is therefore unreachable, and TWO independent gates keep it that way
// rather than one comment asking nicely — because "the engine can't send" was only
// ever true by accident of no rule being promoted:
//   1. This route can't count a subject's recent actions, so it passes
//      `recentActionsForSubject: 'unknown'` and decide() fails closed.
//   2. No RuleAction kind has a dispatcher (DISPATCHERS is empty), so nothing is
//      firable even once (1) is satisfied by a real count query.
// Each covers the window the other leaves open: fixing one does not accidentally
// arm the engine. Both must be deliberately opened for a message to exist.
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
const DISPATCHERS: Record<string, unknown> = {}

// PostgREST caps a response at 1000 rows without erroring, so the unbounded read
// this replaces evaluated an arbitrary 1000 of today's signals across ALL owners
// and silently ignored the rest — and with no ORDER BY, *which* ones varied run to
// run. `id` orders it deterministically so paging can't skip or repeat a row.
const PAGE_ROWS = 1000

export async function GET(req: NextRequest) {
  if (!cronSecretOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const supabase = serviceClient()
  if (!supabase) {
    // The one deliberate no-op: no service key → 200, nothing is broken. Every other
    // failure below is a broken deploy and answers non-2xx so Vercel Cron shows it.
    return NextResponse.json({ ok: true, skipped: true, note: 'Set SUPABASE_SERVICE_ROLE_KEY to enable the engine.' })
  }

  const today = localTodayISO()
  const hour = new Date().getHours()

  const signals: SignalRow[] = []
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await supabase
      .from('automation_signals')
      .select('id, user_id, signal, subject_type, subject_id')
      .eq('detected_on', today)
      .order('id')
      .range(from, from + PAGE_ROWS - 1)
    if (error) {
      return NextResponse.json({ ok: false, error: error.message, note: 'Run RUN-2026-07-14-automation-signals.sql' }, { status: 500 })
    }
    const batch = (data as SignalRow[] | null) || []
    signals.push(...batch)
    if (batch.length < PAGE_ROWS) break
  }
  if (!signals.length) return NextResponse.json({ ok: true, signals: 0, evaluated: 0, fired: 0 })

  // Per-run counters, keyed by rule — the blast-radius cap in RuleConstraints.
  const actionsThisRun: Record<string, number> = {}
  const runs: Record<string, unknown>[] = []
  let fired = 0

  for (const s of signals) {
    for (const rule of AUTOMATION_RULES) {
      if (rule.signal !== s.signal) continue

      // `recentActionsForSubject: 'unknown'` is honest, not a placeholder: this
      // route does not count automation_runs' fired rows yet, so it says so and
      // decide() suppresses. Passing 0 here (as it used to) claimed a history had
      // been checked and quietly disabled the per-customer cap.
      const decided = decide({
        rule,
        hour,
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
      const verdict: typeof decided = decided.fire && !(rule.action.kind in DISPATCHERS)
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
      return NextResponse.json({ ok: false, error: wErr.message, note: 'Run RUN-2026-07-15-automation-runs.sql', evaluated: runs.length }, { status: 500 })
    }
    written += chunk.length
  }

  // `fired` is 0, and both gates above are why. It is reported so the day it stops
  // being 0 is visible, rather than something we find out from a customer.
  return NextResponse.json({ ok: true, signals: signals.length, evaluated: runs.length, written, fired, sent: 0 })
}
