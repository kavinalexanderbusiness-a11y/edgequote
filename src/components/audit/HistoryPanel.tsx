'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  loadHistory, groupByWrite, HISTORY_PAGE,
  type AuditEvent, type HistoryFilter, type HistoryGroup,
} from '@/lib/audit/history'
import {
  actionLabel, actorName, sourceLabel, summary, changes,
} from '@/lib/audit/phrase'
import { cn } from '@/lib/utils'
import { AlertTriangle, ChevronDown, History as HistoryIcon, RotateCw } from 'lucide-react'

// ── THE history surface ──────────────────────────────────────────────────────
// ONE component behind Customer → History, Job → History, Quote → History and the
// business feed. They differ by FILTER, never by engine: a second history renderer
// is a second set of phrasing to keep in sync, and this codebase has paid for that
// mistake in other places (three "follow-up" concepts, four confidence vocabularies).
//
// A row answers WHO · WHAT · WHEN in one glance, with the change underneath it.
// Detail is behind a disclosure because most rows never need it:
//
//     Kavin              Rescheduled visit            Aug 15 · 8:42 PM
//     Aug 18, 10:00 AM → Aug 20, 1:00 PM
//
// ⚠️ NO GIANT BORDERED CARDS, and timeline rhythm only where it earns its keep —
// a hairline rule between rows, not a chrome box around each one.

interface HistoryPanelProps {
  /** Scope to one record. Omit for the business-wide feed. */
  filter?: HistoryFilter
  title?: string
  /** Shown when this record genuinely has no history. */
  emptyText?: string
  /** Rows before "Show more" fetches the next page. */
  pageSize?: number
  className?: string
}

export function HistoryPanel({
  filter, title = 'History',
  emptyText = 'Nothing has happened here yet.',
  pageSize = HISTORY_PAGE, className,
}: HistoryPanelProps) {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  // ⭐ A DROPPED READ IS NOT AN EMPTY HISTORY. `failed` keeps "we could not read
  //   this" separate from "nothing happened" — opposite messages that an
  //   `events.length === 0` branch would collapse into the reassuring one.
  const [failed, setFailed] = useState<string | null>(null)

  const key = JSON.stringify(filter ?? {})

  const load = useCallback(async () => {
    setLoading(true); setFailed(null)
    const res = await loadHistory(createClient(), { ...(filter ?? {}), limit: pageSize })
    if (res.failed) { setFailed(res.reason ?? 'The history could not be loaded.'); setEvents([]) }
    else { setEvents(res.events); setCursor(res.nextCursor) }
    setLoading(false)
    // `key` is the stable identity of `filter`; depending on the object itself
    // would re-run this on every render of a parent that builds it inline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pageSize])

  useEffect(() => { load() }, [load])

  const loadMore = async () => {
    if (cursor == null) return
    setLoadingMore(true)
    const res = await loadHistory(createClient(), { ...(filter ?? {}), before: cursor, limit: pageSize })
    if (!res.failed) { setEvents(prev => [...prev, ...res.events]); setCursor(res.nextCursor) }
    else setFailed(res.reason ?? 'The next page could not be loaded.')
    setLoadingMore(false)
  }

  const groups = groupByWrite(events)

  return (
    <section className={cn('min-w-0', className)}>
      <header className="flex items-center gap-2 mb-3">
        <HistoryIcon className="h-4 w-4 text-ink-faint shrink-0" aria-hidden />
        <h2 className="text-sm font-medium text-ink">{title}</h2>
        {events.length > 0 && (
          <span className="text-xs text-ink-faint tabular-nums">{events.length}</span>
        )}
      </header>

      {failed ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5">
          <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" aria-hidden />
          <p className="text-sm text-ink-muted min-w-0 flex-1">
            The history could not be loaded, so this is not a record of nothing
            happening. {failed}
          </p>
          <button
            type="button" onClick={load}
            className="inline-flex items-center gap-1.5 text-sm text-accent-text hover:underline min-h-[44px] sm:min-h-0"
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden /> Try again
          </button>
        </div>
      ) : loading ? (
        <p className="text-sm text-ink-faint py-2">Loading history…</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-ink-faint py-2">{emptyText}</p>
      ) : (
        <>
          <ol className="divide-y divide-border/60">
            {groups.map(g => <HistoryRow key={g.lead.id} group={g} />)}
          </ol>
          {cursor != null && (
            <button
              type="button" onClick={loadMore} disabled={loadingMore}
              className="mt-3 w-full sm:w-auto min-h-[44px] px-3 rounded-lg border border-border text-sm text-ink-muted hover:text-ink hover:bg-surface-raised transition-colors disabled:opacity-60"
            >
              {loadingMore ? 'Loading…' : 'Show earlier history'}
            </button>
          )}
        </>
      )}
    </section>
  )
}

/** "Aug 15 · 8:42 PM" — one stamp, always in the reader's own zone. */
function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}

