// ── signals — THE canonical detector engines ─────────────────────────────────
// One definition per condition, consumed by every screen AND by every automation.
// Before this module the same customer could read as "ran out" on the dashboard,
// "dormant" on reactivation and "paused" on their own profile.
//
// Rules for anything added here:
//  • PURE and server-runnable — no browser/DOM. Take the clock as a parameter
//    rather than reading it. (A detector that can't run server-side can't drive
//    an automation.)
//  • PRIMITIVE inputs — never one screen's row type.
//  • ONE definition per condition. If you need a variant, add a parameter.
//
// NOT re-exported here: quote follow-up. It lives in lib/followup.ts, which owns
// the whole follow-up domain (the staleness rule, the owner's chase policy, the
// exhaustion gate and the DB patches). It already satisfies the rules above —
// quoteIsQuiet takes an injectable clock — so mirroring it here would just be a
// second name for the same thing.

export { VIP_LTV, CHURN_RATIO_WARN, CHURN_RATIO_HIGH, RANOUT_URGENT_MIN_DAYS, RANOUT_URGENT_CADENCES, LAPSE_BUCKET_DAYS } from './constants'
export { cadenceDays, type CadenceRecLike } from './cadence'
export { lifetimeValue, visitValue, isVip, type ValuedJob, type ValueRec } from './value'
export {
  ranOut, isLapsed, churnRisk, isSeasonallyDormant, daysBetween,
  type RanOutInput, type RanOutSignal, type ChurnRisk, type ChurnLevel,
} from './lifecycle'
