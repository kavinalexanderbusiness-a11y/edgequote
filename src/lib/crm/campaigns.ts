// ── CRM campaigns (pure) ─────────────────────────────────────────────────────
// Types, presets, dedupe-period keys and trigger-matching for the customer-
// centric campaign engine (migration 2026-06-25h). NO I/O — both the daily cron
// (/api/cron/campaigns) and the Campaign Manager UI import these so the rules are
// defined once. Sending always reuses the existing comms pipeline + templates.

import type { CampaignKind, CampaignAudience, CampaignSchedule, CrmCampaign } from '@/types'
import type { MsgType } from '@/lib/comms/templates'

export type { CampaignKind } from '@/types'

export interface CampaignKindMeta {
  label: string
  blurb: string
  defaultTemplate: MsgType
  defaultChannels: string[]
  defaultSchedule: CampaignSchedule
  /** Which schedule control the editor shows. */
  timing: 'lead_days' | 'quiet_days' | 'monthly' | 'calendar_date'
  /** Audience switches that make sense for this kind (order is the UI order). */
  audienceKeys: (keyof CampaignAudience)[]
}

export const CAMPAIGN_KINDS: Record<CampaignKind, CampaignKindMeta> = {
  birthday: {
    label: 'Birthday greeting',
    blurb: 'Sends on each customer’s birthday. Needs a birthday on the profile.',
    defaultTemplate: 'birthday',
    defaultChannels: ['sms', 'email'],
    defaultSchedule: { lead_days: 0 },
    timing: 'lead_days',
    audienceKeys: ['recurring_only'],
  },
  anniversary: {
    label: 'Anniversary greeting',
    blurb: 'Sends on the anniversary date you set on the profile (e.g. their first year).',
    defaultTemplate: 'anniversary',
    defaultChannels: ['email'],
    defaultSchedule: { lead_days: 0 },
    timing: 'lead_days',
    audienceKeys: ['recurring_only'],
  },
  win_back: {
    label: 'Win-back',
    blurb: 'Re-engages customers you haven’t messaged in a while. Self-limits — sending resets their clock.',
    defaultTemplate: 'win_back',
    defaultChannels: ['sms', 'email'],
    defaultSchedule: { days: 45 },
    timing: 'quiet_days',
    audienceKeys: [],
  },
  broadcast: {
    label: 'Recurring check-in',
    blurb: 'A scheduled marketing message to your customers on a repeating cadence.',
    defaultTemplate: 'marketing',
    defaultChannels: ['email'],
    defaultSchedule: { day_of_month: 1, every_months: 1 },
    timing: 'monthly',
    audienceKeys: ['recurring_only'],
  },
  seasonal: {
    label: 'Seasonal offer',
    blurb: 'Fires once a year on a date you pick — spring cleanups, fall aeration, snow bookings.',
    defaultTemplate: 'seasonal_offer',
    defaultChannels: ['email'],
    defaultSchedule: { month: 4, day: 1 },
    timing: 'calendar_date',
    audienceKeys: ['recurring_only'],
  },
  referral: {
    label: 'Referral ask',
    blurb: 'Asks customers to refer a neighbour. Pair with “happy customers only” so you only ask people who already rated you well.',
    defaultTemplate: 'referral_request',
    defaultChannels: ['email'],
    defaultSchedule: { day_of_month: 15, every_months: 6 },
    timing: 'monthly',
    audienceKeys: ['happy_only', 'recurring_only'],
  },
  review: {
    label: 'Review ask',
    blurb: 'Chases customers who haven’t left a review yet. The day-after review automation covers new jobs; this one sweeps up the rest.',
    defaultTemplate: 'review_request',
    defaultChannels: ['sms', 'email'],
    defaultSchedule: { day_of_month: 1, every_months: 3 },
    timing: 'monthly',
    audienceKeys: ['not_reviewed', 'recurring_only'],
  },
}

export const AUDIENCE_LABELS: Record<keyof CampaignAudience, string> = {
  recurring_only: 'Only recurring customers',
  not_reviewed: 'Only customers who haven’t reviewed yet',
  happy_only: 'Only happy customers (reviewed 4★ or better)',
}

