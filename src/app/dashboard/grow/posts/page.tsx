import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/layout/PageHeader'
import { PostsManager } from '@/components/grow/marketing/PostsManager'
import { listPieces, listCampaigns } from '@/lib/marketing/library'

// All posts — searchable, filterable history with favorite / duplicate / archive.
export default async function PostsPage({ searchParams }: { searchParams: Promise<{ campaign?: string }> }) {
  const sp = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const campaignId = sp.campaign || null
  const [{ pieces, hasMore }, campaigns] = await Promise.all([
    listPieces(supabase, user.id, { campaignId }, 0),
    listCampaigns(supabase, user.id),
  ])

  return (
    <div className="space-y-5">
      <PageHeader title="All Posts" description="Your full content history — search and filter to reuse anything." />
      <PostsManager
        userId={user.id}
        initialPieces={pieces}
        initialHasMore={hasMore}
        campaigns={campaigns}
        initialCampaignId={campaignId}
      />
    </div>
  )
}
