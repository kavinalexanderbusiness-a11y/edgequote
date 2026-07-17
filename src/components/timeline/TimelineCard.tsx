'use client'

import { useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import {
  searchTimeline, filterTimeline, timelineGroupCounts, groupTimelineByMonth,
  GROUP_LABELS, TIMELINE_GROUPS,
  type TimelineEvent, type TimelineKind, type TimelineGroup,
} from '@/lib/timeline'
import { thumbUrl } from '@/lib/photos'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { formatDate, cn } from '@/lib/utils'
import {
  FileText, Send, RotateCw, CheckCircle2, XCircle, CalendarPlus, Wrench, Receipt,
  Eye, DollarSign, MessageSquare, StickyNote, Wallet, Camera, Ruler, Shield,
  Sparkles, Globe, History, Search, X,
} from 'lucide-react'

// ── THE timeline UI ──────────────────────────────────────────────────────────
// One presentation over lib/timeline.ts, rendered by BOTH the customer page and the
// property page. Filter/search/expand state is local because it's a view concern —
// two timelines on screen filter independently, and neither owns the other's state.
// The engine decides what an event IS; this only decides how it looks.

const TIMELINE_CAP = 8   // recent events shown before "Show more"

// Record<TimelineKind, …> is load-bearing: adding a kind to the engine without an
// icon here is a tsc error, not a blank square in production.
const EVENT_META: Record<TimelineKind, { icon: typeof FileText; color: string }> = {
  quote_created:   { icon: FileText,     color: 'text-ink-muted bg-surface border-border' },
  quote_sent:      { icon: Send,         color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
  followup:        { icon: RotateCw,     color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  quote_accepted:  { icon: CheckCircle2, color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  quote_declined:  { icon: XCircle,      color: 'text-ink-faint bg-bg-tertiary border-border' },
  job_scheduled:   { icon: CalendarPlus, color: 'text-accent-text bg-accent/10 border-accent/20' },
  job_completed:   { icon: Wrench,       color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  invoice_created: { icon: Receipt,      color: 'text-ink-muted bg-surface border-border' },
  invoice_viewed:  { icon: Eye,          color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
  invoice_paid:    { icon: DollarSign,   color: 'text-accent-text bg-accent/10 border-accent/20' },
  message_in:      { icon: MessageSquare,color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
  message_out:     { icon: Send,         color: 'text-ink-muted bg-surface border-border' },
  note:            { icon: StickyNote,   color: 'text-ink-muted bg-surface border-border' },
  payment:         { icon: DollarSign,   color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  credit:          { icon: Wallet,       color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  refund:          { icon: RotateCw,     color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  expense:         { icon: Receipt,      color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  photo:           { icon: Camera,       color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
  measurement:     { icon: Ruler,        color: 'text-ink-muted bg-surface border-border' },
  price_change:    { icon: DollarSign,   color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  consent:         { icon: Shield,       color: 'text-ink-muted bg-surface border-border' },
  automation:      { icon: Sparkles,     color: 'text-accent-text bg-accent/10 border-accent/20' },
  portal_request:  { icon: StickyNote,   color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  lead:            { icon: Globe,        color: 'text-accent-text bg-accent/10 border-accent/25' },
}

interface TimelineCardProps {
  /** Every event for this subject — the card does its own filtering/searching. */
  events: TimelineEvent[]
  title?: string
  /** Shown when there is no history at all (vs. none matching a filter). */
  emptyText?: string
  /** Quick actions for the subject, rendered in the card header. */
  actions?: ReactNode
  className?: string
}

export function TimelineCard({
  events: allEvents, title = 'Timeline', emptyText = 'No history yet.', actions, className,
}: TimelineCardProps) {
  const [query, setQuery] = useState('')
  const [groups, setGroups] = useState<Set<TimelineGroup>>(new Set())
  const [showAll, setShowAll] = useState(false)

  const groupCounts = useMemo(() => timelineGroupCounts(allEvents), [allEvents])
  const events = useMemo(
    () => searchTimeline(filterTimeline(allEvents, groups), query),
    [allEvents, groups, query],
  )
  const filtered = groups.size > 0 || query.trim().length > 0

  const toggleGroup = (g: TimelineGroup) => setGroups(prev => {
    const next = new Set(prev)
    if (next.has(g)) next.delete(g); else next.add(g)
    return next
  })

  return (
    <Card className={className}>
      <CardHeader className="flex items-center gap-2">
        <History className="w-4 h-4 text-accent-text" />
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {allEvents.length > 0 && (
          <span className="text-xs text-ink-faint tabular-nums ml-auto">
            {filtered ? `${events.length} of ${allEvents.length}` : `${allEvents.length} event${allEvents.length === 1 ? '' : 's'}`}
          </span>
        )}
        {actions && <div className={cn('flex items-center gap-1.5', allEvents.length === 0 && 'ml-auto')}>{actions}</div>}
      </CardHeader>
      <CardBody>
        {allEvents.length === 0 ? (
          <InlineEmpty className="py-6">{emptyText}</InlineEmpty>
        ) : (
          <div className="space-y-3">
            {/* Controls appear only once there's enough history for them to earn
                their space — a property with three events doesn't need a filter.
                But a filter that's already ON always keeps them: history shrinking
                under the cap (realtime, or this card re-used for another subject)
                must never strand "0 of 5" with no search box and no Clear. */}
            {(allEvents.length > TIMELINE_CAP || filtered) && (
              <div className="space-y-2">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-ink-faint absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="search" value={query} onChange={e => setQuery(e.target.value)}
                    placeholder="Search this history…" aria-label={`Search ${title.toLowerCase()}`}
                    className="w-full h-8 pl-8 pr-7 text-xs bg-bg-tertiary border border-border rounded-lg text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
                  />
                  {query && (
                    <button type="button" onClick={() => setQuery('')} aria-label="Clear search"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {TIMELINE_GROUPS.filter(g => groupCounts[g] > 0).map(g => {
                    const on = groups.has(g)
                    return (
                      <button key={g} type="button" onClick={() => toggleGroup(g)} aria-pressed={on}
                        className={cn('text-[11px] font-medium rounded-full px-2 py-0.5 border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                          on ? 'bg-accent/15 border-accent/30 text-accent-text' : 'bg-bg-tertiary border-border text-ink-muted hover:text-ink')}>
                        {GROUP_LABELS[g]} <span className="tabular-nums opacity-70">{groupCounts[g]}</span>
                      </button>
                    )
                  })}
                  {filtered && (
                    <button type="button" onClick={() => { setGroups(new Set()); setQuery('') }}
                      className="text-[11px] font-medium text-ink-faint hover:text-ink rounded px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                      Clear
                    </button>
                  )}
                </div>
              </div>
            )}

            {events.length === 0 ? (
              <InlineEmpty className="py-6">Nothing matches that filter.</InlineEmpty>
            ) : (
              groupTimelineByMonth(showAll ? events : events.slice(0, TIMELINE_CAP)).map(month => (
                <div key={month.label} className="space-y-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint pt-1">{month.label}</p>
                  {month.events.map((e, i) => {
                    const meta = EVENT_META[e.kind]
                    const Icon = meta.icon
                    const row = (
                      <div className="flex items-start gap-3">
                        <div className={`w-7 h-7 rounded-lg border flex items-center justify-center shrink-0 overflow-hidden ${meta.color}`}>
                          {/* A photo shows itself — naming it "Photo added" and hiding
                              the photo is the one thing a visual record can't do. */}
                          {e.thumb
                            ? <img src={thumbUrl(e.thumb, 56, 56)} alt="" loading="lazy" className="w-full h-full object-cover" />
                            : <Icon className="w-3.5 h-3.5" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-ink">{e.title}</p>
                          <p className="text-xs text-ink-faint">{formatDate(e.at)}{e.sub ? ` · ${e.sub}` : ''}</p>
                        </div>
                      </div>
                    )
                    return e.href
                      ? <Link key={`${month.label}-${i}`} href={e.href} className="block hover:opacity-80 transition-opacity">{row}</Link>
                      : <div key={`${month.label}-${i}`}>{row}</div>
                  })}
                </div>
              ))
            )}
            {events.length > TIMELINE_CAP && (
              <button type="button" onClick={() => setShowAll(s => !s)}
                className="text-xs font-medium text-accent-text hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                {showAll ? 'Show less' : `Show ${events.length - TIMELINE_CAP} more`}
              </button>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
