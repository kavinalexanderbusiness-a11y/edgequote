import { WeekendOutlook } from '@/components/dashboard/WeekendOutlook'
import { TodaysPriorities } from '@/components/dashboard/TodaysPriorities'
import { SetupProgress } from '@/components/dashboard/SetupProgress'
import { DashboardKpis } from '@/components/dashboard/DashboardKpis'
import { MoneyBand } from '@/components/dashboard/MoneyBand'
import { WeatherStrip } from '@/components/weather/WeatherStrip'
import { createClient } from '@/lib/supabase/server'
import { loadDashboard } from '@/lib/dashboard/data'
import { PageHeader } from '@/components/layout/PageHeader'
import { PageContainer } from '@/components/layout/PageContainer'
import Link from 'next/link'
import { Plus } from 'lucide-react'

// ── The CEO dashboard — the 7:00-AM owner view ───────────────────────────────
// Opened every morning, it answers three questions in one screen, in this order:
//
//   WHERE'S THE MONEY?  → MoneyBand: in today, in this week, owed (overdue split)
//   WHAT'S THE DAY?     → WeatherStrip (risk to booked work) + Your next work days
//   WHAT DO I DO?       → Today's Priorities — the ONE ranked queue: leads waiting,
//                         unpaid invoices, unscheduled accepted work, missed jobs,
//                         draft invoices, quote follow-ups, recurring ran dry.
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

  return (
    <PageContainer width="wide">
      <PageHeader
        title={d.greeting}
        description={`${d.dateLine} — where the money is, what today holds, and what to do first.`}
        action={
          <Link href="/dashboard/quotes/new"
            className="inline-flex items-center justify-center gap-2 font-medium rounded-xl transition-all duration-150 bg-accent text-black hover:bg-accent-hover active:scale-[0.98] shadow-sm px-4 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
            <Plus className="w-4 h-4" /> New quote
          </Link>
        }
      />

      {/* SETUP — first, and only while something is incomplete; it disappears for
          good at 100% (a finished checklist is a vanity stat). It leads because a
          half-configured business has no money to show yet: the bands below would
          be empty, and "finish setting up" is the honest first instruction. Client
          component — it decides its own visibility, so a configured business pays
          one query and sees nothing move. */}
      <div className="animate-rise"><SetupProgress /></div>

      {/* WHERE'S THE MONEY — the first thing an owner wants at 7 AM. */}
      <div className="animate-rise stagger-2"><MoneyBand {...d.money} /></div>

      {/* WHAT'S THE DAY — weather risk to booked work; hides itself with no base.
          The report is already loaded server-side, so the strip never pops in. */}
      <div className="animate-rise stagger-3"><WeatherStrip report={d.weather} /></div>

      {/* WHAT DO I DO — the one ranked queue (leads, money, follow-ups, at-risk). */}
      <div className="animate-rise stagger-4"><TodaysPriorities items={d.priorities} /></div>

      {/* Today's stops, then the days ahead. */}
      <div className="animate-rise stagger-5"><WeekendOutlook plan={d.dayPlan} /></div>

      {/* How the business is doing — the slow-moving half, last. */}
      <div className="animate-rise stagger-6"><DashboardKpis {...d.kpis} /></div>
    </PageContainer>
  )
}
