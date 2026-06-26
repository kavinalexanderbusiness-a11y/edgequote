'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { FollowUpRadar } from '@/components/grow/FollowUpRadar'
import { CampaignManager } from '@/components/grow/CampaignManager'
import { reviewStatus, type ReviewStatus } from '@/lib/crm/reviews'
import { Referral } from '@/types'
import { ArrowLeft, Star, Gift } from 'lucide-react'

// Grow → Customer Automation hub. Per-customer review/referral/birthday details
// live on the customer profile + messaging; this page is the management + rollup
// layer: review pipeline, referral pipeline, the follow-up radar, and the
// campaign engine.
export default function CrmAutomationPage() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [uid, setUid] = useState<string | null>(null)
  const [reviews, setReviews] = useState({ reviewed: 0, requested: 0, declined: 0, notAsked: 0, avg: 0 })
  const [refs, setRefs] = useState({ joined: 0, invited: 0, rewarded: 0 })

  async function load() {
    const { data: { user } } = await supabase.auth.getUser()
    setUid(user?.id || null)
    if (!user) return
    const [custRes, refRes] = await Promise.all([
      supabase.from('customers').select('reviewed_at, review_requested_at, review_declined_at, review_rating').eq('user_id', user.id).is('archived_at', null),
      supabase.from('referrals').select('status').eq('user_id', user.id),
    ])
    const custs = (custRes.data as { reviewed_at: string | null; review_requested_at: string | null; review_declined_at: string | null; review_rating: number | null }[]) || []
    const counts: Record<ReviewStatus, number> = { reviewed: 0, requested: 0, declined: 0, not_requested: 0 }
    let ratingSum = 0, ratingN = 0
    for (const c of custs) {
      counts[reviewStatus(c)]++
      if (c.reviewed_at && c.review_rating) { ratingSum += c.review_rating; ratingN++ }
    }
    setReviews({ reviewed: counts.reviewed, requested: counts.requested, declined: counts.declined, notAsked: counts.not_requested, avg: ratingN ? ratingSum / ratingN : 0 })

    const rstatus = (refRes.data as Pick<Referral, 'status'>[]) || []
    setRefs({
      joined: rstatus.filter(r => r.status === 'joined').length,
      invited: rstatus.filter(r => r.status === 'invited').length,
      rewarded: rstatus.filter(r => r.status === 'rewarded').length,
    })
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useRealtimeRefresh('customers', uid ? `user_id=eq.${uid}` : null, load)
  useRealtimeRefresh('referrals', uid ? `user_id=eq.${uid}` : null, load)

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => router.back()} className="text-ink-muted hover:text-ink transition-colors"><ArrowLeft className="w-4 h-4" /></button>
        <PageHeader title="Customer Automation" description="Reviews, referrals, follow-ups and campaigns — all wired into your customers and messaging." />
      </div>

      {/* Pipeline rollups */}
      <div className="grid sm:grid-cols-2 gap-3">
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <Star className="w-4 h-4 text-amber-400" />
            <p className="text-sm font-bold text-ink">Reviews</p>
            {reviews.avg > 0 && <span className="ml-auto text-xs text-ink-muted flex items-center gap-1"><Star className="w-3 h-3 text-amber-400 fill-amber-400" /> {reviews.avg.toFixed(1)} avg</span>}
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat label="Reviewed" value={reviews.reviewed} tone="text-emerald-400" />
            <Stat label="Requested" value={reviews.requested} tone="text-amber-400" />
            <Stat label="Not asked" value={reviews.notAsked} tone="text-ink" />
          </div>
          <p className="text-[11px] text-ink-faint mt-3">Ask from any customer’s profile, or auto-ask after a completed visit (Settings → Automated messages).</p>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <Gift className="w-4 h-4 text-accent" />
            <p className="text-sm font-bold text-ink">Referrals</p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat label="Joined" value={refs.joined} tone="text-emerald-400" />
            <Stat label="Invited" value={refs.invited} tone="text-amber-400" />
            <Stat label="Rewarded" value={refs.rewarded} tone="text-accent" />
          </div>
          <p className="text-[11px] text-ink-faint mt-3">Record referrals on a customer’s profile. Customers added with a referrer link in automatically.</p>
        </Card>
      </div>

      {/* Follow-up radar */}
      <FollowUpRadar />

      {/* Campaign engine */}
      <CampaignManager />
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface py-3">
      <p className={`text-2xl font-black tracking-tight ${tone}`}>{value}</p>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint mt-0.5">{label}</p>
    </div>
  )
}
