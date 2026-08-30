// ── The accepted-version renderer input — built from the LEDGER, never the row ─
//
// A quote's PDF used to have one source: the live, mutable quote row. For an
// ACCEPTED quote that is the wrong source — the customer said yes to a specific
// document, quote_acceptances.document holds exactly that document, and the live
// row is whatever the owner has typed since. This file turns the stored snapshot
// into the shapes the ONE PDF pipeline (QuotePDF.renderQuoteBlob) already
// consumes, so "the accepted version" is the same renderer fed from the
// immutable record — one PDF system, two honestly-labelled sources.
//
// ⛔ THE RULE THIS FILE EXISTS FOR: no MATERIAL field below may ever read from a
// live quote row, a live service line, a live option, or live settings. Material
// = everything quote_material_fingerprint counts, which is everything in the
// snapshot. verify:accepted-document-truth feeds this mapper a poisoned live
// context (every material field changed after acceptance) and fails if a single
// poisoned value surfaces in the output.
//
// What is deliberately NOT snapshot-sourced, and why that is correct:
//   · business identity (name, logo, phone, GST annotation) — presentation of
//     the SENDER, not terms of the deal; the fingerprint has never counted it.
//   · issue date / quote id — chronology and addressing; `created_at` is
//     immutable in practice and the accepted band prints the ledger's own
//     accepted_at beside it, which is the date that carries meaning here.
//   · crew/hours estimate labels — operational estimates, not promises; the
//     accepted render suppresses them entirely rather than reading them live
//     (QuoteDocument prints '—' when `accepted` is set).
//
// TERMS are snapshot-sourced from the acceptance ROW (terms_text — the exact
// text agreed), because business_settings.terms_text is a single unversioned
// field: editing it tomorrow must never rewrite what a customer already agreed
// to. A null accepted terms_text renders NO terms box — it never falls back to
// the live setting.

import type { Quote, QuoteService, QuoteOption } from '@/types'
import type { AcceptedDocument, AcceptanceKind } from '@/lib/quoteAcceptance'

/** What renderQuoteBlob needs, plus the stamp that marks the render as the
 *  accepted version rather than the current quote. */
export interface AcceptedRenderInput {
  quote: Quote
  services: QuoteService[] | undefined
  options: QuoteOption[] | undefined
  /** Passed to QuoteDocument's `accepted` prop — its presence IS the label, and
   *  `kind` decides WHICH label: the three evidence kinds are not
   *  interchangeable, and the paper must say which one it carries. */
  accepted: { at: string; termsText: string | null; kind: AcceptanceKind }
}

const num = (v: number | string | null | undefined): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const numOrNull = (v: number | string | null | undefined): number | null => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Build the PDF pipeline's inputs from an acceptance record.
 *
 * `presentation` carries the few NON-material facts named above. Every caller
 * has them (the owner page from the live row, the portal from its own
 * projection) — and nothing else from those sources is consulted.
 */
export function acceptedRenderInput(args: {
  document: AcceptedDocument
  acceptedAt: string
  selectedOptionId: string | null
  /** The EXACT terms text stored on the acceptance row. Null = none were agreed. */
  termsText: string | null
  /** The evidence kind, straight off the ledger row — never inferred. */
  kind: AcceptanceKind
  presentation: { quoteId: string; createdAt: string; issuedDate: string | null }
}): AcceptedRenderInput {
  const d = args.document
  const p = args.presentation
  // ⛔ A LEGACY ROW ACKNOWLEDGED NO TERMS — the database welds that shut
  // (kind='legacy_unrecorded' carries no terms claim by CHECK), and this
  // mapper welds it again so no caller can dress a backfill up as consent to
  // a specific text: whatever arrives, a legacy render prints no terms.
  const termsText = args.kind === 'legacy_unrecorded' ? null : args.termsText

  // Material fields: snapshot only. Presentation fields: named, minimal, inert.
  // Everything else the Quote type carries is zeroed — QuoteDocument's read set
  // is pinned by the guard, so an unread field can never leak into the paper.
  const quote = {
    id: p.quoteId,
    created_at: p.createdAt,
    issued_date: p.issuedDate,
    status: 'accepted',
    quote_number: d.quote_number ?? '',
    customer_name: d.customer_name ?? '',
    address: d.address ?? '',
    service_type: d.service_type ?? '',
    notes: d.notes ?? null,
    initial_price: numOrNull(d.initial_price),
    travel_fee: num(d.travel_fee),
    total: num(d.total),
    valid_until: d.valid_until ?? null,
    weekly_price: numOrNull(d.plan_prices?.weekly),
    biweekly_price: numOrNull(d.plan_prices?.biweekly),
    monthly_price: numOrNull(d.plan_prices?.monthly),
    selected_option_id: args.selectedOptionId,
    // Travel on the accepted document is always ITEMIZED: the snapshot records
    // the fee as its own fact, and the most transparent rendering of a record
    // is the one that shows it. (Rolled-in vs itemized never changes the total.)
    show_travel_separately: num(d.travel_fee) > 0,
    // Never printed on an accepted render (QuoteDocument suppresses the label),
    // and zero here so nothing can fabricate an estimate the snapshot never held.
    crew_size: 0,
    hours: 0,
  } as unknown as Quote

  // Line items, exactly as accepted. The snapshot aggregates in sort order, so
  // the array index IS the order (the first line carries first-visit semantics).
  const services: QuoteService[] | undefined = d.services?.length
    ? d.services.map((s, i) => ({
        id: `accepted-${i}`,
        created_at: p.createdAt,
        user_id: '',
        quote_id: p.quoteId,
        service_type: s.service_type,
        service_template_id: null,
        quantity: num(s.quantity),
        unit: s.unit ?? null,
        unit_price: num(s.unit_price),
        est_minutes: null,
        discount_type: (s.discount_type as QuoteService['discount_type']) ?? null,
        discount_value: numOrNull(s.discount_value),
        notes: s.notes ?? null,
        sort_order: i,
        kind: (s.kind as QuoteService['kind']) ?? 'service',
      }))
    : undefined

  // The alternatives AS OFFERED at acceptance, with the chosen one carrying its
  // full description from the snapshot's own `option` object.
  const chosen = d.option ?? null
  const options: QuoteOption[] | undefined = d.options_offered?.length
    ? d.options_offered.map((o, i) => ({
        id: o.id,
        created_at: p.createdAt,
        updated_at: p.createdAt,
        quote_id: p.quoteId,
        user_id: '',
        name: o.name,
        description: chosen && chosen.id === o.id ? chosen.description ?? null : null,
        price: num(o.price),
        sort_order: i,
        is_recommended: false,
      }))
    : undefined

  return { quote, services, options, accepted: { at: args.acceptedAt, termsText, kind: args.kind } }
}
