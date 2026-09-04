// ── Synthetic props for the S122 browser fixture ─────────────────────────────
//
// ⛔ THESE ARE PROPS, NOT A UI. Nothing here draws anything or restates a rule.
// Every screen the fixture shows is produced by the REAL components from these
// values, through the REAL `buildPortalView` — so what a reviewer sees in the
// browser is what a customer would see, not a hand-built lookalike.
//
// ⛔ NO REAL DATA. Names, ids, addresses and tokens are all obviously fake and
// carry the `zz-` / `ZZ ` marker this repo uses for disposable fixtures. The
// numbers are EPS-2026-0152's shape — current total $500 against a stale
// `accepted_price` of $1,400 — because that is the live shape the whole S122
// lane exists to answer, and a fixture that used round friendly numbers would
// not show the contradiction it is meant to expose.

import type { PortalData, PortalQuote } from '@/app/portal/[token]/model'

export const FIXTURE_TODAY = '2026-09-04'

/** The four states the customer-facing surfaces must distinguish. */
export type FixtureKind = 'legacy_unrecorded' | 'customer' | 'owner_on_behalf' | null

const baseQuote: PortalQuote = {
  id: 'zz-quote-1',
  quote_number: 'ZZ-2026-0152',
  service_type: 'Landscaping',
  address: '1 Fixture Street',
  property_id: null,
  // ⭐ The contradiction lives in these two lines. A 50% rule over $500 asks
  // $250; over the unproven $1,400 snapshot it asks $700.
  total: 500,
  initial_price: 500,
  subtotal: null,
  weekly_price: null,
  biweekly_price: null,
  monthly_price: null,
  notes: null,
  status: 'accepted',
  created_at: FIXTURE_TODAY,
  issued_date: FIXTURE_TODAY,
  valid_until: '2026-12-31',
  crew_size: 1,
  hours: 2,
  travel_fee: 0,
  accepted_price: 1400,
  acceptance_kind: null,
  deposit_type: 'percent',
  deposit_value: 50,
}

/** One quote in a named evidence state — the only thing that varies per scene. */
export function fixtureQuote(kind: FixtureKind): PortalQuote {
  return { ...baseQuote, acceptance_kind: kind }
}

export function fixtureData(kind: FixtureKind): PortalData {
  return {
    customer: {
      id: 'zz-customer-1', name: 'ZZ Fixture Customer', email: null, phone: null,
      address: '1 Fixture Street', city: 'Calgary',
    },
    business: {
      company_name: 'ZZ Fixture Landscaping', owner_name: 'ZZ Owner', phone: null,
      email_primary: null, email_secondary: null, website: null, logo_url: null,
      logo_scale: null, base_address: null,
      terms_text: 'We accept cash, cheque and e-transfer. Please give 24 hours notice to cancel.',
      gst_percent: 0,
    },
    property: null,
    properties: [],
    quotes: [fixtureQuote(kind)],
    invoices: [],
    jobs: [],
    recurrences: [],
    photos: [],
    // ⛔ An EMPTY ledger on purpose: nothing has been collected, so the gate's
    // `outstanding` equals its `required` and the figure on screen is the whole
    // ask. A partial payment would be a different (also real) scene and would
    // blur what this one is for.
    payments: [],
  }
}

// ── The owner-confirmation scenes ────────────────────────────────────────────
// These are the API answers the dialog gets, verbatim in the shape
// /api/quotes/record-acceptance actually returns. ⛔ Not paraphrased: if the
// route's contract changes, this fixture stops matching it and the browser run
// shows the same panel the owner would really meet.

export interface RepairAnswer {
  ok: false
  repairRequired: true
  repairKind: 'revised' | 'unnamed'
  priorAmount: number
  currentAmount: number
  currentFingerprint: string
  error: string
}

/** The quote was accepted before acceptances were recorded — nothing changed. */
export const UNNAMED_ANSWER: RepairAnswer = {
  ok: false,
  repairRequired: true,
  repairKind: 'unnamed',
  priorAmount: 500,
  currentAmount: 500,
  currentFingerprint: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
  error: 'This quote is marked accepted, but no acceptance naming who agreed is on file — so its online deposit link stays off. '
    + 'Confirm that the customer accepted this $500.00 version and we’ll put that on the record.',
}

/** The document moved under a marked acceptance — the original repair shape. */
export const REVISED_ANSWER: RepairAnswer = {
  ok: false,
  repairRequired: true,
  repairKind: 'revised',
  priorAmount: 1400,
  currentAmount: 500,
  currentFingerprint: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
  error: 'This quote changed after acceptance was marked. We don’t have durable evidence of which version the customer accepted, '
    + 'so we can’t record their acceptance of the current $500.00 document from a prior $1,400.00 figure.',
}
