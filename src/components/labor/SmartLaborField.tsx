'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  loadLaborModel, estimateLabor, laborEconomics, LaborModel, LaborEstimate, Confidence,
} from '@/lib/labor'
import { cn } from '@/lib/utils'
import { Sparkles, Check, HelpCircle, Gauge } from 'lucide-react'

const CONF_TONE: Record<Confidence, string> = {
  high: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
  medium: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
  low: 'text-ink-muted border-border bg-bg-tertiary',
}
const CONF_LABEL: Record<Confidence, string> = { high: 'High confidence', medium: 'Medium', low: 'Low — size-based' }

// ── Smart Labor Calculator V2 — drop-in estimate widget ─────────────────────────
// Additive: the form owns `value` (duration minutes); this shows the learned
// estimate + range + confidence + profit, and (when the toggle is ON) auto-fills.
// SAFETY: only auto-fills an empty field or one it filled itself — NEVER overwrites
// a value you typed, never touches pricing, always overridable.
export function SmartLaborField({
  sqft, serviceType, crewSize, propertyId, isInitialVisit, overgrowth, price, value, onApply, readOnly,
}: {
  sqft: number
  serviceType: string | null
  crewSize: number
  propertyId?: string | null
  isInitialVisit?: boolean
  overgrowth?: number
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
    return estimateLabor({ sqft, serviceType, crewSize, propertyId, isInitialVisit, overgrowth }, model)
  }, [sqft, serviceType, crewSize, propertyId, isInitialVisit, overgrowth, model])

  // Auto-fill: only when ON and the field is empty OR still holds the last value we
  // applied (i.e. you haven't typed your own). Live-recalcs when crew/sqft change.
  useEffect(() => {
    if (!enabled || !est || readOnly) return
    const untouched = value == null || value === 0 || value === lastApplied.current
    if (untouched && est.minutes !== value) {
      lastApplied.current = est.minutes
      onApply(est.minutes)
    }
  }, [enabled, est, value, onApply, readOnly])

  if (!est) return null
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
            {enabled ? 'Smart Estimate ON' : 'OFF'}
          </button>
        )}
      </div>

      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-2xl font-black text-ink leading-none">{est.minutes} <span className="text-sm font-semibold text-ink-muted">min</span></p>
          <p className="text-[11px] text-ink-muted mt-1">Range {est.minMinutes}–{est.maxMinutes} min · {est.sampleSize} job{est.sampleSize !== 1 ? 's' : ''}</p>
        </div>
        <span className={cn('text-[10px] font-semibold rounded-full px-2 py-0.5 border', CONF_TONE[est.confidence])}>
          {est.confidencePct}% · {CONF_LABEL[est.confidence]}
        </span>
      </div>

      {/* Recommendation layer (req #4) — read-only; never affects price. */}
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
          : <button type="button" onClick={() => { lastApplied.current = est.minutes; onApply(est.minutes) }}
              className="text-[11px] font-semibold text-accent hover:underline">Use estimate ({est.minutes} min)</button>)}
        {readOnly && <span className="text-[10px] text-ink-faint">Reference only — doesn’t change your price</span>}
        <button type="button" onClick={() => setShowWhy(v => !v)} className="ml-auto text-[11px] font-medium text-ink-faint hover:text-ink flex items-center gap-1"><HelpCircle className="w-3 h-3" /> Why?</button>
      </div>

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
