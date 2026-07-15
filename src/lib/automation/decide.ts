import type { AutomationRule, RunRecord } from './types'

// ── Decision — the gate every automation passes through ──────────────────────
// PURE. It takes a rule, a signal and the recent history, and returns what should
// happen. It has no client, no clock of its own, no send path — it *cannot* message
// anyone, which is what makes it safe to reason about and cheap to test.
//
// The reason `suppressedReason` exists at all: an owner needs to know why the robot
// stayed QUIET, not just when it spoke. "Nothing happened" is the hardest thing to
// debug in an automation, and the most common thing to distrust.

export type Decision =
  | { fire: true }
  | { fire: false; reason: NonNullable<RunRecord['suppressedReason']> }

export interface DecisionInput {
  rule: AutomationRule
  /** Local hour (0-23) the evaluation is happening at. */
  hour: number
  /** How many times this rule has already acted on this subject inside the
   *  rule's own frequency window. */
  recentActionsForSubject: number
  /** How many times this rule has already acted in THIS run. */
  actionsThisRun: number
  /** A prior action already exists for this exact dedupe key. */
  alreadyDeduped: boolean
}

/**
 * Should this rule act on this signal, right now?
 *
 * Order is deliberate — the cheapest and most absolute checks first, so the
 * recorded reason is the most *useful* one. A rule that is switched off should say
 * "off", not "outside quiet hours".
 */
export function decide(inp: DecisionInput): Decision {
  const { rule } = inp

  // 1. Authority. `suggest` is not a lesser `auto` — it means "surface it, don't
  //    act", which is what almost everything does today. Reported separately from
  //    `off` so a run log distinguishes "waiting to be trusted" from "turned off".
  if (rule.mode === 'off') return { fire: false, reason: 'mode_off' }
  if (rule.mode === 'suggest') return { fire: false, reason: 'mode_suggest' }

  // 2. Already handled. Checked before the caps so a duplicate never burns quota.
  if (inp.alreadyDeduped) return { fire: false, reason: 'deduped' }

  // 3. Don't wake anyone up. A correct message at 3am is a wrong message.
  const [from, to] = rule.constraints.sendWindowHours
  if (inp.hour < from || inp.hour >= to) return { fire: false, reason: 'quiet_hours' }

  // 4. Frequency caps — per subject, then the run's blast radius. Being right is
  //    not a licence to be relentless.
  if (inp.recentActionsForSubject >= rule.constraints.maxPerCustomerPer.count) {
    return { fire: false, reason: 'frequency_cap' }
  }
  if (inp.actionsThisRun >= rule.constraints.maxPerRun) {
    return { fire: false, reason: 'frequency_cap' }
  }

  return { fire: true }
}
