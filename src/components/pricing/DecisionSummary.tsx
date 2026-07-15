'use client'

import { useState } from 'react'
import { ProspectAssessment } from '@/lib/prospect'
import { PricingPackage } from '@/lib/pricing'
import { PricePackagePanel, CadenceSelection, CADENCE_LABELS } from '@/components/pricing/PricePackagePanel'
import { Collapsible } from '@/components/ui/Collapsible'
import { cn } from '@/lib/utils'
import { ArrowRight, BarChart3, ChevronDown, DollarSign, Loader2, Route, Sprout, Star, TrendingUp } from 'lucide-react'

// ── 80% of the value in 20% of the screen ───────────────────────────────────
// The owner reads FIVE numbers and a row of tags, sees the take/minimum/avoid
// box, taps the price. Everything else — the full route/customer/growth/LTV
// analysis — stays folded behind "View Full Analysis", one tap away. Every
// number is pre-computed by lib/prospect + lib/pricing; this only re-presents
// it. No fact is shown twice: each lives in exactly one place.

const CALL = {
  take: { dot: '🟢', cls: 'border-emerald-500/40 bg-emerald-500/5', tone: 'text-emerald-400', btn: 'bg-emerald-500 hover:bg-emerald-400 text-black' },
  maybe: { dot: '🟡', cls: 'border-amber-500/40 bg-amber-500/5', tone: 'text-amber-400', btn: 'bg-amber-500 hover:bg-amber-400 text-black' },
  pass: { dot: '🔴', cls: 'border-red-500/40 bg-red-500/5', tone: 'text-red-400', btn: 'bg-surface hover:bg-bg-tertiary text-ink border border-border' },
} as const

const TONE = {
  good: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
  warn: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
  bad: 'text-red-400 border-red-500/30 bg-red-500/10',
  neutral: 'text-ink-muted border-border bg-bg-tertiary',
} as const
type Tone = keyof typeof TONE

function gradeTone(score: ProspectAssessment['score']): string {
  if (score === 'A+' || score === 'A') return 'text-emerald-400'
  if (score === 'B') return 'text-accent'
  if (score === 'C') return 'text-amber-400'
  return 'text-red-400'
}

// The whole "why", as short badges — the only reasoning in the default view.
// Each is one signal, shown once; the numbers behind it live in Full Analysis.
function buildTags(a: ProspectAssessment, pkg: PricingPackage): { text: string; tone: Tone }[] {
  const tags: { text: string; tone: Tone }[] = []

  // Route — strong tightens the route, isolated means a long drive.
  if (a.routeImpact === 'strengthens') tags.push({ text: '✅ Existing Route', tone: 'good' })
  else if (a.routeImpact === 'isolated') tags.push({ text: '⚠️ Long Drive', tone: 'warn' })

  // Recurring revenue is worth flagging; one-time needs no badge.
  if (pkg.recommended.cadence !== 'one_time') tags.push({ text: '✅ Recurring Revenue', tone: 'good' })

  // Margin — healthy vs thin, from the profit engine.
  const underpriced = a.financial.expectedProfit <= 0
  if (a.financial.expectedProfit > 0 && a.financial.profitPerHour >= a.financial.crewCostPerHour)
    tags.push({ text: '✅ High Profit', tone: 'good' })
  else if (underpriced) tags.push({ text: '❌ Underpriced', tone: 'bad' })
  else tags.push({ text: '⚠️ Low Margin', tone: 'warn' })

  // Pricing power in the area — NEVER shown alongside ❌ Underpriced. The pricing-
  // power signal is grade-derived; when the visit actually loses money the profit
  // warning wins, so a card can never say "Premium Area" and "Underpriced" at once.
  if (!underpriced) {
    if (pkg.valuePricing?.aggressiveness === 'aggressive') tags.push({ text: '✅ Premium Area', tone: 'good' })
    else if (pkg.valuePricing?.aggressiveness === 'protective') tags.push({ text: '⚠️ Hold Price', tone: 'warn' })
  }

  return tags
}

