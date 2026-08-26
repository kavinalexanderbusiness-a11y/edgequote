'use client'

import { Select } from '@/components/ui/Select'
import { PRICING_TERMS, unitLabel, type MeasurementType, type PriceBasis } from '@/lib/measurePricing'
import { planSetProblem, PLAN_PROBLEM_MESSAGE, type PlanDraft } from '@/lib/servicePlans'

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
  const problem = planSetProblem(drafts)
  const enabledCount = drafts.filter(d => d.enabled).length
  const unit = measured ? (unitLabel(measuredBy as MeasurementType) || 'unit') : 'unit'

  const patch = (term: string, changes: Partial<PlanDraft>) =>
    onDraftsChange(drafts.map(d => {
      if (d.term !== term) return d
      return { ...d, ...changes }
    }))

  // Only one plan may wear the badge — the DB enforces it with a partial unique
  // index, so the UI must not let the owner arm a save it will refuse.
  const setRecommended = (term: string, on: boolean) =>
    onDraftsChange(drafts.map(d => ({ ...d, is_recommended: on ? d.term === term : (d.term === term ? false : d.is_recommended) })))

  return (
    <div className="rounded-xl border border-border bg-surface/30 p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-semibold text-ink">
          Measure &amp; Price <span className="font-normal text-ink-faint">· optional</span>
        </h3>
        {measured && enabledCount > 0 && (
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

      {measured && (
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
                        : `Price = this amount, whatever the measurement.`}
                    </p>
                  </div>
                )}
              </div>
            )
          })}

          {problem && (
            <p className="text-[11px] text-amber-400">{PLAN_PROBLEM_MESSAGE[problem]}</p>
          )}
          {!problem && enabledCount === 0 && (
            // Honest, not alarming: measuring without a plan is a legitimate
            // half-configured state. The map will say "pricing not configured"
            // rather than invent a number.
            <p className="text-[11px] text-ink-faint">
              No plans yet — quotes can still measure this service, and will say pricing isn’t configured rather than show a price.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
