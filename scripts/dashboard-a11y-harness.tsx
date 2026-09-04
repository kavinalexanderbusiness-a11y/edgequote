// ── Dashboard keyboard / mobile fixture (investigation tool, not a guard) ────
// Renders the REAL dashboard surfaces to static markup — the header action
// pair (real PageHeader + CustomizeDashboard + ButtonLink), the briefing strip
// (real composeBriefing), MoneyBand, MonthStrip, the Needs-You preview and the
// Recent-updates preview — plus a second page with the Customize sheet OPEN.
// scripts/prove-dashboard-a11y.mjs then tabs through each page in headless
// Chrome at 375/390/430/1280 and measures focus order, accessible names, focus
// rings, tap targets and sideways overflow.
//
// Static markup has no React runtime, so anything driven by an effect or a
// handler — the Modal's focus trap, Escape, focus restore, the arrows' state
// changes — is NOT exercised here; those are read from source. This fixture
// proves DOM/ARIA structure, native tab order and geometry.
//
// Usage (needs compiled Tailwind from any .next build; no server, no browser):
//   CSS_DIR=<...>/.next/static/css npx tsx --tsconfig tsconfig.harness.json \
//     scripts/dashboard-a11y-harness.tsx [outdir=.dashboard-a11y]
import { renderToStaticMarkup } from 'react-dom/server'
import { writeFileSync, readdirSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { composeBriefing } from '../src/lib/dashboard/briefing'
import type { InboxItem } from '../src/lib/inbox'
import type { NotifGroup } from '../src/lib/notifications'
import { PageHeader } from '../src/components/layout/PageHeader'
import { OwnerBriefing } from '../src/components/dashboard/OwnerBriefing'
import { CustomizeDashboard } from '../src/components/dashboard/CustomizeDashboard'
import { MoneyBand } from '../src/components/dashboard/MoneyBand'
import { MonthStrip } from '../src/components/dashboard/MonthStrip'
import { TodaysPriorities } from '../src/components/dashboard/TodaysPriorities'
import { InboxUpdates } from '../src/components/inbox/InboxUpdates'
import { DEFAULT_DASHBOARD_LAYOUT } from '../src/lib/dashboard/layout'
import { ButtonLink } from '../src/components/ui/Button'
import { Plus } from 'lucide-react'

const outdir = process.argv[2] || '.dashboard-a11y'
mkdirSync(outdir, { recursive: true })
const cssDir = process.env.CSS_DIR || '.next/static/css'
const css = readdirSync(cssDir).filter(f => f.endsWith('.css'))
  .map(f => readFileSync(join(cssDir, f), 'utf8')).join('\n')

const TODAY = '2026-09-04'
// Every chip at once — the widest strip the page can produce.
const BRIEFING = composeBriefing({
  todayISO: TODAY, stopsToday: 7, revenueToday: 1840,
  overdue: 12480.5, overdueCount: 3, followupsDue: 2, requestsOpen: 1,
  dayPlan: { ok: true, rows: [{ date: '2026-09-05', stops: 3, warnings: [{ severity: 'blocking', message: 'Labour over capacity' } as never] }] },
})

// Presentation inputs for the Needs-You preview (the ranking engine is proved
// elsewhere; this fixture is about what the rendered rows are to a keyboard).
const item = (p: Partial<InboxItem> & Pick<InboxItem, 'key' | 'kind' | 'label' | 'href'>): InboxItem =>
  ({ section: 'today', detail: '', source: 'state', score: 0, ...p })
const ITEMS: InboxItem[] = [
  item({ key: 'p:unpaid', kind: 'unpaid', section: 'urgent', label: 'Collect from Mike Johnson', detail: 'INV-0224 · 7 days overdue', href: '/dashboard/invoices?invoice=INV-0224', value: 1250, more: 3 }),
  item({ key: 'p:leads', kind: 'leads', label: 'Respond to Priya Ramachandran-Oyelaran', detail: 'Website lead · waiting 7h', href: '/dashboard/messages?f=website_lead', more: 2 }),
  item({ key: 'day:2026-09-05', kind: 'day_conflict', section: 'urgent', label: 'Fix tomorrow’s schedule', detail: 'Labour over capacity by 4h', href: '/dashboard/schedule?d=2026-09-05' }),
]
const group = (g: Partial<NotifGroup>): NotifGroup => ({
  key: 'g', type: 'quote_accepted', priority: 'update', title: 'Quote accepted', body: null,
  href: '/dashboard/quotes/q1', count: 1, unread: 0, latestAt: '2026-09-04T15:00:00.000Z', ids: ['n'], items: [], ...g,
})
const GROUPS = [
  group({ key: 'g1', body: 'Priya Ramachandran-Oyelaran approved the $2,100 landscaping quote.', unread: 1 }),
  group({ key: 'g2', type: 'invoice_paid', title: 'Invoice paid', body: 'Jane Smith paid INV-0212 — $380.00.' }),
  group({ key: 'g3', type: 'review_received', title: 'New 5-star review', body: '“Crew was fantastic, the lawn looks great.”' }),
  group({ key: 'g4', type: 'change_order_approved', title: '2 changes approved', count: 2 }),
  group({ key: 'g5', type: 'invoice_paid', title: 'Invoice paid', body: 'Constantinopoulos Property Management Ltd. paid INV-0224.' }),
]
const MONEY = { today: 840, todayCount: 2, week: 4120, weekPrev: 3980, owed: 2760.5, owedCount: 5, overdue: 12480.5, overdueCount: 3, quotesOut: 9800, quotesOutCount: 4 }
const MONTH = { collected: 6230, collectedLastMonthToDate: 5400, jobsDone: 41, jobsDoneLastMonth: 37, conversionRate: 62 }

// The real header, composed exactly as app/dashboard/page.tsx composes it.
const header = (sheetOpen: boolean) => (
  <PageHeader title="Good afternoon" description="Thursday, September 4" action={
    <div className="flex items-center gap-2">
      <CustomizeDashboard initial={DEFAULT_DASHBOARD_LAYOUT} defaultOpen={sheetOpen} />
      <ButtonLink href="/dashboard/quotes/new"><Plus className="w-4 h-4" /> New quote</ButtonLink>
    </div>
  } />
)

const scenarios: Record<string, React.ReactElement> = {
  'dashboard-a11y': (
    <main className="max-w-6xl mx-auto space-y-6 px-4 sm:px-6 py-6">
      {header(false)}
      <OwnerBriefing chips={BRIEFING.chips} />
      <MoneyBand {...MONEY} />
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 lg:gap-5 items-start">
        <div className="lg:col-span-3"><TodaysPriorities items={ITEMS} count={9} failuresCount={0} /></div>
        <div className="lg:col-span-2"><MonthStrip {...MONTH} /></div>
      </div>
      <InboxUpdates groups={GROUPS} limit={4} moreHref="/dashboard/inbox" />
    </main>
  ),
  'customize-open': (
    <main className="max-w-6xl mx-auto space-y-6 px-4 sm:px-6 py-6">
      {header(true)}
      <OwnerBriefing chips={BRIEFING.chips} />
    </main>
  ),
}

const wrap = (body: string) => `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style><style>body{margin:0}</style>
</head><body class="bg-bg text-ink">${body}</body></html>`

for (const [name, el] of Object.entries(scenarios)) {
  const html = wrap(renderToStaticMarkup(el))
  writeFileSync(join(outdir, `${name}.html`), html)
  console.log(`${name}.html  ${(html.length / 1024).toFixed(0)} kB`)
}
