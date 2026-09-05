// ── Verify: the owner may attest to the CURRENT version, and only that ───────
//   npm run verify:current-version-acceptance
//
// S122b made the ordinary owner path refuse a quote flagged accepted with zero
// evidence and a moved price. Correct as a default — but an owner who genuinely
// knows the customer accepted must be able to say so about a NAMED version.
//
// This guard proves the repair path is bounded, atomic and honest, against a
// real Postgres running the real RPC. The fixture mirrors the live shape:
//   current $500 · stale accepted_price $1,400 · status accepted · evidence 0
//   50% deposit · no job · no invoice
//
// ⛔ Nothing here touches production.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { splitStatements, loadPGlite, substitutePlatformStatements } from './lib/pg-sql'
import { termsClaimRefresh } from '../src/lib/payments/termsClaimRefresh'
import { requiredDeposit, depositBasis, schedulingGate } from '../src/lib/payments/depositGate'
import { acceptedPresentation, customerFacingQuoteAmount, acceptedAmountNote } from '../src/lib/quoteAcceptance'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, d?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; console.error(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
}

const ROOT = process.cwd()
const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER = '99999999-9999-4999-8999-999999999999'
const CUSTOMER = '22222222-2222-4222-8222-222222222222'
const TOKEN = 'zz-s122d-token'
const GENERAL = 'We accept cash, cheque and e-transfer. Please give 24 hours notice to cancel.'
const CONTRADICTS = 'Payment due upon completion unless otherwise agreed.'
const AMBIGUOUS = 'A 50% deposit is required before we book. No deposit is required for any job.'

