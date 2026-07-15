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
  /** The hour (0-23) in the OWNER'S timezone that the evaluation is happening at.
   *
   *  `'unknown'` is a first-class value for the same reason it is on
   *  `recentActionsForSubject`, and it is here because we made that exact mistake
   *  again: the engine passed `new Date().getHours()`, which on Vercel is UTC. With
   *  a fixed cron time that is the CONSTANT 11 for every owner on every run — and
   *  11 is inside every rule's send window, so this gate could never suppress. Not
   *  wrong by an offset; wrong by always opening. A Vancouver owner's "9am-7pm"
   *  window would have fired at 4:30am.
   *
   *  It is NOT fixable here, and that is the point of the value: `business_settings`
   *  has no timezone column, so the owner's local hour is not merely unused — it is
   *  not knowable yet. A caller that cannot say what time it is for the OWNER must
   *  say so rather than pass the server's plausible-looking hour.
   *
   *  Unknown fails CLOSED (see decide). So a rule promoted to `auto` before the
   *  timezone work lands stays quiet and says `quiet_hours`, instead of sending at
   *  dawn. The run log can never surface this on its own — `quiet_hours` was an
   *  unreachable verdict — so no amount of observation would have caught it. */
  hour: number | 'unknown'
  /** How many times this rule has already acted on this subject inside the
   *  rule's own frequency window.
   *
   *  `'unknown'` is a first-class value, not a convenience: a caller that has not
   *  counted MUST say so rather than pass a plausible-looking 0. The engine used to
   *  hardcode 0, which made `0 >= count` false forever — the per-customer cap could
   *  never trip, so a promoted rule would re-fire on the same customer every night
   *  the sweep re-emitted their signal. The cap was fully written and the caller
   *  defeated it. Unknown fails CLOSED (see decide), so the count query has to be
   *  real before anything can fire. */
  recentActionsForSubject: number | 'unknown'
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

  // 3. Don't wake anyone up. A correct message at 3am is a wrong message. An
  //    unknown hour is treated as outside the window for the same reason an uncounted
  //    history is treated as a cap hit — and it must be CHECKED, not left to the
  //    comparisons below: `'unknown' < 9` and `'unknown' >= 19` are both false, so
  //    without this line the string sails through the one gate it was added to close.
  if (inp.hour === 'unknown') return { fire: false, reason: 'quiet_hours' }
  const [from, to] = rule.constraints.sendWindowHours
  if (inp.hour < from || inp.hour >= to) return { fire: false, reason: 'quiet_hours' }

  // 4. Frequency caps — per subject, then the run's blast radius. Being right is
  //    not a licence to be relentless. An uncounted history is treated as a cap hit:
  //    "I don't know how often we've already bothered them" is a reason to stay
  //    quiet, never a reason to send.
  if (inp.recentActionsForSubject === 'unknown') return { fire: false, reason: 'frequency_cap' }
  if (inp.recentActionsForSubject >= rule.constraints.maxPerCustomerPer.count) {
    return { fire: false, reason: 'frequency_cap' }
  }
  if (inp.actionsThisRun >= rule.constraints.maxPerRun) {
    return { fire: false, reason: 'frequency_cap' }
  }

  return { fire: true }
}
