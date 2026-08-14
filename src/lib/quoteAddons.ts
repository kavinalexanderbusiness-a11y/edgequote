// ── Quote add-ons — optional extras the customer chooses BEFORE approving ────
// THE one place that answers "what does this quote cost with these extras?", so
// the builder, the PDF, the portal's Approve dialog, the owner's accept-on-behalf
// dialog and the guards can never reach different answers.
//
// ⭐ THE WHOLE MODEL, in one sentence: an add-on's price is a component of the
// quote's price ONLY once someone has chosen it — and until then it is not part
// of any figure anywhere. Nothing here sums an unselected extra, and nothing
// elsewhere can, because the money lives in a single column
// (`quotes.addons_total`) written by ONE database trigger over
// `is_selected` rows. `quotes.total` is a STORED GENERATED column over it
// (initial_price + travel_fee + addons_total), which is why the invoice
// conversion, job costing, the deposit engine and pipeline reporting stayed
// correct without a line of change: they read `total`, and `total` was never
// given the chance to mean "everything on offer".
//
// ⛔ NOT quote options (lib/quoteOptions). An option is an ALTERNATIVE — its
// price REPLACES the quote's price and exactly one is bought. An add-on ADDS,
// and any number of them (including none) can be. The two compose:
//
//     accepted = (chosen option ?? base) + travel + Σ SELECTED add-ons
//
// ⛔ NOT change orders (lib/changeOrders). A change order is additional scope
// authorised AFTER approval and it mints its own billable line. Add-ons are
// decided BEFORE approval and are frozen by the database the moment the quote
// is. Once a quote is accepted, new work is a change order — never an edit here.

import type { QuoteAddon } from '@/types'

/** How many optional extras a quote may offer. Mirrors the DB's own limit
 *  (quote_addons_write_guard). A list of extras is something a customer reads
 *  and decides on; past half a dozen it is a catalogue, and they stop reading. */
export const MAX_QUOTE_ADDONS = 6

/** Anything with a name, a price and a selection state. Lets the pure helpers
 *  below run against DB rows, portal payload rows and half-typed builder rows
 *  alike. */
export interface AddonLike {
  id?: string
  name: string
  description?: string | null
  price: number | string
  sort_order?: number
  is_selected?: boolean
}

/** Does this quote offer optional extras? THE predicate — every surface asks it
 *  the same way, so none of them can disagree about which kind of quote this is. */
export function hasAddons(addons: AddonLike[] | null | undefined): boolean {
  return (addons?.length ?? 0) > 0
}

/** The owner's order. Never re-sorted by price or by what is ticked: an owner who
 *  leads with the cheap extra meant to, and a list that reshuffles as a customer
 *  ticks boxes is a list they stop trusting. */
