import { Suspense } from 'react'
import { ButtonLink } from '@/components/ui/Button'
import { WeekendOutlook } from '@/components/dashboard/WeekendOutlook'
import { TodaysPriorities } from '@/components/dashboard/TodaysPriorities'
import { SetupProgress } from '@/components/dashboard/SetupProgress'
import { MonthStrip } from '@/components/dashboard/MonthStrip'
import { MoneyBand } from '@/components/dashboard/MoneyBand'
import { OwnerBriefing } from '@/components/dashboard/OwnerBriefing'
import { CustomizeDashboard } from '@/components/dashboard/CustomizeDashboard'
import { WeatherStrip } from '@/components/weather/WeatherStrip'
import { InboxUpdates } from '@/components/inbox/InboxUpdates'
import { createClient } from '@/lib/supabase/server'
import { loadDashboard } from '@/lib/dashboard/data'
import { loadInboxSources } from '@/lib/inboxData'
import { composeInbox } from '@/lib/inbox'
import { composeBriefing } from '@/lib/dashboard/briefing'
import { normalizeDashboardLayout, visibleDashboardCards, type DashboardCardId } from '@/lib/dashboard/layout'
import { PageHeader } from '@/components/layout/PageHeader'
import { PageContainer } from '@/components/layout/PageContainer'
import { localTodayISO } from '@/lib/utils'
import { Card } from '@/components/ui/Card'
import Link from 'next/link'
import { Plus, CalendarCheck, ArrowRight } from 'lucide-react'

// ── The owner dashboard — the whole business in ten seconds ─────────────────
// One screen answering three questions in order: what needs me, what is
// happening today, how is the business doing.
//
//   THE HEADER    → greeting and the date; beneath it THE BRIEFING — today's
//                   shape as linked facts (visits, conflicts, follow-ups,
//                   overdue, requests), each chip a door to the surface that
//                   resolves it. This IS the morning digest: the old
//                   notifications-page briefing was deliberately folded into
//                   this screen (one digest, never two competing ones), and
//                   the strip is that digest grown doors — not a new engine,
//                   not a second queue.
//   THE BANDS     → the owner's chosen cards, in their chosen order
//                   (lib/dashboard/layout; default = exactly the composition
//                   this page has always shipped): MoneyBand · the work pair
//                   (Needs You beside the day plan) · MonthStrip · the weekly
//                   review door · optionally Recent updates.
//
// ONE server fetch (lib/dashboard/data) feeds every band, so every NUMBER
// paints complete on the first byte — no per-component query waterfalls, and
// no figure that can disagree with another because two components loaded at
// different moments. Every number comes from an existing engine (ledger,
// reactivation, priorities, day plan, weather impact); nothing is recomputed
// here. CUSTOMISATION DOES NOT CHANGE THIS: hiding a card hides presentation —
// the batch stays one fetch, so a hidden card can never mean a forked data
// path, and re-showing it can never disagree with the page it rejoined.
//
// The ONE exception is weather — the only band fed by an external forecast API
// (2.5s worst case on a cold hit) rather than our own data. It streams into a
// reserved slot exactly the strip's height, so nothing below it ever moves and
// no business figure waits on someone else's server.
//
// Deliberately NOT here: growth suggestions, recent quotes, acquisition
// insights — they don't help you start the day and live on their own pages.

// The dashboard shows the TOP of the inbox, not the inbox — spec'd small on
// purpose so the queue card stays a glance, and "+N need you" is the door.
const PREVIEW_ROWS = 3
// And the TOP of the updates feed, for the same reason.
const UPDATES_PREVIEW_ROWS = 4

