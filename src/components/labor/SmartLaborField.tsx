'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  loadLaborModel, estimateLabor, laborEconomics, LaborModel, LaborEstimate, Confidence, Cadence,
} from '@/lib/labor'
import { cn } from '@/lib/utils'
import { Sparkles, Check, HelpCircle, Gauge, RotateCw, Hourglass } from 'lucide-react'

const CONF_TONE: Record<Confidence, string> = {
  high: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
  medium: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
  low: 'text-ink-muted border-border bg-bg-tertiary',
}
const CONF_LABEL: Record<Confidence, string> = { high: 'High confidence', medium: 'Medium', low: 'Low' }

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
// Never touches pricing.
export function SmartLaborField({
  sqft, serviceType, crewSize, propertyId, isInitialVisit, overgrowth, cadence, price, value, onApply, readOnly,
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
  readOnly?: boolean       // informational only (e.g. on quotes) — no auto-fill, no apply button
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
    <div className="rounded-xl border border-accent/20 bg-accent/[0.04] p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-ink flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5 text-accent" /> Smart Labor Estimate</span>
        {/* ON/OFF toggle (hidden in read-only / quote mode) */}
        {!readOnly && (
          <button type="button" onClick={() => setEnabled(e => !e)}
            className={cn('text-[10px] font-semibold rounded-full px-2 py-0.5 border transition-colors', enabled ? 'text-accent border-accent/40 bg-accent/10' : 'text-ink-faint border-border')}>
            {enabled ? 'Auto-fill ON' : 'Auto-fill OFF'}
          </button>
        )}
      </div>

      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-2xl font-black text-ink leading-none">{est.minutes} <span className="text-sm font-semibold text-ink-muted">min</span></p>
          <p className="text-[11px] text-ink-muted mt-1">Range {est.minMinutes}–{est.maxMinutes} min · {est.sampleSize} {est.serviceLabel.toLowerCase()} job{est.sampleSize !== 1 ? 's' : ''}</p>
        </div>
        <span className={cn('text-[10px] font-semibold rounded-full px-2 py-0.5 border', CONF_TONE[est.confidence])}>
          {est.confidencePct}% · {CONF_LABEL[est.confidence]}
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
          ? <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400"><Check className="w-3.5 h-3.5" /> Applied</span>
          : isOverride
            ? <button type="button" onClick={recalc} className="inline-flex items-center gap-1 text-[11px] font-semibold text-accent hover:underline"><RotateCw className="w-3 h-3" /> Recalculate ({est.minutes} min)</button>
            : <button type="button" onClick={recalc} className="text-[11px] font-semibold text-accent hover:underline">Use estimate ({est.minutes} min)</button>)}
        {readOnly && <span className="text-[10px] text-ink-faint">Reference only — doesn’t change your price</span>}
        <button type="button" onClick={() => setShowWhy(v => !v)} className="ml-auto text-[11px] font-medium text-ink-faint hover:text-ink flex items-center gap-1"><HelpCircle className="w-3 h-3" /> Why?</button>
      </div>
      {!readOnly && isOverride && <p className="text-[10px] text-ink-faint">You typed a custom duration — auto-fill is paused until you Recalculate.</p>}

      {showWhy && (
        <ul className="space-y-0.5 border-t border-border pt-2">
          {est.reasons.map((r, i) => <li key={i} className="text-[11px] text-ink-muted flex gap-1.5"><span className="text-accent/60 shrink-0">•</span><span>{r}</span></li>)}
          <li className="text-[10px] text-ink-faint flex gap-1.5 pt-0.5"><Gauge className="w-3 h-3 shrink-0 mt-0.5" /><span>Estimate feeds scheduling &amp; capacity only — it never changes your price. Edit the field to override.</span></li>
        </ul>
      )}
    </div>
  )
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md bg-bg-tertiary border border-border px-2 py-1.5 text-center">
      <p className="text-[9px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={cn('text-sm font-bold text-ink', tone)}>{value}</p>
    </div>
  )
}
