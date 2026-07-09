// ── Property Health (the ONE property scorer) ────────────────────────────────
// Collapses everything EdgeQuote already knows about a property — measurement
// freshness, pricing confidence, service history, recurring stability, upcoming
// work, AI Vision analysis — into a single 0–100 health score, the SINGLE
// highest-priority recommendation, and the ONE primary action for its current
// lifecycle state. Pure + synchronous: callers pass signals they already loaded
// (no new queries, no new engine). Reused by the Property card today and reusable
// by the dashboard/customer hub later.

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
}

export interface PropertyHealth {
  score: number                    // 0–100
  label: string                    // New | At risk | Needs attention | Good | Healthy
  tone: 'good' | 'ok' | 'warn' | 'new'
  recommendation: string | null    // the single highest-priority next step (null = nothing pressing)
  action: PropertyActionKind       // the one primary action for the current state
  actionLabel: string
}

// Each term is the value of a real, known fact — so the score literally reads
// "how much do we know + how healthy is this account". Max = 100.
export function computePropertyHealth(i: PropertyHealthInput): PropertyHealth {
  let score = 0
  if (i.measured) score += i.measurementStale ? 12 : 24                                   // measurement (24)
  score += i.pricingConfidence === 'high' ? 14 : i.pricingConfidence === 'medium' ? 9 : i.pricingConfidence === 'low' ? 4 : 0 // pricing (14)
  score += i.completedVisits >= 5 ? 24 : i.completedVisits >= 1 ? 15 : 0                   // service history (24)
  if (i.hasActiveRecurring) score += i.recurringNothingScheduled ? 9 : 22                  // recurring stability (22)
  else if (i.hasWonQuote) score += 9
  score += i.hasUpcoming ? 12 : 0                                                          // scheduled work (12)
  if (i.hasVision) score += 4                                                              // AI Vision analysed (4)
  if (i.hasActiveRecurring && i.daysSinceLastService != null && i.daysSinceLastService > 45) score -= 12 // lapsed penalty
  score = Math.max(0, Math.min(100, Math.round(score)))

  // ── The single highest-priority recommendation + its primary action ──
  // Ordered most-urgent first; the FIRST match wins, so the owner never sees a
  // wall of equal nudges — just the next thing that matters. Direct assignment in
  // each branch (no closure) keeps the action type a true union.
  let recommendation: string | null
  let action: PropertyActionKind
  let actionLabel: string
  const fallbackAction: PropertyActionKind = i.measured ? 'remeasure' : 'measure'
  const fallbackLabel = i.measured ? 'Re-measure' : 'Measure'

  if (!i.measured) {
    recommendation = 'Measure this property to unlock pricing.'; action = 'measure'; actionLabel = 'Measure'
  } else if (i.hasActiveRecurring && i.recurringNothingScheduled) {
    recommendation = 'Recurring plan has no upcoming visit — book the next one.'; action = 'schedule'; actionLabel = 'Schedule'
  } else if (i.hasActiveRecurring && i.daysSinceLastService != null && i.daysSinceLastService > 45) {
    recommendation = `Not serviced in ${i.daysSinceLastService} days — rebook this customer.`; action = 'schedule'; actionLabel = 'Schedule'
  } else if (i.hasWonQuote && !i.hasUpcoming && !i.hasActiveRecurring) {
    recommendation = 'Quote accepted — schedule the first visit.'; action = 'schedule'; actionLabel = 'Schedule'
  } else if (!i.hasWonQuote && i.quotedCount === 0 && i.hasCustomer) {
    recommendation = 'Measured and ready — send a quote.'; action = 'quote'; actionLabel = 'Create quote'
  } else if (i.measurementStale) {
    recommendation = 'Measurement is over a year old — recalculate pricing.'; action = 'recalc'; actionLabel = 'Recalculate'
  } else if (i.pricingConfidence === 'low') {
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

  return { score, label, tone, recommendation, action, actionLabel }
}
