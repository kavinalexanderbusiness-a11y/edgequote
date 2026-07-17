import type { FixedAsset } from '@/types'

// ── Depreciation — what the gear is still worth ──────────────────────────────
// A mower isn't an expense the day you buy it; it's cash turning into an asset
// that wears out over years. This module answers ONE question: as at date D, how
// much of an asset's cost has been used up, and what's it still worth on the books?
//
// ══ THESE ARE BOOK FIGURES, NOT A TAX FILING ═════════════════════════════════
// Deliberately NOT CRA capital cost allowance. Real CCA has asset classes,
// prescribed rates, the half-year rule, recapture and terminal loss — none of which
// this computes. Implementing "CCA-ish" maths and calling it CCA is how an owner
// ends up filing a return on a number that was never one. These figures exist to
// make a balance sheet true; a tax return needs an accountant, and the export
// hands them the cost basis to do it properly.
//
// ══ PURE STRING DATES, no Date parsing ═══════════════════════════════════════
// Same idiom as period.ts. Elapsed time is integer month arithmetic off
// 'YYYY-MM-DD', because parsing a stored date to compute a year count is how an
// asset bought on Dec 31 depreciates a year early on a UTC boundary.

const round2 = (n: number) => Math.round(n * 100) / 100

export interface Depreciation {
  /** What it cost, GROSS. */
  cost: number
  /** Cost that can ever be written off: cost − salvage (0 when method is 'none'). */
  depreciableBase: number
  /** Written off from in-service up to the as-at date. Never exceeds depreciableBase. */
  accumulated: number
  /** cost − accumulated. What the balance sheet carries. Never below salvage. */
  bookValue: number
  /** A full year's write-off at the current rate — for the schedule, not the total. */
  annualAmount: number
  /** Whole+fractional years from in-service to the as-at date, floored at 0. */
  yearsElapsed: number
  /** True once accumulated has reached the base — it's worth salvage and no less. */
  fullyDepreciated: boolean
  /** Gone as at this date (sold/scrapped) — off the balance sheet entirely. */
  disposed: boolean
}

/**
 * Months between two 'YYYY-MM-DD' dates, as a fraction of a year.
 *
 * Month-granular rather than day-granular: depreciation is conventionally taken in
 * whole months, and it keeps the arithmetic exact (no 365.25 drift). The day-of-month
 * refines the final partial month so an asset bought on the 1st and one bought on
 * the 30th of the same month don't claim identical time.
 */
export function yearsBetween(fromISO: string, toISO: string): number {
  const fy = Number(fromISO.slice(0, 4)), fm = Number(fromISO.slice(5, 7)), fd = Number(fromISO.slice(8, 10))
  const ty = Number(toISO.slice(0, 4)), tm = Number(toISO.slice(5, 7)), td = Number(toISO.slice(8, 10))
  if (!isFinite(fy) || !isFinite(ty)) return 0
  let months = (ty - fy) * 12 + (tm - fm)
  // Partial month: 30-day convention, matching the whole-month basis above.
  months += (td - fd) / 30
  return months <= 0 ? 0 : months / 12
}

/**
 * Depreciate one asset as at a date.
 *
 * `asOfISO` is the owner's local today (or a period end) — never `new Date()` in
 * here, so this stays pure and a balance sheet "as at 31 Dec" means that date.
 */