// ── Seasonal templates ───────────────────────────────────────────────────────
// Ready-made seasonal campaigns. A new season is a row here — never new code.
// Copy is Canada-first lawn care; the owner can edit any of it after creating.
export interface SeasonalTemplate {
  key: string
  label: string
  blurb: string
  month: number
  day: number
  subject: string
  body: string
  channels: string[]
}

export const SEASONAL_TEMPLATES: SeasonalTemplate[] = [
  {
    key: 'spring_cleanup',
    label: 'Spring cleanup',
    blurb: 'Books spring cleanups as the snow goes. Sends April 1.',
    month: 4, day: 1,
    subject: 'Booking spring cleanups now',
    channels: ['email'],
    body: `Hi {{first_name}},

Spring is here and we're booking cleanups now — winter debris, first cut, and a tidy edge to start the season right.

Reply to this message and we'll get you on the schedule before the rush.

Thank you!

— {{business_name}}`,
  },
  {
    key: 'summer_check',
    label: 'Mid-summer check-in',
    blurb: 'Catches heat-stress and upsells extras. Sends July 1.',
    month: 7, day: 1,
    subject: 'How’s the lawn holding up?',
    channels: ['email'],
    body: `Hi {{first_name}},

We're into the hot stretch of summer — the time of year lawns start to show stress.

If anything's looking dry, patchy, or overgrown, reply to this message and we'll take a look on our next visit.

— {{business_name}}`,
  },
  {
    key: 'fall_cleanup',
    label: 'Fall cleanup & aeration',
    blurb: 'The biggest seasonal earner. Sends September 15.',
    month: 9, day: 15,
    subject: 'Fall cleanup & aeration — booking now',
    channels: ['sms', 'email'],
    body: `Hi {{first_name}},

Leaf season is nearly here. We're booking fall cleanups and aeration now — aerating before the freeze is the single best thing you can do for next spring's lawn.

Reply to this message and we'll reserve a spot for you.

Thank you!

— {{business_name}}`,
  },
  {
    key: 'winter_prep',
    label: 'Winter / snow booking',
    blurb: 'Locks in snow customers before the first fall. Sends October 15.',
    month: 10, day: 15,
    subject: 'Booking snow clearing for this winter',
    channels: ['sms', 'email'],
    body: `Hi {{first_name}},

Before the first snow catches us all out — we're booking winter clearing now.

Spots are limited and go to existing customers first. Reply to this message if you'd like yours held.

— {{business_name}}`,
  },
  {
    key: 'holiday_thanks',
    label: 'Holiday thank-you',
    blurb: 'A warm, no-ask thank-you. Sends December 15.',
    month: 12, day: 15,
    subject: 'Thank you for a great year',
    channels: ['email'],
    body: `Hi {{first_name}},

As the year winds down, we just wanted to say thank you for trusting us with your property this season. It genuinely means a lot to a small local business.

Wishing you and your family a wonderful holiday.

— {{business_name}}`,
  },
]

// ── Presets ──────────────────────────────────────────────────────────────────
// One-tap starting points for the "New campaign" menu. Owner-saved presets live
// in crm_campaign_presets and are merged in by the UI; these are the built-ins.
export interface CampaignPreset {
  kind: CampaignKind
  name: string
  channels: string[]
  schedule: CampaignSchedule
  audience: CampaignAudience
  custom_body?: string
  subject?: string
  /** Set when the preset came from SEASONAL_TEMPLATES. */
  seasonalKey?: string
}

export const CAMPAIGN_PRESETS: CampaignPreset[] = [
  { kind: 'birthday',    name: 'Birthday greeting',        channels: ['sms', 'email'], schedule: { lead_days: 0 }, audience: {} },
  { kind: 'anniversary', name: 'Customer anniversary',     channels: ['email'],        schedule: { lead_days: 0 }, audience: {} },
  { kind: 'win_back',    name: 'Win back quiet customers', channels: ['sms'],          schedule: { days: 45 },     audience: {} },
  { kind: 'broadcast',   name: 'Monthly check-in',         channels: ['email'],        schedule: { day_of_month: 1, every_months: 1 }, audience: {} },
  { kind: 'referral',    name: 'Ask happy customers for referrals', channels: ['email'], schedule: { day_of_month: 15, every_months: 6 }, audience: { happy_only: true } },
  { kind: 'review',      name: 'Chase missing reviews',    channels: ['sms', 'email'], schedule: { day_of_month: 1, every_months: 3 }, audience: { not_reviewed: true } },
  ...SEASONAL_TEMPLATES.map((s): CampaignPreset => ({
    kind: 'seasonal',
    name: s.label,
    channels: s.channels,
    schedule: { month: s.month, day: s.day },
    audience: {},
    custom_body: s.body,
    subject: s.subject,
    seasonalKey: s.key,
  })),
]

