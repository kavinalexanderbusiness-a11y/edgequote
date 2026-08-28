'use client'

import { useState } from 'react'
import { Select } from '@/components/ui/Select'
import { PRICING_TERMS, unitLabel, type MeasurementType, type PriceBasis } from '@/lib/measurePricing'
import { planSetProblem, PLAN_PROBLEM_MESSAGE, type PlanDraft } from '@/lib/servicePlans'

/** Does this draft already carry a term? Drives whether the term fields are
 *  shown for a plan the owner saved earlier — the disclosure below only has to
 *  remember what was opened in THIS session. */
const hasTerm = (d: PlanDraft) => !!(d.term_label.trim() || d.term_start || d.term_end)

// ── "This service is measured by X, and these are the ways I sell it" ────────
// THE configuration surface for Measure & Price, and deliberately the smallest
// one that can express that sentence. It is not a second Service Catalog and not
// a pricing engine — it edits two things on a service the owner already has:
// how it is measured, and which commercial terms they offer for it.
//
// ⛔ Nothing here is trade-specific. There is no snow preset and no mowing
// preset. A snow contractor ticks One-time + Monthly + Seasonal; a mowing
// business ticks One-time + Weekly + Bi-weekly + Monthly; a floor cleaner ticks
// whatever they actually sell. The five terms are the same five for everyone and
// the business chooses — which is the whole product principle.

const MEASURE_OPTIONS = [
  { value: '', label: 'Not measured' },
  { value: 'area', label: 'Area — sq ft' },
  { value: 'length', label: 'Length — linear ft' },
  { value: 'count', label: 'Count' },
]

