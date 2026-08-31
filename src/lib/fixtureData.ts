// ── Fixture data — what is NOT this business's real book ─────────────────────
// THE one definition of "this row was created by a test, a guard or a demo, and
// must never reach a customer, a capacity figure or a revenue number".
//
// ⭐⭐ THE MEASURED STARTING POINT, because it explains every decision below:
// **no table in this schema carries a fixture marker.** There is no `is_test`,
// no `source`, no `origin`, no `seeded_by`.
//
// There IS a tenant-level verification marker used by scripts/ — verify:fixture-
// isolation owns it and describes it. It is deliberately unusable here on two
// counts: that guard forbids ANY application file from reading it (a marker that
// changes app behaviour is a test bypass, and a test bypass is worth forging),
// and it marks a whole TENANT, so it could not answer this question anyway. The
// question here is "is this ROW inside the owner's real book a fixture?".
// ⛔ Nothing in this module may consult it, by name or otherwise.
//
// So fixture-ness has to be recovered from what the fixture WRITERS already put
// in the data. They were deliberate about it, which is what makes this possible:
// every harness in scripts/ tags its rows with an unmistakable prefix.
//
// ── ⛔⛔ THE RULE THAT MATTERS MOST: TWO TIERS, NEVER ONE ────────────────────
// "Do not classify legitimate data merely because its name contains 'test'."
// A pressure-washing company sells "Deck Testing". A real customer lives on
// "Test Valley Road". A landscaper has a client called "Demo Farms". Every one
// of those is real money, and a hygiene rule that hides them is worse than the
// problem it solves — it silently deletes revenue from the owner's own reports.
//
// Therefore:
//
//   TIER 1 — CLASSIFIED (isFixture)     Unambiguous machine-written markers.
//            Acts automatically: excluded from customers, capacity, analytics,
//            routing, Growth and revenue. Nothing a human would plausibly type
//            by accident is in this set.
//
//   TIER 2 — SUSPECT (fixtureSuspicion) Looks like test data but could be real.
//            NEVER acts. It only ever produces a FLAG for the owner to decide
//            on — a cleanup candidate, a catalogue warning, a publish blocker.
//
// ⭐ The safety net for Tier 2 is not this file at all — it is PUBLICATION
// (lib/servicePublication). A "Test Service $1" that nobody classified still
// cannot reach a customer, because nothing reaches a customer until a human
// publishes it. That is why the publication default is closed: it makes being
// conservative here affordable.

/**
 * ⭐ TIER 1 — the machine-written markers, and the ONLY strings that classify.
 *
 * Every one of these is written by code in `scripts/`, was chosen to be
 * unmistakable, and is asserted by verify:production-hygiene to still be what
 * the harnesses emit. ⛔ Never add a natural word here ('test', 'demo',
 * 'sample', 'example', 'foo') — those belong in SUSPECT_PATTERNS below, where
 * they inform a human instead of acting on their own.
 *
 * Matched case-insensitively against the row's display name, anchored at the
 * START for the prefixes: a service legitimately called "Deck ZZ Restoration"
 * is not a fixture, and an anchored rule is what keeps that true.
 */
export const FIXTURE_PREFIXES: readonly string[] = [
  'zz-',        // scripts/*-cdp.mjs and several guards: ZZ-S70, ZZ-S61-FIXTURE, ZZ-GUARD-BUCKET
  'verify-',    // scripts/verify-*.ts fixture rows: VERIFY-OPTIONS, VERIFY-BUNDLE, VERIFY-ADDONS
  '__fixture',  // reserved for anything that needs a marker no human would type
]

/** Whole-name markers written verbatim by the guard harnesses. */
export const FIXTURE_EXACT_MARKERS: readonly string[] = [
  'automated guard fixture — safe to delete',
  'automated guard fixture - safe to delete',   // ASCII-dash variant, defensively
]

