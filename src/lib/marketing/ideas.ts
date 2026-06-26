import { upcomingHolidays, upcomingSeasonReminders } from './holidays'
import type { CampaignKind, ContentPiece, MarketingCandidate } from './types'

// ── Marketing suggestions ("what should I post?") ─────────────────────────────────
// A deterministic engine that turns signals the app already holds — finished jobs,
// recent reviews, posting cadence, the season/holiday calendar, a slow week, weather —
// into a ranked list of timely nudges with a one-tap action. NO AI: these are rules,
// instant and explainable. The owner acts on a card and the real generator (Studio /
// Campaigns) does the writing.

export type IdeaKind =
  | 'new_reviews' | 'post_job' | 'inactive' | 'season_start'
  | 'holiday' | 'slow_week' | 'weather' | 'ready_backlog'

export interface MarketingIdea {
  id: string
  kind: IdeaKind
  priority: number          // higher = surfaced first
  title: string
  detail: string
  actionLabel: string
  href: string
}

export interface IdeaInput {
  todayISO: string                 // yyyy-mm-dd
  candidates: MarketingCandidate[] // scored postable jobs, best-first
  pieces: Pick<ContentPiece, 'status' | 'published_at' | 'created_at' | 'job_id'>[]
  reviewsLast14: number
  upcomingJobsNext7?: number | null
  rainInForecast?: boolean
}

function daysBetween(aISO: string, bISO: string): number {
  const a = new Date(aISO + (aISO.length <= 10 ? 'T00:00:00' : ''))
  const b = new Date(bISO + (bISO.length <= 10 ? 'T00:00:00' : ''))
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

const campaignHref = (kind: CampaignKind, extra?: string) =>
  `/dashboard/grow/campaigns?kind=${kind}${extra ? `&${extra}` : ''}`

export function buildIdeas(input: IdeaInput): MarketingIdea[] {
  const { todayISO, candidates, pieces, reviewsLast14 } = input
  const ideas: MarketingIdea[] = []

  // 1) Fresh reviews — strong social proof, act fast.
  if (reviewsLast14 > 0) {
    ideas.push({
      id: 'new_reviews',
      kind: 'new_reviews',
      priority: 90 + Math.min(reviewsLast14, 5),
      title: reviewsLast14 >= 3 ? `You just received ${reviewsLast14} new reviews` : `You received ${reviewsLast14} new review${reviewsLast14 > 1 ? 's' : ''}`,
      detail: 'Happy customers are your best marketing. Turn them into a review-drive post and thank them publicly.',
      actionLabel: 'Start a review campaign',
      href: campaignHref('review'),
    })
  }

  // 2) Posting cadence — when did you last publish?
  const published = pieces.filter(p => p.status === 'published' && p.published_at)
  const lastPublished = published.map(p => p.published_at!).sort().at(-1) || null
  const sinceLast = lastPublished ? daysBetween(lastPublished.slice(0, 10), todayISO) : null
  if (sinceLast === null) {
    if (candidates.length) {
      ideas.push({
        id: 'inactive_never',
        kind: 'inactive',
        priority: 80,
        title: 'You haven’t posted yet',
        detail: 'You’ve got finished jobs ready to become posts. The first one takes a minute.',
        actionLabel: 'Create your first post',
        href: '/dashboard/grow/studio',
      })
    }
  } else if (sinceLast >= 5) {
    ideas.push({
      id: 'inactive_gap',
      kind: 'inactive',
      priority: 70 + Math.min(sinceLast, 20),
      title: `You haven’t posted in ${sinceLast} days`,
      detail: 'Consistency keeps you top-of-mind with neighbours. A quick post today helps.',
      actionLabel: 'Post something',
      href: '/dashboard/grow/studio',
    })
  }

  // 3) A specific great job to post today (top unposted candidate).
  const postedJobIds = new Set(published.map(p => p.job_id).filter(Boolean) as string[])
  const topUnposted = candidates.find(c => !postedJobIds.has(c.jobId) && c.score >= 50)
  if (topUnposted) {
    const where = topUnposted.neighborhood ? ` in ${topUnposted.neighborhood}` : ''
    const svc = (topUnposted.serviceType || 'job').toLowerCase()
    ideas.push({
      id: `post_job:${topUnposted.jobId}`,
      kind: 'post_job',
      priority: 60 + Math.round(topUnposted.score / 5),
      title: `Post your ${svc}${where}`,
      detail: topUnposted.rationale,
      actionLabel: 'Draft this post',
      href: `/dashboard/grow/studio?job=${topUnposted.jobId}`,
    })
  }

  // 4) Season turn-points.
  for (const r of upcomingSeasonReminders(todayISO, 21).slice(0, 1)) {
    const inDays = daysBetween(todayISO, r.date)
    ideas.push({
      id: `season:${r.season}:${r.edge}`,
      kind: 'season_start',
      priority: 65 - Math.max(0, inDays),
      title: r.label,
      detail: inDays <= 0 ? 'It’s here — get ahead of your neighbours with a seasonal push.' : `Starts in ${inDays} day${inDays === 1 ? '' : 's'}. Line up a campaign now.`,
      actionLabel: 'Build the campaign',
      href: campaignHref(r.campaignKind),
    })
  }

  // 5) Upcoming holiday.
  for (const h of upcomingHolidays(todayISO, 21).slice(0, 1)) {
    const inDays = daysBetween(todayISO, h.date)
    ideas.push({
      id: `holiday:${h.date}`,
      kind: 'holiday',
      priority: 50 - Math.max(0, inDays),
      title: `${h.name} is coming up`,
      detail: h.marketingAngle,
      actionLabel: 'Plan a holiday post',
      href: campaignHref(h.campaignKind === 'custom' ? 'holiday' : h.campaignKind, `holiday=${encodeURIComponent(h.name)}`),
    })
  }

  // 6) Slow week ahead — fill it with content.
  if (typeof input.upcomingJobsNext7 === 'number' && input.upcomingJobsNext7 <= 2) {
    ideas.push({
      id: 'slow_week',
      kind: 'slow_week',
      priority: 55,
      title: 'Quiet week ahead',
      detail: `Only ${input.upcomingJobsNext7} job${input.upcomingJobsNext7 === 1 ? '' : 's'} booked in the next 7 days. Posting now keeps the pipeline full.`,
      actionLabel: 'Plan a week of posts',
      href: '/dashboard/grow/calendar?plan=1',
    })
  }

  // 7) Weather — rain on the way.
  if (input.rainInForecast) {
    ideas.push({
      id: 'weather_rain',
      kind: 'weather',
      priority: 45,
      title: 'Rain in the forecast',
      detail: 'Get ahead of it — a friendly weather update reassures customers you’ll reschedule fairly.',
      actionLabel: 'Post a weather update',
      href: campaignHref('rain_delay'),
    })
  }

  // 8) Backlog of ready-to-post jobs.
  const readyCount = candidates.filter(c => !postedJobIds.has(c.jobId) && (c.hasAfter || c.hasBefore)).length
  if (readyCount >= 3) {
    ideas.push({
      id: 'ready_backlog',
      kind: 'ready_backlog',
      priority: 40,
      title: `${readyCount} finished jobs ready to post`,
      detail: 'You have a backlog of photo-ready jobs. Batch-generate a month of content in one go.',
      actionLabel: 'Fill my calendar',
      href: '/dashboard/grow/calendar?plan=1',
    })
  }

  return ideas.sort((a, b) => b.priority - a.priority)
}
