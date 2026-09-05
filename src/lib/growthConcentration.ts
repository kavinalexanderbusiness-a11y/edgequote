// ── Growth concentration disclosure ───────────────────────────────────────────
// Answers ONE question lib/growthEvidence does not: of the money Growth is
// projecting across the WHOLE BOOK, how much depends on a single customer?
//
// ⛔ NOT A SECOND EVIDENCE ENGINE. `growthEvidence.assessEvidence` already
// refused everything that shouldn't count (unpriced, no-charge, fixture,
// undeclared cadence, thin samples) before an Opportunity's `expectedValue`
// reaches here. This module only asks how that already-admitted money is
// DISTRIBUTED — it decides nothing about whether a figure may exist.
//
// ⭐⭐ ORTHOGONAL TO `skewNote`, which describes spread WITHIN one customer's
// own visits ("one visit is 90x the typical $70") — nothing about how
// customers relate to EACH OTHER. A book can have zero within-customer skew
// and still depend entirely on one customer, if that customer simply holds
// the only quantified opportunities:
//
//   skewNote      one customer's visits vs their OWN median
//   this module   one customer's total vs the WHOLE BOOK's total
//
// Measured on the real book (session111/price-state-weld @ 96c9da99): $62,972
// quantified recurring opportunity, $39,900 (63%) from ONE customer (a
// $26,600 renewal + $13,300 referral, same customer id) — every visit behind
// that figure well inside its own skew tolerance. skewNote had nothing to say;
// the concentration was ACROSS customers, which is what this module measures.

/** One quantified contribution to the book. */
export interface ConcentrationEntry {
  /**
   * ⭐⭐ THE STABLE IDENTITY. A `customers.id` UUID. ⛔⛔ NEVER GROUP BY
   * `customerName` — two real customers can share a display name (a duplicate
   * import, a father-and-son account, a franchise with the same trading name at
   * two addresses), and grouping on the string would silently MERGE their
   * revenue into one "customer" that does not exist, manufacturing a
   * concentration finding out of two unrelated accounts. It can also SPLIT one
   * real customer's revenue if their record was ever renamed, understating a
   * concentration that is actually there. Every Opportunity and every
   * LtvForecast entry already carries `customerId` for exactly this reason
   * (`key: \`${kind}:${customerId}\``); this module reuses it rather than
   * introducing a second identity scheme.
   */
  customerId: string
  /** Display only. Never read for grouping, comparison or deduplication —
   *  only carried through so the note can name the customer, exactly as an
   *  Opportunity card or the LTV forecast table already does on this same
   *  screen. Showing it here exposes nothing not already authorized. */
  customerName: string
  /** A quantified opportunity's dollar figure (`Opportunity.expectedValue`).
   *  ⛔ Not trusted blindly — see assessConcentration's own filtering. An
   *  unquantified opportunity (expectedValue === 0, evidence insufficient) is
   *  passed through unfiltered by the caller and excluded HERE, so this module
   *  is the one place that decides what counts toward the total, the same
   *  discipline growthEvidence uses for exclusions. */
  expectedValue: number
}

export interface ConcentrationResult {
  /**
   * False when there is nothing meaningful to say: no entries, nothing survived
   * the filter, or the considered total is not a positive finite number.
   * ⛔ The caller MUST render nothing in that case — not "0%", not an empty
   * note. Silence is the honest answer to "what is 40% of nothing".
   */
  hasData: boolean
  /** Sum of every entry actually counted — positive, finite contributions
   *  only. Rounded to whole dollars, matching every other total on this screen. */
  totalConsidered: number
  /** How many DISTINCT customer ids contributed at least one counted entry.
   *  Lets the note read differently for "the only contributor" vs "the largest
   *  of several" — both true statements, but very different situations. */
  contributorCount: number
  /** The single largest contributor's own total, summed across every
   *  opportunity kind that customer has (a renewal AND a referral on the same
   *  customer both count toward their one total — that IS the dependency). */
  topAmount: number
  topCustomerId: string | null
  /** Display only — see the identity note on ConcentrationEntry. */
  topCustomerName: string | null
  /** topAmount / totalConsidered, clamped to [0, 1]. 0 when hasData is false —
   *  read `hasData` first; a bare 0 here is not itself meaningful. */
  topShare: number
  /** How many contributors hold exactly `topAmount`. 1 = a clear leader;
   *  2+ = a tie, and the note says "each", never "alone". 0 when hasData is false. */
  topTiedCount: number
  /** True only when hasData AND topShare has crossed CONCENTRATION_MATERIAL_SHARE.
   *  The one flag a caller needs to decide whether to render anything at all. */
  material: boolean
}

