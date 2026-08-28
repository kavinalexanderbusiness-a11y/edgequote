'use client'

import { useMemo, useState } from 'react'
import { HistoryPanel } from '@/components/audit/HistoryPanel'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import {
  AUDIT_CATEGORIES, CATEGORY_LABELS, actionsInCategory, type AuditCategory,
} from '@/lib/audit/phrase'
import type { AuditEvent } from '@/lib/audit/history'
import { cn } from '@/lib/utils'

// ── Business-wide activity — the accountability surface ──────────────────────
// The SAME engine the per-record History panels use, with the entity filter left
// off. There is no second query, no second phrasing and no second renderer: this
// page is the unfiltered view of one event source.
//
// Filters are the four questions an owner actually asks — WHEN, WHO, WHAT KIND,
// and (through the record pages) WHICH RECORD. All four are applied server-side
// against indexed columns; nothing loads "every audit record ever" and filters in
// the browser.

const ACTORS: { value: AuditEvent['actor_type'] | 'all'; label: string }[] = [
  { value: 'all', label: 'Everyone' },
  { value: 'owner', label: 'You' },
  { value: 'worker', label: 'Crew' },
  { value: 'customer', label: 'Customers' },
  { value: 'system', label: 'System' },
]

/** Local midnight N days ago, as an ISO instant — the boundary the reader means. */
function daysAgoISO(days: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

const RANGES = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 0, label: 'All time' },
]

export default function ActivityPage() {
  const [actor, setActor] = useState<AuditEvent['actor_type'] | 'all'>('all')
  const [category, setCategory] = useState<AuditCategory | 'all'>('all')
  const [days, setDays] = useState(30)

  const filter = useMemo(() => ({
    ...(actor !== 'all' ? { actorType: actor } : {}),
    ...(category !== 'all' ? { actions: actionsInCategory(category) } : {}),
    ...(days > 0 ? { from: daysAgoISO(days) } : {}),
  }), [actor, category, days])

  return (
    // THE page shell — this was the one module page still hand-rolling its own
    // container (which double-padded against the layout's gutters) and heading.
    <PageContainer width="narrow">
      <PageHeader
        title="Activity"
        description="Every meaningful change to your business — who made it, when, and what it was before."
      />

      {/* Filter chips wrap rather than scroll: a horizontal scroller hides options
          on exactly the screens that have the least room to spare. */}
      <div className="space-y-2.5">
        <FilterRow label="Who">
          {ACTORS.map(a => (
            <Chip key={a.value} active={actor === a.value} onClick={() => setActor(a.value)}>
              {a.label}
            </Chip>
          ))}
        </FilterRow>
        <FilterRow label="What">
          <Chip active={category === 'all'} onClick={() => setCategory('all')}>Everything</Chip>
          {AUDIT_CATEGORIES.map(c => (
            <Chip key={c} active={category === c} onClick={() => setCategory(c)}>
              {CATEGORY_LABELS[c]}
            </Chip>
          ))}
        </FilterRow>
        <FilterRow label="When">
          {RANGES.map(r => (
            <Chip key={r.value} active={days === r.value} onClick={() => setDays(r.value)}>
              {r.label}
            </Chip>
          ))}
        </FilterRow>
      </div>

      <HistoryPanel
        filter={filter}
        title="Recent activity"
        emptyText="Nothing matches these filters."
      />
    </PageContainer>
  )
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-ink-faint w-10 shrink-0">{label}</span>
      {children}
    </div>
  )
}

function Chip({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode
}) {
  return (
    <button
      type="button" onClick={onClick} aria-pressed={active}
      className={cn(
        // ⭐ 36px, not the 24px this started as. A filter chip is a finger target
        //   and three rows of them at the 44px CTA floor would eat a third of a
        //   phone screen before any history showed — 36px with real spacing is the
        //   balance. (The History rows themselves are full-row targets; see
        //   HistoryPanel.)
        'inline-flex items-center min-h-[36px] px-3 rounded-full text-xs border transition-colors',
        active
          ? 'border-accent/30 bg-accent/10 text-accent-text'
          : 'border-border text-ink-muted hover:text-ink hover:bg-surface-raised',
      )}
    >
      {children}
    </button>
  )
}
