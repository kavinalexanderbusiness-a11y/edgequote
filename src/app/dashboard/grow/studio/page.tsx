import { createClient } from '@/lib/supabase/server'
import { listCandidates } from '@/lib/marketing/data'
import { aiEnabled } from '@/lib/ai/studioGateway'
import { StudioClient } from '@/components/grow/marketing/StudioClient'

// Marketing Studio — the hero flow. Server-fetches the owner's postable jobs
// (scored live) + branding, then hands off to the interactive composer.
export default async function StudioPage({ searchParams }: { searchParams: Promise<{ job?: string }> }) {
  const sp = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null // the dashboard layout already redirects unauthenticated users

  const [candidates, bizRes] = await Promise.all([
    listCandidates(supabase, user.id),
    supabase.from('business_settings').select('company_name, logo_url').eq('user_id', user.id).maybeSingle(),
  ])
  const biz = bizRes.data as { company_name: string | null; logo_url: string | null } | null

  return (
    <div className="space-y-5">
      <StudioClient
        candidates={candidates}
        aiEnabled={aiEnabled()}
        businessName={biz?.company_name || 'Your business'}
        logoUrl={biz?.logo_url || null}
        userId={user.id}
        initialJobId={sp.job}
      />
    </div>
  )
}
