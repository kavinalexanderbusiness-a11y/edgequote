// ── Schedule disruption layer ────────────────────────────────────────────────
// The general model behind the Weather Operations hub: a "disruption" is any
// reason a day's work has to move — weather today, an equipment breakdown,
// employee absence, a holiday, or an emergency tomorrow. They all share the SAME
// machinery: pick affected jobs → choose a destination strategy → redistribute →
// notify customers. This file is pure metadata + a thin destination resolver; the
// actual move math stays in lib/optimizer (planRainDelay) and the comms in the
// existing pipeline. Adding a new disruption cause = one entry here, nothing else.

import { addDays, format, getDay, parseISO } from 'date-fns'
import { MsgType } from '@/lib/comms/templates'

export type DisruptionReason = 'weather' | 'equipment' | 'absence' | 'holiday' | 'emergency'

// Each reason carries the message template customers should receive when their
// visit moves for that cause (weather → the dedicated rain-delay copy; everything
// else → the neutral "rescheduled" copy until a cause earns its own template).
export const DISRUPTION_META: Record<DisruptionReason, { label: string; emoji: string; template: MsgType }> = {
  weather:   { label: 'Weather',   emoji: '🌧️', template: 'rain_delay' },
  equipment: { label: 'Equipment', emoji: '🔧', template: 'rescheduled' },
  absence:   { label: 'Absence',   emoji: '🧑‍🔧', template: 'rescheduled' },
  holiday:   { label: 'Holiday',   emoji: '🎉', template: 'rescheduled' },
  emergency: { label: 'Emergency', emoji: '🚨', template: 'rescheduled' },
}

export const DISRUPTION_REASONS = Object.keys(DISRUPTION_META) as DisruptionReason[]

// How the owner wants the affected jobs re-placed.
export type DestinationStrategy = 'tomorrow' | 'next_business_day' | 'specific_date' | 'auto_optimize'

export const STRATEGY_META: Record<DestinationStrategy, { label: string; hint: string }> = {
  tomorrow:          { label: 'Tomorrow',          hint: 'Move everything to the next day' },
  next_business_day: { label: 'Next work day',     hint: 'Next day you normally work' },
  specific_date:     { label: 'Specific date',     hint: 'Pick the day yourself' },
  auto_optimize:     { label: 'Auto-optimize',     hint: 'Best dry/work days, capacity-aware' },
}

export const STRATEGIES = Object.keys(STRATEGY_META) as DestinationStrategy[]

// Next preferred work day strictly AFTER fromISO that is NOT marked unavailable
// (Day Status). Falls back to the next calendar day when no preferred days are set
// or none land within three weeks.
export function nextWorkday(fromISO: string, preferredDays: number[], blockedDates?: Set<string>): string {
  const pref = preferredDays.length ? new Set(preferredDays) : null
  let d = addDays(parseISO(fromISO), 1)
  for (let i = 0; i < 21; i++) {
    const iso = format(d, 'yyyy-MM-dd')
    if ((!pref || pref.has(getDay(d))) && !blockedDates?.has(iso)) return iso
    d = addDays(d, 1)
  }
  return format(addDays(parseISO(fromISO), 1), 'yyyy-MM-dd')
}

// Resolve a single-destination strategy to one target date. `auto_optimize` returns
// null — the caller delegates to planRainDelay for a capacity-aware spread across
// several days rather than piling everything onto one. `blockedDates` (Day Status)
// is skipped by next_business_day; 'tomorrow' stays literal (it's an explicit
// manual choice — the owner can still override a disabled day).
export function resolveDestination(
  strategy: DestinationStrategy,
  fromISO: string,
  opts: { preferredDays: number[]; specificDate?: string | null; blockedDates?: Set<string> },
): string | null {
  if (strategy === 'tomorrow') return format(addDays(parseISO(fromISO), 1), 'yyyy-MM-dd')
  if (strategy === 'next_business_day') return nextWorkday(fromISO, opts.preferredDays, opts.blockedDates)
  if (strategy === 'specific_date') return opts.specificDate || null
  return null // auto_optimize
}
