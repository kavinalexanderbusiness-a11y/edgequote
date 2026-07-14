import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/layout/PageHeader'
import { IdeasClient } from '@/components/grow/marketing/IdeasClient'
import { listCandidates } from '@/lib/marketing/data'
import { listRecentPieces } from '@/lib/marketing/library'
import { buildIdeas } from '@/lib/marketing/ideas'
import { fetchForecast } from '@/lib/weather'

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Best-effort rain check from any located property — never blocks the page.
async function rainSoon(supabase: Awaited<ReturnType<typeof createClient>>, userId: string): Promise<boolean> {
  try {
    const { data } = await supabase.from('properties')
      .select('latitude, longitude').eq('user_id', userId)
      .not('latitude', 'is', null).not('longitude', 'is', null).limit(1).maybeSingle()
    const p = data as { latitude: number; longitude: number } | null
    if (!p) return false
    const forecast = await fetchForecast(p.latitude, p.longitude, 3)
    return forecast.some(d => d.rainy)
  } catch {
    return false
  }
}

// Marketing Suggestions + Content Reuse — "what should I post?", from signals the app
// already holds. Deterministic; the cards link into the real generators.
export default async function IdeasPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const userId = user.id
  const today = todayISO()
  const in7 = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString().slice(0, 10) })()
  const ago14 = (() => { const d = new Date(); d.setDate(d.getDate() - 14); return d.toISOString() })()

  const [candidates, pieces, reviewsRes, jobsRes, rainInForecast] = await Promise.all([
    listCandidates(supabase, userId),
    listRecentPieces(supabase, userId, 200),
    supabase.from('customers').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('reviewed_at', ago14),
    supabase.from('jobs').select('id', { count: 'exact', head: true }).eq('user_id', userId).in('status', ['scheduled', 'in_progress']).gte('scheduled_date', today).lte('scheduled_date', in7),
    rainSoon(supabase, userId),
  ])

  const ideas = buildIdeas({
    todayISO: today,
    candidates,
    pieces,
    reviewsLast14: reviewsRes.count ?? 0,
    upcomingJobsNext7: jobsRes.count ?? null,
    rainInForecast,
  })

  return (
    <div className="space-y-5">
      <PageHeader title="Marketing Ideas" description="Timely suggestions and ways to reuse what you’ve already made — from your jobs, reviews, season and weather." />
      <IdeasClient ideas={ideas} pieces={pieces} />
    </div>
  )
}
