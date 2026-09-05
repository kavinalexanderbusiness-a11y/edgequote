// ── Verify: the Owner Inbox composes, never competes — and never lies ────────
//   npm run verify:owner-inbox
//
// WHY THIS SCRIPT EXISTS
// The Inbox answers "when I open EdgeHQ, what genuinely needs me?" by COMPOSING
// the engines that already exist (the Session-13 priority queue, the deposit
// gate, planDay, the notification organizer). That design creates exactly four
// ways to rot, and each has already burned this codebase somewhere else:
//   · a SECOND derivation appearing beside a canonical one and drifting,
//   · a resolved situation leaving a stale item behind (a notification
//     graveyard), or an unresolved one being hidden forever (snooze-as-dismiss),
//   · one underlying action rendered as two items (the double-count the
//     priority queue spent a session removing),
//   · a failed read wearing the celebration state ("all caught up" over an
//     outage — the false-all-clear audit's whole subject).
// This guard drives the REAL composition over fixed-clock fixtures for every
// scenario the spec names, pins the loader/page wiring statically, and then
// mutates the engine to prove each load-bearing predicate is actually load-
// bearing. Live halves are deliberately absent: composition is pure, and the
// sources it composes each have their own guard (verify:priority-queue,
// verify:deposit-scheduling, verify:day-plan, verify:crew-messages…).

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import {
  composeInbox, MIRRORED_BY_STATE, SOURCE_LABELS,
  type InboxItem, type InboxSources, type SourceResult, type ChangeOrderRow,
  type CrewUnreadRow, type DayPlanRow,
} from '../src/lib/inbox'
import { computePriorities, type Priority, type PriorityInvoice } from '../src/lib/dashboard/priorities'
import { notifPriority, tomorrow8am } from '../src/lib/notifications'
import { planDay } from '../src/lib/dayPlan'
import { settingsToSeasons } from '../src/lib/seasons'
import type { LeadResponseReport } from '../src/lib/leadResponse'
import type { AppNotification } from '../src/components/notifications/NotificationBell'
import type { Quote } from '../src/types'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail = '') => { failures++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// ── Fixed clock ──────────────────────────────────────────────────────────────
const TODAY = '2026-08-15'
const NOW = new Date('2026-08-15T15:00:00')
const iso = (daysAgo: number, hour = 9) => {
  const d = new Date(NOW)
  d.setDate(d.getDate() - daysAgo)
  d.setHours(hour, 0, 0, 0)
  return d.toISOString()
}
const NO_LEADS: LeadResponseReport = { items: [], total: 0, bySource: { website: 0, reply: 0, booking: 0 }, oldestHours: null }

// ── Fixtures ─────────────────────────────────────────────────────────────────
const quote = (q: Partial<Quote>): Quote => ({
  id: 'q1', customer_id: 'c1', customer_name: 'Sarah Brown', status: 'accepted',
  total: 100, service_type: 'Mowing', created_at: iso(20),
  ...q,
} as Quote)

const inv = (i: Partial<PriorityInvoice>): PriorityInvoice => ({
  amount: 100, status: 'unpaid', amount_paid: 0,
  invoice_number: 'INV-0001', customer_name: 'Sarah Brown', due_date: null,
  ...i,
})

const notif = (n: Partial<AppNotification>): AppNotification => ({
  id: 'n1', created_at: iso(1), type: 'invoice_paid', title: 'Invoice paid',
  body: null, href: null, read: false,
  ...n,
} as AppNotification)

const co = (c: Partial<ChangeOrderRow>): ChangeOrderRow => ({
  id: 'co1', jobId: 'j9', status: 'draft', coNumber: 'CO-0001',
  amount: 250, customerName: 'Mike Johnson', createdAt: iso(2),
  ...c,
})

const crew = (c: Partial<CrewUnreadRow>): CrewUnreadRow => ({
  jobId: 'j5', unread: 2, title: 'Weekly mow', customerName: 'Sarah Brown', scheduledDate: TODAY,
  ...c,
})

// Day fixtures go THROUGH planDay — the real engine judges, this guard never
// writes its own warning objects, so a change to planDay's vocabulary lands
// here as a fixture failure instead of a silent divergence.
function dayVia(date: string, plan: Parameters<typeof planDay>[0]): DayPlanRow {
  const p = planDay(plan)
  return { date, stops: p.stopCount, warnings: p.warnings }
}
const overbookedDay = (date: string): DayPlanRow => dayVia(date, {
  // 3 × 4h solo visits into an 8h day with 1 worker → labour over: blocking.
  stops: [1, 2, 3].map(n => ({ jobId: `j${n}`, durationMinutes: 240, crewSize: 1, status: 'scheduled', located: false })),
  startTime: '08:00', capacityHours: 8, workers: 1, hasBase: false,
})
const crewShortDay = (date: string): DayPlanRow => dayVia(date, {
  stops: [{ jobId: 'j1', durationMinutes: 60, crewSize: 3, status: 'scheduled', located: false }],
  startTime: '08:00', capacityHours: 8, workers: 1, hasBase: false,
})
const caveatOnlyDay = (date: string): DayPlanRow => dayVia(date, {
  // One easy visit, workforce unknown → caveats only, nothing blocking.
  stops: [{ jobId: 'j1', durationMinutes: 60, crewSize: 1, status: 'scheduled', located: false }],
  startTime: '08:00', capacityHours: 8, workers: null, hasBase: false,
})

const src = <T,>(rows: T[]): SourceResult<T> => ({ ok: true, rows })
const down = <T,>(): SourceResult<T> => ({ ok: false, error: 'read failed' })

function queue(over: Partial<Parameters<typeof computePriorities>[0]>): Priority[] {
  return computePriorities({
    quotes: [], invoices: [], jobs: [], recById: {}, customers: [],
    conversations: [], requests: [], leads: NO_LEADS, seasons: settingsToSeasons(null),
    feeSettings: null, today: TODAY, limit: 50,
    ...over,
  })
}

function compose(over: Partial<InboxSources>, opts?: { now?: Date }) {
  const sources: InboxSources = {
    work: src<Priority>([]), changeOrders: src<ChangeOrderRow>([]),
    crew: src<CrewUnreadRow>([]), dayPlan: src<DayPlanRow>([]), events: src<AppNotification>([]),
    ...over,
  }
  return composeInbox({ sources, now: opts?.now ?? NOW, todayISO: TODAY })
}
const item = (items: InboxItem[], kind: string) => items.find(i => i.kind === kind)

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 1. Every scenario the spec names produces its item — with the right door ═══')
{
  // New lead → the queue's leads row, carrying the lead's own href.
  const leads: LeadResponseReport = {
    items: [{ key: 'w-c2', source: 'website', customerId: 'c2', name: 'Mike Johnson', at: iso(0, 8), href: '/dashboard/messages?f=website_lead' }],
    total: 1, bySource: { website: 1, reply: 0, booking: 0 }, oldestHours: 7,
  } as unknown as LeadResponseReport
  const r = compose({ work: src(queue({ leads })) })
  const lead = item(r.needsYou, 'leads')
  check('a new lead needs you', !!lead && /Respond to Mike Johnson/.test(lead.label), lead?.label ?? 'no leads item')
  eq('…and opens the lead, not a list', lead?.href, '/dashboard/messages?f=website_lead')
}
{
  // Follow-up due → quote sent 10 days ago, reachable customer.
  const rows = queue({
    quotes: [quote({ id: 'qF', status: 'sent', sent_at: iso(10), customer_id: 'c1', total: 400 })],
    customers: [{ id: 'c1', phone: '+14035550100', email: null, sms_opt_in: true, email_opt_in: true, message_prefs: null } as never],
  })
  const r = compose({ work: src(rows) })
  const fu = item(r.needsYou, 'followups')
  check('a quiet sent quote needs a follow-up', !!fu, 'no followups item')
  eq('…and opens THAT quote', fu?.href, '/dashboard/quotes/qF')
}
{
  // Quote drafted → the owner's own unfinished draft; a fresh SENT quote is
  // honest silence (wait is a real answer, not an inbox item).
  const r = compose({ work: src(queue({ quotes: [
    quote({ id: 'qD', status: 'draft', customer_name: 'Sarah Brown', total: 900, created_at: iso(3) }),
    quote({ id: 'qS', status: 'sent', sent_at: iso(0), customer_id: 'c9' }),
  ] })) })
  const d = item(r.needsYou, 'quote_drafts')
  check('a draft quote needs finishing', !!d && /Finish Sarah Brown/.test(d.label), d?.label ?? 'no quote_drafts item')
  eq('…and opens THAT draft', d?.href, '/dashboard/quotes/qD')
  check('a freshly-sent quote produces NOTHING — wait is a real answer',
    !item(r.needsYou, 'followups'),
    'a nudge invented for a quote sent this morning teaches the owner to ignore the queue')
}
{
  // Accepted + unscheduled, all three gate states.
  const accepted = quote({ id: 'qA', status: 'accepted', customer_name: 'Sarah Brown', total: 1000 })
  const gated = { ...accepted, deposit_type: 'percent', deposit_value: 25, accepted_price: 1000 } as Quote
  const ready = compose({ work: src(queue({ quotes: [accepted] })) })
  const readyRow = item(ready.needsYou, 'unscheduled')
  check('accepted-unscheduled needs scheduling', !!readyRow && /Schedule Sarah Brown/.test(readyRow.label), readyRow?.label)
  eq('…and opens the schedule prefilled from THAT quote', readyRow?.href, '/dashboard/schedule?quote=qA')

  const awaiting = compose({ work: src(queue({ quotes: [gated], quoteDepositRows: { qA: [] } })) })
  const waitRow = awaiting.needsYou.find(x => x.kind === 'unscheduled')
  check('deposit awaiting: the row says WAITING, not schedule',
    !!waitRow && /Waiting on Sarah Brown/.test(waitRow.label), waitRow?.label)
  eq('…and opens the quote page (recorder + override live there)', waitRow?.href, '/dashboard/quotes/qA')

  const satisfied = compose({ work: src(queue({
    quotes: [gated],
    quoteDepositRows: { qA: [{ amount: 250, kind: 'payment', provider: 'stripe', status: 'paid' }] },
  })) })
  const schedRow = item(satisfied.needsYou, 'unscheduled')
  check('deposit satisfied: back to schedule-now, saying WHY',
    !!schedRow && /Schedule Sarah Brown/.test(schedRow.label) && /deposit received/.test(schedRow.detail),
    `${schedRow?.label} / ${schedRow?.detail}`)
}
{
  // Customer request → the queue's requests row with the inbox's real filter param.
  const r = compose({ work: src(queue({ requests: [{ customer_id: 'c3' }] })) })
  const req = item(r.needsYou, 'requests')
  check('an open portal request needs answering', !!req, 'no requests item')
  eq("…and opens the messages inbox's requests filter (?f=, never ?filter=)", req?.href, '/dashboard/messages?f=requests')
}
{
  // Change order: a DRAFT is the owner's move; PENDING is the customer's and
  // must not appear (the owner ruling that keeps chase-the-customer out).
  const r = compose({ changeOrders: src([co({}), co({ id: 'co2', status: 'pending' })]) })
  const c = item(r.needsYou, 'change_orders')
  check('a drafted change order needs sending', !!c && /Send Mike Johnson the change order/.test(c.label), c?.label)
  eq('…and opens the visit it belongs to', c?.href, '/dashboard/schedule?job=j9')
  eq('…as ONE item (the pending one is the customer’s move, not yours)', r.needsYou.filter(x => x.kind === 'change_orders').length, 1)
}
{
  // Crew message → one row per visit, each opening its own thread.
  const r = compose({ crew: src([crew({}), crew({ jobId: 'j6', customerName: 'Mike Johnson', unread: 1 }), crew({ jobId: 'j7', unread: 0 })]) })
  const rows = r.needsYou.filter(x => x.kind === 'crew')
  eq('unread crew threads each get a row; a read thread gets none', rows.length, 2)
  check('…and each opens ITS visit', rows.every(x => /^\/dashboard\/schedule\?job=j[56]$/.test(x.href)),
    rows.map(x => x.href).join(', '))
}
{
  // Invoice overdue → urgent; owed-but-not-due → today. The urgency flag is the
  // ENGINE's (ledger overlay), never a date comparison in the inbox.
  const overdue = compose({ work: src(queue({ invoices: [inv({ due_date: '2026-08-01' })] })) })
  eq('overdue money is URGENT', item(overdue.needsYou, 'unpaid')?.section, 'urgent')
  const owed = compose({ work: src(queue({ invoices: [inv({ due_date: '2026-09-01' })] })) })
  eq('owed-but-not-due money is TODAY, not urgent', item(owed.needsYou, 'unpaid')?.section, 'today')
}
{
  // Payment failed → an event item, urgent, with the notification's own door.
  const r = compose({ events: src([notif({ id: 'nf', type: 'payment_failed', title: 'Payment failed', body: 'Autopay for INV-0042 was declined', href: '/dashboard/invoices?invoice=INV-0042' })]) })
  const e = item(r.needsYou, 'payment_event')
  check('a failed payment needs you', !!e && e.section === 'urgent', e && `section=${e.section}`)
  eq('…and opens the invoice it names', e?.href, '/dashboard/invoices?invoice=INV-0042')
  check('…and is dismissable/snoozable (it is the one item kind with a lifecycle)',
    e?.source === 'event' && e?.notificationId === 'nf')
}
{
  // Renewal signal → the queue's reactivation row, upcoming (it can wait a day).
  const hand: Priority = { kind: 'reactivation', label: 'Re-book recurring customers', detail: '2 · $150/visit', href: '/dashboard/reactivation', score: 40_000 }
  const r = compose({ work: src([hand]) })
  eq('a renewal/ran-out signal lands in UPCOMING', item(r.needsYou, 'reactivation')?.section, 'upcoming')
}
{
  // Day-plan conflicts — planDay's own blocking verdicts, near = urgent.
  const r = compose({ dayPlan: src([overbookedDay(TODAY), crewShortDay('2026-08-20'), caveatOnlyDay('2026-08-17')]) })
  const days = r.needsYou.filter(x => x.kind === 'day_conflict')
  eq('blocked days appear; a caveat-only day does not', days.length, 2)
  const near = days.find(x => x.at === TODAY)
  const far = days.find(x => x.at === '2026-08-20')
  check('today’s broken plan is URGENT and says so plainly',
    near?.section === 'urgent' && /Fix today’s schedule/.test(near?.label ?? ''), `${near?.section} / ${near?.label}`)
  check('a conflict days out is UPCOMING (real, not an emergency)', far?.section === 'upcoming', far?.section)
  check('…and each opens the schedule ON that day', days.every(x => x.href === `/dashboard/schedule?d=${x.at}`),
    days.map(x => x.href).join(', '))
  check('the reason line is planDay’s own sentence, not a re-derivation',
    /people|worker|hour|capacity|blocked/i.test(near?.detail ?? ''), near?.detail)
}

console.log('\n═══ 2. Auto-resolution: the canonical state changing IS the resolution ═══')
{
  // The same situations as §1, one state change later → the item is GONE, with
  // no residue to dismiss. This is the no-graveyard property.
  const scheduled = compose({ work: src(queue({
    quotes: [quote({ id: 'qA', status: 'accepted' })],
    jobs: [{ id: 'j1', quote_id: 'qA', customer_id: 'c1', status: 'scheduled', scheduled_date: '2026-08-20', recurrence_id: null, price: null, service_type: null } as never],
  })) })
  check('scheduling the accepted quote dissolves its item', !item(scheduled.needsYou, 'unscheduled'))

  const handled = compose({ work: src(queue({ requests: [] })) })
  check('handling the request dissolves its item', !item(handled.needsYou, 'requests'))

  const paid = compose({ work: src(queue({ invoices: [inv({ status: 'paid', amount_paid: 100 })] })) })
  check('paying the invoice dissolves the money item', !item(paid.needsYou, 'unpaid'))

  const sent = compose({ changeOrders: src([co({ status: 'pending' })]) })
  check('sending the change order dissolves its item', !item(sent.needsYou, 'change_orders'))

  const readThread = compose({ crew: src([crew({ unread: 0 })]) })
  check('reading the crew thread dissolves its item', !item(readThread.needsYou, 'crew'))

  const fixedDay = compose({ dayPlan: src([caveatOnlyDay(TODAY)]) })
  check('rebalancing the day dissolves its conflict', !item(fixedDay.needsYou, 'day_conflict'))
}

console.log('\n═══ 3. One action, one item — dedup across the state/event line ═══')
{
  // A crew_message NOTIFICATION beside the derived crew row: one item, and the
  // event is not smuggled into updates either.
  const r = compose({
    crew: src([crew({})]),
    events: src([notif({ id: 'nc', type: 'crew_message', title: 'Crew message', href: '/dashboard/schedule?job=j5' })]),
  })
  eq('crew: derived row owns it — one item total', r.needsYou.filter(x => x.kind === 'crew' || x.key === 'n:nc').length, 1)
  check('…and the mirrored event is not in updates', !r.updates.some(g => g.type === 'crew_message'))

  const r2 = compose({
    work: src(queue({ requests: [{ customer_id: 'c3' }] })),
    events: src([notif({ id: 'np', type: 'portal_request', title: 'New request' })]),
  })
  eq('requests: derived row owns it — one item total',
    r2.needsYou.filter(x => x.kind === 'requests' || x.key === 'n:np').length, 1)
  check('…and portal_request is not in updates', !r2.updates.some(g => g.type === 'portal_request'))

  // quote_accepted + the schedule item is the one DELIBERATE pair: the event is
  // news ("they said yes"), the state item is work ("book it") — the spec's own
  // example. Assert both exist so nobody "fixes" it into a dedup bug later.
  const r3 = compose({
    work: src(queue({ quotes: [quote({ id: 'qA', status: 'accepted' })] })),
    events: src([notif({ id: 'na', type: 'quote_accepted', title: 'Quote accepted' })]),
  })
  check('quote accepted: news in updates AND work in needs-you — by design',
    !!item(r3.needsYou, 'unscheduled') && r3.updates.some(g => g.type === 'quote_accepted'))

  // Booking-created drafts are leads, not quote drafts — never both.
  const booked = queue({ quotes: [quote({ id: 'qB', status: 'draft', lead_meta: { source: 'booking' } })] })
  check('a booking draft is a LEAD’s door, never a quote_drafts row',
    !booked.some(p => p.kind === 'quote_drafts'),
    'counting it twice tells the owner to do one thing twice — the exact bug the leads row fixed')
}

console.log('\n═══ 4. Snooze: later means later — never never ═══')
{
  const active = notif({ id: 'ns', type: 'payment_failed', title: 'Payment failed', snoozed_until: new Date(NOW.getTime() + 3600_000).toISOString() })
  const r = compose({ events: src([active]) })
  check('an actively-snoozed event leaves the list', !r.needsYou.some(x => x.key === 'n:ns'))
  check('…into the visible snoozed shelf, not oblivion', r.snoozedEvents.some(x => x.key === 'n:ns'))
  eq('…and the count excludes it (count = what is actually asking)', r.counts.needsYou, 0)

  const expired = notif({ id: 'ns', type: 'payment_failed', title: 'Payment failed', snoozed_until: new Date(NOW.getTime() - 60_000).toISOString() })
  const r2 = compose({ events: src([expired]) })
  check('an EXPIRED snooze reappears — snooze is not dismiss', r2.needsYou.some(x => x.key === 'n:ns'))

  // Derived items have no snooze by design; their absence of a notificationId
  // is what the UI keys the controls off.
  const r3 = compose({ work: src(queue({ invoices: [inv({})] })) })
  check('derived items carry no snooze lifecycle — the door is the resolution',
    r3.needsYou.every(x => x.source === 'event' || x.notificationId === undefined))
}

console.log('\n═══ 5. Counts and windows: the number is the truth ═══')
{
  const r = compose({
    work: src(queue({ invoices: [inv({})] })),
    changeOrders: src([co({})]),
    events: src([
      notif({ id: 'e1', type: 'payment_failed', title: 'Payment failed' }),
      notif({ id: 'e2', type: 'invoice_paid', title: 'Invoice paid', read: true }),
      notif({ id: 'e3', type: 'quote_accepted', title: 'Quote accepted' }),
    ]),
  })
  eq('needsYou count IS the list length — no second bookkeeping', r.counts.needsYou, r.needsYou.length)
  eq('updates unread counts only unread updates', r.counts.updatesUnread, 1)

  const stale = compose({ events: src([notif({ id: 'old', type: 'payment_failed', title: 'Payment failed', created_at: iso(31) })]) })
  check('an action event older than the window stays in the bell, not here',
    !stale.needsYou.some(x => x.key === 'n:old'),
    'an unbounded needs-you feed is the notification graveyard the spec forbids')
  const oldNews = compose({ events: src([notif({ id: 'on', type: 'invoice_paid', title: 'Invoice paid', created_at: iso(8) })]) })
  check('updates keep a week, not a lifetime', !oldNews.updates.some(g => g.ids.includes('on')))
}

console.log('\n═══ 6. Failure honesty: a failed source is an answer, not a zero ═══')
{
  const r = compose({ work: down<Priority>(), changeOrders: src([co({})]) })
  check('the failed source is NAMED', r.failures.includes(SOURCE_LABELS.work), r.failures.join(', '))
  check('healthy sources still answer', !!item(r.needsYou, 'change_orders'),
    'one outage must not take down the four working sources')
  check('allClear refuses to celebrate over a failed read', !compose({ work: down<Priority>() }).allClear,
    '"all caught up" over an outage is the confident lie the trust audits exist for')
  check('a clean empty inbox IS all clear', compose({}).allClear)
  eq('every source has a banner name', Object.keys(SOURCE_LABELS).length, 5)
}

console.log('\n═══ 7. Copy discipline: say WHAT, name WHO ═══')
{
  const r = compose({
    work: src(queue({ invoices: [inv({ due_date: '2026-08-01' })], requests: [{ customer_id: 'c3' }] })),
    changeOrders: src([co({})]),
    crew: src([crew({})]),
    dayPlan: src([overbookedDay(TODAY)]),
    events: src([notif({ id: 'nf', type: 'payment_failed', title: 'Payment failed' })]),
  })
  check('every item has an action sentence and a door', r.needsYou.every(x => x.label.length > 0 && x.href.startsWith('/dashboard')))
  check('no item is a vague shrug', r.needsYou.every(x => !/attention needed|action required/i.test(x.label)),
    'the spec bans "Attention needed" — say what, name who')
  check('urgent is a tier, not the whole list', r.needsYou.some(x => x.section !== 'urgent'),
    'classifying everything urgent teaches the owner that urgent means nothing')
  check('the order is total and deterministic (score, then recency, then key)',
    JSON.stringify(r.needsYou.map(x => x.key)) === JSON.stringify(compose({
      work: src(queue({ invoices: [inv({ due_date: '2026-08-01' })], requests: [{ customer_id: 'c3' }] })),
      changeOrders: src([co({})]), crew: src([crew({})]), dayPlan: src([overbookedDay(TODAY)]),
      events: src([notif({ id: 'nf', type: 'payment_failed', title: 'Payment failed' })]),
    }).needsYou.map(x => x.key)))
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 8. The wiring: one engine, one count, honest pages ═══')
{
  const ENGINE = read('src/lib/inbox.ts')
  check('the action tier comes from notifPriority — no second type list',
    /notifPriority\(n\.type\)/.test(ENGINE) && !/payment_failed/.test(ENGINE),
    'the day a type is reclassified in lib/notifications, a local list here would silently disagree')
  check('the mirrored-type dedup is declared once, as data',
    MIRRORED_BY_STATE.has('website_lead') && MIRRORED_BY_STATE.has('portal_request')
    && MIRRORED_BY_STATE.has('new_message') && MIRRORED_BY_STATE.has('crew_message'))
  check('notifPriority still calls those four types non-action (mirroring stays sound)',
    [...MIRRORED_BY_STATE].every(t => notifPriority(t) !== 'action'),
    'if one becomes action-tier, MIRRORED_BY_STATE would silently hide a needs-you item')

  const LOADER = read('src/lib/inboxData.ts')
  // Tenancy per READ BLOCK, not a file-wide count — a count is satisfied by any
  // stray mention (the lesson verify-day-suggestions paid for).
  const blocks = LOADER.split(/\bsb\.from\(/).slice(1)
  check(`every one of the loader's ${blocks.length} reads is tenant-scoped where it is written`,
    blocks.length >= 12 && blocks.every(b => b.slice(0, 400).includes(".eq('user_id', userId)")),
    'RLS also holds, but the explicit filter is load-bearing the day a service-role client appears')
  check('the loader reuses THE unread derivation and THE day engine',
    /loadOwnerUnread\(/.test(LOADER) && /planDay\(/.test(LOADER) && /loadDayFitContext\(/.test(LOADER))
  check('the loader never widens the draft filter client-side',
    /\.eq\('status', 'draft'\)/.test(LOADER))
  check('nothing in the inbox writes: no updates, deletes or inserts in the loader',
    !/\.update\(|\.delete\(|\.insert\(/.test(LOADER), 'the inbox is a reader — writes belong to the doors it opens')

  const PAGE = read('src/app/dashboard/inbox/page.tsx')
  check('the page renders the loader’s composition — no queries of its own',
    /loadOwnerInbox\(/.test(PAGE) && !/\.from\(/.test(PAGE))
  check('the page shows the degraded banner from result.failures',
    /result\.failures/.test(PAGE) && /Couldn’t check/.test(PAGE))
  check('the empty state defers to allClear (never celebrates a failed read)',
    /allClear=\{result\.allClear\}/.test(PAGE))

  const DASH = read('src/app/dashboard/page.tsx')
  check('the dashboard preview composes with THE engine over the SAME queue rows',
    /composeInbox\(\{/.test(DASH) && /work: \{ ok: true, rows: d\.priorities \}/.test(DASH))
  check('the preview count is the composition’s own count',
    /count=\{inbox\.counts\.needsYou\}/.test(DASH), 'a re-derived count is the stale-counter bug')
  check('the preview is a slice, not a replica', /slice\(0, PREVIEW_ROWS\)/.test(DASH))

  const DATA = read('src/lib/dashboard/data.ts')
  check('the queue feeding the composition is uncapped in effect', /limit: 50/.test(DATA),
    'a capped queue makes the dashboard count quietly smaller than the inbox it links to')

  const CARD = read('src/components/dashboard/TodaysPriorities.tsx')
  check('a degraded empty preview never wears the celebration',
    /degradedEmpty/.test(CARD) && CARD.indexOf('degradedEmpty ?') < CARD.indexOf('You&rsquo;re all caught up'))

  const MODULES = read('src/lib/modules.ts')
  check('the Inbox is registered (sidebar + ⌘K render FROM the registry)',
    /key: 'inbox'/.test(MODULES) && /href: '\/dashboard\/inbox'/.test(MODULES))

  const SCHED = read('src/app/dashboard/schedule/page.tsx')
  check('the schedule’s day door exists and validates its input',
    /searchParams\.get\('d'\)/.test(SCHED) && /\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/.test(SCHED))
  check('the day door only MOVES the cursor — it opens and edits nothing',
    (() => {
      const eff = SCHED.slice(SCHED.indexOf("// Day deep link (?d=YYYY-MM-DD)"), SCHED.indexOf('}, [dayParam])'))
      return eff.length > 0 && /setCursor\(/.test(eff) && !/setEditing|setShowForm/.test(eff)
    })(), 'a stale day link that opens a form is how a glance becomes an accidental edit')

  const ACTIONS = read('src/components/inbox/EventItemActions.tsx')
  check('dismiss archives — the record stays on file', /archived_at/.test(ACTIONS) && !/\.delete\(/.test(ACTIONS))
  check('snooze/dismiss branch on the write’s own error before moving on',
    /if \(error\)/.test(ACTIONS), 'a failed snooze that looks snoozed is the undo-contract bug')

  // ── One snooze vocabulary ──────────────────────────────────────────────────
  // "Remind me later" is offered on two surfaces. It used to be implemented
  // twice, identically, with the copy documenting itself as a copy — nothing
  // failed if one drifted, so the owner could get two different answers to the
  // same word. These pin the single definition AND its local-time meaning.
  const NOTIF_LIB = read('src/lib/notifications.ts')
  const PAGE_SRC = read('src/app/dashboard/notifications/page.tsx')
  const declares = (s: string) => /(?:function|const)\s+tomorrow8am\b/.test(s)
  check('the snooze rule is declared exactly once, in the organizer',
    declares(NOTIF_LIB) && !declares(ACTIONS) && !declares(PAGE_SRC),
    'two copies of “tomorrow 8am” can drift into two different promises')
  check('…and both surfaces call that one definition',
    /import \{[^}]*\btomorrow8am\b[^}]*\} from '@\/lib\/notifications'/.test(ACTIONS) &&
    /import \{[^}]*\btomorrow8am\b[^}]*\} from '@\/lib\/notifications'/.test(PAGE_SRC) &&
    /tomorrow8am\(\)/.test(ACTIONS) && /tomorrow8am\(\)/.test(PAGE_SRC))

  // Executed, not read: the promise is 8am in the OWNER’S morning. A UTC-based
  // implementation passes every source regex above and still wakes a Kolkata
  // owner at 1:30pm, so each zone is checked in a child process with a real TZ.
  const ZONES = ['America/Edmonton', 'Asia/Kolkata', 'Pacific/Chatham', 'Australia/Lord_Howe', 'UTC']
  // A probe FILE, not `tsx -e`: on Windows spawnSync needs shell:true to find
  // npx, and the shell then mangles inline code containing quotes/newlines.
  const probePath = join(process.cwd(), `.tomorrow8am-probe.${process.pid}.ts`)
  writeFileSync(probePath, [
    "import { tomorrow8am } from './src/lib/notifications'",
    'const d = new Date(tomorrow8am())',
    'const t = new Date(); t.setDate(t.getDate() + 1)',
    'console.log(JSON.stringify({ h: d.getHours(), m: d.getMinutes(), s: d.getSeconds(),',
    '  ms: d.getMilliseconds(), sameDay: d.getFullYear() === t.getFullYear() &&',
    '  d.getMonth() === t.getMonth() && d.getDate() === t.getDate() }))',
  ].join('\n'))
  let zoneResults: { tz: string; h: number; m: number; s: number; ms: number; sameDay: boolean }[] = []
  try {
    zoneResults = ZONES.map(tz => {
      const r = spawnSync('npx', ['tsx', probePath], {
        cwd: process.cwd(), encoding: 'utf8', shell: process.platform === 'win32',
        env: { ...process.env, TZ: tz },
      })
      const line = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || ''
      try { return { tz, ...JSON.parse(line) } } catch { return { tz, h: -1, m: -1, s: -1, ms: -1, sameDay: false } }
    })
  } finally { rmSync(probePath, { force: true }) }
  const localAt8 = (z: { h: number; m: number; s: number; ms: number; sameDay: boolean }) =>
    z.h === 8 && z.m === 0 && z.s === 0 && z.ms === 0 && z.sameDay
  check('snooze lands at 08:00 LOCAL tomorrow in every zone, not 08:00 UTC',
    zoneResults.every(localAt8),
    'zones off: ' + zoneResults.filter(z => !localAt8(z)).map(z => `${z.tz}→${z.h}h`).join(', '))
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 9. Mutations: every load-bearing predicate, proven load-bearing ═══')
{
  const enginePath = join(process.cwd(), 'src/lib/inbox.ts')
  const original = readFileSync(enginePath, 'utf8')
  const srcDir = join(__dirname, '..', 'src').replace(/\\/g, '/')
  const req = createRequire(__filename)

  type Engine = typeof import('../src/lib/inbox')
  const composeWith = (m: Engine, over: Partial<InboxSources>, now = NOW) => m.composeInbox({
    sources: {
      work: src<Priority>([]), changeOrders: src<ChangeOrderRow>([]),
      crew: src<CrewUnreadRow>([]), dayPlan: src<DayPlanRow>([]), events: src<AppNotification>([]),
      ...over,
    }, now, todayISO: TODAY,
  })

  const mutations: { name: string; from: string; to: string; wrong: (m: Engine) => boolean }[] = [
    {
      name: 'the count stops being the list (stale counter)',
      from: 'counts: { needsYou: needsYou.length, updatesUnread },',
      to: 'counts: { needsYou: needsYou.length + snoozedEvents.length, updatesUnread },',
      wrong: m => {
        const r = composeWith(m, { events: src([notif({ id: 'ns', type: 'payment_failed', title: 'x', snoozed_until: new Date(NOW.getTime() + 3600_000).toISOString() })]) })
        return r.counts.needsYou !== r.needsYou.length
      },
    },
    {
      name: 'snooze becomes dismiss (never comes back)',
      from: 'if (snoozedUntil != null && snoozedUntil > nowMs) snoozedEvents.push(item)',
      to: 'if (snoozedUntil != null) snoozedEvents.push(item)',
      wrong: m => !composeWith(m, { events: src([notif({ id: 'ns', type: 'payment_failed', title: 'x', snoozed_until: new Date(NOW.getTime() - 60_000).toISOString() })]) })
        .needsYou.some(x => x.key === 'n:ns'),
    },
    {
      name: 'the mirror dedup disappears (one action, two items)',
      from: "export const MIRRORED_BY_STATE = new Set(['website_lead', 'portal_request', 'new_message', 'crew_message'])",
      to: 'export const MIRRORED_BY_STATE = new Set<string>([])',
      wrong: m => composeWith(m, { events: src([notif({ id: 'nc', type: 'crew_message', title: 'x' })]) })
        .updates.some(g => g.type === 'crew_message'),
    },
    {
      name: 'a pending change order becomes the owner’s problem',
      from: "const drafts = sources.changeOrders.rows.filter(c => c.status === 'draft')",
      to: "const drafts = sources.changeOrders.rows.filter(c => c.status !== 'approved')",
      wrong: m => composeWith(m, { changeOrders: src([co({ status: 'pending' })]) })
        .needsYou.some(x => x.kind === 'change_orders'),
    },
    {
      name: 'caveats get shouted as conflicts (noise floor collapses)',
      from: "const blocking = d.warnings.filter(w => w.severity === 'blocking')",
      to: 'const blocking = d.warnings',
      wrong: m => composeWith(m, { dayPlan: src([caveatOnlyDay(TODAY)]) })
        .needsYou.some(x => x.kind === 'day_conflict'),
    },
    {
      name: 'all-clear celebrates over a failed read',
      from: 'allClear: needsYou.length === 0 && failures.length === 0,',
      to: 'allClear: needsYou.length === 0,',
      wrong: m => composeWith(m, { work: down<Priority>() }).allClear === true,
    },
    {
      name: 'the crew door opens the wrong surface',
      from: 'href: `/dashboard/schedule?job=${encodeURIComponent(r.jobId)}`,',
      to: 'href: `/dashboard/schedule`,',
      wrong: m => composeWith(m, { crew: src([crew({})]) })
        .needsYou.find(x => x.kind === 'crew')?.href === '/dashboard/schedule',
    },
    {
      name: 'the needs-you event window falls off (graveyard returns)',
      from: 'if (!Number.isFinite(atMs) || nowMs - atMs > eventWindowMs) continue',
      to: 'if (!Number.isFinite(atMs)) continue',
      wrong: m => composeWith(m, { events: src([notif({ id: 'old', type: 'payment_failed', title: 'x', created_at: iso(31) })]) })
        .needsYou.some(x => x.key === 'n:old'),
    },
    {
      name: 'archived events rise from the dead',
      from: 'if (n.archived_at) continue',
      to: 'if (false) continue',
      wrong: m => composeWith(m, { events: src([notif({ id: 'na', type: 'payment_failed', title: 'x', archived_at: iso(1) })]) })
        .needsYou.some(x => x.key === 'n:na'),
    },
  ]

  for (const m of mutations) {
    if (!original.includes(m.from)) {
      fail(`mutation "${m.name}" could not be applied`,
        `the anchor text is no longer in src/lib/inbox.ts, so this mutation tests nothing:\n      ${m.from}`)
      continue
    }
    const mutated = original.replace(m.from, m.to)
    if (mutated === original) {
      fail(`mutation "${m.name}" changed nothing`, 'the replacement is identical to the original')
      continue
    }
    const dir = mkdtempSync(join(tmpdir(), 'inbox-mutant-'))
    const file = join(dir, 'inbox.ts')
    writeFileSync(file, mutated.replace(/from '@\/([^']+)'/g, (_x, p) => `from '${srcDir}/${p}'`), 'utf8')
    let observed: boolean
    try {
      observed = m.wrong(req(file) as Engine)
    } catch {
      observed = true
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    check(`caught: ${m.name}`, observed,
      'the mutant produced the SAME answer as the real engine — the predicate it targets is not load-bearing')
  }

  // The tenancy checker itself must not be decoration: strip one scope from a
  // COPY of the loader text and re-run the same per-block analysis — it must
  // flag. Stripped AFTER the first real read, not with a bare replace: the
  // loader's own header comment quotes the filter, and a bare replace eats the
  // quotation while every actual read keeps its scope — a mutation that didn't
  // apply looks exactly like a checker that failed.
  const LOADER = read('src/lib/inboxData.ts')
  const firstRead = LOADER.indexOf('sb.from(')
  const strippedOnce = LOADER.slice(0, firstRead) + LOADER.slice(firstRead).replace(".eq('user_id', userId)", '')
  const analyse = (text: string) => text.split(/\bsb\.from\(/).slice(1)
    .every(b => b.slice(0, 400).includes(".eq('user_id', userId)"))
  check('caught: a read losing its tenant scope', analyse(LOADER) && !analyse(strippedOnce),
    'the per-block tenancy check would miss a stripped scope — it is decoration')
}

// ── Result ───────────────────────────────────────────────────────────────────
if (failures) {
  console.log(`\n❌ verify:owner-inbox — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:owner-inbox — composed from the canonical engines, honest about every source, and nothing needs the owner twice\n')