export function sortedAddons<T extends AddonLike>(addons: T[] | null | undefined): T[] {
  return [...(addons || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
}

/** Only the ones that were chosen. The single reason this exists as a named
 *  function is that "the extras on this quote" and "the extras being paid for"
 *  are different lists, and confusing them is the one bug this feature can have. */
export function selectedAddons<T extends AddonLike>(addons: T[] | null | undefined): T[] {
  return sortedAddons(addons).filter(a => !!a.is_selected)
}

/** The ids of the chosen ones — exactly what the approval RPC's `p_addon_ids`
 *  wants, so a caller never has to build that array by hand. */
export function selectedAddonIds(addons: AddonLike[] | null | undefined): string[] {
  return selectedAddons(addons).map(a => a.id).filter((id): id is string => !!id)
}

/**
 * Σ of the chosen extras, and nothing else.
 *
 * ⭐ THE mirror of the database's `quote_addons_sync_total` trigger — the same
 * sum over the same rows. `verify:quote-addons` proves the two agree against a
 * real quote rather than trusting that they look alike.
 *
 * `selectedIds` overrides the rows' own `is_selected` when supplied, which is
 * what the portal needs while the customer is still ticking boxes: the rows say
 * what the server currently holds, the set says what this screen is offering to
 * commit to, and the figure in the Approve dialog must be the latter.
 */
export function addonsSubtotal(
  addons: AddonLike[] | null | undefined,
  selectedIds?: Iterable<string> | null,
): number {
  const set = selectedIds ? new Set(selectedIds) : null
  return (addons || []).reduce((sum, a) => {
    const chosen = set ? !!(a.id && set.has(a.id)) : !!a.is_selected
    if (!chosen) return sum
    const n = Number(a.price)
    return sum + (Number.isFinite(n) ? n : 0)
  }, 0)
}

/**
 * ⭐⭐ THE money rule, in one function: what this exact configuration costs.
 *
 *     base + travel + Σ selected add-ons
 *
 * `base` is the quote's own price, or the CHOSEN OPTION's price on a quote that
 * offers alternatives — the caller resolves which through lib/quoteOptions,
 * because "which alternative" and "which extras" are different questions and
 * this file only owns the second one.
 *
 * This is the identical arithmetic `quote_apply_choice` performs when it writes
 * `accepted_price`, which is what makes the Approve button, the paper, the
 * owner's screen and the database's record one number rather than four.
 */
export function configuredAmount(opts: {
  base: number
  travelFee?: number | null
  addons?: AddonLike[] | null
  selectedIds?: Iterable<string> | null
}): number {
  const base = Number(opts.base)
  const travel = Number(opts.travelFee) || 0
  return (Number.isFinite(base) ? base : 0) + travel + addonsSubtotal(opts.addons, opts.selectedIds)
}

export type AddonProblem = 'too_many' | 'unnamed' | 'no_price' | 'duplicate_name'

/**
 * Why this set of extras cannot be saved yet, or null when it can. Pure, so the
 * builder's inline message and the guard's assertions come from one rule.
 *
 * ⛔ A price of ZERO is refused here, unlike an option's. An option priced at 0
 * is a real tier ("included"); an OPTIONAL EXTRA at no charge is a tick-box that
 * takes money from nobody and tells the customer nothing — it is either part of
 * the job (put it in the description) or it has a price.
 */
export function addonSetProblem(addons: AddonLike[] | null | undefined): AddonProblem | null {
  const list = addons || []
  if (!list.length) return null            // no extras at all is the normal quote
  if (list.length > MAX_QUOTE_ADDONS) return 'too_many'
  if (list.some(a => !String(a.name ?? '').trim())) return 'unnamed'
  if (list.some(a => !Number.isFinite(Number(a.price)) || Number(a.price) <= 0)) return 'no_price'
  const names = list.map(a => String(a.name).trim().toLowerCase())
  if (new Set(names).size !== names.length) return 'duplicate_name'
  return null
}

/** What to tell the owner. Kept beside the rule so a new problem cannot be added
 *  without a sentence for it. */
export function addonProblemMessage(p: AddonProblem): string {
  switch (p) {
    case 'too_many': return `A quote can offer at most ${MAX_QUOTE_ADDONS} optional extras.`
    case 'unnamed': return 'Give every extra a name — that’s what the customer is ticking.'
    case 'no_price': return 'Give every extra a price. An extra at $0 belongs in the description, not as a tick-box.'
    case 'duplicate_name': return 'Two extras share a name — the customer couldn’t tell them apart.'
  }
}

/** Rows ready for `quote_addons`, renumbered from their position so the stored
 *  order is always the order on screen. The caller supplies quote_id/user_id —
 *  this never guesses tenancy.
 *
 *  ⛔ `selected_via` and `selected_at` are NOT written here. The database fills
 *  them from `is_selected` (quote_addons_write_guard), so a half-recorded choice
 *  is not a state app code is able to create. */
export function addonRowsFor(
  addons: AddonLike[],
  quoteId: string,
  userId: string,
): Array<{ quote_id: string; user_id: string; name: string; description: string | null; price: number; sort_order: number; is_selected: boolean }> {
  return addons.map((a, i) => ({
    quote_id: quoteId,
    user_id: userId,
    name: String(a.name).trim(),
    description: String(a.description ?? '').trim() || null,
    price: Number(a.price) || 0,
    sort_order: i,
    // ⭐ The owner's explicit intent, and nothing else. An extra arrives
    // UNTICKED unless the owner deliberately pre-ticked it — "we'll add it
    // unless you object" is how a customer ends up paying for something they
    // never read.
    is_selected: !!a.is_selected,
  }))
}

/** A blank extra for the builder's "Add an extra" button. Unticked, always. */
export function emptyAddon(): AddonLike {
  return { name: '', description: '', price: 0, is_selected: false }
}

// ── Reporting: is this quote's figure PROPOSED or CHOSEN? ────────────────────
/**
 * ⭐ What an add-on's tick MEANS at this moment, derived from state that already
 * exists — no second column, no second engine.
 *
 *   null        this quote offers no extras; the question doesn't arise
 *   'offered'   extras are on the table and the quote is still open — anything
 *               ticked is the OWNER's suggestion, not the customer's decision
 *   'agreed'    the quote is decided; the ticked set is what was bought, frozen
 *
 * ⛔ Never use this to compute money. The moment it is, there are two answers.
 */
export type AddonBasis = 'offered' | 'agreed'
export function addonBasis(
  addons: AddonLike[] | null | undefined,
  quoteStatus: string | null | undefined,
): AddonBasis | null {
  if (!hasAddons(addons)) return null
  return isAddonEditableStatus(quoteStatus) ? 'offered' : 'agreed'
}

/**
 * ⭐ THE predicate for "can these extras still change?", and it is the same
 * sentence the database enforces (`quote_addons_write_guard`: status in
 * draft/sent). Stated once so the editor's read-only state, the portal's
 * tick-boxes and the guard cannot drift from what the DB will actually accept.
 */
export function isAddonEditableStatus(status: string | null | undefined): boolean {
  return status === 'draft' || status === 'sent'
}

/** One sentence per basis, so every surface says it the same way. */
export function addonBasisLabel(basis: AddonBasis, count: number, chosen: number): string {
  return basis === 'agreed'
    ? chosen === 0
      ? 'No optional extras were taken.'
      : `${chosen} of ${count} optional extra${count === 1 ? '' : 's'} taken.`
    : chosen === 0
      ? `${count} optional extra${count === 1 ? '' : 's'} offered — none ticked yet.`
      : `${chosen} of ${count} optional extra${count === 1 ? '' : 's'} ticked — the customer can change this until they approve.`
}

/**
 * ⭐ THE sentence said at the moment of commitment — in the customer's Approve
 * dialog and in the owner's accept-on-behalf dialog, from one definition, so the
 * two sides of one agreement cannot describe it differently.
 *
 * It names what IS included and, just as deliberately, what is NOT: "am I paying
 * for the ones I left alone?" is the question a list of tick-boxes creates, and
 * it deserves answering where the money is being agreed to, not only beside the
 * boxes. Returns null when the quote offers no extras — there is nothing to say.
 *
 * `taken` is a list of already-formatted labels ("Extra visit (+$95)"), because
 * currency formatting is the caller's concern and this file owns no display.
 */
export function addonSentence(offered: number, taken: string[]): string | null {
  if (offered <= 0) return null
  if (taken.length === 0) {
    return `None of the ${offered} optional extra${offered === 1 ? ' is' : 's are'} included — nothing extra will be charged.`
  }
  const left = offered - taken.length
  const rest = left > 0
    ? ` The other ${left === 1 ? 'one isn’t' : `${left} aren’t`} ordered and won’t be charged.`
    : ''
  return `Optional extras included: ${taken.join(', ')}.${rest}`
}

/**
 * The sentence a customer must read before ticking anything. Kept here rather
 * than in a component so the portal, the PDF and the email say it identically.
 */
export const ADDONS_CUSTOMER_NOTE =
  'These are optional. Tick only what you want — anything left unticked isn’t ordered and isn’t charged.'

/** …and the one the OWNER reads while writing them. */
export const ADDONS_OWNER_NOTE =
  'Extras are added ON TOP of the price above. The customer ticks the ones they want when they approve — leave them unticked unless you mean to suggest one.'

/** The sentence that keeps add-ons and change orders apart, said where an owner
 *  would otherwise reach for the wrong one. ⛔ Do not reword in place — this is
 *  the boundary between two features that must never merge. */
export const ADDONS_AFTER_APPROVAL_NOTE =
  'This quote is decided, so its extras are part of the record now. To add work, raise a change order on the job.'

/** Convenience for readers holding real DB rows. */
export type QuoteAddonRow = QuoteAddon
