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

export async function GET(req: NextRequest) {
  if (!cronSecretOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const supabase = serviceClient()
  if (!supabase) {
    return NextResponse.json({ ok: true, skipped: true, note: 'Set SUPABASE_SERVICE_ROLE_KEY to enable the engine.' })
  }

  const today = localTodayISO()
  const hour = new Date().getHours()

  const { data, error } = await supabase
    .from('automation_signals')
    .select('id, user_id, signal, subject_type, subject_id')
    .eq('detected_on', today)
  if (error) {
    return NextResponse.json({ ok: false, error: error.message, note: 'Run RUN-2026-07-14-automation-signals.sql' }, { status: 200 })
  }
  const signals = (data as SignalRow[] | null) || []
  if (!signals.length) return NextResponse.json({ ok: true, signals: 0, evaluated: 0, fired: 0 })

  // Per-run counters, keyed by rule — the blast-radius cap in RuleConstraints.
  const actionsThisRun: Record<string, number> = {}
  const runs: Record<string, unknown>[] = []
  let fired = 0

  for (const s of signals) {
    for (const rule of AUTOMATION_RULES) {
      if (rule.signal !== s.signal) continue

      // `recentActionsForSubject` will read automation_runs' fired rows once a rule
      // can actually fire. While every rule is `suggest`, nothing fires, so there is
      // nothing to count — and inventing a query for a number that is always 0 would
      // be dead code pretending to be a safeguard.
      const verdict = decide({
        rule,
        hour,
        recentActionsForSubject: 0,
        actionsThisRun: actionsThisRun[rule.key] ?? 0,
        alreadyDeduped: false,
      })

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
    if (wErr) {
      return NextResponse.json({ ok: false, error: wErr.message, note: 'Run RUN-2026-07-15-automation-runs.sql', evaluated: runs.length }, { status: 200 })
    }
    written += chunk.length
  }

  // `fired` is 0 while every rule is `suggest`. It is reported so the day it stops
  // being 0 is visible, rather than something we find out from a customer.
  return NextResponse.json({ ok: true, signals: signals.length, evaluated: runs.length, written, fired, sent: 0 })
}
