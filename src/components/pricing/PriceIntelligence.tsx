'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  loadQuotePricingModel, recommendQuotePrice, QuotePriceRecommendation, QuotePricingModel,
} from '@/lib/quoteLearning'
import { loadLaborModel, estimateLabor, LaborModel, Cadence, Confidence } from '@/lib/labor'
import { loadProspectContext } from '@/lib/prospect'
import type { PricingConfig } from '@/lib/pricing'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { Brain, Check, TrendingUp } from 'lucide-react'

const CONF_TONE: Record<Confidence, string> = {
  high: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
  medium: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
  low: 'text-ink-muted border-border bg-bg-tertiary',
}
// One confidence vocabulary — full words everywhere, matching types CONFIDENCE_LABELS.
const CONF_LABEL: Record<Confidence, string> = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' }
const CAD_LABEL: Record<Cadence, string> = { weekly: 'weekly', biweekly: 'bi-weekly', monthly: 'monthly', one_time: 'one-time' }

// ── Pricing Intelligence — the win-rate-aware price recommendation ───────────────
// Feeds the EXISTING pricing engine better data (lib/quoteLearning): it learns from
// your accepted vs declined quotes WHERE you actually close, then sharpens the
// engine's recommended price — service-specific (mowing learns only from mowing),
// always explained, and NEVER below your minimums. When a service has no win history
// yet it shows your standard price and says it's still learning ("don't guess").
// Self-loads its models; one-tap apply. Reuses the labor model for the visit-time
// and profitability layer — no duplicate engines.
export function PriceIntelligence({
  sqft, serviceType, cadence, overgrowth, propertyId, customerId, nearbyCount, nearbyRecurring, currentPrice, onApply,
}: {
  sqft: number
  serviceType: string | null
  cadence: Cadence
  overgrowth?: number
  propertyId?: string | null
  customerId?: string | null
  nearbyCount?: number | null
  nearbyRecurring?: number | null   // supplied by the measure flow (prospect engine)
  currentPrice?: number             // the price currently in the field, to show "Applied"
  onApply: (price: number) => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [data, setData] = useState<{ model: QuotePricingModel; cfg: PricingConfig; crewCost: number } | null>(null)
  const [loaded, setLoaded] = useState(false) // model fetch settled (even if empty)
  const [laborModel, setLaborModel] = useState<LaborModel | null>(null)
  // Route density resolved from the EXISTING engine (prospect/route-density) when the
  // caller didn't supply it — so "route density / nearby recurring" explains the price
  // everywhere, not only in the measure flow.
  const [density, setDensity] = useState<{ count: number; recurring: number } | null>(null)

  useEffect(() => {
    let active = true
    loadQuotePricingModel(supabase)
      .then(r => { if (active && r) setData(r) })
      .finally(() => { if (active) setLoaded(true) })
    loadLaborModel(supabase).then(r => { if (active && r) setLaborModel(r.model) })
    return () => { active = false }
  }, [supabase])

  // Best-effort nearby resolution (reuses loadProspectContext). Skips when the caller
  // already passed a count, or the property has no coordinates.
  useEffect(() => {
    if (nearbyCount != null || !propertyId) { setDensity(null); return }
    let active = true
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user || !active) return
      const { data: prop } = await supabase.from('properties').select('lat,lng').eq('id', propertyId).maybeSingle()
      const p = prop as { lat: number | null; lng: number | null } | null
      if (!p?.lat || !p?.lng) return
      try {
        const ctx = await loadProspectContext(supabase, user.id, { lat: p.lat, lng: p.lng })
        if (active) setDensity({ count: ctx.nearbyJobs, recurring: ctx.nearbyRecurring })
      } catch { /* engine unavailable — density reason simply omitted */ }
    })()
    return () => { active = false }
  }, [supabase, propertyId, nearbyCount])

  const effectiveNearby = nearbyCount ?? density?.count ?? null
  const effectiveRecurring = nearbyRecurring ?? density?.recurring ?? null

  const rec: QuotePriceRecommendation | null = useMemo(() => {
    if (!data || sqft <= 0) return null
    // Reuse the learned, service-specific visit-time for the profit + rev/hr floor.
    const visit = estimateLabor({ sqft, serviceType, crewSize: 1, propertyId, overgrowth, cadence }, laborModel)
    return recommendQuotePrice({
      sqft, serviceType, cadence, overgrowth, crewCost: data.crewCost,
      propertyId, customerId, nearbyCount: effectiveNearby, nearbyRecurring: effectiveRecurring,
      visitMinutes: visit.minutes,
    }, data.model, data.cfg)
  }, [data, laborModel, sqft, serviceType, cadence, overgrowth, propertyId, customerId, effectiveNearby, effectiveRecurring])

  if (!rec) {
    // Models still loading — hold THE primary card's slot with a skeleton so the
    // recommended price doesn't pop in and shift the form a beat later.
    if (!loaded && sqft > 0) {
      return (
        <div className="rounded-xl border border-border bg-bg-tertiary p-3 animate-pulse" aria-hidden>
          <div className="h-3 w-36 rounded bg-border/60 mb-3" />
          <div className="h-7 w-28 rounded bg-border/60" />
        </div>
      )
    }
    return null
  }
  const applied = currentPrice != null && Math.abs(currentPrice - rec.price) < 0.5

  return (
    // fadeIn so the resolved card dissolves in over the skeleton instead of hard-swapping.
    <div className={cn('rounded-xl border p-3 space-y-2.5 animate-fade', rec.enoughData ? 'border-accent/25 bg-accent/[0.05]' : 'border-border bg-bg-tertiary')}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-ink flex items-center gap-1.5">
          <Brain className={cn('w-3.5 h-3.5', rec.enoughData ? 'text-accent' : 'text-ink-faint')} /> Pricing Intelligence
        </span>
        <span className={cn('text-[10px] font-semibold rounded-full px-2 py-0.5 border', CONF_TONE[rec.confidence])}>
          {rec.confidencePct}% · {CONF_LABEL[rec.confidence]}
        </span>
      </div>

      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-2xl font-black text-ink leading-none">
            ${rec.price}<span className="text-sm font-semibold text-ink-muted"> /{CAD_LABEL[rec.cadence]}</span>
          </p>
          <p className="text-[11px] text-ink-muted mt-1 flex items-center gap-1">
            {rec.acceptancePct != null && <span className="inline-flex items-center gap-0.5 text-emerald-400"><TrendingUp className="w-3 h-3" /> {rec.acceptancePct}% win</span>}
            {rec.acceptancePct != null && <span className="text-ink-faint">·</span>}
            <span>{rec.sampleSize} {rec.serviceLabel.toLowerCase()} quote{rec.sampleSize !== 1 ? 's' : ''}</span>
          </p>
        </div>
        {!applied
          ? <Button size="sm" type="button" onClick={() => onApply(rec.price)} className="shrink-0">Use ${rec.price}</Button>
          : <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400 shrink-0 animate-fade"><Check className="w-3.5 h-3.5" /> Applied</span>}
      </div>

      {/* The WHY (req: explain every recommendation as a clear "Because" list). */}
      <div className="border-t border-border pt-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint mb-1">Because</p>
        <ul className="space-y-0.5">
          {rec.reasons.map((r, i) => <li key={i} className="text-[11px] text-ink-muted flex gap-1.5"><span className="text-accent/60 shrink-0">•</span><span>{r}</span></li>)}
        </ul>
      </div>
      <p className="text-[10px] text-ink-faint text-right">Never below your ${rec.floor} minimum</p>
    </div>
  )
}
