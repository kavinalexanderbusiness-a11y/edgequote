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

/** Deep-readonly, with ONE deliberate exception: arrays and tuples are passed
 *  through untouched. A mapped type over `sendWindowHours: [number, number]` yields
 *  `readonly [number, number]`, and unlike property modifiers — which TypeScript
 *  ignores when checking assignability — a readonly TUPLE is not assignable to a
 *  mutable one. Freezing it would force a signature change on decide() and every
 *  consumer to buy nothing: the property modifiers are the whole point here, because
 *  they are what turns `.mode = 'auto'` into a compile error. Object.freeze covers
 *  the tuple at runtime regardless. */
type Immutable<T> =
  T extends readonly unknown[] ? T :
  T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } :
  T

export type RegisteredRule = Immutable<AutomationRule>

/** Freezes the graph, not just the top level — `Object.freeze(RULES)` alone would
 *  stop `push` and leave `RULES[0].constraints.maxPerRun = 999` working.
 *
 *  This is the belt to the type system's braces, and it covers the one gap the types
 *  leave: `sendWindowHours` stays a mutable tuple above, but frozen here. Whether a
 *  rejected write THROWS or fails silently depends on the caller's strict-mode — so
 *  don't rely on the throw; rely on the value never changing, which holds either way. */
function deepFreeze<T>(o: T): T {
  for (const v of Object.values(o as Record<string, unknown>)) {
    if (v && typeof v === 'object') deepFreeze(v)
  }
  return Object.freeze(o)
}

// `const` protects only the BINDING. This array is the single source of promotion
// authority, and `AUTOMATION_RULES[0].mode = 'auto'` typechecked against a plain
// `AutomationRule[]` — a one-line, one-character grant of authority to message real
// customers that neither the compiler nor a diff-reader's eye would flag. Nothing does
// it today; the point is that nothing COULD. The harness check ("NO rule is promoted
// to auto") reads the registry at startup, so a mutation after that is invisible to it
// as well. Now it is a compile error, and frozen underneath in case someone casts past
// it — so promotion is what it should always have been: editing `mode:` below, in a
// diff someone reads.
export const AUTOMATION_RULES: readonly RegisteredRule[] = deepFreeze([
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
])

// Both accessors hand back the immutable view. Returning `AutomationRule` here would
// reopen the hole one level down — `ruleFor('flag_churn_risk')!.mode = 'auto'` mutates
// the very object the registry holds — while looking like a read.
export function ruleFor(key: string): RegisteredRule | undefined {
  return AUTOMATION_RULES.find(r => r.key === key)
}

/** Rules watching a given signal. A signal may feed more than one rule. */
export function rulesForSignal(signal: string): readonly RegisteredRule[] {
  return AUTOMATION_RULES.filter(r => r.signal === signal)
}
