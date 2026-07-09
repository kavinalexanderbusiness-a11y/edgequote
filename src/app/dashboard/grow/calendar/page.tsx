import { createClient } from '@/lib/supabase/server'
import { aiEnabled } from '@/lib/ai/studioGateway'
import { PageHeader } from '@/components/layout/PageHeader'
import { MarketingCalendar } from '@/components/grow/marketing/MarketingCalendar'

// Content Calendar — plan, schedule, and track every post; one-click month planning.
export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const sp = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  return (
    <div className="space-y-5">
      <PageHeader title="Content Calendar" description="Schedule and track every post — drafts, scheduled, published and failed." />
      <MarketingCalendar userId={user.id} aiEnabled={aiEnabled()} openPlan={sp.plan === '1'} />
    </div>
  )
}