// Days in the given month (1-based month). Used to clamp a broadcast day_of_month
// so "the 31st" still fires on a 30-day month.
function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate()
}

// Month (1-12) + day for a 'YYYY-MM-DD' date string, parsed without timezone
// drift (string split, not Date).
export function monthDayOf(dateStr: string | null | undefined): { month: number; day: number } | null {
  if (!dateStr) return null
  const p = String(dateStr).slice(0, 10).split('-')
  if (p.length < 3) return null
  const month = Number(p[1]), day = Number(p[2])
  if (!month || !day) return null
  return { month, day }
}

// The calendar date a birthday/anniversary campaign treats as "today" — shifted
// forward by lead_days so a "3 days early" greeting fires on time.
export function occurrenceDate(today: Date, leadDays: number): Date {
  const d = new Date(today.getTime())
  d.setUTCDate(d.getUTCDate() + (leadDays || 0))
  return d
}

// Does a birthday/anniversary fall on the campaign's target day (today + lead)?
export function dateFieldFiresToday(dateStr: string | null | undefined, today: Date, leadDays: number): boolean {
  const md = monthDayOf(dateStr)
  if (!md) return false
  const target = occurrenceDate(today, leadDays)
  return md.month === target.getUTCMonth() + 1 && md.day === target.getUTCDate()
}

// Does a broadcast fire today, given { day_of_month, every_months }? The cadence
// is anchored on absolute calendar months so it stays stable across years.
export function broadcastFiresToday(schedule: CampaignSchedule, today: Date): boolean {
  const dom = schedule.day_of_month || 1
  const every = Math.max(1, schedule.every_months || 1)
  const y = today.getUTCFullYear(), m = today.getUTCMonth() + 1
  const effectiveDay = Math.min(dom, daysInMonth(y, m))
  if (today.getUTCDate() !== effectiveDay) return false
  return (y * 12 + (m - 1)) % every === 0
}

// Does a seasonal campaign fire today? One fixed calendar date per year; the day
// is clamped to the month's length so Feb 30 still fires on the 28th.
export function seasonalFiresToday(schedule: CampaignSchedule, today: Date): boolean {
  const month = schedule.month || 1
  const y = today.getUTCFullYear(), m = today.getUTCMonth() + 1
  if (m !== month) return false
  const effectiveDay = Math.min(schedule.day || 1, daysInMonth(y, month))
  return today.getUTCDate() === effectiveDay
}

// Is today inside the campaign's optional active window? Applies to EVERY kind —
// it's how a seasonal campaign stops firing once its season is over without the
// owner having to remember to disable it. Missing bound = open-ended.
export function campaignWindowOpen(schedule: CampaignSchedule, today: Date): boolean {
  const iso = today.toISOString().slice(0, 10)
  if (schedule.starts_on && iso < String(schedule.starts_on).slice(0, 10)) return false
  if (schedule.ends_on && iso > String(schedule.ends_on).slice(0, 10)) return false
  return true
}

// THE one "does this campaign fire today" rule, for every kind. Date-of-birth
// style kinds still filter per-customer afterwards (dateFieldFiresToday); this
// is the campaign-level gate the cron checks before it queries an audience.
export function campaignFiresToday(c: Pick<CrmCampaign, 'kind' | 'schedule'>, today: Date): boolean {
  const s = c.schedule || {}
  if (!campaignWindowOpen(s, today)) return false
  switch (c.kind) {
    case 'broadcast': case 'referral': case 'review': return broadcastFiresToday(s, today)
    case 'seasonal': return seasonalFiresToday(s, today)
    // Birthday/anniversary/win-back evaluate candidates every day.
    case 'birthday': case 'anniversary': case 'win_back': return true
  }
}

