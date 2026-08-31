// ── Verify: acceptance may not record consent to contradictory terms ─────────
//   npm run verify:acceptance-contradiction
//
// WHY THIS SCRIPT EXISTS
// The send gate stops a NEW contradictory quote going out. It cannot stop an
// ALREADY-SENT one being accepted, and it cannot stop terms being edited AFTER a
// compatible quote was sent — and because `portal_accept_quote` is granted to
// `anon`, it cannot stop either from a stale or direct client. S121 made the
// terms load-bearing (the customer must agree to them), so recording consent
// over a contradiction is consent to the wrong thing.
//
// This guard therefore proves the DATABASE refuses, not the UI. It builds a real
// Postgres (PGlite, in-memory, disposable), applies the repository's own
// baseline plus the S122 candidate, and then CALLS THE ACTUAL RPCs — the same
// entry points a browser or a curl command would reach.
//
// ⛔ Nothing here touches production. No network, no fixture rows anywhere but
// the throwaway database this process creates and drops.
//
// ⚠️ SKIPS CLEAN when PGlite is absent, exactly like verify:rebuild — a guard
// that cannot run must say so rather than pass silently.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { splitStatements, loadPGlite, substitutePlatformStatements } from './lib/pg-sql'
import { classifyTermsPaymentClaim, termsFingerprint, TERMS_CLASSIFIER_VERSION } from '../src/lib/payments/termsTimingConflict'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}

const ROOT = process.cwd()
const TENANT = '11111111-1111-4111-8111-111111111111'
const CUSTOMER = '22222222-2222-4222-8222-222222222222'
const TOKEN = 'zz-s122-fixture-token'

const COMPATIBLE = 'We accept cash, cheque and e-transfer. Please give 24 hours notice to cancel.'
const NO_MONEY = 'Payment due upon completion unless otherwise agreed.'
const MONEY_UP = 'A 50% deposit is required before we schedule your job.'
const AMBIGUOUS = 'A 50% deposit is required before we book. No deposit is required for any job.'

