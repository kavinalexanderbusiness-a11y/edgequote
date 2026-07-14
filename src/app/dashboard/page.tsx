import { WeekendOutlook } from '@/components/dashboard/WeekendOutlook'
import { TodaysPriorities } from '@/components/dashboard/TodaysPriorities'
import { DashboardKpis } from '@/components/dashboard/DashboardKpis'
import { createClient } from '@/lib/supabase/server'
import { invoiceBalance } from '@/lib/payments/ledger'
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

  const [{ data: invoices }, { data: jobs }, { data: quotes }, { data: settingsRow }] = await Promise.all([
    supabase.from('invoices').select('amount, status, amount_paid, discount_type, discount_value').eq('user_id', user!.id),
    supabase.from('jobs').select('status, scheduled_date').eq('user_id', user!.id),
    supabase.from('quotes').select('status').eq('user_id', user!.id),
    supabase.from('business_settings').select('gst_percent').eq('user_id', user!.id).maybeSingle(),
  ])
  const allInvoices = (invoices as { amount: number; status: string; amount_paid?: number; discount_type: 'amount' | 'percent' | null; discount_value: number | null }[]) || []
  const allJobs = (jobs as { status: string; scheduled_date: string }[]) || []
  const allQuotes = (quotes as { status: string }[]) || []

  // Ledger-aware, so these agree with the "Collect unpaid invoices" priority AND the
  // Invoices page: Collected = money actually received (amount_paid, incl. partials);
  // Outstanding = remaining GST-inclusive balance across issued invoices.
  const collected = allInvoices.reduce((s, i) => s + (Number(i.amount_paid) || 0), 0)
  const outstanding = allInvoices
    .filter(i => i.status !== 'draft' && i.status !== 'cancelled')
    .reduce((s, i) => s + Math.max(0, invoiceBalance(i, settingsRow).balance), 0)

  const now = new Date()
  const monthStartISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  const jobsThisMonth = allJobs.filter(j => j.status === 'completed' && j.scheduled_date >= monthStartISO).length

  const accepted = allQuotes.filter(q => q.status === 'accepted').length
  const decided = allQuotes.filter(q => q.status !== 'draft').length
  const conversionRate = decided > 0 ? Math.round((accepted / decided) * 100) : 0

  const hour = now.getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const dateLine = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

  // A gentle staggered rise on load (motion-safe; backwards fill so nothing flashes
  // before its delay) — the calm, premium entrance of a Linear/Stripe surface.
  const rise = 'motion-safe:animate-[fadeInUp_.45s_cubic-bezier(0.22,1,0.36,1)_both]'

  return (
    <div className="max-w-6xl space-y-6">
      <div className={rise}>
        <PageHeader
          title={greeting}
          description={dateLine}
          action={
            <Link href="/dashboard/quotes/new">
              <Button>
                <Plus className="w-4 h-4" /> New Quote
              </Button>
            </Link>
          }
        />
      </div>
      <div className={`${rise} motion-safe:[animation-delay:70ms]`}>
        <TodaysPriorities />
      </div>
      <div className={`${rise} motion-safe:[animation-delay:140ms]`}>
        <WeekendOutlook />
      </div>
      <div className={`${rise} motion-safe:[animation-delay:210ms]`}>
        <DashboardKpis collected={collected} outstanding={outstanding} jobsThisMonth={jobsThisMonth} conversionRate={conversionRate} />
      </div>
    </div>
  )
}