// Literal stagger classes (Tailwind scans raw strings — a computed
// `stagger-${n}` would silently compile to nothing).
const STAGGER = ['', 'stagger-2', 'stagger-3', 'stagger-4', 'stagger-5', 'stagger-6']
const rise = (n: number) => `animate-rise ${STAGGER[Math.min(n, STAGGER.length - 1)]}`.trim()

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const todayISO = localTodayISO()
  // The inbox's extra sources and the layout preference load BESIDE the
  // dashboard batch, not inside it: the dashboard keeps its all-or-throw
  // contract for the numbers it paints, while a failed inbox source only
  // degrades the pieces it feeds (named, never silent) — and the layout row is
  // COSMETIC, so any failure there (including the dashboard_cards column not
  // existing yet) resolves to the default composition rather than the error
  // screen. A preference must never be able to take the morning down.
  const [d, inboxExtras, layoutRes] = await Promise.all([
    loadDashboard(supabase, user!.id),
    loadInboxSources(supabase, user!.id, todayISO),
    supabase.from('business_settings').select('dashboard_cards').eq('user_id', user!.id).maybeSingle(),
  ])
  // THE inbox composition — the same engine the Inbox page runs, fed the same
  // queue rows, so the preview's count can never disagree with the page it
  // links to. `work` is the queue this loader already computed (uncapped).
  const inbox = composeInbox({
    sources: { work: { ok: true, rows: d.priorities }, ...inboxExtras },
    now: new Date(),
    todayISO,
  })
  const layout = normalizeDashboardLayout(
    layoutRes.error ? null : (layoutRes.data as { dashboard_cards: unknown } | null)?.dashboard_cards,
  )
  const cards = visibleDashboardCards(layout).map(c => c.id)

  // THE briefing — today's shape from figures already in hand (the day plan's
  // today group, the ledger's overdue slice, the follow-up and request
  // predicates, planDay's blocking verdicts). Nothing is fetched or recomputed
  // for it, so a chip can never disagree with the band it summarizes.
  const todayGroup = d.dayPlan.groups.find(g => g.isToday)
  const briefing = composeBriefing({
    todayISO,
    stopsToday: todayGroup?.jobs.length ?? 0,
    revenueToday: todayGroup?.revenue ?? 0,
    overdue: d.money.overdue,
    overdueCount: d.money.overdueCount,
    followupsDue: d.followupsDue,
    requestsOpen: d.requestsOpen,
    dayPlan: inboxExtras.dayPlan,
  })

  // ── The bands, in the owner's order ────────────────────────────────────────
  // Needs You and the day-plan column render side by side when adjacent (the
  // work pair this page has always shipped, in either order); apart or alone,
  // each takes the full width. items-start keeps each column its own height.
  const needsYouCard = (
    <TodaysPriorities
      items={inbox.needsYou.slice(0, PREVIEW_ROWS)}
      count={inbox.counts.needsYou}
      failuresCount={inbox.failures.length}
      started={d.started}
    />
  )
  // Weather sits WITH the day plan it threatens — risk and the work at risk in
  // one glance column. It STREAMS in behind a placeholder of exactly its
  // height (all strip variants are one line at px-4 py-2.5), so the forecast's
  // latency never delays a business number and its arrival never shifts the
  // outlook below. The fallback is deliberately NOT <WeatherStrip> itself:
  // given no report, the strip client-fetches its own copy — a duplicate
  // 7-query load during the stream window.
  const todayCard = (
    <div className="space-y-4 lg:space-y-5">
      <Suspense fallback={<WeatherPending />}>
        <WeatherSection weather={d.weather} />
      </Suspense>
      <WeekendOutlook plan={d.dayPlan} />
    </div>
  )
  const bandFor = (id: DashboardCardId, s: number): React.ReactNode => {
    switch (id) {
      case 'money': return <div key={id} className={rise(s)}><MoneyBand {...d.money} /></div>
      case 'needsYou': return <div key={id} className={rise(s)}>{needsYouCard}</div>
      case 'today': return <div key={id} className={rise(s)}>{todayCard}</div>
      case 'month':
        // THE MONTH — the trend read, deliberately quieter. Every figure
        // carries its own last-month baseline.
        return <div key={id} className={rise(s)}><MonthStrip {...d.month} /></div>
      case 'review':
        // THE WEEK IN REVIEW — a slim navigational card, not a second hero
        // (one aurora per page stays with the priorities queue). No data is
        // fetched here; the review page loads its own.
        return (
          <Link key={id} href="/dashboard/review" className={`group block ${rise(s)}`}>
            <Card className="p-4 sm:p-5 card-lift hover:border-accent/40 flex items-center gap-3.5">
              <span className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center shrink-0">
                <CalendarCheck aria-hidden className="w-5 h-5 text-accent-text" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold tracking-tight text-ink flex items-center gap-1.5">
                  Weekly review
                  <ArrowRight aria-hidden className="w-3.5 h-3.5 text-accent-text transition-transform group-hover:translate-x-0.5" />
                </span>
                <span className="block text-xs text-ink-muted mt-0.5">Last week&rsquo;s results and next week&rsquo;s moves, on one screen.</span>
              </span>
            </Card>
          </Link>
        )
      case 'updates':
        // Recent updates — the Inbox's Updates column, previewed. Same
        // renderer, same groups, one door; a failed events source SAYS so
        // instead of claiming a quiet week.
        return (
          <div key={id} className={rise(s)}>
            <InboxUpdates
              groups={inbox.updates}
              limit={UPDATES_PREVIEW_ROWS}
              moreHref="/dashboard/inbox"
              unavailable={!inboxExtras.events.ok}
            />
          </div>
        )
    }
  }

  const bands: React.ReactNode[] = []
  {
    let s = 1 // stagger position (the briefing strip takes the first slot)
    for (let i = 0; i < cards.length; i++) {
      const id = cards[i]
      const next = cards[i + 1]
      const pair = (id === 'needsYou' && next === 'today') || (id === 'today' && next === 'needsYou')
      if (pair) {
        bands.push(
          <div key="work" className="grid grid-cols-1 lg:grid-cols-5 gap-4 lg:gap-5 items-start">
            <div className={`${id === 'needsYou' ? 'lg:col-span-3' : 'lg:col-span-2'} ${rise(s)}`}>
              {id === 'needsYou' ? needsYouCard : todayCard}
            </div>
            <div className={`${id === 'needsYou' ? 'lg:col-span-2' : 'lg:col-span-3'} ${rise(s + 1)}`}>
              {id === 'needsYou' ? todayCard : needsYouCard}
            </div>
          </div>,
        )
        i++; s += 2
      } else {
        bands.push(bandFor(id, s))
        s++
      }
    }
  }

  return (
    <PageContainer width="wide">
      <PageHeader
        title={d.greeting}
        description={d.dateLine}
        action={
          <div className="flex items-center gap-2">
            <CustomizeDashboard initial={layout} />
            <ButtonLink href="/dashboard/quotes/new">
              <Plus className="w-4 h-4" /> New quote
            </ButtonLink>
          </div>
        }
      />

      {/* THE BRIEFING — always on, server-painted, above every band. The facts
          the header used to state as a string, now doors — plus the ones a
          glance most needs (conflicts, overdue, requests). Not customisable on
          purpose: whatever cards are hidden below, this floor still answers
          "what needs me / what's happening today". */}
      <div className="animate-rise"><OwnerBriefing chips={briefing.chips} /></div>

      {/* First band, then SETUP — only while something is incomplete;
          disappears for good at 100%. Below the first band so its
          hydration pop-in never moves the hero the morning opens on, while a
          half-configured business still sees it immediately. */}
      {bands[0]}
      <div className="animate-rise stagger-2"><SetupProgress started={d.started} /></div>
      {bands.slice(1)}
    </PageContainer>
  )
}

// Awaits the streamed forecast and hands it to the strip as a RESOLVED report,
// so the strip's "no report → fetch my own" fallback never fires here.
async function WeatherSection({ weather }: { weather: Awaited<ReturnType<typeof loadDashboard>>['weather'] }) {
  return <WeatherStrip report={await weather} />
}

// Same box as every strip variant (all are one line at px-4 py-2.5), so the
// real strip replaces this in place — nothing below it ever moves. Reads as
// pending, never as "no risk": unknown must not look like fine.
function WeatherPending() {
  return (
    <div className="flex items-center gap-2 rounded-card border border-border bg-bg-secondary px-4 py-2.5">
      <span className="w-3.5 h-3.5 shrink-0" aria-hidden />
      <p className="text-xs text-ink-faint">Checking the forecast…</p>
    </div>
  )
}