// Dedupe key for crm_campaign_log. Birthday/anniversary/seasonal dedupe per YEAR
// (they're annual by nature); broadcast/win-back/referral/review dedupe per MONTH
// so they can't repeat within the same window.
export function campaignPeriodKey(kind: CampaignKind, today: Date, leadDays = 0): string {
  if (kind === 'birthday' || kind === 'anniversary') {
    return String(occurrenceDate(today, leadDays).getUTCFullYear())
  }
  if (kind === 'seasonal') return String(today.getUTCFullYear())
  return `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`
}

// Birthday/anniversary/win-back are evaluated EVERY day (they fire per-customer,
// not per-calendar-date), so "next send" is not a date for them — it's "whenever
// a customer qualifies". Saying "next sends today" would be a lie.
export function isDailyEvaluated(kind: CampaignKind): boolean {
  return kind === 'birthday' || kind === 'anniversary' || kind === 'win_back'
}

// The next day this campaign fires, found by asking the ONE fire rule — no second
// scheduling maths to drift from campaignFiresToday(). 400 days covers an annual
// cadence plus a closed window; null means it never fires again (window expired).
export function nextFireDate(c: Pick<CrmCampaign, 'kind' | 'schedule'>, from: Date): Date | null {
  for (let i = 0; i <= 400; i++) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + i))
    if (campaignFiresToday(c, d)) return d
  }
  return null
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

// Plain-English "when does this next actually go out" — the fact behind the rule.
// Honest about the three cases that aren't a date: a campaign that evaluates
// daily, one waiting for its window to open, and one whose window has closed.
export function describeNextRun(c: Pick<CrmCampaign, 'kind' | 'schedule'>, today: Date): string {
  const s = c.schedule || {}
  const next = nextFireDate(c, today)
  if (!next) return 'Its date window has passed — this won’t send again'
  if (!campaignWindowOpen(s, today)) return `Starts ${fmtDate(next)}`
  if (isDailyEvaluated(c.kind)) return 'Checks every day'
  const isToday = next.toISOString().slice(0, 10) === today.toISOString().slice(0, 10)
  return isToday ? 'Sends today' : `Next sends ${fmtDate(next)}`
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function cadenceLabel(every: number): string {
  return every === 1 ? 'every month' : every === 12 ? 'once a year' : `every ${every} months`
}

// A plain-English description of when a campaign sends — for the manager UI.
export function describeSchedule(c: Pick<CrmCampaign, 'kind' | 'schedule'>): string {
  const s = c.schedule || {}
  const base = (() => {
    switch (c.kind) {
      case 'birthday':    return (s.lead_days ? `${s.lead_days} day(s) before each birthday` : 'On each customer’s birthday')
      case 'anniversary': return (s.lead_days ? `${s.lead_days} day(s) before each anniversary` : 'On each customer’s anniversary')
      case 'win_back':    return `When a customer hasn’t been messaged in ${s.days || 45} days`
      case 'seasonal':    return `Every ${MONTHS[(s.month || 1) - 1]} ${s.day || 1}`
      case 'broadcast': case 'referral': case 'review':
        return `On day ${s.day_of_month || 1}, ${cadenceLabel(Math.max(1, s.every_months || 1))}`
    }
  })()
  const window = describeWindow(s)
  return window ? `${base} · ${window}` : base
}

// The active-window half of the sentence, or '' when it's open-ended.
export function describeWindow(s: CampaignSchedule): string {
  const from = s.starts_on ? String(s.starts_on).slice(0, 10) : null
  const to = s.ends_on ? String(s.ends_on).slice(0, 10) : null
  if (from && to) return `only between ${from} and ${to}`
  if (from) return `not before ${from}`
  if (to) return `not after ${to}`
  return ''
}

// Plain-English audience summary — "Everyone" when nothing is narrowed.
export function describeAudience(a: CampaignAudience | null | undefined): string {
  const on = (Object.keys(AUDIENCE_LABELS) as (keyof CampaignAudience)[]).filter(k => a?.[k])
  if (!on.length) return 'Every customer'
  return on.map(k => AUDIENCE_LABELS[k]).join(' · ')
}

export function campaignChannelLabel(channels: string[]): string {
  const map: Record<string, string> = { sms: 'SMS', email: 'Email', push: 'Push' }
  return channels.map(c => map[c] || c).join(' + ') || '—'
}
