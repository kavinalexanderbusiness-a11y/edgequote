// ── Quote add-ons — optional PRE-ACCEPTANCE extras ───────────────────────────
// THE one place that answers "what optional extras does this quote offer, and
// what does taking them cost?", so the builder, the PDF, the portal, the owner's
// record-a-choice dialog and the guards can never reach different answers.
//
// ⭐ THE WHOLE MODEL, in one sentence: an OPTION replaces the price, an ADD-ON
// adds to it. They are orthogonal and compose freely — a quote may offer three
// alternatives AND four extras, and the customer takes exactly one alternative
// and any number of extras.
//
// ⛔ AN ADD-ON IS NOT A CHANGE ORDER. The line between them is ACCEPTANCE, and
// it is the database that draws it (quote_addons_write_guard refuses every write
// once the quote leaves draft/sent). Before the customer decides, extra scope is
// something they may still choose — an add-on. After they decide, extra scope is
// work they did not authorise and must authorise again — a change order, with
// its own table, its own approval and its own audit trail (lib/changeOrders).
// Nothing here may ever be reached from an accepted quote, and nothing in the
// change-order engine may ever write a quote_addons row.
//
// ⛔ NOT the recurring cadence prices, and never added to one. weekly/biweekly/
// monthly are the price of ONE VISIT of an ongoing plan; an optional extra is
// taken ONCE, on the job being quoted. Adding an extra to a cadence price would
// bill a one-time extra on every visit forever — see quoteAddonJobLines(), which
// is the only bridge from an accepted extra into the work, and it is
// deliberately non-recurring.
//
// ── ⭐⭐ WHERE THE MONEY ACTUALLY LIVES — read this before adding arithmetic ──
// Nothing in this module is the quote's price. The database owns every stored
// figure on this seam and there is no second implementation:
//
//   quotes.addons_total   Σ SELECTED extras. Written ONLY by the trigger
//                         quote_addons_sync_total. ⛔ App code never writes it.
//   quotes.total          STORED GENERATED: initial_price + travel_fee +
//                         addons_total. THE one money figure downstream reads.
//   quotes.accepted_price Snapshotted by quote_apply_choice at approval, as
//                         (chosen option ?? base) + travel + Σ selected extras,
//                         computed EXPLICITLY. This is the frozen historical
//                         record: editing an add-on template later cannot move
//                         it, and the write guard means the rows cannot move
//                         either.
//
// The ONE arithmetic helper below (approvalTotal) exists solely to state, BEFORE
// the call, the figure quote_apply_choice is about to write — so the sentence a
// person consents to and the number the business records are the same by
// construction, not by coincidence. It is never stored and never re-read.

import type { QuoteAddon, QuoteAddonInput } from '@/types'

/** How many extras a quote may offer. Mirrors the DB's own cap, raised in
 *  quote_addons_write_guard — a list a customer has to audit line by line stops
 *  being a choice and starts being a bill to check. */
export const MAX_QUOTE_ADDONS = 6

/** Anything with a name, a price and an order. Lets the pure helpers below run
 *  against DB rows, portal payload rows and half-typed builder rows alike. */
export interface AddonLike {
  id?: string
  name: string
  description?: string | null
  price: number | string
  sort_order?: number
  is_selected?: boolean
}

/** Does this quote offer extras? THE predicate — every surface asks it the same
 *  way, so none of them can disagree about which kind of quote this is.
 *
 *  ⭐ There is deliberately NO `has_addons` switch on the quote, unlike options.
 *  An empty list IS "no extras". A declared-intent flag would only create a
 *  state where extras are typed, saved and invisible. */
export function hasAddons(addons: AddonLike[] | null | undefined): boolean {
  return (addons?.length ?? 0) > 0
}

/** The owner's order. Never re-sorted by price: an owner who leads with the
 *  cheap one meant to. */
