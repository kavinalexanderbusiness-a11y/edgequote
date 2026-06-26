// ── CRM campaigns (pure) ─────────────────────────────────────────────────────
// Types, presets, dedupe-period keys and trigger-matching for the customer-
// centric campaign engine (migration 2026-06-25h). NO I/O — both the daily cron
// (/api/cron/campaigns) and the Campaign Manager UI import these so the rules are
// defined once. Sending always reuses the existing comms pipeline + templates.

import type { CampaignKind, CrmCampaign } from '@/types'
import type { MsgType } from '@/lib/comms/templates'

export type { CampaignKind } from '@/types'

export interface CampaignKindMeta {
  label: string
  blurb: string
  defaultTemplate: MsgType
  defaultChannels: string[]
  defaultSchedule: CrmCampaign['schedule']
}

export const CAMPAIGN_KINDS: Record<CampaignKind, CampaignKindMeta> = {
  birthday: {
    label: 'Birthday greeting',
    blurb: 'Sends on each customer’s birthday. Needs a birthday on the profile.',
    defaultTemplate: 'birthday',
    defaultChannels: ['sms', 'email'],
    defaultSchedule: { lead_days: 0 },
  },
  anniversary: {
    label: 'Anniversary greeting',
    blurb: 'Sends on the anniversary date you set on the profile (e.g. their first year).',
    defaultTemplate: 'anniversary',
    defaultChannels: ['email'],
    defaultSchedule: { lead_days: 0 },
  },
  win_back: {
    label: 'Win-back',
    blurb: 'Re-engages customers you haven’t messaged in a while. Self-limits — sending resets their clock.',
    defaultTemplate: 'win_back',
    defaultChannels: ['sms', 'email'],
    defaultSchedule: { days: 45 },
  },
  broadcast: {
    label: 'Recurring check-in',
    blurb: 'A scheduled marketing message to your customers on a repeating cadence.',
    defaultTemplate: 'marketing',
    defaultChannels: ['email'],
    defaultSchedule: { day_of_month: 1, every_months: 1 },
  },
}

// One-tap starting points for the "New campaign" menu.
export interface CampaignPreset {
  kind: CampaignKind
  name: string
  channels: string[]
  schedule: CrmCampaign['schedule']
  audience: CrmCampaign['audience']
}
export const CAMPAIGN_PRESETS: CampaignPreset[] = [
  { kind: 'birthday',    name: 'Birthday greeting',     channels: ['sms', 'email'], schedule: { lead_days: 0 }, audience: {} },
  { kind: 'anniversary', name: 'Customer anniversary',  channels: ['email'],        schedule: { lead_days: 0 }, audience: {} },
  { kind: 'win_back',    name: 'Win back quiet customers', channels: ['sms'],       schedule: { days: 45 },     audience: {} },
  { kind: 'broadcast',   name: 'Monthly check-in',      channels: ['email'],        schedule: { day_of_month: 1, every_months: 1 }, audience: {} },
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
export function broadcastFiresToday(schedule: CrmCampaign['schedule'], today: Date): boolean {
  const dom = schedule.day_of_month || 1
  const every = Math.max(1, schedule.every_months || 1)
  const y = today.getUTCFullYear(), m = today.getUTCMonth() + 1
  const effectiveDay = Math.min(dom, daysInMonth(y, m))
  if (today.getUTCDate() !== effectiveDay) return false
  return (y * 12 + (m - 1)) % every === 0
}

// Dedupe key for crm_campaign_log. Birthday/anniversary dedupe per YEAR (of the
// occurrence date); broadcast/win-back dedupe per MONTH so they can't repeat
// within the same window.
export function campaignPeriodKey(kind: CampaignKind, today: Date, leadDays = 0): string {
  if (kind === 'birthday' || kind === 'anniversary') {
    return String(occurrenceDate(today, leadDays).getUTCFullYear())
  }
  return `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`
}

// A plain-English description of when a campaign sends — for the manager UI.
export function describeSchedule(c: Pick<CrmCampaign, 'kind' | 'schedule'>): string {
  const s = c.schedule || {}
  switch (c.kind) {
    case 'birthday':    return (s.lead_days ? `${s.lead_days} day(s) before each birthday` : 'On each customer’s birthday')
    case 'anniversary': return (s.lead_days ? `${s.lead_days} day(s) before each anniversary` : 'On each customer’s anniversary')
    case 'win_back':    return `When a customer hasn’t been messaged in ${s.days || 45} days`
    case 'broadcast': {
      const dom = s.day_of_month || 1
      const every = Math.max(1, s.every_months || 1)
      const cadence = every === 1 ? 'every month' : every === 3 ? 'every 3 months' : `every ${every} months`
      return `On day ${dom}, ${cadence}`
    }
  }
}

export function campaignChannelLabel(channels: string[]): string {
  const map: Record<string, string> = { sms: 'SMS', email: 'Email', push: 'Push' }
  return channels.map(c => map[c] || c).join(' + ') || '—'
}
