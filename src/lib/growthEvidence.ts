// ── THE quality gate for money the Growth advisor puts on screen ─────────────
// A financial recommendation may only show a dollar figure when its evidence
// earns it. This module decides that, once, so every Growth surface refuses the
// same weak evidence for the same stated reason.
//
// ⛔ NOT AN ANALYTICS ENGINE, NOT A PRICING ENGINE, NOT A SECOND FORECAST.
// It computes no revenue and predicts nothing. It answers three questions about
// evidence that already exists:
//     1. WHICH records may be counted?        → exclusions, each one named
//     2. WHAT statistic represents them?      → robust, never a bare mean
//     3. MAY this be annualized, and by what? → only a DECLARED cadence
// and returns "not enough reliable data" whenever the honest answer is nothing.
//
// ⭐⭐ WHY THIS EXISTS. Measured on the real book (scripts/growth-evidence-audit.mjs,
// read-only, 127 customers · 213 jobs · 116 completed visits):
//
//   • 68.6% of customers with completed visits (35/51) have NO declared cadence,
//     and were annualized anyway — `visitsPerSeason(null)` returned
//     SEASON_VISITS.biweekly = 14. 28 such customers alone account for $138,144
//     of "annual opportunity" derived from no cadence evidence at all.
//   • 32 customers have exactly ONE completed visit. ×14 turns one visit into a year.
//   • 11.2% of completed visits (13/116) are UNPRICED, and `jobVisitValue`
//     returns 0 for them — so an unknown price enters every lifetime figure as
//     free work. (⭐ On this tenant there are ZERO owner-entered $0 prices, so
//     today's zeros are ALL unknowns. Both are still refused below: they are
//     different facts and neither is a price.)
//   • The visit-value distribution is severely skewed: median $70, mean $276
//     (3.94×), max $6,295 = 89.9× the median. Every per-visit figure in the
//     advisor was a MEAN (`ltv / completedCount`).

// ⭐ THE one fixture rule, imported rather than restated. lib/fixtureData is a
// pure leaf with no imports of its own, so this module stays as cheap to import
// as it was — which matters, because every Growth surface pulls it in.
import { isAnyFixtureName } from '@/lib/fixtureData'
import type { PriceState } from '@/lib/pricingState'

// ── 1. What may be counted ───────────────────────────────────────────────────
/**
 * Why a record was left out. Every exclusion is NAMED and surfaced to the owner —
 * "we ignored 3 visits" is only trustworthy if it says which kind and why.
 */
export type ExclusionReason =
  | 'unpriced'
  | 'no_charge'
  | 'fixture'
  | 'not_completed'
  | 'outlier'

export const EXCLUSION_COPY: Record<ExclusionReason, string> = {
  unpriced: 'no price recorded',
  // ⭐ Was 'priced at $0', inferred from `price === 0`. `no_charge` is the
  // owner's DECLARED write-off — reason and author recorded, CHECK-constrained —
  // so the sentence credits the paperwork instead of implying it is missing.
  no_charge: 'recorded as no charge',
  fixture: 'looks like test data',
  not_completed: 'not completed',
  outlier: 'far outside the normal range',
}

/**
 * ⭐⭐ THE SEAM IS CLOSED. `lib/pricingState` ANSWERS THIS NOW.
 *
 * This module used to carry `priceEvidence(rawPrice, derivedValue)`, which
 * decided `'ok' | 'unpriced' | 'zero_price'` by looking at the numbers itself.
 * Its own comment promised to delegate to Session 114's `lib/pricingState` the
 * day that landed. It landed (main `344e0670`, migration `20260830120000`
 * applied), so the promise is kept here: the question is not asked twice, and
 * this module no longer answers it AT ALL — callers pass the canonical verdict
 * in.
 *
 * ⭐ AND THE CANONICAL ANSWER IS BETTER, NOT MERELY SHARED. The old rule inferred
 * a decision from `price === 0`. `PriceState` distinguishes a THIRD case backed
 * by real columns and a CHECK constraint:
 *
 *     unpriced    nobody recorded a price          — a gap in the record
 *     no_charge   the owner declared it free, WITH a reason and an author
 *     priced      a real amount
 *
 * Both of the first two are refused as EVIDENCE — neither can set a per-visit
 * statistic, and free work earns nothing — but they are refused for different
 * stated reasons, which is the whole point of showing the owner what was
 * excluded. Telling someone who correctly recorded a write-off that their visit
 * had "no price recorded" is an accusation of sloppy bookkeeping.
 */
export type { PriceState }

/** How a canonical PriceState is reported when a visit is refused as evidence.
 *  ⛔ `priced` never reaches this — it is not an exclusion. */
