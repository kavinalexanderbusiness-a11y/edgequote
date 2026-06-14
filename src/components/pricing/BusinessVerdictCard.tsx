'use client'

import { ReactNode } from 'react'
import { ProspectAssessment } from '@/lib/prospect'
import { PricingPackage } from '@/lib/pricing'
import { CadenceSelection, CADENCE_LABELS } from '@/components/pricing/PricePackagePanel'
import { Collapsible } from '@/components/ui/Collapsible'
import { cn } from '@/lib/utils'
import { Check, X, ArrowRight, BarChart3, SlidersHorizontal } from 'lucide-react'

// ── The decision, first ─────────────────────────────────────────────────────
// Everything the owner needs to answer "should I take this customer?" in one
// glance: the 🟢/🟡/🔴 verdict, the price to charge, the four money numbers,
// Take / Maybe / Pass, and ✓/✗ reasoning. The price options and the full
// route/growth analysis stay one tap away under "Full analysis" — present, not
// in the way. All numbers come pre-computed from lib/prospect's `decision`.

const CALL = {
  take: { dot: '🟢', cls: 'border-emerald-500/40 bg-emerald-500/5', tone: 'text-emerald-400', btn: 'bg-emerald-500 hover:bg-emerald-400 text-black', pill: 'Take this customer' },
  maybe: { dot: '🟡', cls: 'border-amber-500/40 bg-amber-500/5', tone: 'text-amber-400', btn: 'bg-amber-500 hover:bg-amber-400 text-black', pill: 'Maybe — your call' },
  pass: { dot: '🔴', cls: 'border-red-500/40 bg-red-500/5', tone: 'text-red-400', btn: 'bg-surface hover:bg-bg-tertiary text-ink border border-border', pill: 'Consider passing' },
} as const

export function BusinessVerdictCard({
  a, pkg, onUse, details,
}: {
  a: ProspectAssessment
  pkg: PricingPackage
  onUse: (sel: CadenceSelection) => void
  details?: ReactNode
}) {
  const d = a.decision
  const c = CALL[d.call]
  const recCadence = pkg.recommended.cadence
  const recLabel = CADENCE_LABELS[recCadence]

  return (
    <div className={cn('rounded-xl border p-4 space-y-3.5', c.cls)}>
      {/* Verdict headline */}
      <div className="flex items-center justify-between gap-3">
        <p className={cn('text-base font-bold', c.tone)}>{c.dot} {d.headline}</p>
        <span className={cn('text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full border', c.tone, c.cls)}>
          {d.summary}
        </span>
      </div>

      {/* The four money numbers */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Money label="Recommended price" value={`$${d.recommendedPrice}`} big tone={c.tone} />
        <Money label="Expected revenue" value={`$${d.expectedRevenue}`} />
        <Money label="Expected profit" value={`$${d.expectedProfit}`} tone={d.expectedProfit > 0 ? 'text-emerald-400' : 'text-red-400'} />
        <Money label="Revenue / hour" value={`$${d.revPerHour}/hr`} />
      </div>

      {/* ✓/✗ reasoning */}
      <ul className="space-y-1">
        {d.reasons.map((r, i) => (
          <li key={i} className="flex items-center gap-2 text-[13px]">
            {r.good
              ? <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              : <X className="w-3.5 h-3.5 text-red-400 shrink-0" />}
            <span className={r.good ? 'text-ink' : 'text-ink-muted'}>{r.text}</span>
          </li>
        ))}
      </ul>

      {/* Primary action — charge the recommended price */}
      <button
        type="button"
        onClick={() => onUse({ cadence: recCadence, price: d.recommendedPrice })}
        className={cn('w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-colors', c.btn)}
      >
        Use {recLabel} — ${d.recommendedPrice}
        <ArrowRight className="w-4 h-4" />
      </button>

      {/* Everything else — present, one tap away */}
      {details && (
        <Collapsible
          title="Full analysis"
          icon={BarChart3}
          summary={`Profit/hr $${d.profitPerHour} · all cadence options · route & growth`}
        >
          <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">
            <SlidersHorizontal className="w-3 h-3" />
            Crew cost ${a.financial.crewCostPerHour}/hr · labour ${a.financial.laborCost}/visit · change in Settings → Business Basics
          </div>
          {details}
        </Collapsible>
      )}
    </div>
  )
}

function Money({ label, value, big, tone }: { label: string; value: string; big?: boolean; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-secondary px-2.5 py-2">
      <p className="text-[9px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={cn('font-bold text-ink', big ? 'text-lg' : 'text-base', tone)}>{value}</p>
    </div>
  )
}