export function sortedAddons<T extends AddonLike>(addons: T[] | null | undefined): T[] {
  return [...(addons || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
}

/** The extras that cost money — the only fact on the row that does. */
export function selectedAddons<T extends AddonLike>(addons: T[] | null | undefined): T[] {
  return sortedAddons(addons).filter(a => !!a.is_selected)
}

/** The ids to hand quote_apply_choice, in the owner's order, de-duplicated.
 *  The RPC de-duplicates again — naming the same extra twice must not bill it
 *  twice, and that invariant belongs to the database — but a door that sends a
 *  duplicate is a door with a bug, so this never produces one. */
export function addonIdsFor(addons: AddonLike[] | null | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const a of sortedAddons(addons)) {
    const id = String(a.id ?? '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * ⭐ THE figure a person is about to consent to — and the ONLY arithmetic in
 * this module.
 *
 * It states, before the call, exactly what `quote_apply_choice` will compute and
 * write to `accepted_price`:
 *
 *     (chosen option ?? base) + travel + Σ selected extras
 *
 * Every door that asks a human to approve something reads it from here, so the
 * confirm dialog, the portal's running figure and the owner's record-a-choice
 * sentence cannot drift from the number the database banks. ⛔ It is never
 * stored, never written back, and never used to render an ALREADY-decided
 * quote — a decided quote's figure is `quotes.accepted_price`, which is the
 * frozen record and cannot be recomputed from today's rows.
 */
export function approvalTotal(opts: {
  /** The chosen option's price, or the plain quote's `initial_price`. */
  base: number | string | null | undefined
  travel: number | string | null | undefined
  /** The extras being taken — already filtered to the chosen ones. */
  addons: AddonLike[] | null | undefined
}): number {
  const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }
  return n(opts.base) + n(opts.travel) + (opts.addons || []).reduce((s, a) => s + n(a.price), 0)
}

// ── The freeze, stated in the app so the owner hears a sentence, not an error ─
/**
 * Are this quote's extras part of the record now?
 *
 * ⭐⭐ The DATABASE is the authority (quote_addons_write_guard raises on every
 * insert/update/delete once status leaves draft/sent). This predicate exists so
 * the editor can go read-only while the rows are still on screen, rather than
 * reporting a check_violation after the owner has retyped a price. Same rule,
 * two places, one definition — and the guard asserts the app's copy still says
 * exactly what the trigger says.
 */
export function addonsFrozen(status: string | null | undefined): boolean {
  return status !== 'draft' && status !== 'sent'
}

export const ADDONS_FROZEN_MESSAGE =
  'This quote has been decided — its optional extras are part of the record now. Additional work goes on a change order.'

export type AddonProblem = 'too_many' | 'unnamed' | 'no_price' | 'negative_price' | 'duplicate_name'

/**
 * Why this set of extras cannot be saved yet, or null when it can. Pure, so the
 * builder's inline message and the guard's assertions come from one rule.
 *
 * A price of zero is allowed on purpose: "included if you want it" is a real
 * offer, and the database allows it (price >= 0). A NEGATIVE price is not — an
 * extra that reduces the bill is a discount, which the quote already has a
 * proper engine for, and the database refuses it outright.
 */
export function addonSetProblem(addons: AddonLike[] | null | undefined): AddonProblem | null {
  const list = addons || []
  if (!list.length) return null                       // no extras is a valid quote
  if (list.length > MAX_QUOTE_ADDONS) return 'too_many'
  if (list.some(a => !String(a.name ?? '').trim())) return 'unnamed'
  if (list.some(a => !Number.isFinite(Number(a.price)))) return 'no_price'
  if (list.some(a => Number(a.price) < 0)) return 'negative_price'
  const names = list.map(a => String(a.name).trim().toLowerCase())
  if (new Set(names).size !== names.length) return 'duplicate_name'
  return null
}

/** What to tell the owner. Kept beside the rule so a new problem cannot be added
 *  without a sentence for it. */
export function addonProblemMessage(p: AddonProblem): string {
  switch (p) {
    case 'too_many': return `A quote can offer at most ${MAX_QUOTE_ADDONS} optional extras.`
    case 'unnamed': return 'Give every extra a name — that’s what the customer is choosing.'
    case 'no_price': return 'Give every extra a price.'
    case 'negative_price': return 'An extra can’t have a negative price — use a discount on the quote instead.'
    case 'duplicate_name': return 'Two extras share a name — the customer couldn’t tell them apart.'
  }
}

/**
 * Rows ready for `quote_addons`, renumbered from their position so the stored
 * order is always the order on screen. The caller supplies quote_id/user_id —
 * this never guesses tenancy.
 *
 * ⭐⭐ `is_selected` IS NOT WRITTEN, AND THAT IS THE DESIGN, NOT AN OMISSION.
 * `is_selected` is the one fact on the row that costs money: it feeds the
 * trigger that writes `quotes.addons_total`, which feeds the GENERATED
 * `quotes.total`, which is what the PDF prints, what the pipeline reports and
 * what the deposit engine takes a percentage of. An owner pre-ticking an extra
 * would therefore put money the customer has never agreed to into the quote's
 * headline figure and onto the customer's own document — and `selected_via`
 * would record it as 'default', an admission in the schema itself that nobody
 * chose it. The database can express that state; this application refuses to
 * create it. A selected add-on always means A PERSON PICKED IT, and the only
 * writers of that fact are the two doors into quote_apply_choice.
 */
export function addonRowsFor(
  addons: AddonLike[],
  quoteId: string,
  userId: string,
): Array<{ quote_id: string; user_id: string; name: string; description: string | null; price: number; sort_order: number }> {
  return addons.map((a, i) => ({
    quote_id: quoteId,
    user_id: userId,
    name: String(a.name).trim(),
    description: String(a.description ?? '').trim() || null,
    price: Number(a.price) || 0,
    sort_order: i,
  }))
}

/** A blank extra for the builder's "Add optional extra" button. */
export function emptyAddon(): QuoteAddonInput {
  return { name: '', description: '', price: 0 }
}

// ── Reporting: is this extra OFFERED or TAKEN? ───────────────────────────────
/**
 * ⭐ The distinction every surface needs, derived from the selection state that
 * already exists — no second column, no second engine.
 *
 *   null       this quote offers no extras; the question doesn't arise
 *   'offered'  extras are on the table and none is selected — they are worth
 *              nothing to the business and nothing to the customer's bill
 *   'taken'    at least one was chosen, and `quotes.addons_total` holds its cost
 *
 * ⛔ It must never be used to compute money — the moment it is, there are two
 * answers.
 */
export type AddonValueBasis = 'offered' | 'taken'
export function addonValueBasis(addons: AddonLike[] | null | undefined): AddonValueBasis | null {
  if (!hasAddons(addons)) return null
  return selectedAddons(addons).length > 0 ? 'taken' : 'offered'
}

/** One sentence per basis, so every surface says it the same way. */
export function addonValueBasisLabel(basis: AddonValueBasis, count: number, takenCount: number): string {
  return basis === 'taken'
    ? `${takenCount} of ${count} optional extra${count === 1 ? '' : 's'} taken`
    : `${count} optional extra${count === 1 ? '' : 's'} offered — none taken`
}

// ── The bridge into the WORK, and the only one ───────────────────────────────
/**
 * ⭐⭐ The accepted extras, as job line items.
 *
 * An extra the customer bought is work somebody has to do and money somebody has
 * to bill. `quotes.addons_total` already puts it in the quote's total and in
 * `accepted_price`, but a total is not a scope: when the quote becomes a job the
 * extras have to arrive as real rows, or the invoice conversion prints one lump
 * under the primary service's name and the rows do not reconcile to the bill.
 * (That defect was found on this seam once already.)
 *
 * They ride the SAME rail the multi-service extras already ride —
 * lib/jobPricing.addLineItems → `job_line_items` → buildInvoiceLineItems' `addon`
 * lines — so there is no second engine, no new table, and job costing, profit,
 * BI and the draft-invoice re-pricer all pick them up unchanged.
 *
 * ⛔ `recurring: false`, always. An optional extra is taken ONCE on the job being
 * quoted. A recurring line would bill it on every visit of the plan forever,
 * which is the single worst thing this seam could do to a customer.
 *
 * ⚠️ It reads SELECTED rows only, and it never re-prices: the price on the row is
 * the price that was agreed, and the row cannot change afterwards because the
 * write guard has frozen it.
 */
export function quoteAddonJobLines(addons: AddonLike[] | null | undefined): Array<{ description: string; amount: number }> {
  return selectedAddons(addons).map(a => ({
    description: String(a.name).trim(),
    amount: Number(a.price) || 0,
  }))
}

/** Convenience for readers holding real DB rows. */
export type QuoteAddonRow = QuoteAddon
