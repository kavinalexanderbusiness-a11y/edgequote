import type { AutomationRule } from './types'

// ── The rule registry ────────────────────────────────────────────────────────
// Every automation the engine knows about, and the authority the owner has given
// it. Code-defined on purpose (not a DB table yet): a rule is a piece of product
// behaviour, and inventing one should be a reviewed change, not a row someone can
// type. The owner's *authority* over a rule is the part that will move to storage.
//
// THE MIGRATION RULE: every automation enters at the mode it already runs at
// today. The ones that already send (reminder, review_request, job_complete,
// receipt, campaigns, quote_followup, invoice_reminder) are NOT listed here yet —
// they run through their own crons and are not engine-driven, and re-pointing them
// is a later, deliberate step. What IS listed enters at `suggest`, which is
// exactly what the product does today: surface the condition, act on nothing.
//
// So switching the engine on changes nothing. That is the point. A rule only ever
// starts acting when someone promotes it to `auto` and can say why.

export const AUTOMATION_RULES: AutomationRule[] = [
  {
    key: 'rebook_ran_out',
    label: 'Re-book a recurring customer whose series ran out',
    signal: 'recurring_ran_out',
    action: { kind: 'notify', notificationType: 'rebook_due' },
    // Today the reactivation page surfaces this and the owner acts. Same thing,
    // now written down where the engine can see it.
    mode: 'suggest',
    holdMinutes: 0,
    constraints: {
      sendWindowHours: [9, 19],
      maxPerCustomerPer: { count: 1, days: 14 },
      maxPerRun: 25,
    },
  },
  {
    key: 'flag_churn_risk',
    label: 'Flag a recurring customer drifting past their cadence',
    signal: 'churn_risk',
    action: { kind: 'notify', notificationType: 'churn_risk' },
    mode: 'suggest',
    holdMinutes: 0,
    constraints: {
      sendWindowHours: [9, 19],
      maxPerCustomerPer: { count: 1, days: 30 },
      maxPerRun: 25,
    },
  },
]

export function ruleFor(key: string): AutomationRule | undefined {
  return AUTOMATION_RULES.find(r => r.key === key)
}

/** Rules watching a given signal. A signal may feed more than one rule. */
export function rulesForSignal(signal: string): AutomationRule[] {
  return AUTOMATION_RULES.filter(r => r.signal === signal)
}
