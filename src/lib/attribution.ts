import type { SupabaseClient } from '@supabase/supabase-js'
import { isWon } from '@/lib/winLoss'

// ── THE answer to "where did this customer come from?" ───────────────────────
//
// EdgeHQ already had ONE field for this — `customers.acquisition_source` — and
// four different vocabularies writing into it:
//
//   1. ACQUISITION_SOURCES (src/types)  — the owner's dropdown on the customer form
//      → 'Referral' · 'Google' · 'Facebook' · 'Instagram' · 'Nextdoor' · …
//   2. HEAR_ABOUT_OPTIONS (below)       — the customer's dropdown on the PUBLIC booking page
//      → 'Referral from a friend' · 'Google Business Profile' · 'Drove by / yard sign' · …
//   3. intake door labels               — 'Website' · 'Website Booking' · 'Online Booking'
//      · 'Formspree' · 'webhook' (lib/intake, lib/integrations/inboundActions)
//   4. `p_utm->>'source'` on submit_booking — arbitrary text off a public URL
//
// Four vocabularies on one column is how a book ends up with Facebook, FB, facebook
// ad and Meta as four different "sources". It had not happened yet in production
// only because the second and fourth doors had produced no rows there — the code
// was already loaded.
//
// The fix is NOT a fifth field, a taxonomy table, or a rewrite of the existing 103
// rows. It is one normalizer, applied at READ time, over a column whose raw value is
// left exactly as it was written:
//
//   • The raw string stays the record of what was actually said. No migration, no
//     destructive rewrite; every legacy value keeps working.
//   • The CATEGORY is derived here, and nowhere else. A second copy of this mapping
//     is a second attribution engine (see [engineering-principles] §3).
//   • Anything this file does not recognise becomes `other` WITH ITS RAW TEXT KEPT
//     as detail — never silently folded into a real channel.
//   • Absent/blank becomes `unknown`, and `unknown` is a first-class answer that is
//     always shown. It never becomes "organic", "website", or anything else.
//
// ⛔ WHAT THIS FILE DELIBERATELY IS NOT.
// It records where a customer said they came from. That is not ad attribution.
// There is no paid-vs-organic split (a customer choosing "Google" is not evidence
// of an ad — inventing that distinction would be a claim EdgeHQ cannot support),
// no ad-platform spend, no ROAS, no multi-touch. And no money: see the note above
// `AcquisitionFunnel` for why revenue is out of V1 on purpose.

/**
 * The canonical channel set. Deliberately a SUPERSET of the two existing dropdowns
 * plus the intake door labels, and deliberately nothing more — every key below is
 * something one of the real doors can already produce evidence for.
 */
export type SourceCategory =
  | 'referral' | 'repeat' | 'google' | 'facebook' | 'instagram' | 'nextdoor'
  | 'online_form' | 'signage' | 'print' | 'door_knock' | 'other' | 'unknown'

export interface SourceCategoryMeta {
  key: SourceCategory
  label: string
  /** One line, for a tooltip or a report footnote. Says what the bucket MEANS. */
  hint: string
}

/**
 * Display order: the channels an owner acts on first, then the residuals. `other`
 * and `unknown` are last and are never dropped — a report that hides its residual
 * is a report that overstates everything above it.
 */
