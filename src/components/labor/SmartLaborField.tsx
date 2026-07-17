'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  loadLaborModel, estimateLabor, laborEconomics, LaborModel, LaborEstimate, Confidence, Cadence,
} from '@/lib/labor'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { Sparkles, Check, HelpCircle, Gauge, RotateCw, Hourglass } from 'lucide-react'

// Confidence is a quiet dot + label (loud tinted pills are reserved for risk/alarm).
const CONF_DOT: Record<Confidence, string> = {
  high: 'bg-emerald-400',
  medium: 'bg-amber-400',
  low: 'bg-ink-faint',
}
// One confidence vocabulary — full words everywhere, matching types CONFIDENCE_LABELS.
const CONF_LABEL: Record<Confidence, string> = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' }

// ── Smart Labor Calculator V2 — drop-in estimate widget ─────────────────────────
// The estimated duration is a SMART DEFAULT, not a locked value:
//  • Auto-fills ONLY when THIS service has real history to learn from (never guesses
//    from lawn size alone — if there's no service history it shows "not enough data"
//    and leaves the field for manual entry).
//  • Recalculates automatically when service / property / crew / recurrence /
//    measurement change — while you haven't typed your own value.
//  • The moment you type a duration it becomes an override: auto-fill stops until
//    you explicitly Recalculate.
// Service-specific throughout (lib/labor serviceKey): mowing learns only from mowing.
//
// It never SETS a price. On the quote builder (`affectsPrice`) the duration it
// fills is multiplied out into a suggested price — so the copy there says that
// plainly instead of the old "never changes your price", which stopped being true
// the moment this was wired to the Hours field that drives the suggestion. On the
// job form it genuinely only feeds scheduling. Same engine, different consequence,
// and the widget must not claim the wrong one.
export function SmartLaborField({
  sqft, serviceType, crewSize, propertyId, isInitialVisit, overgrowth, cadence, price, value, onApply, readOnly, affectsPrice,
}: {
  sqft: number
  serviceType: string | null
  crewSize: number
  propertyId?: string | null
  isInitialVisit?: boolean
  overgrowth?: number
  cadence?: Cadence | null   // recurrence cadence so weekly learns from weekly
  price?: number          // per-visit value, for the profit layer (read-only; never changes price)
  value: number | null    // the form's current duration (minutes)
  onApply: (minutes: number) => void
  readOnly?: boolean       // informational only — no auto-fill, no apply button
  /** The consumer's field feeds a price (quote builder). Changes the copy only —
   *  this widget still never writes a price itself. */
  affectsPrice?: boolean
}) {
  const supabase = useMemo(() => createClient(), [])
  const [model, setModel] = useState<LaborModel | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [crewCost, setCrewCost] = useState(40)
  const [showWhy, setShowWhy] = useState(false)
  const lastApplied = useRef<number | null>(null)

  useEffect(() => {
    let active = true
    loadLaborModel(supabase).then(r => { if (active && r) { setModel(r.model); setEnabled(r.enabled); setCrewCost(r.crewCost) } })
    return () => { active = false }
  }, [supabase])

  const est: LaborEstimate | null = useMemo(() => {
    if (sqft <= 0 && !propertyId) return null
    return estimateLabor({ sqft, serviceType, crewSize, propertyId, isInitialVisit, overgrowth, cadence }, model)
  }, [sqft, serviceType, crewSize, propertyId, isInitialVisit, overgrowth, cadence, model])

  // You're "in auto mode" until you type your own duration. Then it's an override and
  // we stop changing it until you click Recalculate.
  const isOverride = value != null && value !== 0 && value !== lastApplied.current

  // Auto-fill: only when ON, in auto mode, AND we actually have service history to
  // trust ("don't guess"). Live-recalcs when service/property/crew/recurrence/sqft
  // change because `est` is in the dep list.
  useEffect(() => {
    if (!enabled || !est || readOnly || !est.enoughData) return
    const untouched = value == null || value === 0 || value === lastApplied.current
    if (untouched && est.minutes !== value) {
      lastApplied.current = est.minutes
      onApply(est.minutes)
    }
  }, [enabled, est, value, onApply, readOnly])

  if (!est) return null
  const recalc = () => { lastApplied.current = est.minutes; onApply(est.minutes) }

  // ── Not enough history for THIS service → don't guess; invite manual entry ──────
  if (!est.enoughData) {
    return (
      <div className="rounded-xl border border-border bg-bg-tertiary p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-bold text-ink flex items-center gap-1.5"><Hourglass className="w-3.5 h-3.5 text-ink-faint" /> Smart Labor Estimate</span>
          <span className="text-[10px] font-semibold rounded-full px-2 py-0.5 border text-ink-muted border-border">Not enough {est.serviceLabel} data</span>
        </div>
        <p className="text-[11px] text-ink-muted">
          No {est.serviceLabel.toLowerCase()} history yet — EdgeQuote won&apos;t guess. {readOnly ? 'Time a few' : 'Enter the duration manually and complete a few'} {est.serviceLabel.toLowerCase()} jobs and it&apos;ll start auto-filling a learned estimate.
        </p>
        {!readOnly && (
          <button type="button" onClick={recalc} className="text-[11px] font-semibold text-ink-faint hover:text-ink">
            Use rough size estimate ({est.minutes} min) anyway
          </button>
        )}
      </div>
    )
  }

  const econ = price && price > 0 ? laborEconomics(est.minutes, price, crewCost) : null
  const applied = value === est.minutes

  return (
    <div className="rounded-xl border border-accent/20 bg-accent/[0.04] p-3 space-y-2.5 animate-fade">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-ink flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5 text-accent-text" /> Smart Labor Estimate</span>
        {/* ON/OFF toggle (hidden in read-only / quote mode) */}
        {!readOnly && (
          <button type="button" aria-pressed={enabled} onClick={() => setEnabled(e => !e)}
            className={cn('text-[10px] font-semibold rounded-full px-2 py-0.5 border transition-colors', enabled ? 'text-accent-text border-accent/40 bg-accent/10' : 'text-ink-faint border-border')}>
            {enabled ? 'Auto-fill ON' : 'Auto-fill OFF'}
          </button>
        )}
      </div>

      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-2xl font-black text-ink leading-none tabular-nums">{est.minutes} <span className="text-sm font-semibold text-ink-muted">min</span></p>
          <p className="text-[11px] text-ink-muted mt-1 tabular-nums">Range {est.minMinutes}–{est.maxMinutes} min · {est.sampleSize} {est.serviceLabel.toLowerCase()} job{est.sampleSize !== 1 ? 's' : ''}</p>
        </div>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted whitespace-nowrap">
          <span aria-hidden className={cn('w-1.5 h-1.5 rounded-full', CONF_DOT[est.confidence])} />
          <span className="tabular-nums">{est.confidencePct}%</span> · {CONF_LABEL[est.confidence]}
        </span>
      </div>

      {/* Recommendation layer — read-only; never affects price. */}
      {econ && (
        <div className="grid grid-cols-3 gap-2">
          <Mini label="$/labor hr" value={`$${econ.revPerLaborHour}`} />
          <Mini label="Labor cost" value={`$${econ.laborCost}`} />
          <Mini label="Gross profit" value={`$${econ.grossProfit}`} tone={econ.grossProfit >= 0 ? 'text-emerald-400' : 'text-red-400'} />
        </div>
      )}

      <div className="flex items-center gap-2">
        {!readOnly && (applied
          ? <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400 animate-fade"><Check className="w-3.5 h-3.5" /> Applied</span>
          : isOverride
            ? <button type="button" onClick={recalc} className="inline-flex items-center gap-1 text-[11px] font-semibold text-accent-text hover:underline"><RotateCw className="w-3 h-3" /> Recalculate ({est.minutes} min)</button>
            : <Button type="button" variant="ghost" size="sm" onClick={recalc}>Use estimate ({est.minutes} min)</Button>)}
        {readOnly && <span className="text-[10px] text-ink-faint">Reference only — doesn’t change your price</span>}
        <button type="button" aria-expanded={showWhy} onClick={() => setShowWhy(v => !v)} className="ml-auto text-[11px] font-medium text-ink-faint hover:text-ink flex items-center gap-1"><HelpCircle className="w-3 h-3" /> Why?</button>
      </div>
      {!readOnly && isOverride && <p className="text-[10px] text-ink-faint">You typed a custom duration — auto-fill is paused until you Recalculate.</p>}

      {showWhy && (
        <ul className="space-y-0.5 border-t border-border pt-2">
          {est.reasons.map((r, i) => <li key={i} className="text-[11px] text-ink-muted flex gap-1.5"><span className="text-accent-text/60 shrink-0">•</span><span>{r}</span></li>)}
          <li className="text-[10px] text-ink-faint flex gap-1.5 pt-0.5"><Gauge className="w-3 h-3 shrink-0 mt-0.5" /><span>{affectsPrice
            ? 'Estimate fills the hours your suggested price is built from — it never sets the price itself, and the suggestion still needs your Accept. Edit the field to override.'
            : 'Estimate feeds scheduling & capacity only — it never changes your price. Edit the field to override.'}</span></li>
        </ul>
      )}
    </div>
  )
}

// Same tile shape + micro-label size as every other pricing stat tile.
function Mini({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg bg-bg-tertiary border border-border px-2 py-1.5 text-center">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={cn('text-sm font-bold text-ink tabular-nums', tone)}>{value}</p>
    </div>
  )
}
