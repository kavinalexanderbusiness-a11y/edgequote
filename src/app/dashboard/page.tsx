import { WeekendOutlook } from '@/components/dashboard/WeekendOutlook'
import { TodaysPriorities } from '@/components/dashboard/TodaysPriorities'
import { DashboardKpis } from '@/components/dashboard/DashboardKpis'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/layout/PageHeader'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { Plus } from 'lucide-react'

// The 7:00-AM owner view — answers both halves of the morning:
//   WHAT DO I DO TODAY?
//     1. What first?            → Today's Priorities (ranked queue)
//     2. Who owes me money?     → Today's Priorities (unpaid-invoices row)
//     3. What jobs are today?   → Your next work days (today's stops, call/map)
//     4. What needs scheduling? → Today's Priorities (accepted-not-scheduled row)
//     5. Who needs follow-up?   → Today's Priorities (follow-up-quotes row)
//   HOW IS MY BUSINESS DOING?  → the compact KPI strip (Collected, Outstanding,
//     Jobs This Month, Conversion) under the day plan.
// Nothing else earns space: growth suggestions, recent quotes and acquisition
// insights don't help you start the day and live on their own pages.
export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const [{ data: invoices }, { data: jobs }, { data: quotes }] = await Promise.all([
    supabase.from('invoices').select('amount, status').eq('user_id', user!.id),
    supabase.from('jobs').select('status, scheduled_date').eq('user_id', user!.id),
    supabase.from('quotes').select('status').eq('user_id', user!.id),
  ])
  const allInvoices = (invoices as { amount: number; status: string }[]) || []
  const allJobs = (jobs as { status: string; scheduled_date: string }[]) || []
  const allQuotes = (quotes as { status: string }[]) || []

  // Collected = invoices paid; Outstanding = money owed. Outstanding uses the SAME
  // filter as the "Collect unpaid invoices" priority above, so the two never disagree.
  const collected = allInvoices.filter(i => i.status === 'paid').reduce((s, i) => s + Number(i.amount || 0), 0)
  const outstanding = allInvoices.filter(i => i.status === 'unpaid' || i.status === 'sent').reduce((s, i) => s + Number(i.amount || 0), 0)

  const now = new Date()
  const monthStartISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  const jobsThisMonth = allJobs.filter(j => j.status === 'completed' && j.scheduled_date >= monthStartISO).length

  const accepted = allQuotes.filter(q => q.status === 'accepted').length
  const decided = allQuotes.filter(q => q.status !== 'draft').length
  const conversionRate = decided > 0 ? Math.round((accepted / decided) * 100) : 0

  const hour = now.getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader
        title={greeting}
        description="Your day, and how the business is doing."
        action={
          <Link href="/dashboard/quotes/new">
            <Button>
              <Plus className="w-4 h-4" /> New Quote
            </Button>
          </Link>
        }
      />
      <TodaysPriorities />
      <WeekendOutlook />
      <DashboardKpis collected={collected} outstanding={outstanding} jobsThisMonth={jobsThisMonth} conversionRate={conversionRate} />
    </div>
  )
}
