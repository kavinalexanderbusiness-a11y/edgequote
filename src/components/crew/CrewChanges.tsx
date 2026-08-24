'use client'

import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import type { CrewChange, CrewChangeKind } from '@/lib/crewBrief'
import {
  Ban, XCircle, PlusCircle, Clock, ArrowUpDown, StickyNote, Megaphone, MessageSquare, Users,
  type LucideIcon,
} from 'lucide-react'

// ── "What changed since you looked" ──────────────────────────────────────────
//
// The seventh question, and the only one whose answer is worthless if it is not
// short. A worker reads this at a red light. lib/crewBrief has already decided
// what counts (and, more importantly, what does not); this decides how few of
// them fit on a phone before the day's actual work gets pushed off the screen.
//
// ⭐ IT LEADS WITH WHAT WOULD WASTE A TRIP. diffCrewDay returns changes in
// severity order — removed and cancelled first, reading material last — so
// truncating from the BOTTOM always keeps the line that stops a pointless
// drive. A "+3 more" that hid a cancellation would be the one bug this
// component could have.
//
// ⭐ TAPPING A LINE GOES TO THE STOP. The banner names a change; the card holds
// the address, the note, the phone number and the button. Restating any of that
// here would be a second job card, and the moment those two disagree the worker
// has no way to tell which is current.

const MAX_LINES = 4

const ICONS: Record<CrewChangeKind, LucideIcon> = {
  removed: Ban, cancelled: XCircle, added: PlusCircle, time: Clock, moved: ArrowUpDown,
  crew: Users, instruction: StickyNote, crew_note: Megaphone, day_note: Megaphone, message: MessageSquare,
}

/** Only the two "do not drive there" kinds get colour. If everything is urgent
 *  nothing is, and these are the two that cost a trip. */
const ALARMING: ReadonlySet<CrewChangeKind> = new Set<CrewChangeKind>(['removed', 'cancelled'])

/**
 * A REMOVED stop is no longer in the payload, so no card was rendered for it and
 * there is nothing on the page to scroll to. It stays a plain line rather than a
 * button that looks tappable and then does nothing — a dead control on a field
 * screen reads as a broken app, and this one would appear only on the change
 * that matters most.
 */
function isLinkable(c: CrewChange): boolean {
  return c.jobId !== null && c.kind !== 'removed'
}

export function CrewChanges({ changes, onDismiss, onGoToStop }: {
  changes: CrewChange[]
  onDismiss: () => void
  onGoToStop: (jobId: string) => void
}) {
  if (changes.length === 0) return null
  const shown = changes.slice(0, MAX_LINES)
  const hidden = changes.length - shown.length

  return (
    <section
      aria-label="What changed since you last looked"
      className="rounded-card border border-amber-500/40 bg-amber-500/[0.07] p-3.5"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-300">
          {changes.length === 1 ? '1 change since you looked' : `${changes.length} changes since you looked`}
        </p>
        {/* ⛔ The ONLY thing that advances the baseline. Nothing about rendering
            this banner marks it read — see crewBriefStore.writeCrewDayBaseline. */}
        <Button size="sm" variant="secondary" className="shrink-0 tap-target h-8" onClick={onDismiss}>
          Got it
        </Button>
      </div>

      <ul className="mt-2 space-y-1.5">
        {shown.map((c, i) => {
          const Icon = ICONS[c.kind]
          const alarming = ALARMING.has(c.kind)
          const body = (
            <>
              <Icon
                className={cn('w-3.5 h-3.5 shrink-0 mt-0.5', alarming ? 'text-amber-300' : 'text-ink-faint')}
                aria-hidden
              />
              {/* min-w-0 + break-words: a long customer name must wrap, never
                  push the card sideways. This screen has no horizontal scroll. */}
              <span className="min-w-0 flex-1 break-words">
                <span className={cn('font-medium', alarming ? 'text-amber-200' : 'text-ink')}>{c.label}</span>
                {c.detail && <span className="text-ink-muted"> — {c.detail}</span>}
              </span>
            </>
          )
          return (
            <li key={`${c.kind}:${c.jobId ?? 'day'}:${i}`} className="text-xs">
              {isLinkable(c) ? (
                <button
                  type="button"
                  onClick={() => onGoToStop(c.jobId!)}
                  className="w-full text-left flex items-start gap-1.5 rounded-md py-0.5 hover:bg-white/[0.04] transition-colors"
                >
                  {body}
                </button>
              ) : (
                <div className="flex items-start gap-1.5 py-0.5">{body}</div>
              )}
            </li>
          )
        })}
      </ul>

      {hidden > 0 && (
        <p className="mt-1.5 text-[11px] text-ink-faint">
          …and {hidden} more {hidden === 1 ? 'change' : 'changes'} below.
        </p>
      )}
    </section>
  )
}
