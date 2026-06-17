'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Suggestion, CATEGORY_META, applyPriceRaise } from '@/lib/suggestions'
import { loadSuggestions } from '@/lib/suggestionsLoad'
import { formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Sparkles, Check, ArrowRight } from 'lucide-react'

// The advisor's top 3, on the home page. Tap into Grow for the full feed.
export function DashboardTopSuggestions() {
  const supabase = useMemo(() => createClient(), [])
  const [items, setItems] = useState<Suggestion[]>([])
  const [loading, setLoading] = useState(true)
  const [applyingId, setApplyingId] = useState<string | null>(null)
  const [appliedId, setAppliedId] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try { setItems(await loadSuggestions(supabase)) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function apply(s: Suggestion) {
    if (s.action.kind !== 'apply-price' || !s.action.apply) return
    setApplyingId(s.id)
    const res = await applyPriceRaise(supabase, s.action.apply)
    setApplyingId(null)
    if (res.ok) { setAppliedId(s.id); setTimeout(() => { setAppliedId(null); load() }, 1200) }
  }

  // Home page shows only confident, ranked actions — speculative low-confidence
  // ideas live in the full Grow feed.
  const top = items.filter(s => s.confidence !== 'low').slice(0, 3)
  if (loading) return null            // stay quiet until ready — no skeleton noise
  if (top.length === 0) return null   // nothing pressing → don't take up space

  return (
    <div className="rounded-card border border-accent/20 bg-gradient-to-br from-accent/[0.07] to-transparent overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
        <p className="text-sm font-bold text-ink flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-accent" /> Do this next
        </p>
        <Link href="/dashboard/grow" className="text-xs font-medium text-accent flex items-center gap-1 hover:underline">
          See all {items.length} <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
      <div className="divide-y divide-border">
        {top.map(s => {
          const cat = CATEGORY_META[s.category]
          return (
            <div key={s.id} className="px-4 py-3 flex items-start gap-3">
              <span className="text-lg leading-none mt-0.5 shrink-0">{cat.emoji}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink leading-snug">{s.title}</p>
                <p className="text-xs text-ink-muted mt-0.5 flex flex-wrap items-center gap-x-2">
                  {s.impact > 0 && <span className="text-accent font-semibold">+{formatCurrency(s.impact)}{s.oneTime ? '' : '/yr'}</span>}
                  {s.subtitle && <span className="truncate">{s.subtitle}</span>}
                </p>
              </div>
              <div className="shrink-0">
                {s.action.kind === 'apply-price' ? (
                  appliedId === s.id
                    ? <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-400"><Check className="w-3.5 h-3.5" /> Done</span>
                    : <Button size="sm" onClick={() => apply(s)} loading={applyingId === s.id}>{s.action.label}</Button>
                ) : (
                  // navigate → its href; create-recurring (needs the weekly/biweekly
                  // choice) → open the full feed in Grow.
                  <Link href={s.action.kind === 'navigate' ? (s.action.href || '#') : '/dashboard/grow'}>
                    <Button size="sm" variant="secondary">{s.action.kind === 'create-recurring' ? 'Review' : s.action.label}</Button>
                  </Link>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
