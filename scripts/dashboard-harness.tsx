// ── Dashboard-strip measurement harness (investigation tool, not a guard) ────
// Renders Session 97's NEW dashboard geometry — the briefing chip strip, the
// header's Customize+New-quote action pair, and the Recent-updates preview —
// to static markup through the REAL engines (composeBriefing over planDay's
// real verdicts), wrapped in the compiled Tailwind CSS, into the same outdir
// scripts/prove-inbox-mobile.mjs measures. The bands below the strip are the
// components S71 already proved at phone widths; this harness measures what
// S97 added. The customize MODAL renders nothing here (static markup, closed
// state) — it is the shared Modal primitive, the app-wide bottom sheet, and
// its sheet content is a six-row list; the Customize BUTTON's tap target IS
// measured.
//
// Usage: npx tsx --tsconfig tsconfig.harness.json scripts/dashboard-harness.tsx <outdir>
import { renderToStaticMarkup } from 'react-dom/server'
import { writeFileSync, readdirSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { composeBriefing } from '../src/lib/dashboard/briefing'
import { planDay } from '../src/lib/dayPlan'
import type { DayPlanRow } from '../src/lib/inbox'
import type { NotifGroup } from '../src/lib/notifications'
import { OwnerBriefing } from '../src/components/dashboard/OwnerBriefing'
import { CustomizeDashboard } from '../src/components/dashboard/CustomizeDashboard'
import { InboxUpdates } from '../src/components/inbox/InboxUpdates'
import { DEFAULT_DASHBOARD_LAYOUT } from '../src/lib/dashboard/layout'
import { ButtonLink } from '../src/components/ui/Button'
import { Plus } from 'lucide-react'

const outdir = process.argv[2] || '.inbox-harness'
mkdirSync(outdir, { recursive: true })

const cssDir = '.next/static/css'
const css = readdirSync(cssDir).filter(f => f.endsWith('.css'))
  .map(f => readFileSync(join(cssDir, f), 'utf8')).join('\n')

const TODAY = '2026-08-15'

// Blocking verdict through the REAL engine — never a hand-written warning.
const overbooked = (date: string): DayPlanRow => {
  const p = planDay({
    stops: [1, 2, 3].map(n => ({ jobId: `j${n}`, durationMinutes: 240, crewSize: 1, status: 'scheduled', located: false })),
    startTime: '08:00', capacityHours: 8, workers: 1, hasBase: false,
  })
  return { date, stops: p.stopCount, warnings: p.warnings }
}

// The worst realistic width case: every chip present at once, with plural
// counts and a four-figure dollar amount.
const BUSY = composeBriefing({
  todayISO: TODAY,
  stopsToday: 7, revenueToday: 1840,
  overdue: 12480.5, overdueCount: 3,
  followupsDue: 2, requestsOpen: 1,
  dayPlan: { ok: true, rows: [overbooked('2026-08-16'), overbooked('2026-08-18')] },
})
// A failed source beside real facts — the unavailable chip's own geometry.
const DEGRADED = composeBriefing({
  todayISO: TODAY,
  stopsToday: 3, revenueToday: 0,
  overdue: 431.55, overdueCount: 1,
  followupsDue: 0, requestsOpen: 0,
  dayPlan: { ok: false, error: 'fetch failed' },
})

const group = (g: Partial<NotifGroup>): NotifGroup => ({
  key: 'g1', type: 'quote_accepted', priority: 'update', title: 'Quote accepted',
  body: null, href: '/dashboard/quotes/q1', count: 1, unread: 1,
  latestAt: '2026-08-15T09:00:00.000Z', ids: ['n1'], items: [],
  ...g,
})
const GROUPS: NotifGroup[] = [
  group({ key: 'g1', title: 'Quote accepted', body: 'Priya Ramachandran-Oyelaran approved the $2,100 landscaping quote.' }),
  group({ key: 'g2', type: 'invoice_paid', title: 'Invoice paid', body: 'Jane Smith paid INV-0212 — $380.00.', unread: 0 }),
  group({ key: 'g3', type: 'review_received', title: 'New 5-star review', body: '“Crew was fantastic, the lawn looks great.”', unread: 0 }),
  group({ key: 'g4', type: 'change_order_approved', title: '2 changes approved', body: null, count: 2, unread: 0 }),
  group({ key: 'g5', type: 'invoice_paid', title: 'Invoice paid', body: 'Constantinopoulos Property Management Ltd. paid INV-0224.', unread: 0 }),
]

const strip = (
  <main className="max-w-6xl mx-auto space-y-6 px-4 sm:px-6 py-6">
    {/* The header's action pair — the Customize button (its modal stays closed
        in static markup) beside the primary CTA, as page.tsx composes them. */}
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex-1 min-w-0">
        <h1 className="text-xl font-bold text-ink tracking-tight truncate">Good morning</h1>
        <p className="text-sm text-ink-muted mt-0.5">Friday, August 15</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <CustomizeDashboard initial={DEFAULT_DASHBOARD_LAYOUT} />
        <ButtonLink href="/dashboard/quotes/new"><Plus className="w-4 h-4" /> New quote</ButtonLink>
      </div>
    </div>
    <OwnerBriefing chips={BUSY.chips} />
    <OwnerBriefing chips={DEGRADED.chips} />
    <InboxUpdates groups={GROUPS} limit={4} moreHref="/dashboard/inbox" />
    <InboxUpdates groups={GROUPS} limit={4} moreHref="/dashboard/inbox" unavailable />
  </main>
)

const wrap = (body: string) => `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style>
<style>body{margin:0}</style>
</head><body class="bg-bg text-ink">${body}</body></html>`

const html = wrap(renderToStaticMarkup(strip))
writeFileSync(join(outdir, 'dashboard-strip.html'), html)
console.log(`dashboard-strip.html  ${(html.length / 1024).toFixed(0)} kB`)
console.log(`busy chips: ${BUSY.chips.map(c => c.id).join(',')} · degraded chips: ${DEGRADED.chips.map(c => c.id).join(',')}`)
