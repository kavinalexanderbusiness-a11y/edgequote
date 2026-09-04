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
  check('a legacy migrated acceptance is also on-behalf, never "you accepted"',
    acceptedPresentation('accepted', 'legacy_unrecorded') === 'evidenced_on_behalf')
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
  check('the customer-facing figure comes from customerFacingQuoteAmount',
    /customerFacingQuoteAmount\(presentation, qq\.accepted_price/.test(model)
    && /amount: facing\.amount/.test(model))
  check('⛔ accepted_price is no longer read straight into the row',
    !/amount: acceptedFigure \?\? \(Number\(qq\.total\)/.test(model))
  check('⛔ "you accepted" is reachable ONLY from evidenced_customer',
    /priceMovedSinceAccepted && presentation === 'evidenced_customer'/.test(model)
    && /const acceptedFigure = facing\.isAcceptedAmount \? facing\.amount : null/.test(model),
    'an owner attestation must never be worded as the customer\'s own act')
  check('the note is chosen by the presentation, in one place',
    /acceptedAmountNote\(presentation\)/.test(model))
  check('⛔ the deposit gate is fed a quote with no unproven snapshot',
    /const gateQuote = facing\.isAcceptedAmount \? qq : \{ \.\.\.qq, accepted_price: null \}/.test(model)
    && /schedulingGate\(gateQuote,/.test(model))

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
  check('…it fires only when status says accepted, evidence is 0, AND the amount drifted',
    /isAcceptedOrBeyond\(qq\.status\) && \(count \?\? 0\) === 0 && drifted/.test(route))
  check('…and returns a repair-required state naming both figures',
    /repairRequired: true/.test(route)
    && /don.t have durable evidence of which version the customer accepted/.test(route))
  check('⛔ a failed evidence COUNT refuses rather than assuming zero',
    /if \(cErr\) \{[\s\S]{0,200}status: 502/.test(route))
  check('⛔ consent is never reconstructed from accepted_price',
    !/accepted_price[\s\S]{0,80}p_option_id|p_accepted/.test(route))
}

console.log(failures > 0 ? `\n✗ ${failures} FAILURE(S)` : '\n✓ acceptance-presentation: all checks passed')
process.exit(failures > 0 ? 1 : 0)
