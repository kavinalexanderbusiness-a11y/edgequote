'use client'

// ── The ways this service is sold, on the quote itself ───────────────────────
// THE fix for "quoting a recurring service feels like assembling several
// unrelated pieces".
//
// ⭐⭐ WHAT WAS ACTUALLY WRONG. Session 107 built all of this — the plans, the
// pricing, the "offer these as options" step — and then put the only door to it
// inside the SATELLITE MAP modal. So a service the owner sells three ways could
// only reach a quote by opening Google Maps, and a service configured as NOT
// measured (a flat $70/visit, $240/month, $900/season snow contract — the exact
// case this session exists for) could not reach a quote at all: the modal
// answers `not_measured` and shows no plans. The owner then rebuilt the three
// options by hand, in a different screen, from numbers they had already
// configured. That is the several-unrelated-pieces feeling, and it was one
// misplaced door.
//
// This panel is that door, in the builder, beside the service. The map is now
// one way to get a MEASUREMENT — not the way to get a PRICE.
//
// ⛔ NOT A PRICING ENGINE and ⛔ NOT AN OPTIONS ENGINE. Every number comes from
// lib/recurringOffering (which delegates to lib/measurePricing); every
// multi-offer quote is built by lib/quoteOptions. This file renders and calls.

import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { Ruler, Layers, Check, Settings2 } from 'lucide-react'
import type { ServiceTemplate } from '@/types'
import { UNPRICED_COPY, formatMeasured, type MeasurementType, type UnpricedReason } from '@/lib/measurePricing'
import {
  offerable, canOfferOptions, offerableForOptions,
  BILLING_VS_VISITS, optionDescription,
  type Offering,
} from '@/lib/recurringOffering'

interface Props {
  /** The owner's catalogue row for the picked service. null = free-text service. */
  template: ServiceTemplate | null
  /** ⭐ Computed ONCE by the builder and read by this panel AND the pre-send
   *  preview. Two components deriving the same offerings from the same plans is
   *  two chances to disagree about what the quote offers. */
  offerings: Offering[]
  /** Whether the picked service has any configured plans at all. Distinct from
   *  `offerings.length`: a plan with no rate produces an offering with no price,
   *  which must be shown, not treated as an absent plan. */
  hasPlans: boolean
  /** Why there is nothing priced to show, or null. From the shared seam, so this
   *  panel and the map modal give the owner the SAME diagnosis. */
  reason: UnpricedReason | null
  measurementType: MeasurementType
  /** The quote's measurement, when one exists. null/0 is NOT zero area: a
   *  per-unit plan simply has no price yet, and says so. */
  measuredValue: number | null
  /** Which term the owner has landed on for a single-price quote. */
  selectedTerm: string | null
  onSelectTerm: (term: string) => void
  /** Apply ONE offering as the quote's price. */
  onUseSingle: (o: Offering) => void
  /** Hand the whole set to Quote Options so the CUSTOMER picks. */
  onOfferOptions: (list: Offering[]) => void
  /** Open the satellite tool. Offered as the way to get a measurement — never as
   *  the way to reach a price. */
  onMeasure: () => void
  /** True once the quote already carries these offerings as options, so the
   *  panel states what is on the quote instead of re-offering the same action. */
  optionsApplied: boolean
}

