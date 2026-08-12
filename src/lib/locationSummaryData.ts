// ── Loading the rows lib/locationSummary eats ────────────────────────────────
// The same split lib/timeline + lib/timelineData already use: the engine is pure
// and I/O-free, and this is the ONE place that knows which tables a location
// summary comes from.
//
// ══ WHY THIS DOES NOT REUSE loadPropertyTimelineSources ══════════════════════
// It reads two of the same tables, but under the OPPOSITE failure contract, and
// that difference is the entire feature. loadPropertyTimelineSources ends every
// read with `(res.data as T[]) || []` — a deliberate, correct choice for a
// timeline, where one unavailable source should not stop the page rendering the
// rest of the history. Built on that, a summary would state "No service history"
// and "Never serviced" from a request that never came back, which is the one
// sentence this module exists to make impossible. So the reads here branch on
// `error` and hand the engine a discriminated `SourceRead`.
//
// The cost is one extra narrow `jobs` select on the property page (a handful of
// columns, not the timeline's `select('*')`). That is the honest price of the
// two contracts being genuinely different rather than one pretending to be both.

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildLocationSummary, type LocationSummary, type LocationVisit, type SourceRead } from '@/lib/locationSummary'
import { localTodayISO } from '@/lib/utils'

// Bounded like every other property-scoped read. 500 visits is ~10 years of
// weekly mowing at one address; a property past it has its oldest visits fall
// out of the SUMMARY only — the timeline below it is paged separately and
// remains the complete record.
const VISIT_CAP = 500

/**
 * Read one property's operational memory.
 *
 * Both reads are scoped by `user_id` on top of RLS. That is belt-and-braces on
 * purpose: `jobs` and `job_photos` are own-row under RLS, so the filter is
 * redundant TODAY, and it is what keeps this honest if these rows are ever read
 * through a definer path. A property id from another tenant therefore returns an
 * empty set, never another business's visits.
 */
export async function loadLocationSummary(
  supabase: SupabaseClient,
  userId: string,
  propertyId: string,
  opts?: { todayISO?: string },
): Promise<LocationSummary> {
  const [visitRes, photoRes] = await Promise.all([
    supabase.from('jobs')
      .select('id, status, title, service_type, scheduled_date, completed_at, actual_minutes')
      .eq('user_id', userId).eq('property_id', propertyId)
      .order('scheduled_date', { ascending: false }).limit(VISIT_CAP),
    // head+count: the summary needs the NUMBER, and the timeline underneath it
    // already fetches and renders the photos themselves. Pulling them twice to
    // count them would double the page's photo bytes for a figure.
    supabase.from('job_photos')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('property_id', propertyId),
  ])

  // The branch that makes "unknown" reachable. `error` is checked FIRST: a failed
  // PostgREST read also carries `data: null`, so testing the data alone would
  // route every failure into the empty case — the exact bug this file prevents.
  const visits: SourceRead<LocationVisit> = visitRes.error
    ? { ok: false }
    : { ok: true, rows: (visitRes.data as LocationVisit[]) || [] }

  // A count read that failed is `null`, not 0. `count` is legitimately null on a
  // head request that errored, so the error check carries it either way.
  const photoCount = photoRes.error ? null : photoRes.count ?? 0

  return buildLocationSummary({
    visits,
    photoCount,
    // The OWNER's today, not UTC — a visit booked for this afternoon must not
    // read as past because the server rolled over.
    todayISO: opts?.todayISO ?? localTodayISO(),
  })
}
