import { createHash } from 'node:crypto'
import { addDaysISO, tenantMoment } from '@/lib/tenantTime'
import { invoiceBalance } from '@/lib/payments/ledger'

export type OwnerReminderSlot = 'workday_prep' | 'day_close'

export interface OwnerReminderPrefs {
  daily_reminder?: boolean
  workday_prep?: boolean
  invoice_followup?: boolean
  overdue_balance?: boolean
  end_of_day?: boolean
}

export interface OwnerReminderSettings {
  userId: string
  timeZone: string
  workStartTime?: string | null
  dailyCapacityHours?: number | null
  gstPercent?: number | null
  prefs?: OwnerReminderPrefs | null
}

export interface OwnerReminderJob {
  id: string
  scheduledDate: string
  status: string
  startTime?: string | null
  endTime?: string | null
  durationMinutes?: number | null
  crewId?: string | null
  crewName?: string | null
  hasPrepNotes?: boolean
  noCharge?: boolean
}

export interface OwnerReminderInvoice {
  id: string
  jobId?: string | null
  status: string
  amount: number
  amountPaid: number
  dueDate?: string | null
  discountType?: 'amount' | 'percent' | null
  discountValue?: number | null
}

export interface OwnerReminderEquipment {
  name: string
  crewId?: string | null
  status: string
}

export interface OwnerReminderInput {
  settings: OwnerReminderSettings
  now: Date
  todayJobs: OwnerReminderJob[]
  tomorrowJobs: OwnerReminderJob[]
  invoices: OwnerReminderInvoice[]
  equipment: OwnerReminderEquipment[]
}

export interface PlannedOwnerReminder {
  id: string
  slot: OwnerReminderSlot
  localDate: string
  type: 'owner_workday_prep' | 'owner_day_close'
  title: string
  body: string
  href: string
}

const on = (prefs: OwnerReminderPrefs | null | undefined, key: keyof OwnerReminderPrefs) => prefs?.[key] !== false

function clockMinutes(value: string | null | undefined, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(value ?? '')
  if (!m) return fallback
  const h = Number(m[1]), min = Number(m[2])
  return h >= 0 && h <= 23 && min >= 0 && min <= 59 ? h * 60 + min : fallback
}

function dueHour(settings: OwnerReminderSettings, slot: OwnerReminderSlot): number {
  const start = clockMinutes(settings.workStartTime, 8 * 60)
  const capacity = Math.max(1, Math.min(14, Number(settings.dailyCapacityHours) || 8)) * 60
  // Default quiet hours are 21:00–06:00. The morning brief lands one hour before
  // work; the close brief one hour after the configured workday, inside that band.
  const minutes = slot === 'workday_prep'
    ? Math.max(6 * 60, Math.min(9 * 60, start - 60))
    : Math.max(16 * 60, Math.min(20 * 60, start + capacity + 60))
  return Math.floor(minutes / 60)
}

/** Which digest an hourly caller may create at this instant. The tenant's IANA
 * zone decides; server UTC and device timezone never enter the decision. */
export function dueOwnerReminderSlots(settings: OwnerReminderSettings, now: Date): OwnerReminderSlot[] {
  if (!on(settings.prefs, 'daily_reminder')) return []
  const local = tenantMoment(settings.timeZone, now)
  const slots: OwnerReminderSlot[] = []
  const morning = dueHour(settings, 'workday_prep')
  const close = dueHour(settings, 'day_close')
  // A transient scheduler failure must not permanently erase the day's digest.
  // Deterministic notification IDs keep this catch-up window at-most-once.
  if (local.hour >= morning && local.hour <= Math.min(11, morning + 3)) slots.push('workday_prep')
  if (local.hour >= close && local.hour <= Math.min(20, close + 3)) slots.push('day_close')
  return slots
}

/** Stable UUID-shaped primary key: retries and overlapping sweeps contend on the
 * existing notifications PK, so only one INSERT can fire the push trigger. */
