import type { SupabaseClient } from '@supabase/supabase-js'
import { serviceCategory } from '@/lib/seasons'

// ── businessShape — THE derivation of what a business does ────────────────────
// EdgeQuote is lawn-care-first, but the same product has to fit a plumber, an
// HVAC tech, a cleaner, a roofer. Those trades have no lawn, and a plumber
// should not be asked for a lawn size.
//
// Nobody is ever ASKED which trade they are. There is no business_type column,
// no enum, no picker, and nothing here is written to the database — this module
// is pure derivation from rows the account already has. That is deliberate: an
// industry someone typed once is a fact that rots, while a catalogue and a job
// list are what the business is actually doing this week. A stored type would
// also be a lie the day a lawn company adds snow removal.
//
// The classification of a service NAME is not done here. It is done by
// serviceCategory() in lib/seasons.ts — the one matcher that already exists.
// That matcher is subtle: its hints deliberately match at a WORD START, because
// plain substring tests found 'ice' inside serv·ice and classified "Lawn
// Service" as SNOW. A second matcher would re-introduce exactly that class of
// bug, so this module owns the DECISION and borrows the READING.

/** Capability flags — what to SHOW, never who the owner IS.
 *
 *  There is deliberately no `BusinessType` and nothing to compare against
 *  `'lawn'`. A type would be the business_type dependency wearing a different
 *  hat: the moment code can ask "are you a lawn company?" it starts branching on
 *  identity instead of on evidence, and every new trade becomes a new enum
 *  member and a new `switch`. Flags are named for what they GATE, so a surface
 *  asks the only question it actually has: "do I render this field?" */
export interface BusinessShape {
  /** Lawn-specific PROPERTY fields: lawn_sqft, lawn_polygon, lawn-worded labels,
   *  and the prompts that nag about their absence. */
  showLawnFields: boolean
  /** false = a brand-new account with nothing to infer from. Everything defaults
   *  ON. Exposed so a caller can tell "we looked and found no lawn" apart from
   *  "there was nothing to look at". */
  hasEvidence: boolean
}

/** The rows the shape is derived from. Separating this from the query keeps the
 *  rule a pure function — the harness proves the DECISION without a database. */
export interface ShapeEvidence {
  /** The owner's own catalogue. Both fields are read: a template can be named
   *  "Weekly Visit" and filed under category "Lawn Care". */
  serviceTemplates: { name?: string | null; category?: string | null }[]
  /** jobs.service_type — what they actually do, not what they meant to sell. */
  jobServiceTypes: (string | null | undefined)[]
}

const isLawn = (s: string | null | undefined): boolean => serviceCategory(s) === 'lawn'
const saysSomething = (s: string | null | undefined): boolean => (s || '').trim().length > 0

/** THE rule. Pure — same evidence in, same flags out. */
export function deriveBusinessShape(e: ShapeEvidence): BusinessShape {
  // Only rows that SAY something are evidence. A service_template with a blank
  // name, or a job whose service_type is NULL (nullable, and common — half this
  // codebase reads `j.service_type || 'Service'`), describes no trade at all.
  //
  // Counting those rows was the first version of this rule, and it was the same
  // bug it exists to prevent, one level down: an account with 50 null-typed jobs
  // "has evidence", finds no lawn in it, and hides the fields — having learned
  // NOTHING. Rows are not evidence; legible rows are.
  const templates = e.serviceTemplates.filter(t => saysSomething(t.name) || saysSomething(t.category))
  const jobs = e.jobServiceTypes.filter(saysSomething)

  // What do they SELL, and what do they actually DO? Those are the two honest
  // answers to "what is this business", and they are the only two inputs.
  const hasLawnEvidence =
    templates.some(t => isLawn(t.name) || isLawn(t.category))
    || jobs.some(isLawn)

  // Is there anything legible to infer from at all? Deliberately NOT the same
  // question as "does it mention lawn" — the whole rule turns on the difference.
  const hasEvidence = templates.length > 0 || jobs.length > 0

  // `|| !hasEvidence` is the load-bearing clause.
  //
  // A brand-new account has no evidence in EITHER direction. Defaulting to HIDE
  // would greet a new lawn signup — the core market, the people this product was
  // built for — with a generic app on day one, and they would never find out it
  // measures lawns. Defaulting to SHOW makes an empty account byte-identical to
  // the app as it shipped before this file existed.
  //
  // ABSENCE OF EVIDENCE IS NOT EVIDENCE OF ABSENCE. "We found no lawn services"
  // and "we found no services" look the same from here and mean opposite things.
  // Every direction this rule can be wrong should fail toward showing a field
  // that does not apply (a plumber sees one stray input) rather than hiding one
  // that does (a lawn company loses the field their whole business runs on).
  return { showLawnFields: hasLawnEvidence || !hasEvidence, hasEvidence }
}

/** Should a lawn field render for THIS record?
 *
 *  The per-record override on top of the global flag: DATA ALREADY ON FILE IS
 *  ALWAYS SHOWN. A plumber who once measured a customer's yard still sees that
 *  5,000 ft² on that property — hiding a value someone can remember entering
 *  reads as data loss, and the account would be right to distrust everything
 *  else on the page.
 *
 *  This is why the global rule reads templates and jobs but NOT properties.
 *  What you DO decides the shape; what a RECORD HOLDS decides that record. Fold
 *  lawn_sqft into the global evidence and one measured property re-shapes the
 *  whole account — this override never fires, and a plumber who touched the
 *  measure tool once is a lawn company forever. */
export function showLawnFieldFor(shape: BusinessShape, value: number | null | undefined): boolean {
  return shape.showLawnFields || Number(value) > 0
}

// How many jobs to read. The failure direction decides this number: MISSING lawn
// evidence hides fields from a lawn company, so a sample that is too small is a
// regression, while one that is too large is only slow. 400 most-recent jobs is
// ~2 seasons of a 200-job/week account — and a lawn company whose last 400 jobs
// mention no lawn service does not exist. It is also explicit rather than
// leaning on PostgREST's silent 1000-row cap, which has already truncated a
// query in this codebase without anyone noticing.
const JOB_SAMPLE = 400
const TEMPLATE_CAP = 200

/** Read the evidence and derive the shape. Two small reads, both already
 *  indexed by user_id; nothing is written. */
export async function loadBusinessShape(sb: SupabaseClient, userId: string): Promise<BusinessShape> {
  const [tplRes, jobRes] = await Promise.all([
    // Inactive templates count. Retiring "Spring Aeration" for the season does
    // not stop you being a lawn company.
    sb.from('service_templates').select('name, category').eq('user_id', userId).limit(TEMPLATE_CAP),
    sb.from('jobs').select('service_type').eq('user_id', userId)
      .order('scheduled_date', { ascending: false }).limit(JOB_SAMPLE),
  ])
  return deriveBusinessShape({
    serviceTemplates: (tplRes.data as ShapeEvidence['serviceTemplates']) || [],
    jobServiceTypes: ((jobRes.data as { service_type: string | null }[]) || []).map(j => j.service_type),
  })
}

/** What an account looks like before either read returns. Shows everything —
 *  the same thing an empty account resolves to, so a page never flickers a lawn
 *  field OUT from under someone while the query is in flight. */
export const SHAPE_LOADING: BusinessShape = { showLawnFields: true, hasEvidence: false }
