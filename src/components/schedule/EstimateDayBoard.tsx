// ── The day's estimate visits ────────────────────────────────────────────────
//
// Sits directly above the work board in Day view, in the same visual language,
// so the owner reads one day: what I'm quoting, and what I'm doing.
//
// ⭐ WHY THIS IS NOT A ROW INSIDE DayOpsPanel. That component is 1,500 lines of
// operations that only make sense for work — change orders, add-ons, prices,
// work sessions, invoicing, mark-done. Rendering an estimate through it would
// mean making each of those conditional, and the first one anybody forgets is
// the day an estimate visit invoices somebody. Estimates get their own rows so
// that a job affordance cannot reach them by accident: the separation is
// structural here for the same reason it is structural in the database.
//
// Renders nothing at all on a day with no estimates.

'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { Menu } from '@/components/ui/Menu'
import { Ruler, MapPin, Phone, MessageSquare, Check, X, UserX, FileText, Pencil, RotateCcw } from 'lucide-react'
import { ITEM_META } from '@/lib/scheduleItems'
import type { ScheduleItemStatus } from '@/lib/scheduleItems'
import {
  STATUS_LABELS, awaitingQuote, estimateMinutes, isOpen, timeLabel,
  type EstimateAppointment,
} from '@/lib/estimateAppointments'

interface Props {
  items: EstimateAppointment[]
  /** A failed READ. Shown as "we don't know", never as an empty day. */
  error?: string | null
  onEdit: (item: EstimateAppointment) => void
  onSetStatus: (item: EstimateAppointment, to: ScheduleItemStatus) => void
  onMessage?: (item: EstimateAppointment) => void
  onAdd?: () => void
}

function statusTone(s: ScheduleItemStatus): string {
  switch (s) {
    case 'completed': return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
    case 'cancelled': return 'text-ink-muted bg-bg-tertiary border-border'
    case 'no_show': return 'text-red-400 bg-red-500/10 border-red-500/20'
    default: return ITEM_META.estimate.chip
  }
}