/**
 * ⭐⭐ SELF-IDENTIFYING ROWS — the marker that is not a prefix.
 *
 * FOUND IN LIVE PRODUCTION, and it is why this exists rather than being
 * imagined: `S61 FIELD FIXTURE — DELETE ME (A)` was an ACTIVE technician,
 * counting toward workforce capacity. The anchored prefixes above miss it
 * completely — the name begins "S61", not "ZZ-" — so the rule that was meant to
 * remove fixture workers from capacity would have left the only one that
 * actually existed.
 *
 * ⛔ THE RULE IS A CONJUNCTION, NOT A KEYWORD, and that is what keeps it Tier 1.
 * A name qualifies only when it says BOTH that it is a fixture AND that it is
 * disposable. Neither half acts alone:
 *
 *   "Light Fixture Installation"  → real electrical service. NOT classified.
 *   "Fixture Repair"              → real service. NOT classified.
 *   "Delete Me Later"             → odd, but no fixture claim. NOT classified.
 *   "S61 FIELD FIXTURE — DELETE ME (A)"  → both. Classified.
 *
 * Whoever wrote "DELETE ME" into a production row was leaving an instruction.
 * Requiring the word "fixture" beside it is what stops that instruction being
 * read into a name that merely contains one of the two words.
 */
const SELF_IDENTIFYING = [
  { needs: 'fixture', and: 'delete me' },
] as const

/**
 * ⭐⭐ HARNESS-SHAPED FIXTURE NAMES — the second conjunction, added when Growth's
 * rival classifier was folded into this one (Session 114).
 *
 * Growth had its own marker list, and it classified on SINGLE words. Measured
 * against these two rules it was both too broad AND too narrow:
 *
 *   TOO BROAD   /\bfixture\b/  classified "Light Fixture Installation".
 *               /^s\d{2,3}\s/  classified "S61 Roofing Ltd".
 *               Both are ordinary businesses. An electrician and a roofer would
 *               have watched their own revenue vanish out of Growth.
 *
 *   TOO NARROW  it had no rule for `VERIFY-…`, so guard fixtures tagged that way
 *               counted as real money in the very report meant to exclude them.
 *
 * These two shapes close the gap the narrow direction left, WITHOUT importing
 * the broad direction. Both are anchored at the start and both still require the
 * word "fixture", so neither half acts alone — the same discipline as
 * SELF_IDENTIFYING above:
 *
 *   "S61-FIXTURE CREW"            → harness token, joined by a hyphen. Classified.
 *   "ZZ S111 Fixture A"           → zz-prefixed AND says fixture. Classified.
 *   "Light Fixture Installation"  → says fixture, no harness token. NOT classified.
 *   "S61 Roofing Ltd"             → harness-shaped token, never says fixture. NOT.
 *   "ZZ Top Tribute Band Venue Clean" → zz-prefixed, never says fixture. NOT.
 *
 * ⭐ The hyphen in the first rule is load-bearing. `S61-FIXTURE` is how a script
 * joins a token to a word; `S61 Light Fixture Co` is how a person writes a name.
 * Requiring the join is what separates them, and it is why the rule is a regex
 * rather than another word pair.
 */
const HARNESS_SHAPES: readonly { shape: RegExp; alsoSays?: string }[] = [
  // scripts/s61-field-cdp.mjs: "S61-FIXTURE", "S61-FIXTURE CREW", "S61-fixture-…"
  { shape: /^s\d{1,3}[-_]fixture\b/i },
  // scripts/recurring-quote-fixture.mjs: "ZZ S111 Fixture A" — space-separated, so
  // the anchored `zz-` prefix misses it; the word "fixture" is what makes it safe.
  { shape: /^zz[\s\-_]/i, alsoSays: 'fixture' },
]

