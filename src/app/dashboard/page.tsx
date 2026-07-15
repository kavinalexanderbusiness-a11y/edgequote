import { WeekendOutlook } from '@/components/dashboard/WeekendOutlook'
import { TodaysPriorities } from '@/components/dashboard/TodaysPriorities'
import { DashboardKpis } from '@/components/dashboard/DashboardKpis'
import { MoneyBand } from '@/components/dashboard/MoneyBand'
import { WeatherStrip } from '@/components/weather/WeatherStrip'
import { createClient } from '@/lib/supabase/server'
import { invoiceBalance, displayInvoiceStatus, collectedBetween, dayBoundsIso } from '@/lib/payments/ledger'
import { PageHeader } from '@/components/layout/PageHeader'
import { PageContainer } from '@/components/layout/PageContainer'
import { localTodayISO } from '@/lib/utils'
import type { Invoice } from '@/types'
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
// Every number is read from an existing engine — the payments ledger, the
// reactivation engine, the weather-impact engine, needsFollowUp, the lead union.
// Nothing is recomputed here, so no figure can disagree with the page it links to.
// Deliberately NOT here: growth suggestions, recent quotes, acquisition insights —
// they don't help you start the day and live on their own pages.
export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const today = localTodayISO()
  // Week = the last 7 days INCLUDING today (a rolling week, not a calendar week):
  // on a Monday a calendar week would read $0 and look broken.
  const weekStartDate = new Date(`${today}T00:00:00`)
  weekStartDate.setDate(weekStartDate.getDate() - 6)
  const weekStartISO = `${weekStartDate.getFullYear()}-${String(weekStartDate.getMonth() + 1).padStart(2, '0')}-${String(weekStartDate.getDate()).padStart(2, '0')}`
  const dayBounds = dayBoundsIso(today)
  const weekBounds = { start: dayBoundsIso(weekStartISO).start, end: dayBounds.end }

  const [{ data: invoices }, { data: jobs }, { data: quotes }, { data: settingsRow }, todayCash, weekCash] = await Promise.all([
    supabase.from('invoices').select('amount, status, amount_paid, discount_type, discount_value, due_date').eq('user_id', user!.id),
    supabase.from('jobs').select('status, scheduled_date').eq('user_id', user!.id),
    supabase.from('quotes').select('status').eq('user_id', user!.id),
    supabase.from('business_settings').select('gst_percent').eq('user_id', user!.id).maybeSingle(),
    // Money actually received, from THE ledger (payments rows by paid_at) —
    // invoices.amount_paid is a date-collapsed rollup and cannot answer "today".
    collectedBetween(supabase, { userId: user!.id, startIso: dayBounds.start, endIso: dayBounds.end }),
    collectedBetween(supabase, { userId: user!.id, startIso: weekBounds.start, endIso: weekBounds.end }),
  ])
  // The exact shape the ledger's invoiceBalance/displayInvoiceStatus overlays need.
  type InvoiceRow = Pick<Invoice, 'amount' | 'status' | 'amount_paid' | 'discount_type' | 'discount_value' | 'due_date'>
  const allInvoices = (invoices as InvoiceRow[]) || []
  const allJobs = (jobs as { status: string; scheduled_date: string }[]) || []
  const allQuotes = (quotes as { status: string }[]) || []

  // Ledger-aware, so these agree with the "Collect unpaid invoices" priority AND the
  // Invoices page: Collected = money actually received (amount_paid, incl. partials);
  // Outstanding = remaining GST-inclusive balance across issued invoices.
  const collected = allInvoices.reduce((s, i) => s + (Number(i.amount_paid) || 0), 0)
  const issued = allInvoices.filter(i => i.status !== 'draft' && i.status !== 'cancelled')
  const owing = issued.filter(i => invoiceBalance(i, settingsRow).balance > 0.01)
  const outstanding = owing.reduce((s, i) => s + Math.max(0, invoiceBalance(i, settingsRow).balance), 0)

  // Overdue = the same display-status overlay the Invoices page renders, so the
  // dashboard's overdue count is exactly what the Overdue filter shows.
  const overdueInvoices = owing.filter(i => displayInvoiceStatus(i, settingsRow, today) === 'overdue')
  const overdue = overdueInvoices.reduce((s, i) => s + Math.max(0, invoiceBalance(i, settingsRow).balance), 0)

  const now = new Date()
  const monthStartISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  const jobsThisMonth = allJobs.filter(j => j.status === 'completed' && j.scheduled_date >= monthStartISO).length

  const accepted = allQuotes.filter(q => q.status === 'accepted').length
  const decided = allQuotes.filter(q => q.status !== 'draft').length
  const conversionRate = decided > 0 ? Math.round((accepted / decided) * 100) : 0

  const hour = now.getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const dateLine = now.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <PageContainer width="wide">
      <PageHeader
        title={greeting}
        description={`${dateLine} — where the money is, what today holds, and what to do first.`}
        action={
          <Link href="/dashboard/quotes/new"
            className="inline-flex items-center justify-center gap-2 font-medium rounded-xl transition-all duration-150 bg-accent text-black hover:bg-accent-hover active:scale-[0.98] shadow-sm px-4 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
            <Plus className="w-4 h-4" /> New quote
          </Link>
        }
      />

      {/* WHERE'S THE MONEY — the first thing an owner wants at 7 AM. */}
      <div className="animate-rise">
        <MoneyBand
          today={todayCash.total} todayCount={todayCash.count}
          week={weekCash.total} weekLabel="Last 7 days"
          owed={outstanding} owedCount={owing.length}
          overdue={overdue} overdueCount={overdueInvoices.length}
        />
      </div>

      {/* WHAT'S THE DAY — weather risk to booked work; hides itself with no base. */}
      <div className="animate-rise stagger-2"><WeatherStrip /></div>

      {/* WHAT DO I DO — the one ranked queue (leads, money, follow-ups, at-risk). */}
      <div className="animate-rise stagger-3"><TodaysPriorities /></div>

      {/* Today's stops, then the days ahead. */}
      <div className="animate-rise stagger-4"><WeekendOutlook /></div>

      {/* How the business is doing — the slow-moving half, last. */}
      <div className="animate-rise stagger-5">
        <DashboardKpis collected={collected} jobsThisMonth={jobsThisMonth} conversionRate={conversionRate} />
      </div>
    </PageContainer>
  )
}