export const SOURCE_CATEGORIES: SourceCategoryMeta[] = [
  { key: 'referral',    label: 'Referral',            hint: 'Sent by someone who already knows you.' },
  { key: 'repeat',      label: 'Repeat customer',     hint: 'Came back on their own.' },
  { key: 'google',      label: 'Google',              hint: 'Search or the maps listing. EdgeHQ cannot tell paid from organic, and does not guess.' },
  { key: 'facebook',    label: 'Facebook',            hint: 'Facebook, including Meta ads.' },
  { key: 'instagram',   label: 'Instagram',           hint: 'Instagram, including Meta ads.' },
  { key: 'nextdoor',    label: 'Nextdoor',            hint: 'The Nextdoor neighbourhood app.' },
  { key: 'online_form', label: 'Website / online form', hint: 'They arrived through your own form or booking link. That is the DOOR they used — whatever sent them to it is unknown unless they said.' },
  { key: 'signage',     label: 'Signage or drove by',  hint: 'Truck lettering, a yard sign, or they saw you working.' },
  { key: 'print',       label: 'Flyer, mailout or QR', hint: 'Something printed.' },
  { key: 'door_knock',  label: 'Door knocking',        hint: 'You went to them.' },
  { key: 'other',       label: 'Other',                hint: 'Recorded, but not one of the channels above. The words used are kept.' },
  { key: 'unknown',     label: 'Not recorded',         hint: 'Nobody wrote down where this customer came from. Not a channel — a gap.' },
]

const LABEL_BY_KEY: Record<SourceCategory, string> =
  Object.fromEntries(SOURCE_CATEGORIES.map(c => [c.key, c.label])) as Record<SourceCategory, string>

export const sourceLabel = (c: SourceCategory): string => LABEL_BY_KEY[c] ?? LABEL_BY_KEY.other

/**
 * The public booking page's "How did you hear about us?" list — the CUSTOMER's own
 * words, in the customer's language. It lived inline in BookingClient; it lives here
 * now so the vocabulary and its normalizer sit in one file and cannot drift apart.
 * The eight strings are byte-identical to what shipped: this is a move, not a rewrite
 * of the public funnel's copy.
 */
export const HEAR_ABOUT_OPTIONS = [
  'Website', 'Google Business Profile', 'QR code', 'Facebook', 'Nextdoor',
  'Referral from a friend', 'Drove by / yard sign', 'Other',
] as const

/**
 * Longest source string we will store. Comfortably above the longest real option
 * ('Referral from a friend' is 22) and short enough that a public URL parameter
 * cannot be used to stuff the column. Mirrored by `sanitize_source_input` in SQL —
 * the two are pinned together by verify:attribution.
 */
export const MAX_SOURCE_LEN = 60

/**
 * The PUBLIC-door guard. A booking submission can carry `hear_about` and
 * `utm_source` straight off a URL, so this is an untrusted-input boundary:
 * collapse whitespace, drop control characters, bound the length. Returns null for
 * anything that is empty once cleaned, so the caller falls through to its own door
 * label instead of storing a blank.
 *
 * ⭐ It deliberately does NOT enforce the vocabulary. Rejecting unrecognised values
 * at write time would need this file's mapping duplicated in PL/pgSQL — a second
 * copy that drifts. Instead the raw survives, and `normalizeSource` (the ONE
 * mapping) decides at read time what it means; anything it doesn't know lands in
 * `other` with its text intact, so the cardinality of a report is bounded no matter
 * what a public caller sends.
 */
export function sanitizeSourceInput(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim()
  // Trim again after the cut: slicing a bounded string can leave a trailing space.
  const bounded = cleaned.slice(0, MAX_SOURCE_LEN).trim()
  return bounded || null
}