async function main() {
  const pglite = await loadPGlite()
  if (!pglite) {
    console.log('\n⏭  verify:acceptance-contradiction SKIPPED — PGlite is not installed.')
    console.log('   This guard proves the DATABASE refuses contradictory consent.')
    console.log('   Run it before any release:  npm i -D @electric-sql/pglite\n')
    process.exit(0)
  }
  const { PGlite, contribs } = pglite
  const db = await PGlite.create({ extensions: Object.fromEntries(Object.entries(contribs).filter(([, v]) => v)) })

  const apply = async (label: string, raw: string) => {
    const { sql } = substitutePlatformStatements(raw)
    let n = 0
    for (const st of splitStatements(sql)) {
      try { await db.exec(st); n++ } catch (e) {
        throw new Error(`${label}: statement ${n + 1} failed — ${(e as Error).message}\n${st.slice(0, 300)}`)
      }
    }
    return n
  }

  console.log('\n══ acceptance contradiction gate — real Postgres, real RPCs ════════\n')
  await apply('prelude', readFileSync(join(ROOT, 'scripts/schema/platform-prelude.sql'), 'utf8'))
  const baselineName = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('_baseline.sql')).sort().pop()!
  await apply('baseline', readFileSync(join(ROOT, 'supabase/migrations', baselineName), 'utf8'))
  console.log(`  applied ${baselineName}`)
  // ⭐ Applied in the SAME ORDER S106 must use. Stage A is additive and inert;
  // Stage B is the only part that can refuse, and it fails closed on an
  // unclassified tenant — so the real landing runs the backfill between them.
  await apply('S122 Stage A', readFileSync(join(ROOT, 'supabase/proposals/RUN-S122A-terms-payment-claim-columns.sql'), 'utf8'))
  console.log('  applied Stage A — RUN-S122A-terms-payment-claim-columns.sql')

  // ⭐⭐ STAGE A IS INERT, PROVEN NOT ASSUMED. Before Stage B exists, an
  // unclassified tenant must still be able to accept — otherwise "additive and
  // safe to sit on" is a claim nobody checked, and S106 would be applying A on
  // production trusting a sentence in a comment.
  {
    const d0 = (await db.query(
      `select pg_get_functiondef(p.oid) as d from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='quote_record_acceptance' and p.prokind='f'`)).rows[0] as { d: string }
    check('Stage A alone does NOT touch quote_record_acceptance',
      !/S122 · TERMS MAY NOT CONTRADICT/.test(d0.d))
  }

  await apply('S122 Stage B', readFileSync(join(ROOT, 'supabase/proposals/RUN-S122B-acceptance-terms-gate.sql'), 'utf8'))
  console.log('  applied Stage B — RUN-S122B-acceptance-terms-gate.sql\n')

  // ── The anchor patch actually landed ──────────────────────────────────────
  const def = (await db.query(
    `select pg_get_functiondef(p.oid) as d from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname='quote_record_acceptance' and p.prokind='f'`)).rows[0] as { d: string }
  check('the gate was patched into quote_record_acceptance', /S122 · TERMS MAY NOT CONTRADICT/.test(def.d))
  check('…and S121\'s terms-acknowledgement refusal SURVIVED the patch',
    /the quoted scope and terms must be acknowledged/.test(def.d))
  check('…and S121\'s options rule survived', /the accepted one must be named/.test(def.d))
  check('…and the evidence insert survived', /insert into public\.quote_acceptances/.test(def.d))

  // ── Fixture tenant ────────────────────────────────────────────────────────
  const q = (sql: string, params: unknown[] = []) => db.query(sql, params)
  // ⚠️ PGlite ships PostgreSQL 18, which refuses an UPDATE on a published table
  // whose replica identity contains a generated column — `quotes.total` is
  // generated and the table is in supabase_realtime, so every acceptance would
  // fail with "cannot update table quotes" for a reason that has nothing to do
  // with this feature. That is a property of the TEST TARGET, not of production
  // (PG17, where these updates are routine), so the publication is dropped here
  // rather than the assertions being weakened. Same workaround, same reason, as
  // verify:custom-fields.
  try { await q(`drop publication if exists supabase_realtime`) } catch { /* not present */ }

  // The prelude's auth.users stub — 93 foreign keys point at it, and
  // business_settings.user_id is one of them.
  await q(`insert into auth.users (id, email) values ($1,'zz-s122-fixture@example.invalid')`, [TENANT])
  await q(`insert into public.business_settings (user_id, company_name, terms_text) values ($1,'ZZ-S122 Fixture Co',$2)`, [TENANT, COMPATIBLE])
  await q(`insert into public.customers (id, user_id, name) values ($1,$2,'ZZ-S122 Fixture Customer')`, [CUSTOMER, TENANT])
  await q(`insert into public.customer_portal_tokens (user_id, customer_id, token) values ($1,$2,$3)`, [TENANT, CUSTOMER, TOKEN])

  /** Persist a classification the way the app's atomic Settings save does. */
  const setTerms = async (terms: string, opts: { classify?: boolean; version?: number } = {}) => {
    const classify = opts.classify !== false
    await q(`update public.business_settings set terms_text = $2,
               terms_payment_claim = $3, terms_payment_claim_fingerprint = $4, terms_payment_claim_version = $5
             where user_id = $1`,
      [TENANT, terms,
        classify ? classifyTermsPaymentClaim(terms) : null,
        classify ? termsFingerprint(terms) : null,
        classify ? (opts.version ?? TERMS_CLASSIFIER_VERSION) : null])
  }

  let seq = 0
  const newQuote = async (deposit: 'percent' | null, total: number) => {
    seq++
    const id = `33333333-3333-4333-8333-${String(seq).padStart(12, '0')}`
    await q(`insert into public.quotes (id, user_id, customer_id, customer_name, quote_number, service_type,
               address, status, initial_price, travel_fee, deposit_type, deposit_value)
             values ($1,$2,$3,'ZZ-S122 Fixture Customer',$4,'ZZ-S122 Service','1 Test St','sent',$5,0,$6,$7)`,
      [id, TENANT, CUSTOMER, `ZZ-S122-${seq}`, total, deposit, deposit ? 50 : null])
    return id
  }

  /** The PUBLIC door, exactly as a browser or curl reaches it. */
  const portalAccept = async (quoteId: string): Promise<{ ok: boolean; err?: string }> => {
    try {
      const r = await q(`select public.portal_accept_quote($1,$2,null,null,true) as ok`, [TOKEN, quoteId])
      return { ok: !!(r.rows[0] as { ok: boolean }).ok }
    } catch (e) { return { ok: false, err: (e as Error).message } }
  }
  const evidenceCount = async (quoteId: string) =>
    Number((await q(`select count(*)::int as n from public.quote_acceptances where quote_id = $1`, [quoteId])).rows[0].n)
  const statusOf = async (quoteId: string) =>
    String((await q(`select status from public.quotes where id = $1`, [quoteId])).rows[0].status)
  const acceptedPriceOf = async (quoteId: string) =>
    (await q(`select accepted_price from public.quotes where id = $1`, [quoteId])).rows[0].accepted_price

  /** A refusal must leave NOTHING behind — that is the whole product claim. */
  const proveRefused = async (label: string, quoteId: string, r: { ok: boolean; err?: string }) => {
    check(`${label} — refused`, !r.ok, 'acceptance succeeded')
    check(`${label} — no evidence row`, (await evidenceCount(quoteId)) === 0)
    check(`${label} — status not 'accepted'`, (await statusOf(quoteId)) !== 'accepted')
    check(`${label} — no accepted_price snapshot`, (await acceptedPriceOf(quoteId)) === null)
    if (r.err) check(`${label} — the customer is told what to do`, /update the quote or its terms/.test(r.err), r.err)
  }
  const proveAccepted = async (label: string, quoteId: string, r: { ok: boolean; err?: string }) => {
    check(`${label} — accepted`, r.ok, r.err ?? 'returned false')
    check(`${label} — evidence written`, (await evidenceCount(quoteId)) === 1)
    check(`${label} — status accepted`, (await statusOf(quoteId)) === 'accepted')
  }

  console.log('■ 1. Compatible terms accept; every contradiction refuses')
  {
    await setTerms(COMPATIBLE)
    const a = await newQuote('percent', 1000)
    await proveAccepted('compatible terms + deposit quote', a, await portalAccept(a))

    // no_claim: says nothing about timing, so it fits either configuration.
    const b = await newQuote(null, 1000)
    await proveAccepted('no_claim terms + no-deposit quote', b, await portalAccept(b))

    // CASE 1 — deposit required, terms promise money-after-work.
    await setTerms(NO_MONEY)
    const c = await newQuote('percent', 1400)
    await proveRefused('deposit quote + no_money_before_work', c, await portalAccept(c))

    // CASE 2 — the OTHER direction, the half a lesser gate would have missed.
    await setTerms(MONEY_UP)
    const d = await newQuote(null, 1400)
    await proveRefused('no-deposit quote + money_before_work', d, await portalAccept(d))

    // …and the same terms are fine for a quote that DOES take a deposit.
    const e = await newQuote('percent', 1400)
    await proveAccepted('money_before_work terms + deposit quote', e, await portalAccept(e))

    // CASE 4 — ambiguous and unclassified are absences of a verdict, not verdicts.
    await setTerms(AMBIGUOUS)
    const f = await newQuote('percent', 1400)
    await proveRefused('ambiguous terms', f, await portalAccept(f))

    await setTerms(COMPATIBLE, { classify: false })
    const g = await newQuote('percent', 1400)
    await proveRefused('unclassified terms (never classified)', g, await portalAccept(g))

    // A stale CLASSIFIER VERSION, with terms byte-identical and fingerprint valid.
    await setTerms(COMPATIBLE, { version: TERMS_CLASSIFIER_VERSION - 1 })
    const h = await newQuote('percent', 1400)
    await proveRefused('stale classifier version', h, await portalAccept(h))
  }

  console.log('\n■ 2. Terms changed AFTER send — the lifecycle hole')
  {
    await setTerms(COMPATIBLE)
    const id = await newQuote('percent', 1400)
    check('sent under compatible terms', (await statusOf(id)) === 'sent')

    // The owner edits the terms directly — the shape a second tab, an API client
    // or a raw SQL edit takes. The stored classification is now stale.
    await q(`update public.business_settings set terms_text = $2 where user_id = $1`, [TENANT, NO_MONEY])
    const stored = (await q(`select terms_payment_claim, terms_payment_claim_fingerprint
                               from public.business_settings where user_id = $1`, [TENANT])).rows[0] as
      { terms_payment_claim: string | null; terms_payment_claim_fingerprint: string | null }
    check('the trigger invalidated the stale verdict', stored.terms_payment_claim === null,
      `claim is still ${stored.terms_payment_claim}`)

    await proveRefused('post-send terms change (stale verdict)', id, await portalAccept(id))

    // Reclassify the EXACT new terms. They are genuinely contradictory, so the
    // refusal must STAND — a fresh verdict is not a permission slip.
    await setTerms(NO_MONEY)
    await proveRefused('post-send change, reclassified and still contradictory', id, await portalAccept(id))

    // Now make the terms compatible and reclassify: acceptance succeeds.
    await setTerms(COMPATIBLE)
    await proveAccepted('post-send change, terms made compatible', id, await portalAccept(id))
  }

  console.log('\n■ 3. The fingerprint is load-bearing on its own')
  {
    // Terms and classifier version both current, but the stored fingerprint
    // belongs to DIFFERENT text. Only the fingerprint comparison can catch this.
    await setTerms(COMPATIBLE)
    await q(`update public.business_settings set terms_payment_claim_fingerprint = $2 where user_id = $1`,
      [TENANT, termsFingerprint('some other terms entirely')])
    const id = await newQuote('percent', 1400)
    await proveRefused('fingerprint belongs to other text', id, await portalAccept(id))
  }

  console.log('\n■ 4. Owner-on-behalf, and the administrative override')
  {
    await setTerms(NO_MONEY)
    const id = await newQuote('percent', 1400)
    // The owner path runs as an authenticated user; auth.uid() is read from the
    // request GUC, which is how the platform prelude models it.
    await q(`select set_config('request.jwt.claim.sub', $1, false)`, [TENANT])
    let ownerErr = ''
    try {
      await q(`select public.owner_record_customer_acceptance($1,'phone',null,null,null) as id`, [id])
    } catch (e) { ownerErr = (e as Error).message }
    check('owner-on-behalf CANNOT mint evidence over a contradiction', ownerErr !== '', 'it succeeded')
    check('…and is refused for the same stated reason', /update the quote or its terms/.test(ownerErr), ownerErr)
    check('…leaving no evidence row', (await evidenceCount(id)) === 0)

    // S121's distinction: an administrative status correction is NOT consent and
    // never was — it does not reach this function, so the gate must not change it.
    let ovErr = ''
    try {
      await q(`select public.owner_override_quote_status($1,'accepted','ZZ-S122 fixture override') as ok`, [id])
    } catch (e) { ovErr = (e as Error).message }
    check('admin override still succeeds (it is not consent)', ovErr === '', ovErr)
    check('…and still records NO acceptance evidence', (await evidenceCount(id)) === 0)
    await q(`select set_config('request.jwt.claim.sub', '', false)`)
  }

  console.log('\n■ 5. The public RPC is the boundary — a stale client gains nothing')
  {
    await setTerms(NO_MONEY)
    const id = await newQuote('percent', 1400)
    // portal_accept_quote is GRANTED TO anon: this is the call a stale browser
    // tab, a replayed request or a curl command makes. No app code is involved.
    const grants = (await q(
      `select has_function_privilege('anon', p.oid, 'execute') as can
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='portal_accept_quote'`)).rows[0] as { can: boolean }
    check('portal_accept_quote really is anon-executable (so the DB must be the gate)', !!grants.can)
    await proveRefused('direct anon RPC call', id, await portalAccept(id))
  }

  console.log('\n■ 6. The gate never touches money, and never rewrites terms')
  {
    await setTerms(COMPATIBLE)
    const before = String((await q(`select terms_text from public.business_settings where user_id=$1`, [TENANT])).rows[0].terms_text)
    const id = await newQuote('percent', 2000)
    await portalAccept(id)
    const after = String((await q(`select terms_text from public.business_settings where user_id=$1`, [TENANT])).rows[0].terms_text)
    check('the owner\'s terms are byte-identical after an acceptance', before === after)
    // The authorized amount still comes from the structured quote, never the prose.
    const amt = (await q(`select accepted_amount from public.quote_acceptances where quote_id=$1`, [id])).rows[0].accepted_amount
    check('the accepted amount is the structured quote total, untouched by terms', Number(amt) === 2000, String(amt))
  }

  await db.close()
  console.log(fail > 0 ? `\n✗ ${fail} FAILURE(S) — ${pass} passed` : `\n✓ acceptance-contradiction: ${pass} checks passed`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()
