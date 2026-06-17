import { WeekendOutlook } from '@/components/dashboard/WeekendOutlook'
import { DashboardSections } from '@/components/dashboard/DashboardSections'
import { createClient } from '@/lib/supabase/server'
import { StatsGrid } from '@/components/dashboard/StatsGrid'
import { RecentQuotes } from '@/components/dashboard/RecentQuotes'
import { UnscheduledAccepted } from '@/components/dashboard/UnscheduledAccepted'
import { MissedJobs } from '@/components/dashboard/MissedJobs'
import { FollowUpQuotes } from '@/components/dashboard/FollowUpQuotes'
import { AcquisitionInsights } from '@/components/dashboard/AcquisitionInsights'
import { DashboardTopSuggestions } from '@/components/dashboard/DashboardTopSuggestions'
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
    supabase.from('invoices').select('amount, status').eq('user_id', user!.id),
    supabase.from('jobs').select('status, scheduled_date').eq('user_id', user!.id),
    supabase.from('business_settings').select('dashboard_cards').eq('user_id', user!.id).maybeSingle(),
  ])

  const allQuotes: Quote[] = quotes || []
  const allInvoices = (invoices as { amount: number; status: string }[]) || []
  const allJobs = (jobs as { status: string; scheduled_date: string }[]) || []
  const collectedRevenue = allInvoices.filter(i => i.status === 'paid').reduce((s, i) => s + Number(i.amount || 0), 0)
  const outstandingRevenue = allInvoices.filter(i => i.status === 'unpaid' || i.status === 'sent').reduce((s, i) => s + Number(i.amount || 0), 0)

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
        description="Here's what's happening with Edge Property Services today."
        action={
          <Link href="/dashboard/quotes/new">
            <Button>
              <Plus className="w-4 h-4" /> New Quote
            </Button>
          </Link>
        }
      />
      <DashboardSections
        initialPrefs={(settingsRow as { dashboard_cards: { order: string[]; hidden: string[] } | null } | null)?.dashboard_cards ?? null}
        sections={{
          suggestions: <DashboardTopSuggestions />,
          stats: <StatsGrid stats={stats} />,
          missed: <MissedJobs />,
          followups: <FollowUpQuotes />,
          unscheduled: <UnscheduledAccepted />,
          weekend: <WeekendOutlook />,
          recent: <RecentQuotes quotes={recent} />,
          acquisition: <AcquisitionInsights />,
        }}
      />
    </div>
  )
}