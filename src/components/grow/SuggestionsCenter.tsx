'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Suggestion, SuggestionAction, SuggestionCategory, CATEGORY_META, Confidence, applyPriceRaise, createRecurringPlan } from '@/lib/suggestions'
import { loadSuggestions } from '@/lib/suggestionsLoad'
import { formatCurrency, cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Sparkles, Check, ArrowRight, Clock, Navigation, TrendingUp, Loader2, RefreshCw, HelpCircle, Calculator } from 'lucide-react'

const CONF_PILL: Record<Confidence, string> = {
  high: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
  medium: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
  low: 'text-ink-muted border-border bg-bg-tertiary',
}
const CONF_LABEL: Record<Confidence, string> = { high: 'High confidence', medium: 'Medium', low: 'Worth a look' }

const FILTERS: { key: SuggestionCategory | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'profit', label: '💰 Profit' },
  { key: 'growth', label: '📍 Growth' },
  { key: 'route', label: '🚗 Route' },
  { key: 'problem', label: '⚠️ Problems' },
  { key: 'retention', label: '❤️ Keep' },
]

export function SuggestionsCenter() {
  const supabase = useMemo(() => createClient(), [])
  const [items, setItems] = useState<Suggestion[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<SuggestionCategory | 'all'>('all')
  const [showAll, setShowAll] = useState(false)
  const [showLow, setShowLow] = useState(false)
  const [applyingId, setApplyingId] = useState<string | null>(null)
  const [appliedId, setAppliedId] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try { setItems(await loadSuggestions(supabase)) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function runAction(s: Suggestion, action: SuggestionAction) {
    if (action.kind === 'apply-price' && action.apply) {
      setApplyingId(s.id)
      const res = await applyPriceRaise(supabase, action.apply)
      setApplyingId(null)
      if (res.ok) {
        setAppliedId(s.id)
        setNote(`${s.title} — applied. Future invoices use the new price.`)
        setTimeout(() => { setAppliedId(null); load() }, 1200)
      } else setNote(res.error || 'Could not apply. Try again.')
    } else if (action.kind === 'create-recurring' && action.plan) {
      setApplyingId(s.id)
      const res = await createRecurringPlan(supabase, action.plan)
      setApplyingId(null)
      if (res.ok) {
        setAppliedId(s.id)
        setNote(`Recurring plan created — ${res.count} visit${res.count !== 1 ? 's' : ''} scheduled. Review them on the Schedule.`)
        setTimeout(() => { setAppliedId(null); load() }, 1400)
      } else setNote(res.error || 'Could not create the plan.')
    }
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length }
    for (const s of items) c[s.category] = (c[s.category] || 0) + 1
    return c
  }, [items])
  const CAP = 6
  const inCategory = filter === 'all' ? items : items.filter(s => s.category === filter)
  const lowHidden = showLow ? 0 : inCategory.filter(s => s.confidence === 'low').length
  const filtered = showLow ? inCategory : inCategory.filter(s => s.confidence !== 'low')
  const visible = showAll ? filtered : filtered.slice(0, CAP)
  const totalAnnual = items.filter(s => s.category === 'profit' && !s.oneTime).reduce((sum, s) => sum + s.impact, 0)

  return (
    <div className="rounded-card border border-accent/20 bg-gradient-to-br from-accent/[0.07] to-transparent overflow-hidden">
      {/* Header — the headline question + total opportunity */}
      <div className="px-5 py-4 border-b border-border flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center shrink-0">
            <Sparkles className="w-4.5 h-4.5 text-accent" />
          </div>
          <div className="min-w-0">
            <p className="text-base font-bold text-ink">What should I do next?</p>
            <p className="text-xs text-ink-muted mt-0.5">
              {loading ? 'Reading your business…'
                : items.length === 0 ? 'You’re all caught up — nothing pressing right now.'
                : `${items.length} ranked action${items.length !== 1 ? 's' : ''}${totalAnnual > 0 ? ` · up to ${formatCurrency(totalAnnual)}/yr in pricing upside` : ''}`}
            </p>
          </div>
        </div>
        <button onClick={load} disabled={loading} title="Refresh"
          className="h-8 w-8 rounded-lg border border-border text-ink-muted hover:text-ink flex items-center justify-center shrink-0 disabled:opacity-50">
          <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
        </button>
      </div>

      {note && (
        <div className="px-5 py-2 bg-accent/5 border-b border-border text-xs text-ink flex items-center gap-2">
          <Check className="w-3.5 h-3.5 text-accent" /> {note}
        </div>
      )}

      {/* Category filter */}
      {!loading && items.length > 0 && (
        <div className="px-4 py-2.5 border-b border-border flex flex-wrap gap-1.5">
          {FILTERS.map(f => {
            const n = counts[f.key] || 0
            if (f.key !== 'all' && n === 0) return null
            return (
              <button key={f.key} onClick={() => { setFilter(f.key); setShowAll(false) }}
                className={cn('text-xs font-medium rounded-full px-2.5 py-1 border transition-colors',
                  filter === f.key ? 'bg-accent text-black border-accent' : 'border-border text-ink-muted hover:text-ink')}>
                {f.label} {n > 0 && <span className="opacity-70">{n}</span>}
              </button>
            )
          })}
        </div>
      )}

      {/* Feed */}
      <div className="p-4 space-y-3">
        {loading ? (
          <div className="py-10 text-center text-sm text-ink-muted flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Analyzing pricing, routes, profit and customers…
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-10 text-center text-sm text-ink-muted">Nothing in this category right now.</div>
        ) : (
          <>
            {visible.map(s => (
              <SuggestionCard key={s.id} s={s}
                applying={applyingId === s.id} applied={appliedId === s.id}
                onAction={(a) => runAction(s, a)} />
            ))}
            {(filtered.length > visible.length || lowHidden > 0) && (
              <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                {filtered.length > visible.length && (
                  <button onClick={() => setShowAll(true)} className="text-xs font-medium text-accent hover:underline">
                    Show {filtered.length - visible.length} more
                  </button>
                )}
                {lowHidden > 0 && (
                  <button onClick={() => setShowLow(true)} className="text-xs font-medium text-ink-muted hover:text-ink">
                    + {lowHidden} lower-confidence
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function SuggestionCard({ s, applying, applied, onAction }: { s: Suggestion; applying: boolean; applied: boolean; onAction: (a: SuggestionAction) => void }) {
  const cat = CATEGORY_META[s.category]
  const [showWhy, setShowWhy] = useState(false)
  const [showCalc, setShowCalc] = useState(false)
  const actions = s.actions && s.actions.length ? s.actions : [s.action]

  function renderAction(a: SuggestionAction, i: number) {
    if (a.kind === 'navigate') {
      return (
        <Link key={i} href={a.href || '#'}>
          <Button size="sm" variant="secondary">{a.label} <ArrowRight className="w-3.5 h-3.5" /></Button>
        </Link>
      )
    }
    return <Button key={i} size="sm" onClick={() => onAction(a)} loading={applying}>{a.label}</Button>
  }

  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-3.5">
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <span className={cn('text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border', cat.tone)}>
          {cat.emoji} {cat.label}
        </span>
        <span className={cn('text-[10px] font-semibold rounded-full px-2 py-0.5 border', CONF_PILL[s.confidence])}>
          {CONF_LABEL[s.confidence]}
        </span>
      </div>

      {/* Decision-first: recommendation + impact lead. */}
      <p className="text-sm font-bold text-ink leading-snug">{s.title}</p>
      {s.subtitle && <p className="text-xs text-ink-muted mt-0.5">{s.subtitle}</p>}

      <div className="flex flex-wrap items-center gap-2 mt-2">
        {s.impact > 0 && (
          <span className="text-sm font-bold text-accent flex items-center gap-1">
            <TrendingUp className="w-3.5 h-3.5" /> +{formatCurrency(s.impact)}{s.oneTime ? ' one-time' : '/yr'}
          </span>
        )}
        {s.timeSavedMin != null && s.timeSavedMin > 0 && (
          <span className="text-xs text-ink-muted flex items-center gap-1"><Clock className="w-3 h-3" /> {s.timeSavedMin} min saved</span>
        )}
        {s.distanceSavedKm != null && s.distanceSavedKm > 0 && (
          <span className="text-xs text-ink-muted flex items-center gap-1"><Navigation className="w-3 h-3" /> {s.distanceSavedKm} km saved</span>
        )}
      </div>

      {/* Action(s) — one tap. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {applied
          ? <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-400"><Check className="w-4 h-4" /> Done</span>
          : actions.map(renderAction)}
      </div>

      {/* Progressive disclosure — Why / How calculated tucked away. */}
      <div className="mt-2.5 flex items-center gap-4">
        {s.why.length > 0 && (
          <button onClick={() => setShowWhy(v => !v)} className="text-[11px] font-medium text-ink-faint hover:text-ink flex items-center gap-1">
            <HelpCircle className="w-3 h-3" /> Why?
          </button>
        )}
        {s.calc && s.calc.length > 0 && (
          <button onClick={() => setShowCalc(v => !v)} className="text-[11px] font-medium text-ink-faint hover:text-ink flex items-center gap-1">
            <Calculator className="w-3 h-3" /> How calculated?
          </button>
        )}
      </div>
      {showWhy && s.why.length > 0 && (
        <ul className="mt-2 space-y-0.5 border-t border-border pt-2">
          {s.why.map((w, i) => (
            <li key={i} className="text-xs text-ink-muted flex gap-1.5"><span className="text-accent/60 shrink-0">•</span><span>{w}</span></li>
          ))}
        </ul>
      )}
      {showCalc && s.calc && s.calc.length > 0 && (
        <ul className="mt-2 space-y-0.5 border-t border-border pt-2">
          {s.calc.map((c, i) => (
            <li key={i} className="text-xs text-ink-faint flex gap-1.5"><span className="shrink-0">=</span><span>{c}</span></li>
          ))}
        </ul>
      )}
    </div>
  )
}