/**
 * ⭐⭐ THE THRESHOLD IS A PRODUCT CHOICE. The arithmetic below is the whole
 * justification — no external benchmark, no industry survey, nothing claimed
 * beyond what this book's own numbers do at 40% vs. nearby values.
 *
 *   • An even split among THREE contributors is ~33% each. A threshold set
 *     there fires on perfectly ordinary three-customer books, purely because
 *     they have three customers — not because any one is unusual. 40% sits
 *     above that, so an ordinary book with 3+ similarly-sized customers stays
 *     quiet.
 *
 * ⚠️⚠️ WHAT IT CANNOT DO: exclude a two-customer book, not even an exact
 * 50/50 one. With only two contributors, the larger share is always >= 50%
 * by construction (two non-negative numbers summing to a whole; a tie means
 * both are at 50%), so `material` is `true` for every two-customer book —
 * dominant or identical, always, regardless of which threshold below 50% is
 * chosen. On a two-customer book, `material: true` means "few customers,"
 * not "one is unusually large" — the code cannot tell those apart at
 * `contributorCount === 2`.
 *
 * A named constant, not a magic number inline, so the reasoning and the value
 * are found and changed in one place.
 */
export const CONCENTRATION_MATERIAL_SHARE = 0.4

/**
 * ⭐ THE ONE ASSESSMENT. Every Growth surface that wants to disclose
 * concentration calls this, so no two surfaces can compute the share
 * differently or apply a different bar for "material".
 *
 * Aggregates by `customerId`. Handles, explicitly and by test:
 *   • zero, negative or non-finite `expectedValue` — excluded, never coerced
 *   • an entry with no `customerId` — excluded, never attributed to "unknown"
 *   • duplicate `customerName` across different `customerId`s — kept separate
 *   • a book where nothing is quantified at all — `hasData: false`
 *   • a single contributor — `hasData: true`, `contributorCount: 1`,
 *     `topShare` up to 1, `material` true past the same threshold as any other
 *     book (concentration in one customer is concentration whether or not
 *     there happens to be a second one to compare against)
 */
