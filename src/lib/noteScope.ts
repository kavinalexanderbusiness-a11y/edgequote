// ── Scoped notes: WHO IS THIS WRITTEN FOR ────────────────────────────────────
// EdgeQuote carries three kinds of written information, and they must never
// leak into one another:
//
//   INTERNAL  the business only — "don't discount below $700", "difficult about
//             the last invoice". Never leaves the owner's own screens.
//   CREW      the people doing the work — "use the east gate", "don't prune the
//             lilac", plus the reference photo/video that shows them where.
//   CUSTOMER  written FOR the person paying — "disposal is included",
//             "irrigation repairs are not". Printed on documents they receive.
//
// ⭐ THE MODEL, AND WHY THERE IS NO `visibility` COLUMN ANYWHERE
// This codebase already answers "who may read this" — with the COLUMN ITSELF.
// invoices.notes prints on the customer's PDF and invoices.internal_notes never
// does. jobs.notes goes to the worker's phone; jobs.completion_summary goes to
// the customer; jobs.completion_issue goes to neither. The audience is a
// property of the FIELD, decided once when the field is created, and enforced
// by which server-side projection selects it.
//
// A generic `notes` table with a `visibility` enum would be a SECOND answer to
// that question — and a strictly worse one, because a wrong enum value is one
// UPDATE away from publishing a gate code, whereas a wrong column requires
// someone to add it to get_portal_data on purpose. Every audience mistake this
// product has actually shipped (jobs.notes rendered in the portal; machine text
// and AutoPay hold reasons printed on invoices) was fixed by SPLITTING A FIELD,
// never by adding a flag. So this module does not introduce a mechanism. It
// NAMES the one already in use, writes down every field it governs, and gives
// verify:scoped-notes something executable to hold the line with.
//
// ⛔ Do not add a runtime "can user X read note Y" function here. Enforcement is
// not a shared predicate — it is the explicit column list in get_portal_data,
// the explicit column list in crew_day, and the assignment check in
// /api/crew/media. This module is the MAP; those are the doors.

export type NoteAudience = 'internal' | 'crew' | 'customer'

/** Every surface a piece of text can come out of. */
export type NoteReader = 'owner' | 'crew' | 'customer'

/**
 * Which readers each audience admits. Owner sees everything the business wrote
 * — that is what "owner" means — so every audience includes them.
 */
export const AUDIENCE_READERS: Record<NoteAudience, readonly NoteReader[]> = {
  internal: ['owner'],
  crew: ['owner', 'crew'],
  customer: ['owner', 'crew', 'customer'],
} as const

/**
 * The owner-facing words for each audience, written ONCE so the same promise is
 * made on every screen. The owner must never have to guess, and must never read
 * two different sentences about the same field.
 */
export const AUDIENCE_COPY: Record<NoteAudience, { label: string; help: string }> = {
  internal: {
    label: 'Internal note',
    help: 'Only your team can see this. Never on the PDF or in the customer portal.',
  },
  crew: {
    label: 'Work instructions',
    help: 'Goes to the crew assigned to this visit. Customers never see it.',
  },
  customer: {
    label: 'Note to customer',
    help: 'Appears on the quote PDF and in the customer portal.',
  },
}

export interface ScopedNoteField {
  table: string
  column: string
  audience: NoteAudience
  /** What the field is for, in the owner's language. */
  purpose: string
  /**
   * The server-side thing that actually keeps the promise — the projection, the
   * route, or the absence of one. This is the string a reviewer should go read
   * before believing the audience above.
   */
  enforcedBy: string
  /**
   * ⭐ Set when the WHOLE TABLE is one audience rather than one column of a
   * mixed-audience table. crew_media and crew_messages are like this: there is
   * no customer-facing column anywhere in them, so the strongest possible check
   * is that the TABLE NAME never appears in a customer projection at all —
   * qualified, nested, aliased or otherwise. Columns on mixed tables (jobs,
   * quotes) cannot be checked that way, because their table legitimately does
   * appear; those fall back to reading the projection's column list.
   */
  wholeTable?: true
}

/**
 * ⭐ THE REGISTRY. Every persisted free-text field whose audience matters.
 *
 * Adding a note field to the product means adding a line here, and
 * verify:scoped-notes will then hold it to its word: nothing marked `internal`
 * or `crew` may appear in get_portal_data's projection or in any PDF component.
 *
 * Fields NOT listed are ones with no customer-facing surface at all (supplier
 * notes, PO notes, equipment notes, payroll notes). They are internal by
 * construction — there is no door they could come out of — and listing them
 * would pad the map without adding a guarantee.
 */
