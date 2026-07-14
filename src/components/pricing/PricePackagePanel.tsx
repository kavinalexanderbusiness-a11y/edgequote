'use client'

import { PricingPackage, CadenceKey } from '@/lib/pricing'
import { cn } from '@/lib/utils'
import { Trophy, ShieldAlert, Route } from 'lucide-react'

const AGG_META = {
  aggressive: { label: 'Competitive recurring pricing', cls: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
  standard: { label: 'Standard recurring discount', cls: 'text-accent border-accent/30 bg-accent/10' },
  protective: { label: 'Hold / raise pricing', cls: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
} as const

export interface CadenceSelection { cadence: CadenceKey; price: number }

export const CADENCE_LABELS: Record<CadenceKey, string> = {
  one_time: 'One-Time', weekly: 'Weekly', biweekly: 'Bi-Weekly', monthly: 'Monthly',
}

// Per-cadence prices + season value, which option to push and why, and the
// don't-go-below guidance. Tapping a price applies it to the quote. The
// is-this-customer-worth-it verdict lives in DecisionSummary, which folds this
// panel away under "View full analysis".
export function PricePackagePanel({ pkg, onUse }: { pkg: PricingPackage; onUse: (sel: CadenceSelection) => void }) {
  const recLabel = CADENCE_LABELS[pkg.recommended.cadence]

  const cards: { cadence: CadenceKey; price: number; annual?: string }[] = [
    { cadence: 'one_time', price: pkg.oneTime },
    ...pkg.options.map(o => ({
      cadence: o.cadence as CadenceKey,
      price: o.price,
      annual: `$${o.price} × ${o.visits} visits = $${o.annual.toLocaleString()}/season`,
    })),
  ]

  return (
    <div className="space-y-3 motion-safe:animate-[fadeIn_140ms_ease-out]">
      {/* Cadence prices — tap to use on the quote */}
      <div className="grid grid-cols-2 gap-2">
        {cards.map(c => {
          const isRec = c.cadence === pkg.recommended.cadence
          return (
            <button key={c.cadence} type="button" onClick={() => onUse({ cadence: c.cadence, price: c.price })}
              className={cn('text-left rounded-xl border px-3 py-2.5 transition-all hover:border-accent',
                isRec ? 'border-accent/50 bg-accent/10' : 'border-border')}>
              <p className="text-[11px] uppercase tracking-wide text-ink-faint flex items-center gap-1">
                {CADENCE_LABELS[c.cadence]}{isRec && <Trophy className="w-3 h-3 text-accent" />}
              </p>
              <p className="text-lg font-bold text-ink tabular-nums">${c.price.toLocaleString()}</p>
              {c.annual && <p className="text-[10px] text-ink-faint leading-tight mt-0.5">{c.annual}</p>}
              <p className={cn('text-[10px] font-semibold mt-1', isRec ? 'text-accent' : 'text-ink-faint')}>Use {CADENCE_LABELS[c.cadence]} →</p>
            </button>
          )
        })}
      </div>

      {/* Value-based pricing: confidence + route-aware why */}
      {pkg.valuePricing && (
        <div className={cn('rounded-xl border px-3 py-2.5', AGG_META[pkg.valuePricing.aggressiveness].cls)}>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            {/* Same pill treatment as every other confidence marker — one visual language. */}
            <p className="text-xs font-bold flex items-center gap-1.5">
              <Route className="w-3.5 h-3.5" />
              <span className="text-[10px] font-semibold rounded-full px-2 py-0.5 border border-current/30">{pkg.valuePricing.confidence}</span>
            </p>
            <span className="text-[10px] font-semibold uppercase tracking-wide">{AGG_META[pkg.valuePricing.aggressiveness].label}</span>
          </div>
          <ul className="mt-1 space-y-0.5">
            {pkg.valuePricing.reasons.map((r, i) => <li key={i} className="text-[11px] text-ink-muted">• {r}</li>)}
          </ul>
        </div>
      )}

      {/* 🏆 Which option to push, and why */}
      <div className="rounded-xl border border-accent/30 bg-accent/5 px-3 py-2.5">
        <p className="text-xs font-bold text-accent flex items-center gap-1.5"><Trophy className="w-3.5 h-3.5" /> Recommended: {recLabel} service</p>
        <ul className="mt-1 space-y-0.5">
          {pkg.recommended.reasons.map((r, i) => <li key={i} className="text-[11px] text-ink-muted">• {r}</li>)}
        </ul>
      </div>

      {/* Don't underprice it */}
      <div className="rounded-xl border border-border bg-bg-tertiary px-3 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint flex items-center gap-1.5 mb-1.5">
          <ShieldAlert className="w-3.5 h-3.5" /> Pricing guidance ({recLabel.toLowerCase()})
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
          <Guide label="Suggested" value={`$${pkg.guidance.suggested}`} tone="text-ink" />
          <Guide label="Market range" value={`$${pkg.guidance.rangeLow}–${pkg.guidance.rangeHigh}`} tone="text-ink-muted" />
          <Guide label="Minimum" value={`$${pkg.guidance.minimum}`} tone="text-amber-400" />
          <Guide label="Avoid below" value={`$${pkg.guidance.avoidBelow}`} tone="text-red-400" />
        </div>
      </div>
    </div>
  )
}

function Guide({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-secondary px-2 py-1.5">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={cn('text-sm font-bold tabular-nums', tone)}>{value}</p>
    </div>
  )
}
