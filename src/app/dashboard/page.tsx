import { WeekendOutlook } from '@/components/dashboard/WeekendOutlook'
import { TodaysPriorities } from '@/components/dashboard/TodaysPriorities'
import { SetupProgress } from '@/components/dashboard/SetupProgress'
import { MonthStrip } from '@/components/dashboard/MonthStrip'
import { MoneyBand } from '@/components/dashboard/MoneyBand'
import { WeatherStrip } from '@/components/weather/WeatherStrip'
import { createClient } from '@/lib/supabase/server'
import { loadDashboard } from '@/lib/dashboard/data'
import { PageHeader } from '@/components/layout/PageHeader'
import { PageContainer } from '@/components/layout/PageContainer'
import { formatCurrency } from '@/lib/utils'
import { Card } from '@/components/ui/Card'
import Link from 'next/link'
import { Plus, CalendarCheck, ArrowRight } from 'lucide-react'

// ── The owner dashboard — the whole business in ten seconds ─────────────────
// One screen, four moves of the eye, in this order:
//
//   THE HEADER    → today's shape: date, stops booked, revenue on the books —
//                   facts, not a caption describing the page.
//   THE MONEY     → MoneyBand: in today · this week (vs last) · owed (overdue
//                   split) · quotes out for a decision. Past → present → due →
//                   maybe, left to right.
//   THE WORK      → side by side on desktop: Today's Priorities (the ONE ranked
//                   queue — the hero, above the fold) and the day plan with its
//                   weather risk. Stacked in that order on phones.
//   THE MONTH     → MonthStrip: collected / jobs / conversion, each against
//                   last month — the trend read, deliberately last and
//                   deliberately quieter.
//
// ONE server fetch (lib/dashboard/data) feeds every band, so the page paints
// complete on the first byte — no spinners, no waterfall, and no figure that can
// disagree with another because two components loaded at different moments.
// Every number comes from an existing engine (ledger, reactivation, priorities,
// day plan, weather impact); nothing is recomputed here.
//
// Deliberately NOT here: growth suggestions, recent quotes, acquisition insights —
// they don't help you start the day and live on their own pages.
export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const d = await loadDashboard(supabase, user!.id)

  // The header carries the FORWARD half of the morning (the money band below is
  // the backward half): how many stops today, and what's on the books over the
  // day-plan window. Both figures already exist in the day plan — this is
  // presentation of numbers the page computed anyway, not new math.
  const todayGroup = d.dayPlan.groups.find(g => g.isToday)
  const stopsToday = todayGroup?.jobs.length ?? 0
  const headerFacts = [
    d.dateLine,
    stopsToday > 0 ? `${stopsToday} stop${stopsToday !== 1 ? 's' : ''} today` : 'no stops today',
    d.dayPlan.totalRevenue > 0 ? `${formatCurrency(d.dayPlan.totalRevenue)} on the books` : null,
  ].filter(Boolean).join(' · ')

  return (
    <PageContainer width="wide">
      <PageHeader
        title={d.greeting}
        description={headerFacts}
        action={
          <Link href="/dashboard/quotes/new"
            className="inline-flex items-center justify-center gap-2 font-medium rounded-xl transition-all duration-150 bg-accent text-black hover:bg-accent-hover active:scale-[0.98] shadow-sm px-4 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
            <Plus className="w-4 h-4" /> New quote
          </Link>
        }
      />

      {/* THE MONEY — first and server-painted, so the top of the page never
          moves. (SetupProgress used to sit above this band: a client component
          that decides its own visibility after hydration, it shoved the money
          down mid-read on exactly the accounts the first seconds matter for.) */}
      <div className="animate-rise"><MoneyBand {...d.money} /></div>

      {/* SETUP — only while something is incomplete; disappears for good at 100%
          (a finished checklist is a vanity stat). Below the money now: a
          half-configured business still sees it immediately under honest $0
          tiles, and its hydration pop-in no longer moves the hero. */}
      <div className="animate-rise stagger-2"><SetupProgress /></div>

      {/* THE WORK — queue beside day plan on desktop so the whole page fits one
          screen; stacked queue-first on phones. items-start keeps each column
          its own height instead of stretching the short one. */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 lg:gap-5 items-start">
        <div className="lg:col-span-3 animate-rise stagger-3">
          <TodaysPriorities items={d.priorities} />
        </div>
        <div className="lg:col-span-2 space-y-4 lg:space-y-5">
          {/* Weather sits WITH the day plan it threatens — risk and the work at
              risk in one glance column. The strip's own honesty rules are
              untouched: it still says "no rain risk" explicitly and renders
              "couldn't check" on failure rather than silence. */}
          <div className="animate-rise stagger-4"><WeatherStrip report={d.weather} /></div>
          <div className="animate-rise stagger-5"><WeekendOutlook plan={d.dayPlan} /></div>
        </div>
      </div>

      {/* THE MONTH — the trend read, last and quieter. Every figure carries its
          own last-month baseline; the all-time total is gone (a lifetime
          cumulative never changes what the owner does this morning). */}
      <div className="animate-rise stagger-6"><MonthStrip {...d.month} /></div>

      {/* THE WEEK IN REVIEW — the retrospective drill-down, sitting with the
          month tiles it deepens. The Sunday screen (last week's results + next
          week's moves) previously had no path from home: the only door was a
          detour through the Grow hub, so the owner's weekly reflection lived two
          hubs from where they start the day. A slim navigational card, not a
          second hero — one aurora per page stays with the priorities queue. No
          data is fetched here; the review page loads its own, exactly as before.
          Matches the Grow FeatureCard hover language (card floats, arrow leans). */}
      <Link href="/dashboard/review" className="group block animate-rise">
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
    </PageContainer>
  )
}