export function exclusionForPriceState(s: PriceState): ExclusionReason | null {
  if (s === 'no_charge') return 'no_charge'
  if (s === 'unpriced') return 'unpriced'
  return null
}

/**
 * Does this text read as test/fixture data?
 *
 * ⭐⭐ ONE CLASSIFIER, AND IT IS NOT THIS FILE'S (Session 114). This used to keep
 * its own `FIXTURE_MARKERS` list beside lib/fixtureData's rule. Two engines for
 * one question is this codebase's proven failure mode, and these two were not
 * even equivalent — they disagreed in BOTH directions:
 *
 *   TOO BROAD   this list classified on SINGLE words. `/\bfixture\b/` hid
 *               "Light Fixture Installation"; `/^s\d{2,3}\s/` hid "S61 Roofing
 *               Ltd". An electrician and a roofer would each have watched their
 *               own revenue disappear out of Growth — the exact trust failure
 *               the comment below this one warns about.
 *
 *   TOO NARROW  it had no `VERIFY-` rule, so guard fixtures tagged that way were
 *               counted as REAL MONEY by the one report built to exclude them.
 *
 * ⚠️ Production divergence measured ZERO on the day they were merged — which is
 * exactly why this was worth fixing then rather than after a tenant in the
 * lighting or roofing trade signed up.
 *
 * ⛔ It remains a FLAG, not a verdict: excluding a real customer's revenue is as
 * much a trust failure as including a fixture's, so every exclusion is counted
 * and shown to the owner rather than applied silently. That is this file's job;
 * deciding WHAT a fixture is belongs to lib/fixtureData, which owns the two-tier
 * rule (classify machine markers only; merely test-LOOKING data is Tier 2 and
 * never acts).
 */
export function looksLikeFixture(...texts: Array<string | null | undefined>): boolean {
  return isAnyFixtureName(...texts)
}

// ── 2. What statistic represents them ────────────────────────────────────────
/** Ascending copy. Every quantile below reads from one sorted array. */
const sorted = (v: number[]) => [...v].sort((a, b) => a - b)

export function quantile(values: number[], p: number): number | null {
  if (!values.length) return null
  const s = sorted(values)
  const i = (s.length - 1) * p
  const lo = Math.floor(i), hi = Math.ceil(i)
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo)
}
export const median = (values: number[]): number | null => quantile(values, 0.5)

/**
 * ⭐⭐ THE ROBUST PER-VISIT FIGURE, and the reason it is not a mean.
 *
 * The advisor used `ltv / completedCount` everywhere. On the real book that mean
 * is **$276 against a median of $70** — 3.94× — because one $6,295 visit sits
 * 89.9× above the middle of the distribution. A single large job therefore
 * dominated the projection for any customer unlucky enough to have had one.
 *
 * The median fixes that by construction: it cannot be moved by how extreme an
 * outlier is, only by how many there are.
 *
 * ⛔ AND THAT IS WHY THERE IS NO AGGRESSIVE OUTLIER *EXCLUSION* HERE. The obvious
 * rule — drop anything past median + 5·MAD — was measured before being written:
 * MAD is $20, so the cut lands at $170 and would discard **21 of 103 priced
 * visits (20%)**, most of them ordinary larger jobs. That is not outlier
 * control, it is deleting a fifth of the revenue. The brief's instruction was
 * exact: do not invent arbitrary caps without measuring current data first.
 * A robust STATISTIC is the fix; mass exclusion is not.
 */
export function robustPerVisit(values: number[]): number | null {
  const usable = values.filter(v => Number.isFinite(v) && v > 0)
  if (!usable.length) return null
  return Math.round(median(usable) as number)
}

/**
 * How far the sample's own extreme sits above its middle. Reported to the owner
 * as context — NOT used to drop anything. It is what lets them see "one visit in
 * this sample is 90× the rest" and judge the figure themselves.
 */
export function skewNote(values: number[]): string | null {
  const usable = values.filter(v => Number.isFinite(v) && v > 0)
  if (usable.length < 3) return null
  const m = median(usable) as number
  const max = Math.max(...usable)
  if (!(m > 0) || max < m * 3) return null
  return `one visit is ${Math.round(max / m)}× the typical ${Math.round(m)}`
}

