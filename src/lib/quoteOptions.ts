// ── Quote options — mutually exclusive alternatives for one job ──────────────
// THE one place that answers "what does a quote with options cost?", so the
// builder, the PDF, the portal, the owner's accept dialog and the guards can
// never reach different answers.
//
// ⭐ THE WHOLE MODEL, in one sentence: an option's price is not a component of
// the quote's price — it IS the quote's price, for whoever picks it. Nothing
// here sums options, and nothing anywhere else can, because the money lives in
// a single column (`quotes.initial_price`) that holds exactly one option's
// price at a time. `quotes.total` is a STORED GENERATED column over it
// (initial_price + travel_fee), which is why the invoice conversion, job
// costing, the deposit engine and pipeline reporting all stayed correct without
// a line of change: they read `total`, and `total` was never given the chance to
// mean "all three".
//
// ⛔ NOT the recurring cadence prices. weekly/biweekly/monthly are CADENCE
// alternatives for one scope and are a different question with a different
// answer (and are still not selectable — see the portal's planOptions block).
// A quote may carry both; they never interact.

import type { QuoteOption } from '@/types'

/** How many alternatives a quote may offer. Mirrors the DB's own limit
 *  (quote_options_shape_guard) — comparison is the point, and it stops working
 *  somewhere around four columns on a phone. */
export const MAX_QUOTE_OPTIONS = 4
/** Fewer than two alternatives is not a choice. The builder refuses to save a
 *  one-option quote as an options quote; readers still render whatever exists
 *  rather than silently ignoring a row. */
export const MIN_QUOTE_OPTIONS = 2

/** Anything with a price and an order. Lets the pure helpers below run against
 *  DB rows, portal payload rows and half-typed builder rows alike. */
export interface OptionLike {
  id?: string
  name: string
  description?: string | null
  price: number | string
  sort_order?: number
  is_recommended?: boolean
}

/** Does this quote offer alternatives? THE predicate — every surface asks it
 *  the same way, so none of them can disagree about which kind of quote this is. */
export function hasOptions(options: OptionLike[] | null | undefined): boolean {
  return (options?.length ?? 0) > 0
}

/** The owner's order, with the recommended one findable. Never re-sorts by
 *  price: an owner who puts Premium first meant to. */