export function DecisionSummary({
  a, pkg, onUse, busy,
}: {
  a: ProspectAssessment
  pkg: PricingPackage
  onUse: (sel: CadenceSelection) => void
  /** The parent is acting on the selection (e.g. creating the quote) — the CTA
      shows a spinner and locks against double-taps. Presentation only. */
  busy?: boolean
}) {
  const d = a.decision
  const c = CALL[d.call]
  const recCadence = pkg.recommended.cadence
  const recLabel = CADENCE_LABELS[recCadence]
  const [showFull, setShowFull] = useState(false)
  const tags = buildTags(a, pkg)

  return (
    <div className="space-y-3 animate-fade">
      {/* ── DECISION SUMMARY — answers only: take? charge? minimum? freq? why? */}
      <div className={cn('rounded-xl border p-4 space-y-3', c.cls)}>
        {/* Q1 — should I take this customer? */}
        <div className="flex items-center justify-between gap-3">
          <p className={cn('text-base font-bold', c.tone)}>{c.dot} {d.headline}</p>
          <div className="text-center shrink-0">
            <p className={cn('text-2xl font-black leading-none', gradeTone(a.score))}>{a.score}</p>
            <p className="text-[10px] uppercase tracking-wide text-ink-faint mt-0.5">Grade</p>
          </div>
        </div>

        {/* Why this recommendation? — the top signals behind the grade, straight
            from the SAME engine (decision.reasons; presentation only). Positive
            drivers lead; a weak verdict honestly leads with what's dragging it. */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Why this recommendation?</p>
          <ul className="mt-1 space-y-0.5">
            {[...d.reasons].sort((x, y) => Number(y.good) - Number(x.good)).slice(0, 4).map((r, i) => (
              <li key={i} className="text-[11px] text-ink-muted flex items-center gap-1.5">
                <span className={cn('font-bold shrink-0', r.good ? 'text-emerald-400' : 'text-amber-400')}>{r.good ? '✓' : '✗'}</span>
                {r.text}
              </li>
            ))}
          </ul>
        </div>

        {/* Q4 frequency + Q2 charge, front and centre — the plan to pitch */}
        <div>
          <div className="mb-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Recommended Plan</p>
            <p className="text-lg font-bold text-ink leading-tight">{recLabel} · ${d.recommendedPrice}</p>
          </div>
          {/* Q2 charge? Q3 minimum? — accept / minimum / avoid */}
          <div className="grid grid-cols-3 gap-2">
            <Decision label="Accept at" value={`$${d.recommendedPrice}`} tone="text-emerald-400" cls="border-emerald-500/30 bg-emerald-500/5" />
            <Decision label="Minimum" value={`$${pkg.guidance.minimum}`} tone="text-amber-400" cls="border-amber-500/30 bg-amber-500/5" />
            <Decision label="Avoid below" value={`$${pkg.guidance.avoidBelow}`} tone="text-red-400" cls="border-red-500/30 bg-red-500/5" />
          </div>
        </div>

        {/* Q5 — why? badges only, no prose */}
        <div className="flex flex-wrap gap-1.5">
          {tags.map((t, i) => (
            <span key={i} className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border', TONE[t.tone])}>
              {t.text}
            </span>
          ))}
        </div>
      </div>

      {/* ── PRIMARY ACTION — spinner + lock while the parent creates the quote */}
      <button
        type="button"
        disabled={busy}
        onClick={() => onUse({ cadence: recCadence, price: d.recommendedPrice })}
        className={cn('w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-colors disabled:opacity-60 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50', c.btn)}
      >
        {busy ? 'Creating quote…' : <>Use {recLabel} — ${d.recommendedPrice}</>}
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
      </button>

      {/* ── FULL ANALYSIS — folded away until asked for ──────────────────── */}
      <button
        type="button"
        aria-expanded={showFull}
        onClick={() => setShowFull(s => !s)}
        className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold text-ink-muted hover:text-ink hover:bg-bg-tertiary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <BarChart3 className="w-3.5 h-3.5" />
        {showFull ? 'Hide full analysis' : 'View full analysis'}
        <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', showFull && 'rotate-180')} />
      </button>

      {showFull && (
        <div className="space-y-2 animate-fade">
          {/* Pricing Details — the one home for cadence prices + guidance */}
          <Collapsible title="Pricing Details" icon={DollarSign}
            summary={`One-time $${pkg.oneTime} · ${recLabel} $${d.recommendedPrice}`}>
            <PricePackagePanel pkg={pkg} onUse={onUse} />
          </Collapsible>

          {/* Route Impact — ownership, rank, travel */}
          <Collapsible title="Route Impact" icon={Route}
            summary={a.routeOwnership.label}>
            <div className="space-y-2.5">
              <div className="flex items-center gap-0.5">
                {[1, 2, 3, 4, 5].map(i => (
                  <Star key={i} className={cn('w-4 h-4', i <= a.routeOwnership.stars ? 'text-amber-400 fill-amber-400' : 'text-ink-faint')} />
                ))}
                <span className={cn('ml-2 text-xs font-bold',
                  a.routeOwnership.label === 'Route Asset' ? 'text-emerald-400'
                    : a.routeOwnership.label === 'Solid Addition' ? 'text-amber-400' : 'text-red-400')}>
                  {a.routeOwnership.label}
                </span>
              </div>
              <p className="text-[11px] text-ink-muted">{a.routeOwnership.reasons.join(' · ')}</p>
              <ul className="space-y-0.5">
                <li className="text-[11px] text-ink-muted">• Travel: {a.financial.travelImpact}</li>
                <li className="text-[11px] text-ink-muted">• Route: {a.financial.routeImpact}</li>
              </ul>
              {a.competitive && (
                <p className="text-xs text-ink">
                  Area rank — {a.competitive.hood}:{' '}
                  <span className="font-bold">{a.competitive.currentRank != null ? `#${a.competitive.currentRank}` : 'Unranked'}</span>
                  <span className="text-ink-faint"> → </span>
                  <span className={cn('font-bold', a.competitive.projectedRank <= 3 ? 'text-emerald-400' : 'text-ink')}>#{a.competitive.projectedRank}</span>
                  <span className="text-ink-faint"> of {a.competitive.totalAreas}</span>
                </p>
              )}
            </div>
          </Collapsible>

          {/* Customer Value — stars + why */}
          <Collapsible title="Customer Value" icon={Star}
            summary={`${a.stars}/5 · ${a.lifetime.cadenceLabel}`}>
            <div className="flex items-center gap-0.5 mb-1.5">
              {[1, 2, 3, 4, 5].map(i => (
                <Star key={i} className={cn('w-4 h-4', i <= a.stars ? 'text-amber-400 fill-amber-400' : 'text-ink-faint')} />
              ))}
            </div>
            <ul className="space-y-0.5">
              {a.starReasons.map((r, i) => <li key={i} className="text-[11px] text-ink-muted">• {r}</li>)}
            </ul>
          </Collapsible>

          {/* Growth Opportunity — bullets, narrative, expansion */}
          <Collapsible title="Growth Opportunity" icon={Sprout}
            summary={a.growth.bullets[0] ?? 'Expansion potential'}>
            <div className="space-y-2.5">
              <ul className="space-y-0.5">
                {a.growth.bullets.map((b, i) => <li key={i} className="text-[11px] text-ink-muted">• {b}</li>)}
              </ul>
              {a.growth.narrative && (
                <p className="text-xs font-medium text-accent flex items-start gap-1.5">
                  <TrendingUp className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {a.growth.narrative}
                </p>
              )}
              {a.expansion && (
                <div className="rounded-lg border border-border bg-bg-tertiary px-3 py-2.5">
                  <p className="text-xs font-bold text-emerald-400">
                    🟢 {a.expansion.kind === 'domination' ? 'Route Domination' : 'Route Expansion'}
                    <span className="text-ink font-semibold"> · {a.expansion.hood}</span>
                  </p>
                  <div className="grid grid-cols-2 gap-2 mt-1.5">
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-0.5">Current</p>
                      {a.expansion.current.map((x, i) => <p key={i} className="text-[11px] text-ink-muted">• {x}</p>)}
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-0.5">Potential</p>
                      {a.expansion.potential.map((x, i) => <p key={i} className="text-[11px] text-ink-muted">• {x}</p>)}
                    </div>
                  </div>
                  <p className="text-[11px] italic text-ink mt-1.5">“{a.expansion.reason}”</p>
                </div>
              )}
            </div>
          </Collapsible>

          {/* Revenue & Lifetime Value — season, rate, 1 / 3 / 5 year */}
          <Collapsible title="Revenue & Lifetime Value" icon={TrendingUp}
            summary={`$${a.financial.annual.toLocaleString()}/season · $${a.lifetime.fiveYear.toLocaleString()} over 5 yrs`}>
            <div className="grid grid-cols-2 gap-2 text-center mb-2">
              <Stat label="Season revenue" value={`$${a.financial.annual.toLocaleString()}`} />
              <Stat label="Est. $/hour" value={`$${a.financial.revPerHour}/hr`} />
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <Stat label="1 year" value={`$${a.lifetime.oneYear.toLocaleString()}`} />
              <Stat label="3 years" value={`$${a.lifetime.threeYear.toLocaleString()}`} />
              <Stat label="5 years" value={`$${a.lifetime.fiveYear.toLocaleString()}`} />
            </div>
            <p className="text-[11px] text-ink-faint mt-2">
              Crew cost ${a.financial.crewCostPerHour}/hr · labour ${a.financial.laborCost}/visit · {a.financial.timeBasis}
            </p>
          </Collapsible>
        </div>
      )}
    </div>
  )
}

// Stat tiles share ONE micro-label size (text-[10px]) + tabular figures across
// every pricing card, so grids read as one system.
function Stat({ label, value, big, tone }: { label: string; value: string; big?: boolean; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-secondary px-2.5 py-2">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={cn('font-bold text-ink tabular-nums', big ? 'text-lg' : 'text-sm', tone)}>{value}</p>
    </div>
  )
}

function Decision({ label, value, tone, cls }: { label: string; value: string; tone: string; cls: string }) {
  return (
    <div className={cn('rounded-lg border px-2.5 py-2 text-center', cls)}>
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={cn('text-base font-bold tabular-nums', tone)}>{value}</p>
    </div>
  )
}