export function depreciate(asset: FixedAsset, asOfISO: string): Depreciation {
  const cost = round2(Number(asset.cost) || 0)
  const salvage = round2(Number(asset.salvage_value) || 0)
  const disposed = Boolean(asset.disposed_at && asset.disposed_at <= asOfISO)

  // Stop the clock at disposal: an asset sold in March doesn't keep depreciating
  // through December just because the report is run in December.
  const effectiveDate = disposed && asset.disposed_at && asset.disposed_at < asOfISO
    ? asset.disposed_at
    : asOfISO

  const yearsElapsed = yearsBetween(asset.in_service_date, effectiveDate)

  // 'none' means never written down (land) — base 0, book value stays cost.
  if (asset.method === 'none') {
    return {
      cost,
      depreciableBase: 0,
      accumulated: 0,
      bookValue: disposed ? 0 : cost,
      annualAmount: 0,
      yearsElapsed,
      fullyDepreciated: false,
      disposed,
    }
  }

  // Never write below salvage: that's what it's worth at the end, by definition.
  const depreciableBase = round2(Math.max(0, cost - salvage))

  let accumulated = 0
  let annualAmount = 0

  if (asset.method === 'straight_line') {
    const life = Number(asset.useful_life_years) || 0
    // The DB refuses straight_line without a life, so this is a corrupt row, not a
    // reason to invent a default life and depreciate on a guess.
    if (life > 0) {
      annualAmount = round2(depreciableBase / life)
      accumulated = round2(Math.min(depreciableBase, (depreciableBase / life) * yearsElapsed))
    }
  } else if (asset.method === 'declining_balance') {
    const rate = (Number(asset.declining_rate) || 0) / 100
    if (rate > 0) {
      // Continuous form of "a % of what's left each year": after t years the
      // remaining fraction is (1−rate)^t. Exact at whole years and smooth between,
      // rather than stepping once a year and lying for the other 364 days.
      const remainingFraction = Math.pow(1 - rate, yearsElapsed)
      // Declining balance is asymptotic — it never reaches zero on its own, so the
      // salvage floor is what actually terminates it.
      accumulated = round2(Math.min(depreciableBase, cost * (1 - remainingFraction)))
      annualAmount = round2((cost - accumulated) * rate)
    }
  }

  const bookValue = disposed ? 0 : round2(cost - accumulated)

  return {
    cost,
    depreciableBase,
    accumulated,
    bookValue,
    annualAmount,
    yearsElapsed: Math.round(yearsElapsed * 100) / 100,
    fullyDepreciated: depreciableBase > 0 && accumulated >= depreciableBase,
    disposed,
  }
}

export interface AssetRegister {
  /** Assets still owned as at the date, with their depreciation. */
  rows: { asset: FixedAsset; depreciation: Depreciation }[]
  /** Gross cost of everything still owned. */
  totalCost: number
  /** Total written off against what's still owned. */
  totalAccumulated: number
  /** THE balance-sheet figure: cost − accumulated, for assets still owned. */
  netBookValue: number
  /** A full year's depreciation at current rates — the run-rate, not a total. */
  annualDepreciation: number
  /** Sold or scrapped as at this date. Off the balance sheet; kept for the schedule. */
  disposedCount: number
}

/**
 * The whole register as at a date.
 *
 * Disposed assets are EXCLUDED from every total (you can't carry what you sold) but
 * still counted, because "0 assets" and "3 assets, all sold" are different facts and
 * the second one has a story.
 */
export function assetRegister(assets: FixedAsset[], asOfISO: string): AssetRegister {
  const all = assets.map(asset => ({ asset, depreciation: depreciate(asset, asOfISO) }))
  // An asset bought AFTER the as-at date isn't owned yet — a balance sheet dated
  // 30 June must not carry a mower bought in August.
  const owned = all.filter(r => !r.depreciation.disposed && r.asset.in_service_date <= asOfISO)

  return {
    rows: owned,
    totalCost: round2(owned.reduce((s, r) => s + r.depreciation.cost, 0)),
    totalAccumulated: round2(owned.reduce((s, r) => s + r.depreciation.accumulated, 0)),
    netBookValue: round2(owned.reduce((s, r) => s + r.depreciation.bookValue, 0)),
    annualDepreciation: round2(owned.reduce((s, r) => s + r.depreciation.annualAmount, 0)),
    disposedCount: all.filter(r => r.depreciation.disposed).length,
  }
}

/**
 * Depreciation charged BETWEEN two dates — what a period's P&L would show if this
 * business reported on an accrual basis.
 *
 * Exported for the trends/reporting surfaces and the accountant export. It is
 * deliberately NOT added to the cash-basis P&L: depreciation is a NON-CASH charge,
 * and adding it to a statement whose entire premise is "money that actually moved"
 * would break the basis and double-count the purchase, which cash accounting
 * already expensed in full on the day it was paid.
 */
export function depreciationBetween(assets: FixedAsset[], fromISO: string, toISO: string): number {
  return round2(
    assets.reduce((sum, a) => {
      const start = depreciate(a, fromISO).accumulated
      const end = depreciate(a, toISO).accumulated
      return sum + Math.max(0, end - start)
    }, 0),
  )
}
