'use client'

import { useState } from 'react'
import { AssistButton } from '@/components/ai/ui'
import { useAiAssist } from '@/hooks/useAiAssist'
import { FilterPill } from '@/components/ui/FilterPill'
import { Sparkles, DollarSign, PlusCircle, SearchX, Clock, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Quote Intelligence ──────────────────────────────────────────────────────────
// The owner-facing AI read on a quote, through THE assist engine (one new task,
// quote_intelligence — /api/ai/assist). Everything it says is derived SERVER-SIDE
// from real engine outputs (pricing seams, win/loss history, labor accuracy,
// customer history); the model explains, it never computes a price and never
// changes one — the pricing engine stays the single source of truth.
//
// Renders nothing when AI isn't configured (the app's disabled-by-default
// contract), and nothing until asked — analysis is a click, not ambient noise.

const FOCI = [
  { key: 'full',    label: 'Full brief', icon: Sparkles },
  { key: 'pricing', label: 'Price & confidence', icon: DollarSign },
  { key: 'upsells', label: 'Upsells', icon: PlusCircle },
  { key: 'gaps',    label: 'Missing services', icon: SearchX },
  { key: 'time',    label: 'Time', icon: Clock },
  { key: 'risk',    label: 'Risk', icon: ShieldAlert },
] as const
type Focus = typeof FOCI[number]['key']

export function QuoteIntelligencePanel({ quoteId, className }: { quoteId: string; className?: string }) {
  const ai = useAiAssist()
  const [text, setText] = useState('')
  const [ran, setRan] = useState<Focus | null>(null)

  async function run(focus: Focus) {
    if (ai.running) return
    ai.clearError()
    setRan(focus)
    setText('')
    const full = await ai.run(
      { task: 'quote_intelligence', quoteId, focus },
      { onDelta: d => setText(prev => prev + d) },
    )
    if (full === null && !text) setRan(null)
  }

  // Capability unknown (checking) or absent → the surface doesn't exist.
  if (!ai.enabled) return null

  return (
    <div className={cn('rounded-card border border-border bg-bg-secondary p-4 space-y-3', className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-bold text-ink flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-accent-text" /> Quote intelligence
        </p>
        <p className="text-[10px] text-ink-faint">Reads your real history — advisory only, never changes the price</p>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {FOCI.map(f => (
          <FilterPill key={f.key} active={ran === f.key} onClick={() => run(f.key)} disabled={ai.running}>
            <f.icon className="w-3 h-3" /> {f.label}
          </FilterPill>
        ))}
      </div>

      {ai.error && <p className="text-xs text-red-400">{ai.error}</p>}

      {(text || ai.running) && (
        <div className="rounded-xl border border-border bg-bg-tertiary px-3.5 py-3">
          <p className="text-sm text-ink whitespace-pre-wrap leading-relaxed">{text}{ai.running && <span className="inline-block w-1.5 h-4 bg-accent/70 align-text-bottom animate-pulse ml-0.5" aria-hidden />}</p>
        </div>
      )}
      {!text && !ai.running && !ran && (
        <p className="text-xs text-ink-muted">
          Pick a lens. Price &amp; confidence explains how this total sits against your own wins and losses; Upsells and Missing services only ever suggest from your service list; Time reads your estimated-vs-actual history; Risk reads payment and follow-through history.
        </p>
      )}
      {!ai.running && ran && (
        <AssistButton label="Run again" onClick={() => run(ran)} busy={false} title="Re-run this analysis" />
      )}
    </div>
  )
}
