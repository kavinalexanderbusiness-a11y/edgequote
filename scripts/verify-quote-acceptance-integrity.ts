// ── Verify: a quote cannot be accepted without saying who accepted what ──────
//   npm run verify:quote-acceptance-integrity
//
// WHAT THIS GUARDS. Before Session 121 the only record that a quote was accepted
// was the quote row itself — status='accepted' plus accepted_price — and that row
// is fully writable by its owner. There was no acceptance timestamp, no actor, no
// source, and no snapshot of the document the customer read. So:
//
//   • an owner picking "Approved" from the status dropdown produced a row
//     BYTE-IDENTICAL to a customer approving in their own portal, and the
//     notification bell then told the owner that the customer had accepted;
//   • that same dropdown wrote accepted_price from whatever `total` happened to
//     be — a consent figure invented by the person recording it;
//   • it bypassed the rule that an options quote must name the option sold, so a
//     quote could be accepted from the LIST with the choice left null;
//   • editing the price afterwards left the quote quietly 'accepted' at a number
//     nobody had agreed to;
//   • the terms lived in ONE mutable tenant field, so editing Settings rewrote
//     what every past acceptance appeared to have agreed to.
//
// THE MODEL NOW. quote_acceptances is append-only evidence — one row per
// acceptance, with the kind ('customer' vs 'owner_on_behalf'), the door, the
// actor, the authorized amount, an immutable document snapshot with a
// fingerprint, and the exact terms text. Reapproval is DERIVED by comparing the
// live fingerprint to the stored one; it is never a stored flag. See
// src/lib/quoteAcceptance and 20260828140000_quote_acceptance_integrity_v1.sql.
//
// ── THE THREE SECTIONS ───────────────────────────────────────────────────────
//   1. The engine, and mutation tests against it (pure, always runs).
//   2. Source pinning — the removed doors stay removed, the words stay one word.
//   3. Behaviour from ZERO: an empty Postgres built from this repository's own
//      migrations, driven through the real RPCs as owner / customer / service
//      role. Nothing touches production and nothing touches the network.
//      ⛔ NO FIXTURE-TENANT WRITE HALF, DELIBERATELY. The rules under test are
//      schema rules, and this migration is not applied to production yet — a
//      live half would prove the OLD schema passes assertions written for the
//      new one, which is worse than no live half at all.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { splitStatements, loadPGlite, substitutePlatformStatements } from './lib/pg-sql'
import {
  ON_BEHALF_REASONS, MATERIAL_QUOTE_FIELDS, NON_MATERIAL_QUOTE_FIELDS,
  acceptanceStanding, acceptanceSentence, reapprovalSentence, materialChanges,
  isUnevidencedAcceptance, isAcceptedOrBeyond, termsRequired,
  acceptBlockedReason, acceptBlockedLabel, TERMS_ACK_LABEL,
  type AcceptanceState, type AcceptedDocument,
} from '../src/lib/quoteAcceptance'
import { STATUS_LABELS } from '../src/types'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// ⚠️⚠️ THE APPLY PATH, NOT A FILENAME. A migration has two lives: its own file
// while in flight, and the generated BASELINE once production has run it and a
// resync folds it in — at which point the file moves to supabase/archive/ledger/,
// which is never applied. Pinning the name means this guard goes red on the very
// convergence that proves the schema landed. That has now happened FOUR times in
// this repo (verify-comm-prefs, verify-estimate-appointments, verify-custom-fields,
// verify-client-privileges), so read all of supabase/migrations/ and assert the
// STATE it produces. The generator also spells SQL its own way — quoted
// identifiers, `= ANY (ARRAY[…])` for an IN list — so match the shape, never one
// literal spelling.
const APPLY_PATH = (() => {
  const dir = join(process.cwd(), 'supabase', 'migrations')
  return readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
    .map(f => readFileSync(join(dir, f), 'utf8')).join('\n')
})()