export const SCOPED_NOTE_FIELDS: readonly ScopedNoteField[] = [
  // ── Customer ───────────────────────────────────────────────────────────────
  {
    table: 'customers',
    column: 'notes',
    audience: 'internal',
    purpose: 'What the office knows about this customer — how they pay, how they like to be contacted, what went wrong last time.',
    enforcedBy: "get_portal_data's `customer` projection names its columns and does not include notes.",
  },

  // ── Quote ──────────────────────────────────────────────────────────────────
  {
    table: 'quotes',
    column: 'notes',
    audience: 'customer',
    purpose: 'The scope note the customer reads — what is included, what is not, what depends on supply.',
    enforcedBy: "Rendered by QuotePDF's Notes box and selected by get_portal_data. Customer-facing BY DESIGN.",
  },
  {
    table: 'quotes',
    column: 'internal_notes',
    audience: 'internal',
    purpose: "The owner's own margin on this quote — a price floor, who to call before changing scope, why it was priced this way.",
    enforcedBy: 'Absent from get_portal_data\'s explicit quote column list and from every PDF component. Pinned by verify:scoped-notes.',
  },

  // ── Invoice (pre-existing — 2026-07-15) ────────────────────────────────────
  {
    table: 'invoices',
    column: 'notes',
    audience: 'customer',
    purpose: 'What prints in the Notes box on the invoice the customer receives.',
    enforcedBy: 'Rendered by InvoicePDF and selected by get_portal_data. Customer-facing BY DESIGN.',
  },
  {
    table: 'invoices',
    column: 'internal_notes',
    audience: 'internal',
    purpose: 'System provenance (auto-draft origin) and the AutoPay hold flag + its reason.',
    enforcedBy: 'Never rendered by any PDF; absent from get_portal_data.',
  },

  // ── Property (added by the location-intelligence pass, same day) ───────────
  // ⭐ CONVERGENT EVIDENCE THAT THE MODEL IS RIGHT. A separate session hit the
  // same wall from the other side — "where does 'gate is on the east side'
  // go?" — and landed on the identical answer without coordination: reuse
  // `internal_notes` as THE product-wide name for "the owner's, never the
  // customer's", and let the column carry the audience. Two independent passes
  // choosing the same shape is the strongest argument against inventing a
  // visibility enum here.
  {
    table: 'properties',
    column: 'notes',
    audience: 'customer',
    purpose: 'What the provider wants the customer to know about their property.',
    enforcedBy: "Selected by get_portal_data and rendered under 'Notes from your provider'. Customer-facing BY DESIGN.",
  },
  {
    table: 'properties',
    column: 'internal_notes',
    audience: 'internal',
    purpose: 'Private facts about the PLACE — where the gate is, which dog, where the irrigation controller lives.',
    enforcedBy: "get_portal_data enumerates the property columns it returns, so a new column is invisible to the portal by construction. Also pinned by verify:location-intelligence.",
  },

  // ── Visit (a `jobs` row IS a visit) ────────────────────────────────────────
  {
    table: 'jobs',
    column: 'notes',
    audience: 'crew',
    purpose: 'The access and instruction note for whoever does the work — gate code, where to park, what not to touch.',
    enforcedBy: "Shipped by crew_day as stops[].notes. REMOVED from get_portal_data 2026-08-11 after it was found rendering to customers.",
  },
  {
    table: 'jobs',
    column: 'completion_summary',
    audience: 'customer',
    purpose: 'What was done, written for the person who paid for it.',
    enforcedBy: 'Selected by get_portal_data and rendered in the portal visit history. Customer-facing BY DESIGN.',
  },
  {
    table: 'jobs',
    column: 'completion_issue',
    audience: 'internal',
    purpose: 'What the field found that needs the office — a leaking head, a hedge worth quoting.',
    enforcedBy: 'Absent from get_portal_data. Shown to the crew who wrote it, never to a customer.',
  },

  // ── Crew reference media (2026-08-11) ──────────────────────────────────────
  {
    table: 'crew_media',
    column: 'caption',
    audience: 'crew',
    wholeTable: true,
    purpose: 'What this reference photo or video is showing — "the gate", "mulch depth here".',
    enforcedBy: 'The whole table is crew-audience: reachable only through /api/crew/media, which proves crew assignment, and the owner\'s own RLS. No portal projection selects it.',
  },

  // ── The visit conversation (Crew Communications V1) ────────────────────────
  // ⭐ THE OTHER HALF OF A DISTINCTION THIS REGISTRY DID NOT YET HAVE A WORD FOR.
  // Everything above is a NOTE: a standing fact about the work, edited in place,
  // authorless, correct whoever wrote it. crew_messages is a MESSAGE: an
  // utterance at a moment, appended, never edited, and meaningless without its
  // author and its time. The audience model is unchanged and is the reason this
  // is a new TABLE rather than a `kind` column on an existing one — the table IS
  // the audience, exactly as it is for crew_media.
  {
    table: 'crew_messages',
    column: 'body',
    audience: 'crew',
    wholeTable: true,
    purpose: 'What the office and the assigned crew said to each other about this visit — "use the side gate", "we\'re short one bag", "approved".',
    enforcedBy: 'The whole table is crew-audience. No portal projection, no PDF and no public API selects it; a crew session reaches it only through the crew_job_messages/crew_post_message DEFINER RPCs, which re-prove employer + crew assignment. Pinned by verify:scoped-notes and verify:crew-messages.',
  },
] as const

/**
 * Fields that must never reach a customer. This is the list verify:scoped-notes
 * greps the portal RPC and the PDF components against — so the guard is derived
 * from the registry rather than hand-kept beside it, and a new internal field
 * is protected the moment it is declared above.
 */
export function fieldsHiddenFromCustomers(): ScopedNoteField[] {
  return SCOPED_NOTE_FIELDS.filter(f => !AUDIENCE_READERS[f.audience].includes('customer'))
}

/** Fields a crew session is allowed to receive. */
export function fieldsVisibleToCrew(): ScopedNoteField[] {
  return SCOPED_NOTE_FIELDS.filter(f => AUDIENCE_READERS[f.audience].includes('crew'))
}
