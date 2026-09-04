'use client'

import { useState } from 'react'
import { PageContainer } from '@/components/layout/PageContainer'
import Link from 'next/link'
import {
  RevenueIntelReport, Opportunity, OppKind, OPP_META, Confidence, FeedbackRow, priorityScoreLabel, priorityScoreTooltip,
} from '@/lib/revenueIntelligence'
import { INSUFFICIENT_LABEL, evidenceSummary, insufficientReason } from '@/lib/growthEvidence'
import { concentrationNote } from '@/lib/growthConcentration'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { StatTile } from '@/components/ui/StatTile'
import { EmptyState } from '@/components/ui/EmptyState'
import { FilterPill } from '@/components/ui/FilterPill'
import { formatCurrency, cn } from '@/lib/utils'
import { TrendingUp, Check, X, Trophy, ArrowRight, Sparkles, AlertTriangle, RefreshCw, HelpCircle } from 'lucide-react'
import { scrollBehavior } from '@/lib/motion'

// ── The "Who to call next" screen, as a PURE VIEW ────────────────────────────
// Everything below is the presentation that used to live inline in page.tsx,
// moved here verbatim so it can be rendered from props alone: the page wires it
// to Supabase (load / act / cache), and src/app/dev/growth-visual-fixture wires
// the SAME component to synthetic data for the browser-width proofs. One
// markup, two callers — a fixture that re-drew this screen by hand would prove
// only that the fixture works.
//
// ⛔ No data access here. No Supabase client, no cache, no fetch: `report`,
// `feedback` and `busy` arrive as props; `onAct` / `onRefresh` go back out.

// Confidence is a quiet dot + label (same language as the Suggestions advisor);
// the loud tinted pill is reserved for the churn-risk badge where alarm is the point.
const CONF_DOT: Record<Confidence, string> = { high: 'bg-emerald-400', medium: 'bg-amber-400', low: 'bg-ink-faint' }
const CONF_LABEL: Record<Confidence, string> = { high: 'High confidence', medium: 'Medium confidence', low: 'Worth a look' }
const RISK_PILL: Record<Confidence, string> = {
  high: 'text-red-400 border-red-500/30 bg-red-500/10',
  medium: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
  low: 'text-ink-muted border-border bg-bg-tertiary',
}

interface RevenueIntelligenceViewProps {
  report: RevenueIntelReport
  feedback: Record<string, FeedbackRow>
  /** The opportunity key currently being recorded, or null. */
  busy: string | null
  onAct: (o: Opportunity, status: 'acted' | 'dismissed' | 'won') => void | Promise<void>
  onRefresh: () => void | Promise<void>
}

