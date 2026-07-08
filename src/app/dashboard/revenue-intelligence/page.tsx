'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import {
  loadRevenueIntel, recordRecommendation, RevenueIntelReport, Opportunity, LtvForecast,
  OppKind, OPP_META, Confidence, FeedbackRow,
} from '@/lib/revenueIntelligence'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { StatTile } from '@/components/ui/StatTile'
import { Skeleton, SkeletonTiles, SkeletonRows } from '@/components/ui/Skeleton'
import { readCache, writeCache, CACHE_TTL } from '@/lib/clientCache'
import { formatCurrency, cn } from '@/lib/utils'
import { TrendingUp, Check, X, Trophy, ArrowRight, Sparkles, AlertTriangle, RefreshCw } from 'lucide-react'

const CONF_PILL: Record<Confidence, string> = {
  high: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
  medium: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
  low: 'text-ink-muted border-border bg-bg-tertiary',
}
const CONF_LABEL: Record<Confidence, string> = { high: 'High', medium: 'Medium', low: 'Worth a look' }

export default function RevenueIntelligencePage() {
  const supabase = useMemo(() => createClient(), [])
  const [report, setReport] = useState<RevenueIntelReport | null>(() => readCache<RevenueIntelReport>('revintel', CACHE_TTL.medium))
  const [feedback, setFeedback] = useState<Record<string, FeedbackRow>>({})
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<OppKind | 'all'>('all')
  const [busy, setBusy] = useState<string | null>(null)
  const [showForecast, setShowForecast] = useState(false)

  async function load() {
    try {
      const res = await loadRevenueIntel(supabase)
      if (res) { setReport(res.report); setFeedback(res.feedback); writeCache('revintel', res.report) }
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function act(o: Opportunity, status: 'acted' | 'dismissed' | 'won') {
    setBusy(o.key)
    setFeedback(prev => ({ ...prev, [o.key]: { opportunity_key: o.key, kind: o.kind, status, expected_value: o.expectedValue, result_value: status === 'won' ? o.expectedValue : null } }))
    await recordRecommendation(supabase, o, status, status === 'won' ? o.expectedValue : undefined)
    setBusy(null)
  }

  if (loading && !report) {
    return (
      <div className="max-w-5xl space-y-6">
        <PageHeader title="Revenue Intelligence" description="The highest-value moves to grow the business — ranked." />
        <SkeletonTiles count={4} />
        <Skeleton className="h-20 w-full rounded-card" />
        <SkeletonRows count={5} />
      </div>
    )
  }
  if (!report) return null

  const { opportunities, ltvForecast, summary } = report
  // Hide dismissed; keep open + acted/won (badged).
  const live = opportunities.filter(o => feedback[o.key]?.status !== 'dismissed')
  const inFilter = filter === 'all' ? live : live.filter(o => o.kind === filter)
  const fbList = Object.values(feedback)
  const actedCount = fbList.filter(f => f.status === 'acted' || f.status === 'won').length
  const wonCount = fbList.filter(f => f.status === 'won').length
  const wonValue = fbList.filter(f => f.status === 'won').reduce((s, f) => s + Number(f.result_value || 0), 0)

  const KINDS: (OppKind | 'all')[] = ['all', 'renewal', 'upsell', 'cross_sell', 'membership', 'referral', 'reactivation']
  const kindCount = (k: OppKind | 'all') => k === 'all' ? live.length : live.filter(o => o.kind === k).length

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader title="Revenue Intelligence"
        description="Every customer scored for the moves that grow revenue — ranked by expected impact."
        action={<Link href="/dashboard/intelligence"><Button variant="secondary" size="sm">View BI dashboard <ArrowRight className="w-3.5 h-3.5" /></Button></Link>} />

      {/* Summary — upside on the left, risk on the right (the two numbers that matter) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile label="Recurring opportunity" value={formatCurrency(summary.totalOpportunity)} sub="/yr if all won" accent />
        <Tile label="One-time opportunity" value={formatCurrency(summary.totalOneTime)} />
        <Tile label="Revenue from acted" value={formatCurrency(wonValue)} sub={`${actedCount} acted · ${wonCount} won`} />
        {(() => {
          const atRisk = ltvForecast.reduce((s, f) => s + (Number(f.churnRiskImpact) || 0), 0)
          // Tappable — opens + scrolls to the LTV forecast where the at-risk names live.
          return (
            <StatTile label="Revenue at churn risk" value={formatCurrency(atRisk)} sub="/yr — tap to see who" tone={atRisk > 0 ? 'danger' : undefined} tonedSurface={atRisk > 0}
              onClick={() => { setShowForecast(true); setTimeout(() => document.getElementById('ltv-forecast')?.scrollIntoView({ behavior: 'smooth' }), 50) }} />
          )
        })()}
      </div>

      {/* Top action — actionable, not just a headline (same act-tracking as the cards) */}
      {summary.topAction && (
        <div className="rounded-card border border-accent/30 bg-gradient-to-br from-accent/[0.08] to-transparent p-4 flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-wide text-ink-faint flex items-center gap-1.5"><Trophy className="w-3.5 h-3.5 text-accent" /> Top move right now</p>
            <p className="text-sm font-bold text-ink mt-1">{OPP_META[summary.topAction.kind].emoji} {summary.topAction.action} — {summary.topAction.customerName}</p>
            <p className="text-xs text-ink-muted mt-0.5">+{formatCurrency(summary.topAction.expectedValue)}{summary.topAction.oneTime ? ' one-time' : '/yr'} · {summary.topAction.score}/100 likelihood</p>
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
            <button key={k} onClick={() => setFilter(k)}
              className={cn('text-xs font-medium rounded-full px-3 py-1.5 border transition-colors',
                filter === k ? 'bg-accent text-black border-accent' : 'border-border text-ink-muted hover:text-ink')}>
              {k === 'all' ? 'All' : `${OPP_META[k as OppKind].emoji} ${OPP_META[k as OppKind].label}`} {n > 0 && <span className="opacity-70">{n}</span>}
            </button>
          )
        })}
        <button onClick={load} title="Refresh" className="ml-auto h-7 w-7 rounded-lg border border-border text-ink-muted hover:text-ink flex items-center justify-center"><RefreshCw className="w-3.5 h-3.5" /></button>
      </div>

      {/* Ranked opportunities — the Action Center */}
      <div className="space-y-2.5">
        {inFilter.length === 0 ? (
          <div className="py-12 text-center text-sm text-ink-muted">No opportunities in this view yet. As you complete jobs and quotes, predictions sharpen.</div>
        ) : inFilter.map(o => (
          <OppCard key={o.key} o={o} status={feedback[o.key]?.status} busy={busy === o.key} onAct={act} />
        ))}
      </div>

      {/* LTV Forecast */}
      <div id="ltv-forecast" className="rounded-card border border-border bg-bg-secondary overflow-hidden scroll-mt-4">
        <button onClick={() => setShowForecast(s => !s)} className="w-full px-5 py-3.5 flex items-center justify-between text-left">
          <span className="text-sm font-bold text-ink flex items-center gap-2"><Sparkles className="w-4 h-4 text-accent" /> Lifetime Value Forecast</span>
          <span className="text-xs text-ink-muted">{showForecast ? 'Hide' : `Show top ${Math.min(12, ltvForecast.length)}`}</span>
        </button>
        {showForecast && (
          <div className="divide-y divide-border border-t border-border">
            {ltvForecast.slice(0, 12).map(f => (
              <div key={f.customerId} className="px-5 py-2.5 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <Link href={`/dashboard/customers/${f.customerId}`} className="text-sm font-semibold text-ink truncate hover:text-accent">{f.customerName}</Link>
                  <p className="text-[11px] text-ink-faint">Now {formatCurrency(f.currentLtv)} → forecast {formatCurrency(f.forecastLtv)} · {formatCurrency(f.revenueRemaining)} remaining</p>
                </div>
                {f.churnRiskImpact > 0 && (
                  <span className={cn('shrink-0 text-[11px] font-semibold rounded-full px-2 py-0.5 border flex items-center gap-1', CONF_PILL[f.churnRisk])}>
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
    </div>
  )
}

// Thin adapter over the ONE shared KPI tile (no local tile styles to drift).
function Tile({ label, value, sub, accent, danger }: { label: string; value: string; sub?: string; accent?: boolean; danger?: boolean }) {
  return <StatTile label={label} value={value} sub={sub} accent={accent} tone={danger ? 'danger' : undefined} tonedSurface={danger} />
}

function OppCard({ o, status, busy, onAct }: { o: Opportunity; status?: string; busy: boolean; onAct: (o: Opportunity, s: 'acted' | 'dismissed' | 'won') => void }) {
  const [showWhy, setShowWhy] = useState(false)
  const meta = OPP_META[o.kind]
  const done = status === 'acted' || status === 'won'
  return (
    <div className={cn('rounded-card border p-3.5', status === 'won' ? 'border-emerald-500/30 bg-emerald-500/[0.04]' : done ? 'border-border bg-bg-tertiary' : 'border-border bg-bg-secondary')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border border-border text-ink-muted">{meta.emoji} {meta.label}</span>
            <span className={cn('text-[10px] font-semibold rounded-full px-2 py-0.5 border', CONF_PILL[o.confidence])}>{CONF_LABEL[o.confidence]}</span>
            <span className="text-[10px] text-ink-faint">{o.score}/100 likelihood</span>
          </div>
          <p className="text-sm font-bold text-ink mt-1.5">{o.action} — {o.customerName}</p>
        </div>
        <span className="shrink-0 text-sm font-bold text-accent flex items-center gap-1"><TrendingUp className="w-3.5 h-3.5" /> +{formatCurrency(o.expectedValue)}{o.oneTime ? '' : '/yr'}</span>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {status === 'won' ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-400"><Trophy className="w-4 h-4" /> Won</span>
        ) : done ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-muted"><Check className="w-3.5 h-3.5 text-accent" /> Acted</span>
            <Button size="sm" variant="secondary" onClick={() => onAct(o, 'won')} loading={busy}><Trophy className="w-3.5 h-3.5" /> Mark won</Button>
          </>
        ) : (
          <>
            <Link href={o.actionHref} onClick={() => onAct(o, 'acted')}><Button size="sm">{o.offer ? `Offer ${o.offer}` : 'Take action'} <ArrowRight className="w-3.5 h-3.5" /></Button></Link>
            <Button size="sm" variant="ghost" onClick={() => onAct(o, 'dismissed')} disabled={busy}><X className="w-3.5 h-3.5" /> Dismiss</Button>
          </>
        )}
        <button onClick={() => setShowWhy(v => !v)} className="ml-auto text-[11px] font-medium text-ink-faint hover:text-ink">Why?</button>
      </div>

      {showWhy && (
        <ul className="mt-2 space-y-0.5 border-t border-border pt-2">
          {o.why.map((w, i) => <li key={i} className="text-xs text-ink-muted flex gap-1.5"><span className="text-accent/60 shrink-0">•</span><span>{w}</span></li>)}
        </ul>
      )}
    </div>
  )
}