// Ordered rules. ORDER IS LOAD-BEARING and is pinned by the guard:
//   • `nextdoor` must beat `door_knock`, or every Nextdoor lead becomes door knocking.
//   • `instagram` must beat `facebook`, so 'Instagram/Facebook' resolves to the more
//     specific platform named rather than to whichever appears first in the string.
//   • `google` must beat `online_form`, or 'Google Business Profile' would be
//     swallowed by a 'profile'/'site' style match later on.
//   • `repeat` must beat `referral`: 'repeat referral customer' is a returning
//     customer first.
const RULES: { cat: Exclude<SourceCategory, 'unknown' | 'other'>; test: RegExp }[] = [
  { cat: 'repeat',      test: /\brepeat\b|\breturning\b|existing customer|previous customer/ },
  { cat: 'nextdoor',    test: /next ?door/ },
  { cat: 'instagram',   test: /\binstagram\b|\big\b|\binsta\b/ },
  { cat: 'facebook',    test: /\bfacebook\b|\bfb\b|\bmeta\b|\bmessenger\b|\bmarketplace\b/ },
  { cat: 'google',      test: /\bgoogle\b|\bgbp\b|\bgmb\b|business profile|\bmaps\b|\bsearch\b|\bbing\b|\bseo\b|\bsem\b|\bppc\b|\badwords\b/ },
  { cat: 'referral',    test: /referr?al|\breferred\b|word of mouth|\bfriend\b|\bneighbou?r\b|\brecommend/ },
  // 'door to door' is safe here only because `nextdoor` already matched above —
  // and it could not collide anyway: the punctuation-to-space normalisation leaves
  // 'Nextdoor' as ONE word, which can never look like this three-word phrase.
  { cat: 'door_knock',  test: /\bknock|door to door/ },
  { cat: 'signage',     test: /\bsign\b|signage|yard sign|lawn sign|\btruck\b|\bvehicle\b|\btrailer\b|drove by|\bdriving by\b|saw you|saw your/ },
  { cat: 'print',       test: /\bflyer\b|\bflier\b|mail ?out|\bmailer\b|door hanger|\bpostcard\b|\bnewspaper\b|\bprint\b|\bqr\b/ },
  // 'formspree' / 'webhook' / 'api' / 'zapier' / 'make' are the integration door
  // labels (lib/intake, lib/integrations) — they name HOW the submission arrived,
  // which is exactly what `online_form` means.
  { cat: 'online_form', test: /\bwebsite\b|\bweb\b|\bsite\b|online booking|\bbooking\b|\bform\b|formspree|\bwebhook\b|\bapi\b|\bzapier\b|\bmake\b|\bonline\b/ },
]

/**
 * Map any recorded source string to exactly one canonical category. Total and
 * deterministic: every input returns a category, the same one, every time.
 *
 * Blank/absent → `unknown`. Present but unrecognised → `other`. There is no path
 * from a blank value to a real channel: an unknown source stays visibly unknown.
 */
export function normalizeSource(raw: string | null | undefined): SourceCategory {
  const cleaned = sanitizeSourceInput(raw)
  if (!cleaned) return 'unknown'
  // Compare on a lowercased form with punctuation reduced to spaces, so
  // 'Flyer / Mailout', 'flyer-mailout' and 'FLYER MAILOUT' are one value. Word
  // boundaries in the rules above rely on this normalisation.
  const s = ` ${cleaned.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `
  for (const r of RULES) if (r.test.test(s)) return r.cat
  return 'other'
}

export interface SourceDescription {
  category: SourceCategory
  label: string
  /**
   * The raw string, kept when it says more than the category label does — so
   * 'Google Business Profile' is not flattened to 'Google' on a customer's record,
   * and an unrecognised value is readable rather than just "Other". Null when the
   * raw adds nothing (it matched the label) or when there is no raw at all.
   */
  detail: string | null
}

/**
 * The category AND the words that produced it. This is what a per-customer surface
 * should render — the customer profile used to run its own inline regex for the
 * same job ('formspree|webhook|api|zapier' → 'Website'), which was a second mapping
 * in a file that has no business owning one.
 */
export function describeSource(raw: string | null | undefined): SourceDescription {
  const category = normalizeSource(raw)
  const label = sourceLabel(category)
  const cleaned = sanitizeSourceInput(raw)
  const detail = cleaned && cleaned.toLowerCase() !== label.toLowerCase() ? cleaned : null
  return { category, label, detail: category === 'unknown' ? null : detail }
}