// ── 3. May this be annualized? ───────────────────────────────────────────────
/**
 * ⭐⭐ A CADENCE MUST BE DECLARED. IT IS NEVER INFERRED.
 *
 * Two inferences were doing this work, and both are refused here:
 *
 *   1. `visitsPerSeason(null) → SEASON_VISITS.biweekly` — an unknown cadence
 *      silently became fortnightly. 68.6% of customers with completed visits go
 *      through this path.
 *   2. `isRecurringProgramService(description)` — a regex on a service NAME
 *      (`/mow|grass cut|lawn care/`, `/fertiliz|weed control/`) deciding whether
 *      an add-on is billed 4×/year or once. ⛔ A NAME IS NOT A CADENCE. A
 *      business that calls its plan "Mowing" and one that calls it "Turf Care"
 *      would be annualized differently for the same work, and a snow contractor
 *      matches nothing at all.
 *
 * The only admissible source is a `job_recurrences` row whose frequency actually
 * resolves — the owner declared it. `null` in means `null` out, and null means
 * NO ANNUAL FIGURE, not a default one.
 */
export type DeclaredCadence = 'weekly' | 'biweekly' | 'monthly'

export function declaredCadence(freq: string | null | undefined): DeclaredCadence | null {
  return freq === 'weekly' || freq === 'biweekly' || freq === 'monthly' ? freq : null
}

/**
 * The visits-per-season multiplier for a DECLARED cadence, with the sentence
 * that explains it. Returns null for anything undeclared — callers must render
 * the insufficient-evidence state rather than reach for a fallback.
 *
 * The counts come from `lib/pricing.SEASON_VISITS` via the caller, so this module
 * introduces no second opinion about how long a season is.
 */
export interface Annualization {
  cadence: DeclaredCadence
  visitsPerSeason: number
  /** "$70 × 14 bi-weekly visits" — shown verbatim, so the owner can check it. */
  formula: string
}

export function annualize(
  perVisit: number,
  cadence: DeclaredCadence | null,
  visitsPerSeason: number | null,
): { annual: number; annualization: Annualization } | null {
  if (!cadence || !visitsPerSeason || !(perVisit > 0)) return null
  const label = cadence === 'biweekly' ? 'bi-weekly' : cadence
  return {
    annual: Math.round(perVisit * visitsPerSeason),
    annualization: {
      cadence,
      visitsPerSeason,
      formula: `$${Math.round(perVisit)} × ${visitsPerSeason} ${label} visits`,
    },
  }
}

// ── 4. The verdict ───────────────────────────────────────────────────────────
/**
 * How few priced visits is too few to speak from.
 *
 * ⭐ MEASURED, not chosen: 32 of the book's customers have exactly ONE completed
 * visit, and the old code annualized every one of them. A single observation has
 * no spread, so no robust statistic can be computed from it.
 *
 * ⭐⭐ AND THREE, NOT TWO — A CORRECTION THIS SESSION HAD TO MAKE OF ITSELF.
 * The threshold started at 2, the unit guard passed, and driving the REAL book
 * exposed it: one customer with exactly TWO visits contributed $86,058 of a
 * $109,130 headline (79%), through `$4,098 × 14 bi-weekly visits`.
 *
 * The reason is arithmetic, not taste: **the median of two points IS their
 * mean.** `median([70, 6295]) === 3182.5`. So at n=2 the robustness this whole
 * module rests on does not exist — it is a mean wearing the word "median", and
 * the outlier protection is exactly zero. At n=3 a single extreme value cannot
 * move the middle at all, which is the property being relied on.
 *
 * That is also why this is not an "arbitrary cap": it is the smallest sample for
 * which the chosen statistic actually behaves like itself.
 */
export const MIN_VISITS_FOR_VALUE = 3
export const MIN_VISITS_FOR_CONFIDENT = 5

export type EvidenceStrength = 'confident' | 'provisional' | 'insufficient'

/**
 * Everything the owner is entitled to see about a figure — ⭐ the transparency
 * contract. A recommendation that survives the gate MUST be able to answer all
 * of it, which is why it travels with the number instead of beside it.
 */
export interface Evidence {
  strength: EvidenceStrength
  /** How many records the figure is actually built from. */
  sampleSize: number
  /** What was left out, and why. */
  excluded: Array<{ reason: ExclusionReason; count: number }>
  /** The robust per-visit figure, or null. */
  perVisit: number | null
  /** The statistic used — named, so "average" is never assumed. */
  statistic: 'median visit value' | null
  /** Null unless a cadence was DECLARED. */
  annualization: Annualization | null
  /** The resulting annual figure, or null when it may not be claimed. */
  annual: number | null
  /** Plain-language caveat about spread, when the sample is skewed. */
  skew: string | null
}

export interface EvidenceInput {
  /** One entry per candidate record. */
  visits: Array<{
    /** ⭐ THE CANONICAL VERDICT, from lib/pricingState.jobPriceState(). This
     *  module does not re-derive it and has no opinion about prices. */
    priceState: PriceState
    /** lib/pricingState.jobAmountOrNull() — null is UNKNOWN, and a declared
     *  no-charge resolves to a known 0. ⛔ Never coerce either to a number here. */
    amount: number | null
    completed: boolean
    /** Any text that could betray a fixture — customer name, service, title. */
    labels?: Array<string | null | undefined>
  }>
  /** From job_recurrences only. ⛔ Never inferred from a name. */
  declaredFreq: string | null | undefined
  /** SEASON_VISITS[cadence], supplied by the caller. */
  visitsPerSeason: (c: DeclaredCadence) => number
}

