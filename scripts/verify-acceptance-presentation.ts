// ── Verify: never tell a customer they accepted something we cannot prove ────
//   npm run verify:acceptance-presentation
//
// WHY THIS SCRIPT EXISTS
// An independent S121 red-team found this live:
//
//   EPS-2026-0152 · status = accepted · accepted_price = 1400
//                 · current total = 500 · quote_acceptances = 0
//
// and the customer portal was telling that customer **"This is the price you
// accepted"**, showing $1,400, against a document that now reads $500. Nothing
// in the record supported the sentence. The payment route refused the charge —
// but the CLAIM had already been made, and a false statement about what someone
// agreed to is the failure, not the charge that would have followed it.
//
// ⭐⭐⭐ THE CANONICAL RULE THIS PINS:
//   STATUS is not evidence. accepted_price is not evidence.
//   The only support for "you accepted" is a quote_acceptances row.
//
// Pure: no network, no database, no fixtures. The rules under test are pure
// functions in lib/quoteAcceptance, and the portal model is pinned structurally
// to use them.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  acceptedPresentation, customerFacingQuoteAmount, unevidencedAcceptanceNote,
  isUnevidencedAcceptance, acceptedAmountNote,
} from '../src/lib/quoteAcceptance'
import { requiredDeposit } from '../src/lib/payments/depositGate'
// ⭐ The REAL composition, imported rather than described. §6 runs buildDocItems
// itself, because the defect this guard now covers lived in the ORDER two correct
// functions were called in — which no amount of grepping either one can see.
import { buildDocItems, type PortalQuote, type PortalData } from '../src/app/portal/[token]/model'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, c: boolean, d = '') => (c ? ok(n) : fail(n, d))

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const stripComments = (s: string) => s.replace(/\r\n/g, '\n')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/([^:'"])\/\/[^\n]*/g, '$1')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')

// ── THE LIVE FIXTURE, exactly as the red-team found it ──────────────────────
const LIVE = {
  status: 'accepted',
  accepted_price: 1400,
  total: 500,
  deposit_type: 'percent' as const,
  deposit_value: 50,
  evidence: 0,
}

// Every sentence a customer must never see about an unproven acceptance.
const CONSENT_CLAIMS = [
  /you accepted/i,
  /price you accepted/i,
  /accepted version/i,
  /you agreed to/i,
  /your acceptance of/i,
]

console.log('\n■ 1. The live shape — status says accepted, the record does not')
{
  const p = acceptedPresentation(LIVE.status, LIVE.evidence > 0 ? 'customer' : null)
  check('zero evidence + accepted status → "unevidenced"', p === 'unevidenced', p)
  check('…and S121\'s own primitive agrees it is unevidenced',
    isUnevidencedAcceptance(LIVE.status, null))

  const facing = customerFacingQuoteAmount(p, LIVE.accepted_price, LIVE.total)
  check('the customer-facing amount is the CURRENT $500, not the stale $1,400',
    facing.amount === 500, String(facing.amount))
  check('…and it is NOT labelled an accepted amount', facing.isAcceptedAmount === false)

  const note = unevidencedAcceptanceNote()
  for (const re of CONSENT_CLAIMS) {
    check(`the honest note makes no consent claim — ${re.source}`, !re.test(note), note)
  }
  check('…and it says plainly that no record of acceptance exists',
    /don.t have a record of your acceptance/i.test(note), note)
  check('…and names the figure as the CURRENT price', /current price/i.test(note), note)
}

console.log('\n■ 2. The deposit ask may not be derived from a stale accepted_price')
{
  // 50% of the stale $1,400 is $700. 50% of the live $500 is $250. The customer
  // must never be shown $700 against a $500 document.
  const stale = requiredDeposit({ status: LIVE.status, total: LIVE.total, accepted_price: LIVE.accepted_price,
    deposit_type: LIVE.deposit_type, deposit_value: LIVE.deposit_value })
  check('depositGate WOULD produce $700 from accepted_price (the hazard is real)',
    stale === 700, String(stale))

  // The portal strips accepted_price before asking, exactly as the model does.
  const honest = requiredDeposit({ status: LIVE.status, total: LIVE.total, accepted_price: null,
    deposit_type: LIVE.deposit_type, deposit_value: LIVE.deposit_value })
  check('…and with the unproven snapshot removed it is $250, from the live total',
    honest === 250, String(honest))
  check('⛔ the two differ — so stripping it is load-bearing, not cosmetic', stale !== honest)
}

console.log('\n■ 3. Evidence changes the answer — and only evidence does')
{
  const evidenced = acceptedPresentation('accepted', 'customer')
  check('the CUSTOMER’s own acceptance → evidenced_customer', evidenced === 'evidenced_customer')
  const f = customerFacingQuoteAmount(evidenced, 1400, 500)
  check('…and only THEN may the consent snapshot be shown', f.amount === 1400 && f.isAcceptedAmount)

  // ⭐⭐ THE OWNER'S ATTESTATION IS EVIDENCE, BUT IT IS NOT THE CUSTOMER'S ACT.
  // Found while wiring this: with a bare has-evidence boolean, an owner_on_behalf
  // row would have driven "This is the price YOU accepted" — telling a customer
  // they did something the business wrote down for them. S121 built these kinds
  // to be different facts; a boolean collapsed them at the last surface.
  const onBehalf = acceptedPresentation('accepted', 'owner_on_behalf')
  check('an owner attestation → evidenced_on_behalf', onBehalf === 'evidenced_on_behalf')
  const fb = customerFacingQuoteAmount(onBehalf, 500, 500)
  check('…its agreed figure IS shown (it is real evidence)', fb.amount === 500 && fb.isAcceptedAmount)
  const nb = acceptedAmountNote(onBehalf) ?? ''
  for (const re of CONSENT_CLAIMS) {
    check(`⛔ …but it never borrows the customer's voice — ${re.source}`, !re.test(nb), nb)
  }
  check('…it says the BUSINESS recorded it, on their behalf',
    /recorded at by the business, on your behalf/i.test(nb), nb)
  // ⭐⭐⭐ A LEGACY ROW NAMES NOBODY — IT IS NOT AN OWNER ATTESTATION.
  // It used to land on `evidenced_on_behalf` and therefore said "recorded at by
  // the business, on your behalf" — a specific business act no one can point to.
  // Production holds 75 evidence rows and EVERY ONE is legacy, so the day
  // RUN-S122C projects the kind, 100% of live on-behalf sentences would have been
  // unsupported claims. The migration's own shape CHECK says why: actor_type
  // 'system', actor_id null, no reason, no terms acknowledgement — "a statement
  // that a deal exists and that WHO ACCEPTED IT IS UNKNOWN".
  const legacy = acceptedPresentation('accepted', 'legacy_unrecorded')
  check('a legacy migrated acceptance gets its OWN state', legacy === 'evidenced_legacy', legacy)
  check('⛔ …and is NEVER presented as an owner attestation', legacy !== onBehalf)
  const nl = acceptedAmountNote(legacy) ?? ''
  check('⛔ the two kinds never produce the same sentence', nl !== nb && nl.length > 0)
  for (const re of CONSENT_CLAIMS) {
    check(`⛔ …the legacy sentence makes no consent claim — ${re.source}`, !re.test(nl), nl)
  }
  check('⛔ …and never claims the business recorded it',
    !/on your behalf|by the business/i.test(nl), nl)
  check('…it says the provenance is not on file', /isn.t on file/i.test(nl), nl)
  check('⛔ …and it does NOT claim there is no record at all',
    !/don.t have a record/i.test(nl), nl)
  // ⛔ A backfilled accepted_amount is `coalesce(accepted_price, total)` — the
  // migration COPIED the claim rather than corroborating it, so reading
  // accepted_price back out of a legacy row is circular. A quote in
  // EPS-2026-0152's exact shape that predated the backfill would have been handed
  // a legacy row and shown $1,400 as an agreed figure.
  const fl = customerFacingQuoteAmount(legacy, 1400, 500)
  check('⛔ a legacy row does not license the snapshot — the CURRENT price shows',
    fl.amount === 500 && fl.isAcceptedAmount === false, String(fl.amount))
  check('only the customer branch has no extra note (the existing wording covers it)',
    acceptedAmountNote(evidenced) === null)

  // The three-state input matters: "no evidence" and "could not look" both refuse.
  check('no evidence row refuses the claim', acceptedPresentation('accepted', null) === 'unevidenced')
  check('unknowable evidence ALSO refuses — fails closed',
    acceptedPresentation('accepted', undefined) === 'unevidenced')
  check('an un-accepted quote is simply an offer', acceptedPresentation('sent', undefined) === 'offer')
  check('…and an offer shows its live price, never an accepted one',
    customerFacingQuoteAmount('offer', 1400, 500).amount === 500)

  for (const s of ['accepted', 'scheduled', 'completed', 'paid']) {
    check(`every accepted-or-beyond status is covered — ${s}`,
      acceptedPresentation(s, undefined) === 'unevidenced')
  }
}

console.log('\n■ 4. The portal model is wired to the rules, not to status')
{
  const model = stripComments(read('src/app/portal/[token]/model.ts'))
  check('the model asks acceptedPresentation, never status alone',
    /acceptedPresentation\(qq\.status, qq\.acceptance_kind/.test(model))
  check('the customer-facing figure comes from ONE call that also yields the quote',
    /const facing = customerFacingQuote\(presentation, qq\)/.test(model)
    && /amount: facing\.amount/.test(model))
  check('⛔ accepted_price is no longer read straight into the row',
    !/amount: acceptedFigure \?\? \(Number\(qq\.total\)/.test(model))
  check('⛔ "you accepted" is reachable ONLY from evidenced_customer',
    /priceMovedSinceAccepted && presentation === 'evidenced_customer'/.test(model)
    && /const acceptedFigure = facing\.isAcceptedAmount \? facing\.amount : null/.test(model),
    'an owner attestation must never be worded as the customer\'s own act')
  check('the note is chosen by the presentation, in one place',
    /acceptedAmountNote\(presentation\)/.test(model))
  // ⚠️ This used to name the gate ALONE, and that is precisely why the partial
  // strip survived a review: the check sat two lines from the defect and asserted
  // nothing about it. §6 now proves the property behaviourally for every money
  // reader; this keeps the structural half honest about ALL of them.
  check('⛔ every money reader is fed the sanitized quote — gate, timing AND pdf',
    /const moneyQuote = facing\.moneyQuote/.test(model)
    && /schedulingGate\(moneyQuote,/.test(model)
    && /paymentTiming\(moneyQuote, \{/.test(model)
    && /renderers\.quote\(moneyQuote[,)]/.test(model))
  check('⛔ …and the raw quote reaches none of them',
    !/schedulingGate\(qq[,)]/.test(model)
    && !/paymentTiming\(qq[,)]/.test(model)
    && !/renderers\.quote\(qq\)/.test(model))

  // The payload cannot currently prove evidence, so the flag must be optional —
  // and its absence must mean "unproven", which §3 already pins behaviourally.
  check('the payload carries the KIND, optional (absent = unproven)',
    /acceptance_kind\?: string \| null/.test(model))

  const sql = read('supabase/proposals/RUN-S122C-portal-acceptance-evidence.sql')
  check('the widening that restores S121\'s snapshot is a CANDIDATE, not applied',
    /CANDIDATE — NOT APPLIED/.test(sql))
  check('…and it is an anchor patch that normalises CRLF and demands one match',
    /pg_get_functiondef/.test(sql) && /replace\(v_src, E'\\r\\n', E'\\n'\)/.test(sql)
    && /expected exactly 1 — refusing to patch/.test(sql))
  // ⚠️ Assert the projection IS the kind, not merely that the alias appears.
  // A mutation that swapped the SELECT back to `exists(...)` left the trailing
  // `as acceptance_kind` line untouched, so an alias-only check stayed green
  // while the payload had gone back to a boolean.
  check('…and it projects the KIND only — never actor, amount, time or note',
    /select qa\.kind from public\.quote_acceptances qa/.test(sql)
    && !/exists \(select 1 from public\.quote_acceptances/.test(sql)
    && !/accepted_amount|accepted_at|actor_id|on_behalf_note/.test(sql),
    'a bare boolean would have let an owner attestation speak as the customer')
}

console.log('\n■ 5. The owner path refuses to invent consent for a revised quote')
{
  const route = stripComments(read('src/app/api/quotes/record-acceptance/route.ts'))
  check('the material-revision guard exists and is evidence-aware',
    /quote_acceptances/.test(route) && /count: 'exact', head: true/.test(route))
  // ⚠️ RE-POINTED, not relaxed. `drifted` used to be part of the CONDITION; it is
  // now part of the EXPLANATION only. An accepted quote with no actor-named
  // acceptance needs the same repair whether or not the price moved — and while
  // `drifted` gated it, the un-moved case fell through to an unrelated refusal,
  // which is the dead end the deposit gate now depends on not existing.
  check('…it fires whenever an accepted quote has no ACTOR-NAMED acceptance',
    /isAcceptedOrBeyond\(qq\.status\) && \(count \?\? 0\) === 0\) \{/.test(route)
    && /\.in\('kind', ACTOR_NAMED_ACCEPTANCE_KINDS\)/.test(route),
    'a legacy backfill row must not count as somebody having accepted')
  check('…and `drifted` now only chooses the wording, never the outcome',
    /repairKind: drifted \? 'revised' : 'unnamed'/.test(route))
  check('…and returns a repair-required state naming both figures',
    /repairRequired: true/.test(route)
    && /don.t have durable evidence of which version the customer accepted/.test(route))
  check('⛔ a failed evidence COUNT refuses rather than assuming zero',
    /if \(cErr\) \{[\s\S]{0,200}status: 502/.test(route))
  check('⛔ consent is never reconstructed from accepted_price',
    !/accepted_price[\s\S]{0,80}p_option_id|p_accepted/.test(route))
}

console.log('\n■ 6. THE REAL COMPOSITION BOUNDARY — one quote, one figure, every surface')
{
  // ⭐⭐⭐ WHY THIS SECTION EXISTS, AND WHY THE STRUCTURAL CHECKS ABOVE WERE NOT
  // ENOUGH. §4 asserted that the deposit GATE receives a stripped quote. It did.
  // Twenty lines earlier the very same model handed `paymentTiming` the RAW quote,
  // and an independent red-team found the result on the live shape:
  //
  //     deposit card      $250
  //     timing sentence   "A 50% deposit ($700.00) is required before we
  //                        schedule your visit"
  //
  // Two figures, one screen, one quote, one engine — the exact contradiction class
  // S122 exists to end, produced by stripping in one place and not the other. The
  // check that would have caught it sat two lines from the defect and asserted
  // nothing about it.
  //
  // ⛔ So this runs the REAL buildDocItems — the actual composition, in its actual
  // order, with the actual renderers — rather than re-deriving what it ought to do.
  // A guard that agrees with itself is how the last three defects in this lane
  // survived review.
  const business = { gst_percent: 0 } as unknown as PortalData['business']
  const TODAY = '2026-09-04'
  /** Every quote handed to the PDF renderer, captured as the model passes it. */
  let pdfSaw: PortalQuote[] = []
  const renderers = {
    quote: async (qq: PortalQuote) => { pdfSaw.push(qq); return new Blob() },
    invoice: async () => new Blob(),
  }
  const row = (over: Partial<PortalQuote>) => {
    pdfSaw = []
    const q: PortalQuote = {
      id: 'q1', quote_number: 'EPS-2026-0152', service_type: 'Landscaping', address: '1 Main St',
      property_id: null, total: LIVE.total, initial_price: LIVE.total, subtotal: null,
      weekly_price: null, biweekly_price: null, monthly_price: null,
      notes: null, status: LIVE.status, created_at: TODAY, issued_date: TODAY,
      valid_until: '2026-12-31', crew_size: 1, hours: 2, travel_fee: 0,
      accepted_price: LIVE.accepted_price,
      deposit_type: LIVE.deposit_type, deposit_value: LIVE.deposit_value,
      ...over,
    } as PortalQuote
    const d = buildDocItems({
      quotes: [q], invoices: [], properties: [], business, todayISO: TODAY, renderers,
    })[0]
    void d.getBlob?.()          // the customer's own download, taken as they take it
    return d
  }

  // ── The live shape, exactly as it reaches a customer today ────────────────
  const d = row({})
  check('the headline figure is the CURRENT $500', d.amount === 500, String(d.amount))
  check('the deposit CARD asks $250, from the live total',
    d.schedulingDeposit?.required === 250, JSON.stringify(d.schedulingDeposit))
  check('⛔ the timing SENTENCE names the same $250 — not $700',
    /\$250\.00/.test(d.paymentTimingLine ?? ''), d.paymentTimingLine)
  check('⛔ …and $700 appears in NO customer-facing string on this row',
    !JSON.stringify(d).includes('700'),
    'the card and the sentence disagreeing about the same quote is the whole defect')
  check('⛔ …nor does the unproven $1,400', !JSON.stringify(d).includes('1,400'))
  check('the deposit timing line agrees too',
    !/700/.test(d.depositTimingLine ?? ''), d.depositTimingLine)
  // ⭐ The PDF is a customer-facing surface too — QuotePDF runs the SAME
  // paymentTiming reader off the SAME accepted_price, so a raw quote there prints
  // the $700 sentence onto the document they keep, under the $250 card.
  check('⛔ the PDF renderer is handed the sanitized quote',
    pdfSaw.length === 1 && pdfSaw[0].accepted_price === null,
    JSON.stringify(pdfSaw.map(p => p.accepted_price)))

  // ── The strip is CONDITIONAL, not a blanket null ──────────────────────────
  // Without this control the section would pass just as well if the model always
  // threw accepted_price away, which would silently undo S121's snapshot.
  const ev = row({ acceptance_kind: 'customer' })
  // ⚠️ Captured HERE, not read from `pdfSaw` further down. `row()` resets that
  // recorder on every call, so an assertion several fixtures later was silently
  // describing whichever quote happened to be built last — it began failing the
  // moment two drift fixtures were added below, which is the good version of that
  // mistake: a positional read that breaks loudly rather than drifting quietly.
  const evPdfBasis = pdfSaw[0]?.accepted_price
  check('with the CUSTOMER’s own acceptance, the snapshot is honoured',
    ev.amount === 1400, String(ev.amount))
  check('…the deposit follows it to $700', ev.schedulingDeposit?.required === 700)
  // ⚠️⚠️ THIS CONTROL'S FIXTURE WAS ITSELF THE DRIFTED SHAPE — accepted at $1,400
  // against a $500 document — so it used to assert the very contradiction the
  // drift follow-up exists to remove. Split in two rather than deleted: the
  // "one basis, every surface" claim keeps a fixture where the acceptance still
  // MATCHES its document, and drift gets its own case below.
  // ⚠️ `acceptance_is_current: true` is REQUIRED here, not decoration. This
  // fixture omitted it and passed only while an absent field read as "current" —
  // the very assumption an independent review then showed to be the defect. A
  // fixture that leans on a permissive default is asserting the default.
  const same = row({ acceptance_kind: 'customer', acceptance_is_current: true, total: 1400, initial_price: 1400 })
  check('…the sentence follows it too — one basis, every surface',
    /\$700\.00/.test(same.paymentTimingLine ?? ''), same.paymentTimingLine)
  // ⭐⭐ DRIFT IS DECIDED CANONICALLY — by `quote_acceptance_is_current`, the same
  // function the owner's screens and the charge route ask, carried in the payload
  // by RUN-S122C. It is NOT a total comparison: an edit to address, service_type,
  // notes or the deposit terms moves the material fingerprint and leaves `total`
  // untouched, and a price proxy answered "not superseded" there — so the owner's
  // copy suppressed the stale figure while the customer's copy printed it.
  const drifted = row({ acceptance_kind: 'customer', acceptance_is_current: false })
  check('⭐ …and when the acceptance is no longer CURRENT, the sentence keeps the '
    + 'rule and drops the figure',
    !/\$700\.00/.test(drifted.paymentTimingLine ?? '')
    && /50% deposit is required/.test(drifted.paymentTimingLine ?? '')
    && /revised since you accepted it/.test(drifted.paymentTimingLine ?? ''),
    drifted.paymentTimingLine)
  check('⛔ …and does NOT substitute a figure from the current total instead',
    !/\$250\.00/.test(drifted.paymentTimingLine ?? ''), drifted.paymentTimingLine)
  // ⭐ THE CLASS THE PRICE PROXY MISSED: same total, only the fingerprint moved.
  const sameTotal = row({ acceptance_kind: 'customer', accepted_price: 500, acceptance_is_current: false })
  check('⭐ same-total drift is caught too — the figure is dropped',
    !/\$250\.00/.test(sameTotal.paymentTimingLine ?? '')
    && /revised since you accepted it/.test(sameTotal.paymentTimingLine ?? ''),
    sameTotal.paymentTimingLine)
  {
    // Read locally — §4's `model` is out of scope here, and a guard that reaches
    // for a name it does not own is a guard that stops running at the first edit.
    const src = read('src/app/portal/[token]/model.ts')
    // ⭐ "Is it known CURRENT", not "is it known stale" — the difference is the
    // old-C payload, where the kind is present and currentness is not.
    // ⭐ THREE states, not a boolean: both non-current answers withhold the
    // figure, and only the KNOWN one may say the quote was revised.
    check('⛔ the portal fails closed on a usable snapshot it cannot verify',
      /qq\.acceptance_kind == null \? 'current'/.test(src)
      && /qq\.acceptance_is_current === false \? 'superseded'/.test(src)
      && /: 'unverified'/.test(src)
      && !/const acceptanceSuperseded = priceMovedSinceAccepted/.test(src))
    check('⭐ …so a kind-without-currentness payload drops the figure',
      !/\$700\.00/.test(row({ acceptance_kind: 'customer' }).paymentTimingLine ?? ''),
      row({ acceptance_kind: 'customer' }).paymentTimingLine)
  }
  check('…and the PDF is handed the same basis',
    evPdfBasis === 1400, String(evPdfBasis))
  check('…and only here may the screen say "you accepted"',
    /price you accepted/i.test(ev.amountNote ?? ''), ev.amountNote)

  // ── An owner attestation: real evidence, different voice ──────────────────
  const ob = row({ acceptance_kind: 'owner_on_behalf' })
  check('an owner attestation shows the agreed figure', ob.amount === 1400)
  check('⛔ …but never in the customer’s voice',
    !/you accepted/i.test(ob.amountNote ?? ''), ob.amountNote)
  check('…it says the business recorded it on their behalf',
    /on your behalf/i.test(ob.amountNote ?? ''), ob.amountNote)

  // ── A legacy migrated row: names nobody, so it claims nothing ─────────────
  const lg = row({ acceptance_kind: 'legacy_unrecorded' })
  check('⛔ a legacy row does NOT speak as an owner attestation',
    !/on your behalf|by the business/i.test(lg.amountNote ?? ''), lg.amountNote)
  check('⛔ …and does not borrow the customer’s voice either',
    !/you accepted/i.test(lg.amountNote ?? ''), lg.amountNote)
  check('…it says the provenance is not on file',
    /isn.t on file/i.test(lg.amountNote ?? ''), lg.amountNote)
  check('…it shows the CURRENT price, and the deposit follows it',
    lg.amount === 500 && lg.schedulingDeposit?.required === 250, String(lg.amount))
  check('⛔ …and $700 reaches no surface here either', !JSON.stringify(lg).includes('700'))
  check('⛔ the two on-behalf-ish kinds never produce the same sentence',
    (lg.amountNote ?? '') !== (ob.amountNote ?? ''))

  // ── An un-accepted quote is untouched by all of this ──────────────────────
  const offer = row({ status: 'sent', accepted_price: null })
  check('an offer still shows its live price with no gate',
    offer.amount === 500 && offer.schedulingDeposit === undefined)
  check('…and makes no acceptance claim at all',
    !/accepted/i.test(offer.amountNote ?? ''), offer.amountNote)
}

console.log(failures > 0 ? `\n✗ ${failures} FAILURE(S)` : '\n✓ acceptance-presentation: all checks passed')
process.exit(failures > 0 ? 1 : 0)
