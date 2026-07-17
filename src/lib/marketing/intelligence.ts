import type { SupabaseClient } from '@supabase/supabase-js'
import { assembleCandidate } from './data'
import type { BrandVoice } from './brandVoice'
import type { GenSubject, MarketingCandidate, Season } from './types'

// ── Post Intelligence ───────────────────────────────────────────────────────────────
// Before generating, gather the context the app already holds and turn it into facts a
// marketing manager would actually use — never raw numbers. Extends the scored
// candidate with: the customer relationship (first / returning / regular), the work
// actually done (edging, trimming, cleanup…), how involved the visit was, the season's
// timing, and — when available — AI Vision highlights. Assembled ONCE per generation
// (reused across every platform), so it stays cheap.

export interface PostIntelligence {
  candidate: MarketingCandidate
  relationship: 'first' | 'returning' | 'regular'
  recurring: boolean
  involved: 'quick' | 'thorough' | null   // banded from duration; never the raw minutes
  serviceParts: string[]                  // mowing, edging, a full cleanup, …
  visionHighlights: string[]              // optional, from property_intelligence
  seasonStart: boolean
}

function bandDuration(min: number | null | undefined): 'quick' | 'thorough' | null {
  if (!min || min <= 0) return null
  if (min <= 25) return 'quick'
  if (min >= 75) return 'thorough'
  return null
}

// Translate the service description + notes into the work a neighbour would recognise.
function detectServiceParts(text: string): string[] {
  const t = text.toLowerCase()
  const parts: string[] = []
  if (/\b(mow|mowing|cut|cutting)\b/.test(t)) parts.push('mowing')
  if (/\bedg/.test(t)) parts.push('edging')
  if (/\btrim|trimming|whipper|string/.test(t)) parts.push('trimming')
  if (/clean ?up|cleanup|tidy/.test(t)) parts.push('a full cleanup')
  if (/\bmulch/.test(t)) parts.push('fresh mulch')
  if (/\baerat/.test(t)) parts.push('aeration')
  if (/\bfertiliz|\bfeed/.test(t)) parts.push('fertilizing')
  if (/\bblow|blowing/.test(t)) parts.push('blowing down the hard surfaces')
  if (/\bweed/.test(t)) parts.push('weeding')
  if (/\bsnow|plow|shovel|ice|salt/.test(t)) parts.push('snow & ice clearing')
  return Array.from(new Set(parts)).slice(0, 4)
}

// Calgary-style season openings — used only to flag a timely "get on the schedule" CTA.
function isSeasonStart(season: Season | null): boolean {
  if (!season) return false
  const m = new Date().getMonth() + 1 // 1-12
  if (season === 'spring') return m === 4 || m === 5
  if (season === 'fall') return m === 9
  if (season === 'winter') return m === 11
  if (season === 'summer') return m === 6
  return false
}

// Best-effort, never-fatal read of AI Vision insights (parallel-owned table). If the
// table or columns aren't present, we simply return no highlights.
async function readVisionHighlights(supabase: SupabaseClient, userId: string, propertyId: string | null): Promise<string[]> {
  if (!propertyId) return []
  try {
    const { data } = await supabase.from('property_intelligence')
      .select('*').eq('user_id', userId).eq('property_id', propertyId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (!data || typeof data !== 'object') return []
    const row = data as Record<string, unknown>
    const out: string[] = []
    for (const key of ['features', 'detected_features', 'highlights']) {
      const v = row[key]
      if (Array.isArray(v)) {
        for (const item of v) {
          const label = typeof item === 'string' ? item : (item && typeof item === 'object' ? String((item as Record<string, unknown>).label ?? (item as Record<string, unknown>).name ?? '') : '')
          if (label) out.push(label)
        }
      }
    }
    return Array.from(new Set(out.map(s => s.replace(/_/g, ' ').trim()).filter(Boolean))).slice(0, 4)
  } catch {
    return []
  }
}

export async function assembleIntelligence(supabase: SupabaseClient, userId: string, jobId: string): Promise<PostIntelligence | null> {
  const candidate = await assembleCandidate(supabase, userId, jobId)
  if (!candidate) return null

  const [{ data: jobRow }, priorRes, visionHighlights] = await Promise.all([
    supabase.from('jobs').select('actual_minutes, notes, recurrence_id').eq('id', jobId).maybeSingle(),
    candidate.propertyId
      ? supabase.from('jobs').select('id', { count: 'exact', head: true })
          .eq('user_id', userId).eq('property_id', candidate.propertyId).eq('status', 'completed').neq('id', jobId)
      : Promise.resolve({ count: 0 }),
    readVisionHighlights(supabase, userId, candidate.propertyId),
  ])

  const job = jobRow as { actual_minutes: number | null; notes: string | null; recurrence_id: string | null } | null
  const priorVisits = (priorRes as { count: number | null }).count ?? 0
  const recurring = !!job?.recurrence_id || priorVisits > 0
  const relationship: PostIntelligence['relationship'] =
    priorVisits >= 4 || job?.recurrence_id ? 'regular' : priorVisits > 0 ? 'returning' : 'first'

  return {
    candidate,
    relationship,
    recurring,
    involved: bandDuration(job?.actual_minutes),
    serviceParts: detectServiceParts(`${candidate.serviceType || ''} ${job?.notes || ''}`),
    visionHighlights,
    seasonStart: isSeasonStart(candidate.season),
  }
}

// Banded property size — "a compact property" / "a larger property" — never the raw
// square footage. lawn_sqft is a measured area, not a claim the property is a lawn
// (same rule as lib/ai/assist.ts).
function lawnBand(sqft: number | null): string | null {
  if (!sqft) return null
  if (sqft < 2000) return 'a compact property'
  if (sqft > 6000) return 'a larger property'
  return null
}

// Turn the intelligence into the SUBJECT facts the prompt consumes — all phrased as a
// person would, no raw numbers.
export function intelligenceSubject(intel: PostIntelligence, voice: BrandVoice): GenSubject {
  const c = intel.candidate
  const facts: string[] = []

  facts.push(`Work done: ${intel.serviceParts.length ? intel.serviceParts.join(', ') : (c.serviceType || 'property maintenance')}.`)

  if (intel.relationship === 'first') facts.push('This was a first visit for a brand-new customer.')
  else if (intel.relationship === 'regular') facts.push('This is one of our regulars — a property we look after on a recurring schedule.')
  else facts.push('A returning customer we have looked after before.')

  if (intel.involved === 'thorough') facts.push('It was a thorough, full visit.')
  else if (intel.involved === 'quick') facts.push('It was a quick, efficient visit.')

  if (c.neighborhood) facts.push(`Neighbourhood: ${c.neighborhood}${voice.city && voice.city !== c.neighborhood ? `, ${voice.city}` : ''}.`)
  else if (c.city) facts.push(`Area: ${c.city}.`)

  if (c.season) facts.push(`Season: ${c.season}${intel.seasonStart ? ' — the season is just getting going' : ''}.`)

  const band = lawnBand(c.lawnSqft)
  if (band) facts.push(`It is ${band}.`)

  if (c.hasBefore && c.hasAfter) facts.push('There is a before-and-after photo pair to attach — the change is visible.')
  else if (c.hasAfter) facts.push('There is a finished "after" photo to attach.')

  if (c.hasReview) facts.push('This customer was happy and left a review.')

  if (intel.visionHighlights.length) facts.push(`Notable property features (from an AI property scan): ${intel.visionHighlights.join(', ')}.`)

  return { facts, season: c.season, neighborhood: c.neighborhood, city: c.city }
}
