// ── THE Owner Inbox composer ─────────────────────────────────────────────────
// One calm answer to "when I open EdgeHQ, what genuinely needs me?" — composed
// from the engines that already exist, never a second opinion beside them.
//
// TWO HALVES, NEVER MIXED:
//   NEEDS YOU — human action required. Almost all of it is DERIVED from current
//     canonical state (the Session-13 priority queue, draft change orders,
//     unread crew words, a day that cannot run as booked), so an item resolves
//     ITSELF the moment the canonical state changes — schedule the job and the
//     row is gone, no notification residue to clean up. The only persistent
//     rows here are the bell's `action`-tier events (failed payments, disputes,
//     autopay holds): things no table's current state can re-derive, which is
//     exactly why the notifications table exists for them.
//   UPDATES — things that happened; useful, not actionable. Sourced from the
//     same notifications stream, windowed, and grouped by the ONE notification
//     organizer (lib/notifications). When Session 68's audit trail lands, this
//     is the seam it plugs into: anything that can map its events into
//     AppNotification's shape can feed `updates` — nothing else here changes.
//
// ── COMPOSE, DO NOT RE-DERIVE ────────────────────────────────────────────────
// • "What should the owner do?"      → computePriorities (lib/dashboard/priorities)
// • "Is this notification an action?"→ notifPriority (lib/notifications) — this
//   file deliberately has NO type list of its own for the action tier.
// • "Can this day run as booked?"    → planDay's warnings (lib/dayPlan); this
//   file only reads severity, it never re-computes capacity.
// • "Is a crew message unread?"      → loadOwnerUnread's derivation (the loader
//   calls it); this file only ranks the result.
//
// ── DEDUP BY SEMANTIC ACTION ─────────────────────────────────────────────────
// One underlying action must be ONE item. The priority queue already dedupes
// within itself (leads vs messages vs requests). Across the state/event line the
// rule is: a notification type whose situation is ALREADY derived from state is
// MIRRORED, and mirrored types never render here — the state item owns the
// action (and unlike the notification, it disappears when the work is done).
//
// ── SNOOZE (V1, deliberately narrow) ─────────────────────────────────────────
// Only EVENT items snooze, via the notifications row's own snoozed_until —
// server-side, tenant-scoped, source truth untouched, reappears on expiry.
// DERIVED items have no snooze: they resolve through their canonical door, and
// "hide this real unresolved work" is exactly the failure the spec forbids. A
// durable per-item snooze store for derived rows needs a migration this session
// cannot apply (no DB credentials on this machine — Session 62's env policy);
// the seam is `snoozedEvents` + this comment, not a half-built table.

import type { Priority } from '@/lib/dashboard/priorities'
import type { AppNotification } from '@/components/notifications/NotificationBell'
import { groupNotifications, notifPriority, type NotifGroup } from '@/lib/notifications'
import type { DayPlanWarning } from '@/lib/dayPlan'

// ── Source results — a failed read is an ANSWER, never an empty list ─────────

export type SourceResult<T> = { ok: true; rows: T[] } | { ok: false; error: string }

export type InboxSourceKey = 'work' | 'changeOrders' | 'crew' | 'dayPlan' | 'events'

/** Owner-facing names for the degraded banner ("Couldn't check: …"). */
export const SOURCE_LABELS: Record<InboxSourceKey, string> = {
  work: 'today’s work',
  changeOrders: 'change orders',
  crew: 'crew messages',
  dayPlan: 'day plans',
  events: 'notifications',
}

export interface ChangeOrderRow {
  id: string
  jobId: string
  status: string
  coNumber: string | null
  amount: number
  customerName: string | null
  createdAt: string
}

export interface CrewUnreadRow {
  jobId: string
  unread: number
  title: string | null
  customerName: string | null
  scheduledDate: string | null
}

export interface DayPlanRow {
  /** yyyy-MM-dd */
  date: string
  stops: number
  /** planDay's OWN warnings for that day — this module only reads severity. */
  warnings: DayPlanWarning[]
}

export interface InboxSources {
  /** The Session-13 queue, uncapped — ok:false when its core batch failed. */
  work: SourceResult<Priority>
  changeOrders: SourceResult<ChangeOrderRow>
  crew: SourceResult<CrewUnreadRow>
  dayPlan: SourceResult<DayPlanRow>
  /** Non-archived notification rows, newest first. */
  events: SourceResult<AppNotification>
}

