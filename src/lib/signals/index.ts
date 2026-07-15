// ── signals — THE canonical detector engines ─────────────────────────────────
// One definition per condition, consumed by every screen AND (later) by every
// automation. Before this module the same customer could read as "ran out" on the
// dashboard, "dormant" on reactivation and "paused" on their own profile.
//
// Rules for anything added here:
//  • PURE and server-runnable — no browser/DOM/Date.now(). Pass `today` in.
//    (A detector that can't run server-side can't drive an automation.)
//  • PRIMITIVE inputs — never one screen's row type.
//  • ONE definition per condition. If you need a variant, add a parameter.

export { VIP_LTV, FOLLOW_UP_DAYS, CHURN_RATIO_WARN, CHURN_RATIO_HIGH, RANOUT_URGENT_MIN_DAYS, RANOUT_URGENT_CADENCES, LAPSE_BUCKET_DAYS } from './constants'
export { cadenceDays, type CadenceRecLike } from './cadence'
export { lifetimeValue, visitValue, isVip, type ValuedJob, type ValueRec } from './value'
export { needsFollowUp, compareFollowUp, followUpAnchor, daysElapsed, localToday, startOfDayMs, type FollowUpQuote } from './followup'
export {
  ranOut, isLapsed, churnRisk, isSeasonallyDormant, daysBetween,
  type RanOutInput, type RanOutSignal, type ChurnRisk, type ChurnLevel,
} from './lifecycle'
