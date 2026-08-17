// ── Owner Inbox measurement harness (investigation tool, not a guard) ────────
// Renders the REAL inbox surfaces to static markup — through the REAL composer
// over the REAL queue engine — wraps them in the compiled Tailwind CSS, and
// writes HTML files headless Chrome can lay out and measure
// (scripts/prove-inbox-mobile.mjs). Class-name greps cannot tell you whether a
// row overflows 375px; only layout can.
//
// Credential-free by design: the dashboard requires a session this machine
// cannot mint (Session 62's env policy), so the phone proof measures the real
// component tree with representative composed data instead of a signed-in page.
//
// Usage: npx tsx --tsconfig tsconfig.harness.json scripts/inbox-harness.tsx <outdir>
import { renderToStaticMarkup } from 'react-dom/server'
import { writeFileSync, readdirSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { composeInbox, type InboxSources, type SourceResult, type ChangeOrderRow, type CrewUnreadRow, type DayPlanRow } from '../src/lib/inbox'
import { computePriorities, type Priority, type PriorityInvoice } from '../src/lib/dashboard/priorities'
import { planDay } from '../src/lib/dayPlan'
import { settingsToSeasons } from '../src/lib/seasons'
import type { LeadResponseReport } from '../src/lib/leadResponse'
import type { AppNotification } from '../src/components/notifications/NotificationBell'
import type { Quote } from '../src/types'
import { InboxNeedsYou } from '../src/components/inbox/InboxNeedsYou'
import { InboxUpdates } from '../src/components/inbox/InboxUpdates'
import { TodaysPriorities } from '../src/components/dashboard/TodaysPriorities'

const outdir = process.argv[2] || '.inbox-harness'
mkdirSync(outdir, { recursive: true })

const cssDir = '.next/static/css'
const css = readdirSync(cssDir).filter(f => f.endsWith('.css'))
  .map(f => readFileSync(join(cssDir, f), 'utf8')).join('\n')

// ── The same fixture grammar as verify-owner-inbox, at display scale ─────────
const TODAY = '2026-08-15'
const NOW = new Date('2026-08-15T15:00:00')
const iso = (daysAgo: number, hour = 9) => {
  const d = new Date(NOW); d.setDate(d.getDate() - daysAgo); d.setHours(hour, 0, 0, 0); return d.toISOString()
}
const quote = (q: Partial<Quote>): Quote => ({
  id: 'q1', customer_id: 'c1', customer_name: 'Sarah Brown', status: 'accepted',
  total: 100, service_type: 'Mowing', created_at: iso(20),
  ...q,
} as Quote)
const inv = (i: Partial<PriorityInvoice>): PriorityInvoice => ({
  amount: 100, status: 'unpaid', amount_paid: 0,
  invoice_number: 'INV-0001', customer_name: 'Sarah Brown', due_date: null, ...i,
})
const notif = (n: Partial<AppNotification>): AppNotification => ({
  id: 'n1', created_at: iso(1), type: 'invoice_paid', title: 'Invoice paid',
  body: null, href: null, read: false, ...n,
} as AppNotification)
const src = <T,>(rows: T[]): SourceResult<T> => ({ ok: true, rows })

const LEADS: LeadResponseReport = {
  items: [{ key: 'w-c2', source: 'website', customerId: 'c2', name: 'Mike Johnson', at: iso(0, 8), href: '/dashboard/messages?f=website_lead' }],
  total: 3, bySource: { website: 2, reply: 1, booking: 0 }, oldestHours: 7,
} as unknown as LeadResponseReport

const work: Priority[] = computePriorities({
  quotes: [
    quote({ id: 'qA', status: 'accepted', customer_name: 'Constantinopoulos Property Management Ltd.', total: 4890, service_type: 'Full landscaping refresh' }),
    quote({ id: 'qW', status: 'accepted', customer_name: 'Priya Ramachandran-Oyelaran', total: 2100, deposit_type: 'percent', deposit_value: 25, accepted_price: 2100 } as Partial<Quote>),
    quote({ id: 'qD', status: 'draft', customer_name: 'Sarah Brown', total: 960, created_at: iso(4) }),
    quote({ id: 'qF', status: 'sent', customer_name: 'Bob Chen', sent_at: iso(9), customer_id: 'c4', total: 445 }),
  ],
  invoices: [
    inv({ invoice_number: 'INV-0224', customer_name: 'Mike Johnson', amount: 1250, due_date: '2026-08-08' }),
    inv({ invoice_number: 'INV-0231', customer_name: 'Jane Smith', amount: 380, due_date: '2026-09-01' }),
    inv({ invoice_number: 'INV-0228', customer_name: 'Sarah Brown', amount: 640, status: 'draft' }),
  ],
  jobs: [{ id: 'jM', quote_id: null, customer_id: 'c9', status: 'scheduled', scheduled_date: '2026-08-12', recurrence_id: null, price: null, service_type: null } as never],
  recById: {}, customers: [{ id: 'c4', phone: '+14035550100', email: null, sms_opt_in: true, email_opt_in: true, message_prefs: null } as never],
  conversations: [{ unread: 2, customer_id: 'c7' }],
  requests: [{ customer_id: 'c3' }],
  leads: LEADS, seasons: settingsToSeasons(null), feeSettings: null, today: TODAY, limit: 50,
  quoteDepositRows: { qW: [{ amount: 200, kind: 'payment', provider: 'stripe', status: 'paid' }] },
})

const dayVia = (date: string, plan: Parameters<typeof planDay>[0]): DayPlanRow => {
  const p = planDay(plan)
  return { date, stops: p.stopCount, warnings: p.warnings }
}
const SOURCES: InboxSources = {
  work: src(work),
  changeOrders: src<ChangeOrderRow>([
    { id: 'co1', jobId: 'j9', status: 'draft', coNumber: 'CO-0003', amount: 575, customerName: 'Mike Johnson', createdAt: iso(2) },
  ]),
  crew: src<CrewUnreadRow>([
    { jobId: 'j5', unread: 2, title: 'Weekly mow', customerName: 'Sarah Brown', scheduledDate: TODAY },
    { jobId: 'j6', unread: 1, title: 'Hedge trim — backyard and front beds', customerName: 'Constantinopoulos Property Management Ltd.', scheduledDate: '2026-08-16' },
  ]),
  dayPlan: src<DayPlanRow>([
    dayVia(TODAY, {
      stops: [1, 2, 3].map(n => ({ jobId: `j${n}`, durationMinutes: 240, crewSize: 1, status: 'scheduled', located: false })),
      startTime: '08:00', capacityHours: 8, workers: 1, hasBase: false,
    }),
    // A conflict days out — renders the Upcoming section (its real producer).
    dayVia('2026-08-20', {
      stops: [{ jobId: 'jx', durationMinutes: 90, crewSize: 3, status: 'scheduled', located: false }],
      startTime: '08:00', capacityHours: 8, workers: 1, hasBase: false,
    }),
  ]),
  events: src<AppNotification>([
    notif({ id: 'nf', type: 'payment_failed', title: 'Autopay failed for INV-0219', body: 'Card declined — the balance of $431.55 is still owed.', href: '/dashboard/invoices?invoice=INV-0219', created_at: iso(0, 7) }),
    notif({ id: 'nsz', type: 'autopay_review', title: 'Autopay held for review', body: 'INV-0230 charge paused pending your review.', snoozed_until: new Date(NOW.getTime() + 12 * 3600_000).toISOString(), created_at: iso(1) }),
    notif({ id: 'u1', type: 'quote_accepted', title: 'Quote accepted', body: 'Priya approved the $2,100 landscaping quote.', href: '/dashboard/quotes/qW', created_at: iso(0, 11) }),
    notif({ id: 'u2', type: 'quote_accepted', title: 'Quote accepted', body: 'Constantinopoulos PM approved the refresh.', created_at: iso(1) }),
    notif({ id: 'u3', type: 'invoice_paid', title: 'Invoice paid', body: 'Jane Smith paid INV-0212 — $380.00.', href: '/dashboard/invoices?invoice=INV-0212', created_at: iso(2), read: true }),
    notif({ id: 'u4', type: 'review_received', title: 'New 5-star review', body: '“Crew was fantastic, lawn looks great.”', created_at: iso(3), read: true }),
    notif({ id: 'u5', type: 'change_order_approved', title: 'Change approved', body: 'Mike approved CO-0002 (+$575).', created_at: iso(4), read: true }),
  ]),
}

const FULL = composeInbox({ sources: SOURCES, now: NOW, todayISO: TODAY })
const EMPTY = composeInbox({
  sources: { work: src<Priority>([]), changeOrders: src([]), crew: src([]), dayPlan: src([]), events: src([]) },
  now: NOW, todayISO: TODAY,
})
const DEGRADED = composeInbox({
  sources: { ...SOURCES, work: { ok: false, error: 'fetch failed' }, dayPlan: { ok: false, error: 'fetch failed' } },
  now: NOW, todayISO: TODAY,
})

// The inbox page's own structure (page.tsx renders exactly this shape) — the
// real components at the real widths, minus the app shell it cannot have here.
function Page({ result }: { result: ReturnType<typeof composeInbox> }) {
  const n = result.counts.needsYou
  return (
    <main className="max-w-6xl mx-auto space-y-6 px-4 sm:px-6 py-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink">Inbox</h1>
        <p className="text-sm text-ink-muted mt-1">
          {n > 0 ? `${n} thing${n !== 1 ? 's' : ''} need${n === 1 ? 's' : ''} you`
            : result.failures.length > 0 ? 'Some sources couldn’t be checked' : 'Nothing needs you right now'}
        </p>
      </header>
      {result.failures.length > 0 && (
        <div role="alert" className="flex items-center gap-2.5 rounded-card border px-4 py-2.5 text-sm bg-amber-500/10 border-amber-500/25 text-amber-200">
          <div className="flex-1 min-w-0">
            Couldn’t check {result.failures.join(', ')} — this list may be missing items from those sources. Refresh to try again.
          </div>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-3 items-start">
        <div className="lg:col-span-2 min-w-0">
          <InboxNeedsYou items={result.needsYou} snoozedEvents={result.snoozedEvents} allClear={result.allClear} />
        </div>
        <div className="min-w-0">
          <InboxUpdates groups={result.updates} />
        </div>
      </div>
    </main>
  )
}

const wrap = (body: string) => `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style>
<style>body{margin:0}</style>
</head><body class="bg-bg text-ink">${body}</body></html>`

const scenarios: Record<string, React.ReactElement> = {
  full: <Page result={FULL} />,
  empty: <Page result={EMPTY} />,
  degraded: <Page result={DEGRADED} />,
  preview: (
    <main className="max-w-2xl mx-auto space-y-6 px-4 sm:px-6 py-6">
      <TodaysPriorities items={FULL.needsYou.slice(0, 3)} count={FULL.counts.needsYou} failuresCount={0} />
      <TodaysPriorities items={[]} count={0} failuresCount={2} />
    </main>
  ),
}

for (const [name, el] of Object.entries(scenarios)) {
  const html = wrap(renderToStaticMarkup(el))
  writeFileSync(join(outdir, `${name}.html`), html)
  console.log(`${name}.html  ${(html.length / 1024).toFixed(0)} kB`)
}
console.log(`composed: needsYou=${FULL.counts.needsYou} snoozed=${FULL.snoozedEvents.length} updates=${FULL.updates.length} sections=${[...new Set(FULL.needsYou.map(i => i.section))].join(',')}`)
