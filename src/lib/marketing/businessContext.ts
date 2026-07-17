// ── Business context ─────────────────────────────────────────────────────────
// THE seam that tells the AI what this business actually sells, instead of the
// AI assuming.
//
// WHY THIS EXISTS
// The marketing prompts encoded one trade: campaign presets said "Summer Lawn
// Care" and "Snow & Ice", holiday angles said "Summer lawn care is in full
// swing". Meanwhile `service_templates` — the table where the owner literally
// types the services they sell — was read by the quote builder, the job form and
// settings, and by NOTHING in the AI layer. The answer was already in the
// database; the prompts just never asked.
//
// DESIGN RULES
//  • Derive, never guess. Everything here comes from rows the owner created.
//  • A business with no templates yet must not get a WORSE experience than today.
//    Every consumer falls back to the existing lawn/snow copy when this returns
//    nothing, so a lawn company sees zero regression and a new account sees what
//    it sees today.
//  • Read-only, and one query. This runs inside prompt building; it must not
//    become a reason a caption is slow or a generation fails.
//  • No second AI system, no second source of truth: this is a READ over tables
//    that already exist.

import type { SupabaseClient } from '@supabase/supabase-js'

export interface BusinessContext {
  /** Service names the owner sells, most-used first. e.g. ['Drain Cleaning', 'Water Heater Install'] */
  services: string[]
  /** Distinct categories from service_templates. e.g. ['Plumbing', 'Emergency'] */
  categories: string[]
  /** The owner's own words for what they do — default_description, when written. */
  descriptions: string[]
  /** True when we know nothing; callers MUST fall back to their existing copy. */
  empty: boolean
}

export const EMPTY_CONTEXT: BusinessContext = { services: [], categories: [], descriptions: [], empty: true }

const MAX_SERVICES = 12   // enough to characterise a business; short enough to keep a prompt tight

/**
 * What does this business sell? Answered from service_templates (what they OFFER)
 * and recent job service_types (what they actually DO — which can differ, and is
 * the better signal when it does).
 *
 * Never throws: a failure here must degrade to "we don't know" and let the caller
 * use its existing copy, not break a generation.
 */
export async function loadBusinessContext(sb: SupabaseClient, userId: string): Promise<BusinessContext> {
  try {
    const [tplRes, jobRes] = await Promise.all([
      sb.from('service_templates')
        .select('name, category, default_description')
        .eq('user_id', userId)
        .order('name'),
      // What they've actually been doing lately outranks what they once typed into
      // a template — a business drifts, and the recent work is the truth.
      sb.from('jobs')
        .select('service_type')
        .eq('user_id', userId)
        .not('service_type', 'is', null)
        .order('scheduled_date', { ascending: false })
        .limit(200),
    ])

    const tpls = (tplRes.data as { name: string | null; category: string | null; default_description: string | null }[] | null) || []
    const jobs = (jobRes.data as { service_type: string | null }[] | null) || []

    // TEMPLATES ARE THE AUTHORITY on what's sold; jobs only RANK them.
    //
    // This ordering is not arbitrary — real production data forced it. jobs.service_type
    // is free text typed in the field, and it contains customer names ("Robert mowing",
    // "Xanthe mow + prune"), non-services ("Call"), and case duplicates ("Lawn Mowing"
    // vs "Lawn mowing"). Feeding that raw into a prompt would tell the model this
    // business sells "Robert mowing" — worse than the hardcoded lawn assumption it
    // replaces. service_templates is the list the owner deliberately curated, so it
    // decides WHAT the business sells; the jobs only decide what to mention FIRST.
    const norm = (s: string) => s.trim().toLowerCase()
    const jobFreq = new Map<string, number>()
    for (const j of jobs) {
      const s = norm(j.service_type || '')
      if (s) jobFreq.set(s, (jobFreq.get(s) || 0) + 1)
    }

    // Dedupe templates case-insensitively, keeping the owner's own capitalisation.
    const byNorm = new Map<string, string>()
    for (const t of tpls) {
      const raw = (t.name || '').trim()
      if (raw && !byNorm.has(norm(raw))) byNorm.set(norm(raw), raw)
    }

    let services: string[]
    if (byNorm.size > 0) {
      services = [...byNorm.entries()]
        .sort((a, b) => (jobFreq.get(b[0]) || 0) - (jobFreq.get(a[0]) || 0) || a[1].localeCompare(b[1]))
        .map(([, raw]) => raw)
        .slice(0, MAX_SERVICES)
    } else {
      // No templates yet — fall back to what they've actually done, deduped. Messier,
      // but a new account still gets its real trade rather than an assumed one.
      const seen = new Map<string, string>()
      for (const j of jobs) {
        const raw = (j.service_type || '').trim()
        if (raw && !seen.has(norm(raw))) seen.set(norm(raw), raw)
      }
      services = [...seen.entries()]
        .sort((a, b) => (jobFreq.get(b[0]) || 0) - (jobFreq.get(a[0]) || 0))
        .map(([, raw]) => raw)
        .slice(0, MAX_SERVICES)
    }

    const categories = [...new Set(tpls.map(t => (t.category || '').trim()).filter(c => c && c !== 'General'))]
    const descriptions = tpls.map(t => (t.default_description || '').trim()).filter(Boolean).slice(0, 4)

    return { services, categories, descriptions, empty: services.length === 0 }
  } catch {
    return EMPTY_CONTEXT
  }
}

/**
 * One line describing the business, for a prompt. Returns null when we don't know
 * — callers must treat null as "say nothing", never as "assume lawn care".
 */
export function contextLine(ctx: BusinessContext): string | null {
  if (ctx.empty) return null
  const svc = ctx.services.slice(0, 6).join(', ')
  const cats = ctx.categories.length ? ` They describe their work as: ${ctx.categories.join(', ')}.` : ''
  return `This business sells: ${svc}.${cats} Write about THESE services — never invent a trade they don't do.`
}

/**
 * Does this business do seasonal work at all? Snow, pools and lawns are seasonal;
 * plumbing and electrical are not, and a "Spring Cleanup" campaign is nonsense for
 * them. Derived from their own service names rather than assumed.
 *
 * Conservative on purpose: unknown → true, so a business we can't read keeps the
 * full existing campaign set rather than silently losing options.
 */
export function looksSeasonal(ctx: BusinessContext): boolean {
  if (ctx.empty) return true
  const hay = [...ctx.services, ...ctx.categories].join(' ').toLowerCase()
  return SEASONAL_HINTS.some(h => hay.includes(h))
}

// Hints that a trade follows the calendar. Deliberately broad — the cost of a
// false positive is one irrelevant campaign preset the owner ignores; the cost of
// a false negative is a lawn company losing its Spring Cleanup campaign.
const SEASONAL_HINTS = [
  'lawn', 'mow', 'grass', 'turf', 'yard', 'garden', 'landscap', 'aerat', 'fertiliz', 'fertilis',
  'snow', 'ice', 'plow', 'plough', 'salt', 'shovel',
  'pool', 'spa', 'irrigation', 'sprinkler', 'gutter', 'leaf', 'seasonal', 'christmas', 'holiday light',
]