export function sortedOptions<T extends OptionLike>(options: T[] | null | undefined): T[] {
  return [...(options || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
}

export function recommendedOption<T extends OptionLike>(options: T[] | null | undefined): T | null {
  return sortedOptions(options).find(o => o.is_recommended) ?? null
}

/**
 * THE price a quote with options carries before anyone has chosen — the
 * recommended option, else the first.
 *
 * This is what `quotes.initial_price` is set to at save time, and it is the
 * reason a multi-option quote can be sent at all: `sendBlockedReason` refuses a
 * quote whose total is null or zero, and every reporting surface would read a
 * pipeline of £0. Showing the recommended figure is the honest choice available
 * — it is a real price the owner really offered — but note what it means:
 * ⚠️ a multi-option quote reports at its RECOMMENDED price until the customer
 * chooses, at which point it reports at the chosen one.
 */
export function headlineOptionPrice(options: OptionLike[] | null | undefined): number | null {
  const list = sortedOptions(options)
  if (!list.length) return null
  const rec = list.find(o => o.is_recommended) ?? list[0]
  const n = Number(rec.price)
  return Number.isFinite(n) ? n : null
}

/**
 * The option this quote is currently priced at: the SELECTED one once the
 * customer has chosen, otherwise the recommended/first.
 *
 * `selectedId` comes from `quotes.selected_option_id`, whose composite foreign
 * key guarantees it belongs to this quote — so a non-null id that matches
 * nothing here means the caller mixed up two quotes, and the honest answer is
 * null rather than quietly falling back to the recommended one and presenting
 * somebody else's choice as this customer's.
 */
export function activeOption<T extends OptionLike>(
  options: T[] | null | undefined,
  selectedId: string | null | undefined,
): T | null {
  const list = sortedOptions(options)
  if (!list.length) return null
  if (selectedId) return list.find(o => o.id === selectedId) ?? null
  return list.find(o => o.is_recommended) ?? list[0]
}

/** Has the customer actually chosen? Distinct from "a recommended option
 *  exists" — the whole point of the feature is that those are different facts. */
export function isSelected(selectedId: string | null | undefined): boolean {
  return !!selectedId
}

export type OptionProblem =
  | 'too_few' | 'too_many' | 'unnamed' | 'no_price' | 'duplicate_name' | 'many_recommended'

/**
 * Why this set of options cannot be saved yet, or null when it can. Pure, so
 * the builder's inline message and the guard's assertions come from one rule.
 *
 * Prices of zero are allowed on purpose: "included" and "no charge" are real
 * tiers. It is the QUOTE having no price that is blocked, and that is
 * sendBlockedReason's job — one gate, where it already lives.
 */
export function optionSetProblem(options: OptionLike[] | null | undefined): OptionProblem | null {
  const list = options || []
  if (list.length < MIN_QUOTE_OPTIONS) return 'too_few'
  if (list.length > MAX_QUOTE_OPTIONS) return 'too_many'
  if (list.some(o => !String(o.name ?? '').trim())) return 'unnamed'
  if (list.some(o => !Number.isFinite(Number(o.price)) || Number(o.price) < 0)) return 'no_price'
  const names = list.map(o => String(o.name).trim().toLowerCase())
  if (new Set(names).size !== names.length) return 'duplicate_name'
  if (list.filter(o => o.is_recommended).length > 1) return 'many_recommended'
  return null
}

/** What to tell the owner. Kept beside the rule so a new problem cannot be
 *  added without a sentence for it. */
export function optionProblemMessage(p: OptionProblem): string {
  switch (p) {
    case 'too_few': return `Offer at least ${MIN_QUOTE_OPTIONS} options, or turn options off for a single price.`
    case 'too_many': return `A quote can offer at most ${MAX_QUOTE_OPTIONS} options.`
    case 'unnamed': return 'Give every option a name — that’s what the customer picks between.'
    case 'no_price': return 'Give every option a price.'
    case 'duplicate_name': return 'Two options share a name — the customer couldn’t tell them apart.'
    case 'many_recommended': return 'Only one option can be marked Recommended.'
  }
}

/** Rows ready for `quote_options`, renumbered from their position so the stored
 *  order is always the order on screen. The caller supplies quote_id/user_id —
 *  this never guesses tenancy. */
export function optionRowsFor(
  options: OptionLike[],
  quoteId: string,
  userId: string,
): Array<{ quote_id: string; user_id: string; name: string; description: string | null; price: number; sort_order: number; is_recommended: boolean }> {
  return options.map((o, i) => ({
    quote_id: quoteId,
    user_id: userId,
    name: String(o.name).trim(),
    description: String(o.description ?? '').trim() || null,
    price: Number(o.price) || 0,
    sort_order: i,
    is_recommended: !!o.is_recommended,
  }))
}

/** A duplicate of an option, ready to become the next tier — same scope text to
 *  edit down or up, never the Recommended badge (two would be meaningless, and
 *  the DB refuses it anyway). */
export function duplicateOption(o: OptionLike, existing: OptionLike[]): OptionLike {
  const base = String(o.name).trim()
  const taken = new Set(existing.map(x => String(x.name).trim().toLowerCase()))
  let name = `${base} 2`
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} ${i + 1}`
  return { name, description: o.description ?? '', price: Number(o.price) || 0, is_recommended: false }
}

/** A blank option for the builder's "Add option" button. */
export function emptyOption(index: number): OptionLike {
  return { name: '', description: '', price: 0, is_recommended: index === 0 }
}

/** The three names an owner recognises, seeded into a fresh editor as EXAMPLES —
 *  every one of them is a plain editable text field. ⛔ Nothing in this feature
 *  branches on these strings: "Budget/Standard/Premium" is a convention, and
 *  `is_recommended` is the only structural distinction that exists. The badge is
 *  deliberately not on the row called "Standard" by any rule — it is on whichever
 *  row the owner put it on, and the seed just has to start somewhere. */
export const EXAMPLE_OPTION_NAMES: ReadonlyArray<{ name: string; is_recommended: boolean }> = [
  { name: 'Budget', is_recommended: false },
  { name: 'Standard', is_recommended: true },
  { name: 'Premium', is_recommended: false },
]

// ── Reporting: is this figure PROPOSED or CHOSEN? ────────────────────────────
/**
 * ⭐ THE distinction the owner's reporting needs, derived from the selection
 * state that already exists — no second column, no second engine.
 *
 *   null        this is an ordinary quote; the question doesn't arise
 *   'proposed'  it offers alternatives and nobody has chosen — the figure is the
 *               RECOMMENDED option, a real price really offered, but not agreed
 *   'selected'  a choice was made and the figure IS what was bought
 *
 * The figure itself is `quotes.total` in both cases, which is the entire reason
 * pipeline, job costing, invoice conversion and the deposit engine needed no
 * change: this function says what the number MEANS, never what it is. ⛔ It must
 * never be used to compute money — the moment it is, there are two answers.
 */
export type OptionValueBasis = 'proposed' | 'selected'
export function optionValueBasis(
  options: OptionLike[] | null | undefined,
  selectedId: string | null | undefined,
): OptionValueBasis | null {
  if (!hasOptions(options)) return null
  return isSelected(selectedId) ? 'selected' : 'proposed'
}

/** One sentence per basis, so every surface says it the same way. `name` is the
 *  active option's name — activeOption() already found it. */
export function optionValueBasisLabel(basis: OptionValueBasis, name: string, count: number): string {
  return basis === 'selected'
    ? `Chosen: ${name}`
    : `Proposed at ${name} — ${count} option${count === 1 ? '' : 's'} offered, none chosen yet`
}

// ── The rule the builder must enforce BEFORE the database does ───────────────
/**
 * Alternatives and additive service lines cannot coexist (the DB's
 * quote_options_shape_guard refuses it with a check_violation). The owner must
 * hear that as a sentence while both are still on screen, not as a constraint
 * error after tapping Save — so this pure predicate is asked by the builder and
 * asserted by the guard, from one definition.
 */
export function optionsConflictWithLines(optionsOn: boolean, lineCount: number): boolean {
  return optionsOn && lineCount > 0
}
export const OPTIONS_VS_LINES_MESSAGE =
  'Options replace the line-by-line breakdown — an option’s price is the whole job, so extra service or material lines would double-count. Remove them, or turn options off.'

/** Convenience for readers holding real DB rows. */
export type QuoteOptionRow = QuoteOption