// A state row shaped the way quote_acceptance_state returns one.
function state(over: Partial<AcceptanceState> = {}): AcceptanceState {
  return {
    accepted: true, acceptance_id: 'a1', acceptance_seq: 1,
    accepted_at: '2026-08-20T10:00:00Z', kind: 'customer', source: 'portal',
    actor_label: 'Dana Reyes', on_behalf_reason: null, accepted_amount: 5400,
    selected_option_id: null, document: null, terms_acknowledged: false,
    needs_reapproval: false, terms_changed: false, ...over,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · THE ENGINE
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ 1. Five events, and none of them is another one ═══')

check('an acceptance with a live document is STANDING',
  acceptanceStanding(state()) === 'standing')
check('a changed document means REAPPROVAL, not a silent stand',
  acceptanceStanding(state({ needs_reapproval: true })) === 'needs_reapproval')
check('changed TERMS also mean reapproval — the promise moved even if the price did not',
  acceptanceStanding(state({ terms_changed: true })) === 'needs_reapproval')
check('no record at all is NONE, never "probably fine"',
  acceptanceStanding(null) === 'none' && acceptanceStanding(state({ accepted: false })) === 'none')

// ⭐ THE state the whole session exists to make visible: the row SAYS accepted
// and nothing consented to it.
check('status accepted + no record = an UNEVIDENCED acceptance',
  isUnevidencedAcceptance('accepted', null) && isUnevidencedAcceptance('accepted', state({ accepted: false })))
check('…and every status that downstream reads as "a deal was struck" counts',
  ['accepted', 'scheduled', 'completed', 'paid'].every(s => isUnevidencedAcceptance(s, null)))
check('a sent quote with no record is NOT an unevidenced acceptance — it is just unanswered',
  !isUnevidencedAcceptance('sent', null) && !isUnevidencedAcceptance('draft', null))
check('an acceptance that IS on record is never called unevidenced',
  !isUnevidencedAcceptance('accepted', state()))

console.log('\n═══ The sentence never claims more than the record knows ═══')
const customerSaid = acceptanceSentence('accepted', state())
const ownerSaid = acceptanceSentence('accepted', state({
  kind: 'owner_on_behalf', source: 'dashboard', actor_label: 'Fixture Yard',
  on_behalf_reason: 'phone', document: { customer_name: 'Dana Reyes' } as AcceptedDocument,
}))
const nobodySaid = acceptanceSentence('accepted', null)
check('a customer acceptance names the CUSTOMER as the one who acted',
  /Dana Reyes accepted this in their portal/.test(customerSaid), customerSaid)
check('an owner-recorded one says the BUSINESS wrote it down, and where it came from',
  /Fixture Yard recorded/.test(ownerSaid) && /taken by phone/.test(ownerSaid), ownerSaid)
// ⭐⭐ The exact lie this session removes: three different acts must not produce
// one sentence, and the two that are not consent must never contain the word
// "portal" or read as the customer having acted.
check('MUTATION — the owner sentence does NOT say the customer acted in their portal',
  !/portal/.test(ownerSaid) && !/^Dana Reyes accepted/.test(ownerSaid), ownerSaid)
check('with no record the sentence says so, and names nobody',
  /no customer acceptance is on record/i.test(nobodySaid) && !/Dana/.test(nobodySaid), nobodySaid)
check('the three sentences are three different sentences',
  new Set([customerSaid, ownerSaid, nobodySaid]).size === 3)
check('the amount consented to is stated, not the quote total',
  customerSaid.includes('$5,400.00'), customerSaid)

console.log('\n═══ What counts as a commercial change ═══')
// Every material field is named, and every deliberately-excluded one is named
// too — so adding a column later is a DECISION, not an omission that silently
// stops requiring reapproval.
check('the money, the plan prices, the deposit ask, the scope and the choice are all material',
  ['initial_price', 'travel_fee', 'addons_total', 'weekly_price', 'biweekly_price', 'monthly_price',
   'deposit_type', 'deposit_value', 'service_type', 'address', 'notes', 'selected_option_id']
    .every(f => (MATERIAL_QUOTE_FIELDS as readonly string[]).includes(f)))
check('internal_notes is NOT material — it is staff-only and never printed',
  (NON_MATERIAL_QUOTE_FIELDS as readonly string[]).includes('internal_notes')
  && !(MATERIAL_QUOTE_FIELDS as readonly string[]).includes('internal_notes'))
check('customer-facing `notes` IS material — it prints on the PDF and renders in the portal',
  (MATERIAL_QUOTE_FIELDS as readonly string[]).includes('notes'))
check('no field is claimed both ways',
  !MATERIAL_QUOTE_FIELDS.some(f => (NON_MATERIAL_QUOTE_FIELDS as readonly string[]).includes(f)))

const DOC: AcceptedDocument = {
  quote_number: 'Q-1001', customer_name: 'Dana Reyes', address: '12 Elm St',
  service_type: 'Lawn care', notes: 'Front and back',
  initial_price: 5400, travel_fee: 150, total: 5550,
  plan_prices: { weekly: 60, biweekly: 90, monthly: 140 },
  deposit_type: 'percent', deposit_value: 20,
  option: { id: 'o2', name: 'Standard', price: 5400 },
  options_offered: [{ id: 'o1', name: 'Budget', price: 3900 }, { id: 'o2', name: 'Standard', price: 5400 }],
  addons: [{ id: 'x1', name: 'Edging', price: 80 }],
  services: [],
}
const LIVE = {
  initial_price: 5400, travel_fee: 150, total: 5550,
  service_type: 'Lawn care', address: '12 Elm St', notes: 'Front and back',
  weekly_price: 60, biweekly_price: 90, monthly_price: 140,
  deposit_type: 'percent', deposit_value: 20, selected_option_id: 'o2',
  options: [{ id: 'o1', name: 'Budget', price: 3900 }, { id: 'o2', name: 'Standard', price: 5400 }],
  addons: [{ id: 'x1', name: 'Edging', price: 80, is_selected: true }],
  services: [],
}
check('an unchanged quote itemises NOTHING', materialChanges(DOC, LIVE).length === 0,
  JSON.stringify(materialChanges(DOC, LIVE)))
const priceMoved = materialChanges(DOC, { ...LIVE, initial_price: 6075 })
check('a price move is named, with both figures',
  priceMoved.some(c => c.what === 'the price' && c.was === '5400.00' && c.now === '6075.00'),
  JSON.stringify(priceMoved))
check('swapping the accepted option is named by the OPTION’S NAME, not its id',
  materialChanges(DOC, { ...LIVE, selected_option_id: 'o1' })
    .some(c => c.what === 'the chosen option' && c.was === 'Standard' && c.now === 'Budget'))
// ⭐ The quiet one: same id, new price. An id-only comparison sees nothing.
check('re-pricing the SAME option is still a change',
  materialChanges(DOC, { ...LIVE, options: [{ id: 'o2', name: 'Standard', price: 6100 }] })
    .some(c => /Standard price/.test(c.what)))
check('ticking an extra the customer never agreed to is a change',
  materialChanges(DOC, { ...LIVE, addons: [
    { id: 'x1', name: 'Edging', price: 80, is_selected: true },
    { id: 'x2', name: 'Hedge trim', price: 240, is_selected: true }] })
    .some(c => c.what === 'the extras'))
check('…but an UNTICKED suggestion appearing is not — it was never part of the deal',
  materialChanges(DOC, { ...LIVE, addons: [
    { id: 'x1', name: 'Edging', price: 80, is_selected: true },
    { id: 'x2', name: 'Hedge trim', price: 240, is_selected: false }] }).length === 0)
check('moving the deposit ask is a change — it is a payment obligation',
  materialChanges(DOC, { ...LIVE, deposit_value: 50 }).some(c => c.what === 'the deposit'))
check('changing the plan prices is a change — the approve dialog quotes them',
  materialChanges(DOC, { ...LIVE, weekly_price: 75 }).some(c => c.what === 'the weekly price'))

{
  // ── MUTATION TEST ────────────────────────────────────────────────────────
  // A describer that only compared the headline total would call every one of
  // these "no change", because the total is generated and several of them do
  // not move it. Run that broken comparison against the same inputs.
  const brokenSameTotal = (live: typeof LIVE) => Number(DOC.total) === Number(live.total)
  const sneaky = { ...LIVE, deposit_value: 50, weekly_price: 75, notes: 'Front only' }
  check('MUTATION — a total-only comparison would miss the deposit, the plan and the scope',
    brokenSameTotal(sneaky) && materialChanges(DOC, sneaky).length === 3,
    `total-only says "unchanged"; the real engine found ${materialChanges(DOC, sneaky).length}`)
  // …and the second break: comparing the option by id alone.
  const idOnly = (live: typeof LIVE) => DOC.option?.id !== live.selected_option_id
  const repriced = { ...LIVE, options: [{ id: 'o2', name: 'Standard', price: 6100 }] }
  check('MUTATION — an id-only option check would miss a re-priced option',
    !idOnly(repriced) && materialChanges(DOC, repriced).length > 0)
}

console.log('\n═══ The terms tick ═══')
check('terms are required exactly when the business has any',
  termsRequired('Payment due on completion.') && !termsRequired('') && !termsRequired(null) && !termsRequired('   '))
check('an options quote with no choice is blocked before anything is written',
  acceptBlockedReason({ hasOptions: true, chosenOptionId: null, termsText: null, termsAcknowledged: false }) === 'option_not_chosen')
check('terms not ticked blocks acceptance',
  acceptBlockedReason({ hasOptions: false, chosenOptionId: null, termsText: 'T&Cs', termsAcknowledged: false }) === 'terms_not_acknowledged')
check('…and ticking them unblocks it',
  acceptBlockedReason({ hasOptions: false, chosenOptionId: null, termsText: 'T&Cs', termsAcknowledged: true }) === null)
check('a business with no terms blocks nothing',
  acceptBlockedReason({ hasOptions: false, chosenOptionId: null, termsText: null, termsAcknowledged: false }) === null)
check('both refusals say what to DO', acceptBlockedLabel('option_not_chosen').length > 10
  && acceptBlockedLabel('terms_not_acknowledged').length > 10)
check('the tick agrees to the SCOPE and the terms, not just "the terms"',
  /scope/i.test(TERMS_ACK_LABEL) && /terms/i.test(TERMS_ACK_LABEL), TERMS_ACK_LABEL)

console.log('\n═══ The reason has no default ═══')
check('six ways a decision reaches an owner, all named',
  ON_BEHALF_REASONS.length === 6 && ON_BEHALF_REASONS.every(r => r.label.length > 5))
check('no reason is marked as a default or pre-selected anywhere in the engine',
  !/default/i.test(read('src/lib/quoteAcceptance.ts').split('ON_BEHALF_REASONS')[1]?.slice(0, 400) ?? ''))
check('the reapproval sentence names what moved',
  /the price/.test(reapprovalSentence(state({ needs_reapproval: true }), priceMoved)))
check('…and still says something useful when it cannot itemise',
  reapprovalSentence(state({ needs_reapproval: true }), []).length > 20)
check('a terms-only change gets its OWN sentence, about terms',
  /terms/i.test(reapprovalSentence(state({ terms_changed: true }), [])))

// ═══════════════════════════════════════════════════════════════════════════
// 2 · SOURCE PINNING — the removed doors stay removed
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ 2. One word, and one door ═══')

check('the quote status label is ACCEPTED, not "Approved"',
  STATUS_LABELS.accepted === 'Accepted', `got "${STATUS_LABELS.accepted}"`)

const statusControl = read('src/components/quotes/QuoteStatusControl.tsx')
// ⭐ THE regression this pin exists for: the status dropdown used to write the
// acceptance snapshot itself.
check('the status dropdown no longer imports the acceptance patch',
  !/import[^\n]*markWonPatch/.test(statusControl))
check('…and has no accepted branch that writes a patch',
  !/s === 'accepted'\s*\?/.test(statusControl))
check('…and refuses the transition in the handler, not only in the markup',
  /ACCEPTANCE_IS_NOT_A_LABEL/.test(statusControl) && /Record customer acceptance/.test(statusControl))
check('the dead acceptance props are gone rather than accepted-and-ignored',
  !/followUpCount\?: number/.test(statusControl) && !/total\?: number \| null/.test(statusControl))

const quotePage = read('src/app/dashboard/quotes/[id]/page.tsx')
check('the quote page no longer writes an acceptance through a plain update',
  !/markWonPatch/.test(quotePage))
check('it reads the acceptance RECORD rather than asserting from the status',
  /quote_acceptance_state/.test(quotePage) && /acceptanceSentence/.test(quotePage))
// ⚠️ The failure mode that would quietly re-break this: rendering the "nobody
// accepted" banner from a FAILED read. That sentence is an accusation.
check('the banner is gated on the record having actually loaded',
  /acceptanceLoaded && isWon\(quote\.status\)/.test(quotePage))
check('"Changes require reapproval" is stated in those words',
  /Changes require reapproval/.test(quotePage))
check('…and it says the original acceptance is kept',
  /never replaces it|stays on the record/.test(quotePage))

const dialog = read('src/components/quotes/RecordAcceptanceDialog.tsx')
check('the owner door is a named action that says whose act it is',
  /you<\/span> wrote it down for them/.test(dialog) || /wrote it down for them/.test(dialog))
check('…and cannot be submitted without a reason',
  /const canSave = !needsOption && !!reason/.test(dialog))
check('…and treats a null id from the RPC as a REFUSAL, not a quiet success',
  /error \|\| !data/.test(dialog))

const billing = read('src/app/portal/[token]/components/BillingTab.tsx')
check('the portal shows the terms in full above the accept button',
  /whitespace-pre-wrap[^\n]*\{termsText\}/.test(billing))
check('…gates the button on the tick',
  /\(!needsTerms \|\| termsAck\)/.test(billing))
check('…and passes the tick to the RPC rather than assuming it',
  /actions\.accept\(d\.rawId, picked \?\? undefined, termsAck\)/.test(billing))
check('the portal button says Accept, matching the status word',
  /`Accept — \$\{formatCurrency\(d\.amount\)\}`/.test(billing) && !/Approve — \$\{formatCurrency\(d\.amount\)\}/.test(billing))

const home = read('src/app/portal/[token]/components/HomeTab.tsx')
// ⭐ A one-tap shortcut that skips the terms would be ticking a box on the
// customer's behalf — the same impersonation, one screen over.
check('the home one-tap accept stands aside when there are terms to read',
  /oneQuoteId && !hasTerms/.test(home))

const portalClient = read('src/app/portal/[token]/PortalClient.tsx')
check('the portal passes the acknowledgement as given, never coerced to true',
  /p_terms_ack: !!termsAck/.test(portalClient))

// ── ⭐⭐ THE DOWNSTREAM GATES — one seam, asked everywhere that ACTS ─────────
// A stale acceptance must not authorize current work. These pin every acting
// path to the SAME engine: a second fingerprint comparison anywhere is a second
// answer waiting to disagree, which is why the assertions check both that the
// gate is called AND that nobody re-derived it locally.
console.log('\n═══ Stale acceptance cannot authorize current work ═══')

const schedule = read('src/lib/scheduleQuote.ts')
check('SCHEDULING — the quote→job engine asks the acceptance gate',
  /acceptanceBlock\(/.test(schedule) && /loadAcceptanceState\(/.test(schedule))
// ⭐ Inside the engine, not in its callers: this function exists because
// "schedule this quote" was implemented twice and the copies disagreed.
check('SCHEDULING — …inside the engine, so no caller can forget it',
  /export async function scheduleQuoteAsJob[\s\S]{0,2400}?acceptanceBlock\(/.test(schedule))
check('SCHEDULING — …and a FAILED read blocks rather than proceeding',
  /if \(accErr\)[\s\S]{0,200}return \{ jobId: null/.test(schedule))

check('INVOICING — the quote→invoice conversion asks the same gate',
  /handleConvertToInvoice[\s\S]{0,1200}?acceptanceBlock\(/.test(quotePage))
check('INVOICING — …and a failed read blocks there too',
  /if \(accErr\) \{ toast\.error\('Could not check this quote’s acceptance record, so nothing was invoiced/.test(quotePage))

const depositRoute = read('src/app/api/portal/quote-deposit/route.ts')
// The route has no user session (a token proves the customer), so it must use
// the DATABASE half of the seam rather than the tenancy-asserting state RPC.
check('DEPOSIT — the portal charge route asks the database gate',
  /quote_acceptance_is_current/.test(depositRoute))
check('DEPOSIT — …and treats anything but an explicit true as blocking',
  /stillCurrent !== true/.test(depositRoute))
check('DEPOSIT — …refusing the charge rather than quoting a figure off changed terms',
  /paused its deposit/.test(depositRoute))

const portalModel = read('src/app/portal/[token]/model.ts')
// ⭐ The customer-facing half: an accepted quote shows the CONSENTED figure, not
// whatever the owner has since edited the total to.
check('PORTAL — an accepted quote shows the figure the customer accepted',
  /amount: acceptedFigure \?\?/.test(portalModel))
check('PORTAL — …and says so plainly when the document has moved since',
  /priceMovedSinceAccepted/.test(portalModel) && /updated quote to look over/.test(portalModel))

// ⛔ ONE SEAM. If a second file starts comparing fingerprints itself, the answers
// diverge — so the comparison is allowed in exactly two places: the pure engine
// that defines it, and the migration that is its database twin.
{
  const offenders = ['src/lib/scheduleQuote.ts', 'src/app/dashboard/quotes/[id]/page.tsx',
    'src/app/api/portal/quote-deposit/route.ts', 'src/app/portal/[token]/model.ts',
    'src/lib/payments/depositGate.ts', 'src/lib/sales/analytics.ts']
    .filter(f => /document_fingerprint|quote_material_fingerprint/.test(read(f)))
  check('MUTATION — no consumer re-derives the fingerprint for itself',
    offenders.length === 0, `re-derived in: ${offenders.join(', ')}`)
}

// Revenue surfaces report the AUTHORIZED figure, not the drifted total. Both
// already preferred accepted_price; this pins it, because accepted_price is now
// write-once through the acceptance window and is therefore the authorized one.
check('REVENUE — won-value reads the consent snapshot before the live total',
  /isWon\(q\.status\) && q\.accepted_price != null/.test(read('src/lib/sales/analytics.ts')))
check('DEPOSIT BASIS — the ask is taken of the consented figure',
  /const accepted = round2\(Number\(q\.accepted_price\) \|\| 0\)/.test(read('src/lib/payments/depositGate.ts')))

console.log('\n═══ Revising an agreement, and overriding a label ═══')
check('REVISE — an accepted quote offers "Revise quote", not a quiet Edit',
  /hasCurrentValidAcceptance\(acceptance\) \? 'Revise quote' : 'Edit'/.test(quotePage))
check('REVISE — …behind a confirm that says the acceptance is preserved',
  /beginRevision/.test(quotePage) && /stays on the record permanently/.test(quotePage))
check('REVISE — …and that changed terms stop being approved',
  /can’t be scheduled or invoiced until they accept it again/.test(quotePage))
// ⛔ Revising is NOT a change order — that is post-acceptance ADDITIONAL work,
// hangs off a job, and belongs to Session 51's engine.
check('REVISE — …and does not reach for change orders',
  !/changeOrder/i.test(quotePage.slice(quotePage.indexOf('async function beginRevision'), quotePage.indexOf('async function beginRevision') + 1400)))

const override = read('src/components/quotes/OverrideStatusDialog.tsx')
check('OVERRIDE — lives behind Advanced, not in the everyday pill',
  /Advanced/.test(quotePage) && /OverrideStatusDialog/.test(quotePage))
check('OVERRIDE — cannot be submitted without a reason',
  /reason\.trim\(\)\.length > 0/.test(override))
check('OVERRIDE — says explicitly that it is NOT a customer acceptance',
  /This does not record a customer acceptance/.test(override))
check('OVERRIDE — …and points at the door that is',
  /Record customer acceptance/.test(override))
check('OVERRIDE — cannot set draft or sent (those have real doors)',
  /OVERRIDABLE_STATUSES: QuoteStatus\[\] = \['accepted', 'scheduled', 'completed', 'paid', 'declined'\]/.test(override))

const phrase = read('src/lib/audit/phrase.ts')
check('the audit feed has a separate action for an owner-recorded acceptance',
  /quote_acceptance_recorded/.test(phrase))
check('…and a deliberately dull one for a hand-set status',
  /quote_status_overridden/.test(phrase) && /by hand/.test(phrase))

// ═══════════════════════════════════════════════════════════════════════════
// 3 · BEHAVIOUR, FROM ZERO
// ═══════════════════════════════════════════════════════════════════════════
async function behaviour() {
  console.log('\n═══ 3. Behaviour — an empty Postgres built from this repository ═══')

  // The objects must be reachable by the apply path — as their own migration
  // while in flight, or inside the baseline once absorbed. Either is correct.
  if (!/create table if not exists public."?quote_acceptances"?/i.test(APPLY_PATH)) {
    fail('quote_acceptances is defined somewhere in the apply path', 'neither a migration nor the baseline defines it'); return
  }

  const pglite = await loadPGlite()
  if (!pglite) {
    console.log('  ⏭  SKIPPED — PGlite is not installed (this is the behavioural proof).')
    console.log('     npm i -D @electric-sql/pglite && npm run verify:quote-acceptance-integrity')
    return
  }
  const { PGlite, contribs } = pglite
  const db = await PGlite.create({ extensions: contribs })

  const apply = async (label: string, rawSql: string) => {
    const { sql } = substitutePlatformStatements(rawSql)
    const statements = splitStatements(sql)
    let n = 0
    try { for (const s of statements) { await db.exec(s + ';'); n++ }; return true }
    catch (e: any) {
      fail(`applied ${label}`, `statement ${n + 1}/${statements.length}: ${String(e.message).slice(0, 240)}\n      ` +
        (statements[n] ?? '').replace(/\s+/g, ' ').slice(0, 240))
      return false
    }
  }
  if (!await apply('platform prelude', read(join('scripts', 'schema', 'platform-prelude.sql')))) return
  for (const f of readdirSync(join('supabase', 'migrations')).filter(f => f.endsWith('.sql')).sort()) {
    if (!await apply(f, read(join('supabase', 'migrations', f)))) return
  }
  ok('the acceptance schema applies from zero, on top of the baseline')

  // ── ⚠️⚠️ A PG18 FINDING, ACCOMMODATED HERE AND REPORTED, NOT HIDDEN ────────
  // PGlite ships PostgreSQL 18; production is 17. On 18, a table that is
  // REPLICA IDENTITY FULL *and* published *and* carries a generated column
  // refuses EVERY update with 42P10 ("Replica identity must not contain
  // unpublished generated columns"). Exactly two tables in this schema match:
  // `quotes` (3 generated columns) and `customers` (1). It is PRE-EXISTING on
  // main — measured by applying the baseline ALONE and updating a quote, which
  // fails identically with no Session 121 migration present — and it is invisible
  // to verify:rebuild, which only applies DDL and diffs the catalogue.
  //
  // ⛔ It is NOT a defect in anything below, and it is NOT fixed here: whether to
  // drop REPLICA IDENTITY FULL (and lose the old-row UPDATE payload realtime
  // depends on) or to publish the generated columns is a platform decision that
  // belongs with the realtime contract, not with an acceptance guard. It becomes
  // a live outage on the day Supabase moves to 18, on the two most central tables
  // in the product.
  //
  // Relaxed for the FIXTURE ONLY, on the two tables, so this guard can exercise
  // the acceptance path at all. Nothing asserted below concerns replication.
  const blocked = (await db.query(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relreplident = 'f'
       and exists (select 1 from pg_publication_tables pt
                    where pt.schemaname = 'public' and pt.tablename = c.relname)
       and exists (select 1 from pg_attribute a
                    where a.attrelid = c.oid and a.attgenerated <> '' and not a.attisdropped)`)).rows as any[]
  for (const t of blocked) await db.exec(`alter table public."${t.relname}" replica identity default`)
  console.log(`  ⚠️  PG18 note: relaxed REPLICA IDENTITY on ${blocked.length} published table(s) with generated columns `
    + `(${blocked.map((t: any) => t.relname).join(', ')}) so this fixture can UPDATE them. `
    + `Pre-existing on main; production is PG17. See the comment above.`)

  const rows = async (sql: string, params: any[] = []) => (await db.query(sql, params)).rows as any[]
  const one = async (sql: string, params: any[] = []) => (await rows(sql, params))[0]
  /** Runs a statement expecting a REFUSAL. Returns the message, or null if it went through. */
  const refused = async (sql: string, params: any[] = []): Promise<string | null> => {
    try { await db.query(sql, params); return null } catch (e: any) { return String(e.message) }
  }

  const OWNER = '00000000-0000-0000-0000-0000000000c1'
  const OTHER = '00000000-0000-0000-0000-0000000000c2'

  /**
   * Run something AS a PostgREST role, in a transaction that is always rolled back.
   *
   * ⚠️⚠️ THE TRANSACTION IS NOT TIDINESS — it is what makes SET LOCAL ROLE work.
   * `SET LOCAL` outside a transaction block is a documented NO-OP. The first
   * version of the tenancy section below set only the JWT claims and ran as the
   * SUPERUSER, so every grant and every RLS policy was bypassed: it reported
   * "6 rows leaked" and "the table was readable" as failures of the schema when
   * they were failures of the harness. A privilege test that never changes
   * privilege is worse than no test — it accuses the code. Same trap
   * verify:audit-trail documents; same fix.
   */
  const asRole = async <T>(role: string, uid: string | null, fn: () => Promise<T>): Promise<T> => {
    await db.exec('begin')
    try {
      await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? ''])
      await db.query(`select set_config('request.jwt.claims', $1, true)`,
        [uid ? `{"role":"${role}","sub":"${uid}"}` : `{"role":"${role}"}`])
      await db.exec(`set local role ${role}`)
      return await fn()
    } finally { await db.exec('rollback').catch(() => {}) }
  }
  /** True when the statement was REFUSED for that role. */
  const refusedFor = async (role: string, sql: string, params: any[] = [], uid: string | null = OWNER) => {
    try { await asRole(role, uid, () => db.query(sql, params)); return false } catch { return true }
  }
  const asOwner = async () => {
    await db.exec(`set request.jwt.claim.sub = '${OWNER}'`)
    await db.exec(`set request.jwt.claims = '{"role":"authenticated","sub":"${OWNER}"}'`)
  }
  const asOther = async () => {
    await db.exec(`set request.jwt.claim.sub = '${OTHER}'`)
    await db.exec(`set request.jwt.claims = '{"role":"authenticated","sub":"${OTHER}"}'`)
  }
  const asCustomer = async () => {
    await db.exec(`set request.jwt.claim.sub = ''`)
    await db.exec(`set request.jwt.claims = '{"role":"anon"}'`)
  }
  const asService = async () => {
    await db.exec(`set request.jwt.claim.sub = ''`)
    await db.exec(`set request.jwt.claims = '{"role":"service_role"}'`)
  }

  await asService()
  await db.exec(`insert into auth.users (id, email) values
    ('${OWNER}', 'owner@example.test'), ('${OTHER}', 'other@example.test')`)
  await db.exec(`insert into public.business_settings (user_id, company_name, owner_name, terms_text)
    values ('${OWNER}', 'Fixture Yard', 'Sam Owner', 'Payment due on completion. Cancellations need 24 hours notice.')`)
  const cust = await one(`insert into public.customers (user_id, name) values ('${OWNER}', 'Dana Reyes') returning id`)
  await db.exec(`insert into public.customer_portal_tokens (token, customer_id, user_id)
    values ('tok-dana', '${cust.id}', '${OWNER}')`)

  let qn = 0
  /** A fresh 'sent' quote owned by OWNER and belonging to Dana. */
  const makeQuote = async (over: Record<string, any> = {}) => {
    qn++
    const cols = {
      user_id: `'${OWNER}'`, customer_id: `'${cust.id}'`, quote_number: `'Q-${1000 + qn}'`,
      customer_name: `'Dana Reyes'`, address: `'12 Elm St'`, service_type: `'Lawn care'`,
      initial_price: '5400', travel_fee: '150', status: `'sent'`, ...over,
    }
    return one(`insert into public.quotes (${Object.keys(cols).join(',')})
      values (${Object.values(cols).join(',')}) returning *`)
  }
  const acceptanceOf = (qid: string) =>
    rows(`select * from public.quote_acceptances where quote_id = $1 order by seq`, [qid])
  const quoteRow = (qid: string) => one(`select * from public.quotes where id = $1`, [qid])

  // ── 3a · The customer's door writes evidence ──────────────────────────────
  console.log('\n─── The customer accepts ───')
  const q1 = await makeQuote()
  await asCustomer()
  const acc1 = await one(`select public.portal_accept_quote('tok-dana', $1, null, null, true) as ok`, [q1.id])
  check('a customer can accept through their own token', acc1.ok === true)
  await asService()
  const ev1 = await acceptanceOf(q1.id)
  check('…and exactly one acceptance row exists', ev1.length === 1)
  check('…recorded as the CUSTOMER, through the PORTAL',
    ev1[0]?.kind === 'customer' && ev1[0]?.source === 'portal' && ev1[0]?.actor_type === 'customer',
    JSON.stringify({ kind: ev1[0]?.kind, source: ev1[0]?.source, actor: ev1[0]?.actor_type }))
  check('…naming the customer as the actor', ev1[0]?.actor_id === cust.id && ev1[0]?.actor_label === 'Dana Reyes')
  check('…with the authorized amount = price + travel', Number(ev1[0]?.accepted_amount) === 5550,
    `got ${ev1[0]?.accepted_amount}`)
  check('…with an accepted_at stamp', !!ev1[0]?.accepted_at)
  check('…with a document snapshot carrying the quote number and the scope',
    ev1[0]?.document?.quote_number === 'Q-1001' && ev1[0]?.document?.service_type === 'Lawn care')
  check('…with a fingerprint of the material facts', !!ev1[0]?.document_fingerprint)
  check('…with the EXACT terms text stored, not a reference to it',
    /Cancellations need 24 hours notice/.test(ev1[0]?.terms_text ?? '') && ev1[0]?.terms_acknowledged === true)
  check('the quote row moved to accepted with the same figure',
    (await quoteRow(q1.id)).status === 'accepted' && Number((await quoteRow(q1.id)).accepted_price) === 5550)

  // ⛔ MUTATION — the terms tick is real
  const q1b = await makeQuote()
  await asCustomer()
  const noAck = await refused(`select public.portal_accept_quote('tok-dana', $1, null, null, false)`, [q1b.id])
  check('MUTATION — accepting WITHOUT the terms tick is refused',
    noAck !== null && /scope and terms/.test(noAck), noAck ?? 'it went through')
  await asService()
  check('…and no acceptance row was left behind by the refusal', (await acceptanceOf(q1b.id)).length === 0)
  check('…and the quote is still awaiting an answer', (await quoteRow(q1b.id)).status === 'sent')

  // ── 3b · Owner override cannot impersonate the customer ───────────────────
  console.log('\n─── Owner override vs. owner-on-behalf vs. the customer ───')
  const q2 = await makeQuote()
  await asOwner()
  await db.exec(`update public.quotes set status = 'accepted' where id = '${q2.id}'`)
  const ev2 = await acceptanceOf(q2.id)
  // ⭐⭐ THE headline mutation: a hand-set status must not manufacture consent.
  check('MUTATION — setting status=accepted by hand creates NO acceptance record',
    ev2.length === 0, `${ev2.length} row(s) appeared`)
  check('…so the engine calls it an unevidenced acceptance',
    isUnevidencedAcceptance('accepted', null))
  const auditOverride = await one(
    `select * from public.audit_events where entity_id = $1 and action like 'quote_%' order by seq desc limit 1`, [q2.id])
  check('…and the audit trail names it an OVERRIDE, not an acceptance',
    auditOverride?.action === 'quote_status_overridden',
    `got "${auditOverride?.action}"`)
  const noteOverride = await one(
    `select * from public.notifications where entity_id = $1 order by created_at desc limit 1`, [q2.id])
  check('…and the notification does NOT say the customer accepted anything',
    !/Dana Reyes accepted/.test(noteOverride?.title ?? '') && /no customer acceptance on record/i.test(noteOverride?.title ?? ''),
    noteOverride?.title)
  // The override may still not invent a consent figure.
  const inventPrice = await refused(
    `update public.quotes set accepted_price = 9999 where id = '${q2.id}'`)
  check('MUTATION — an override cannot invent an accepted_price to go with the label',
    inventPrice !== null && /what the customer agreed to/.test(inventPrice), inventPrice ?? 'it went through')

  const q3 = await makeQuote()
  await asOwner()
  const onBehalf = await one(
    `select public.owner_record_customer_acceptance($1, 'phone', null, null, 'Called at 2pm') as id`, [q3.id])
  check('an owner CAN record an acceptance that reached them by phone', !!onBehalf.id)
  await asService()
  const ev3 = (await acceptanceOf(q3.id))[0]
  check('…recorded as owner_on_behalf, from the dashboard, with an OWNER actor',
    ev3?.kind === 'owner_on_behalf' && ev3?.source === 'dashboard' && ev3?.actor_type === 'owner')
  check('…carrying the reason and the note', ev3?.on_behalf_reason === 'phone' && ev3?.on_behalf_note === 'Called at 2pm')
  check('…and naming the OWNER, never the customer, as who acted',
    ev3?.actor_id === OWNER && ev3?.actor_label === 'Sam Owner')
  const auditOnBehalf = await one(
    `select * from public.audit_events where entity_id = $1 and action like 'quote_%' order by seq desc limit 1`, [q3.id])
  check('…and the audit action is its own action, distinct from a customer acceptance',
    auditOnBehalf?.action === 'quote_acceptance_recorded', `got "${auditOnBehalf?.action}"`)
  const noteOnBehalf = await one(
    `select * from public.notifications where entity_id = $1 order by created_at desc limit 1`, [q3.id])
  check('…and the bell says YOU recorded it, not that the customer accepted',
    /You recorded/.test(noteOnBehalf?.title ?? '') && !/^Dana Reyes accepted/.test(noteOnBehalf?.title ?? ''),
    noteOnBehalf?.title)

  // ⛔ MUTATION — the reason cannot be omitted, and the shape cannot be faked.
  const q4 = await makeQuote()
  await asOwner()
  const noReason = await one(`select public.owner_record_customer_acceptance($1, null) as id`, [q4.id])
  check('MUTATION — an owner acceptance with NO reason is refused', noReason.id === null)
  const blankReason = await one(`select public.owner_record_customer_acceptance($1, '   ') as id`, [q4.id])
  check('MUTATION — …and a blank one is refused too, not trimmed into "other"', blankReason.id === null)
  await asService()
  check('…leaving no row and no status change',
    (await acceptanceOf(q4.id)).length === 0 && (await quoteRow(q4.id)).status === 'sent')
  // ── The strict door refuses a reasonless call ─────────────────────────────
  // Explicit casts because BOTH arities now exist (the 3-arg is a deploy-window
  // shim), and an under-specified call is ambiguous — which is itself the proof
  // that the shim is really there.
  const strictNoReason = await one(
    `select public.owner_select_quote_option($1::uuid, null::uuid, null::uuid[], null::text, null::text) as ok`, [q4.id])
  check('MUTATION — the strict owner door refuses a reasonless call', strictNoReason.ok === false)

  // ⛔ MUTATION — the impersonating row is not constructible at all, even by the
  // service role writing straight to the table.
  await asService()
  const fake = await refused(
    `insert into public.quote_acceptances
       (user_id, quote_id, customer_id, kind, source, actor_type, actor_id, accepted_amount, document, document_fingerprint)
     values ('${OWNER}', $1, $2, 'owner_on_behalf', 'portal', 'customer', $2, 100, '{}'::jsonb, 'x')`,
    [q4.id, cust.id])
  check('MUTATION — an owner-recorded row claiming a customer actor via the portal is unrepresentable',
    fake !== null && /on_behalf_shape/.test(fake), fake ?? 'it was accepted')
  const fakeNoReason = await refused(
    `insert into public.quote_acceptances
       (user_id, quote_id, customer_id, kind, source, actor_type, actor_id, accepted_amount, document, document_fingerprint)
     values ('${OWNER}', $1, $2, 'owner_on_behalf', 'dashboard', 'owner', '${OWNER}', 100, '{}'::jsonb, 'x')`,
    [q4.id, cust.id])
  check('MUTATION — …and one with no reason is refused by the constraint, not by a caller',
    fakeNoReason !== null && /on_behalf_shape/.test(fakeNoReason), fakeNoReason ?? 'it was accepted')

  // ── 3c · An accepted quote's consent snapshot cannot be rewritten ─────────
  console.log('\n─── The consent snapshot has one writer ───')
  await asOwner()
  const overwritePrice = await refused(`update public.quotes set accepted_price = 1 where id = '${q1.id}'`)
  check('MUTATION — a customer acceptance’s figure cannot be overwritten by its owner',
    overwritePrice !== null, overwritePrice ?? 'it went through')
  await asService()
  const overwriteAsService = await refused(`update public.quotes set accepted_price = 1 where id = '${q1.id}'`)
  check('MUTATION — …nor by the service role', overwriteAsService !== null, overwriteAsService ?? 'it went through')
  check('…and the agreed figure is untouched', Number((await quoteRow(q1.id)).accepted_price) === 5550)

  // ── 3d · Options ──────────────────────────────────────────────────────────
  console.log('\n─── An options quote must name what was sold ───')
  const q5 = await makeQuote()
  await asService()
  const oBudget = await one(`insert into public.quote_options (quote_id, user_id, name, price, sort_order)
    values ($1, '${OWNER}', 'Budget', 3900, 0) returning *`, [q5.id])
  const oStd = await one(`insert into public.quote_options (quote_id, user_id, name, price, sort_order)
    values ($1, '${OWNER}', 'Standard', 5400, 1) returning *`, [q5.id])
  await asCustomer()
  const noChoice = await one(`select public.portal_accept_quote('tok-dana', $1, null, null, true) as ok`, [q5.id])
  check('MUTATION — an options quote cannot be accepted without naming one', noChoice.ok === false)
  await asService()
  check('…and nothing was recorded', (await acceptanceOf(q5.id)).length === 0)
  const q5other = await makeQuote()
  await asCustomer()
  const foreignOpt = await one(`select public.portal_accept_quote('tok-dana', $1, $2, null, true) as ok`, [q5other.id, oStd.id])
  check('MUTATION — an option from ANOTHER quote cannot be accepted', foreignOpt.ok === false)
  const picked = await one(`select public.portal_accept_quote('tok-dana', $1, $2, null, true) as ok`, [q5.id, oStd.id])
  check('naming the option accepts it', picked.ok === true)
  await asService()
  const ev5 = (await acceptanceOf(q5.id))[0]
  check('…the record names the option and prices it AS the quote',
    ev5?.selected_option_id === oStd.id && Number(ev5?.accepted_amount) === 5550,
    `option=${ev5?.selected_option_id} amount=${ev5?.accepted_amount}`)
  check('…and the snapshot keeps the option’s own NAME and PRICE, not just its id',
    ev5?.document?.option?.name === 'Standard' && Number(ev5?.document?.option?.price) === 5400)
  check('…and keeps what ELSE was offered, so "they were shown three" survives',
    (ev5?.document?.options_offered ?? []).length === 2)
  // ⭐ Deleting the losing option must not erase the record of the choice.
  await asOwner()
  await db.exec(`delete from public.quote_options where id = '${oBudget.id}'`)
  await asService()
  const ev5after = (await acceptanceOf(q5.id))[0]
  check('MUTATION — deleting a losing option does not rewrite what was offered',
    (ev5after?.document?.options_offered ?? []).length === 2)
  // ⭐ The accepted option itself cannot be swapped.
  await asOwner()
  const swap = await refused(`update public.quotes set selected_option_id = null where id = '${q5.id}'`)
  check('MUTATION — the accepted option cannot be swapped or cleared on the quote',
    swap !== null, swap ?? 'it went through')

  // ── 3e · Reapproval is derived, and history is kept ──────────────────────
  console.log('\n─── A commercial edit does not stay accepted ───')
  const st = async (qid: string) => {
    await asOwner()
    return one(`select * from public.quote_acceptance_state($1)`, [qid])
  }
  let s1 = await st(q1.id)
  check('an untouched acceptance does not need reapproval', s1.needs_reapproval === false && s1.accepted === true)
  check('…and the state names the kind and the amount',
    s1.kind === 'customer' && Number(s1.accepted_amount) === 5550)

  await asOwner()
  await db.exec(`update public.quotes set initial_price = 6075 where id = '${q1.id}'`)
  s1 = await st(q1.id)
  check('MUTATION — raising the price after acceptance flags REAPPROVAL', s1.needs_reapproval === true)
  check('…and the quote is still labelled accepted (nothing is un-done behind the owner)',
    (await quoteRow(q1.id)).status === 'accepted')
  check('…and the ORIGINAL agreed figure is still the one on record',
    Number(s1.accepted_amount) === 5550 && Number(s1.document.total) === 5550)

  // Every material fact, one at a time, against the DATABASE's own fingerprint.
  const q6 = await makeQuote({ weekly_price: '60', deposit_type: `'percent'`, deposit_value: '20', notes: `'Front and back'` })
  await asCustomer()
  await one(`select public.portal_accept_quote('tok-dana', $1, null, null, true)`, [q6.id])
  await asService()
  const base6 = (await acceptanceOf(q6.id))[0].document_fingerprint
  const fp = async (qid: string) => (await one(`select public.quote_material_fingerprint($1) as f`, [qid])).f
  const MATERIAL_MOVES: [string, string][] = [
    ['the price', `initial_price = 6075`],
    ['the travel fee', `travel_fee = 200`],
    ['the service', `service_type = 'Snow clearing'`],
    ['the address', `address = '99 Oak Ave'`],
    ['the customer-facing notes', `notes = 'Front only'`],
    ['the weekly plan price', `weekly_price = 75`],
    ['the deposit ask', `deposit_value = 50`],
  ]
  for (const [what, set] of MATERIAL_MOVES) {
    await db.exec(`update public.quotes set ${set} where id = '${q6.id}'`)
    const moved = await fp(q6.id)
    check(`MUTATION — changing ${what} changes the fingerprint`, moved !== base6, `fingerprint unchanged after: ${set}`)
    // Put it back so each fact is tested alone.
    await db.exec(`update public.quotes set initial_price=5400, travel_fee=150, service_type='Lawn care',
      address='12 Elm St', notes='Front and back', weekly_price=60, deposit_value=20 where id = '${q6.id}'`)
  }
  check('…and restoring every fact restores the fingerprint exactly', (await fp(q6.id)) === base6)

  const NON_MATERIAL_MOVES: [string, string][] = [
    ['internal notes', `internal_notes = 'Watch the dog'`],
    ['the measurement', `measured_sqft = 4200`],
    ['the expiry date', `valid_until = '2027-01-01'`],
    ['the follow-up counter', `follow_up_count = 3`],
    ['the customer’s preferred date', `preferred_date = '2026-09-10'`],
    ['the pricing confidence', `pricing_confidence = 'high'`],
  ]
  for (const [what, set] of NON_MATERIAL_MOVES) {
    await db.exec(`update public.quotes set ${set} where id = '${q6.id}'`)
    check(`correcting ${what} does NOT demand reapproval`, (await fp(q6.id)) === base6, `after: ${set}`)
  }

  // ── Add-ons: two protections, and neither is the other ────────────────────
  // ⭐ THE FREEZE ALREADY EXISTED and this guard found it by trying to break it:
  // quote_addons_write_guard() refuses EVERY add-on write once a quote leaves
  // draft/sent, because the approved set of extras IS the record and later scope
  // is a change order. So "silently tick an extra on an accepted quote" is not a
  // live hole — it is already impossible one layer down.
  //
  // The fingerprint still carries is_selected, and that is not redundant: it
  // covers the window BEFORE acceptance (an extra ticked between sending and
  // accepting), it covers a quote returned to 'sent' for reapproval — where the
  // freeze lifts by design — and it is what would keep the rule true if the
  // freeze were ever relaxed. Both are asserted, separately, so a change to
  // either is visible.
  const q8 = await makeQuote()
  const addon = await one(`insert into public.quote_addons (quote_id, user_id, name, price, sort_order)
    values ($1, '${OWNER}', 'Hedge trim', 240, 0) returning *`, [q8.id])
  const base8 = await fp(q8.id)
  check('offering an extra nobody has ticked is not yet a change', typeof base8 === 'string')
  await db.exec(`update public.quote_addons set is_selected = true where id = '${addon.id}'`)
  check('MUTATION — ticking an extra while the quote is still open IS a change',
    (await fp(q8.id)) !== base8)
  await db.exec(`update public.quote_addons set is_selected = false where id = '${addon.id}'`)
  check('…and unticking it restores the fingerprint', (await fp(q8.id)) === base8)

  await asCustomer()
  await one(`select public.portal_accept_quote('tok-dana', $1, $2, null, true)`, [q8.id, null])
  await asService()
  const ev8 = (await acceptanceOf(q8.id))[0]
  check('an unticked extra is NOT in the accepted amount', Number(ev8.accepted_amount) === 5550)
  check('…and the snapshot records no extras', (ev8.document?.addons ?? []).length === 0)
  const tickAfter = await refused(
    `update public.quote_addons set is_selected = true where id = '${addon.id}'`)
  check('MUTATION — ticking an extra AFTER acceptance is refused outright (the pre-existing freeze)',
    tickAfter !== null && /change order/.test(tickAfter), tickAfter ?? 'it went through')
  const addAfter = await refused(
    `insert into public.quote_addons (quote_id, user_id, name, price, sort_order)
     values ($1, '${OWNER}', 'Snuck in', 900, 1)`, [q8.id])
  check('MUTATION — …and adding a NEW extra after acceptance is refused too',
    addAfter !== null, addAfter ?? 'it went through')

  // ── 3f · Terms ────────────────────────────────────────────────────────────
  console.log('\n─── Editing the terms does not rewrite what was agreed ───')
  let s6 = await st(q6.id)
  check('the acceptance stands while the terms are unchanged', s6.terms_changed === false)
  await asOwner()
  await db.exec(`update public.business_settings set terms_text = 'Payment due in 7 days. No cancellations.'
    where user_id = '${OWNER}'`)
  s6 = await st(q6.id)
  check('MUTATION — editing the tenant terms flags the acceptance as needing reapproval',
    s6.terms_changed === true)
  await asService()
  const ev6 = (await acceptanceOf(q6.id))[0]
  check('…and the ORIGINAL terms text is untouched on the record',
    /Cancellations need 24 hours notice/.test(ev6.terms_text) && !/No cancellations/.test(ev6.terms_text))

  // ── 3g · History never disappears ─────────────────────────────────────────
  console.log('\n─── History is appended to, never rewritten ───')
  await asOwner()
  const upd = await refused(`update public.quote_acceptances set accepted_amount = 1 where quote_id = '${q1.id}'`)
  check('MUTATION — an acceptance cannot be updated by its owner', upd !== null && /append-only/.test(upd),
    upd ?? 'it went through')
  const del = await refused(`delete from public.quote_acceptances where quote_id = '${q1.id}'`)
  check('MUTATION — …nor deleted while its quote exists', del !== null && /append-only/.test(del),
    del ?? 'it went through')
  await asService()
  const updSvc = await refused(`update public.quote_acceptances set kind = 'customer' where quote_id = '${q3.id}'`)
  const delSvc = await refused(`delete from public.quote_acceptances where quote_id = '${q3.id}'`)
  check('MUTATION — …and the service role is refused both, exactly the same way',
    updSvc !== null && delSvc !== null)
  check('…and every row is still there',
    (await acceptanceOf(q1.id)).length === 1 && (await acceptanceOf(q3.id)).length === 1)

  // The owner may not hand-write evidence either — there is no INSERT policy and
  // no INSERT grant. Run AS the authenticated role, on a quote that has NO
  // acceptance yet, so the refusal cannot be the seq trigger answering for the
  // wrong reason.
  const FORGE = `insert into public.quote_acceptances
       (user_id, quote_id, customer_id, kind, source, actor_type, actor_id, accepted_amount, document, document_fingerprint)
     values ('${OWNER}', $1, $2, 'customer', 'portal', 'customer', $2, 99999, '{}'::jsonb, 'forged')`
  check('MUTATION — an owner cannot hand-write an acceptance into their own book',
    await refusedFor('authenticated', FORGE, [q2.id, cust.id]))
  check('MUTATION — …and cannot update or delete one either, as their real role',
    await refusedFor('authenticated', `update public.quote_acceptances set accepted_amount = 1 where quote_id = $1`, [q1.id])
    && await refusedFor('authenticated', `delete from public.quote_acceptances where quote_id = $1`, [q1.id]))

  // A reapproval APPENDS. It never replaces.
  await asOwner()
  await db.exec(`update public.quotes set status = 'sent' where id = '${q3.id}'`)
  const re = await one(`select public.owner_record_customer_acceptance($1, 'email') as id`, [q3.id])
  check('a re-sent quote can be accepted again', !!re.id)
  await asService()
  const hist = await acceptanceOf(q3.id)
  check('…and BOTH acceptances are on the record', hist.length === 2, `${hist.length} row(s)`)
  check('…in order, with the second superseding the first',
    hist[0].seq === 1 && hist[1].seq === 2 && hist[1].supersedes_id === hist[0].id)
  check('…and the first one still says exactly what it always said',
    hist[0].on_behalf_reason === 'phone' && hist[0].on_behalf_note === 'Called at 2pm')
  check('…while the second says how the SECOND yes arrived', hist[1].on_behalf_reason === 'email')
  const forked = await refused(
    `insert into public.quote_acceptances
       (user_id, quote_id, customer_id, kind, source, actor_type, actor_id, accepted_amount, document, document_fingerprint)
     values ('${OWNER}', $1, $2, 'customer', 'portal', 'customer', $2, 1, '{}'::jsonb, 'x')`,
    [q3.id, cust.id])
  check('MUTATION — history cannot be FORKED: a second acceptance must say what it replaces',
    forked !== null, forked ?? 'it went through')

  // Deleting the QUOTE is a different, deliberate, audited act — and it takes
  // its evidence with it rather than leaving an orphan.
  const q7 = await makeQuote()
  await asCustomer()
  await one(`select public.portal_accept_quote('tok-dana', $1, null, null, true)`, [q7.id])
  await asOwner()
  const delQuote = await refused(`delete from public.quotes where id = '${q7.id}'`)
  check('deleting the QUOTE is still allowed — the bulk delete must not break',
    delQuote === null, delQuote ?? '')
  await asService()
  check('…and it cascades, leaving no orphaned evidence', (await acceptanceOf(q7.id)).length === 0)
  const delAudit = await one(
    `select * from public.audit_events where entity_id = $1 and action = 'quote_deleted' limit 1`, [q7.id])
  check('…while the audit trail keeps the record that it happened', !!delAudit)

  // ── 3h · Tenancy ──────────────────────────────────────────────────────────
  console.log('\n─── Another tenant sees none of it ───')
  // Prove the harness can actually change role FIRST — otherwise every result
  // below could be a superuser silently succeeding at something no client can do.
  const whoami = await asRole('authenticated', OWNER, async () =>
    (await db.query(`select current_user as u`)).rows[0] as any)
  check('the harness really switches role (otherwise every check below is vacuous)',
    whoami.u === 'authenticated', `current_user = ${whoami.u}`)

  const ownerSees = await asRole('authenticated', OWNER, async () =>
    (await db.query(`select id from public.quote_acceptances`)).rows.length)
  check('the owner CAN read their own acceptance evidence', ownerSees > 0, `${ownerSees} rows`)
  const otherSees = await asRole('authenticated', OTHER, async () =>
    (await db.query(`select id from public.quote_acceptances`)).rows.length)
  check('MUTATION — a different signed-in tenant reads ZERO acceptance rows', otherSees === 0,
    `${otherSees} row(s) leaked`)

  await asOther()
  const foreignState = await rows(`select * from public.quote_acceptance_state($1)`, [q1.id])
  check('MUTATION — …and the state RPC refuses to answer for someone else’s quote',
    foreignState.length === 0, JSON.stringify(foreignState[0] ?? {}))
  const foreignRecord = await one(`select public.owner_record_customer_acceptance($1, 'phone') as id`, [q5other.id])
  check('MUTATION — …and cannot record an acceptance on it', foreignRecord.id === null)

  check('MUTATION — an anonymous caller has no grant on the table at all',
    await refusedFor('anon', `select * from public.quote_acceptances`, [], null))
  check('MUTATION — …and cannot call the state RPC either',
    await refusedFor('anon', `select * from public.quote_acceptance_state($1)`, [q1.id], null))
  // ⭐ The portal door STAYS open to anon — that is the customer's own door, and
  // breaking it would be the loudest possible regression from this change.
  check('…while the customer’s own portal door is still reachable anonymously',
    !(await refusedFor('anon', `select public.portal_accept_quote('nope', $1, null, null, true)`, [q1.id], null)))

  // ── 3j · THE DEPLOY WINDOW — an OLD client against the NEW schema ─────────
  //
  // ⭐⭐ THE COMPATIBILITY SEAM IS THE DEFAULT VALUE, NOT A SECOND FUNCTION.
  // An earlier cut kept the old arities as shims; Postgres refused to call
  // either, because `(text,uuid,uuid,uuid[])` matches the 4-arg exactly AND the
  // 5-arg with p_terms_ack defaulted, with nothing to break the tie
  // (42725 "function is not unique"). PostgREST resolves by parameter NAME and
  // lands in the same ambiguity. The shim would not have softened the deploy
  // window — it would have broken every call in it.
  //
  // So the old arities are dropped, and these checks simulate exactly what a
  // pre-deploy client does: OMIT the new argument. First: the two arities really
  // are gone, so nothing ambiguous survives to be resolved at random.
  console.log('\n─── A client deployed before the app ships ───')
  const arities = await rows(
    `select p.proname, pg_get_function_identity_arguments(p.oid) as args
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('portal_accept_quote','owner_select_quote_option')
      order by p.proname`)
  check('exactly ONE signature survives per acceptance door — no ambiguous overload',
    arities.length === 2, arities.map(a => `${a.proname}(${a.args})`).join(' | '))
  const sig = (n: string) => arities.find(a => a.proname === n)?.args ?? '<missing>'
  // (pg_get_function_identity_arguments includes the parameter NAMES, so these
  // assert the named argument a pre-deploy client omits — which is the thing
  // that actually decides the deploy window's behaviour.)
  check('…the portal door is the one that takes the terms acknowledgement',
    /p_terms_ack\s+boolean/.test(sig('portal_accept_quote')), sig('portal_accept_quote'))
  check('…and the owner door is the one that takes a reason',
    /p_reason\s+text/.test(sig('owner_select_quote_option')), sig('owner_select_quote_option'))

  const shimQ = await makeQuote()
  await asCustomer()
  // An old client omits p_terms_ack entirely. The tenant HAS terms, so the
  // default (false) must make this refuse rather than record a fiction.
  const shimTerms = await refused(
    `select public.portal_accept_quote(p_token => 'tok-dana', p_quote_id => $1::uuid)`, [shimQ.id])
  check('MUTATION — an old client omitting p_terms_ack cannot bypass the tick: it FAILS CLOSED',
    shimTerms !== null && /scope and terms/.test(shimTerms), shimTerms ?? 'it went through')
  await asService()
  check('…leaving no evidence and no status change',
    (await acceptanceOf(shimQ.id)).length === 0 && (await quoteRow(shimQ.id)).status === 'sent')

  // …and where the tenant has NO terms, the very same old call still works —
  // which is what makes this a compatibility seam rather than an outage.
  await asService()
  await db.exec(`update public.business_settings set terms_text = null where user_id = '${OWNER}'`)
  await asCustomer()
  const shimOk = await one(
    `select public.portal_accept_quote(p_token => 'tok-dana', p_quote_id => $1::uuid) as ok`, [shimQ.id])
  check('a pre-deploy client still works where there is nothing to acknowledge', shimOk.ok === true)
  await asService()
  const shimEv = (await acceptanceOf(shimQ.id))[0]
  check('…and it still writes full evidence, not a lesser row',
    shimEv?.kind === 'customer' && shimEv?.source === 'portal' && Number(shimEv?.accepted_amount) === 5550)
  check('…recording honestly that nothing was required to be acknowledged',
    shimEv?.terms_required === false && shimEv?.terms_acknowledged === false)

  // The owner's old call omits p_reason → null → refused. Owner-side, visible,
  // and it lasts exactly as long as the app rollout. It must NOT be softened by
  // defaulting the reason: a default reason is a fabricated reason.
  const shimQ2 = await makeQuote()
  await asOwner()
  const shimOwner = await one(
    `select public.owner_select_quote_option(p_quote_id => $1::uuid) as ok`, [shimQ2.id])
  check('MUTATION — an old owner client omitting p_reason is REFUSED, not defaulted',
    shimOwner.ok === false)
  await asService()
  check('…and records nothing at all', (await acceptanceOf(shimQ2.id)).length === 0)
  // Restore the tenant's terms for the sections below.
  await db.exec(`update public.business_settings set terms_text = 'Payment due in 7 days. No cancellations.' where user_id = '${OWNER}'`)

  // ── 3k · THE LEGACY BACKFILL ──────────────────────────────────────────────
  // ⭐⭐ Without this the gate answers "not authorized" for the whole existing
  // book on the first deploy. Proved by building a quote in the OLD shape — an
  // accepted row with no evidence, exactly what production is full of — and
  // re-running the migration's backfill statement over it.
  console.log('\n─── The book that was accepted before evidence existed ───')
  await asService()
  const legacyQ = await makeQuote({ status: `'accepted'`, accepted_price: '5550' })
  check('a pre-existing accepted quote starts with NO evidence', (await acceptanceOf(legacyQ.id)).length === 0)
  const gateBefore = await one(`select public.quote_acceptance_is_current($1) as ok`, [legacyQ.id])
  check('…and would therefore be refused scheduling and invoicing', gateBefore.ok === false)

  // Re-run just the backfill from the migration file — the same statement, not a
  // paraphrase of it, so the guard cannot pass against a backfill that differs.
  // ⚠️ A BACKFILL IS THE ONE THING THE BASELINE NEVER CARRIES. The generated
  // baseline describes SCHEMA; a one-time DML that gives existing accepted quotes
  // their legacy_unrecorded evidence is history, and once production has run it
  // the statement lives only in supabase/archive/ledger/. So look in the apply
  // path first (while the migration is still in flight) and fall back to the
  // archive (after it is absorbed).
  // ⭐ This does NOT breach "archive is never applied": nothing here applies it to
  // production. The guard REPLAYS it into a throwaway PGlite to prove what it
  // does — which is the whole reason it extracts the real statement instead of
  // paraphrasing one.
  const ledgerDir = join(process.cwd(), 'supabase', 'archive', 'ledger')
  const archived = existsSync(ledgerDir)
    ? readdirSync(ledgerDir).filter(f => f.endsWith('.sql')).sort()
        .map(f => readFileSync(join(ledgerDir, f), 'utf8')).join('\n')
    : ''
  // ⚠️ Do NOT pick a source by "does it contain the opening line" — the BASELINE
  // contains that line too, inside quote_record_acceptance()'s body, so the
  // fallback never fires and the search runs over a file with no backfill in it.
  // Search both and let the marker below decide, which is the only thing that
  // actually distinguishes the backfill from the function that resembles it.
  const migSql = APPLY_PATH + '\n' + archived
  // ⚠️ lastIndexOf, not indexOf: quote_record_acceptance() contains the SAME
  // opening line, and grabbing that one lifts a fragment of a plpgsql body
  // instead of the backfill ("syntax error at or near into" — which is how this
  // was caught).
  // ⚠️ SELECT BY MARKER, NOT BY POSITION. `lastIndexOf` worked while this read one
  // file in a known order; reading the archive concatenates several, and
  // quote_record_acceptance()'s body contains the SAME opening line, so position
  // picks up `) returning id into v_id;` — a fragment of plpgsql, not a statement.
  // The backfill is the only one of these that names legacy_unrecorded, and it is
  // the only one that is not inside a function body, so say that instead.
  const candidates: string[] = []
  for (let i = migSql.indexOf('insert into public.quote_acceptances ('); i !== -1;
       i = migSql.indexOf('insert into public.quote_acceptances (', i + 1)) {
    const rest = migSql.slice(i)
    candidates.push(rest.slice(0, rest.indexOf(';') + 1))
  }
  const backfillStmt = candidates.find(s => /legacy_unrecorded/.test(s) && !/into\s+v_id/i.test(s)) ?? ''
  check('the backfill statement was located in the migration', /legacy_unrecorded/.test(backfillStmt))
  await db.exec(backfillStmt)
  const legacyEv = (await acceptanceOf(legacyQ.id))[0]
  check('the backfill gives it evidence', !!legacyEv)
  check('…named honestly: legacy_unrecorded, by the system, from the migration',
    legacyEv?.kind === 'legacy_unrecorded' && legacyEv?.actor_type === 'system' && legacyEv?.source === 'migration')
  check('…claiming NO actor and NO reason, because none was ever recorded',
    legacyEv?.actor_id === null && legacyEv?.on_behalf_reason === null)
  // ⭐ It must never claim the customer agreed to terms they may never have seen.
  check('MUTATION — …and asserting NO terms acknowledgement',
    legacyEv?.terms_required === false && legacyEv?.terms_acknowledged === false && legacyEv?.terms_text === null)
  check('…carrying the amount the old row already claimed', Number(legacyEv?.accepted_amount) === 5550)
  const gateAfter = await one(`select public.quote_acceptance_is_current($1) as ok`, [legacyQ.id])
  check('…so the existing book keeps working', gateAfter.ok === true)
  // …but only for the terms as they stood. It is not a blank cheque.
  await asOwner()
  await db.exec(`update public.quotes set initial_price = 9000 where id = '${legacyQ.id}'`)
  const gateAfterEdit = await one(`select public.quote_acceptance_is_current($1) as ok`, [legacyQ.id])
  check('MUTATION — a legacy acceptance still goes stale when the deal changes', gateAfterEdit.ok === false)
  await asService()
  const rerun = await db.query(backfillStmt)
  check('the backfill is idempotent — re-running adds nothing', (await acceptanceOf(legacyQ.id)).length === 1,
    `${(await acceptanceOf(legacyQ.id)).length} rows after re-run (${(rerun as any).affectedRows ?? '?'} inserted)`)

  // ── 3l · THE GATE, which is the whole point of the fingerprint ────────────
  console.log('\n─── Stale acceptance does not authorize current work ───')
  const gateQ = await makeQuote()
  await asCustomer()
  await one(`select public.portal_accept_quote('tok-dana', $1, null, null, true)`, [gateQ.id])
  await asService()
  check('a fresh acceptance authorizes the current terms',
    (await one(`select public.quote_acceptance_is_current($1) as ok`, [gateQ.id])).ok === true)
  await asOwner()
  await db.exec(`update public.quotes set initial_price = 7000 where id = '${gateQ.id}'`)
  check('MUTATION — a price rise revokes the authorization immediately',
    (await one(`select public.quote_acceptance_is_current($1) as ok`, [gateQ.id])).ok === false)
  check('…while the quote still READS accepted (nothing is un-done silently)',
    (await quoteRow(gateQ.id)).status === 'accepted')
  check('…and the evidence still says what was actually agreed',
    Number((await acceptanceOf(gateQ.id))[0].accepted_amount) === 5550)
  await db.exec(`update public.quotes set initial_price = 5400 where id = '${gateQ.id}'`)
  check('…and putting the deal back restores the authorization',
    (await one(`select public.quote_acceptance_is_current($1) as ok`, [gateQ.id])).ok === true)

  // ⭐ TERMS ARE CONSULTED BY THE GATE, not merely stored beside it.
  await asOwner()
  await db.exec(`update public.business_settings set terms_text = 'Brand new terms, never shown to anyone.' where user_id = '${OWNER}'`)
  check('MUTATION — moving the TERMS revokes the authorization too',
    (await one(`select public.quote_acceptance_is_current($1) as ok`, [gateQ.id])).ok === false)
  await asService()
  check('…and the exact agreed terms are still on the record, unchanged',
    /Payment due in 7 days/.test((await acceptanceOf(gateQ.id))[0].terms_text ?? ''))
  await db.exec(`update public.business_settings set terms_text = 'Payment due in 7 days. No cancellations.' where user_id = '${OWNER}'`)
  check('…restoring the terms restores it',
    (await one(`select public.quote_acceptance_is_current($1) as ok`, [gateQ.id])).ok === true)

  // A quote nobody ever accepted is not authorized by its status alone.
  const bareQ = await makeQuote({ status: `'accepted'` })
  check('MUTATION — status alone never authorizes anything',
    (await one(`select public.quote_acceptance_is_current($1) as ok`, [bareQ.id])).ok === false)

  // ⛔ The gate is SECURITY DEFINER and resolves a quote by id, so a signed-in
  // caller must not be able to probe another tenant's quotes with it. `false` is
  // indistinguishable from "not current", so nothing leaks either way.
  await asOther()
  check('MUTATION — another tenant cannot probe acceptance currency by quote id',
    (await one(`select public.quote_acceptance_is_current($1) as ok`, [gateQ.id])).ok === false)
  await asOwner()
  check('…while the real owner still gets the true answer',
    (await one(`select public.quote_acceptance_is_current($1) as ok`, [gateQ.id])).ok === true)

  // ── 3m · THE ADMINISTRATIVE OVERRIDE DOOR ─────────────────────────────────
  console.log('\n─── Overriding a status is not accepting a quote ───')
  const ovQ = await makeQuote()
  await asOwner()
  check('MUTATION — an override with no reason is refused',
    (await one(`select public.owner_override_quote_status($1, 'accepted', null) as ok`, [ovQ.id])).ok === false)
  check('MUTATION — …and a blank reason is refused, not trimmed into silence',
    (await one(`select public.owner_override_quote_status($1, 'accepted', '   ') as ok`, [ovQ.id])).ok === false)
  check('MUTATION — …and it cannot be used to send a quote (that has its own door)',
    (await one(`select public.owner_override_quote_status($1, 'sent', 'because') as ok`, [ovQ.id])).ok === false)
  const ovOk = await one(
    `select public.owner_override_quote_status($1, 'accepted', 'Signed paperwork in the office, pre-dates EdgeHQ') as ok`, [ovQ.id])
  check('an override with a stated reason is allowed', ovOk.ok === true)
  await asService()
  check('…it moved the label', (await quoteRow(ovQ.id)).status === 'accepted')
  // ⭐⭐ THE LINE. A label moved; no authority was created.
  check('MUTATION — …and created NO acceptance evidence', (await acceptanceOf(ovQ.id)).length === 0)
  check('MUTATION — …so it still does not authorize scheduling or invoicing',
    (await one(`select public.quote_acceptance_is_current($1) as ok`, [ovQ.id])).ok === false)
  const ovAudit = await one(
    `select * from public.audit_events where entity_id = $1 order by seq desc limit 1`, [ovQ.id])
  check('…the audit row names it an override', ovAudit?.action === 'quote_status_overridden', ovAudit?.action)
  check('…and carries the owner’s own words for why',
    /pre-dates EdgeHQ/.test(JSON.stringify(ovAudit?.after ?? {})), JSON.stringify(ovAudit?.after))
  // The reason must not leak onto the NEXT status change in the same session.
  await asOwner()
  await db.exec(`update public.quotes set status = 'declined' where id = '${ovQ.id}'`)
  await asService()
  const nextAudit = await one(
    `select * from public.audit_events where entity_id = $1 order by seq desc limit 1`, [ovQ.id])
  check('MUTATION — the override reason does not leak onto a later, unrelated change',
    !/override_reason/.test(JSON.stringify(nextAudit?.after ?? {})), JSON.stringify(nextAudit?.after))

  // ── 3i · The migration says what it is ────────────────────────────────────
  // These assert what the migration SAYS — its recorded intent, in comments the
  // generated baseline necessarily strips. That prose is history, so read the
  // apply path AND the archive: whichever life the migration is in, the sentence
  // it committed to is still findable.
  const ledgerDir2 = join(process.cwd(), 'supabase', 'archive', 'ledger')
  const mig = APPLY_PATH + '\n' + (existsSync(ledgerDir2)
    ? readdirSync(ledgerDir2).filter(f => f.endsWith('.sql')).sort()
        .map(f => readFileSync(join(ledgerDir2, f), 'utf8')).join('\n')
    : '')
  check('the migration states that signatures are NOT its job',
    /S74|documents\/signatures/.test(mig) && /NOT THIS TABLE|Not a signature store/.test(mig))
  check('…and that an administrative override produces no acceptance row',
    /ADMINISTRATIVE STATUS OVERRIDE/.test(mig))
}

behaviour().then(() => {
  console.log(failures === 0
    ? '\n✅ quote acceptance integrity: every check passed\n'
    : `\n❌ quote acceptance integrity: ${failures} check(s) failed\n`)
  process.exit(failures === 0 ? 0 : 1)
})