// ── The acquisition funnel ───────────────────────────────────────────────────
//
// ⭐ THE UNIT IS THE CUSTOMER, and that is the whole answer to "how do you avoid
// counting a lead twice?". Acquisition is a property of a customer (it is stored on
// the customer row), so every stage below is a YES/NO about that ONE customer:
// "did they ever get a quote", not "how many quotes". A customer with five won
// quotes and nine completed visits contributes exactly 1 to each stage. Nothing in
// this file sums a per-quote or per-job number, so no join can multiply anything.
//
// Note the denominator this makes honest: "leads" is not a table in EdgeHQ.
// `website_leads` is only ONE of three intake doors, and a customer entered by hand
// or won by door knocking never has a row in it. Counting customers counts all of
// them, which is why the report says "customers", not "leads".

/** Quote statuses that mean "a real quote exists" — a draft is not a quote yet. */
const isIssuedQuote = (status: string) => status !== 'draft'

export interface FunnelInputCustomer { id: string; acquisition_source: string | null }
export interface FunnelInputQuote { customer_id: string | null; status: string }
export interface FunnelInputJob { customer_id: string | null; status: string }

export interface SourceFunnelRow {
  category: SourceCategory
  label: string
  /** Distinct raw strings behind this category, so 'Other' is never a black box. */
  details: string[]
  /** Customers acquired from this channel. The denominator for everything else. */
  customers: number
  /** …of whom this many were ever sent a real (non-draft) quote. */
  quoted: number
  /** …of whom this many accepted one. Uses winLoss.isWon — never a second rule. */
  won: number
  /** …of whom this many have at least one COMPLETED visit. The end of the funnel. */
  worked: number
  /**
   * won / customers, 0..1 — or NULL when the cohort is too small to state a rate
   * without overstating it. Counts are always present; a percentage is not.
   */
  wonRate: number | null
}

/**
 * ⛔ NO MONEY IN THIS SHAPE, ON PURPOSE.
 *
 * Source-level revenue is not safe to state yet and is deliberately out of V1:
 * an invoice total is not revenue (a cancelled invoice keeps its full balance, and
 * a deposit is a partial payment of an existing invoice), a payment is not
 * attributable to acquisition, and job-level profit is a separate lane's work.
 * Adding a dollar column here would put a second engine on money — the thing this
 * codebase has been bitten by most. Counts are the honest deliverable for V1.
 */
export interface AcquisitionFunnel {
  rows: SourceFunnelRow[]
  /** Every customer counted, including the ones with no source. */
  customers: number
  /** Customers whose source is recorded (i.e. not `unknown`). */
  known: number
  /** 0..100, or null when there are no customers at all. A big number here is a
   *  DATA-QUALITY finding to be shown, not a rounding error to be hidden. */
  unknownPct: number | null
  /** The cohort size below which `wonRate` is withheld. Surfaced so the UI can say why. */
  minSampleForRate: number
}

/**
 * Cohorts of 10 or more get a percentage. Below that the counts are shown alone.
 *
 * This is not timidity: at n=2, one customer moves the rate by 50 points, and a
 * "50% of Google leads convert" line on two customers is a sentence an owner would
 * act on and should not. Ten is the point where a single record stops dominating.
 */
export const MIN_SAMPLE_FOR_RATE = 10

/**
 * Pure. Takes the three lists and returns the funnel — no fetching, no clock, no
 * randomness, so the guard can drive it with fixtures and assert exact numbers.
 *
 * Rows are sorted by cohort size, largest first, EXCEPT that `unknown` is always
 * last and is always present when it has any customers at all. A source report that
 * ranks its own blind spot into first place buries the channels underneath it; one
 * that omits the blind spot lies about the total.
 */
