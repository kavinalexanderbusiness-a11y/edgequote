'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import type { Job } from '@/types'
import type { Coord } from '@/lib/geo'
import { directionsUrl } from '@/lib/route'
import { Button } from '@/components/ui/Button'
import { StickyActionBar } from '@/components/ui/StickyActionBar'
import { VisitAddress } from '@/components/schedule/VisitAddress'
import { VisitConversation } from '@/components/schedule/VisitConversation'
import {
  CheckCircle2, ChevronUp, Navigation, PauseCircle, Phone, Play,
  MessagesSquare, StickyNote, User as UserIcon, X,
} from 'lucide-react'

// ── The field bar: the day's next stop, and everything it takes to do it ─────
//
// MEASURED, on the deployed build at 375 × 844 with a real day (11 visits):
//
//   first card's "Start"      y = 1735   → 939px of scrolling
//   its "Route to"            y = 1781   → 985px
//   its "Crew chat"           y = 1873   → 1077px
//   whole board               6.6 screens · 171 controls
//
// The bar already rescued the PRIMARY action from that scroll — it restated
// Start / Complete in thumb reach. But a contractor standing in a driveway needs
// four more things before that button means anything, and every one of them was
// still a thousand pixels away: how do I get there, what did they tell us about
// the property, how do I reach the customer, and what has the crew said.
//
// So the bar now answers, in one tap, the five questions the field asks:
//
//   where am I going  → Directions (the SAME directionsUrl the card uses)
//   who is it         → the name, and Call when there is a number on file
//   what do I need to know → the crew note (gate code, dog, where to park)
//   what has been said→ the visit conversation, ⛔ the CREW one, never the
//                       customer's SMS thread — two audiences, two doors
//   what happens next → Stop / Start / Resume / Complete, unchanged
//
// ⭐ It ADDS REACH, NOT CAPABILITY. Every control here is the same engine the
// day-board card calls; nothing can be done from this bar that cannot be done
// from the card, and nothing here decides anything the card doesn't.
//
// ⭐ COLLAPSED BY DEFAULT, and it stays that way until asked: the bar is what
// stands between the last job card and the bottom of the screen, and a panel
// that opens itself would cover the board it is meant to summarise.

interface Props {
  job: Job
  baseCoord: Coord | null
  /** Unread crew messages on THIS visit, from the day board's one query. */
  unread?: number
  busy: boolean
  onStop: () => void
  onPrimary: () => void | Promise<void>
}

