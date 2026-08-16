import type { ServiceTemplate } from '@/types'

// ── THE PRICE BOOK — what the catalogue offers a new quote, and what it may not
//
//   npm run verify:price-book
//
// ══ THE CATALOGUE ALREADY EXISTED. THIS IS NOT A SECOND ONE ══════════════════
// `service_templates` IS the price book, and has been since the product had one.
// It owns the name, the category, the customer-facing `default_description`, the
// `default_rate` + `pricing_display_type` that say what kind of number that rate
// is, the cost columns, favourites, `recurrence`, and `is_active` (the archive).
// Session 76 added exactly two facts an owner had no way to record — how long the
// work takes (`default_minutes`) and how many people it needs (`default_crew_size`)
// — and this module is where those are READ. There is no new table, no new rate
// concept, and ⛔ no pricing engine: not one function here multiplies, discounts,
// marks up or recommends a price. `default_rate` is passed through untouched or
// not at all. Pricing stays where it is ([[pricing-experience-locked]]).
//
// ══ ⭐⭐ A DEFAULT IS A STARTING POINT, NEVER A LIVE LINK ═════════════════════
// Everything here answers ONE question: "what should this line START as?" It is
// asked once, when a service is picked or a bundle is applied, and the answer is
// COPIED into the quote. From that moment the quote owns its own numbers.
//
// THE HISTORICAL-TRUTH GUARANTEE IS STRUCTURAL, NOT A RULE.
// There is no live reference from a saved line back to the catalogue's price,
// description or duration. `quote_services` stores its own `service_type`,
// `unit_price`, `est_minutes` and `notes`; the quote stores its own `notes` (the
// description, copied by the builder at pick time). `service_template_id` is kept
// — it records WHICH catalogue row was used, and is what lets the picker offer
// "Recent" and what decides which pricing engine may recommend — but ⛔ nothing
// re-reads that row's rate or text to RENDER a quote. So re-pricing the price
// book next month cannot reach a quote already sent or accepted: there is nothing
// to follow. Service Bundles proved this shape first (copy-not-live-link,
// guaranteed by the ABSENCE of a bundle_id), and the guard asserts the absence so
// nobody helpfully adds provenance later.
//
// ⚠️ THE ONE SUBTLETY, stated so it is not rediscovered: an ARCHIVED service
// (`is_active = false`) must still render correctly on an old quote. It does,
// because the quote copied the NAME — nothing renders through the catalogue row.
// The builder additionally re-admits an inactive template that the quote being
// edited already points at, so editing an old quote does not silently blank its
// service. Archive hides a service from FUTURE picking; it never edits the past.
//
// ══ THE THREE DURATIONS ARE THREE DIFFERENT CLAIMS ══════════════════════════
//   CATALOGUE default  — `service_templates.default_minutes`. What the owner
//                        TYPED once: "this normally takes 90 minutes."
//   LEARNED estimate   — the median of what the work HAS TAKEN, derived at read
//                        time by lib/estimateVsActual + lib/workEstimate from the
//                        stopwatch. ⛔ Never stored, so it can never be overwritten.
//   THIS job's figure  — `quote_services.est_minutes` / `jobs.duration_minutes`.
//                        What the owner decided about THIS piece of work.
//
// They are ranked by lib/dayFit `resolveDuration`: own → learned → catalogue →
// unknown, with the catalogue THIRD on purpose. See that function's header for
// why a typed default must never outrank measured evidence. ⭐ This module owns
// no threshold, no median and no precedence of its own — it hands the catalogue
// figure to the one resolver and stays out of the way.
//
// ══ CREW: DEFAULT ≠ ASSIGNED ≠ ACTUAL ═══════════════════════════════════════
// `default_crew_size` is the catalogue's expectation only. It is NOT the crew
// scheduled onto a visit, and it is NOT who actually worked it (`job_work_sessions`
// records that, per day, with its own arithmetic). This module never reconciles
// the three, never writes the other two, and never presents one as another —
// they answer "how many does this normally need", "how many are booked", and
// "how many turned up", and those genuinely differ every week.

/** What a catalogue row offers a new line. Every field is nullable-or-passthrough:
 *  this is a report of what the catalogue SAYS, not a decision about what to use. */
export interface CatalogDefaults {
  /** Elapsed on-site minutes the owner typed. null = not stated (never 0). */
  minutes: number | null
  /** Workers the owner says this normally needs. null = not stated. */
  crewSize: number | null
  /** The catalogue rate, passed through untouched. */
  rate: number
  /** What kind of number `rate` is — `starting_from`, `hourly`, `per_sqft`, … */
  pricingDisplayType: string
  /** The customer-facing scope, copied into a quote's notes at pick time. */
  description: string | null
}