async function main() {
  const pg = await loadPGlite()
  if (!pg) { console.log('\n⏭  verify:current-version-acceptance SKIPPED — PGlite not installed.\n'); process.exit(0) }
  const db = await pg.PGlite.create({ extensions: Object.fromEntries(Object.entries(pg.contribs).filter(([, v]) => v)) })
  const q = (sql: string, p: unknown[] = []) => db.query(sql, p)
  const apply = async (label: string, raw: string) => {
    const { sql } = substitutePlatformStatements(raw)
    for (const st of splitStatements(sql)) {
      try { await db.exec(st) } catch (e) { throw new Error(`${label}: ${(e as Error).message}`) }
    }
  }

  console.log('\n══ owner confirms the CURRENT version ══════════════════════════════\n')
  await apply('prelude', readFileSync(join(ROOT, 'scripts/schema/platform-prelude.sql'), 'utf8'))
  const baseline = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('_baseline.sql')).sort().pop()!
  await apply('baseline', readFileSync(join(ROOT, 'supabase/migrations', baseline), 'utf8'))
  await apply('S122D', readFileSync(join(ROOT, 'supabase/proposals/RUN-S122D-owner-confirm-current-acceptance.sql'), 'utf8'))
  // ⭐ S122E is part of THIS RPC's contract, not a separate feature: without it
  // the fingerprint S122D checks is not the fingerprint that gets stored. Applying
  // it here also proves its anchor resolves exactly once against the real writer.
  await apply('S122E', readFileSync(join(ROOT, 'supabase/proposals/RUN-S122E-recorded-version-must-match.sql'), 'utf8'))
  // Applying twice must be a no-op — S106 re-runs proposals against a live ledger.
  await apply('S122E (replay)', readFileSync(join(ROOT, 'supabase/proposals/RUN-S122E-recorded-version-must-match.sql'), 'utf8'))
  console.log(`  applied ${baseline} + RUN-S122D + RUN-S122E\n`)

  // PG18 refuses UPDATE on a published table whose replica identity holds a
  // generated column (quotes.total). Property of the test target, not production.
  try { await q(`drop publication if exists supabase_realtime`) } catch { /* absent */ }

  await q(`insert into auth.users (id, email) values ($1,'zz-s122d@example.invalid'),($2,'zz-other@example.invalid')`, [TENANT, OTHER])
  await q(`insert into public.business_settings (user_id, company_name, owner_name, terms_text) values ($1,'ZZ-S122D Co','ZZ Owner',$2)`, [TENANT, GENERAL])
  await q(`insert into public.customers (id, user_id, name) values ($1,$2,'ZZ-S122D Customer')`, [CUSTOMER, TENANT])
  await q(`insert into public.customer_portal_tokens (user_id, customer_id, token) values ($1,$2,$3)`, [TENANT, CUSTOMER, TOKEN])

  const asOwner = (u = TENANT) => q(`select set_config('request.jwt.claim.sub', $1, false)`, [u])
  const asAnon = () => q(`select set_config('request.jwt.claim.sub', '', false)`)
  const setTerms = async (t: string) => {
    const { patch } = termsClaimRefresh({ terms_text: t, terms_payment_claim: null, terms_payment_claim_fingerprint: null, terms_payment_claim_version: null })
    await q(`update public.business_settings set terms_text=$2, terms_payment_claim=$3,
               terms_payment_claim_fingerprint=$4, terms_payment_claim_version=$5 where user_id=$1`,
      [TENANT, t, patch.terms_payment_claim, patch.terms_payment_claim_fingerprint, patch.terms_payment_claim_version])
  }

  let seq = 0
  /** The live shape: accepted, stale accepted_price, zero evidence. */
  const junShaped = async (opts: { price?: number; stale?: number | null; status?: string; deposit?: boolean } = {}) => {
    seq++
    const id = `33333333-3333-4333-8333-${String(seq).padStart(12, '0')}`
    const price = opts.price ?? 500
    await q(`insert into public.quotes (id, user_id, customer_id, customer_name, quote_number, service_type,
               address, status, initial_price, travel_fee, deposit_type, deposit_value)
             values ($1,$2,$3,'ZZ-S122D Customer',$4,'ZZ-S122D Service','1 Test St',$5,$6,0,$7,$8)`,
      [id, TENANT, CUSTOMER, `ZZ-S122D-${seq}`, opts.status ?? 'accepted', price,
        opts.deposit === false ? null : 'percent', opts.deposit === false ? null : 50])
    if (opts.stale !== null) {
      // Write the stale snapshot the way an administrative flip left it.
      await q(`select set_config('app.quote_consent_writer', $1, false)`, [id])
      await q(`update public.quotes set accepted_price=$2 where id=$1`, [id, opts.stale ?? 1400])
      await q(`select set_config('app.quote_consent_writer', '', false)`)
    }
    return id
  }
  const fpOf = async (id: string) => String((await q(`select public.quote_material_fingerprint($1) as f`, [id])).rows[0].f)
  const confirm = async (id: string, o: { fp?: string; amount?: number; reason?: string; note?: string; who?: string } = {}) => {
    await asOwner(o.who ?? TENANT)
    const fp = o.fp ?? await fpOf(id)
    try {
      const r = await q(`select public.owner_confirm_current_acceptance($1,$2,$3,$4,$5) as out`,
        [id, o.reason ?? 'text_message', o.note ?? 'Customer texted yes to the revised price.', fp, o.amount ?? 500])
      return (r.rows[0] as { out: Record<string, unknown> }).out
    } catch (e) { return { ok: false, raised: (e as Error).message } as Record<string, unknown> }
  }
  const evidence = async (id: string) =>
    Number((await q(`select count(*)::int n from public.quote_acceptances where quote_id=$1`, [id])).rows[0].n)

  await setTerms(GENERAL)

  console.log('■ A/B. The live shape → refused by default, allowed on explicit confirmation')
  {
    const id = await junShaped()
    // A — the ORDINARY path cannot reach it (quote_apply_choice refuses non-sent).
    await asOwner()
    const ord = await q(`select public.owner_record_customer_acceptance($1,'text_message',null,null,null) as id`, [id])
    check('A · the ordinary record action cannot repair this shape',
      (ord.rows[0] as { id: string | null }).id === null)
    check('A · …and leaves no evidence', (await evidence(id)) === 0)

    // B — the explicit attestation succeeds.
    const out = await confirm(id)
    check('B · explicit confirmation of the CURRENT $500 succeeds', out.ok === true, JSON.stringify(out))
    const firstId = out.acceptance_id
    check('B · exactly ONE evidence row', (await evidence(id)) === 1)

    const row = (await q(`select kind, source, actor_type, actor_id, on_behalf_reason, on_behalf_note,
                                 accepted_amount, document_fingerprint, terms_acknowledged
                            from public.quote_acceptances where quote_id=$1`, [id])).rows[0] as Record<string, unknown>
    check('B · it is owner_on_behalf, never customer portal acceptance',
      row.kind === 'owner_on_behalf' && row.actor_type === 'owner' && row.source === 'dashboard')
    check('B · the accepted snapshot is $500', Number(row.accepted_amount) === 500, String(row.accepted_amount))
    check('B · the method the owner chose is recorded', row.on_behalf_reason === 'text_message')
    check('B · the owner is named', row.actor_id === TENANT)
    check('B · the note is kept', String(row.on_behalf_note ?? '').length > 0)
    check('B · it is stamped with the CURRENT material fingerprint',
      row.document_fingerprint === await fpOf(id))

    const qq = (await q(`select status, accepted_price from public.quotes where id=$1`, [id])).rows[0] as Record<string, unknown>
    check('B · accepted_price is re-stamped to the current $500', Number(qq.accepted_price) === 500, String(qq.accepted_price))
    check('B · status stays accepted', qq.status === 'accepted')

    // K — the deposit follows the repaired basis.
    const dep = requiredDeposit({ status: 'accepted', total: 500, accepted_price: Number(qq.accepted_price),
      deposit_type: 'percent', deposit_value: 50 })
    check('K · deposit ask is $250 from the repaired $500 basis', dep === 250, String(dep))
    check('L · and never the $700 the stale $1,400 would have produced', dep !== 700)

    // J — replay is idempotent, not a second row.
    const again = await confirm(id)
    check('J · a replay returns the SAME acceptance idempotently',
      again.ok === true && again.idempotent === true && again.acceptance_id === firstId,
      `first=${String(firstId)} again=${String(again.acceptance_id)}`)
    check('J · …and there is still exactly ONE evidence row', (await evidence(id)) === 1)
  }

  console.log('\n■ C. A quote that changed after the modal opened')
  {
    const id = await junShaped()
    const staleFp = await fpOf(id)
    // The owner edits the price in another tab.
    await q(`update public.quotes set initial_price = 650 where id=$1`, [id])
    const out = await confirm(id, { fp: staleFp, amount: 500 })
    check('C · a stale fingerprint is refused', out.ok === false && out.reason === 'fingerprint_mismatch', JSON.stringify(out))
    check('C · …and no evidence is written', (await evidence(id)) === 0)
    // Even with a fresh fingerprint, the AMOUNT the owner ticked is now wrong.
    const out2 = await confirm(id, { amount: 500 })
    check('C · a stale AMOUNT is refused even with a fresh fingerprint',
      out2.ok === false && out2.reason === 'amount_mismatch', JSON.stringify(out2))
    check('C · …still no evidence', (await evidence(id)) === 0)
  }

  console.log('\n■ D/E. Terms that contradict, and terms nobody can read')
  {
    await setTerms(CONTRADICTS)
    const id = await junShaped()
    const out = await confirm(id)
    check('D · contradictory terms refuse even WITH owner confirmation',
      out.ok !== true && /no money is due until the work is done/.test(String(out.raised ?? '')), JSON.stringify(out))
    check('D · …and nothing is written — the stamp rolls back with the raise',
      (await evidence(id)) === 0
      && Number((await q(`select accepted_price from public.quotes where id=$1`, [id])).rows[0].accepted_price) === 1400)

    await setTerms(AMBIGUOUS)
    const id2 = await junShaped()
    const out2 = await confirm(id2)
    check('E · ambiguous terms refuse', out2.ok !== true, JSON.stringify(out2))
    check('E · …and write nothing', (await evidence(id2)) === 0)
    await setTerms(GENERAL)
  }

  console.log('\n■ F/G/H. The bounds')
  {
    const unpriced = await junShaped({ price: 0, stale: 1400 })
    check('F · an unpriced quote is refused',
      (await confirm(unpriced, { amount: 0 })).reason === 'unpriced')

    const withEvidence = await junShaped()
    await confirm(withEvidence)                       // one legitimate repair
    const second = await confirm(withEvidence, { note: 'a different story' })
    check('G · a competing repair row cannot be added beside existing evidence',
      second.ok === true && second.idempotent === true, JSON.stringify(second))
    check('G · …and the count stays at one', (await evidence(withEvidence)) === 1)

    for (const st of ['scheduled', 'completed', 'paid']) {
      const id = await junShaped({ status: st })
      const out = await confirm(id)
      check(`H · ${st} is refused — that is a reconciliation, not a hotfix`,
        out.ok === false && out.reason === 'status_not_repairable', JSON.stringify(out))
      check(`H · …and writes nothing`, (await evidence(id)) === 0)
    }
    const scheduled = await junShaped()
    await q(`insert into public.jobs (id, user_id, customer_id, quote_id, title, service_type, scheduled_date, status)
             values (gen_random_uuid(), $1, $2, $3, 'ZZ-S122D Job', 'ZZ-S122D Service', current_date, 'scheduled')`,
      [TENANT, CUSTOMER, scheduled])
    check('H · a quote with work already booked is refused',
      (await confirm(scheduled)).reason === 'work_scheduled')

    const invoiced = await junShaped()
    await q(`insert into public.invoices (id, user_id, customer_id, quote_id, customer_name, invoice_number, amount, status)
             values (gen_random_uuid(), $1, $2, $3, 'ZZ-S122D Customer', 'ZZ-INV-1', 1400, 'sent')`, [TENANT, CUSTOMER, invoiced])
    check('H · an invoice issued for a DIFFERENT amount is refused',
      (await confirm(invoiced)).reason === 'invoice_amount_mismatch')
    check('H · …and writes nothing', (await evidence(invoiced)) === 0)
  }

  console.log('\n■ I. Identity — anon, and another tenant')
  {
    const id = await junShaped()
    const fp = await fpOf(id)
    await asAnon()
    let anonBlocked = false
    try {
      const r = await q(`select public.owner_confirm_current_acceptance($1,'text_message','n',$2,500) as out`, [id, fp])
      anonBlocked = ((r.rows[0] as { out: Record<string, unknown> }).out).ok === false
    } catch { anonBlocked = true }
    check('I · an unauthenticated caller cannot record anything', anonBlocked)
    check('I · …and writes nothing', (await evidence(id)) === 0)

    const out = await confirm(id, { who: OTHER })
    check('I · another tenant cannot reach this quote at all',
      out.ok === false && out.reason === 'not_found', JSON.stringify(out))
    check('I · …and writes nothing', (await evidence(id)) === 0)

    // ⛔ The grant itself: anon must not hold EXECUTE.
    const g = (await q(`select has_function_privilege('anon', p.oid, 'execute') as can
                          from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                         where n.nspname='public' and p.proname='owner_confirm_current_acceptance'`)).rows[0] as { can: boolean }
    check('I · anon holds NO execute grant on the repair RPC', g.can === false)
  }

  console.log('\n■ M/N/O. S121, S114 and S122 still stand')
  {
    // M — the kinds remain distinct, and override still writes no evidence.
    const id = await junShaped()
    await confirm(id)
    const k = (await q(`select kind from public.quote_acceptances where quote_id=$1`, [id])).rows[0] as { kind: string }
    check('M · the repair writes owner_on_behalf, never customer', k.kind === 'owner_on_behalf')
    const id2 = await junShaped()
    await asOwner()
    await q(`select public.owner_override_quote_status($1,'accepted','ZZ admin note') as ok`, [id2])
    check('M · an administrative override still records NO evidence', (await evidence(id2)) === 0)

    // N — S114: no-charge is a decision, not an absence.
    const nc = await junShaped({ price: 0, stale: null, deposit: false })
    await q(`update public.quotes set no_charge_at = now(), no_charge_reason = 'ZZ goodwill', no_charge_by = $2 where id=$1`, [nc, TENANT])
    const ncOut = await confirm(nc, { amount: 0 })
    check('N · a DECIDED no-charge quote may be attested to', ncOut.ok === true, JSON.stringify(ncOut))
    check('N · …while an undecided $0 quote is still refused as unpriced',
      (await confirm(await junShaped({ price: 0, stale: 1400 }), { amount: 0 })).reason === 'unpriced')

    // O — S122's gate is the thing that raised in §D; assert it is reached from here.
    const src = String((await q(`select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                                  where n.nspname='public' and p.proname='owner_confirm_current_acceptance'`)).rows[0].d)
    check('O · the repair composes quote_record_acceptance — every S121/S122 rule applies',
      /quote_record_acceptance/.test(src))
    check('O · ⛔ it does not insert evidence itself',
      !/insert\s+into\s+public\.quote_acceptances/i.test(src))
    check('O · ⛔ and it takes no tenant argument — identity is auth.uid()',
      /v_uid uuid := auth\.uid\(\)/.test(src) && !/p_tenant|p_user_id/.test(src))
  }

  console.log('\n■ JUN. The whole chain, end to end, on the live shape')
  {
    // current $500 · stale accepted_price $1,400 · accepted · zero evidence
    // 50% deposit · no job · no invoice — and the owner confirms by text.
    const id = await junShaped()
    const before = (await q(`select status, accepted_price, total from public.quotes where id=$1`, [id])).rows[0] as Record<string, unknown>
    check('JUN · before: accepted, stale $1,400, current $500, zero evidence',
      before.status === 'accepted' && Number(before.accepted_price) === 1400
      && Number(before.total) === 500 && (await evidence(id)) === 0,
      JSON.stringify(before))

    // ⭐ The unrepaired state is what the customer would have been shown: the
    // deposit derived from the STALE snapshot is $700 against a $500 document.
    check('JUN · unrepaired, the stale basis would ask $700',
      requiredDeposit({ status: 'accepted', total: 500, accepted_price: 1400,
        deposit_type: 'percent', deposit_value: 50 }) === 700)

    const out = await confirm(id)
    check('JUN · the owner confirms the CURRENT $500 by text', out.ok === true, JSON.stringify(out))

    const row = (await q(`select kind, accepted_amount from public.quote_acceptances where quote_id=$1`, [id])).rows[0] as Record<string, unknown>
    const after = (await q(`select status, accepted_price, total from public.quotes where id=$1`, [id])).rows[0] as Record<string, unknown>
    check('JUN · ONE owner_on_behalf evidence row', (await evidence(id)) === 1 && row.kind === 'owner_on_behalf')
    check('JUN · accepted snapshot = $500', Number(row.accepted_amount) === 500, String(row.accepted_amount))
    check('JUN · accepted_price = $500', Number(after.accepted_price) === 500, String(after.accepted_price))
    check('JUN · status stays accepted', after.status === 'accepted')

    // ⭐⭐ THE CHAIN THE BRIEF ASKS FOR, computed by the REAL gate over the REAL
    // repaired row — not by re-typing the numbers into the assertion.
    const gq = {
      status: String(after.status), total: Number(after.total),
      accepted_price: Number(after.accepted_price),
      deposit_type: 'percent', deposit_value: 50,
    }
    check('JUN · deposit BASIS is now $500', depositBasis(gq) === 500, String(depositBasis(gq)))
    const gate = schedulingGate(gq, [])
    check('JUN · required deposit = $250', gate.required === 250, String(gate.required))
    check('JUN · outstanding = $250 (nothing collected yet)', gate.outstanding === 250)
    check('JUN · the gate stands between acceptance and the schedule', gate.status === 'awaiting')
    check('JUN · remaining service balance after the deposit = $250',
      Number(after.accepted_price) - gate.required === 250)
    check('JUN · ⛔ no $700 anywhere in the repaired chain',
      gate.required !== 700 && depositBasis(gq) !== 1400)

    // The quote-deposit link is a QUOTE-level door: it needs no invoice.
    const invs = Number((await q(`select count(*)::int n from public.invoices where quote_id=$1`, [id])).rows[0].n)
    check('JUN · no invoice exists, and none is needed for the deposit link', invs === 0)

    // And the customer-facing presentation, from the same repaired row.
    const kind = String(row.kind)
    const pres = acceptedPresentation(String(after.status), kind as never)
    check('JUN · presentation is evidenced_on_behalf', pres === 'evidenced_on_behalf')
    const facing = customerFacingQuoteAmount(pres, Number(after.accepted_price), Number(after.total))
    check('JUN · the customer sees $500, labelled as an accepted amount',
      facing.amount === 500 && facing.isAcceptedAmount)
    const note = acceptedAmountNote(pres) ?? ''
    check('JUN · ⛔ and is never told "you accepted"', !/you accepted/i.test(note), note)
    check('JUN · …but IS told the business recorded it on their behalf',
      /on your behalf/i.test(note), note)
  }

  console.log('\n■ G2. Evidence that does NOT match cannot be joined by a repair row')
  {
    // The idempotent branch only fires for a repair identical to one already
    // recorded. Any OTHER evidence — a real customer acceptance above all — must
    // refuse. Without this case the `evidence_exists` return was unreachable in
    // the guard, and deleting it changed nothing.
    const id = await junShaped({ stale: null, status: 'sent' })
    await asOwner()
    await q(`select public.portal_accept_quote($1,$2,null,null,true) as ok`, [TOKEN, id])
    check('G2 · the customer\'s own acceptance is on record', (await evidence(id)) === 1)
    const kind = String((await q(`select kind from public.quote_acceptances where quote_id=$1`, [id])).rows[0].kind)
    check('G2 · …recorded as a CUSTOMER acceptance', kind === 'customer')
    const out = await confirm(id)
    check('G2 · a repair cannot be added beside customer evidence',
      out.ok === false && out.reason === 'evidence_exists', JSON.stringify(out))
    check('G2 · …and the count stays at one', (await evidence(id)) === 1)
  }

  console.log('\n■ P. The confirmation UI and route demand a NAMED version')
  {
    const strip = (s: string) => s.replace(/\r\n/g, '\n').replace(/^\s*\/\/.*$/gm, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    const dlg = strip(readFileSync(join(ROOT, 'src/components/quotes/RecordAcceptanceDialog.tsx'), 'utf8'))
    const rt = strip(readFileSync(join(ROOT, 'src/app/api/quotes/confirm-current-acceptance/route.ts'), 'utf8'))

    check('P · the confirmation requires the checkbox AND a note',
      /const canConfirm = [^\n]*confirmed && !!note\.trim\(\)/.test(dlg),
      'a repair without an explicit confirmation is just a click')
    check('P · the confirm button NAMES the amount being attested to',
      /Confirm acceptance of \{formatCurrency\(repair\.currentAmount\)\}/.test(dlg),
      'a generic Confirm lets an owner agree to a figure they never read')
    check('P · the checkbox sentence names the CURRENT amount',
      /I confirm the customer accepted the current quote for\{' '\}/.test(dlg)
      && /formatCurrency\(repair\.currentAmount\)/.test(dlg))
    check('P · the previous unsupported figure is shown to the owner',
      /Previous unsupported acceptance figure/.test(dlg)
      && /formatCurrency\(repair\.priorAmount\)/.test(dlg))
    check('P · the current quote NUMBER is shown beside the current amount',
      /Current quote \{quoteNumber\}/.test(dlg))
    check('P · it says plainly this is an attestation, not portal acceptance',
      /never as their own portal acceptance/.test(dlg))
    check('P · the dialog sends the fingerprint it READ',
      /expectedFingerprint: repair\.fingerprint/.test(dlg),
      'without it a quote edited in another tab is recorded against a version nobody saw')
    check('P · …and the amount it named', /expectedAmount: repair\.currentAmount/.test(dlg))

    check('P · the route requires an authenticated owner',
      /auth\.getUser\(\)/.test(rt) && /status: 401/.test(rt))
    check('P · the route REQUIRES a note on a material repair',
      /if \(!note\) \{/.test(rt) && /how you know the customer accepted this version/.test(rt))
    check('P · the route refuses without a fingerprint and an amount',
      /!fp \|\| !Number\.isFinite\(amount\)/.test(rt))
    check('P · the route keeps the terms verdict current before asking',
      /termsClaimRefresh/.test(rt))
    check('P · ⛔ the route passes NO tenant to the RPC',
      /owner_confirm_current_acceptance/.test(rt) && !/p_tenant|p_user_id/.test(rt))
  }

  console.log('\n■ R. THE RACE — the version RECORDED must be the version CHECKED (S122E)')
  {
    // ⚠️⚠️ WHAT THIS CAN AND CANNOT PROVE. PGlite compiles ONE Postgres backend to
    // WASM, so two transactions can never be in flight and a genuine interleaving
    // is not producible here. What IS proven is the CONSEQUENCE of a child row
    // moving between S122D's fingerprint check and the canonical writer's own
    // recomputation — which is the thing the contract exists to stop. The
    // concurrency is injected into a PROBE COPY of the deployed function, and the
    // probe is asserted to differ from it by EXACTLY the injected lines.
    //
    // ⛔ THE PROBE IS NOT THE SUBJECT. It supplies only the interleaving; the real
    // quote_record_acceptance and the real S122E contract decide every outcome
    // below. Same-transaction visibility stands in for READ COMMITTED
    // cross-transaction visibility — a different mechanism presenting the same
    // observable to the statement that follows, stated here rather than glossed.
    const realSrc = String((await q(
      `select pg_get_functiondef(p.oid) src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='owner_confirm_current_acceptance'`)).rows[0].src)
    const STAMP = '  update public.quotes set accepted_price = v_amount where id = p_quote_id;'
    check('R · the injection point exists exactly once in the deployed body',
      realSrc.split(STAMP).length - 1 === 1)
    check('R · …and it sits AFTER the fingerprint check it is meant to defeat',
      realSrc.indexOf('fingerprint_mismatch') < realSrc.indexOf(STAMP)
      && realSrc.indexOf(STAMP) < realSrc.indexOf('quote_record_acceptance('))
    check('R · S122D arms the expectation the writer will assert',
      /app\.quote_expected_fingerprint/.test(realSrc) && /app\.quote_expected_amount/.test(realSrc))

    // A probe = the deployed body, renamed, with `injected` spliced in at the
    // stamp. The line delta is asserted by the caller, so a probe can never
    // quietly grow into a rewrite of the thing under test.
    const mkProbe = async (name: string, injected: string[]) => {
      const src = realSrc
        .replace('FUNCTION public.owner_confirm_current_acceptance(', `FUNCTION public.${name}(`)
        .replace(STAMP, [STAMP, ...injected].join('\n'))
      await db.exec(src)
      return src.split('\n').length - realSrc.split('\n').length
    }
    // ⛔ THE CONTROL is the SAME probe with the expectation disarmed — exactly the
    // pre-S122E behaviour — so the pair isolates the contract and nothing else.
    const DISARM = "  perform set_config('app.quote_expected_fingerprint','',true); perform set_config('app.quote_expected_amount','',true);"
    const callProbe = async (name: string, id: string, fp: string, amount: number) => {
      await asOwner()
      try {
        const r = await q(`select public.${name}($1,$2,$3,$4,$5) as out`,
          [id, 'text_message', 'Customer texted yes to the revised price.', fp, amount])
        return (r.rows[0] as { out: Record<string, unknown> }).out
      } catch (e) { return { ok: false, raised: (e as Error).message } as Record<string, unknown> }
    }
    const latest = async (id: string) => (await q(
      `select document_fingerprint f, accepted_amount a from public.quote_acceptances
        where quote_id=$1 order by seq desc limit 1`, [id])).rows[0] as { f: string; a: string } | undefined
    const acceptedPrice = async (id: string) =>
      Number((await q(`select accepted_price p from public.quotes where id=$1`, [id])).rows[0].p)
    const addService = async (id: string, price: number) =>
      q(`insert into public.quote_services (user_id, quote_id, service_type, quantity, unit_price, sort_order)
         values ($1,$2,'ZZ line',1,$3,0)`, [TENANT, id, price])

    // ── The concurrent writes, and one that turned out not to be ──────────────
    // ⚠️⚠️ CORRECTED after independent re-testing on real backends: the INSERT arm
    // is NOT externally reachable. A real external INSERT into quote_services
    // takes FOR KEY SHARE on the parent `quotes` row, which conflicts with this
    // function's FOR UPDATE, and the attempt ends in `deadlock detected` with
    // nothing written. The same-transaction injection below bypasses that lock,
    // so it must not be read as evidence that the INSERT path races — it is kept
    // only as a second exercise of the contract on a moved fingerprint, and it is
    // labelled as such wherever it prints.
    //
    // ⭐ UPDATE, DELETE and the selected-option price DO race, on independent
    // backends. Those are the cases the contract exists for.
    const CASES: { key: string; label: string; sql: string; prep?: (id: string) => Promise<unknown> }[] = [
      { key: 'ins', label: 'a service line is INSERTED (⚠️ contract exercise only — a real external INSERT deadlocks on the parent lock)',
        sql: `  insert into public.quote_services (user_id, quote_id, service_type, quantity, unit_price, sort_order) values (v_q.user_id, p_quote_id, 'ZZ concurrent', 1, 40, 9);` },
      { key: 'upd', label: 'a service line PRICE is edited',
        prep: id => addService(id, 40),
        sql: `  update public.quote_services set unit_price = unit_price + 25 where quote_id = p_quote_id;` },
      { key: 'del', label: 'every service line is DELETED (the editor’s clear-and-reinsert)',
        prep: id => addService(id, 40),
        sql: `  delete from public.quote_services where quote_id = p_quote_id;` },
    ]

    for (const c of CASES) {
      check(`R · probe(${c.key}) differs from the deployed body by exactly 1 line`,
        (await mkProbe(`zz_probe_${c.key}`, [c.sql])) === 1)
      check(`R · control(${c.key}) differs by exactly 2 — the write and the disarm`,
        (await mkProbe(`zz_control_${c.key}`, [c.sql, DISARM])) === 2)

      // ── The DEFECT, reproduced: with the contract disarmed the wrong version is
      // recorded and the call still reports success.
      {
        const id = await junShaped()
        await c.prep?.(id)
        const fp = await fpOf(id)
        const out = await callProbe(`zz_control_${c.key}`, id, fp, 500)
        check(`R · ⛔ WITHOUT the contract, ${c.label} → still reports ok`, out.ok === true, JSON.stringify(out))
        const row = await latest(id)
        check('R ·   …and the fingerprint STORED is not the one confirmed',
          !!row && row.f !== fp && row.f.length === 32, `${row?.f} vs ${fp}`)
        check('R ·   …so quote_acceptance_is_current answers TRUE for a version nobody saw',
          (await q(`select public.quote_acceptance_is_current($1) c`, [id])).rows[0].c === true,
          'the harm is an inversion, not a gap: a refusal became an authorisation')
      }

      // ── The CONTRACT: same interleaving, refused, everything rolled back.
      {
        const id = await junShaped()
        await c.prep?.(id)
        const fp = await fpOf(id)
        const out = await callProbe(`zz_probe_${c.key}`, id, fp, 500)
        check(`R · ✅ WITH the contract, ${c.label} → refused`, out.ok === false, JSON.stringify(out))
        check('R ·   …and the refusal says plainly that nothing was saved',
          /changed while it was being confirmed/.test(String(out.raised ?? '')), String(out.raised))
        check('R ·   …ZERO evidence rows were written', (await evidence(id)) === 0)
        check('R ·   …and accepted_price rolled back to its pre-repair 1400',
          (await acceptedPrice(id)) === 1400, String(await acceptedPrice(id)))
      }
    }

    // ── The SELECTED-OPTION case — predicted by the review, not proven there ───
    // A concurrent option-price change moves the WRITER's own v_amount too, so the
    // corruption is strictly worse than the service cases: quotes.accepted_price
    // and quote_acceptances.accepted_amount come apart on the same quote.
    {
      const optionQuote = async () => {
        const id = await junShaped({ price: 0 })
        const oid = `44444444-4444-4444-8444-${String(seq).padStart(12, '0')}`
        await q(`insert into public.quote_options (id, quote_id, user_id, name, price, sort_order, is_recommended)
                 values ($1,$2,$3,'ZZ Option A',500,0,true)`, [oid, id, TENANT])
        // The consent-writer marker, the same escape junShaped uses to seed a
        // stale snapshot: quotes_protect_consent_snapshot refuses this column to
        // anything but the acceptance window, and the fixture's job is to build
        // the live shape, not to fight the protection that guards it.
        await q(`select set_config('app.quote_consent_writer', $1, false)`, [id])
        await q(`update public.quotes set selected_option_id=$2 where id=$1`, [id, oid])
        await q(`select set_config('app.quote_consent_writer', '', false)`)
        return id
      }
      const BUMP = `  update public.quote_options set price = price + 250 where quote_id = p_quote_id;`
      check('R · probe(option) differs from the deployed body by exactly 1 line',
        (await mkProbe('zz_probe_opt', [BUMP])) === 1)
      check('R · control(option) differs by exactly 2',
        (await mkProbe('zz_control_opt', [BUMP, DISARM])) === 2)

      {
        const id = await optionQuote()
        const out = await callProbe('zz_control_opt', id, await fpOf(id), 500)
        check('R · ⛔ WITHOUT the contract, a concurrent OPTION price change reports ok',
          out.ok === true, JSON.stringify(out))
        const ap = await acceptedPrice(id), row = await latest(id)
        check('R ·   …and the quote and its own evidence disagree about the money',
          ap === 500 && Number(row?.a) === 750, `accepted_price=${ap} evidence.accepted_amount=${row?.a}`)
      }
      {
        const id = await optionQuote()
        const out = await callProbe('zz_probe_opt', id, await fpOf(id), 500)
        check('R · ✅ WITH the contract, the option race is refused', out.ok === false, JSON.stringify(out))
        check('R ·   …ZERO evidence, and accepted_price back at 1400',
          (await evidence(id)) === 0 && (await acceptedPrice(id)) === 1400)
      }
    }

    // ── A change landing AFTER the version was recorded is NOT this contract's
    // business ───────────────────────────────────────────────────────────────
    // ⭐⭐ This is why the assertion reads what was STORED rather than re-deriving
    // the fingerprint. Re-deriving takes ANOTHER snapshot, so an edit that lands
    // after the row is written would roll back a perfectly good attestation — the
    // opposite error, and a liveness bug that would be blamed on the owner. The
    // right ending for a later edit already exists: the acceptance stands, and
    // quote_acceptance_is_current answers false until it is re-approved.
    {
      const src = realSrc
        .replace('FUNCTION public.owner_confirm_current_acceptance(', 'FUNCTION public.zz_probe_after(')
        .replace('  perform public.audit_log(',
          `  insert into public.quote_services (user_id, quote_id, service_type, quantity, unit_price, sort_order)
     values (v_q.user_id, p_quote_id, 'ZZ later', 1, 15, 7);
  perform public.audit_log(`)
      await db.exec(src)
      const id = await junShaped()
      const out = await callProbe('zz_probe_after', id, await fpOf(id), 500)
      check('R · a later edit does NOT roll back the attestation', out.ok === true, JSON.stringify(out))
      check('R ·   …the evidence stands, recorded at the version confirmed',
        (await evidence(id)) === 1)
      check('R ·   …and is invalidated the honest way, by needing reapproval',
        (await q(`select public.quote_acceptance_is_current($1) c`, [id])).rows[0].c === false)
    }

    // ── The AMOUNT clause is not dead code ────────────────────────────────────
    // ⚠️ Every input to the authorized amount is ALSO a fingerprint input, so in
    // today's schema the amount clause can never fire alone through S122D — the
    // fingerprint clause reaches any divergence first. Said plainly rather than
    // dressed up as an independent scenario: it is defence in depth against a
    // future amount input that is not fingerprinted, and it is exercised directly
    // against the canonical writer here so it cannot rot into a comment.
    {
      const id = await junShaped()
      const armed = async (amt: string) => {
        try {
          await db.exec(`do $zz$ declare v uuid; begin
            perform set_config('app.quote_expected_amount', '${amt}', true);
            v := public.quote_record_acceptance('${id}','owner_on_behalf','dashboard',
                   '${TENANT}'::uuid,'ZZ Owner','text_message',null,true);
          end $zz$;`)
          return null
        } catch (e) { return (e as Error).message }
      }
      check('R · the writer refuses a stored amount that is not the confirmed one',
        /amount that would have been recorded/.test(String(await armed('999.00'))))
      check('R ·   …and nothing was written', (await evidence(id)) === 0)
      check('R · …while the CORRECT amount passes through untouched', (await armed('500.00')) === null)
      check('R ·   …writing exactly one row', (await evidence(id)) === 1)
    }

    // ── Single-use: a marker may never leak into a second write ───────────────
    {
      const id = await junShaped()
      let leaked = 'unset'
      try {
        await db.exec(`do $zz$ declare v uuid; begin
          perform set_config('app.quote_expected_amount', '500.00', true);
          v := public.quote_record_acceptance('${id}','owner_on_behalf','dashboard',
                 '${TENANT}'::uuid,'ZZ Owner','text_message',null,true);
          if coalesce(current_setting('app.quote_expected_amount', true), '') <> '' then
            raise exception 'MARKER SURVIVED';
          end if;
        end $zz$;`)
      } catch (e) { leaked = (e as Error).message }
      check('R · the expectation is consumed exactly once, never inherited', leaked === 'unset', leaked)
    }

    // ── Undisturbed and replay are unchanged by any of this ───────────────────
    {
      const id = await junShaped()
      const first = await confirm(id)
      check('R · an UNDISTURBED attestation still succeeds', first.ok === true, JSON.stringify(first))
      const row = await latest(id)
      check('R ·   …recording exactly the version that was confirmed', row?.f === await fpOf(id))
      const again = await confirm(id)
      check('R · a REPLAY is still idempotent, not a second row',
        again.ok === true && again.idempotent === true, JSON.stringify(again))
      check('R ·   …exactly one evidence row', (await evidence(id)) === 1)
    }
  }

  await db.close()
  console.log(fail > 0 ? `\n✗ ${fail} FAILURE(S) — ${pass} passed` : `\n✓ current-version-acceptance: ${pass} checks passed`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()
