'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Suggestion, SuggestionAction, SuggestionCategory, CATEGORY_META, Confidence, applyPriceRaise, createRecurringPlan, dismissSuggestion, undismissSuggestion } from '@/lib/suggestions'
import { loadSuggestions } from '@/lib/suggestionsLoad'
import { readCache, writeCache, CACHE_TTL } from '@/lib/clientCache'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { formatCurrency, cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Sparkles, Check, ArrowRight, Clock, Navigation, TrendingUp, RefreshCw, HelpCircle, Calculator, X, BellOff, Undo2 } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { addDays, format } from 'date-fns'

// Confidence renders as a quiet dot + label — data, not decoration.
const CONF_DOT: Record<Confidence, string> = {
  high: 'bg-emerald-400',
  medium: 'bg-amber-400',
  low: 'bg-ink-faint',
}
const CONF_LABEL: Record<Confidence, string> = { high: 'High confidence', medium: 'Medium confidence', low: 'Worth a look' }

const FILTERS: { key: SuggestionCategory | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'profit', label: 'Profit' },
  { key: 'growth', label: 'Growth' },
  { key: 'route', label: 'Route' },
  { key: 'problem', label: 'Problems' },
  { key: 'retention', label: 'Retention' },
]

export function SuggestionsCenter() {
  const supabase = useMemo(() => createClient(), [])
  const [items, setItems] = useState<Suggestion[]>(() => readCache<Suggestion[]>('suggestions', CACHE_TTL.short) || [])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<SuggestionCategory | 'all'>('all')
  const [showAll, setShowAll] = useState(false)
  const [showLow, setShowLow] = useState(false)
  const [applyingId, setApplyingId] = useState<string | null>(null)
  const [appliedId, setAppliedId] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [undo, setUndo] = useState<{ key: string; label: string } | null>(null)

  async function load() {
    setUndo(null)
    try { const next = await loadSuggestions(supabase); setItems(next); writeCache('suggestions', next) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Dismiss = hide a decided card. snoozeDays set → resurfaces after a month.
  // Optimistic removal + one-tap Undo, so clearing the feed never loses a card.
  async function dismiss(s: Suggestion, snoozeDays?: number) {
    setItems(prev => prev.filter(x => x.id !== s.id))
    setUndo({ key: s.id, label: s.title })
    setNote(null)
    const snoozeUntil = snoozeDays ? format(addDays(new Date(), snoozeDays), 'yyyy-MM-dd') : null
    await dismissSuggestion(supabase, s.id, snoozeUntil)
  }
  async function undoDismiss() {
    if (!undo) return
    const key = undo.key
    setUndo(null)
    await undismissSuggestion(supabase, key)
    load()
  }

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
  // Rank by confidence-weighted value so the list answers "what should I do FIRST":
  // a high-confidence $300 beats a low-confidence $500; recurring (annual) impact
  // outweighs one-time; zero-impact problem/route cards sort by confidence alone.
  const CONF_W: Record<Confidence, number> = { high: 1, medium: 0.6, low: 0.3 }
  const ranked = useMemo(() =>
    [...items].sort((a, b) => {
      const score = (s: Suggestion) => CONF_W[s.confidence] * (s.impact > 0 ? s.impact * (s.oneTime ? 0.6 : 1) : 50)
      return score(b) - score(a)
    }), [items]) // eslint-disable-line react-hooks/exhaustive-deps
  const inCategory = filter === 'all' ? ranked : ranked.filter(s => s.category === filter)
  const lowHidden = showLow ? 0 : inCategory.filter(s => s.confidence === 'low').length
  const filtered = showLow ? inCategory : inCategory.filter(s => s.confidence !== 'low')
  const visible = showAll ? filtered : filtered.slice(0, CAP)
  const totalAnnual = items.filter(s => s.category === 'profit' && !s.oneTime).reduce((sum, s) => sum + s.impact, 0)

  return (
    <div className="rounded-card border border-accent/20 hero-aurora overflow-hidden animate-rise">
      {/* Header — the advisor moment: the question, then the opportunity it found */}
      <div className="px-5 py-5 border-b border-border flex items-start justify-between gap-3">
        <div className="flex items-start gap-3.5 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/25 icon-glow flex items-center justify-center shrink-0">
            <Sparkles className="w-5 h-5 text-accent" />
          </div>
          <div className="min-w-0">
            <p className="text-lg font-bold tracking-tight text-ink">What should I do next?</p>
            <p className="text-xs text-ink-muted mt-1">
              {loading ? 'Reading your business…'
                : items.length === 0 ? 'You’re all caught up — nothing pressing right now.'
                : <>
                    {items.length} opportunit{items.length !== 1 ? 'ies' : 'y'} found in your data
                    {totalAnnual > 0 && <> · worth up to <span className="font-semibold text-accent tabular-nums">{formatCurrency(totalAnnual)}/yr</span></>}
                  </>}
            </p>
          </div>
        </div>
        <IconButton icon={RefreshCw} label="Refresh suggestions" onClick={load} disabled={loading} spin={loading} />
      </div>

      {note && (
        <div className="px-5 py-2 bg-accent/5 border-b border-border text-xs text-ink flex items-center gap-2">
          <Check className="w-3.5 h-3.5 text-accent" /> {note}
        </div>
      )}

      {undo && (
        <div className="px-5 py-2 bg-bg-tertiary border-b border-border text-xs text-ink-muted flex items-center justify-between gap-2">
          <span className="truncate">Dismissed “{undo.label}”.</span>
          <button onClick={undoDismiss} className="shrink-0 inline-flex items-center gap-1 font-semibold text-accent hover:underline">
            <Undo2 className="w-3.5 h-3.5" /> Undo
          </button>
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
        {loading && items.length === 0 ? (
          <SkeletonRows count={3} />
        ) : items.length === 0 ? (
          <div className="py-10 text-center">
            <div className="w-11 h-11 mx-auto rounded-full bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center mb-3">
              <Check className="w-5 h-5 text-emerald-400" />
            </div>
            <p className="text-sm font-semibold text-ink">Nothing needs your attention</p>
            <p className="text-xs text-ink-muted mt-1">Your advisor re-reads the business as jobs, quotes and payments land.</p>
          </div>
        ) : filtered.length === 0 ? (
          <InlineEmpty icon={Sparkles}>Nothing in this category right now.</InlineEmpty>
        ) : (
          <>
            {visible.map((s, i) => (
              <SuggestionCard key={s.id} s={s} index={i}
                applying={applyingId === s.id} applied={appliedId === s.id}
                onAction={(a) => runAction(s, a)}
                onDismiss={(snoozeDays) => dismiss(s, snoozeDays)} />
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

function SuggestionCard({ s, index, applying, applied, onAction, onDismiss }: { s: Suggestion; index: number; applying: boolean; applied: boolean; onAction: (a: SuggestionAction) => void; onDismiss: (snoozeDays?: number) => void }) {
  const cat = CATEGORY_META[s.category]
  const [showWhy, setShowWhy] = useState(false)
  const [showCalc, setShowCalc] = useState(false)
  const actions = s.actions && s.actions.length ? s.actions : [s.action]
  // Time-required — a display heuristic from the action shape (NOT another engine):
  // one-click applies land in ~1 min; anything that navigates to do work is ~5 min.
  const effortMin = actions.some(a => a.kind === 'apply-price' || a.kind === 'create-recurring') ? 1 : 5

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
    <div className={cn('rounded-xl border border-border bg-bg-secondary p-4 card-lift animate-rise', index < 6 && `stagger-${index + 1}`)}>
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <span className={cn('text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border', cat.tone)}>
          {cat.label}
        </span>
        <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-ink-muted rounded-full px-2 py-0.5 border border-border bg-bg-tertiary" title="How sure the advisor is, based on how much of your data backs this">
          <span className={cn('w-1.5 h-1.5 rounded-full', CONF_DOT[s.confidence])} />
          {CONF_LABEL[s.confidence]}
        </span>
      </div>

      {/* Decision-first: recommendation + impact lead. */}
      <p className="text-sm font-bold text-ink leading-snug tracking-tight">{s.title}</p>
      {s.subtitle && <p className="text-xs text-ink-muted mt-0.5">{s.subtitle}</p>}

      <div className="flex flex-wrap items-center gap-2 mt-2">
        {s.impact > 0 && (
          <span className="text-sm font-bold text-accent flex items-center gap-1 tabular-nums">
            <TrendingUp className="w-3.5 h-3.5" /> +{formatCurrency(s.impact)}{s.oneTime ? ' one-time' : '/yr'}
          </span>
        )}
        {s.timeSavedMin != null && s.timeSavedMin > 0 && (
          <span className="text-xs text-ink-muted flex items-center gap-1"><Clock className="w-3 h-3" /> {s.timeSavedMin} min saved</span>
        )}
        <span className="text-xs text-ink-faint flex items-center gap-1" title="Roughly how long this takes to act on">
          <Clock className="w-3 h-3" /> ~{effortMin} min to do
        </span>
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

      {/* Progressive disclosure — Why / How calculated tucked away; dismiss/snooze on the right. */}
      <div className="mt-2.5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-4">
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
        <div className="flex items-center gap-3 shrink-0">
          <button onClick={() => onDismiss(30)} title="Snooze for a month"
            className="text-[11px] font-medium text-ink-faint hover:text-ink flex items-center gap-1">
            <BellOff className="w-3 h-3" /> Snooze
          </button>
          <button onClick={() => onDismiss()} title="Dismiss this suggestion"
            className="text-[11px] font-medium text-ink-faint hover:text-ink flex items-center gap-1">
            <X className="w-3 h-3" /> Dismiss
          </button>
        </div>
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