export function MeasurePricingEditor({
  measuredBy,
  onMeasuredByChange,
  drafts,
  onDraftsChange,
}: {
  measuredBy: '' | MeasurementType
  onMeasuredByChange: (v: '' | MeasurementType) => void
  drafts: PlanDraft[]
  onDraftsChange: (next: PlanDraft[]) => void
}) {
  const measured = measuredBy && measuredBy !== 'none'
  // Which plans have their term fields showing. Local and deliberately not
  // persisted: it is a disclosure, not configuration.
  const [termOpen, setTermOpen] = useState<Set<string>>(new Set())
  const problem = planSetProblem(drafts)
  const enabledCount = drafts.filter(d => d.enabled).length
  const unit = measured ? (unitLabel(measuredBy as MeasurementType) || 'unit') : 'unit'

  const patch = (term: string, changes: Partial<PlanDraft>) =>
    onDraftsChange(drafts.map(d => {
      if (d.term !== term) return d
      const next = { ...d, ...changes }
      // ⭐ An unmeasured service has no unit, so `per_unit` cannot mean anything
      // for it — pricePlan() would find no measurement and report the plan
      // unpriced forever. Coerced HERE rather than validated at save, so the
      // stored row and the screen always agree, including for a service whose
      // measurement type the owner has just switched off.
      if (!measured) next.basis = 'flat'
      return next
    }))

  // Only one plan may wear the badge — the DB enforces it with a partial unique
  // index, so the UI must not let the owner arm a save it will refuse.
  const setRecommended = (term: string, on: boolean) =>
    onDraftsChange(drafts.map(d => ({ ...d, is_recommended: on ? d.term === term : (d.term === term ? false : d.is_recommended) })))

  return (
    <div className="rounded-xl border border-border bg-surface/30 p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-semibold text-ink">
          {/* Renamed: the block is no longer only about measuring. It answers two
              independent questions — how this service is measured (if at all) and
              how it is sold — and gating the second on the first is exactly the
              bug fixed below. */}
          Pricing plans <span className="font-normal text-ink-faint">· optional</span>
        </h3>
        {enabledCount > 0 && (
          <span className="text-[11px] text-ink-faint">{enabledCount} plan{enabledCount === 1 ? '' : 's'}</span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-start">
        <Select
          label="Measurement"
          options={MEASURE_OPTIONS}
          value={measuredBy}
          onChange={e => onMeasuredByChange(e.target.value as '' | MeasurementType)}
        />
        <p className="text-xs text-ink-muted sm:pt-7">
          {measured
            ? `Quotes for this service can be measured on the map, and priced in ${unit}.`
            : 'Not offered on the map. Turn this on for services you price from a measured area, length or count.'}
        </p>
      </div>

      {/* ⭐⭐ NOT GATED ON `measured` (Session 111). This block used to render only
          for a measured service, so a business selling snow clearing at a flat
          $70/visit, $240/month and $900/season — no trace involved — could not
          configure a single one of those plans. It had to declare the service
          measured to reach the editor, which is a lie told to a column to get at
          a screen.
          HOW A SERVICE IS MEASURED AND HOW IT IS SOLD ARE INDEPENDENT FACTS.
          Measurement decides whether a PER-UNIT rate is available; it has no
          bearing on whether a business offers a monthly price. */}
      <div className="space-y-2 pt-1">
          <div>
            <p className="text-xs font-semibold text-ink">Ways you sell it</p>
            {/* ⛔⛔ The distinction the whole feature rests on, said where the
                owner is configuring it. Ticking Monthly prices and bills the work
                monthly; it does not create four visits a month. The visit
                schedule stays with recurrence and dispatch. */}
            <p className="text-[11px] text-ink-muted">
              How customers buy it and what the price is per. This doesn’t schedule visits — recurrence still does that.
            </p>
          </div>

          {PRICING_TERMS.map(t => {
            const d = drafts.find(x => x.term === t.key)
            if (!d) return null
            return (
              <div key={t.key} className={`rounded-lg border px-3 py-2.5 transition-colors ${d.enabled ? 'border-accent/30 bg-accent/[0.03]' : 'border-border'}`}>
                <label className="flex items-center gap-2.5 min-h-[44px] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={d.enabled}
                    onChange={e => patch(t.key, { enabled: e.target.checked, ...(e.target.checked ? {} : { is_recommended: false }) })}
                    className="h-5 w-5 rounded border-border-strong accent-[color:var(--accent)]"
                  />
                  <span className="text-sm font-medium text-ink">{t.label}</span>
                  <span className="text-[11px] text-ink-faint">{t.priceSuffix}</span>
                </label>

                {d.enabled && (
                  <div className="mt-2 pl-[30px] flex flex-wrap items-end gap-2.5">
                    {/* A per-unit rate needs a unit to multiply. An unmeasured
                        service therefore has exactly one honest price rule, and
                        the control says so rather than offering a choice that
                        would produce a price of nothing × a rate. */}
                    {measured ? (
                      <label className="flex flex-col gap-1">
                        <span className="text-[11px] text-ink-muted">Price rule</span>
                        <select
                          value={d.basis}
                          onChange={e => patch(t.key, { basis: e.target.value as PriceBasis })}
                          className="h-11 bg-bg border border-border-strong rounded-lg px-2.5 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                        >
                          <option value="per_unit">Per {unit}</option>
                          <option value="flat">Flat price</option>
                        </select>
                      </label>
                    ) : null}
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-ink-muted">
                        {d.basis === 'per_unit' ? `$ per ${unit}` : `$ ${t.priceSuffix.replace('/', 'per ')}`}
                      </span>
                      <input
                        type="number"
                        min="0"
                        // ⭐⭐ THE STEP MUST MATCH THE COLUMN, which is numeric(12,4).
                        // A number input REFUSES a value off its step: the field goes
                        // :invalid, and because it sits inside the service form, the
                        // browser then blocks submit — so the WHOLE service silently
                        // fails to save, measurement type included. Not a rejected
                        // field, no message, nothing written.
                        //   step="0.01" refused 0.035 and 0.0025 — the sub-cent rates
                        //   20260826120000 widened the column to keep.
                        //   step="1"    refused $249.50 and $1,200.75 — i.e. any flat
                        //   price with cents in it, which is most of them.
                        // Measured on production: typing 0.035 wrote no plan and no
                        // measurement type; typing 0.08 wrote both.
                        step={d.basis === 'per_unit' ? '0.0001' : '0.01'}
                        // Held as TEXT so blank stays blank: Number('') is 0, and a
                        // rate the owner never typed must not become a $0 plan that
                        // quotes the work as free.
                        value={d.rate}
                        onChange={e => patch(t.key, { rate: e.target.value })}
                        placeholder={d.basis === 'per_unit' ? '0.08' : '249'}
                        className="h-11 w-28 bg-bg border border-border-strong rounded-lg px-2.5 text-base sm:text-sm text-ink tabular-nums outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                      />
                    </label>
                    <label className="flex items-center gap-2 min-h-[44px] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={d.is_recommended}
                        onChange={e => setRecommended(t.key, e.target.checked)}
                        className="h-5 w-5 rounded border-border-strong accent-[color:var(--accent)]"
                      />
                      <span className="text-xs text-ink-muted">Recommended</span>
                    </label>
                    <p className="basis-full text-[11px] text-ink-faint">
                      {d.basis === 'per_unit'
                        ? `Price = your rate × the measured ${unit}.`
                        : measured
                          ? 'Price = this amount, whatever the measurement.'
                          : 'Price = this amount.'}
                    </p>

                    {/* ── What the customer reads, and the period it covers ────
                        ⛔ NO PLACEHOLDER TEXT THAT COULD BE MISTAKEN FOR A
                        DEFAULT. Both fields are empty until the owner types, and
                        an empty field puts NOTHING on the quote. The product does
                        not ship "Pay only when service occurs" — that is a claim
                        about how a business operates, and only the business can
                        make it. */}
                    <label className="basis-full flex flex-col gap-1">
                      <span className="text-[11px] text-ink-muted">
                        What the customer reads <span className="text-ink-faint">· optional</span>
                      </span>
                      <input
                        type="text"
                        value={d.customer_note}
                        onChange={e => patch(t.key, { customer_note: e.target.value })}
                        maxLength={140}
                        placeholder="Your own words for this plan"
                        className="h-11 w-full bg-bg border border-border-strong rounded-lg px-2.5 text-base sm:text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                      />
                    </label>

                    {/* The term is genuinely optional and most plans have none, so
                        it stays out of the way until asked for — three date-ish
                        fields on every plan row would be the "20 configuration
                        steps" the brief is against. */}
                    {termOpen.has(t.key) || hasTerm(d) ? (
                      <div className="basis-full grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <label className="flex flex-col gap-1">
                          <span className="text-[11px] text-ink-muted">Term name</span>
                          <input
                            type="text" value={d.term_label}
                            onChange={e => patch(t.key, { term_label: e.target.value })}
                            maxLength={60}
                            placeholder="e.g. 2026/27 Season"
                            className="h-11 w-full bg-bg border border-border-strong rounded-lg px-2.5 text-base sm:text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                          />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-[11px] text-ink-muted">Starts</span>
                          <input
                            type="date" value={d.term_start}
                            onChange={e => patch(t.key, { term_start: e.target.value })}
                            className="h-11 w-full bg-bg border border-border-strong rounded-lg px-2.5 text-base sm:text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                          />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-[11px] text-ink-muted">Ends</span>
                          <input
                            type="date" value={d.term_end}
                            onChange={e => patch(t.key, { term_end: e.target.value })}
                            className="h-11 w-full bg-bg border border-border-strong rounded-lg px-2.5 text-base sm:text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                          />
                        </label>
                        <p className="sm:col-span-3 text-[11px] text-ink-faint">
                          {/* ⛔ The line that keeps a commercial term from being read
                              as a schedule. Dates here say what the price covers —
                              they create no visits and no recurrence. */}
                          The period this price covers. It doesn’t schedule any visits.
                        </p>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setTermOpen(prev => new Set(prev).add(t.key))}
                        className="basis-full text-left min-h-[40px] text-[11px] font-semibold text-accent-text hover:underline"
                      >
                        + Add a term (season or fixed period)
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {problem && (
            <p className="text-[11px] text-amber-400">{PLAN_PROBLEM_MESSAGE[problem]}</p>
          )}
          {!problem && enabledCount === 0 && (
            // Honest, not alarming: no plan is a legitimate half-configured
            // state. Quotes fall back to this service's starting price, and the
            // map says "pricing not configured" rather than inventing a number.
            <p className="text-[11px] text-ink-faint">
              {measured
                ? 'No plans yet — quotes can still measure this service, and will say pricing isn’t configured rather than show a price.'
                : 'No plans yet — quotes for this service use its starting price above.'}
            </p>
          )}
        </div>
    </div>
  )
}
