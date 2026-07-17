import { Flower2, Sun, Leaf, Snowflake, PartyPopper, CloudRain, Gift, Star, Repeat, Megaphone, type LucideIcon } from 'lucide-react'
import type { BrandVoice } from './brandVoice'
import type { GenSubject } from './prompt'
import type { CampaignKind, MarketingChannel, Season } from './types'

// ── Campaign registry ─────────────────────────────────────────────────────────────
// A campaign is a THEME that fans out into one post per channel. Every kind reduces to
// the same two things the one prompt framework already understands: a SUBJECT (the
// facts to write about) and a DIRECTIVE (the campaign angle). Seasonal campaigns can
// anchor to a real finished job (for a photo + proof); the rest are "themed" — written
// from the business + the campaign angle, inventing no specific job. This is why a new
// campaign type is just a row here, never a new prompt.

export interface CampaignDef {
  kind: CampaignKind
  label: string
  icon: LucideIcon
  description: string
  // 'job'  → needs an anchor job (before/after, proof-of-work)
  // 'themed' → business-level message, no specific job
  // 'either' → uses an anchor job if one is supplied, else themed
  anchorMode: 'job' | 'themed' | 'either'
  defaultChannels: MarketingChannel[]
  season: Season | null
  // suggested name when the owner doesn't type one
  defaultName: string
}

const ALL: MarketingChannel[] = ['facebook', 'instagram', 'threads', 'gbp', 'nextdoor', 'linkedin']
const LOCAL_FIRST: MarketingChannel[] = ['facebook', 'nextdoor', 'gbp', 'instagram', 'threads', 'linkedin']

export const CAMPAIGN_DEFS: CampaignDef[] = [
  // Descriptions and defaultNames are un-overridable picker chrome — they must not
  // name a trade. The trade-specific push lives in campaignDirective below, which
  // sees the owner's real services and only falls back to lawn/snow examples when
  // the business is still unknown (same rule as businessContext).
  { kind: 'spring',     label: 'Spring Kickoff',    icon: Flower2,     description: 'Kick off the season — spring bookings, first visits, get on the schedule.', anchorMode: 'either', defaultChannels: ALL, season: 'spring', defaultName: 'Spring Kickoff' },
  { kind: 'summer',     label: 'Summer Care',       icon: Sun,         description: 'Peak-season work — steady, dependable service through the heat.',    anchorMode: 'either', defaultChannels: ALL, season: 'summer', defaultName: 'Summer Care' },
  { kind: 'fall',       label: 'Fall Push',         icon: Leaf,        description: 'The last big push — cleanup and prep before winter arrives.',             anchorMode: 'either', defaultChannels: ALL, season: 'fall',   defaultName: 'Fall Push' },
  { kind: 'winter',     label: 'Winter Ready',      icon: Snowflake,   description: 'Winter services — get customers booked before the season turns.',           anchorMode: 'either', defaultChannels: ALL, season: 'winter', defaultName: 'Winter Ready' },
  { kind: 'holiday',    label: 'Holiday Promo',     icon: PartyPopper, description: 'Tie a friendly promotion to an upcoming holiday or long weekend.',         anchorMode: 'either', defaultChannels: ALL, season: null,     defaultName: 'Holiday Promotion' },
  { kind: 'rain_delay', label: 'Rain Delay',        icon: CloudRain,   description: 'Heads-up that weather may push the schedule — set expectations kindly.',    anchorMode: 'themed', defaultChannels: LOCAL_FIRST, season: null, defaultName: 'Weather Update' },
  { kind: 'referral',   label: 'Referral Drive',    icon: Gift,        description: 'Ask happy customers to refer someone — word-of-mouth growth.',          anchorMode: 'themed', defaultChannels: LOCAL_FIRST, season: null, defaultName: 'Refer a Friend' },
  { kind: 'review',     label: 'Review Request',    icon: Star,        description: 'Invite recent customers to leave a quick review.',                          anchorMode: 'themed', defaultChannels: LOCAL_FIRST, season: null, defaultName: 'Leave Us a Review' },
  { kind: 'winback',    label: 'Win-Back',          icon: Repeat,      description: 'Reconnect with past customers you haven’t served in a while.',              anchorMode: 'themed', defaultChannels: LOCAL_FIRST, season: null, defaultName: 'We’d Love to Have You Back' },
  { kind: 'custom',     label: 'Custom',            icon: Megaphone,   description: 'A general post in your brand voice across every platform.',                  anchorMode: 'either', defaultChannels: ALL, season: null,     defaultName: 'Marketing Post' },
]

const BY_KIND = CAMPAIGN_DEFS.reduce((acc, d) => { acc[d.kind] = d; return acc }, {} as Record<CampaignKind, CampaignDef>)

export function campaignDef(kind: CampaignKind): CampaignDef {
  return BY_KIND[kind] || BY_KIND.custom
}

export function isCampaignKind(v: unknown): v is CampaignKind {
  return typeof v === 'string' && v in BY_KIND
}

