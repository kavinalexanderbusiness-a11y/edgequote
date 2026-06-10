import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { TravelFeeTier } from '@/types'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
    minimumFractionDigits: 2,
  }).format(amount)
}

// Date-only strings ('2026-06-12') parse as UTC midnight, which renders as the
// PREVIOUS day in Calgary — anchor them to local midnight before formatting.
export function parseLocalDate(dateStr: string): Date {
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr + 'T00:00:00' : dateStr)
}

export function formatDate(dateStr: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(parseLocalDate(dateStr))
}

// Local (not UTC) yyyy-MM-dd — evening work must not stamp tomorrow's date.
export function localTodayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Highest trailing number across existing document numbers ('EPS-2026-0007' → 7).
// Count-based numbering collides after a delete; max-suffix+1 never does.
export function maxNumericSuffix(values: (string | null | undefined)[]): number {
  let max = 0
  for (const v of values) {
    const m = (v || '').match(/(\d+)\s*$/)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return max
}

export function calculateQuote(
  hours: number,
  crewSize: number,
  rate: number,
  travelFee: number
) {
  const manHours = hours * crewSize
  const subtotal = manHours * rate
  const total = subtotal + travelFee
  return { manHours, subtotal, total }
}

export function generateQuoteNumber(index: number): string {
  const year = new Date().getFullYear()
  const num = String(index).padStart(4, '0')
  return `EPS-${year}-${num}`
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

// ── Phase 1 additions ──

/**
 * Suggest a travel fee from configured tiers (nothing hardcoded).
 */
export function suggestTravelFee(
  km: number,
  tiers: TravelFeeTier[]
): { fee: number | null; isCustom: boolean; tierLabel: string } {
  const sorted = [...tiers].sort((a, b) => a.sort_order - b.sort_order)
  for (const tier of sorted) {
    const aboveMin = km >= tier.min_km
    const belowMax = tier.max_km === null ? true : km < tier.max_km
    if (aboveMin && belowMax) {
      const label =
        tier.max_km === null
          ? `${tier.min_km}+ km`
          : `${tier.min_km}–${tier.max_km} km`
      return {
        fee: tier.is_custom ? null : tier.fee ?? 0,
        isCustom: tier.is_custom,
        tierLabel: label,
      }
    }
  }
  return { fee: 0, isCustom: false, tierLabel: 'Unknown' }
}

/**
 * Apply overgrowth multiplier to a base rate.
 * multiplier of 0 means "custom quote required".
 */
export function applyOvergrowth(baseRate: number, multiplier: number): number {
  if (multiplier <= 0) return baseRate
  return baseRate * multiplier
}