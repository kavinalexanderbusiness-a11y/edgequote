'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { autoMeasureLawn, getNeighborhoodRatio, AutoMeasureResult } from '@/lib/autoMeasure'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { Loader2, Sparkles, Check } from 'lucide-react'

export function ConfidenceBadge({ confidence }: { confidence?: string | null }) {
  const map: Record<string, string> = {
    high: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
    medium: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
    low: 'text-ink-muted border-border bg-bg-tertiary',
  }
  const c = confidence || 'low'
  return <span className={cn('text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border', map[c] || map.low)}>{c} confidence</span>
}

// Auto-measure by default: estimates the lawn for the coords, shows confidence,
// and lets the owner Use it (accept/adjust). The parent's manual trace overrides.
// `onAuto` hands the raw estimate up so the parent can record auto-vs-accepted.
export function AutoMeasureBanner({ lat, lng, neighborhood, onAuto, onUse }: {
  lat: number | null | undefined
  lng: number | null | undefined
  neighborhood: string
  onAuto: (r: AutoMeasureResult | null) => void
  onUse: (sqft: number) => void
}) {
  const [phase, setPhase] = useState<'loading' | 'done' | 'none'>('loading')
  const [result, setResult] = useState<AutoMeasureResult | null>(null)
  const [val, setVal] = useState('')
  const [used, setUsed] = useState(false)

  useEffect(() => {
    if (lat == null || lng == null) return
    let active = true
    setPhase('loading'); setUsed(false)
    ;(async () => {
      try {
        const supabase = createClient()
        // Local session read — this runs on every lat/lng change; no auth round-trip
        // should gate the auto-measure result each time.
        const { data: { session } } = await supabase.auth.getSession()
        const user = session?.user
        const cal = user ? await getNeighborhoodRatio(supabase, user.id, neighborhood) : { ratio: undefined as number | undefined, calibrated: false }
        const r = await autoMeasureLawn(lat, lng, { ratio: cal.ratio, calibrated: cal.calibrated })
        if (!active) return
        setResult(r); onAuto(r)
        if (r) { setVal(String(r.sqft)); setPhase('done') } else setPhase('none')
      } catch { if (active) { setPhase('none'); onAuto(null) } }
    })()
    return () => { active = false }
  }, [lat, lng, neighborhood]) // eslint-disable-line react-hooks/exhaustive-deps

  if (lat == null || lng == null) return null
  if (phase === 'loading') return (
    <div className="rounded-xl border border-border bg-bg-secondary px-4 py-3 text-sm text-ink-muted flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Auto-measuring this lawn…</div>
  )
  if (phase === 'none' || !result) return (
    <div className="rounded-xl border border-border bg-bg-secondary px-4 py-3 text-xs text-ink-muted">Couldn’t auto-measure this address — trace the lawn on the map below.</div>
  )
  return (
    <div className="rounded-xl border border-accent/30 bg-accent/5 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-ink flex items-center gap-2"><Sparkles className="w-4 h-4 text-accent" /> Auto-measured lawn</span>
        <ConfidenceBadge confidence={result.confidence} />
      </div>
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        <input type="number" value={val} onChange={e => setVal(e.target.value)}
          className="w-28 bg-bg-tertiary border border-border-strong rounded-lg px-3 py-1.5 text-base font-bold text-ink outline-none focus:border-accent" />
        <span className="text-sm text-ink-muted">sq ft</span>
        <Button type="button" size="sm" onClick={() => { const n = Number(val) || 0; if (n > 0) { onUse(n); setUsed(true) } }}>
          {used ? <><Check className="w-3.5 h-3.5" /> Used</> : 'Use this'}
        </Button>
      </div>
      <p className="text-[11px] text-ink-faint mt-1.5">Edit the number and tap Use, or trace on the map to set it exactly (tracing overrides this).</p>
    </div>
  )
}
