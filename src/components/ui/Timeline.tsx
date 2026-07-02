'use client'

import { useState } from 'react'
import Link from 'next/link'
import { History } from 'lucide-react'
import { EVENT_META, type TimelineEvent } from '@/lib/timeline'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { formatDate } from '@/lib/utils'

// ── Timeline ──────────────────────────────────────────────────────────────────
// THE activity-feed renderer (one look everywhere — extracted from the inline
// version customers/[id] carried). Events come pre-sorted from lib/timeline;
// each row deep-links into its module when it has an href. Long histories are
// capped with a "Show all" toggle so a 5-year customer doesn't render 400 rows.

const INITIAL_COUNT = 30

export function Timeline({ events, emptyText = 'No history yet.' }: { events: TimelineEvent[]; emptyText?: string }) {
  const [showAll, setShowAll] = useState(false)
  if (events.length === 0) return <InlineEmpty icon={History}>{emptyText}</InlineEmpty>
  const visible = showAll ? events : events.slice(0, INITIAL_COUNT)

  return (
    <div className="space-y-3">
      {visible.map((e, i) => {
        const meta = EVENT_META[e.kind]
        const Icon = meta.icon
        const row = (
          <div className="flex items-start gap-3">
            <div className={`w-7 h-7 rounded-lg border flex items-center justify-center shrink-0 ${meta.color}`}>
              <Icon className="w-3.5 h-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink">{e.title}</p>
              <p className="text-xs text-ink-faint">{formatDate(e.at)}{e.sub ? ` · ${e.sub}` : ''}</p>
            </div>
          </div>
        )
        return e.href
          ? <Link key={i} href={e.href} className="block hover:opacity-80 transition-opacity rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">{row}</Link>
          : <div key={i}>{row}</div>
      })}
      {events.length > INITIAL_COUNT && (
        <button
          onClick={() => setShowAll(s => !s)}
          className="w-full text-center text-xs font-medium text-ink-muted hover:text-ink py-2 rounded-lg border border-border bg-surface hover:bg-surface-raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          {showAll ? 'Show recent only' : `Show all ${events.length} events`}
        </button>
      )}
    </div>
  )
}
