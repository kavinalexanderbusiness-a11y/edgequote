'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { PageContainer } from '@/components/layout/PageContainer'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import {
  loadRevenueIntel, recordRecommendation, RevenueIntelReport, Opportunity, LtvForecast,
  OppKind, OPP_META, Confidence, FeedbackRow, priorityScoreLabel, priorityScoreTooltip,
} from '@/lib/revenueIntelligence'
import { INSUFFICIENT_LABEL, evidenceSummary, insufficientReason } from '@/lib/growthEvidence'
import { concentrationFact } from '@/lib/growthConcentration'
import { createActionLedger, withRow, type ActionOutcome } from '@/lib/growthActionState'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { StatTile } from '@/components/ui/StatTile'
import { Skeleton, SkeletonTiles, SkeletonRows } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { FilterPill } from '@/components/ui/FilterPill'
import { readCache, writeCache, CACHE_TTL } from '@/lib/clientCache'
import { formatCurrency, cn, timeAgo } from '@/lib/utils'
import { TrendingUp, Check, X, Trophy, ArrowRight, Sparkles, AlertTriangle, RefreshCw, HelpCircle } from 'lucide-react'
import { scrollBehavior } from '@/lib/motion'

// Confidence is a quiet dot + label (same language as the Suggestions advisor);
// the loud tinted pill is reserved for the churn-risk badge where alarm is the point.
const CONF_DOT: Record<Confidence, string> = { high: 'bg-emerald-400', medium: 'bg-amber-400', low: 'bg-ink-faint' }
const CONF_LABEL: Record<Confidence, string> = { high: 'High confidence', medium: 'Medium confidence', low: 'Worth a look' }
// The button the owner tapped, named back to them when its save fails.
const ACTION_LABEL: Record<'acted' | 'dismissed' | 'won', string> = { acted: 'Take action', dismissed: 'Dismiss', won: 'Mark won' }
const RISK_PILL: Record<Confidence, string> = {
  high: 'text-red-400 border-red-500/30 bg-red-500/10',
  medium: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
  low: 'text-ink-muted border-border bg-bg-tertiary',
}

