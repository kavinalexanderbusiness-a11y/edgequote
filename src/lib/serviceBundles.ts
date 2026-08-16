import type {
  QuoteLineKind, QuoteServiceInput, ServiceBundleItem, ServiceTemplate,
} from '@/types'
import { sumServiceLines } from './quoteServices'
import { resolveEstMinutes } from './priceBook'

// ── Service bundles: a reusable starting scope ───────────────────────────────
// THE ONE place a bundle turns into quote lines, and the one place quote lines
// turn into a bundle. Pure functions on purpose: every rule below is asserted
// directly by `npm run verify:service-bundles` instead of being inferred from
// three screens.
//
// WHAT A BUNDLE IS. A named set of lines an owner quotes together — "Spring
// Cleanup", "Move-out clean", "Furnace maintenance". It is a STARTING POINT.
// Applying one writes ordinary quote lines and then gets out of the way.
//
// WHAT IT IS NOT:
//   · Not a catalogue. `service_templates` is the catalogue and still owns
//     every default rate; a bundle item points AT one rather than restating it.
//   · Not a pricing engine. Nothing here derives a price. `resolveUnitPrice`
//     picks between two numbers an owner already typed — the bundle's own, or
//     the catalogue's. There is no rule, curve, multiplier or lookup, which is
//     what keeps this outside the frozen pricing surface entirely.
//   · Not an option set. Budget/Recommended/Premium are ALTERNATIVE whole-job
//     prices the customer chooses between (`quote_options`); a bundle seeds the
//     lines that ADD UP to one price. The database refuses a quote holding
//     both, so the two features cannot meet by accident.
//   · Not a live link. See COPY SEMANTICS below.
//
// COPY SEMANTICS — proven by ABSENCE, not by discipline.
// Applying a bundle produces plain `quote_services` rows and flat `quotes`
// fields. Nothing on a quote records which bundle it came from — there is no
// bundle_id column anywhere — so editing or deleting a bundle CANNOT reach a
// quote that was built from it, including one already sent or approved. The
// guarantee is structural: there is no reference to follow.
//
// NO DISCOUNTS, DELIBERATELY. `quote_services` lines can carry a discount and
// bundle items cannot. A discount is a concession on ONE deal — the least
// reusable thing on a quote — and baking one into a reusable scope is how every
// future customer silently gets 10% off. Apply produces lines with no discount;
// the owner adds one per quote, where it belongs.

/** A quote line in the shape both directions of this file speak. Loaded
 *  `quote_services` rows and the builder's own form values both satisfy it. */
export interface BundleSourceLine {
  service_type: string
  service_template_id: string | null
  quantity: number
  unit: string | null
  unit_price: number
  est_minutes: number | null
  notes: string | null
  kind: QuoteLineKind
}

/** What `captureBundleItems` produces: an item minus the ids the database
 *  assigns. Written straight to `service_bundle_items`. */
export type NewBundleItem = Pick<
  ServiceBundleItem,
  'service_template_id' | 'name' | 'quantity' | 'unit' | 'unit_price' | 'est_minutes' | 'notes' | 'kind' | 'sort_order'
>

/** A bundle applied to the builder. The primary service lives in the quote's
 *  FLAT fields and the rest in the `services` array — that asymmetry is the
 *  quote builder's existing shape (row 0 = primary, per `splitServices`), not
 *  something this file invents. */
export interface BundleScope {
  primary: {
    service_type: string
    service_template_id: string
    /** qty × resolved unit price. Seeds `initial_price`. */
    price: number
    /** Only when the item carried an estimate. `null` = leave hours alone —
     *  an unknown estimate must never become a typed 0. */
    hours: number | null
  } | null
  extras: QuoteServiceInput[]
}

const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100

/** Index a catalogue for the lookups below. */
export function templateIndex(templates: ServiceTemplate[] | null | undefined): Map<string, ServiceTemplate> {
  return new Map((templates || []).map(t => [t.id, t]))
}

// ── Price, resolved at APPLY time ────────────────────────────────────────────
// The whole of the bundle's price behaviour, in one function:
//   item.unit_price set  → the owner's own figure for this bundle.
//   item.unit_price null → the catalogue's current `default_rate`. This is the
//                          default and the point: re-price a service once, in
//                          the catalogue, and every future quote built from
//                          every bundle follows — no bundle to go and re-edit.
//   neither              → 0, meaning "nobody has said what this costs". The
//                          line still lands, with an empty price for the owner
//                          to fill. A fabricated number would be worse.
// Resolution happens when the bundle is APPLIED, never when it is saved, which
// is what makes the catalogue link worth having.
export function resolveUnitPrice(
  item: Pick<ServiceBundleItem, 'unit_price' | 'service_template_id'>,
  templates: Map<string, ServiceTemplate>,
): number {
  if (item.unit_price != null) return round2(item.unit_price)
  const t = item.service_template_id ? templates.get(item.service_template_id) : null
  return t ? round2(t.default_rate) : 0
}

/** Where a line's price came from — for the picker's "what will this do" copy.
 *  'catalogue' is the honest word for a figure this bundle does not own. */
export function priceBasis(
  item: Pick<ServiceBundleItem, 'unit_price' | 'service_template_id'>,
  templates: Map<string, ServiceTemplate>,
): 'bundle' | 'catalogue' | 'unpriced' {
  if (item.unit_price != null) return 'bundle'
  const t = item.service_template_id ? templates.get(item.service_template_id) : null
  return t ? 'catalogue' : 'unpriced'
}

