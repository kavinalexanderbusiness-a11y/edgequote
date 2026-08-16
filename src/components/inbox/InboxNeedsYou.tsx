// ── Needs you — the action half of the Owner Inbox ───────────────────────────
// Server-rendered rows in three plain sections (Urgent / Today / Upcoming).
// Every row: one action sentence, one reason line, ONE door. Event rows add the
// two quiet lifecycle controls; derived rows deliberately have none — doing the
// work is how they leave.

import Link from 'next/link'
import { cn, formatCurrency, timeAgo } from '@/lib/utils'
import { SECTION_LABELS, SECTION_ORDER, type InboxItem, type InboxSection } from '@/lib/inbox'
import { ITEM_META } from '@/components/inbox/itemMeta'
import { EventItemActions } from '@/components/inbox/EventItemActions'
import { CheckCircle2, ArrowRight, AlertTriangle, Clock } from 'lucide-react'

function Row({ item }: { item: InboxItem }) {
  const meta = ITEM_META[item.kind]
  const Icon = meta.icon
  return (
    <li className="flex items-center">
      <Link
        href={item.href}
        className="group flex items-center gap-3 flex-1 min-w-0 px-4 sm:px-5 py-3.5 hover:bg-surface-raised/40 active:bg-surface-raised/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50"
      >
        <span aria-hidden className={cn('shrink-0 w-9 h-9 rounded-lg border flex items-center justify-center', meta.tone)}>
          <Icon className="w-4 h-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold tracking-tight text-ink truncate">{item.label}</span>
          <span className="block text-xs text-ink-muted truncate mt-0.5 tabular-nums">
            {item.detail}
            {item.more != null && item.more > 0 && (
              <span className="text-ink-faint"> · +{item.more} more</span>
            )}
            {item.source === 'event' && item.at && (
              <span className="text-ink-faint"> · {timeAgo(item.at)}</span>
            )}
          </span>
        </span>
        {item.value != null && item.value > 0 && (
          <span className={cn('shrink-0 text-sm font-bold tabular-nums tracking-tight',
            item.kind === 'followups_blocked' ? 'text-ink-muted' : 'text-ink')}>
            {formatCurrency(item.value)}
          </span>
        )}
        <ArrowRight className="w-4 h-4 text-ink-faint shrink-0 transition-transform group-hover:translate-x-0.5" />
      </Link>
      {item.source === 'event' && item.notificationId && (
        <span className="pr-2">
          <EventItemActions notificationId={item.notificationId} />
        </span>
      )}
    </li>
  )
}

export function InboxNeedsYou({ items, snoozedEvents, allClear }: {
  items: InboxItem[]
  snoozedEvents: InboxItem[]
  /** From the engine — empty AND every source read. Never derived here. */
  allClear: boolean
}) {
  const bySection: Record<InboxSection, InboxItem[]> = { urgent: [], today: [], upcoming: [] }
  for (const it of items) bySection[it.section].push(it)

  return (
    <div className="space-y-5">
      {items.length === 0 && (
        allClear ? (
          <div className="rounded-card border border-border bg-surface px-5 py-12 text-center">
            <div className="w-11 h-11 mx-auto rounded-full bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center mb-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
            </div>
            <p className="text-sm font-semibold text-ink">Nothing needs you right now</p>
            <p className="text-xs text-ink-muted mt-1 max-w-xs mx-auto">
              New leads, approvals, money problems and schedule conflicts will land here the moment they exist.
            </p>
          </div>
        ) : (
          // Sources failed and nothing loaded from the rest: the banner above
          // has named what couldn't be read — this must NOT celebrate.
          <div className="rounded-card border border-border bg-surface px-5 py-10 text-center">
            <div className="w-11 h-11 mx-auto rounded-full bg-amber-500/10 border border-amber-500/25 flex items-center justify-center mb-3">
              <AlertTriangle className="w-5 h-5 text-amber-400" />
            </div>
            <p className="text-sm font-semibold text-ink">Nothing loaded from the sources we could read</p>
            <p className="text-xs text-ink-muted mt-1">Some sources are unavailable, so this may not be the whole picture.</p>
          </div>
        )
      )}

      {SECTION_ORDER.map(section => {
        const rows = bySection[section]
        if (rows.length === 0) return null
        return (
          <section key={section} aria-label={SECTION_LABELS[section]}>
            <h2 className={cn('px-1 pb-2 text-[11px] font-semibold uppercase tracking-[0.14em]',
              section === 'urgent' ? 'text-red-400' : 'text-ink-muted')}>
              {SECTION_LABELS[section]}
              <span className="text-ink-faint font-medium normal-case tracking-normal"> · {rows.length}</span>
            </h2>
            <div className="rounded-card border border-border bg-surface overflow-hidden">
              <ol className="divide-y divide-border">
                {rows.map(item => <Row key={item.key} item={item} />)}
              </ol>
            </div>
          </section>
        )
      })}

      {snoozedEvents.length > 0 && (
        <details className="rounded-card border border-border bg-surface">
          <summary className="flex items-center gap-2 px-4 sm:px-5 py-3 text-xs font-medium text-ink-muted cursor-pointer select-none">
            <Clock className="w-3.5 h-3.5 text-ink-faint" />
            Snoozed · {snoozedEvents.length} — back when their time comes
          </summary>
          <ol className="divide-y divide-border border-t border-border">
            {snoozedEvents.map(item => <Row key={item.key} item={item} />)}
          </ol>
        </details>
      )}
    </div>
  )
}