function HistoryRow({ group }: { group: HistoryGroup }) {
  const [open, setOpen] = useState(false)
  const e = group.lead
  const line = summary(e)
  const detail = changes(e)
  const src = sourceLabel(e)
  // Expandable only when there is more to say than the summary already says.
  const expandable = detail.length > 1 || group.consequences.length > 0 || !!e.meta

  // ⭐ THE WHOLE ROW IS THE TAP TARGET when there is detail to open.
  //   The 375/390/430 pass measured the old "Detail ⌄" control at 48×16px — a
  //   finger-sized miss on every phone. Padding it out to 44px would have added
  //   ~28px to every expandable row (700px across a full page); making the row
  //   itself the target gives a ~112px × full-width hit area and adds nothing.
  //   The small "Detail" text stays as the affordance, not as the target.
  const body = (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm min-w-0 flex-1">
          {/* WHO, then WHAT — the two things a reader scans for. */}
          <span className="font-medium text-ink">{actorName(e)}</span>{' '}
          <span className="text-ink-muted">{actionLabel(e.action).toLowerCase()}</span>
          {e.entity_label && (
            <span className="text-ink-muted"> · {e.entity_label}</span>
          )}
        </p>
        {/* WHEN. Never wraps under the text; shrinks to its own column on phones. */}
        <time
          dateTime={e.occurred_at}
          className="text-xs text-ink-faint whitespace-nowrap shrink-0 tabular-nums"
        >
          {when(e.occurred_at)}
        </time>
      </div>

      {line && (
        <p className="mt-1 text-sm text-ink-muted break-words">{line}</p>
      )}

      {(src || expandable) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          {src && (
            <span className="text-[11px] uppercase tracking-wide text-ink-faint">{src}</span>
          )}
          {expandable && (
            <span className="inline-flex items-center gap-1 text-xs text-ink-faint">
              {open ? 'Hide detail' : 'Detail'}
              <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} aria-hidden />
            </span>
          )}
        </div>
      )}
    </>
  )

  return (
    <li className="py-3 first:pt-0">
      {expandable ? (
        <button
          type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          className="w-full text-left rounded-lg -mx-2 px-2 py-1 -my-1 hover:bg-surface-raised/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {body}
        </button>
      ) : body}

      {open && (
        <div className="mt-2 space-y-1.5 border-l-2 border-border/60 pl-3">
          {detail.map(c => (
            <p key={c.key} className="text-xs text-ink-muted break-words">
              <span className="text-ink-faint">{c.label}</span>{' '}
              {c.from !== null && <span>{c.from}</span>}
              {c.from !== null && c.to !== null && <span className="text-ink-faint"> → </span>}
              {c.to !== null && <span className="text-ink">{c.to}</span>}
            </p>
          ))}
          {/* Consequences of the SAME write — grouped by txid, never guessed at by
              timestamp proximity. "and the invoice became paid" belongs to the
              payment that caused it, not beside it as a second act. */}
          {group.consequences.map(c => (
            <p key={c.id} className="text-xs text-ink-faint break-words">
              …and {actionLabel(c.action).toLowerCase()}
              {c.entity_label ? ` · ${c.entity_label}` : ''}
            </p>
          ))}
          {typeof e.meta?.cascade === 'object' && e.meta.cascade !== null && (
            <p className="text-xs text-ink-faint">
              Also removed: {Object.entries(e.meta.cascade as Record<string, number>)
                .filter(([, n]) => Number(n) > 0)
                .map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`)
                .join(' · ') || 'nothing else'}
            </p>
          )}
        </div>
      )}
    </li>
  )
}