export function ServiceOfferings({
  template, offerings, hasPlans, reason, measurementType, measuredValue,
  selectedTerm, onSelectTerm, onUseSingle, onOfferOptions, onMeasure, optionsApplied,
}: Props) {
  // ⛔ A service with no configured plans renders NOTHING. The builder's existing
  // price field and recommendation are untouched for it — which is every service
  // in every existing install until an owner configures one. This panel adds a
  // surface; it replaces none.
  if (!hasPlans) return null

  const priced = offerable(offerings)
  const chosen = priced.find(o => o.term === selectedTerm) ?? null
  const multi = canOfferOptions(offerings)
  const forOptions = offerableForOptions(offerings)
  // Per-unit plans are the only ones a measurement changes; a flat monthly price
  // is complete with nothing traced, and offering "Measure" beside it would imply
  // the price is waiting on something it is not.
  const measurable = measurementType !== 'none'
  const wantsMeasurement = measurable && offerings.some(o => o.price == null)

  return (
    <div className="rounded-xl border border-border-strong bg-bg-secondary/40 p-3 sm:p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            How you sell this service
          </p>
          <p className="text-[11px] text-ink-faint mt-0.5">
            {/* Names the source out loud. The owner configured these in one place
                and is seeing that same configuration, not a re-derivation. */}
            From your pricing plans for {template?.name ?? 'this service'}.
          </p>
        </div>
        {measurable && measuredValue != null && measuredValue > 0 && (
          // ⭐ The measurement, COMPACTLY. The brief's "Measured area 2,919 sq ft"
          // — a fact, not a map. The customer never interprets raw tooling.
          <span className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg px-2 py-1 text-[11px] text-ink">
            <Ruler className="w-3 h-3 text-ink-faint" />
            <span className="tabular-nums font-medium">{formatMeasured(measuredValue, measurementType)}</span>
          </span>
        )}
      </div>

      {priced.length > 0 ? (
        <>
          <div role="radiogroup" aria-label="Commercial offering" className="space-y-2">
            {offerings.map(o => {
              const active = chosen?.term === o.term
              const unpriced = o.price == null
              const desc = optionDescription(o)
              return (
                <button
                  key={o.term}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  // ⛔ An offering with no price cannot be selected — there is
                  // nothing to select. It still RENDERS, because "Seasonal, no
                  // rate set" is information the owner needs.
                  disabled={unpriced}
                  onClick={() => !unpriced && onSelectTerm(o.term)}
                  className={cn(
                    'w-full min-h-[52px] flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                    unpriced
                      ? 'border-border bg-bg/50 opacity-70 cursor-default'
                      : active
                        ? 'border-accent bg-accent/[0.08]'
                        : 'border-border-strong bg-bg hover:border-accent/40',
                  )}
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-semibold text-ink">{o.label}</span>
                      {o.isRecommended && (
                        <span className="text-[10px] font-bold uppercase tracking-wide text-accent-text bg-accent/15 rounded px-1.5 py-0.5">
                          Recommended
                        </span>
                      )}
                    </span>
                    {/* ⭐ THE OWNER'S OWN WORDS, when they wrote any — this is what
                        the customer will read. Nothing is manufactured here: a
                        plan with no note and no term shows only its price. */}
                    {desc && <span className="block text-[11px] text-ink-muted truncate mt-0.5">{desc}</span>}
                    {/* Provenance is for the OWNER and stays on this screen — it
                        is never what reaches the customer's quote. */}
                    <span className="block text-[11px] text-ink-faint truncate">{o.basisText}</span>
                  </span>
                  <span className={cn(
                    'text-sm font-bold tabular-nums shrink-0',
                    unpriced ? 'text-ink-faint' : 'text-ink',
                  )}>
                    {/* ⭐⭐ UNKNOWN IS NOT ZERO. No price means no number — never
                        "$0", which reads as a quote for free work. */}
                    {o.priceText ?? 'No price'}
                  </span>
                </button>
              )
            })}
          </div>

          {/* ⛔ THE SEPARATION, said where the owner is choosing a term. One
              definition, shared with the map modal via lib/recurringOffering. */}
          <p className="text-[11px] text-ink-faint">{BILLING_VS_VISITS}</p>

          {optionsApplied ? (
            <div className="flex items-start gap-2 rounded-lg border border-accent/30 bg-accent/[0.05] px-3 py-2">
              <Check className="w-3.5 h-3.5 text-accent-text shrink-0 mt-0.5" />
              <p className="text-[11px] text-ink">
                This quote offers {forOptions.length} options for the customer to choose between. Edit
                the names, prices and wording under <span className="font-semibold">Options</span> below.
              </p>
            </div>
          ) : (
            <div className="flex flex-col sm:flex-row gap-2">
              {/* ⭐ THE TWO ANSWERS THE BRIEF ASKS FOR: one price, or let the
                  customer choose. Both seed EXISTING machinery — initial_price,
                  or quote_options — and both stay fully editable afterwards. */}
              <Button
                type="button" variant="secondary" size="sm"
                className="min-h-[44px] flex-1 justify-center"
                disabled={!chosen}
                onClick={() => chosen && onUseSingle(chosen)}
              >
                {chosen ? `Use ${chosen.label} — ${chosen.priceText}` : 'Pick a plan'}
              </Button>
              {multi && (
                <Button
                  type="button" variant="primary" size="sm"
                  className="min-h-[44px] flex-1 justify-center"
                  onClick={() => onOfferOptions(forOptions)}
                >
                  <Layers className="w-3.5 h-3.5" />
                  Offer all {forOptions.length} as options
                </Button>
              )}
            </div>
          )}
        </>
      ) : (
        // ⭐ Nothing carries a number. A sentence and the owner's next action —
        // never a zero, never a silent empty panel.
        <div className="space-y-2">
          <p className="text-[11px] text-ink-muted">
            {reason ? UNPRICED_COPY[reason] : UNPRICED_COPY.no_rates}
          </p>
          <a
            href="/dashboard/settings/templates" target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1.5 min-h-[40px] text-[11px] font-semibold text-accent-text hover:underline"
          >
            <Settings2 className="w-3.5 h-3.5" /> Open the Price Book
          </a>
        </div>
      )}

      {/* The map is offered as a way to get a MEASUREMENT — and only when one is
          actually missing for a plan that needs it. It is no longer the door to
          the prices. */}
      {wantsMeasurement && (
        <button
          type="button" onClick={onMeasure}
          className="w-full min-h-[40px] inline-flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border-strong text-[11px] font-semibold text-ink-muted hover:border-accent/40 hover:text-ink transition-colors"
        >
          <Ruler className="w-3.5 h-3.5" /> Measure from satellite to price the per-unit plans
        </button>
      )}
    </div>
  )
}