// ── Items ────────────────────────────────────────────────────────────────────

export type InboxSection = 'urgent' | 'today' | 'upcoming'

export const SECTION_ORDER: InboxSection[] = ['urgent', 'today', 'upcoming']
export const SECTION_LABELS: Record<InboxSection, string> = {
  urgent: 'Urgent',
  today: 'Today',
  upcoming: 'Upcoming',
}

export type InboxItemKind = Priority['kind'] | 'change_orders' | 'crew' | 'day_conflict' | 'payment_event'

export interface InboxItem {
  /** Stable within a compose run; event keys are stable across runs (n:<id>). */
  key: string
  kind: InboxItemKind
  section: InboxSection
  /** The action sentence — says WHAT, names WHO. Never "attention needed". */
  label: string
  detail: string
  /** The one door — opens the exact surface where this resolves. */
  href: string
  value?: number
  more?: number
  /** ISO timestamp for the age line. Event items always carry it. */
  at?: string | null
  /** Derived-from-state (self-resolving) vs notification-backed (dismissable). */
  source: 'state' | 'event'
  /** Event items only: the notifications row snooze/dismiss acts on. */
  notificationId?: string
  score: number
}

export interface InboxResult {
  needsYou: InboxItem[]
  /** Event items hidden by an ACTIVE snooze — shown collapsed, never deleted. */
  snoozedEvents: InboxItem[]
  /** Grouped by THE notification organizer; windowed, mirrored types removed. */
  updates: NotifGroup[]
  /** Human names (SOURCE_LABELS values) of sources that could not be read. */
  failures: string[]
  counts: {
    /** = needsYou.length, always — never a second bookkeeping path. */
    needsYou: number
    /** Unread update notifications inside the window. */
    updatesUnread: number
  }
  /**
   * True ONLY when the queue is empty AND every source was actually read.
   * "You're all caught up" over a failed read is the confident lie the trust
   * audits exist to prevent — a degraded load must never celebrate.
   */
  allClear: boolean
}

export interface ComposeInboxInput {
  sources: InboxSources
  /** The clock, injected — the engine takes time, it never asks for it. */
  now: Date
  /** yyyy-MM-dd in the owner's timezone (drives day-conflict proximity). */
  todayISO: string
  /** Needs-You event window. Older unarchived action events stay in the bell. */
  eventWindowDays?: number
  /** Updates window — recent news, not a permanent social feed. */
  updateWindowDays?: number
}

export const EVENT_WINDOW_DAYS = 30
export const UPDATE_WINDOW_DAYS = 7

/**
 * Notification types whose situation is ALREADY a derived Needs-You item, so
 * the event must not render in the inbox at all — not as an action (the state
 * item owns it and self-resolves) and not as an update (the same news twice).
 *   website_lead / portal_request → the queue's leads / requests rows
 *   new_message                   → the queue's messages row
 *   crew_message                  → the derived crew rows below
 * The bell keeps showing them — this is the inbox's dedup, not a global mute.
 */
export const MIRRORED_BY_STATE = new Set(['website_lead', 'portal_request', 'new_message', 'crew_message'])

const DAY_MS = 86_400_000

// yyyy-MM-dd plus n days, via local midnight (same construction as the
// priorities engine's daysBetween — no UTC-boundary drift).
function isoPlusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function weekdayName(dateISO: string, todayISO: string): string {
  if (dateISO === todayISO) return 'today'
  if (dateISO === isoPlusDays(todayISO, 1)) return 'tomorrow'
  return new Date(`${dateISO}T00:00:00`).toLocaleDateString('en-CA', { weekday: 'long' })
}

// The queue's own tier-adder discipline, restated: adders order WITHIN a tier
// and may never jump one. Imported constants would be circular-free too, but
// these scores are the INBOX's tiers (they interleave with Priority scores in
// one list), so they are declared here, beside each other, where a collision is
// visible at a glance:
//   110k payment events · 100k unpaid · 90k leads · 85k near day conflict ·
//   80k ready-to-schedule · … · 65k far day conflict … 52k CO drafts ·
//   34k crew · … (everything else = the queue's own scores)
const clampAdder = (n: number) => Math.min(Math.max(n, 0), 9_000)