/**
 * Domains RFC 2606 and RFC 6761 RESERVE for documentation and testing. They can
 * never belong to a real business, which is the only reason an address is
 * allowed to classify at all — no English word is being judged here.
 *
 * ⚠️ Deliberately NOT `test@…`: a real company genuinely runs test@theirdomain
 * as a shared inbox, and Growth's old rule matched it. Measured before removing:
 * ZERO harnesses in scripts/ write a `test@` address, so nothing real is lost.
 */
const RESERVED_EMAIL_DOMAINS = /@(example\.(com|org|net)|.*\.(invalid|test|localhost))$/i

/**
 * ⭐⭐ THE predicate. True only for Tier 1 — a row a machine created and labelled.
 *
 * ⛔ It takes the NAME, not the row, deliberately: every entity on this seam
 * (technician, crew, service template, customer, quote, job) names its display
 * field differently, and a helper that had to know all six would grow a branch
 * per table and drift. Callers pass the one string a human would read.
 *
 * A null/blank name is NOT a fixture. "We could not read a name" is not evidence
 * of anything, and failing closed here would hide real rows.
 */
export function isFixtureName(name: string | null | undefined): boolean {
  const n = String(name ?? '').trim().toLowerCase()
  if (!n) return false
  // ⭐ The guard sentence matches as a PREFIX, not only whole. Harnesses append
  // to it ("…safe to delete accepted a quote"), and verify:production-hygiene
  // caught exactly that case: an exact-only rule let those rows through. Nothing
  // a person would type begins with this sentence, so the prefix reading is both
  // safer and stricter.
  if (FIXTURE_EXACT_MARKERS.some(m => n === m || n.startsWith(m))) return true
  // ⭐ The conjunction rule — position-independent BECAUSE both halves must be
  // present. See SELF_IDENTIFYING for why a single keyword would be unsafe here.
  if (SELF_IDENTIFYING.some(r => n.includes(r.needs) && n.includes(r.and))) return true
  // ⭐ Harness shapes: anchored, and each still requires the word "fixture"
  // (either inside the shape itself or via `alsoSays`). See HARNESS_SHAPES.
  if (HARNESS_SHAPES.some(r => r.shape.test(n) && (!r.alsoSays || n.includes(r.alsoSays)))) return true
  // A reserved documentation/testing domain cannot be a real business address.
  if (RESERVED_EMAIL_DOMAINS.test(n)) return true
  // Anchored at the start. `includes()` would classify "Deck ZZ-Top Mural".
  return FIXTURE_PREFIXES.some(p => n.startsWith(p))
}

/**
 * True when ANY of the identifying strings on a row is a fixture marker.
 *
 * ⭐ A quote is identifiable two ways — its NUMBER (guards tag them VERIFY-ADDONS,
 * ZZ-S81) and its CUSTOMER NAME (“Automated guard fixture — safe to delete”) — and
 * different harnesses set different ones. Asking both is what makes the rule work
 * across every generation of fixture without a per-harness branch.
 */
export function isAnyFixtureName(...names: (string | null | undefined)[]): boolean {
  return names.some(isFixtureName)
}

/** Convenience for the common shape: drop the fixtures out of a list of rows
 *  that each carry a display name. One call site, one rule, no per-table branch. */
export function withoutFixtures<T>(rows: readonly T[] | null | undefined, nameOf: (row: T) => string | null | undefined): T[] {
  return (rows ?? []).filter(r => !isFixtureName(nameOf(r)))
}

/** How many were dropped — so a surface can say "3 test records hidden" rather
 *  than silently showing a smaller number the owner cannot account for.
 *  ⭐ Hygiene that cannot be seen reads as data loss. */
export function fixtureCount<T>(rows: readonly T[] | null | undefined, nameOf: (row: T) => string | null | undefined): number {
  return (rows ?? []).filter(r => isFixtureName(nameOf(r))).length
}

// ── TIER 2 — suspicion. Informs a human; never acts. ─────────────────────────