// The campaign angle — appended to the prompt as the CAMPAIGN directive. Reuses the
// owner's brand facts (review link, location) so the call to action is real.
export function campaignDirective(kind: CampaignKind, voice: BrandVoice, opts?: { holiday?: string | null }): string {
  const where = voice.city ? ` in ${voice.city}` : ''
  // Seasonal pushes are about THEIR seasonal services. When we know what the
  // business sells (voice.services rides in via loadBrandVoice), the directive
  // points at those; only a business we can't read yet gets the original lawn/snow
  // examples — the same zero-regression fallback rule as businessContext.
  const known = !!voice.services?.length
  switch (kind) {
    case 'spring':  return known
      ? `This post launches a SPRING push. Encourage neighbours${where} to book the spring services this business sells (see the BUSINESS block) and get on the season's schedule early. Never name a service they don't sell.`
      : `This post launches a SPRING CLEANUP push. Encourage neighbours${where} to book their spring cleanup / first mow and get on the season's schedule early.`
    case 'summer':  return known
      ? `This post is part of a SUMMER push. Focus on dependable, regular service through the summer heat — anchored in the services this business sells (see the BUSINESS block). Never name a service they don't sell.`
      : `This post is part of a SUMMER CARE push. Focus on dependable, regular mowing and keeping lawns healthy through the summer heat.`
    case 'fall':    return known
      ? `This post launches a FALL push. Focus on the fall work this business sells (see the BUSINESS block) and getting properties ready before winter. Never name a service they don't sell.`
      : `This post launches a FALL CLEANUP push. Focus on leaf cleanup and getting the yard ready before the snow.`
    case 'winter':  return known
      ? `This post is part of a WINTER push. Encourage neighbours to book the winter services this business sells (see the BUSINESS block) before the season turns. Never name a service they don't sell.`
      : `This post is part of a SNOW & ICE push. Encourage neighbours to lock in reliable snow removal for their driveway and walks before the first storm.`
    case 'holiday': return `This post ties a friendly seasonal message${opts?.holiday ? ` to ${opts.holiday}` : ' to an upcoming holiday'}. Keep it warm and community-minded — a gentle nudge to book, not a hard sell. Do not invent a specific discount amount unless told one.`
    case 'rain_delay': return `This is a WEATHER UPDATE. Let customers know weather may shift the schedule, that you’ll keep them posted and reschedule fairly. Reassuring and professional — not an apology spiral.`
    case 'referral': return `This is a REFERRAL ASK. Thank existing customers and invite them to refer someone. Friendly and low-pressure. Do not promise a specific reward unless told one.`
    case 'review':   return `This is a REVIEW REQUEST. Warmly invite recent customers to leave a quick review.${voice.reviewUrl ? ` Point them to: ${voice.reviewUrl}.` : ''} Grateful, never pushy.`
    case 'winback':  return `This is a WIN-BACK message to past customers you haven’t served in a while. Warm, no guilt — remind them you’re here and make it easy to come back.`
    default:         return `A general post in the business's brand voice.`
  }
}

// For themed campaigns (no anchor job), the SUBJECT facts. Seasonal/custom prefer a
// real job; if none is supplied they fall back to these business-level facts too.
export function campaignSubject(kind: CampaignKind, voice: BrandVoice, opts?: { holiday?: string | null; season?: Season | null }): GenSubject {
  const facts: string[] = []
  const def = campaignDef(kind)
  const season = opts?.season ?? def.season
  facts.push(`Business: ${voice.businessName}, a local property-services business${voice.city ? ` in ${voice.city}` : ''}.`)
  // Same known/unknown split as campaignDirective: themed facts name the trade only
  // when the business hasn't told us theirs.
  const known = !!voice.services?.length
  switch (kind) {
    case 'spring': facts.push(known ? 'Theme: the spring push — opening the season and the first visits of the year.' : 'Theme: spring cleanup and the first cuts of the year.'); break
    case 'summer': facts.push(known ? 'Theme: dependable, regular service through the summer heat.' : 'Theme: regular summer mowing and lawn health in the heat.'); break
    case 'fall':   facts.push(known ? 'Theme: the fall push — cleanup and prep before winter.' : 'Theme: fall leaf cleanup and getting yards ready for winter.'); break
    case 'winter': facts.push(known ? 'Theme: winter services, booked before the season turns.' : 'Theme: snow removal and ice control for driveways and walks.'); break
    case 'holiday': facts.push(`Theme: a friendly seasonal greeting${opts?.holiday ? ` for ${opts.holiday}` : ''}.`); break
    case 'rain_delay': facts.push('Theme: a weather/scheduling update — possible rain delays and fair rescheduling.'); break
    case 'referral': facts.push('Theme: word-of-mouth referrals from happy customers.'); break
    case 'review': facts.push('Theme: inviting recent customers to leave a review.'); break
    case 'winback': facts.push('Theme: reconnecting with past customers.'); break
    default: facts.push('Theme: a general update from the business.')
  }
  return { facts, season, neighborhood: null, city: voice.city }
}
