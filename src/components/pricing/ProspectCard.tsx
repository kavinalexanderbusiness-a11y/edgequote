'use client'

import { ProspectAssessment } from '@/lib/prospect'
import { cn } from '@/lib/utils'
import { Star, TrendingUp, DollarSign, Sprout, Route } from 'lucide-react'

const VERDICT = {
  excellent: { dot: '🟢', label: 'Excellent customer', cls: 'border-emerald-500/40 bg-emerald-500/5', tone: 'text-emerald-400' },
  decent: { dot: '🟡', label: 'Decent customer', cls: 'border-amber-500/40 bg-amber-500/5', tone: 'text-amber-400' },
  weak: { dot: '🔴', label: 'Weak customer', cls: 'border-red-500/40 bg-red-500/5', tone: 'text-red-400' },
} as const

const ROUTE_IMPACT = {
  strengthens: { icon: '✅', label: 'Strengthens existing route', tone: 'text-emerald-400' },
  neutral: { icon: '⚠️', label: 'Neutral route impact', tone: 'text-amber-400' },
  isolated: { icon: '❌', label: 'Creates isolated stop', tone: 'text-red-400' },
} as const

// The business answer after measuring: do I actually want this customer?
// Score + reasons, financial impact, long-term value stars, growth potential
// and route impact — all composed from the existing engines (lib/prospect).
export function ProspectCard({ a }: { a: ProspectAssessment }) {
  const v = VERDICT[a.verdict]
  const ri = ROUTE_IMPACT[a.routeImpact]

  return (
    <div className={cn('rounded-xl border p-3.5 space-y-3', v.cls)}>
      {/* Verdict + score */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={cn('text-sm font-bold', v.tone)}>{v.dot} {v.label}</p>
          <ul className="mt-1 space-y-0.5">
            {a.reasons.map((r, i) => <li key={i} className="text-[11px] text-ink-muted">• {r}</li>)}
          </ul>
        </div>
        <div className="text-center shrink-0">
          <div className={cn('w-12 h-12 rounded-xl border flex items-center justify-center text-lg font-black', v.tone, v.cls)}>
            {a.score}
          </div>
          <p className="text-[9px] uppercase tracking-wide text-ink-faint mt-1">Est. score</p>
        </div>
      </div>

      {/* Financial impact */}
      <div className="rounded-lg border border-border bg-bg-secondary px-3 py-2.5">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint flex items-center gap-1.5 mb-1.5">
          <DollarSign className="w-3 h-3" /> Financial impact
        </p>
        <div className="grid grid-cols-3 gap-2 text-center">
          <Metric label="Per visit" value={`$${a.financial.revPerVisit}`} />
          <Metric label="Est. $/hour" value={`$${a.financial.revPerHour}`} />
          <Metric label="Season value" value={`$${a.financial.annual.toLocaleString()}`} />
        </div>
        <div className="mt-1.5 space-y-0.5">
          <p className="text-[11px] text-ink-muted">• Travel: {a.financial.travelImpact}</p>
          <p className="text-[11px] text-ink-muted">• Route: {a.financial.routeImpact}</p>
        </div>
      </div>

      {/* Long-term value + route impact */}
      <div className="grid sm:grid-cols-2 gap-2">
        <div className="rounded-lg border border-border bg-bg-secondary px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint mb-1">Customer value</p>
          <div className="flex items-center gap-0.5">
            {[1, 2, 3, 4, 5].map(i => (
              <Star key={i} className={cn('w-4 h-4', i <= a.stars ? 'text-amber-400 fill-amber-400' : 'text-ink-faint')} />
            ))}
          </div>
          <ul className="mt-1 space-y-0.5">
            {a.starReasons.map((r, i) => <li key={i} className="text-[11px] text-ink-muted">• {r}</li>)}
          </ul>
        </div>
        <div className="rounded-lg border border-border bg-bg-secondary px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint flex items-center gap-1.5 mb-1">
            <Route className="w-3 h-3" /> Route impact
          </p>
          <p className={cn('text-sm font-semibold', ri.tone)}>{ri.icon} {ri.label}</p>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint flex items-center gap-1.5 mt-2 mb-1">
            <Sprout className="w-3 h-3" /> Growth potential
          </p>
          <ul className="space-y-0.5">
            {a.growth.bullets.map((b, i) => <li key={i} className="text-[11px] text-ink-muted">• {b}</li>)}
          </ul>
        </div>
      </div>

      {a.growth.narrative && (
        <p className="text-xs font-medium text-accent flex items-start gap-1.5">
          <TrendingUp className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {a.growth.narrative}
        </p>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-bg-tertiary border border-border px-1.5 py-1.5">
      <p className="text-[9px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="text-sm font-bold text-ink">{value}</p>
    </div>
  )
}
