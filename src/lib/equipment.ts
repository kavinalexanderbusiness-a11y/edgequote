import { Wrench, Scissors, Wind, Truck, Package, Sprout, type LucideIcon } from 'lucide-react'
import type { Tone } from '@/lib/tone'

// ── THE equipment engine ─────────────────────────────────────────────────────
// Every equipment question is answered here: what a machine is, whether it's due
// for service, and what it has cost to own. Pages render this — they never
// re-derive a due date or a total, so the list, the detail panel and any future
// consumer can't disagree.

export type EquipmentStatus = 'active' | 'repair' | 'retired'
export type EquipmentCategory = 'mower' | 'trimmer' | 'blower' | 'aerator' | 'truck' | 'trailer' | 'other'

export interface Equipment {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  name: string
  category: EquipmentCategory
  make: string | null
  model: string | null
  serial_number: string | null
  purchase_date: string | null
  purchase_price: number | null
  status: EquipmentStatus
  hours: number
  service_interval_hours: number | null
  service_interval_days: number | null
  // Derived by the DB trigger from the service log — never written by app code.
  last_service_at: string | null
  last_service_hours: number | null
  notes: string | null
  // Warranty cover (optional) — drives "don't pay for this repair".
  warranty_expires: string | null
  warranty_provider: string | null
  // Straight-line depreciation inputs (optional). No useful life = not
  // depreciated; book value simply reports the purchase price.
  useful_life_years: number | null
  salvage_value: number | null
}

export type ServiceKind = 'oil' | 'blade' | 'filter' | 'spark_plug' | 'tune_up' | 'tire' | 'repair' | 'other'

export interface EquipmentService {
  id: string
  created_at: string
  user_id: string
  equipment_id: string
  service_date: string
  kind: ServiceKind
  hours: number | null
  cost: number | null
  notes: string | null
}

export const EQUIPMENT_CATEGORIES: { value: EquipmentCategory; label: string; icon: LucideIcon }[] = [
  { value: 'mower', label: 'Mower', icon: Sprout },
  { value: 'trimmer', label: 'Trimmer', icon: Scissors },
  { value: 'blower', label: 'Blower', icon: Wind },
  { value: 'aerator', label: 'Aerator', icon: Wrench },
  { value: 'truck', label: 'Truck', icon: Truck },
  { value: 'trailer', label: 'Trailer', icon: Package },
  { value: 'other', label: 'Other', icon: Wrench },
]

export const SERVICE_KINDS: { value: ServiceKind; label: string }[] = [
  { value: 'oil', label: 'Oil change' },
  { value: 'blade', label: 'Blade sharpen / replace' },
  { value: 'filter', label: 'Air / fuel filter' },
  { value: 'spark_plug', label: 'Spark plug' },
  { value: 'tune_up', label: 'Full tune-up' },
  { value: 'tire', label: 'Tires' },
  { value: 'repair', label: 'Repair' },
  { value: 'other', label: 'Other' },
]

export const STATUS_LABELS: Record<EquipmentStatus, string> = {
  active: 'In service',
  repair: 'In the shop',
  retired: 'Retired',
}
export const STATUS_TONE: Record<EquipmentStatus, Tone> = {
  active: 'success',
  repair: 'warn',
  retired: 'neutral',
}

export function categoryMeta(c: EquipmentCategory) {
  return EQUIPMENT_CATEGORIES.find(x => x.value === c) ?? EQUIPMENT_CATEGORIES[EQUIPMENT_CATEGORIES.length - 1]
}
export function serviceKindLabel(k: ServiceKind): string {
  return SERVICE_KINDS.find(x => x.value === k)?.label ?? 'Other'
}

const DAY = 86_400_000
function daysBetween(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(toISO + 'T00:00:00') - Date.parse(fromISO + 'T00:00:00')) / DAY)
}

export type ServiceState = 'ok' | 'due_soon' | 'due' | 'untracked'

export interface ServiceStatus {
  state: ServiceState
  /** Plain-language reason — always explains WHY, never a bare verdict. */
  reason: string
  hoursRemaining: number | null   // negative = overdue by that many hours
  daysRemaining: number | null    // negative = overdue by that many days
  tone: Tone
}

// Due when EITHER axis is reached — whichever comes first, matching how an
// operator actually services a machine ("every 50 hours or every 6 months").
// "Due soon" = within 10% of the hour interval, or 14 days of the date one.
export function serviceStatus(eq: Equipment, todayISO: string): ServiceStatus {
  const trackHours = !!eq.service_interval_hours && eq.service_interval_hours > 0
  const trackDays = !!eq.service_interval_days && eq.service_interval_days > 0
  if (!trackHours && !trackDays) {
    return { state: 'untracked', reason: 'No service schedule set', hoursRemaining: null, daysRemaining: null, tone: 'neutral' }
  }

  let hoursRemaining: number | null = null
  if (trackHours) {
    // Hours since the last service — or since new when never serviced.
    const base = eq.last_service_hours != null ? Number(eq.last_service_hours) : 0
    const run = Math.max(0, Number(eq.hours) - base)
    hoursRemaining = Math.round((eq.service_interval_hours! - run) * 10) / 10
  }

  let daysRemaining: number | null = null
  if (trackDays) {
    // Days since the last service — or since purchase when never serviced.
    const from = eq.last_service_at ?? eq.purchase_date
    if (from) daysRemaining = eq.service_interval_days! - daysBetween(from, todayISO)
  }

  const hoursDue = hoursRemaining != null && hoursRemaining <= 0
  const daysDue = daysRemaining != null && daysRemaining <= 0
  if (hoursDue || daysDue) {
    const why = hoursDue && hoursRemaining != null
      ? `${Math.abs(hoursRemaining)} h past its ${eq.service_interval_hours} h service`
      : `${Math.abs(daysRemaining!)} days past its ${eq.service_interval_days}-day service`
    return { state: 'due', reason: `Service due — ${why}`, hoursRemaining, daysRemaining, tone: 'danger' }
  }

  const hoursSoon = hoursRemaining != null && hoursRemaining <= Math.max(1, (eq.service_interval_hours || 0) * 0.1)
  const daysSoon = daysRemaining != null && daysRemaining <= 14
  if (hoursSoon || daysSoon) {
    const why = hoursSoon && hoursRemaining != null
      ? `${hoursRemaining} h left`
      : `${daysRemaining} days left`
    return { state: 'due_soon', reason: `Service soon — ${why}`, hoursRemaining, daysRemaining, tone: 'warn' }
  }

  const why = hoursRemaining != null ? `${hoursRemaining} h until next service` : `${daysRemaining} days until next service`
  return { state: 'ok', reason: why, hoursRemaining, daysRemaining, tone: 'success' }
}

