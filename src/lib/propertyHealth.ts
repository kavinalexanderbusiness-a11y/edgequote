// ── Property Health (the ONE property scorer) ────────────────────────────────
// Collapses everything EdgeQuote already knows about a property — measurement
// freshness, pricing confidence, service history, recurring stability, upcoming
// work, AI Vision analysis — into a single 0–100 health score, the SINGLE
// highest-priority recommendation, and the ONE primary action for its current
// lifecycle state. Pure + synchronous: callers pass signals they already loaded
// (no new queries, no new engine). Reused by the Property card today and reusable
// by the dashboard/customer hub later.
//
// NOT every term applies to every trade. Lawn measurement is the one signal here
// that a plumber, an electrician or an HVAC tech will never have — and scoring its
// absence made "Measure this property" the permanent primary action on every
// property they own, dragging a score they could never raise. Which terms apply is
// decided by lib/businessShape from rows the account already has; see the
// `applicable` denominator below for why dropping a term does not cap the score.

import { showLawnFieldFor, type BusinessShape } from '@/lib/businessShape'

export type PropertyActionKind = 'measure' | 'remeasure' | 'recalc' | 'quote' | 'schedule' | 'view'

export interface PropertyHealthInput {
  hasCustomer: boolean
  measured: boolean
  measurementStale: boolean
  located: boolean
  pricingConfidence: 'high' | 'medium' | 'low' | null
  completedVisits: number
  hasActiveRecurring: boolean
  recurringNothingScheduled: boolean
  daysSinceLastService: number | null
  hasUpcoming: boolean
  hasWonQuote: boolean
  quotedCount: number
  pricingDriftPct: number | null
  hasVision: boolean
  /** What this business does (lib/businessShape). Required rather than optional:
   *  a caller that forgets it should have to say so, not silently nag a plumber
   *  for a lawn. Pass SHAPE_LOADING for the pre-shape behaviour verbatim. */
  shape: BusinessShape
}

export interface PropertyHealth {
  score: number                    // 0–100
  label: string                    // New | At risk | Needs attention | Good | Healthy
  tone: 'good' | 'ok' | 'warn' | 'new'
  recommendation: string | null    // the single highest-priority next step (null = nothing pressing)
  action: PropertyActionKind       // the one primary action for the current state
  actionLabel: string
  /** Did the lawn-measurement terms count for THIS property? Exposed so a card's
   *  secondary lawn affordances (the quiet "Re-measure" link) follow the same
   *  decision the score made instead of re-deriving it and drifting from it. */
  lawnApplies: boolean
}

// Component weights, summing to exactly 100 — the number the whole design turns
// on. See `applicable` in computePropertyHealth.
const W = { measurement: 24, pricing: 14, history: 24, recurring: 22, upcoming: 12, vision: 4 }
// Half credit for a measurement that's over a year old: on file, no longer trusted.
const W_MEASUREMENT_STALE = 12
// Not a component — an absolute deduction. See where it's applied.
const LAPSED_PENALTY = 12