export default function RevenueIntelligencePage() {
  const supabase = useMemo(() => createClient(), [])
  const [report, setReport] = useState<RevenueIntelReport | null>(() => readCache<RevenueIntelReport>('revintel', CACHE_TTL.medium))
  const [feedback, setFeedback] = useState<Record<string, FeedbackRow>>({})
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<OppKind | 'all'>('all')
  // ⭐ One save may be in flight per card, on several cards at once. Which cards
  // are busy, and what each shows while its save is pending or after it fails,
  // is decided by lib/growthActionState — pure, so it is proven offline in every
  // interleaving — not by a single `busy` key that the last click overwrote.
  const ledgerRef = useRef(createActionLedger<FeedbackRow>())
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set())
  const [actionError, setActionError] = useState<string | null>(null)
  const [showForecast, setShowForecast] = useState(false)
  // ⭐ A refresh that fails must SAY so. loadRevenueIntel returns null when any
  // read errors (its honesty gate) and throws on a dropped connection; both used
  // to fall through `if (res)` with nothing said, so the previous figures stayed
  // on screen as if they were current. The report is still KEPT — stale data
  // labelled stale beats a blank page — but it is labelled, dated, and a retry
  // is offered in the same line. `loadedAt` is null while the figures are the
  // session cache's (an earlier visit), so the label says "earlier results".
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [loadedAt, setLoadedAt] = useState<number | null>(null)

  async function load() {
    setLoading(true)
    setRefreshError(null)
    try {
      const res = await loadRevenueIntel(supabase)
      if (res) {
        setReport(res.report); setFeedback(res.feedback); setLoadedAt(Date.now()); writeCache('revintel', res.report)
        // The server's feedback is the new baseline for every card; a ledger
        // that remembered pre-refresh saves would restore to the wrong state.
        ledgerRef.current = createActionLedger<FeedbackRow>()
      }
      else setRefreshError('Could not refresh')
    } catch {
      setRefreshError('Could not refresh')
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ⭐ `result_value` is seeded from the FORECAST (`o.expectedValue`), not from
  // any invoice/payment evidence — there is no collections feed into this table
  // at all. "Marking won" records the owner's own claim that the play landed;
  // it does not verify what was actually charged or collected. Kept exactly as
  // the forecast on purpose (a "how much did they actually pay" flow would be a
  // different, real-money feature — invoicing/payments own that, not this
  // advisor), but every surface reading this value must say "marked won", never
  // "revenue" or "collected". See the `wonValue` tile above.
  //
  // ⭐ OPTIMISTIC, BUT NEVER A LIE. The badge changes on tap and the save
  // follows; if the save answers `ok: false` or throws, the card goes back to
  // the last state the server acknowledged and one line says what was not
  // recorded. Overlapping taps — on different cards, or twice on one — are
  // reconciled by the ledger, never by whichever response happened to land last.
  async function act(o: Opportunity, status: 'acted' | 'dismissed' | 'won') {
    const ledger = ledgerRef.current
    const row: FeedbackRow = { opportunity_key: o.key, kind: o.kind, status, expected_value: o.expectedValue, result_value: status === 'won' ? o.expectedValue : null }
    const seq = ledger.begin(o.key, row, feedback[o.key])
    setActionError(null)
    setBusyKeys(new Set(ledger.pendingKeys()))
    setFeedback(prev => withRow(prev, o.key, ledger.display(o.key)))
    let outcome: ActionOutcome
    try {
      const r = await recordRecommendation(supabase, o, status, status === 'won' ? o.expectedValue : undefined)
      outcome = r.ok ? { ok: true } : { ok: false, error: r.error }
    } catch (e) {
      outcome = { ok: false, error: String((e as Error)?.message ?? e) }
    }
    const settled = ledger.settle(o.key, seq, outcome)
    setFeedback(prev => withRow(prev, o.key, settled.display))
    setBusyKeys(new Set(ledger.pendingKeys()))
    if (settled.failed && !settled.superseded) {
      setActionError(`Couldn't save "${ACTION_LABEL[status]}" for ${o.customerName} — nothing was recorded. Check your connection and tap it again.`)
    }
  }

  if (loading && !report) {
    return (
      <PageContainer>
        <PageHeader crumb={{ label: 'Grow', href: '/dashboard/grow' }} title="Who to call next" description="Every customer scored for the moves that grow revenue — ranked by expected impact." />
        <SkeletonTiles count={4} />
        <Skeleton className="h-20 w-full rounded-card" />
        <SkeletonRows count={5} />
      </PageContainer>
    )
  }
  // A failed load must not render a literally blank page — say so, offer retry.
  if (!report) return (
    <PageContainer width="wide">
      <PageHeader crumb={{ label: 'Grow', href: '/dashboard/grow' }} title="Who to call next" />
      <p className="text-sm text-ink-muted">
        Could not load revenue intelligence — check your connection and{' '}
        <button type="button" onClick={load} disabled={loading} className="text-accent-text underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded disabled:opacity-50">try again</button>.
      </p>
    </PageContainer>
  )

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

  // The headline's one caveat line: how many recommendations the figure speaks
  // for, how many were left out, and — only when one customer dominates — the
  // share, from the SAME denominator (lib/growthConcentration; one-time upsells
  // are the next tile). A null fact simply drops out of the line.
  const recurringCaveat = [
    summary.unquantified > 0
      ? `/yr from ${summary.quantified} · ${summary.unquantified} without enough data`
      : `/yr from ${summary.quantified} recommendation${summary.quantified === 1 ? '' : 's'}`,
    concentrationFact(summary.concentration),
  ].filter(Boolean).join(' · ')

  const KINDS: (OppKind | 'all')[] = ['all', 'renewal', 'upsell', 'cross_sell', 'membership', 'referral', 'reactivation']
  const kindCount = (k: OppKind | 'all') => k === 'all' ? live.length : live.filter(o => o.kind === k).length

  return (
    <PageContainer>
      <PageHeader crumb={{ label: 'Grow', href: '/dashboard/grow' }} title="Who to call next"
        description="Every customer scored for the moves that grow revenue — ranked by expected impact."
        action={<Link href="/dashboard/intelligence"><Button variant="secondary" size="sm">View BI dashboard <ArrowRight className="w-3.5 h-3.5" /></Button></Link>} />

      {/* ⭐ Stale is said, above everything it qualifies. Not a card: one line,
          rendered only after a failed refresh, dating the figures still shown. */}
      {refreshError && (
        <p role="alert" className="text-xs text-amber-400">
          {refreshError} — showing {loadedAt ? `results from ${timeAgo(new Date(loadedAt).toISOString())}` : 'earlier results'}, which may be out of date.{' '}
          <button type="button" onClick={load} disabled={loading} className="underline font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded disabled:opacity-50">Retry</button>
        </p>
      )}

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
          sub={recurringCaveat}
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
          // ⭐ The ACTIVE kind stays visible at zero. Before, a refresh (or the
          // last dismissal) that emptied the selected kind hid its pill while
          // `filter` still held it — an empty list under "All" that was not
          // selected, with no way to see or clear the filter that caused it.
          if (k !== 'all' && n === 0 && filter !== k) return null
          return (
            <FilterPill key={k} active={filter === k} onClick={() => setFilter(k)}>
              {k === 'all' ? 'All' : OPP_META[k as OppKind].label} {n > 0 && <span className="opacity-70 tabular-nums">{n}</span>}
            </FilterPill>
          )
        })}
        <button onClick={load} disabled={loading} aria-busy={loading} title="Refresh" aria-label="Refresh opportunities" className="ml-auto h-8 w-8 rounded-lg border border-border text-ink-muted hover:text-ink flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"><RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} /></button>
      </div>

      {/* Ranked opportunities — the Action Center */}
      {/* A save that failed is said once, here, above the cards it concerns; the
          card itself has already gone back to its acknowledged state. */}
      {actionError && <p role="alert" className="text-xs text-amber-400">{actionError}</p>}
      <div className="space-y-2.5">
        {inFilter.length === 0 ? (
          <EmptyState icon={Sparkles} className="py-12" title="No opportunities in this view yet"
            description="Predictions sharpen as jobs complete and quotes are decided." />
        ) : inFilter.map((o, i) => (
          <OppCard key={o.key} o={o} index={i} status={feedback[o.key]?.status} busy={busyKeys.has(o.key)} onAct={act} />
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
                  {/* block: measured (same run) — `truncate` cannot clip an inline anchor, so long names overflowed the viewport. */}
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
                cannot support. The chip now says "Priority score N/100" in
                full (priorityScoreLabel — the same words the hero line uses;
                never `%`), VISIBLY: the fixture run at 375/390/430 measured
                that a title tooltip never appears on a touch screen, so a
                bare "61/100" was a number with no name for every phone user.
                The tooltip keeps the longer sentence for pointer users. */}
            <span className="inline-flex items-center gap-1.5 text-[10px] text-ink-faint tabular-nums" title={priorityScoreTooltip(o.score)}>
              <span className="w-10 h-1 rounded-full bg-border overflow-hidden">
                <span className="block h-full rounded-full bg-accent/80" style={{ width: `${Math.min(100, Math.max(4, o.score))}%` }} />
              </span>
              {priorityScoreLabel(o.score)}
            </span>
          </div>
          {/* break-words: measured at 375/390/430 — an unbroken customer name painted past the card (growth-visual-fixture run 1). */}
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
