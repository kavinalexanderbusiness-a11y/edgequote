// ── THE owner briefing — today's shape, in linked facts ──────────────────────
// The compact line under the dashboard greeting: visits today, days that can't
// run as booked, quotes gone quiet, money past due, customers waiting on an
// answer. It EXTENDS the header facts the dashboard has always opened with
// (the old "morning briefing" was deliberately folded INTO this page — see
// notifications/page.tsx — so this strip is that digest growing doors, never a
// second briefing surface competing with it).
//
// COMPOSE, DO NOT RE-DERIVE — every figure is an existing engine's answer:
//   visits today       → the day-plan group the header already counted
//   schedule conflicts → the inbox's dayPlan source (planDay's own blocking
//                        verdicts, composed by lib/inboxData) — this file only
//                        counts days, it never re-judges capacity
//   awaiting follow-up → needsFollowUp via the dashboard batch — the SAME
//                        predicate behind the Quotes page's "Follow-ups due"
//                        tile, so the chip and its destination can't disagree
//   overdue            → THE ledger overlay's figure, verbatim from MoneyBand's
//                        input — never a second date comparison
//   requests           → lib/portalRequests' openRequests, verbatim
//
// Every chip deep-links to the surface that resolves it, and a chip renders
// ONLY when its fact is real: no zero-count chips (the visits chip is the one
// always-on fact — "no visits today" is itself today's shape), and no summary
// sentence — TodaysPriorities owns the all-clear celebration and its rules
// about degraded loads. A failed source renders as UNAVAILABLE, never as zero:
// an unknown schedule must not look like a clear one (the day-status law).

import { formatCurrency } from '@/lib/utils'
import type { SourceResult, DayPlanRow } from '@/lib/inbox'

export type BriefingChipId = 'visits' | 'conflicts' | 'followups' | 'overdue' | 'requests'

export interface BriefingChip {
  id: BriefingChipId
  /** The fact, count first: "7 visits today", "$1,240 overdue". */
  label: string
  /** Quiet suffix ("$840 booked", "3 invoices"). */
  sub?: string
  /** The one door — the surface where this fact resolves. */
  href: string
  tone: 'neutral' | 'attention' | 'urgent'
  /** The figure behind the label; null when the source couldn't be read. */
  count: number | null
  /** The source failed — the chip says so instead of claiming a number. */
  unavailable?: true
}

export interface BriefingInput {
  /** yyyy-MM-dd in the owner's timezone — drives the schedule day door. */
  todayISO: string
  /** Today's stops + booked value, from the day-plan band the page already
   *  computed (the all-or-throw batch: if the page rendered, these are real). */
  stopsToday: number
  revenueToday: number
  /** THE ledger overlay's overdue slice, verbatim from MoneyBand's input. */
  overdue: number
  overdueCount: number
  /** quotes.filter(needsFollowUp).length — computed in lib/dashboard/data. */
  followupsDue: number
  /** openRequests(...).length — computed in lib/dashboard/data. */
  requestsOpen: number
  /** The inbox's day-conflict source — the ONE briefing input that loads
   *  independently of the batch and can fail on its own. */
  dayPlan: SourceResult<DayPlanRow>
}

export interface BriefingResult {
  /** Render-ready, in order. Chips for zero facts are already absent. */
  chips: BriefingChip[]
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function composeBriefing(i: BriefingInput): BriefingResult {
  const chips: BriefingChip[] = []

  // Today's visits — the one always-present fact. Zero is an answer here ("no
  // visits today" IS today's shape), and the door opens the schedule on today
  // via the cursor-only ?d= day door.
  chips.push({
    id: 'visits',
    label: i.stopsToday > 0 ? `${plural(i.stopsToday, 'visit')} today` : 'No visits today',
    sub: i.revenueToday > 0 ? `${formatCurrency(i.revenueToday)} booked` : undefined,
    href: `/dashboard/schedule?d=${encodeURIComponent(i.todayISO)}`,
    tone: 'neutral',
    count: i.stopsToday,
  })

  // Days that cannot run as booked — planDay's own blocking verdicts, one per
  // day, exactly the days the inbox lists as "Fix X's schedule". One conflict
  // opens that day; several open the inbox, where each day has its own row.
  if (!i.dayPlan.ok) {
    chips.push({
      id: 'conflicts',
      label: 'Schedule check unavailable',
      href: '/dashboard/inbox',
      tone: 'attention',
      count: null,
      unavailable: true,
    })
  } else {
    const blockedDays = i.dayPlan.rows.filter(d => d.warnings.some(w => w.severity === 'blocking'))
    if (blockedDays.length > 0) {
      chips.push({
        id: 'conflicts',
        label: plural(blockedDays.length, 'schedule conflict'),
        href: blockedDays.length === 1
          ? `/dashboard/schedule?d=${encodeURIComponent(blockedDays[0].date)}`
          : '/dashboard/inbox',
        tone: 'urgent',
        count: blockedDays.length,
      })
    }
  }

  // Quotes gone quiet — the Quotes page's own "Follow-ups due" number. The
  // door is that page: its tile restates this count and its list holds the
  // queue (the S13 row names the single most urgent one; this chip is the SET).
  if (i.followupsDue > 0) {
    chips.push({
      id: 'followups',
      label: `${plural(i.followupsDue, 'quote')} awaiting follow-up`,
      href: '/dashboard/quotes',
      tone: 'attention',
      count: i.followupsDue,
    })
  }

  // Money past due — THE ledger overlay's slice. ?f=overdue lands the invoices
  // page pre-filtered to exactly the rows behind this figure.
  if (i.overdueCount > 0) {
    chips.push({
      id: 'overdue',
      label: `${formatCurrency(i.overdue)} overdue`,
      sub: plural(i.overdueCount, 'invoice'),
      href: '/dashboard/invoices?f=overdue',
      tone: 'urgent',
      count: i.overdueCount,
    })
  }

  // Portal requests still waiting — same door as the S13 requests row (`?f=`
  // is the messages page's filter param; `?filter=` is silently ignored there).
  if (i.requestsOpen > 0) {
    chips.push({
      id: 'requests',
      label: `${plural(i.requestsOpen, 'customer request')} to review`,
      href: '/dashboard/messages?f=requests',
      tone: 'attention',
      count: i.requestsOpen,
    })
  }

  return { chips }
}