export type WarrantyState = 'covered' | 'expiring' | 'expired' | 'none'

export interface WarrantyStatus {
  state: WarrantyState
  /** Plain-language — always says what it means for the money. */
  reason: string
  daysRemaining: number | null
  tone: Tone
}

// Is this machine still covered? "Expiring" at 30 days is the window where an
// operator can still book covered work before paying for it themselves.
export function warrantyStatus(eq: Equipment, todayISO: string): WarrantyStatus {
  if (!eq.warranty_expires) {
    return { state: 'none', reason: 'No warranty on file', daysRemaining: null, tone: 'neutral' }
  }
  const days = daysBetween(todayISO, eq.warranty_expires)
  const who = eq.warranty_provider ? ` · ${eq.warranty_provider}` : ''
  if (days < 0) {
    return { state: 'expired', reason: `Warranty ended ${Math.abs(days)} days ago${who}`, daysRemaining: days, tone: 'neutral' }
  }
  if (days <= 30) {
    return { state: 'expiring', reason: `Warranty ends in ${days} days — book covered work now${who}`, daysRemaining: days, tone: 'warn' }
  }
  return { state: 'covered', reason: `Under warranty for ${days} more days${who}`, daysRemaining: days, tone: 'success' }
}

export interface BookValue {
  value: number            // what it's worth today
  depreciated: number      // how much value it has lost
  annual: number | null    // straight-line depreciation per year
  depreciating: boolean    // false = no useful life set (value = purchase price)
}

// Straight-line book value: purchase → salvage over useful_life_years, floored at
// salvage and never above purchase. No purchase price or no useful life → we
// report what we know rather than inventing a number.
export function bookValue(eq: Equipment, todayISO: string): BookValue {
  const purchase = Number(eq.purchase_price) || 0
  const life = Number(eq.useful_life_years) || 0
  const salvage = Math.min(Number(eq.salvage_value) || 0, purchase)
  if (!purchase || life <= 0 || !eq.purchase_date) {
    return { value: round2(purchase), depreciated: 0, annual: null, depreciating: false }
  }
  const annual = round2((purchase - salvage) / life)
  const years = Math.max(0, daysBetween(eq.purchase_date, todayISO) / 365.25)
  const lost = Math.min(round2(annual * years), round2(purchase - salvage))
  return { value: round2(purchase - lost), depreciated: lost, annual, depreciating: true }
}

/** What this machine has actually cost: purchase + every logged service. */
export function costOfOwnership(eq: Equipment, services: EquipmentService[]) {
  const maintenance = round2(services.reduce((s, r) => s + (Number(r.cost) || 0), 0))
  const purchase = Number(eq.purchase_price) || 0
  const total = round2(purchase + maintenance)
  const hours = Number(eq.hours) || 0
  return {
    purchase,
    maintenance,
    total,
    /** Blended $/hour — null until the machine has logged hours. */
    perHour: hours > 0 ? round2(total / hours) : null,
  }
}

/** Fleet rollup for the page's stat strip — one place, so the tiles can't drift. */
export function fleetSummary(equipment: Equipment[], services: EquipmentService[], todayISO: string) {
  const live = equipment.filter(e => e.status !== 'retired')
  const byEq = new Map<string, EquipmentService[]>()
  for (const s of services) {
    const list = byEq.get(s.equipment_id) ?? []
    list.push(s)
    byEq.set(s.equipment_id, list)
  }
  const needing = live.filter(e => {
    const st = serviceStatus(e, todayISO).state
    return st === 'due' || st === 'due_soon'
  })
  const yearStart = todayISO.slice(0, 4) + '-01-01'
  return {
    activeCount: equipment.filter(e => e.status === 'active').length,
    repairCount: equipment.filter(e => e.status === 'repair').length,
    needingService: needing.length,
    /** What the live fleet is worth TODAY (depreciated where a life is set). */
    fleetValue: round2(live.reduce((s, e) => s + bookValue(e, todayISO).value, 0)),
    /** What it cost new — the paid figure, for contrast with book value. */
    fleetPurchase: round2(live.reduce((s, e) => s + (Number(e.purchase_price) || 0), 0)),
    /** Cover about to lapse — the window to book covered work for free. */
    warrantyExpiring: live.filter(e => warrantyStatus(e, todayISO).state === 'expiring').length,
    maintenanceYtd: round2(services.filter(s => s.service_date >= yearStart).reduce((s, r) => s + (Number(r.cost) || 0), 0)),
    servicesByEquipment: byEq,
  }
}

function round2(n: number) { return Math.round(n * 100) / 100 }