export function ownerReminderId(userId: string, localDate: string, slot: OwnerReminderSlot): string {
  const hex = createHash('sha256').update(`edgehq-owner-reminder:v1:${userId}:${localDate}:${slot}`).digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  const s = hex.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

function timeLabel(value: string | null | undefined): string | null {
  const mins = clockMinutes(value, -1)
  if (mins < 0) return null
  const h = Math.floor(mins / 60), m = mins % 60
  const hour = h % 12 || 12
  return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`
}

function jobEndMinutes(j: OwnerReminderJob): number | null {
  const end = clockMinutes(j.endTime, -1)
  if (end >= 0) return end
  const start = clockMinutes(j.startTime, -1)
  return start >= 0 && j.durationMinutes && j.durationMinutes > 0 ? start + j.durationMinutes : null
}

function arrivalSummary(jobs: OwnerReminderJob[]): string | null {
  const starts = jobs.map(j => clockMinutes(j.startTime, -1)).filter(n => n >= 0)
  if (!starts.length) return jobs.length ? 'arrival times not set' : null
  const ends = jobs.map(jobEndMinutes).filter((n): n is number => n != null)
  const first = timeLabel(`${Math.floor(Math.min(...starts) / 60)}:${String(Math.min(...starts) % 60).padStart(2, '0')}`)
  const last = ends.length ? timeLabel(`${Math.floor(Math.max(...ends) / 60) % 24}:${String(Math.max(...ends) % 60).padStart(2, '0')}`) : null
  const missing = jobs.length - starts.length
  return `${first}${last ? `–${last}` : ''}${missing ? `; ${missing} time${missing === 1 ? '' : 's'} not set` : ''}`
}

function money(n: number): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 2 }).format(n)
}

function invoiceFacts(invoices: OwnerReminderInvoice[], today: string, gstPercent?: number | null) {
  const live = invoices.map(i => ({
    ...i,
    balance: Math.max(0, invoiceBalance({
      amount: i.amount,
      amount_paid: i.amountPaid,
      discount_type: i.discountType ?? null,
      discount_value: i.discountValue ?? null,
    }, { gst_percent: gstPercent }).balance),
  }))
    .filter(i => !['paid', 'cancelled', 'overpaid'].includes(i.status) && i.balance > 0)
  const collectible = live.filter(i => i.status !== 'draft')
  const overdue = collectible.filter(i => !!i.dueDate && i.dueDate < today)
  return {
    drafts: live.filter(i => i.status === 'draft'),
    collectible,
    overdue,
    collectibleTotal: collectible.reduce((s, i) => s + i.balance, 0),
    overdueTotal: overdue.reduce((s, i) => s + i.balance, 0),
  }
}

function equipmentFor(jobs: OwnerReminderJob[], equipment: OwnerReminderEquipment[]): string[] {
  const crews = new Set(jobs.map(j => j.crewId).filter((id): id is string => !!id))
  return [...new Set(equipment.filter(e => e.status === 'active' && !!e.crewId && crews.has(e.crewId)).map(e => e.name.trim()).filter(Boolean))].sort()
}

export function buildOwnerReminder(input: OwnerReminderInput, slot: OwnerReminderSlot): PlannedOwnerReminder | null {
  const { settings } = input
  if (!on(settings.prefs, 'daily_reminder')) return null
  const { date: today } = tenantMoment(settings.timeZone, input.now)
  const tomorrow = addDaysISO(today, 1)
  const activeToday = input.todayJobs.filter(j => ['scheduled', 'in_progress'].includes(j.status))
  const completedToday = input.todayJobs.filter(j => j.status === 'completed')
  const tomorrowJobs = input.tomorrowJobs.filter(j => j.status === 'scheduled')
  const facts = invoiceFacts(input.invoices, today, settings.gstPercent)
  const invoiceJobIds = new Set(input.invoices.filter(i => i.status !== 'cancelled').map(i => i.jobId).filter(Boolean))
  const uninvoiced = completedToday.filter(j => !j.noCharge && !invoiceJobIds.has(j.id))

  if (slot === 'workday_prep') {
    const sections: string[] = []
    if (on(settings.prefs, 'workday_prep') && activeToday.length) {
      const arrival = arrivalSummary(activeToday)
      sections.push(`${activeToday.length} job${activeToday.length === 1 ? '' : 's'} today${arrival ? `; ${arrival}` : ''}.`)
      const gear = equipmentFor(activeToday, input.equipment)
      if (gear.length) sections.push(`Assigned equipment: ${gear.slice(0, 5).join(', ')}${gear.length > 5 ? ` +${gear.length - 5} more` : ''}.`)
      const prep = activeToday.filter(j => j.hasPrepNotes).length
      if (prep) sections.push(`Visit notes are recorded on ${prep} job${prep === 1 ? '' : 's'}; open the day plan before loading materials.`)
    }
    if (!sections.length) return null
    return {
      id: ownerReminderId(settings.userId, today, slot), slot, localDate: today,
      type: 'owner_workday_prep', title: activeToday.length ? `Workday prep · ${activeToday.length} job${activeToday.length === 1 ? '' : 's'}` : 'Money follow-up',
      body: sections.join(' ').slice(0, 420), href: activeToday.length ? `/dashboard/schedule?date=${today}` : '/dashboard/invoices',
    }
  }

  const sections: string[] = []
  if (on(settings.prefs, 'end_of_day')) {
    if (activeToday.length) sections.push(`${activeToday.length} job${activeToday.length === 1 ? '' : 's'} still open from today.`)
    if (tomorrowJobs.length) {
      const arrival = arrivalSummary(tomorrowJobs)
      sections.push(`Tomorrow: ${tomorrowJobs.length} job${tomorrowJobs.length === 1 ? '' : 's'}${arrival ? `; ${arrival}` : ''}.`)
      const gear = equipmentFor(tomorrowJobs, input.equipment)
      if (gear.length) sections.push(`Tomorrow’s assigned equipment: ${gear.slice(0, 5).join(', ')}${gear.length > 5 ? ` +${gear.length - 5} more` : ''}.`)
    }
  }
  if (on(settings.prefs, 'invoice_followup')) {
    if (uninvoiced.length) sections.push(`${uninvoiced.length} completed job${uninvoiced.length === 1 ? '' : 's'} need${uninvoiced.length === 1 ? 's' : ''} an invoice.`)
    if (facts.drafts.length) sections.push(`${facts.drafts.length} draft invoice${facts.drafts.length === 1 ? '' : 's'} ready to review and send.`)
    if (facts.collectible.length) sections.push(`${facts.collectible.length} unpaid invoice${facts.collectible.length === 1 ? '' : 's'}: ${money(facts.collectibleTotal)} remaining.`)
  }
  if (on(settings.prefs, 'overdue_balance') && facts.overdue.length) {
    sections.push(`${facts.overdue.length} overdue: ${money(facts.overdueTotal)}.`)
  }
  if (!sections.length) return null
  const moneyFirst = Boolean(
    (on(settings.prefs, 'invoice_followup') && (uninvoiced.length || facts.drafts.length || facts.collectible.length))
    || (on(settings.prefs, 'overdue_balance') && facts.overdue.length),
  )
  return {
    id: ownerReminderId(settings.userId, today, slot), slot, localDate: today,
    type: 'owner_day_close', title: moneyFirst ? 'Close the day · invoices and collection' : 'Close the day',
    body: sections.join(' ').slice(0, 420), href: moneyFirst ? '/dashboard/invoices' : `/dashboard/schedule?date=${tomorrow}`,
  }
}
