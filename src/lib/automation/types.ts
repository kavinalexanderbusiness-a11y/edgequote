// ── Automation engine — CONTRACTS ONLY. NOTHING IS WIRED. ────────────────────
// The shape the engine will take, encoded so future work has one thing to build
// against. There is deliberately no runtime here: no rules are registered, no
// queue is drained, nothing sends. See AUTOMATION_ARCHITECTURE.md.
//
// The pipeline these types describe:
//   Detection → Decision → Delay → Send → Undo → Audit
//
// Detection already exists: src/lib/signals. Those detectors are pure, take an
// injected clock and never touch the DOM — which is what lets a server job
// evaluate them. Everything below is the missing half.

import type { MsgType } from '@/lib/comms/templates'

// ── Decision ─────────────────────────────────────────────────────────────────
/** How much authority the owner has granted a rule.
 *  `suggest` is today's behaviour for ~every detector: surface it, act on nothing.
 *  Every rule migrates in at its CURRENT mode, so turning the engine on changes
 *  nothing until a rule is deliberately promoted. */
export type RuleMode = 'off' | 'suggest' | 'auto'

/** What a rule does when it fires. Kept narrow on purpose — a rule that can do
 *  anything is a rule nobody can reason about. */
export type RuleAction =
  | { kind: 'message'; template: MsgType }
  | { kind: 'notify'; notificationType: string }

export interface AutomationRule {
  key: string
  /** Owner-facing name, e.g. "Chase quiet quotes". */
  label: string
  /** The signal (from lib/signals) this rule watches. */
  signal: string
  action: RuleAction
  mode: RuleMode
  /** Minutes the action waits, cancellable, before it commits. 0 = no undo
   *  window, which should be rare — see UndoableAction. */
  holdMinutes: number
  /** Guard rails applied before anything leaves: never message the same customer
   *  more than N times per window, never outside quiet hours. */
  constraints: RuleConstraints
}

export interface RuleConstraints {
  /** Local hours during which sending is allowed, e.g. [8, 20]. */
  sendWindowHours: [number, number]
  /** Max actions per customer per rolling window. */
  maxPerCustomerPer: { count: number; days: number }
  /** Max actions this rule may take in one run — a blast-radius cap. */
  maxPerRun: number
}

// ── Delay ────────────────────────────────────────────────────────────────────
/** The stage EdgeQuote has never had. A fired rule becomes a queued action, not
 *  a send. The queue is what makes quiet hours, frequency caps and undo possible. */
export interface QueuedAction {
  id: string
  ruleKey: string
  customerId: string
  /** Earliest it may run (quiet hours / explicit delay). */
  scheduledAt: string
  /** Until this passes, the owner can cancel it. */
  holdUntil: string
  /** Idempotency: the engine must RESERVE this before dispatch, never
   *  check-then-act. `cron/campaigns` is the pattern to copy. */
  dedupeKey: string
  status: 'held' | 'ready' | 'sent' | 'cancelled' | 'suppressed'
}

// ── Undo ─────────────────────────────────────────────────────────────────────
/** A rule that mutates (re-book, price change) must be able to describe its own
 *  reversal before it acts. If it can't, it doesn't get `auto`. */
export interface UndoableAction {
  /** Applied to reverse the action within the hold window. */
  inverse: Record<string, unknown>
  table: string
  rowId: string
}

// ── Audit ────────────────────────────────────────────────────────────────────
/** Every evaluation — fired OR suppressed — lands here. If it isn't in the run
 *  log, it didn't happen. `suppressedReason` is the important half: the owner
 *  needs to know why the robot stayed quiet, not just when it spoke. */
export interface RunRecord {
  id: string
  ruleKey: string
  customerId: string | null
  evaluatedAt: string
  decision: 'fired' | 'suppressed'
  suppressedReason?: 'mode_off' | 'quiet_hours' | 'frequency_cap' | 'no_consent' | 'deduped' | 'signal_absent'
  queuedActionId?: string
  sentAt?: string
  undoneAt?: string
}