export function composeInbox(i: ComposeInboxInput): InboxResult {
  const { sources, now, todayISO } = i
  const eventWindowMs = (i.eventWindowDays ?? EVENT_WINDOW_DAYS) * DAY_MS
  const updateWindowMs = (i.updateWindowDays ?? UPDATE_WINDOW_DAYS) * DAY_MS
  const nowMs = now.getTime()

  const needsYou: InboxItem[] = []
  const snoozedEvents: InboxItem[] = []
  const failures: string[] = []
  for (const key of Object.keys(SOURCE_LABELS) as InboxSourceKey[]) {
    if (!sources[key].ok) failures.push(SOURCE_LABELS[key])
  }

  // ── 1) The Session-13 queue, verbatim ──────────────────────────────────────
  // Sections: the engine's own urgency flag decides 'urgent' (it owns the
  // overdue/missed semantics); the two retention kinds are 'upcoming' (they can
  // wait a day without anyone being let down); everything else is 'today'.
  if (sources.work.ok) {
    const seen: Record<string, number> = {}
    for (const p of sources.work.rows) {
      const n = (seen[p.kind] = (seen[p.kind] ?? 0) + 1)
      needsYou.push({
        key: n === 1 ? `p:${p.kind}` : `p:${p.kind}:${n}`,
        kind: p.kind,
        section: p.urgency === 'urgent' ? 'urgent'
          : p.kind === 'reactivation' || p.kind === 'lapsed' || p.kind === 'followups_blocked' ? 'upcoming'
          : 'today',
        label: p.label, detail: p.detail, href: p.href,
        value: p.value, more: p.more,
        source: 'state',
        score: p.score,
      })
    }
  }

  // ── 2) Draft change orders — priced extra work that never got asked for ────
  // Approval/decline are the CUSTOMER's move and arrive as update events; a
  // PENDING change is also the customer's move (chasing it is deliberately not
  // a verb here — the owner ruling that keeps the pipeline to 14 verbs). A
  // DRAFT is the owner's: they wrote it and nobody has seen it.
  if (sources.changeOrders.ok) {
    const drafts = sources.changeOrders.rows.filter(c => c.status === 'draft')
    if (drafts.length > 0) {
      const top = [...drafts].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
      const total = drafts.reduce((s, c) => s + Number(c.amount || 0), 0)
      const name = (top.customerName ?? '').trim()
      needsYou.push({
        key: `co:${top.id}`,
        kind: 'change_orders',
        section: 'today',
        label: name ? `Send ${name} the change order` : 'Send the change order you drafted',
        detail: `${top.coNumber ?? 'Change order'} · drafted, customer hasn’t seen it`,
        // The visit is where change orders live and are sent from — the same
        // door the bell's change_order_* events use.
        href: `/dashboard/schedule?job=${encodeURIComponent(top.jobId)}`,
        value: Number(top.amount || 0) || undefined,
        more: drafts.length - 1,
        at: top.createdAt,
        source: 'state',
        score: 52_000 + clampAdder(total),
      })
    }
  }

  // ── 3) Unread crew words — a person on a job site said something ───────────
  // One row per VISIT (the conversation's own unit), not one giant count: each
  // row's door is its own thread. unread here is loadOwnerUnread's derivation —
  // a PERSON's words, system lines are context.
  if (sources.crew.ok) {
    const withUnread = sources.crew.rows.filter(r => r.unread > 0)
      .sort((a, b) => b.unread - a.unread || String(b.scheduledDate ?? '').localeCompare(String(a.scheduledDate ?? '')))
    const totalUnread = withUnread.reduce((s, r) => s + r.unread, 0)
    withUnread.forEach((r, idx) => {
      const who = (r.customerName ?? '').trim() || (r.title ?? '').trim() || 'a visit'
      needsYou.push({
        key: `crew:${r.jobId}`,
        kind: 'crew',
        section: 'today',
        label: `Reply to your crew — ${who}`,
        detail: `${r.unread} new message${r.unread !== 1 ? 's' : ''}${r.scheduledDate ? ` · visit ${weekdayName(r.scheduledDate, todayISO)}` : ''}`,
        href: `/dashboard/schedule?job=${encodeURIComponent(r.jobId)}`,
        source: 'state',
        // 34k: above requests (32k) — a crew member is usually standing on the
        // job site when they write; a portal request is asynchronous by nature.
        // Later rows step down by 10 so multiple threads keep a stable order
        // without ever leaving the tier.
        score: 34_000 + clampAdder(totalUnread * 100) - idx * 10,
      })
    })
  }

  // ── 4) Days that cannot run as booked — planDay's own blocking verdicts ────
  // Only severity 'blocking' surfaces here (day blocked / crew short / labour
  // over): those say TODAY'S PLAN IS FICTION, which is owner work. Warnings and
  // caveats stay on the schedule board where their context lives.
  if (sources.dayPlan.ok) {
    const nearCutoff = isoPlusDays(todayISO, 1)
    for (const d of sources.dayPlan.rows) {
      const blocking = d.warnings.filter(w => w.severity === 'blocking')
      if (blocking.length === 0) continue
      const near = d.date <= nearCutoff
      needsYou.push({
        key: `day:${d.date}`,
        kind: 'day_conflict',
        section: near ? 'urgent' : 'upcoming',
        label: `Fix ${weekdayName(d.date, todayISO)}’s schedule`,
        detail: blocking[0].message,
        href: `/dashboard/schedule?d=${encodeURIComponent(d.date)}`,
        at: d.date,
        source: 'state',
        // A day that can't run as booked outranks scheduling MORE work (80k),
        // but never a failed payment or money already overdue.
        score: (near ? 85_000 : 65_000) + clampAdder(d.stops * 200),
      })
    }
  }

  // ── 5) Action-tier events — the bell's own tier, not a list kept here ──────
  // notifPriority is THE classifier; this file adds no second vocabulary. These
  // are the only Needs-You items with a lifecycle (snooze / dismiss) because
  // they are the only ones no current state can re-derive.
  if (sources.events.ok) {
    for (const n of sources.events.rows) {
      if (notifPriority(n.type) !== 'action') continue
      if (n.archived_at) continue
      const atMs = Date.parse(n.created_at)
      if (!Number.isFinite(atMs) || nowMs - atMs > eventWindowMs) continue
      const item: InboxItem = {
        key: `n:${n.id}`,
        kind: 'payment_event',
        section: 'urgent',
        label: n.title,
        detail: n.body ?? '',
        href: n.href || '/dashboard/notifications',
        at: n.created_at,
        source: 'event',
        notificationId: n.id,
        score: 110_000,
      }
      // An ACTIVE snooze hides, an EXPIRED one is inert — the strict '>' is the
      // whole difference between "later" and "never".
      const snoozedUntil = n.snoozed_until ? Date.parse(n.snoozed_until) : null
      if (snoozedUntil != null && snoozedUntil > nowMs) snoozedEvents.push(item)
      else needsYou.push(item)
    }
  }

  // Score first; newest first inside a tie; key last so the order is total and
  // two composes over the same state can never disagree.
  needsYou.sort((a, b) => b.score - a.score
    || String(b.at ?? '').localeCompare(String(a.at ?? ''))
    || a.key.localeCompare(b.key))
  snoozedEvents.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))

  // ── UPDATES — recent news through THE notification organizer ───────────────
  // 'update'-tier types only, minus the mirrored ones, inside the window.
  // Grouping (and its exact-duplicate suppression) is groupNotifications' — the
  // same behaviour as the bell, because it IS the bell's code.
  let updates: NotifGroup[] = []
  let updatesUnread = 0
  if (sources.events.ok) {
    const recent = sources.events.rows.filter(n => {
      if (n.archived_at) return false
      if (notifPriority(n.type) !== 'update') return false
      if (MIRRORED_BY_STATE.has(n.type)) return false
      const atMs = Date.parse(n.created_at)
      return Number.isFinite(atMs) && nowMs - atMs <= updateWindowMs
    })
    updates = groupNotifications(recent).activity
    updatesUnread = updates.reduce((s, g) => s + g.unread, 0)
  }

  return {
    needsYou,
    snoozedEvents,
    updates,
    failures,
    counts: { needsYou: needsYou.length, updatesUnread },
    allClear: needsYou.length === 0 && failures.length === 0,
  }
}