export function FieldStopBar({ job, baseCoord, unread = 0, busy, onStop, onPrimary }: Props) {
  const [open, setOpen] = useState(false)
  const [chat, setChat] = useState(false)

  // A different stop means a different set of answers — never inherit the last
  // one's open panel.
  useEffect(() => { setOpen(false); setChat(false) }, [job.id])

  const running = job.status === 'in_progress' && !!job.started_at
  const stopped = job.status === 'in_progress' && !job.started_at
  const phone = job.customers?.phone?.trim() || ''
  const address = job.properties?.address || ''
  const hasWhere = !!address || job.properties?.lat != null
  // ⭐ jobs.notes is the CREW note — gate codes, where to park, the dog. It is
  // deliberately not in get_portal_data and never shown to a customer.
  const note = job.notes?.trim() || ''

  return (
    <>
      <StickyActionBar fixed className="lg:hidden">
        {/* ── The answers, when asked for ────────────────────────────────────
            Above the action row so opening it pushes the buttons DOWN the
            screen rather than covering them — the bar's whole reason to exist
            is that the primary action stays under the thumb. */}
        {open && (
          <div className="pb-2.5 mb-2.5 border-b border-border space-y-2">
            {note && (
              <p className="flex items-start gap-1.5 text-xs text-ink leading-snug">
                <StickyNote aria-hidden className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-400" />
                <span className="min-w-0">{note}</span>
              </p>
            )}
            <div className="flex items-center gap-1.5 flex-wrap">
              {hasWhere && (
                <a href={directionsUrl({ lat: job.properties?.lat ?? null, lng: job.properties?.lng ?? null, address }, baseCoord)}
                  target="_blank" rel="noopener noreferrer"
                  className="tap-target h-10 px-3 rounded-lg border border-border bg-surface text-ink text-xs font-medium flex items-center justify-center gap-1.5">
                  <Navigation aria-hidden className="w-3.5 h-3.5" /> Directions
                </a>
              )}
              {phone && (
                <a href={`tel:${phone}`}
                  className="tap-target h-10 px-3 rounded-lg border border-border bg-surface text-ink text-xs font-medium flex items-center justify-center gap-1.5">
                  <Phone aria-hidden className="w-3.5 h-3.5" /> Call
                </a>
              )}
              {/* ⚠️ The CREW conversation — internal, and no customer surface can
                  read it. The button that texts the customer stays on the card,
                  where its consent gating and segment cost are in view. */}
              <button type="button" onClick={() => setChat(true)}
                className="tap-target h-10 px-3 rounded-lg border border-border bg-surface text-ink text-xs font-medium flex items-center justify-center gap-1.5">
                <MessagesSquare aria-hidden className="w-3.5 h-3.5" />
                {unread > 0 ? `Crew chat (${unread})` : 'Crew chat'}
              </button>
              {job.customer_id && (
                <Link href={`/dashboard/customers/${job.customer_id}`}
                  className="tap-target h-10 px-3 rounded-lg border border-border bg-surface text-ink text-xs font-medium flex items-center justify-center gap-1.5">
                  <UserIcon aria-hidden className="w-3.5 h-3.5" /> Customer
                </Link>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center gap-3">
          {/* The identity block is the disclosure. It was already the largest
              target in the bar and did nothing at all when tapped. */}
          <button type="button" onClick={() => setOpen(o => !o)}
            aria-expanded={open} aria-label={open ? 'Hide stop details' : 'Show stop details'}
            className="min-w-0 flex-1 flex items-center gap-2 text-left rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <span className="min-w-0 flex-1">
              {/* Three states, not two. A job that is underway with nobody on the
                  clock — stopped for the day — is neither "in progress right
                  now" nor "next stop", and calling it either is the lie this bar
                  existed to avoid. */}
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                {job.status === 'in_progress' ? (running ? 'On the clock' : 'Underway · stopped') : 'Next stop'}
              </span>
              <span className="block text-sm font-semibold text-ink truncate">
                {job.customers?.name || job.title}
              </span>
              <VisitAddress address={job.properties?.address} />
            </span>
            <span className="shrink-0 flex items-center gap-1">
              {/* A silent badge is the only thing here that must be seen without
                  opening anything: a message waiting is news. */}
              {unread > 0 && !open && (
                <span aria-label={`${unread} unread crew message${unread !== 1 ? 's' : ''}`}
                  className="min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-accent text-black text-[10px] font-bold flex items-center justify-center tabular-nums">
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
              <ChevronUp aria-hidden className={cn('w-4 h-4 text-ink-faint transition-transform', !open && 'rotate-180')} />
            </span>
          </button>

          {/* On the clock, the phone gets BOTH doors: stop the day, or finish the
              job. They are different decisions and neither may be reached only
              through a menu — "Stop" hidden behind an overflow is how a crew ends
              up completing a job to get out of the rain. Stop is the quieter of
              the two, so it is the ghost button. */}
          {running && (
            <Button size="lg" variant="ghost" className="shrink-0 tap-target" disabled={busy} onClick={onStop}>
              <PauseCircle className="w-4 h-4" /> Stop
            </Button>
          )}
          <Button size="lg" className="shrink-0 tap-target" loading={busy} onClick={onPrimary}>
            {job.status === 'in_progress'
              ? (running
                ? <><CheckCircle2 className="w-4 h-4" /> Complete</>
                : <><Play className="w-4 h-4" /> Resume</>)
              : <><Play className="w-4 h-4" /> Start</>}
          </Button>
        </div>
      </StickyActionBar>

      {/* The crew conversation, from the bar. Same component the card opens — one
          thread, two doors, exactly like the stop sheet. Full-height sheet: this
          is a keyboard surface, and a short one would put the composer under the
          software keyboard. */}
      {chat && (
        <div className="lg:hidden fixed inset-0 z-overlay flex flex-col" role="dialog" aria-modal="true" aria-label="Crew conversation">
          <button aria-label="Close" onClick={() => setChat(false)} className="flex-1 bg-black/50 backdrop-blur-[2px]" />
          {/* ⚠️ dvh, not vh. `vh` is the viewport with the mobile URL bar HIDDEN,
              so an 80vh sheet is taller than what you can see while that bar is
              showing — and its composer ends up behind browser chrome with no
              way to scroll to it. Same rule verify:mobile-shell pins on Modal;
              the vh value stays as the fallback for anything without dvh. */}
          <div className="rounded-t-2xl bg-bg-secondary border-t border-border p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] max-h-[80vh] supports-[max-height:1dvh]:max-h-[80dvh] overflow-y-auto overscroll-contain">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-faint truncate">
                Crew · {job.customers?.name || job.title}
              </p>
              <button type="button" onClick={() => setChat(false)} aria-label="Close"
                className="w-11 h-11 -mr-2 flex items-center justify-center text-ink-muted hover:text-ink">
                <X aria-hidden className="w-5 h-5" />
              </button>
            </div>
            <VisitConversation jobId={job.id} />
          </div>
        </div>
      )}
    </>
  )
}
