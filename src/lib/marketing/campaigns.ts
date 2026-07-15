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
  { kind: 'spring',     label: 'Spring Cleanup',    icon: Flower2,     description: 'Kick off the season — spring cleanup, first cuts, get on the schedule.', anchorMode: 'either', defaultChannels: ALL, season: 'spring', defaultName: 'Spring Cleanup' },
  { kind: 'summer',     label: 'Summer Care',       icon: Sun,         description: 'Peak-season mowing & maintenance — keep lawns crisp through the heat.',    anchorMode: 'either', defaultChannels: ALL, season: 'summer', defaultName: 'Summer Lawn Care' },
  { kind: 'fall',       label: 'Fall Cleanup',      icon: Leaf,        description: 'Leaf cleanup, aeration, the last tidy before the snow flies.',             anchorMode: 'either', defaultChannels: ALL, season: 'fall',   defaultName: 'Fall Cleanup' },
  { kind: 'winter',     label: 'Snow & Ice',        icon: Snowflake,   description: 'Snow removal & ice control — book your driveway and walks now.',           anchorMode: 'either', defaultChannels: ALL, season: 'winter', defaultName: 'Snow & Ice Removal' },
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
  switch (kind) {
    case 'spring':  return `This post launches a SPRING CLEANUP push. Encourage neighbours${where} to book their spring cleanup / first mow and get on the season's schedule early.`
    case 'summer':  return `This post is part of a SUMMER CARE push. Focus on dependable, regular mowing and keeping lawns healthy through the summer heat.`
    case 'fall':    return `This post launches a FALL CLEANUP push. Focus on leaf cleanup and getting the yard ready before the snow.`
    case 'winter':  return `This post is part of a SNOW & ICE push. Encourage neighbours to lock in reliable snow removal for their driveway and walks before the first storm.`
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
  facts.push(`Business: ${voice.businessName}, a local property-care business${voice.city ? ` in ${voice.city}` : ''}.`)
  switch (kind) {
    case 'spring': facts.push('Theme: spring cleanup and the first cuts of the year.'); break
    case 'summer': facts.push('Theme: regular summer mowing and lawn health in the heat.'); break
    case 'fall':   facts.push('Theme: fall leaf cleanup and getting yards ready for winter.'); break
    case 'winter': facts.push('Theme: snow removal and ice control for driveways and walks.'); break
    case 'holiday': facts.push(`Theme: a friendly seasonal greeting${opts?.holiday ? ` for ${opts.holiday}` : ''}.`); break
    case 'rain_delay': facts.push('Theme: a weather/scheduling update — possible rain delays and fair rescheduling.'); break
    case 'referral': facts.push('Theme: word-of-mouth referrals from happy customers.'); break
    case 'review': facts.push('Theme: inviting recent customers to leave a review.'); break
    case 'winback': facts.push('Theme: reconnecting with past customers.'); break
    default: facts.push('Theme: a general update from the business.')
  }
  return { facts, season, neighborhood: null, city: voice.city }
}