export function buildAcquisitionFunnel(
  customers: FunnelInputCustomer[],
  quotes: FunnelInputQuote[],
  jobs: FunnelInputJob[],
): AcquisitionFunnel {
  // Stage membership as SETS of customer ids — this is what makes a customer with
  // many quotes or many visits count exactly once, structurally rather than by
  // remembering to de-duplicate later.
  const quotedIds = new Set<string>()
  const wonIds = new Set<string>()
  const workedIds = new Set<string>()
  for (const q of quotes) {
    if (!q.customer_id) continue          // an orphan quote has no acquisition source
    if (isIssuedQuote(q.status)) quotedIds.add(q.customer_id)
    if (isWon(q.status)) wonIds.add(q.customer_id)
  }
  for (const j of jobs) {
    if (!j.customer_id) continue
    if (j.status === 'completed') workedIds.add(j.customer_id)
  }

  const acc = new Map<SourceCategory, SourceFunnelRow & { rawSeen: Set<string> }>()
  const rowFor = (cat: SourceCategory) => {
    let r = acc.get(cat)
    if (!r) {
      r = { category: cat, label: sourceLabel(cat), details: [], customers: 0, quoted: 0, won: 0, worked: 0, wonRate: null, rawSeen: new Set() }
      acc.set(cat, r)
    }
    return r
  }

  let known = 0
  for (const c of customers) {
    const d = describeSource(c.acquisition_source)
    const r = rowFor(d.category)
    r.customers++
    if (d.category !== 'unknown') known++
    if (d.detail) r.rawSeen.add(d.detail)
    // A won quote implies an issued quote, and a completed visit implies a won
    // quote — but only in theory. Jobs can be created directly, without a quote,
    // so each stage is counted from its OWN evidence and a later stage may exceed
    // an earlier one. That is a true fact about the book, not a bug to clamp:
    // pretending otherwise would invent quotes that were never sent.
    if (quotedIds.has(c.id)) r.quoted++
    if (wonIds.has(c.id)) r.won++
    if (workedIds.has(c.id)) r.worked++
  }

  const rows: SourceFunnelRow[] = [...acc.values()].map(({ rawSeen, ...r }) => ({
    ...r,
    details: [...rawSeen].sort((a, b) => a.localeCompare(b)),
    wonRate: r.customers >= MIN_SAMPLE_FOR_RATE ? r.won / r.customers : null,
  }))
  rows.sort((a, b) =>
    (a.category === 'unknown' ? 1 : 0) - (b.category === 'unknown' ? 1 : 0) ||
    b.customers - a.customers ||
    a.label.localeCompare(b.label))

  const total = customers.length
  const unknownCount = total - known
  return {
    rows,
    customers: total,
    known,
    unknownPct: total > 0 ? Math.round((unknownCount / total) * 100) : null,
    minSampleForRate: MIN_SAMPLE_FOR_RATE,
  }
}

/**
 * Returns NULL when any load-bearing read failed — never a zeroed board.
 *
 * All three reads are load-bearing here, which is the whole point. supabase-js
 * RESOLVES with `{ data: null, error }` on a dead connection, so a tolerant `|| []`
 * on the QUOTES read would render "Facebook: 37 customers, 0 quoted, 0 won" — a
 * confident, specific, entirely false verdict that Facebook never converts. Same
 * class of bug as loadCustomerHealth's all-clear and loadWinLoss's vanishing panel.
 * A connection problem must look like a connection problem.
 *
 * Every read is tenant-scoped with an explicit `user_id` filter on top of RLS, so
 * one business can never see another's acquisition data even if a policy regressed.
 */
export async function loadAcquisitionFunnel(supabase: SupabaseClient): Promise<AcquisitionFunnel | null> {
  // getSession (local) rather than getUser (network hop) — the id only scopes reads
  // that RLS already constrains. Matches loadWinLoss.
  const { data: { session } } = await supabase.auth.getSession()
  const uid = session?.user?.id
  if (!uid) return null

  const [cRes, qRes, jRes] = await Promise.all([
    supabase.from('customers').select('id, acquisition_source').eq('user_id', uid).is('archived_at', null),
    supabase.from('quotes').select('customer_id, status').eq('user_id', uid),
    supabase.from('jobs').select('customer_id, status').eq('user_id', uid),
  ])
  if (cRes.error || qRes.error || jRes.error) return null

  return buildAcquisitionFunnel(
    (cRes.data as FunnelInputCustomer[]) || [],
    (qRes.data as FunnelInputQuote[]) || [],
    (jRes.data as FunnelInputJob[]) || [],
  )
}