/**
 * Read a catalogue row's defaults, normalising the "not stated" cases ONCE.
 *
 * ⭐ The `> 0` test is the whole point. A stored 0 (or a NaN from a bad read)
 * must come back as null — "we haven't said" — because every downstream consumer
 * treats 0 as absence already and a 0 that survived as a number would mean "this
 * job takes no time" to lib/dayFit and "this job needs nobody" to a crew display.
 * The DB CHECKs refuse 0, so this is belt-and-braces for rows that predate them
 * and for anything arriving through a client that did not.
 */
export function catalogDefaults(t: ServiceTemplate): CatalogDefaults {
  const min = Number(t.default_minutes)
  const crew = Number(t.default_crew_size)
  return {
    minutes: Number.isFinite(min) && min > 0 ? Math.round(min) : null,
    crewSize: Number.isFinite(crew) && crew >= 1 ? Math.round(crew) : null,
    rate: Number(t.default_rate) || 0,
    pricingDisplayType: t.pricing_display_type,
    description: t.default_description?.trim() || null,
  }
}

/** The catalogue's typed duration for a template id, or null. The shape
 *  `resolveDuration`'s third argument wants, resolved through a map the caller
 *  already has. An id that no longer resolves (deleted service) is null, not 0 —
 *  history can name things that are not on offer today. */
export function catalogMinutesFor(
  templateId: string | null | undefined,
  templates: Map<string, ServiceTemplate>,
): number | null {
  if (!templateId) return null
  const t = templates.get(templateId)
  return t ? catalogDefaults(t).minutes : null
}

/** The catalogue's typical crew for a template id, or null. */
export function catalogCrewFor(
  templateId: string | null | undefined,
  templates: Map<string, ServiceTemplate>,
): number | null {
  if (!templateId) return null
  const t = templates.get(templateId)
  return t ? catalogDefaults(t).crewSize : null
}

// ── Bundles follow the catalogue for TIME exactly as they do for PRICE ───────
//
// `service_bundle_items.unit_price` has always been NULLABLE-means-follow-the-
// catalogue: re-price a service in Settings and every future quote from every
// bundle follows, with no bundle to re-edit (lib/serviceBundles `resolveUnitPrice`).
// `est_minutes` was nullable too, but had nowhere to fall back TO — the catalogue
// could not state a duration — so a bundle item with no minutes produced 0 and the
// owner retyped it on every quote. That was the same defect in the same table,
// left standing only because half the answer did not exist yet. Now it does, and
// duration resolves through the identical rule so the two cannot drift.
//
// ⚠️ `!= null`, never `??` or truthiness — for minutes as for price. The bundle
// storing an explicit figure means the owner typed one that was not the
// catalogue's, and that includes deliberately-short lines.

/** Minutes for a bundle line: the bundle's own figure, else the catalogue's, else
 *  0. Returns 0 (not null) because that is what the builder's line shape uses for
 *  "not stated" — `QuoteServiceInput.est_minutes` is a number, and every consumer
 *  reads `> 0`. */
export function resolveEstMinutes(
  item: { est_minutes?: number | null; service_template_id?: string | null },
  templates: Map<string, ServiceTemplate>,
): number {
  const own = Number(item.est_minutes)
  if (item.est_minutes != null && Number.isFinite(own) && own > 0) return Math.round(own)
  return catalogMinutesFor(item.service_template_id, templates) ?? 0
}

/** Where a line's duration came from — the same three-way answer `priceBasis`
 *  gives for money, and for the same reason: a preview must be able to say
 *  whether a number is the bundle's, the catalogue's, or absent. */
export function durationBasis(
  item: { est_minutes?: number | null; service_template_id?: string | null },
  templates: Map<string, ServiceTemplate>,
): 'bundle' | 'catalogue' | 'unstated' {
  const own = Number(item.est_minutes)
  if (item.est_minutes != null && Number.isFinite(own) && own > 0) return 'bundle'
  return catalogMinutesFor(item.service_template_id, templates) != null ? 'catalogue' : 'unstated'
}

// ── Saying where a duration came from ────────────────────────────────────────

/**
 * How a resolved duration may be SPOKEN. The number is the same; the claim is
 * the part that can be false, so each source gets its own words.
 *
 * ⭐ 'catalog' says "your default" — possessive, and pointedly not "typical",
 * which lib/dayFit reserves for 'learned'. An owner reading "typical" fairly
 * concludes the product measured something. Here it measured nothing; it is
 * repeating what they typed.
 */
export function describeDurationSource(
  source: 'estimate' | 'learned' | 'catalog' | 'unknown',
): string | null {
  switch (source) {
    case 'estimate': return 'this quote'
    case 'learned': return 'past visits'
    case 'catalog': return 'your service default'
    case 'unknown': return null
  }
}