function EstimateRow({ item, onEdit, onSetStatus, onMessage }: {
  item: EstimateAppointment
  onEdit: Props['onEdit']
  onSetStatus: Props['onSetStatus']
  onMessage?: Props['onMessage']
}) {
  const address = item.properties?.address ?? null
  const phone = item.customers?.phone ?? item.phone ?? null
  const open = isOpen(item)
  const quoteHref = item.converted_quote_id
    ? `/dashboard/quotes/${item.converted_quote_id}`
    : `/dashboard/quotes/new?estimate=${item.id}`
      + (item.customer_id ? `&customer=${item.customer_id}` : '')
      + (item.property_id ? `&property=${item.property_id}` : '')

  return (
    <div className="rounded-card border border-border bg-bg-secondary p-3 flex flex-col gap-2">
      <div className="flex items-start gap-3">
        <span className={`shrink-0 mt-0.5 w-8 h-8 rounded-lg border flex items-center justify-center ${ITEM_META.estimate.chip}`}>
          <Ruler className="w-4 h-4" aria-hidden />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {/* The word ESTIMATE is not decoration — it is the whole point of
                the row, so it is never truncated away on a narrow screen. */}
            <span className={`shrink-0 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border ${ITEM_META.estimate.chip}`}>
              Estimate
            </span>
            <p className="font-semibold text-ink text-sm truncate">{item.title}</p>
          </div>
          <p className="text-xs text-ink-muted mt-0.5">
            {timeLabel(item)}
            {item.customers?.name ? ` · ${item.customers.name}` : ''}
          </p>
          {address && <p className="text-xs text-ink-faint truncate mt-0.5">{address}</p>}
          {item.notes && (
            <p className="text-xs text-ink-faint mt-1 line-clamp-2">
              <span className="font-semibold">Private:</span> {item.notes}
            </p>
          )}
          {item.cancel_reason && (
            <p className="text-xs text-ink-faint mt-1">{item.cancel_reason}</p>
          )}
        </div>

        <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${statusTone(item.status)}`}>
          {STATUS_LABELS[item.status]}
        </span>
      </div>

      {/* Actions wrap rather than scroll — at 375px these become two rows, and a
          44px touch target is kept on every one of them. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {address && (
          <Button
            variant="secondary" size="sm"
            onClick={() => window.open(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`, '_blank')}
          >
            <MapPin className="w-3.5 h-3.5" /> Directions
          </Button>
        )}
        {phone && (
          <Button variant="secondary" size="sm" onClick={() => { window.location.href = `tel:${phone}` }}>
            <Phone className="w-3.5 h-3.5" /> Call
          </Button>
        )}
        {onMessage && item.customer_id && (
          <Button variant="secondary" size="sm" onClick={() => onMessage(item)}>
            <MessageSquare className="w-3.5 h-3.5" /> Text
          </Button>
        )}

        {open && (
          <Button variant="secondary" size="sm" onClick={() => onSetStatus(item, 'completed')}>
            <Check className="w-3.5 h-3.5" /> Visit done
          </Button>
        )}

        {/* The quote is the POINT of the visit, so it is a primary action the
            moment the visit is done and nothing has been written yet. */}
        <Link href={quoteHref}>
          <Button variant={awaitingQuote(item) ? 'primary' : 'secondary'} size="sm">
            <FileText className="w-3.5 h-3.5" />
            {item.converted_quote_id ? 'Open quote' : 'Write quote'}
          </Button>
        </Link>

        <Menu align="end" width={280} ariaLabel="Estimate visit actions" items={[
          { key: 'edit', label: 'Edit visit', description: 'Date, time, who’s going, notes', icon: Pencil, onSelect: () => onEdit(item) },
          ...(open ? [
            // Two different outcomes, deliberately not one "close" action: the
            // difference between them is the wasted trip.
            { key: 'cancel', label: 'Customer cancelled', description: 'They called it off — no trip made', icon: X, onSelect: () => onSetStatus(item, 'cancelled') },
            { key: 'noshow', label: 'Nobody home', description: 'You went; they weren’t there', icon: UserX, danger: true, onSelect: () => onSetStatus(item, 'no_show') },
          ] : [
            { key: 'reopen', label: 'Put back on the schedule', description: 'Undo — returns it to scheduled', icon: RotateCcw, onSelect: () => onSetStatus(item, 'scheduled') },
          ]),
        ]}>
          {({ toggle, triggerProps }) => (
            <Button size="sm" variant="ghost" onClick={toggle} aria-label="More actions" {...triggerProps}>
              More
            </Button>
          )}
        </Menu>
      </div>
    </div>
  )
}

export function EstimateDayBoard({ items, error, onEdit, onSetStatus, onMessage, onAdd }: Props) {
  const [showClosed, setShowClosed] = useState(false)

  if (error) {
    return (
      <div className="rounded-card border border-amber-500/20 bg-amber-500/5 p-3 mb-3">
        <p className="text-xs text-amber-400">
          Couldn’t load today’s estimate visits, so this list may be incomplete — {error}
        </p>
      </div>
    )
  }

  const open = items.filter(isOpen)
  const closed = items.filter(i => !isOpen(i))
  if (!items.length) return null

  const shown = showClosed ? [...open, ...closed] : open
  const totalMin = open.reduce((n, i) => n + estimateMinutes(i), 0)

  return (
    <section className="mb-3 space-y-2" aria-label="Estimate visits today">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-muted flex items-center gap-1.5">
          <Ruler className="w-3.5 h-3.5 text-sky-400" aria-hidden />
          Estimate visits
          {open.length > 0 && (
            <span className="text-ink-faint normal-case font-normal">
              · {open.length} · {totalMin} min
            </span>
          )}
        </h2>
        <div className="flex items-center gap-1.5">
          {closed.length > 0 && (
            <button
              type="button"
              onClick={() => setShowClosed(s => !s)}
              className="text-[11px] font-semibold text-ink-muted hover:text-ink transition-colors"
            >
              {showClosed ? 'Hide' : `Show ${closed.length} done/cancelled`}
            </button>
          )}
          {onAdd && <Button variant="secondary" size="sm" onClick={onAdd}>Add</Button>}
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="text-xs text-ink-faint">No estimate visits left on this day.</p>
      ) : (
        <div className="space-y-2">
          {shown.map(i => (
            <EstimateRow key={i.id} item={i} onEdit={onEdit} onSetStatus={onSetStatus} onMessage={onMessage} />
          ))}
        </div>
      )}
    </section>
  )
}
