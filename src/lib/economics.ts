// ── Business economics — THE single profit/cost engine ──────────────────────
// One place turns revenue into PROFIT, so every screen agrees on what a job is
// worth: the measure-business verdict, customer / route / area profitability,
// the Suggestions Center, and customer quality scoring all call through here.
//
// The only business input is the loaded cost of one crew-hour (labour +
// overhead), set once in Settings → Business Basics. Revenue minus the hours a
// visit consumes (on-site + drive) priced at that rate is the expected profit.

// Fallback when business_settings.crew_cost_per_hour is null (not yet set).
// A sensible loaded cost for a small solo/2-person lawn crew.
export const DEFAULT_CREW_COST = 40

// Resolve the configured crew cost, guarding bad/empty values back to the
// default. Accepts the raw settings value (number | null | undefined).
export function crewCostPerHour(raw: number | null | undefined): number {
  return typeof raw === 'number' && isFinite(raw) && raw > 0 ? raw : DEFAULT_CREW_COST
}

export interface VisitEconomics {
  revenue: number          // what the visit bills (job price / quote visit value)
  laborMinutes: number     // crew-minutes consumed = on-site + drive (one way doubled)
  laborCost: number        // laborMinutes / 60 × crewCostPerHour, rounded
  profit: number           // revenue − laborCost, rounded
  revPerHour: number       // revenue per crew-hour, rounded
  profitPerHour: number    // profit per crew-hour, rounded
  margin: number           // profit / revenue, 0..1 (0 when revenue ≤ 0)
}

// The core metric. `onSiteMin` is time at the property; `driveMin` is the
// travel leg attributed to this visit (already one-way or round-trip per the
// caller — prospect uses the leg to the nearest anchor). `crewCost` defaults to
// DEFAULT_CREW_COST so callers without a setting still get a sane number.
export function visitEconomics(
  revenue: number,
  onSiteMin: number,
  driveMin: number,
  crewCost: number = DEFAULT_CREW_COST,
): VisitEconomics {
  const rev = Math.max(0, revenue)
  const laborMinutes = Math.max(0, onSiteMin) + Math.max(0, driveMin)
  const hours = laborMinutes / 60
  const laborCost = Math.round(hours * crewCost)
  const profit = Math.round(rev - laborCost)
  return {
    revenue: rev,
    laborMinutes,
    laborCost,
    profit,
    revPerHour: hours > 0 ? Math.round(rev / hours) : rev,
    profitPerHour: hours > 0 ? Math.round(profit / hours) : profit,
    margin: rev > 0 ? Math.max(0, profit / rev) : 0,
  }
}
