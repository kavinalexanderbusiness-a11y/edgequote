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
import { requiredDeposit } from '../src/lib/payments/depositGate'

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
  console.log(`  applied ${baseline} + RUN-S122D\n`)

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

  await db.close()
  console.log(fail > 0 ? `\n✗ ${fail} FAILURE(S) — ${pass} passed` : `\n✓ current-version-acceptance: ${pass} checks passed`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()
