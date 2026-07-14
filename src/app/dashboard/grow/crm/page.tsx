'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatTile } from '@/components/ui/StatTile'
import { FollowUpRadar } from '@/components/grow/FollowUpRadar'
import { CampaignManager } from '@/components/grow/CampaignManager'
import { reviewStatus, type ReviewStatus } from '@/lib/crm/reviews'
import { loadFollowUpRadar } from '@/lib/crm/radar'
import { Referral } from '@/types'
import { ArrowLeft, Star, Gift, Zap, MessageSquare, Clock, HeartPulse, Cake, ArrowRight } from 'lucide-react'

// Grow → Customer Automation hub. Per-customer review/referral/birthday details
// live on the customer profile + messaging; this page is the management + rollup
// layer: review pipeline, referral pipeline, the follow-up radar, and the
// campaign engine.
export default function CrmAutomationPage() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [uid, setUid] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reviews, setReviews] = useState({ reviewed: 0, requested: 0, declined: 0, notAsked: 0, avg: 0 })
  const [refs, setRefs] = useState({ joined: 0, invited: 0, rewarded: 0 })
  // Due-now counts — the same engines that power the sections below (the follow-up
  // radar + the customers' campaign dates), rolled up so nothing needs scrolling to find.
  const [due, setDue] = useState({ unanswered: 0, quiet: 0, celebrations: 0 })

  // Month+day within the next `days`, ignoring year (same semantics the campaign
  // engine fires on — this just previews the coming week).
  function upcomingWithinDays(dateStr: string | null, days: number): boolean {
    if (!dateStr) return false
    const p = String(dateStr).slice(0, 10).split('-')
    const m = Number(p[1]), d = Number(p[2])
    if (!m || !d) return false
    const now = new Date()
    for (let i = 0; i < days; i++) {
      const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)
      if (t.getMonth() + 1 === m && t.getDate() === d) return true
    }
    return false
  }

  async function load() {
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    setUid(user?.id || null)
    if (!user) { setLoading(false); return }
    const [custRes, refRes, radar] = await Promise.all([
      supabase.from('customers').select('reviewed_at, review_requested_at, review_declined_at, review_rating, birthday, anniversary').eq('user_id', user.id).is('archived_at', null),
      supabase.from('referrals').select('status').eq('user_id', user.id),
      loadFollowUpRadar(supabase),
    ])
    const custs = (custRes.data as { reviewed_at: string | null; review_requested_at: string | null; review_declined_at: string | null; review_rating: number | null; birthday: string | null; anniversary: string | null }[]) || []
    const counts: Record<ReviewStatus, number> = { reviewed: 0, requested: 0, declined: 0, not_requested: 0 }
    let ratingSum = 0, ratingN = 0, celebrations = 0
    for (const c of custs) {
      counts[reviewStatus(c)]++
      if (c.reviewed_at && c.review_rating) { ratingSum += c.review_rating; ratingN++ }
      if (upcomingWithinDays(c.birthday, 7) || upcomingWithinDays(c.anniversary, 7)) celebrations++
    }
    setReviews({ reviewed: counts.reviewed, requested: counts.requested, declined: counts.declined, notAsked: counts.not_requested, avg: ratingN ? ratingSum / ratingN : 0 })
    setDue({
      unanswered: radar.filter(r => r.unansweredInbound).length,
      quiet: radar.filter(r => !r.unansweredInbound).length,
      celebrations,
    })

    const rstatus = (refRes.data as Pick<Referral, 'status'>[]) || []
    setRefs({
      joined: rstatus.filter(r => r.status === 'joined').length,
      invited: rstatus.filter(r => r.status === 'invited').length,
      rewarded: rstatus.filter(r => r.status === 'rewarded').length,
    })
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useRealtimeRefresh('customers', uid ? `user_id=eq.${uid}` : null, load)
  useRealtimeRefresh('referrals', uid ? `user_id=eq.${uid}` : null, load)

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => router.back()} aria-label="Go back" className="text-ink-muted hover:text-ink transition-colors rounded p-1 -m-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"><ArrowLeft className="w-4 h-4" /></button>
        <PageHeader title="Customer Automation" description="Reviews, referrals, follow-ups and campaigns — all wired into your customers and messaging." />
      </div>

      {/* Due now — proactive rollup of the SAME engines below (radar + campaign dates
          + review lifecycle). Only shows what actually needs action; every card is
          the action. Silent when everything is handled. */}
      {!loading && (due.unanswered + due.quiet + due.celebrations + reviews.notAsked) > 0 && (
        <div className="rounded-card border border-accent/25 hero-aurora p-4 sm:p-5 animate-rise">
          <div className="flex items-center gap-2.5 mb-3">
            <span className="w-7 h-7 rounded-lg bg-accent/15 border border-accent/25 icon-glow flex items-center justify-center shrink-0">
              <Zap className="w-4 h-4 text-accent" />
            </span>
            <div>
              <p className="text-sm font-bold tracking-tight text-ink">Due now</p>
              <p className="text-[11px] text-ink-muted">What your customer engine says needs a human today.</p>
            </div>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {due.unanswered > 0 && (
              <Link href="/dashboard/messages" className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                <StatTile icon={MessageSquare} tone="danger" label="Awaiting your reply" value={String(due.unanswered)}
                  sub={<span className="inline-flex items-center gap-1">Open inbox <ArrowRight className="w-3 h-3" /></span>} />
              </Link>
            )}
            {due.quiet > 0 && (
              <a href="#followup-radar" className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                <StatTile icon={Clock} tone="warn" label="Gone quiet 30+ days" value={String(due.quiet)}
                  sub={<span className="inline-flex items-center gap-1">Follow-up radar <ArrowRight className="w-3 h-3" /></span>} />
              </a>
            )}
            {reviews.notAsked > 0 && (
              <Link href="/dashboard/customers" className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                <StatTile icon={Star} tone="accent" label="Never asked for a review" value={String(reviews.notAsked)}
                  sub={<span className="inline-flex items-center gap-1">Bulk-request from Customers <ArrowRight className="w-3 h-3" /></span>} />
              </Link>
            )}
            {due.celebrations > 0 && (
              <a href="#campaigns" className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                <StatTile icon={Cake} tone="success" label="Birthdays / anniversaries" value={String(due.celebrations)}
                  sub={<span className="inline-flex items-center gap-1">Next 7 days · campaigns <ArrowRight className="w-3 h-3" /></span>} />
              </a>
            )}
            <Link href="/dashboard/reactivation" className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              <StatTile icon={HeartPulse} label="Win-back opportunities" value={<ArrowRight className="w-5 h-5" />}
                sub="Lapsed customers, valued & ranked" />
            </Link>
          </div>
        </div>
      )}

      {/* Pipeline rollups */}
      <div className="grid sm:grid-cols-2 gap-3 animate-rise stagger-2">
        <Card className="p-5 card-lift">
          <div className="flex items-center gap-2 mb-3">
            <Star className="w-4 h-4 text-amber-400" />
            <p className="text-sm font-bold tracking-tight text-ink">Reviews</p>
            {!loading && reviews.avg > 0 && <span className="ml-auto text-xs text-ink-muted flex items-center gap-1"><Star className="w-3 h-3 text-amber-400 fill-amber-400" /> {reviews.avg.toFixed(1)} avg</span>}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Reviewed" value={reviews.reviewed} tone="success" loading={loading} />
            <Stat label="Requested" value={reviews.requested} tone="warn" loading={loading} />
            <Stat label="Not asked" value={reviews.notAsked} loading={loading} />
          </div>
          <p className="text-[11px] text-ink-faint mt-3">Ask from any customer’s profile, or auto-ask after a completed visit (Settings → Automated messages).</p>
        </Card>

        <Card className="p-5 card-lift">
          <div className="flex items-center gap-2 mb-3">
            <Gift className="w-4 h-4 text-accent" />
            <p className="text-sm font-bold tracking-tight text-ink">Referrals</p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Joined" value={refs.joined} tone="success" loading={loading} />
            <Stat label="Invited" value={refs.invited} tone="warn" loading={loading} />
            <Stat label="Rewarded" value={refs.rewarded} tone="accent" loading={loading} />
          </div>
          <p className="text-[11px] text-ink-faint mt-3">Record referrals on a customer’s profile. Customers added with a referrer link in automatically.</p>
        </Card>
      </div>

      {/* Follow-up radar */}
      <div id="followup-radar" className="scroll-mt-4"><FollowUpRadar /></div>

      {/* Campaign engine */}
      <div id="campaigns" className="scroll-mt-4"><CampaignManager /></div>
    </div>
  )
}

// Thin adapter over the ONE shared KPI tile (loading renders the skeleton in place).
function Stat({ label, value, tone, loading }: { label: string; value: number; tone?: 'success' | 'warn' | 'accent'; loading?: boolean }) {
  return <StatTile label={label} tone={tone} value={loading ? <Skeleton className="h-7 w-8" /> : String(value)} />
}
