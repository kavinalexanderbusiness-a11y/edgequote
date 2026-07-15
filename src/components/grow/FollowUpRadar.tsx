'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { loadFollowUpRadar, RadarItem } from '@/lib/crm/radar'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { FilterPill } from '@/components/ui/FilterPill'
import { Skeleton } from '@/components/ui/Skeleton'
import { Bell, MessageSquare, Clock, ArrowRight, PartyPopper } from 'lucide-react'

const THRESHOLDS = [14, 30, 60, 90]

// "Customers needing follow-up" + "Customers not contacted in X days" in one
// panel. Reads from customers.last_contacted_at + the conversations summary —
// no new data. Customers who replied and are awaiting a response float to the top.
export function FollowUpRadar() {
  const supabase = useMemo(() => createClient(), [])
  const [threshold, setThreshold] = useState(30)
  const [items, setItems] = useState<RadarItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showAll, setShowAll] = useState(false)

  async function load() {
    setItems(await loadFollowUpRadar(supabase, threshold))
    setLoading(false)
  }
  useEffect(() => { setLoading(true); load() }, [threshold]) // eslint-disable-line react-hooks/exhaustive-deps
  useRealtimeRefresh('conversations', null, load)
  useRealtimeRefresh('customers', null, load)

  const awaiting = items.filter(i => i.unansweredInbound).length
  const quiet = items.length - awaiting
  const visible = showAll ? items : items.slice(0, 8)

  return (
    <div className="rounded-card border border-border bg-bg-secondary overflow-hidden animate-rise">
      <div className="px-5 py-4 border-b border-border flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center shrink-0">
          <Bell className="w-4 h-4 text-accent" />
        </div>
        <div className="min-w-0">
          <p className="text-base font-bold tracking-tight text-ink">Follow-up radar</p>
          <p className="text-xs text-ink-muted tabular-nums">
            {loading ? 'Checking…' : `${awaiting} awaiting a reply · ${quiet} gone quiet (${threshold}+ days)`}
          </p>
        </div>
      </div>

      {/* Not-contacted-in window */}
      <div role="group" aria-label="Quiet-for window" className="px-4 py-2.5 border-b border-border flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-ink-faint mr-1">Quiet for</span>
        {THRESHOLDS.map(t => (
          <FilterPill key={t} active={threshold === t} onClick={() => setThreshold(t)} ariaLabel={`${t} days or more`}>
            {t}d
          </FilterPill>
        ))}
      </div>

      {loading ? (
        <div className="divide-y divide-border" aria-hidden="true">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="flex items-center gap-3 px-4 py-2.5">
              <Skeleton className="w-8 h-8 rounded-lg shrink-0" />
              <div className="min-w-0 flex-1"><Skeleton className="h-3 w-28" /><Skeleton className="h-2.5 w-40 mt-1.5" /></div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <InlineEmpty icon={PartyPopper}>Everyone’s been contacted recently — nothing to chase.</InlineEmpty>
      ) : (
        <>
          <div className="divide-y divide-border">
            {visible.map(i => {
              const Icon = i.unansweredInbound ? MessageSquare : Clock
              const tone = i.unansweredInbound ? 'text-amber-400 bg-amber-500/10 border-amber-500/20' : 'text-ink-muted bg-surface border-border'
              return (
                <Link key={i.customerId} href={`/dashboard/customers/${i.customerId}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40">
                  <div className={`w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 ${tone}`}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink truncate">{i.name}</p>
                    <p className="text-xs text-ink-muted truncate">{i.reason}</p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-ink-faint shrink-0" />
                </Link>
              )
            })}
          </div>
          {items.length > 8 && (
            <button onClick={() => setShowAll(s => !s)} aria-expanded={showAll} className="w-full py-2.5 text-xs font-medium text-accent hover:bg-surface-raised border-t border-border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40">
              {showAll ? 'Show less' : `Show all ${items.length}`}
            </button>
          )}
        </>
      )}
    </div>
  )
}
