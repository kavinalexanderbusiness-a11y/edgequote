// ── QUARANTINED: the season keyword guess ────────────────────────────────────
// Session 110.
//
// ⛔⛔ NOTHING IN `src/` MAY IMPORT THE SEASON RESOLVER BELOW. This module holds
// the logic that USED to decide which season governs a recurring series, by
// matching keywords against the service's NAME. It is kept because the migration
// needs it exactly once; it is quarantined because it must never decide anything
// again.
//
// ── WHY IT WAS REMOVED FROM THE RUNTIME ─────────────────────────────────────
// Measured on production 2026-08-29:
//
//   14 series named "…Mowing" / "Lawn Mowing" → matched → lawn season, bounded ✅
//    1 series named "Bi-weekly"               → matched NOTHING → no season, no
//                                               end_date, 24 future visits
//                                               generated to 2027-07-31
//    1 series named "General Upkeep"          → matched NOTHING → no season
//
// Identical cadence, identical intent, opposite outcome — decided entirely by
// what the owner typed into a name field. ⛔ A NAME IS NOT A RELATIONSHIP.
// Renaming a service must never change when it runs, and a trade whose
// vocabulary we did not anticipate must not silently lose its season.
//
// ── ITS ONLY TWO LEGITIMATE CALLERS ─────────────────────────────────────────
//   • scripts/season-reconcile.ts — SUGGESTS a season for each existing series,
//     for a human to accept or correct.
//   • the season_key backfill in the migration — applies those accepted
//     suggestions ONCE.
//
// Both are one-time migration paths. verify:season-recurrence fails if any file
// under src/ imports the resolver, so the quarantine is enforced rather than
// requested.

import { resolveSeriesSeason, type ServiceSeason, type ServiceSeasons } from '@/lib/seasons'

/**
 * ⭐⭐ THE ONE SWITCH. False while the book still contains series that have not
 * declared a season; true once every series has one.
 *
 * ⚠️ IT IS FALSE ON PURPOSE, AND FLIPPING IT IS THE LAST STEP OF THE MIGRATION,
 * NOT THE FIRST. `job_recurrences.season_key` is proposed, not applied
 * (supabase/proposals/), so today NO series has a declaration. Removing the
 * bridge before the column lands does not make the product correct — it makes
 * 17 live series seasonless at once, which silently costs real behaviour:
 * "a snow customer in July is dormant, not lost" stops being true, renewals
 * lose the season that gives a plan its ending, and off-season customers
 * re-enter the chase queue.
 *
 * ⭐ What is ALREADY structural, flag or no flag: `resolveSeriesSeason` has no
 * parameter a service name can arrive through, so a DECLARED season can never
 * be overridden by a rename. The flag only governs what happens for a series
 * that has declared NOTHING.
 *
 * S106: flip this to `true` in the same change that completes the backfill.
 * verify:season-recurrence proves the end state — with it true, nothing infers.
 */
// ⚠️ Typed `boolean`, not inferred as the literal `false`. A literal type makes
// every "what happens when this is true" check a compile error, which would mean
// the END STATE could never be asserted — the guard would be unable to test the
// half of the transition that actually matters.
export const SEASON_DECLARATIONS_COMPLETE: boolean = false

/**
 * THE only runtime path that may consult a service name, and only while
 * declarations are incomplete.
 *
 * A declaration ALWAYS wins — that is `resolveSeriesSeason`, unchanged and
 * name-free. This adds exactly one behaviour: while the book is mid-migration,
 * an UNDECLARED series falls back to the legacy guess so the product does not
 * regress under owners who have not been asked yet.
 */
export function bridgeSeasonForSeries(
  seasonKey: string | null | undefined,
  serviceType: string | null | undefined,
  seasons: ServiceSeasons,
): ServiceSeason | null {
  const declared = resolveSeriesSeason({ seasonKey: seasonKey ?? null }, seasons)
  if (declared.source !== 'unknown') return declared.season
  if (SEASON_DECLARATIONS_COMPLETE) return null
  const key = inferSeasonKeyFromName(serviceType, seasons)
  return key ? (seasons[key] ?? null) : null
}

// Hints match at a WORD START (prefix), so "Weekly Mowing", "Monthly Lawn Care"
// and "Fertilization" read as lawn, and "Snow Removal/Blowing/Clearing" as snow.
//
// ⚠️ The word boundary is load-bearing, not tidiness. These were once plain
// substring tests, and 'ice' is inside serv·ice — so EVERY service with
// "Service" in its name classified as snow, and snow is tested first, so it won
// even when the string said "Lawn". Snow's season is Nov–Mar, so those customers
// silently left the re-book and reactivation queues for the whole mowing season.
// Kept exactly as it was, because the migration must reproduce the OLD
// behaviour's suggestion — not a corrected one nobody has reviewed.
export const LAWN_HINTS = ['mow', 'lawn', 'fertiliz', 'fertilis', 'grass', 'aerat', 'trim', 'edge']
export const SNOW_HINTS = ['snow', 'ice', 'plow', 'plough', 'salt', 'shovel']

const hintRe = (h: string) => new RegExp(`\\b${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')
export const matchesHint = (s: string, hints: string[]) => hints.some(h => hintRe(h).test(s))

/**
 * The season KEY a service name would have been guessed into, or null.
 *
 * ⭐ Returns a KEY rather than a season object, deliberately: a suggestion is a
 * proposed DECLARATION for a human to store, not a resolved season to act on.
 * The difference is the whole repair.
 */
export function inferSeasonKeyFromName(
  serviceType: string | null | undefined,
  seasons: ServiceSeasons,
): string | null {
  const s = (serviceType || '').toLowerCase()
  if (!s) return null
  // Owner-defined custom seasons win first — their `match` words are theirs, and
  // an owner's vocabulary beats ours. Keys are SORTED because Postgres jsonb
  // canonicalises key order on save, so an unsorted walk could pick a different
  // season before and after a reload with no edit by the owner.
  for (const key of Object.keys(seasons).sort()) {
    if (key === 'lawn' || key === 'snow') continue
    const m = seasons[key]?.match
    if (m?.some(w => w && matchesHint(s, [w.toLowerCase()]))) return key
  }
  if (matchesHint(s, SNOW_HINTS)) return 'snow'
  if (matchesHint(s, LAWN_HINTS)) return 'lawn'
  return null
}

/**
 * Service-type → coarse category, for grouping that is NOT season governance.
 *
 * ⚠️ Still a keyword test, and still exported, because "does this property
 * already have a lawn-ish series?" is a duplicate-detection question, not a
 * question about when work runs. It decides nothing about scheduling. ⛔ It must
 * never be used to resolve a season — verify:season-recurrence pins that.
 */
export type SeasonCategory = 'lawn' | 'snow' | 'year_round'
export function serviceCategory(serviceType: string | null | undefined): SeasonCategory {
  const s = (serviceType || '').toLowerCase()
  if (matchesHint(s, SNOW_HINTS)) return 'snow'
  if (matchesHint(s, LAWN_HINTS)) return 'lawn'
  return 'year_round'
}