// Each term is the value of a real, known fact — so the score literally reads
// "how much of what we COULD know about this property do we know, and how healthy
// is it". Max = 100.
export function computePropertyHealth(i: PropertyHealthInput): PropertyHealth {
  // Does the lawn-measurement chain count here? Routed through the one helper
  // rather than re-deciding: `measured` is this engine's per-record "holds lawn
  // data" (a saved measurement OR a lawn_sqft), which is the same question
  // showLawnFieldFor answers about a raw column. A record that HAS the data is
  // therefore never treated as a record that lacks it, whatever the trade.
  const lawnApplies = showLawnFieldFor(i.shape, i.measured ? 1 : 0)

  // ── earned / applicable, never a running total ──
  // Each term that applies adds its weight to the DENOMINATOR and its result to
  // the numerator, so the score is a SHARE of what's knowable about this property
  // rather than a tally out of a fixed 100. That is the whole reason a dropped
  // term doesn't cap anyone: subtracting measurement's 24 and stopping would just
  // move the plumber's unfixable ceiling from 100 to 76 — the same defect, one
  // step quieter. Renormalising is also why nothing had to be re-weighted by hand:
  // every surviving term keeps its size RELATIVE to the others, and the same
  // "average only the rows that apply" rule the Data Quality audit already uses.
  //
  // For a lawn business `applicable` is always 100, so the division is ÷1 and the
  // arithmetic below is byte-for-byte today's. That is asserted, not asserted-ish:
  // verify-business-shape replays every input combination against a frozen copy of
  // the old function.
  let earned = 0
  let applicable = 0

  if (lawnApplies) {
    applicable += W.measurement
    if (i.measured) earned += i.measurementStale ? W_MEASUREMENT_STALE : W.measurement
  }

  // Pricing confidence rides WITH the measurement, because in this app that is
  // literally where it comes from: the only caller computes it as
  // `saved ? pricingConfidence(...) : null`, and `saved` is the lawn measure
  // tool's own snapshot — so a plumber's is structurally, permanently null.
  // Gating the measurement alone would have left him at a hard 82/100 instead of
  // 76: the ceiling this whole change exists to remove, moved rather than lifted.
  //
  // `!= null` is what keeps that from being a lie about pricing in general: a
  // confidence arriving from ANY future non-lawn source still scores, and a lawn
  // business that has none is still marked down exactly as it is today.
  if (lawnApplies || i.pricingConfidence != null) {
    applicable += W.pricing
    earned += i.pricingConfidence === 'high' ? 14 : i.pricingConfidence === 'medium' ? 9 : i.pricingConfidence === 'low' ? 4 : 0
  }

  // The rest are facts about any property in any trade: has it been serviced, is
  // it on a plan, is work booked, has the camera seen it.
  applicable += W.history
  earned += i.completedVisits >= 5 ? W.history : i.completedVisits >= 1 ? 15 : 0

  applicable += W.recurring
  if (i.hasActiveRecurring) earned += i.recurringNothingScheduled ? 9 : W.recurring
  else if (i.hasWonQuote) earned += 9

  applicable += W.upcoming
  earned += i.hasUpcoming ? W.upcoming : 0

  applicable += W.vision
  if (i.hasVision) earned += W.vision

  // `applicable` can never be 0 — history/recurring/upcoming/vision are universal
  // and always add 62 — so there is no divide-by-zero to guard.
  let score = (earned / applicable) * 100
  // The lapse lands AFTER the renormalisation, at face value. It is a fact about
  // the account ("nobody has been here in 45+ days"), not a share of what's
  // knowable, and it is already denominated in the 0–100 the caller sees. Scaling
  // it with the components would make one identical missed visit cost a plumber 19
  // points and a lawn business 12 — a trade surcharge for a field he doesn't have.
  if (i.hasActiveRecurring && i.daysSinceLastService != null && i.daysSinceLastService > 45) score -= LAPSED_PENALTY
  score = Math.max(0, Math.min(100, Math.round(score)))

  // ── The single highest-priority recommendation + its primary action ──
  // Ordered most-urgent first; the FIRST match wins, so the owner never sees a
  // wall of equal nudges — just the next thing that matters. Direct assignment in
  // each branch (no closure) keeps the action type a true union.
  let recommendation: string | null
  let action: PropertyActionKind
  let actionLabel: string
  // With no lawn to measure, Measure is not a safe fallback — it IS the nag, and a
  // fallback fires on exactly the properties where nothing else is pressing, which
  // is how it became the permanent default on every card. 'view' is the existing
  // "nothing to do here" member of the union, unused until now.
  const fallbackAction: PropertyActionKind = !lawnApplies ? 'view' : i.measured ? 'remeasure' : 'measure'
  const fallbackLabel = !lawnApplies ? (i.hasCustomer ? 'View customer' : 'View') : i.measured ? 'Re-measure' : 'Measure'

  // Ordered most-urgent first; the FIRST match wins. Every `lawnApplies &&` below
  // is a no-op for a lawn business (the flag is always true for them, and for any
  // measured record) — it only stops a lawn-worded nag reaching a trade that has
  // no lawn.
  if (lawnApplies && !i.measured) {
    recommendation = 'Measure this property to unlock pricing.'; action = 'measure'; actionLabel = 'Measure'
  } else if (i.hasActiveRecurring && i.recurringNothingScheduled) {
    recommendation = 'Recurring plan has no upcoming visit — book the next one.'; action = 'schedule'; actionLabel = 'Schedule'
  } else if (i.hasActiveRecurring && i.daysSinceLastService != null && i.daysSinceLastService > 45) {
    recommendation = `Not serviced in ${i.daysSinceLastService} days — rebook this customer.`; action = 'schedule'; actionLabel = 'Schedule'
  } else if (i.hasWonQuote && !i.hasUpcoming && !i.hasActiveRecurring) {
    recommendation = 'Quote accepted — schedule the first visit.'; action = 'schedule'; actionLabel = 'Schedule'
  } else if (!i.hasWonQuote && i.quotedCount === 0 && i.hasCustomer) {
    // Only a measured property is "measured and ready". This branch is now
    // reachable unmeasured — a plumber's new property lands here instead of on the
    // Measure nag, and telling him it's measured would be a plain falsehood. A
    // lawn business can still only arrive here measured (the branch above catches
    // the rest), so its wording is untouched.
    recommendation = i.measured ? 'Measured and ready — send a quote.' : 'No quote yet — send one.'
    action = 'quote'; actionLabel = 'Create quote'
  } else if (lawnApplies && i.measurementStale) {
    recommendation = 'Measurement is over a year old — recalculate pricing.'; action = 'recalc'; actionLabel = 'Recalculate'
  } else if (lawnApplies && i.pricingConfidence === 'low') {
    recommendation = 'Low pricing confidence — re-measure or build nearby route density.'; action = 'remeasure'; actionLabel = 'Re-measure'
  } else if (i.pricingDriftPct != null && Math.abs(i.pricingDriftPct) >= 15) {
    recommendation = `Pricing has drifted ${i.pricingDriftPct > 0 ? '+' : ''}${i.pricingDriftPct}% vs the last price — review it.`; action = 'quote'; actionLabel = 'Re-quote'
  } else if (!i.hasUpcoming && i.completedVisits > 0 && !i.hasActiveRecurring) {
    recommendation = 'No upcoming visit — rebook or offer a recurring plan.'; action = 'schedule'; actionLabel = 'Schedule'
  } else {
    recommendation = null; action = fallbackAction; actionLabel = fallbackLabel
  }

  // Actions that need a customer fall back to a measurement action when there isn't one.
  if (!i.hasCustomer && (action === 'quote' || action === 'schedule')) {
    action = fallbackAction; actionLabel = fallbackLabel
  }

  // Label + tone. A property with nothing done yet reads as "New", not "At risk".
  let label: string, tone: PropertyHealth['tone']
  if (i.completedVisits === 0 && i.quotedCount === 0 && !i.hasWonQuote) { label = 'New'; tone = 'new' }
  else if (score >= 80) { label = 'Healthy'; tone = 'good' }
  else if (score >= 58) { label = 'Good'; tone = 'ok' }
  else if (score >= 35) { label = 'Needs attention'; tone = 'warn' }
  else { label = 'At risk'; tone = 'warn' }

  return { score, label, tone, recommendation, action, actionLabel, lawnApplies }
}
