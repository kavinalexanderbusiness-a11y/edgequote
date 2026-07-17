import type { QuoteService, QuoteServiceInput, QuoteLineKind } from '@/types'

// ── Materials on a quote ─────────────────────────────────────────────────────
// The customer-facing half of materials, and deliberately nothing else.
//
// A material line is an ESTIMATE ON A DOCUMENT. It is the same species as a
// service line — quantity × unit_price, discounted by the one discount engine —
// and it rides quote_services under `kind`, not a second table. A second line
// table would mean a second price rollup (quotes.initial_price is Σ line nets),
// and two sums in the money column always drift.
//
// ⚠️ WHAT THIS FILE MUST NEVER GROW:
//   · no reservation, no allocation — a reservation isn't a movement, so it
//     needs its own count, and then "on hand" and "available" disagree
//   · no stock deduction — part_movements is the only thing that moves stock,
//     and qty_on_hand = sum(part_movements.qty) is not this file's business
//   · no part_id link — that's Inventory V2 Stage 2, and it needs a cost model
//   · NO COST, and no margin. What a material costs the business is the
//     Pricing V2 Phase 1 / Inventory D1 question — ONE canonical cost model,
//     platform-wide. A cost field here would pre-empt that decision and become
//     the second cost model the whole V2 effort exists to prevent.
// This file knows what you CHARGE. It does not know what you PAID.
//
// The arithmetic lives in lib/quoteServices (serviceLineTotals) and is not
// re-implemented here — a material line sums exactly like every other line.

/** A suggested material: a name and the unit its trade actually buys it in. */
export interface MaterialSuggestion {
  label: string
  /** A service_units code — see lib/units. Never a unit invented here. */
  unit: string
  hint?: string
}

// The starter vocabulary. SUGGESTIONS, not a catalogue: they prefill a name and
// a sensible unit, and the owner types over either. Nothing is stored, nothing is
// enforced, and a material that isn't on this list is just a line you name
// yourself — exactly like a service.
//
// Landscape-first because that's the trade that asked, but nothing here is
// lawn-gated: an irrigation fitting and a bag of fertiliser are the same shape
// of line for any trade that supplies goods. When trade packs learn to seed
// materials, this list is what they'd replace — see the roadmap's Stage 3.2.
export const MATERIAL_SUGGESTIONS: MaterialSuggestion[] = [
  { label: 'Mulch',            unit: 'cubic_yard', hint: 'Bark, cedar, or coloured' },
  { label: 'Topsoil',          unit: 'cubic_yard', hint: 'Screened or triple-mix' },
  { label: 'Gravel',           unit: 'ton',        hint: 'Also sold by the yard' },
  { label: 'Rock',             unit: 'ton',        hint: 'Decorative or river rock' },
  { label: 'Sod',              unit: 'sqft',       hint: 'Or by the pallet' },
  { label: 'Fertilizer',       unit: 'bag' },
  { label: 'Plants',           unit: 'each',       hint: 'Trays for annuals' },
  { label: 'Irrigation parts', unit: 'each',       hint: 'Heads, valves, fittings' },
]

/** A blank material line for the builder. Mirrors emptyServiceLine's contract. */
export function emptyMaterialLine(): QuoteServiceInput {
  return {
    service_type: '', service_template_id: '', quantity: 1, unit: 'each', unit_price: 0,
    // Materials take no labour of their own — spreading the mulch is the service
    // line's minutes. A number here would inflate the job's duration twice, since
    // scheduleQuote sums hours×60 + every extra's est_minutes.
    est_minutes: 0,
    discount_type: '', discount_value: 0, notes: '', kind: 'material',
  }
}

/** Prefill a line from a suggestion, keeping whatever the owner already typed. */
export function applySuggestion(line: QuoteServiceInput, s: MaterialSuggestion): QuoteServiceInput {
  return { ...line, service_type: s.label, unit: s.unit }
}

const kindOf = (l: { kind?: QuoteLineKind | null }): QuoteLineKind => l.kind ?? 'service'

/** Rows with no kind read as 'service' — matching the column default, so a line
 *  written before this shipped can never be mistaken for a material. */
export function isMaterial(line: { kind?: QuoteLineKind | null }): boolean {
  return kindOf(line) === 'material'
}

export function splitByKind<T extends { kind?: QuoteLineKind | null }>(lines: T[]): {
  services: T[]; materials: T[]
} {
  return {
    services: lines.filter(l => !isMaterial(l)),
    materials: lines.filter(l => isMaterial(l)),
  }
}

/**
 * Whether the quote has anything worth showing a Materials section for.
 * Used to keep the section out of the way of trades that never supply goods —
 * it appears because you added a material, not because of who you are.
 */
export function hasMaterials(lines: { kind?: QuoteLineKind | null }[]): boolean {
  return lines.some(isMaterial)
}

/**
 * The primary line (sort_order 0) is the quote's identity — quotes.service_type
 * caches its label and the builder maps it to the classic single-service fields.
 * A material must never hold that slot: a quote whose identity is "Mulch" reads
 * as a mulch delivery, and the job it schedules would carry no labour at all.
 * The builder enforces this by construction (materials are always extras); this
 * is the assertion that says so out loud for any future caller.
 */
export function isValidPrimary(line: Pick<QuoteService, 'kind'> | QuoteServiceInput): boolean {
  return !isMaterial(line)
}
