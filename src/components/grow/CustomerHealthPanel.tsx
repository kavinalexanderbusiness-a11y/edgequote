'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { loadCustomerHealth, HealthRow, HealthTier } from '@/lib/customerHealth'
import { formatCurrency, cn } from '@/lib/utils'
import { FilterPill } from '@/components/ui/FilterPill'
import { HeartPulse, Loader2, RefreshCw, Star, ArrowRight } from 'lucide-react'

const TIER: Record<HealthTier, { label: string; tone: string; dot: string }> = {
  healthy: { label: 'Healthy', tone: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10', dot: 'bg-emerald-400' },
  watch: { label: 'Watch', tone: 'text-amber-400 border-amber-500/30 bg-amber-500/10', dot: 'bg-amber-400' },
  at_risk: { label: 'At risk', tone: 'text-red-400 border-red-500/30 bg-red-500/10', dot: 'bg-red-400' },
}
type SortKey = 'priority' | 'value' | 'name'
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'priority', label: 'Needs attention' },
  { key: 'value', label: 'Highest value' },
  { key: 'name', label: 'A–Z' },
]

// ── Customer Health Score (Growth) ──────────────────────────────────────────────
// One sortable 0-100 score per customer (churn + LTV + payment + cadence + tenure).
// Decision-first: at-risk and high-value surface first; tap through to the customer.
export function CustomerHealthPanel() {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<HealthRow[]>([])
  const [loading, setLoading] = useState(true)
  const [sort, setSort] = useState<SortKey>('priority')
  const [showAll, setShowAll] = useState(false)

  async function load() {
    setLoading(true)
    try { setRows(await loadCustomerHealth(supabase)) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const sorted = useMemo(() => {
    const r = [...rows]
    if (sort === 'value') r.sort((a, b) => b.ltv - a.ltv)
    else if (sort === 'name') r.sort((a, b) => a.name.localeCompare(b.name))
    // 'priority' keeps the loader's worst-first-weighted-by-value order
    return r
  }, [rows, sort])

  if (loading) {
    return (
      <div className="rounded-card border border-border bg-bg-secondary p-5 flex items-center gap-2 text-sm text-ink-muted">
        <Loader2 className="w-4 h-4 animate-spin" /> Scoring customer health…
      </div>
    )
  }
  if (rows.length === 0) return null

  const atRisk = rows.filter(r => r.tier === 'at_risk').length
  const vips = rows.filter(r => r.flags.includes('vip')).length
  const visible = showAll ? sorted : sorted.slice(0, 12)

  return (
    <div className="rounded-card border border-border bg-bg-secondary overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center shrink-0">
            <HeartPulse className="w-4.5 h-4.5 text-accent" />
          </div>
          <div className="min-w-0">
            <p className="text-base font-bold text-ink">Customer Health</p>
            <p className="text-xs text-ink-muted mt-0.5">
              {rows.length} customers · {atRisk} at risk · {vips} VIP
            </p>
          </div>
        </div>
        <button onClick={load} title="Refresh" className="h-8 w-8 rounded-lg border border-border text-ink-muted hover:text-ink flex items-center justify-center shrink-0">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      <div className="px-4 py-2.5 border-b border-border flex flex-wrap gap-1.5">
        {SORTS.map(s => (
          <FilterPill key={s.key} active={sort === s.key} onClick={() => { setSort(s.key); setShowAll(false) }}>
            {s.label}
          </FilterPill>
        ))}
      </div>

      <div className="divide-y divide-border">
        {visible.map(r => {
          const t = TIER[r.tier]
          return (
            <Link key={r.customerId} href={`/dashboard/customers/${r.customerId}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-bg-tertiary transition-colors">
              <div className={cn('w-10 h-10 rounded-xl border flex flex-col items-center justify-center shrink-0', t.tone)}>
                <span className="text-sm font-black leading-none">{r.score}</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink truncate flex items-center gap-1.5">
                  {r.name}
                  {r.flags.includes('vip') && <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400 shrink-0" />}
                </p>
                <p className="text-xs text-ink-muted truncate">{r.reason}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs font-semibold text-ink">{formatCurrency(r.ltv)}</p>
                <p className={cn('text-[10px] font-semibold uppercase tracking-wide', t.tone.split(' ')[0])}>{t.label}</p>
              </div>
              <ArrowRight className="w-3.5 h-3.5 text-ink-faint shrink-0" />
            </Link>
          )
        })}
      </div>
      {sorted.length > 12 && (
        <button onClick={() => setShowAll(s => !s)} className="w-full py-2.5 text-xs font-medium text-accent hover:underline border-t border-border">
          {showAll ? 'Show less' : `Show all ${sorted.length} customers`}
        </button>
      )}
    </div>
  )
}