export function assessConcentration(entries: readonly ConcentrationEntry[]): ConcentrationResult {
  const byCustomer = new Map<string, { name: string; amount: number }>()

  for (const e of entries) {
    const v = Number(e.expectedValue)
    // ⛔⛔ NaN, +/-Infinity and <= 0 are ALL excluded here, never coerced to 0
    // and never allowed to reach the sum. `Infinity` would poison every share
    // computed against it (x / Infinity = 0 for every real contributor, hiding
    // a genuine concentration); `NaN` would poison every comparison silently
    // (NaN > anything is always false, so a NaN "top" would never be found —
    // but NaN also propagates through totalConsidered, corrupting every other
    // customer's share too). A defensive `> 0` on an already-rounded, already-
    // gated Opportunity.expectedValue should never trip in practice; it is
    // asserted anyway because "should never happen upstream" is exactly the
    // class of assumption this module must not inherit silently.
    if (!Number.isFinite(v) || v <= 0) continue
    const id = String(e.customerId ?? '').trim()
    if (!id) continue // no identity, cannot attribute — excluded, not guessed
    const cur = byCustomer.get(id)
    if (cur) cur.amount += v
    else byCustomer.set(id, { name: e.customerName, amount: v })
  }

  const contributorCount = byCustomer.size
  let totalConsidered = 0
  for (const c of byCustomer.values()) totalConsidered += c.amount

  if (contributorCount === 0 || !Number.isFinite(totalConsidered) || !(totalConsidered > 0)) {
    return {
      hasData: false, totalConsidered: 0, contributorCount: 0,
      topAmount: 0, topCustomerId: null, topCustomerName: null,
      topShare: 0, topTiedCount: 0, material: false,
    }
  }

  let topId: string | null = null
  let topName: string | null = null
  let topAmount = 0
  for (const [id, c] of byCustomer) {
    if (c.amount > topAmount) { topAmount = c.amount; topId = id; topName = c.name }
  }
  // A strict `>` keeps the FIRST of equals as the named contributor; the count
  // of equals travels with it so the sentence can refuse to say "alone".
  let topTiedCount = 0
  for (const c of byCustomer.values()) if (c.amount === topAmount) topTiedCount++

  // Clamped defensively: a share should land in [0, 1] by construction (the
  // top contributor's own amount is part of the total it is divided by), but
  // floating-point summation order is not commutative, and a share the UI
  // reads as "104%" would be a worse failure than a share silently pinned to 100%.
  const topShare = Math.min(1, Math.max(0, topAmount / totalConsidered))

  return {
    hasData: true,
    totalConsidered: Math.round(totalConsidered),
    contributorCount,
    topAmount: Math.round(topAmount),
    topCustomerId: topId,
    topCustomerName: topName,
    topShare,
    topTiedCount,
    material: topShare >= CONCENTRATION_MATERIAL_SHARE,
  }
}

/**
 * The owner-facing sentence, or null when there is nothing to say — either no
 * data, or the concentration did not cross the material bar. ⛔ The caller must
 * not render a fallback in the null case; null IS the answer "nothing worth
 * flagging here".
 *
 * `formatMoney` is injected rather than imported, so this module stays
 * framework-agnostic and testable outside Next (the same discipline
 * growthEvidence's `evidenceSummary` uses — pure functions take a formatter,
 * they do not reach for one).
 */
export function concentrationNote(
  r: ConcentrationResult,
  formatMoney: (n: number) => string,
): string | null {
  if (!r.hasData || !r.material || !r.topCustomerId || !r.topCustomerName) return null
  // ⭐ Rounding said honestly. Whole percents match the tiles' precision, but
  // "100% … across 3 customers" is a contradiction, so a share that ROUNDS to
  // 100 while others exist reads "over 99%" instead of a number that is false.
  const rounded = Math.round(r.topShare * 100)
  const pct = rounded >= 100 ? 'over 99%' : `${rounded}%`
  // ⭐ "The only contributor" and "the largest of several" are both true
  // statements about a 100%-concentrated book with contributorCount === 1, but
  // they read very differently — the first is a statement of fact about a thin
  // book, the second implies competitors for the top spot that don't exist yet.
  // "Recurring projection" names the tile this sentence sits under; one-time
  // figures live on a different tile and are not in this denominator.
  if (r.contributorCount === 1) {
    return `${r.topCustomerName} is currently the ONLY customer behind the recurring projection (${formatMoney(r.topAmount)}). If that changes, the whole figure moves with it.`
  }
  // A tie at the top is a tie: nobody is "alone" there.
  if (r.topTiedCount > 1) {
    const others = r.topTiedCount - 1
    return `${r.topCustomerName} and ${others} other${others === 1 ? '' : 's'} each account for ${pct} of the recurring projection — ${formatMoney(r.topAmount)} each, of ${formatMoney(r.totalConsidered)} across ${r.contributorCount} customers.`
  }
  return `${r.topCustomerName} alone accounts for ${pct} of the recurring projection — ${formatMoney(r.topAmount)} of ${formatMoney(r.totalConsidered)} across ${r.contributorCount} customers.`
}