// `onAct`/`onRefresh` are destructured to the names the moved body already
// uses (`act`, `load`), so the body below is the page's original, byte for byte.
export function RevenueIntelligenceView({ report, feedback, busy, onAct: act, onRefresh: load }: RevenueIntelligenceViewProps) {
  const [filter, setFilter] = useState<OppKind | 'all'>('all')
  const [showForecast, setShowForecast] = useState(false)

  const { opportunities, ltvForecast, summary } = report
  // Hide dismissed; keep open + acted/won (badged).
  const live = opportunities.filter(o => feedback[o.key]?.status !== 'dismissed')
  const inFilter = filter === 'all' ? live : live.filter(o => o.kind === filter)
  const fbList = Object.values(feedback)
  const actedCount = fbList.filter(f => f.status === 'acted' || f.status === 'won').length
  const wonCount = fbList.filter(f => f.status === 'won').length
  // ⭐⭐ THIS IS NOT COLLECTED REVENUE. `act()` below seeds `result_value` from
  // `o.expectedValue` — the SAME forecast figure the opportunity card already
  // showed — at the moment the owner taps "Mark won". Nothing here reads an
  // invoice, a payment or any other evidence that money actually changed hands;
  // `revenue_recommendations.result_value` has no such feed at all today. So
  // `wonValue` is "the sum of what we forecasted for the plays you told us you
  // won", not a collections figure — and the tile below is labelled to say
  // exactly that ("Value marked won"), never "Revenue" or "Collected".
  const wonValue = fbList.filter(f => f.status === 'won').reduce((s, f) => s + Number(f.result_value || 0), 0)

  const KINDS: (OppKind | 'all')[] = ['all', 'renewal', 'upsell', 'cross_sell', 'membership', 'referral', 'reactivation']
  const kindCount = (k: OppKind | 'all') => k === 'all' ? live.length : live.filter(o => o.kind === k).length

  return (
    <PageContainer>
      <PageHeader crumb={{ label: 'Grow', href: '/dashboard/grow' }} title="Who to call next"
        description="Every customer scored for the moves that grow revenue — ranked by expected impact."
        action={<Link href="/dashboard/intelligence"><Button variant="secondary" size="sm">View BI dashboard <ArrowRight className="w-3.5 h-3.5" /></Button></Link>} />

      {/* Summary — upside on the left, risk on the right (the two numbers that matter) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 animate-rise">
        {/* ⭐⭐ THE HEADLINE NOW SAYS HOW MUCH OF THE BOOK IT SPEAKS FOR.
            "$98,000/yr if all won" read as a claim about the whole advisor. It
            was in fact a sum over figures many of which were a single visit
            multiplied by a cadence nobody declared. The figure is now only the
            quantified ones, and the sub-line says how many were left out. */}
        {/* ⭐ subWrap: the audit that added this caveat is the same one that had
            it clipped to "19 without e…" at 375px — a truncated disclosure is
            no disclosure. See StatTile's subWrap doc for why this is opt-in
            rather than the shared component's new default. */}
        <Tile label="Recurring opportunity" value={formatCurrency(summary.totalOpportunity)}
          sub={summary.unquantified > 0
            ? `/yr from ${summary.quantified} · ${summary.unquantified} without enough data`
            : `/yr from ${summary.quantified} recommendation${summary.quantified === 1 ? '' : 's'}`}
          subWrap
          accent />
        <Tile label="One-time opportunity" value={formatCurrency(summary.totalOneTime)} />
        {/* ⭐ "Revenue from acted" implied collected money. This is the sum of
            forecasted expectedValue for plays marked won — see the `wonValue`
            comment above — so the label says what it actually is. */}
        <Tile label="Value marked won" value={formatCurrency(wonValue)} sub={`${actedCount} acted · ${wonCount} won`} />
        {(() => {
          const atRisk = ltvForecast.reduce((s, f) => s + (Number(f.churnRiskImpact) || 0), 0)
          // Tappable — opens + scrolls to the LTV forecast where the at-risk names live.
          return (
            <StatTile label="Revenue at churn risk" value={formatCurrency(atRisk)} sub="/yr — tap to see who" tone={atRisk > 0 ? 'danger' : undefined} tonedSurface={atRisk > 0}
              onClick={() => { setShowForecast(true); setTimeout(() => document.getElementById('ltv-forecast')?.scrollIntoView({ behavior: scrollBehavior() }), 50) }} />
          )
        })()}
      </div>

      {/* ⭐⭐ CONCENTRATION DISCLOSURE — a DIFFERENT fact from the tiles above.
          Those say how much money and how much of it is quantified; this says
          how much of THAT depends on one customer. Renders NOTHING unless the
          share crosses the documented threshold (lib/growthConcentration) —
          silence is the honest answer for an ordinary, well-spread book. Aggregated
          by customerId, never by name, so a shared display name cannot merge or
          split a customer's contribution into a false or hidden finding. */}
      {summary.concentration?.material && (() => {
        const note = concentrationNote(summary.concentration, formatCurrency)
        // ⭐ Explicit `break-words`: Banner's own content div is already
        // `flex-1 min-w-0` with no truncate/nowrap, so this sentence wraps by
        // default — but the sentence embeds a customer's own display name,
        // which is free text an owner typed and could in principle be one long
        // unbroken token (no spaces) at any width. `break-words` guarantees it
        // still wraps rather than overflowing the banner's fixed padding at
        // 375/390/430, without touching Banner's default behaviour for its many
        // other callers across the app.
        return note ? (
          <Banner tone="warn" icon={AlertTriangle} className="animate-rise">
            <p className="break-words">{note}</p>
          </Banner>
        ) : null
      })()}

      {/* Top action — the advisor's single best play, actionable in one tap */}
      {summary.topAction && (
        <div className="rounded-card border border-accent/30 hero-aurora p-5 flex flex-wrap items-center gap-4 animate-rise">
          <div className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/25 icon-glow flex items-center justify-center shrink-0">
            <Trophy className="w-5 h-5 text-accent-text" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Top move right now</p>
            <p className="text-base font-bold tracking-tight text-ink mt-0.5">{summary.topAction.action} — {summary.topAction.customerName}</p>
            {/* ⭐⭐ "% likely to land" claimed a measured conversion probability.
                The score is a fixed-point heuristic (base + signal deltas,
                clamped 0-100) — real for RANKING, invented if read as a
                percentage chance. priorityScoreLabel is the one honest sentence,
                shared with every OppCard below so neither drifts back. */}
            <p className="text-xs text-ink-muted mt-1 tabular-nums">
              <span className="font-semibold text-accent-text">+{formatCurrency(summary.topAction.expectedValue)}{summary.topAction.oneTime ? ' one-time' : '/yr'}</span>
              {' '}· {priorityScoreLabel(summary.topAction.score)}, based on this customer’s history
            </p>
          </div>
          <Link href={summary.topAction.actionHref} onClick={() => act(summary.topAction!, 'acted')} className="shrink-0">
            <Button size="sm">Take action <ArrowRight className="w-3.5 h-3.5" /></Button>
          </Link>
        </div>
      )}

      {/* Filter */}
      <div className="flex flex-wrap items-center gap-1.5">
        {KINDS.map(k => {
          const n = kindCount(k)
          if (k !== 'all' && n === 0) return null
          return (
            <FilterPill key={k} active={filter === k} onClick={() => setFilter(k)}>
              {k === 'all' ? 'All' : OPP_META[k as OppKind].label} {n > 0 && <span className="opacity-70 tabular-nums">{n}</span>}
            </FilterPill>
          )
        })}
        <button onClick={load} title="Refresh" aria-label="Refresh opportunities" className="ml-auto h-8 w-8 rounded-lg border border-border text-ink-muted hover:text-ink flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"><RefreshCw className="w-3.5 h-3.5" /></button>
      </div>

      {/* Ranked opportunities — the Action Center */}
      <div className="space-y-2.5">
        {inFilter.length === 0 ? (
          <EmptyState icon={Sparkles} className="py-12" title="No opportunities in this view yet"
            description="Predictions sharpen as jobs complete and quotes are decided." />
        ) : inFilter.map((o, i) => (
          <OppCard key={o.key} o={o} index={i} status={feedback[o.key]?.status} busy={busy === o.key} onAct={act} />
        ))}
      </div>

      {/* LTV Forecast */}
      <div id="ltv-forecast" className="rounded-card border border-border bg-bg-secondary overflow-hidden scroll-mt-4">
        <button onClick={() => setShowForecast(s => !s)} aria-expanded={showForecast} className="w-full px-5 py-3.5 flex items-center justify-between text-left rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40">
          <span className="text-sm font-bold text-ink flex items-center gap-2"><Sparkles className="w-4 h-4 text-accent-text" /> Lifetime Value Forecast</span>
          <span className="text-xs text-ink-muted">{showForecast ? 'Hide' : ltvForecast.length === 0 ? 'Nothing to forecast yet' : `Show top ${Math.min(12, ltvForecast.length)}`}</span>
        </button>
        {showForecast && (
          <div className="divide-y divide-border border-t border-border">
            {/* "Show top 0" over an empty bordered void was an invitation to nothing. */}
            {ltvForecast.length === 0 && (
              <p className="px-5 py-4 text-sm text-ink-muted">Forecasts appear once customers have completed jobs.</p>
            )}
            {ltvForecast.slice(0, 12).map(f => (
              <div key={f.customerId} className="px-5 py-2.5 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  {/* ⭐ block: MEASURED (same run) — `truncate` on an INLINE anchor
                      cannot clip (overflow does not apply to inline boxes) but its
                      nowrap still stops wrapping, so any long name, spaced or not,
                      painted past the viewport (383px and 410px wide at 375px).
                      As a block it gets the row's width and the ellipsis works. */}
                  <Link href={`/dashboard/customers/${f.customerId}`} className="block text-sm font-semibold text-ink truncate hover:text-accent-text">{f.customerName}</Link>
                  <p className="text-[11px] text-ink-faint tabular-nums">Now {formatCurrency(f.currentLtv)} → forecast {formatCurrency(f.forecastLtv)} · {formatCurrency(f.revenueRemaining)} remaining</p>
                </div>
                {f.churnRiskImpact > 0 && (
                  <span className={cn('shrink-0 text-[11px] font-semibold rounded-full px-2 py-0.5 border flex items-center gap-1 tabular-nums', RISK_PILL[f.churnRisk])}>
                    {f.churnRisk === 'high' && <AlertTriangle className="w-3 h-3" />}{formatCurrency(f.churnRiskImpact)}/yr at risk
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-[11px] text-ink-faint text-center">
        Acting on / dismissing a recommendation is tracked so the ranking learns which plays actually produce revenue.
      </p>
    </PageContainer>
  )
}

// Thin adapter over the ONE shared KPI tile (no local tile styles to drift).
function Tile({ label, value, sub, accent, danger, subWrap }: { label: string; value: string; sub?: string; accent?: boolean; danger?: boolean; subWrap?: boolean }) {
  return <StatTile label={label} value={value} sub={sub} accent={accent} tone={danger ? 'danger' : undefined} tonedSurface={danger} subWrap={subWrap} />
}

function OppCard({ o, index, status, busy, onAct }: { o: Opportunity; index: number; status?: string; busy: boolean; onAct: (o: Opportunity, s: 'acted' | 'dismissed' | 'won') => void }) {
  const [showWhy, setShowWhy] = useState(false)
  const meta = OPP_META[o.kind]
  const done = status === 'acted' || status === 'won'
  return (
    <div className={cn(
      'rounded-card border p-4 animate-rise',
      index < 6 && `stagger-${index + 1}`,
      status === 'won' ? 'border-emerald-500/30 bg-emerald-500/[0.04]' : done ? 'border-border bg-bg-tertiary' : 'border-border bg-bg-secondary card-lift',
    )}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border border-border text-ink-muted">{meta.label}</span>
            <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-ink-muted rounded-full px-2 py-0.5 border border-border bg-bg-tertiary" title="How sure the advisor is, based on how much of this customer's history backs it">
              <span className={cn('w-1.5 h-1.5 rounded-full', CONF_DOT[o.confidence])} />
              {CONF_LABEL[o.confidence]}
            </span>
            {/* ⭐⭐ A PRIORITY METER, NOT A LIKELIHOOD METER. The bar's fill width
                is still driven by the same 0-100 score (that geometry is honest
                — it IS how the advisor ranks), but the number beside it used to
                read "61%" with a tooltip saying "likelihood this play lands",
                which is a measured-probability claim this heuristic score
                cannot support. `/100` (never `%`) plus the shared tooltip
                (priorityScoreTooltip, same sentence the hero card uses) is what
                makes the honest reading unambiguous at a glance. */}
            <span className="inline-flex items-center gap-1.5 text-[10px] text-ink-faint tabular-nums" title={priorityScoreTooltip(o.score)}>
              <span className="w-10 h-1 rounded-full bg-border overflow-hidden">
                <span className="block h-full rounded-full bg-accent/80" style={{ width: `${Math.min(100, Math.max(4, o.score))}%` }} />
              </span>
              {o.score}/100
            </span>
          </div>
          {/* ⭐ break-words: MEASURED at 375/390/430 (growth-visual-fixture run 1,
              d8325a80) — a customer name with no break opportunity (an
              imported-record style token) painted 400px wide inside a
              189-244px column and made the whole dashboard column scroll
              sideways. Same fix the concentration banner already carries. */}
          <p className="text-sm font-bold tracking-tight text-ink mt-1.5 break-words">{o.action} — {o.customerName}</p>
        </div>
        {/* ⭐⭐ THE FIGURE ONLY APPEARS WHEN ITS EVIDENCE EARNED IT.
            An unquantified opportunity is still worth acting on — the action and
            the reasoning are unchanged — so this states the absence plainly
            instead of printing a confident "+$0/yr", which would read as "this
            customer is worth nothing". */}
        {o.expectedValue > 0 ? (
          <span className="shrink-0 text-sm font-bold text-accent-text flex items-center gap-1 tabular-nums"><TrendingUp className="w-3.5 h-3.5" /> +{formatCurrency(o.expectedValue)}{o.oneTime ? '' : '/yr'}</span>
        ) : (
          <span className="shrink-0 text-[11px] font-semibold text-ink-faint text-right leading-tight max-w-[9.5rem]"
            title={insufficientReason(o.evidence)}>
            {INSUFFICIENT_LABEL}
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {status === 'won' ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-400"><Trophy className="w-4 h-4" /> Won</span>
        ) : done ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-muted"><Check className="w-3.5 h-3.5 text-accent-text" /> Acted</span>
            <Button size="sm" variant="secondary" onClick={() => onAct(o, 'won')} loading={busy}><Trophy className="w-3.5 h-3.5" /> Mark won</Button>
          </>
        ) : (
          <>
            <Link href={o.actionHref} onClick={() => onAct(o, 'acted')}><Button size="sm">{o.offer ? `Offer ${o.offer}` : 'Take action'} <ArrowRight className="w-3.5 h-3.5" /></Button></Link>
            <Button size="sm" variant="ghost" onClick={() => onAct(o, 'dismissed')} disabled={busy}><X className="w-3.5 h-3.5" /> Dismiss</Button>
          </>
        )}
        {/* ⭐ Given a real touch height because this control is now load-bearing:
            it is the door to the evidence behind the figure — sample size, the
            statistic, the cadence assumption, the formula and the exclusions.
            A transparency affordance nobody can reliably tap on a phone is not
            transparency. */}
        <button onClick={() => setShowWhy(v => !v)}
          aria-expanded={showWhy}
          className="ml-auto min-h-[32px] px-1.5 -mr-1.5 text-[11px] font-medium text-ink-faint hover:text-ink transition-colors rounded flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          <HelpCircle className="w-3 h-3" /> {showWhy ? 'Hide' : 'Why?'}
        </button>
      </div>

      {showWhy && (
        <div className="mt-2 border-t border-border pt-2 space-y-2">
          <ul className="space-y-0.5">
            {o.why.map((w, i) => <li key={i} className="text-xs text-ink-muted flex gap-1.5"><span className="text-accent-text/60 shrink-0">•</span><span>{w}</span></li>)}
          </ul>
          {/* ⭐⭐ THE TRANSPARENCY CONTRACT, in the one place the owner asks "why?".
              Record count, the statistic named, the cadence assumption, the
              annualization formula in full, and everything excluded with its
              reason. Fake precision is the failure mode this replaces: a figure
              to the dollar, derived from two visits and an assumed cadence. */}
          <div className="rounded-lg border border-border bg-bg-tertiary/60 px-2.5 py-2 space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">What this is based on</p>
            <p className="text-[11px] text-ink-muted">{evidenceSummary(o.evidence)}</p>
            {o.evidence.skew && (
              <p className="text-[11px] text-amber-400">Spread: {o.evidence.skew}</p>
            )}
            {o.expectedValue <= 0 && (
              <p className="text-[11px] text-ink-faint">{insufficientReason(o.evidence)}</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