export type SuspicionCode =
  | 'test_wording'        // the name reads like test data — but might be a real service
  | 'placeholder'         // lorem/asdf/xxx/tbd — almost certainly unfinished
  | 'trivial_price'       // $0 or $1 shown to customers as a real price
  | 'malformed_label'     // unreadable as a customer-facing name
  | 'duplicate_name'      // two rows a customer could not tell apart
  | 'inactive'            // switched off, so it should not be reachable
  | 'unknown_price'       // no usable displayed price

export interface Suspicion {
  code: SuspicionCode
  /** What the OWNER is told. Written for a person deciding, not for a log. */
  message: string
  /** ⭐ Does this alone justify keeping the row away from customers? A suspicion
   *  that is merely odd (test wording) must not block; one that would print a
   *  wrong price or an unreadable label must. */
  blocksPublication: boolean
}

/**
 * Words that make a row LOOK like test data. ⛔ These never classify — see the
 * two-tier rule at the top of this file. "Deck Testing" and "Demo Farms" are
 * real, and this list exists to raise an eyebrow, not to act.
 *
 * Matched as whole words so "Testing" hits and "Greatest" does not, and
 * "Sample" hits while "Samples of Work" also hits — which is correct, because
 * the owner is the one deciding.
 */
export const SUSPECT_WORDS: readonly string[] = [
  'test', 'testing', 'demo', 'sample', 'dummy', 'fake', 'example', 'scratch', 'temp', 'temporary',
]

/** Strings that are not a name at all. Unlike SUSPECT_WORDS these have no honest
 *  reading as a customer-facing label, so they DO block publication. */
export const PLACEHOLDER_WORDS: readonly string[] = [
  'lorem', 'ipsum', 'asdf', 'qwerty', 'xxx', 'tbd', 'todo', 'fixme', 'placeholder', 'untitled', 'new service',
]

const hasWord = (name: string, words: readonly string[]): boolean => {
  const n = name.toLowerCase()
  return words.some(w => new RegExp(`\\b${w}\\b`, 'i').test(n))
}

/** What the customer would be shown as this row's price, and whether it is
 *  usable. `rate` is `service_templates.default_rate`. */
export interface PricedLike {
  name: string | null | undefined
  default_rate?: number | string | null
  is_active?: boolean | null
}

/**
 * Everything questionable about ONE catalogue row, for a human to act on.
 *
 * ⛔ It NEVER rewrites anything. "Do not silently rewrite legitimate owner
 * prices" is the whole reason this returns a list of sentences instead of a
 * corrected row: a $1 service might be a genuine call-out fee, and the only
 * safe move is to say so and let the owner answer.
 */
