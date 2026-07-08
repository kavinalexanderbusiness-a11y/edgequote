import { WeekendOutlook } from '@/components/dashboard/WeekendOutlook'
import { DashboardSections } from '@/components/dashboard/DashboardSections'
import { createClient } from '@/lib/supabase/server'
import { StatsGrid } from '@/components/dashboard/StatsGrid'
import { RecentQuotes } from '@/components/dashboard/RecentQuotes'
import { AcquisitionInsights } from '@/components/dashboard/AcquisitionInsights'
import { DashboardTopSuggestions } from '@/components/dashboard/DashboardTopSuggestions'
import { TodaysPriorities } from '@/components/dashboard/TodaysPriorities'
import { UnscheduledAccepted } from '@/components/dashboard/UnscheduledAccepted'
import { MissedJobs } from '@/components/dashboard/MissedJobs'
import { TodayJobs } from '@/components/dashboard/TodayJobs'
import { PageHeader } from '@/components/layout/PageHeader'
import { DashboardStats, Quote } from '@/types'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { Plus } from 'lucide-react'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const [{ data: quotes }, { data: invoices }, { data: jobs }, { data: settingsRow }] = await Promise.all([
    supabase.from('quotes').select('*').eq('user_id', user!.id).order('created_at', { ascending: false }),
    supabase.from('invoices').select('amount, status, amount_paid').eq('user_id', user!.id),
    supabase.from('jobs').select('status, scheduled_date').eq('user_id', user!.id),
    supabase.from('business_settings').select('dashboard_cards, gst_percent').eq('user_id', user!.id).maybeSingle(),
  ])

  const allQuotes: Quote[] = quotes || []
  const allInvoices = (invoices as { amount: number; status: string; amount_paid: number | null }[]) || []
  const allJobs = (jobs as { status: string; scheduled_date: string }[]) || []
  // Ledger-aware: Collected = money actually received (amount_paid, incl. partial
  // payments); Outstanding = remaining balance across issued invoices.
  const collectedRevenue = allInvoices.reduce((s, i) => s + (Number(i.amount_paid) || 0), 0)
  // GST-inclusive + cancelled excluded, so this agrees with the Invoices page and
  // the portal (amount is the NET subtotal; the customer owes net × (1 + GST)).
  const gstMult = 1 + (Number(settingsRow?.gst_percent) || 0) / 100
  const outstandingRevenue = allInvoices
    .filter(i => i.status !== 'draft' && i.status !== 'cancelled')
    .reduce((s, i) => s + Math.max(0, Math.round((Number(i.amount || 0) * gstMult - (Number(i.amount_paid) || 0)) * 100) / 100), 0)

  // Monthly revenue = total of quotes created this calendar month
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthlyRevenue = allQuotes
    .filter(q => new Date(q.created_at) >= monthStart)
    .reduce((sum, q) => sum + Number(q.total), 0)

  // Conversion rate = accepted / (everything except draft)
  const acceptedCount = allQuotes.filter(q => q.status === 'accepted').length
  const decidedCount = allQuotes.filter(q => q.status !== 'draft').length
  const conversionRate = decidedCount > 0
    ? Math.round((acceptedCount / decidedCount) * 100)
    : 0

  // Done (completed) jobs feed reporting.
  const doneJobs = allJobs.filter(j => j.status === 'completed')
  const monthStartISO = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}-01`
  const jobsDone = doneJobs.length
  const jobsDoneThisMonth = doneJobs.filter(j => j.scheduled_date >= monthStartISO).length

  const stats: DashboardStats = {
    totalQuotes: allQuotes.length,
    revenueQuoted: allQuotes.reduce((sum, q) => sum + Number(q.total), 0),
    acceptedJobs: acceptedCount,
    pendingQuotes: allQuotes.filter(q => q.status === 'draft' || q.status === 'sent').length,
    acceptedRevenue: allQuotes
      .filter(q => q.status === 'accepted')
      .reduce((sum, q) => sum + Number(q.total), 0),
    monthlyRevenue,
    conversionRate,
    collectedRevenue,
    outstandingRevenue,
    jobsDone,
    jobsDoneThisMonth,
  }

  const recent = allQuotes.slice(0, 8)

  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader
        title={greeting}
        description="Here's what's happening with your business today."
        action={
          <Link href="/dashboard/quotes/new">
            <Button>
              <Plus className="w-4 h-4" /> New Quote
            </Button>
          </Link>
        }
      />
      {/* Operational block — what to work on RIGHT NOW, fixed above the customizable
          business-overview sections so it always leads the page:
            1. Today's Priorities — the ranked triage queue (money owed, risk, replies).
            2. Accepted — not yet scheduled — committed revenue at risk, one-tap to book
               (null when there's nothing slipping, so it's silent on a clean day).
            3. Today's Jobs — the day's route with one-tap call / open-in-Maps. */}
      <TodaysPriorities />
      <UnscheduledAccepted />
      <MissedJobs />
      <TodayJobs />
      <DashboardSections
        initialPrefs={(settingsRow as { dashboard_cards: { order: string[]; hidden: string[] } | null } | null)?.dashboard_cards ?? null}
        sections={{
          suggestions: <DashboardTopSuggestions />,
          stats: <StatsGrid stats={stats} />,
          weekend: <WeekendOutlook />,
          recent: <RecentQuotes quotes={recent} />,
          acquisition: <AcquisitionInsights />,
        }}
      />
    </div>
  )
}