/** Every item as a builder line, in bundle order. Used for the preview total
 *  and as the source for `bundleScope`. */
export function bundleLines(
  items: ServiceBundleItem[] | null | undefined,
  templates: Map<string, ServiceTemplate>,
): QuoteServiceInput[] {
  return [...(items || [])]
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
    .map(it => ({
      service_type: it.name,
      service_template_id: it.service_template_id || '',
      quantity: Number(it.quantity) > 0 ? Number(it.quantity) : 1,
      unit: it.unit || 'each',
      unit_price: resolveUnitPrice(it, templates),
      // ⭐ Session 76: TIME now follows the catalogue exactly as PRICE does.
      // A bundle item with no minutes of its own resolves to the linked
      // service's `default_minutes` (lib/priceBook `resolveEstMinutes` — the
      // same nullable-means-follow-the-catalogue rule as `resolveUnitPrice`
      // above). Before the catalogue could state a duration there was nothing
      // to fall back to, so this read 0 and the owner retyped it every quote.
      est_minutes: resolveEstMinutes(it, templates),
      // See NO DISCOUNTS above.
      discount_type: '' as const,
      discount_value: 0,
      notes: it.notes || '',
      kind: it.kind,
    }))
}

/** What the bundle will add up to, through the SAME adder the quote uses. A
 *  second sum here is how a preview starts disagreeing with the quote it
 *  previews. Returns 0 for an empty bundle. */
export function bundleTotal(
  items: ServiceBundleItem[] | null | undefined,
  templates: Map<string, ServiceTemplate>,
): number {
  return sumServiceLines(bundleLines(items, templates)).net
}

/** Split a bundle into the builder's two halves. The FIRST line becomes the
 *  primary service, matching how a saved quote loads (`splitServices`) — so a
 *  quote built from a bundle is indistinguishable from one typed by hand. */
export function bundleScope(
  items: ServiceBundleItem[] | null | undefined,
  templates: Map<string, ServiceTemplate>,
): BundleScope {
  const lines = bundleLines(items, templates)
  if (!lines.length) return { primary: null, extras: [] }
  const [first, ...rest] = lines
  const qty = Number(first.quantity) > 0 ? Number(first.quantity) : 1
  return {
    primary: {
      service_type: first.service_type,
      service_template_id: first.service_template_id,
      price: round2(qty * first.unit_price),
      // `hours` on a quote IS the primary line's estimate (the save path writes
      // est_minutes = hours × 60). Null when the bundle never recorded one —
      // unknown hours is not zero hours, and the builder is explicit that an
      // empty hours field is correct rather than a gap.
      hours: first.est_minutes > 0 ? round2(first.est_minutes / 60) : null,
    },
    extras: rest,
  }
}

/** How many lines, said in the owner's words — the picker's one-line summary. */
export function bundleSummary(items: ServiceBundleItem[] | null | undefined): string {
  const list = items || []
  const services = list.filter(i => i.kind !== 'material').length
  const materials = list.filter(i => i.kind === 'material').length
  if (!list.length) return 'No lines yet'
  const parts: string[] = []
  if (services) parts.push(`${services} service${services === 1 ? '' : 's'}`)
  if (materials) parts.push(`${materials} material${materials === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

// ── Capture: a quote's scope becomes a bundle ────────────────────────────────
// The lower-friction door. An owner has just built the scope for real, on a
// real job; saving it costs one tap and no configuration screen.
//
// ⭐ WHAT IS DELIBERATELY LEFT BEHIND. A bundle is reusable, so nothing about
// the customer it came from may ride along: no customer, property, address,
// measured area, travel fee, cadence prices, valid-until, discount or quote
// notes. Only the LINES survive — what the work is, how much of it, roughly
// how long, and (see below) sometimes what it cost.
export function captureBundleItems(
  lines: BundleSourceLine[] | null | undefined,
  templates: Map<string, ServiceTemplate>,
): NewBundleItem[] {
  return (lines || [])
    .filter(l => (l.service_type || '').trim())
    .map((l, i) => {
      const templateId = l.service_template_id || null
      return {
        service_template_id: templateId,
        name: l.service_type.trim(),
        quantity: Number(l.quantity) > 0 ? Number(l.quantity) : 1,
        unit: l.unit || null,
        unit_price: captureUnitPrice(l, templates),
        est_minutes: Number(l.est_minutes) > 0 ? Math.round(Number(l.est_minutes)) : null,
        notes: (l.notes || '').trim() || null,
        kind: l.kind || 'service',
        sort_order: i,
      }
    })
}

// A captured price is stored ONLY when it is genuinely this bundle's own.
// A line that was priced straight off the catalogue stores NULL instead of a
// copy of the catalogue number — otherwise the first bundle an owner saves
// quietly becomes a second, frozen price list, and re-pricing a service in
// Settings would stop reaching the quotes that need it most. Anything else
// (a hand-typed figure, one-off work with no catalogue row) is a number the
// owner chose, so it is kept as this bundle's starting point.
function captureUnitPrice(
  line: BundleSourceLine,
  templates: Map<string, ServiceTemplate>,
): number | null {
  const price = round2(line.unit_price)
  const t = line.service_template_id ? templates.get(line.service_template_id) : null
  if (t && round2(t.default_rate) === price) return null
  if (price <= 0) return null
  return price
}

/** A bundle name the owner will recognise later. Trimmed and length-capped;
 *  blank is refused by the caller, not silently turned into "Untitled". */
export function cleanBundleName(name: string): string {
  return (name || '').trim().replace(/\s+/g, ' ').slice(0, 80)
}