/**
 * ⭐ THE ONE ASSESSMENT. Every Growth money figure goes through this, so an
 * exclusion rule cannot apply on one screen and not another.
 */
export function assessEvidence(inp: EvidenceInput): Evidence {
  const counts = new Map<ExclusionReason, number>()
  const drop = (r: ExclusionReason) => counts.set(r, (counts.get(r) ?? 0) + 1)
  const values: number[] = []

  for (const v of inp.visits) {
    if (!v.completed) { drop('not_completed'); continue }
    if (looksLikeFixture(...(v.labels ?? []))) { drop('fixture'); continue }
    // ⭐ The canonical verdict arrives already decided. `no_charge` and
    // `unpriced` are both refused as evidence — free work earns nothing and an
    // unknown is not a number — but they are counted under DIFFERENT reasons,
    // because what the owner is told about the exclusion is the point.
    const excludeAs = exclusionForPriceState(v.priceState)
    if (excludeAs) { drop(excludeAs); continue }
    // Belt as well as braces: `priced` should always carry an amount, but a
    // null here must never become a 0 in the sample.
    if (v.amount == null || !(v.amount > 0)) { drop('unpriced'); continue }
    values.push(v.amount)
  }

  const excluded = [...counts.entries()].map(([reason, count]) => ({ reason, count }))
  const perVisit = robustPerVisit(values)
  const sampleSize = values.length

  if (sampleSize < MIN_VISITS_FOR_VALUE || perVisit == null) {
    // ⛔ No figure at all. Not a small figure, not a hedged figure — none.
    return {
      strength: 'insufficient', sampleSize, excluded,
      perVisit: null, statistic: null, annualization: null, annual: null, skew: null,
    }
  }

  const cadence = declaredCadence(inp.declaredFreq)
  const ann = cadence ? annualize(perVisit, cadence, inp.visitsPerSeason(cadence)) : null

  return {
    strength: sampleSize >= MIN_VISITS_FOR_CONFIDENT ? 'confident' : 'provisional',
    sampleSize, excluded,
    perVisit,
    statistic: 'median visit value',
    annualization: ann?.annualization ?? null,
    // ⭐⭐ A per-visit figure survives without a cadence; an ANNUAL one does not.
    // This single null is the difference between "we know what a visit is worth"
    // and "we know what a year is worth", which the advisor used to collapse.
    annual: ann?.annual ?? null,
    skew: skewNote(values),
  }
}

// ── 5. What to say when the evidence is not there ────────────────────────────
/**
 * ⭐ ONE sentence, everywhere. The brief is explicit: weak evidence shows
 * "Not enough reliable data", never a confident dollar projection.
 */
export const INSUFFICIENT_LABEL = 'Not enough reliable data'

/** Why, in the owner's language — so the message is actionable, not just a refusal. */
export function insufficientReason(e: Evidence): string {
  if (e.sampleSize === 0) {
    const only = e.excluded.length === 1 ? e.excluded[0] : null
    if (only) return `Every visit we could count was ${EXCLUSION_COPY[only.reason]}.`
    return 'No completed, priced visits to measure.'
  }
  return `Only ${e.sampleSize} priced visit${e.sampleSize === 1 ? '' : 's'} — too few to project from.`
}

/** "3 visits · median visit value · no cadence set" — the audit line under a figure. */
export function evidenceSummary(e: Evidence): string {
  const parts: string[] = [`${e.sampleSize} visit${e.sampleSize === 1 ? '' : 's'}`]
  if (e.statistic) parts.push(e.statistic)
  parts.push(e.annualization ? e.annualization.formula : 'no cadence set — not annualized')
  const dropped = e.excluded.reduce((n, x) => n + x.count, 0)
  if (dropped) parts.push(`${dropped} excluded (${e.excluded.map(x => `${x.count} ${EXCLUSION_COPY[x.reason]}`).join(', ')})`)
  return parts.join(' · ')
}

/**
 * ⛔ THE DISPLAY GATE. May a dollar figure be shown at all?
 * `annual` requires a declared cadence; `perVisit` requires only a real sample.
 */
export function mayShowAnnual(e: Evidence): boolean {
  return e.strength !== 'insufficient' && e.annual != null && e.annual > 0
}
export function mayShowPerVisit(e: Evidence): boolean {
  return e.strength !== 'insufficient' && e.perVisit != null && e.perVisit > 0
}
