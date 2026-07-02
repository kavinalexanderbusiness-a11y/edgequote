import { createClient } from '@/lib/supabase/server'
import { aiEnabled } from '@/lib/ai/studioGateway'
import { PageHeader } from '@/components/layout/PageHeader'
import { MarketingSubnav } from '@/components/grow/marketing/MarketingSubnav'
import { CampaignBuilder } from '@/components/grow/marketing/CampaignBuilder'
import { listCampaigns } from '@/lib/marketing/library'
import { isCampaignKind } from '@/lib/marketing/campaigns'

// Campaign Builder — one theme fans out into a post per platform.
export default async function CampaignsPage({ searchParams }: { searchParams: Promise<{ kind?: string; holiday?: string }> }) {
  const sp = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const campaigns = await listCampaigns(supabase, user.id)
  const initialKind = sp.kind && isCampaignKind(sp.kind) ? sp.kind : undefined

  return (
    <div className="space-y-5">
      <MarketingSubnav />
      <PageHeader title="Campaign Builder" description="Pick a theme — Spring Cleanup, Snow & Ice, Reviews, Win-back — and generate a post for every platform at once." />
      <CampaignBuilder
        userId={user.id}
        aiEnabled={aiEnabled()}
        initialCampaigns={campaigns}
        initialKind={initialKind}
        initialHoliday={sp.holiday || null}
      />
    </div>
  )
}