export function catalogueSuspicions(row: PricedLike, opts?: { duplicateOfName?: string | null }): Suspicion[] {
  const out: Suspicion[] = []
  const raw = String(row.name ?? '')
  const name = raw.trim()

  if (!name) {
    out.push({ code: 'malformed_label', message: 'This service has no name — a customer would see a blank row.', blocksPublication: true })
  } else {
    if (name !== raw) {
      out.push({ code: 'malformed_label', message: `“${raw}” has leading or trailing spaces — it will not sort or match the way you expect.`, blocksPublication: false })
    }
    if (hasWord(name, PLACEHOLDER_WORDS)) {
      out.push({ code: 'placeholder', message: `“${name}” still reads as a placeholder. Give it the name a customer should see.`, blocksPublication: true })
    }
    if (hasWord(name, SUSPECT_WORDS)) {
      // ⭐ blocksPublication FALSE, on purpose. "Soil Testing" and "Demo Day
      // Cleanup" are real services. This is a question, not a verdict.
      out.push({ code: 'test_wording', message: `“${name}” reads like test data. If it is a real service, publish it and this note goes away.`, blocksPublication: false })
    }
    if (name.length > 60) {
      out.push({ code: 'malformed_label', message: `“${name.slice(0, 40)}…” is too long to read on a phone.`, blocksPublication: false })
    }
  }

  if (opts?.duplicateOfName) {
    out.push({ code: 'duplicate_name', message: `Another service is also called “${opts.duplicateOfName}” — a customer could not tell them apart.`, blocksPublication: true })
  }

  // ⚠️⚠️ `Number(null)` is 0 and `Number('')` is 0 — both FINITE. Testing
  // Number.isFinite alone therefore reported "no price at all" as a deliberate
  // $0, which is the unknown-is-zero failure this codebase keeps meeting. The
  // absence has to be checked BEFORE the coercion.
  const rawRate = row.default_rate
  const rate = rawRate === null || rawRate === undefined || String(rawRate).trim() === ''
    ? Number.NaN
    : Number(rawRate)
  if (!Number.isFinite(rate)) {
    out.push({ code: 'unknown_price', message: 'This service has no usable price, so a customer would see nothing where the price should be.', blocksPublication: true })
  } else if (rate <= 1) {
    // ⭐ THE $1 fixture case from the production audit — and the reason it is a
    // FLAG and not a rule. A $0 "Free estimate" and a $1 deposit line are both
    // legitimate. What is not legitimate is either of them reaching a customer
    // without anybody having looked.
    out.push({
      code: 'trivial_price',
      message: rate === 0
        ? 'This shows as $0 to customers. If that is deliberate (a free estimate), publish it and this note goes away.'
        : `This shows as ${rate.toFixed(2)} to customers, which usually means a price was never set.`,
      blocksPublication: true,
    })
  }

  if (row.is_active === false) {
    out.push({ code: 'inactive', message: 'This service is switched off, so it cannot be offered to anyone.', blocksPublication: true })
  }

  return out
}

/** Does anything about this row justify keeping it off the customer catalogue?
 *  ⭐ Advisory for the UI — the DATABASE is what actually gates publication. */
export function blocksPublication(suspicions: readonly Suspicion[]): boolean {
  return suspicions.some(s => s.blocksPublication)
}

/** Names that appear more than once, lower-cased and trimmed. The caller passes
 *  the whole catalogue; this is the only check that needs the set, not the row. */
export function duplicateNameSet(names: readonly (string | null | undefined)[]): Set<string> {
  const seen = new Map<string, number>()
  for (const n of names) {
    const k = String(n ?? '').trim().toLowerCase()
    if (!k) continue
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  return new Set([...seen.entries()].filter(([, c]) => c > 1).map(([k]) => k))
}

// ── The cleanup report ───────────────────────────────────────────────────────
/**
 * One cleanup candidate, as the owner needs to see it before deciding.
 *
 * ⛔⛔ NOTHING IN THIS MODULE DELETES ANYTHING, and nothing may be built on top
 * of it that does so without a human saying yes to a specific list. A fixture
 * row can be referenced by a job, an invoice or a quote that is real; deleting
 * it silently would take real history with it. That is why `references` is a
 * required field and `action` is a RECOMMENDATION.
 */
export interface CleanupCandidate {
  entity: string
  id: string
  name: string
  /** Why we believe this is fixture data — the exact marker that matched. */
  evidence: string
  /** What points at it, so the owner can see what a delete would take with it. */
  references: Array<{ table: string; count: number }>
  /** ⭐ RECOMMENDED, never performed. `archive` is preferred wherever the entity
   *  supports it: it removes the row from every live surface while keeping the
   *  history that references it intact. */
  action: 'archive' | 'deactivate' | 'delete' | 'review'
  reason: string
}

/** The recommendation, from the references. ⭐ The rule: anything real points at
 *  it ⇒ never delete, because that history is the owner's. */
export function recommendedAction(
  refs: readonly { table: string; count: number }[],
  supports: { archive?: boolean; deactivate?: boolean },
): CleanupCandidate['action'] {
  const referenced = refs.some(r => r.count > 0)
  if (referenced) return supports.archive ? 'archive' : supports.deactivate ? 'deactivate' : 'review'
  if (supports.archive) return 'archive'
  if (supports.deactivate) return 'deactivate'
  return 'delete'
}
