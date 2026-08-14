// ── The one setting the smart estimate needs beyond its history ──────────────
// lib/workEstimate is pure; lib/estimateVsActualData already owns the visits it
// learns from. This is the remaining read: how long the owner's working day is,
// which is the unit "~2 workdays" is counted in.
//
// It deliberately does NOT have the three-outcome contract its sibling loader
// has, and the difference is not laziness. A failed HISTORY read must darken the
// card, because "I could not read your past work" is not "you have no past
// work". A failed CAPACITY read cannot mislead in the same way: it changes only
// the unit a known duration is spoken in (9h reads as "1.5 workdays" on an 8h
// day and "1 workday" on a 9h one) and can never manufacture, inflate or
// suppress a duration, a sample size or a fit. lib/route dayLoad has always
// defaulted the same way for the same reason.

import type { SupabaseClient } from '@supabase/supabase-js'
import { workdayMinutes } from '@/lib/workEstimate'

/**
 * Minutes in this owner's working day. Falls back to the product default on any
 * read that does not demonstrably succeed.
 *
 * TENANCY: `business_settings` is RLS own-row, and the explicit
 * `.eq('user_id', userId)` is the only thing standing if a service-role client
 * is ever passed here — the same reason lib/estimateVsActualData carries one. An
 * unscoped read would silently measure this business's projects in another
 * business's working day.
 */
export async function loadWorkdayMinutes(
  supabase: SupabaseClient,
  userId: string,
): Promise<number> {
  if (!userId) return workdayMinutes(null)
  const { data, error } = await supabase
    .from('business_settings')
    .select('daily_capacity_hours')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data) return workdayMinutes(null)
  return workdayMinutes((data as { daily_capacity_hours: number | null }).daily_capacity_hours)
}
