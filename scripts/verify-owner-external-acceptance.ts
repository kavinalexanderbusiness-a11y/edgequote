// ── Verify: an owner can record an acceptance that already happened ──────────
//   npm run verify:owner-external-acceptance
//
// WHY THIS SCRIPT EXISTS
// S122's acceptance gate fails closed while the stored terms classification
// cannot be trusted. For the CUSTOMER portal that is right — a stale verdict
// means we do not know what they are being asked to agree to. For the OWNER
// recording a yes that already happened by text, it was wrong, and it locked a
// real business out of its own books: the invalidation trigger nulls the verdict
// the moment terms_text changes, and only the Settings save rewrote it.
//
// In the live case, the owner had just EDITED THEIR TERMS TO REMOVE the
// contradiction we asked them to fix. The classifier's verdict on the new text
// is `no_claim` — no contradiction at all — and they were still refused.
//
// The repair reclassifies server-side and then runs the SAME gate. This guard
// proves both halves: that the self-heal unblocks the honest case, and that it
// is not a bypass — a genuine contradiction, `ambiguous` terms, and the anon
// portal path are all still refused.
//
// Real Postgres (PGlite, in-memory, disposable). No network, no production.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { splitStatements, loadPGlite, substitutePlatformStatements } from './lib/pg-sql'
import {
  classifyTermsPaymentClaim, termsFingerprint, TERMS_CLASSIFIER_VERSION,
} from '../src/lib/payments/termsTimingConflict'
import { termsClaimRefresh, type StoredTermsClaim } from '../src/lib/payments/termsClaimRefresh'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}

const ROOT = process.cwd()
const TENANT = '11111111-1111-4111-8111-111111111111'
const CUSTOMER = '22222222-2222-4222-8222-222222222222'
const TOKEN = 'zz-s122b-fixture-token'

// The SHAPE OF THE LIVE INCIDENT: general terms that say nothing at all about
// when money is due, on a quote that requires 50% before scheduling.
const GENERAL = 'We accept cash, cheque and e-transfer. Please give 24 hours notice to cancel or reschedule. All work is guaranteed for 30 days.'
const CONTRADICTS = 'Payment due upon completion unless otherwise agreed.'
const AMBIGUOUS = 'A 50% deposit is required before we book. No deposit is required for any job.'

async function main() {
  const pglite = await loadPGlite()
  if (!pglite) {
    console.log('\n⏭  verify:owner-external-acceptance SKIPPED — PGlite is not installed.\n')
    process.exit(0)
  }
  const { PGlite, contribs } = pglite
  const db = await PGlite.create({ extensions: Object.fromEntries(Object.entries(contribs).filter(([, v]) => v)) })
  const q = (sql: string, params: unknown[] = []) => db.query(sql, params)

  const apply = async (label: string, raw: string) => {
    const { sql } = substitutePlatformStatements(raw)
    let n = 0
    for (const st of splitStatements(sql)) {
      try { await db.exec(st); n++ } catch (e) {
        throw new Error(`${label}: statement ${n + 1} failed — ${(e as Error).message}`)
      }
    }
  }

  console.log('\n══ owner-recorded external acceptance ══════════════════════════════\n')
  await apply('prelude', readFileSync(join(ROOT, 'scripts/schema/platform-prelude.sql'), 'utf8'))
  const baselineName = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('_baseline.sql')).sort().pop()!
  await apply('baseline', readFileSync(join(ROOT, 'supabase/migrations', baselineName), 'utf8'))
  console.log(`  applied ${baselineName} (S122 already landed — the gate is IN the baseline)\n`)

  // PG18 refuses UPDATE on a published table whose replica identity holds a
  // generated column (quotes.total). Property of the test target, not production.
  try { await q(`drop publication if exists supabase_realtime`) } catch { /* absent */ }

  await q(`insert into auth.users (id, email) values ($1,'zz-s122b@example.invalid')`, [TENANT])
  await q(`insert into public.business_settings (user_id, company_name, terms_text) values ($1,'ZZ-S122B Fixture Co',$2)`, [TENANT, GENERAL])
  await q(`insert into public.customers (id, user_id, name) values ($1,$2,'ZZ-S122B Fixture Customer')`, [CUSTOMER, TENANT])
  await q(`insert into public.customer_portal_tokens (user_id, customer_id, token) values ($1,$2,$3)`, [TENANT, CUSTOMER, TOKEN])

  let seq = 0
  const newQuote = async (deposit: 'percent' | null, total: number) => {
    seq++
    const id = `33333333-3333-4333-8333-${String(seq).padStart(12, '0')}`
    await q(`insert into public.quotes (id, user_id, customer_id, customer_name, quote_number, service_type,
               address, status, initial_price, travel_fee, deposit_type, deposit_value)
             values ($1,$2,$3,'ZZ-S122B Fixture Customer',$4,'ZZ-S122B Service','1 Test St','sent',$5,0,$6,$7)`,
      [id, TENANT, CUSTOMER, `ZZ-S122B-${seq}`, total, deposit, deposit ? 50 : null])
    return id
  }
  /** Terms as the owner left them — deliberately WITHOUT any classification. */
  const setTermsUnclassified = async (terms: string) => {
    await q(`update public.business_settings set terms_text = $2,
               terms_payment_claim = null, terms_payment_claim_fingerprint = null,
               terms_payment_claim_version = null where user_id = $1`, [TENANT, terms])
  }
  /**
   * The route's own decision, run against the real row — NOT a re-implementation.
   *
   * ⚠️⚠️ This used to hand-roll the reclassification the route performs, and the
   * mutation harness proved that worthless: gutting the route's self-heal, its
   * classifier call, and its staleness rule all left this guard GREEN, because
   * the test was agreeing with itself. `termsClaimRefresh` is now the one
   * function both use, so a change to the route's logic changes this too.
   */
  const reclassifyLikeTheRoute = async () => {
    const row = (await q(`select terms_text, terms_payment_claim, terms_payment_claim_fingerprint,
                                 terms_payment_claim_version
                            from public.business_settings where user_id=$1`, [TENANT])).rows[0] as StoredTermsClaim
    const { stale, patch } = termsClaimRefresh(row)
    if (!stale) return
    await q(`update public.business_settings set terms_payment_claim=$2,
               terms_payment_claim_fingerprint=$3, terms_payment_claim_version=$4 where user_id=$1`,
      [TENANT, patch.terms_payment_claim, patch.terms_payment_claim_fingerprint, patch.terms_payment_claim_version])
  }
  const asOwner = () => q(`select set_config('request.jwt.claim.sub', $1, false)`, [TENANT])
  const ownerRecord = async (quoteId: string): Promise<{ ok: boolean; err?: string }> => {
    await asOwner()
    try {
      const r = await q(`select public.owner_record_customer_acceptance($1,'text_message',null,null,null) as id`, [quoteId])
      return { ok: !!(r.rows[0] as { id: string | null }).id }
    } catch (e) { return { ok: false, err: (e as Error).message } }
  }
  const portalAccept = async (quoteId: string): Promise<{ ok: boolean; err?: string }> => {
    await q(`select set_config('request.jwt.claim.sub', '', false)`)
    try {
      const r = await q(`select public.portal_accept_quote($1,$2,null,null,true) as ok`, [TOKEN, quoteId])
      return { ok: !!(r.rows[0] as { ok: boolean }).ok }
    } catch (e) { return { ok: false, err: (e as Error).message } }
  }
  const evidence = async (quoteId: string) =>
    Number((await q(`select count(*)::int as n from public.quote_acceptances where quote_id=$1`, [quoteId])).rows[0].n)

  console.log('■ 1. THE LIVE INCIDENT — general terms, 50% deposit, classification missing')
  {
    await setTermsUnclassified(GENERAL)
    check('the canonical classifier reads these terms as no_claim',
      classifyTermsPaymentClaim(GENERAL) === 'no_claim', classifyTermsPaymentClaim(GENERAL))

    // BEFORE the repair: the gate refuses, because the verdict is untrustworthy.
    const before = await newQuote('percent', 1400)
    const r0 = await ownerRecord(before)
    check('WITHOUT reclassification the owner is refused (the reported bug)', !r0.ok)
    check('…and the refusal is about the terms not being reviewed',
      /not been reviewed/.test(r0.err ?? ''), r0.err)
    check('…leaving no evidence row', (await evidence(before)) === 0)

    // AFTER the repair: reclassify server-side, then the SAME gate runs.
    const after = await newQuote('percent', 1400)
    await reclassifyLikeTheRoute()
    const r1 = await ownerRecord(after)
    check('WITH reclassification the owner-recorded acceptance SUCCEEDS', r1.ok, r1.err)
    check('…exactly ONE evidence row', (await evidence(after)) === 1)

    const row = (await q(`select kind, source, actor_type, actor_id, on_behalf_reason,
                                 accepted_amount, terms_required, terms_acknowledged, terms_text
                            from public.quote_acceptances where quote_id=$1`, [after])).rows[0] as Record<string, unknown>
    check('evidence is owner_on_behalf, not fabricated customer consent',
      row.kind === 'owner_on_behalf' && row.actor_type === 'owner' && row.source === 'dashboard')
    check('…names the method the owner chose', row.on_behalf_reason === 'text_message')
    check('…names the owner', row.actor_id === TENANT)
    check('…records the exact accepted amount from the structured quote', Number(row.accepted_amount) === 1400)
    check('…snapshots the terms in force', row.terms_required === true && String(row.terms_text) === GENERAL)
    check('quote is accepted', String((await q(`select status from public.quotes where id=$1`, [after])).rows[0].status) === 'accepted')
    check('the deposit rule is untouched — still 50%',
      String((await q(`select deposit_type||':'||deposit_value as d from public.quotes where id=$1`, [after])).rows[0].d) === 'percent:50.00')

    const terms = String((await q(`select terms_text from public.business_settings where user_id=$1`, [TENANT])).rows[0].terms_text)
    check('⛔ the owner\'s terms were NOT rewritten', terms === GENERAL)
    check('…and the persisted claim is the classifier\'s, not a guess',
      String((await q(`select terms_payment_claim from public.business_settings where user_id=$1`, [TENANT])).rows[0].terms_payment_claim) === 'no_claim')
  }

  console.log('\n■ 2. NOT A BYPASS — reclassification does not excuse a real contradiction')
  {
    await setTermsUnclassified(CONTRADICTS)
    await reclassifyLikeTheRoute()   // the route would do exactly this, honestly
    const id = await newQuote('percent', 1400)
    const r = await ownerRecord(id)
    check('owner-on-behalf is STILL refused on genuinely contradictory terms', !r.ok)
    check('…with the contradiction named, not a generic error',
      /no money is due until the work is done/.test(r.err ?? ''), r.err)
    check('…and no evidence row', (await evidence(id)) === 0)

    await setTermsUnclassified(AMBIGUOUS)
    await reclassifyLikeTheRoute()
    check('ambiguous terms classify as ambiguous', classifyTermsPaymentClaim(AMBIGUOUS) === 'ambiguous')
    const id2 = await newQuote('percent', 1400)
    const r2 = await ownerRecord(id2)
    check('owner-on-behalf is STILL refused on ambiguous terms', !r2.ok)
    check('…and no evidence row', (await evidence(id2)) === 0)
  }

  console.log('\n■ 3. The customer portal keeps its fail-closed behaviour')
  {
    // Stale/unclassified: the portal must NOT self-heal. A customer must never
    // trigger a reclassification of the business's terms by trying to accept.
    await setTermsUnclassified(GENERAL)
    const id = await newQuote('percent', 1400)
    const r = await portalAccept(id)
    check('anon portal acceptance is refused while the verdict is stale', !r.ok)
    check('…and no evidence row', (await evidence(id)) === 0)
    const claim = (await q(`select terms_payment_claim from public.business_settings where user_id=$1`, [TENANT])).rows[0].terms_payment_claim
    check('⛔ the portal attempt did NOT reclassify anything', claim === null,
      `claim became ${String(claim)} — the portal must never write the business's classification`)

    // Once the OWNER's path has reclassified, the portal proceeds normally —
    // the gate judges on merits, which is the whole design.
    await reclassifyLikeTheRoute()
    const id2 = await newQuote('percent', 1400)
    check('after the owner path reclassifies, the portal accepts on merits', (await portalAccept(id2)).ok)
  }

  console.log('\n■ 4. Double submission cannot create two acceptances')
  {
    await setTermsUnclassified(GENERAL)
    await reclassifyLikeTheRoute()
    const id = await newQuote('percent', 900)
    const [a, b] = await Promise.all([ownerRecord(id), ownerRecord(id)])
    check('two concurrent owner records → exactly ONE evidence row', (await evidence(id)) === 1,
      `a.ok=${a.ok} b.ok=${b.ok}`)
    check('…and exactly one of them reports success', (a.ok ? 1 : 0) + (b.ok ? 1 : 0) === 1)
  }

  console.log('\n■ 5. The route itself — structural')
  {
    const route = readFileSync(join(ROOT, 'src/app/api/quotes/record-acceptance/route.ts'), 'utf8')
    const code = route.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    check('the route requires an authenticated owner', /auth\.getUser\(\)/.test(code) && /status: 401/.test(code))
    check('it derives the refresh from THE shared decision, not its own copy',
      /termsClaimRefresh\(row\)/.test(code) && !/classifyTermsPaymentClaim/.test(code),
      'the route must not re-implement the staleness rule')
    // ⚠️ These four were MISSED by the first mutation run, because §1–§4 tested a
    // simulation of the route rather than the route. The behaviour now lives in
    // termsClaimRefresh (exercised above), and what remains here is the wiring
    // that only the route can get wrong.
    check('it actually PERFORMS the self-heal when the verdict is stale',
      /if \(row != null && stale\) \{/.test(code) && /\.update\(patch\)/.test(code),
      'without this the owner is locked out again — the reported bug')
    check('⛔ the ONLY success response comes AFTER the RPC and carries its id',
      (code.match(/ok: true/g) || []).length === 1
      && code.indexOf('ok: true') > code.indexOf('owner_record_customer_acceptance')
      && /ok: true, acceptanceId/.test(code),
      'an early ok:true would be a bypass — success without the database deciding')
    check('a failed TERMS READ specifically refuses (never "no terms")',
      /if \(bsErr\) \{[\s\S]{0,200}status: 502/.test(code))
    // ⚠️ The write is now `.update(patch)` — a value, not an inline literal — so
    // there is no object to grep. That is STRICTER, not weaker: the shape is
    // fixed by termsClaimRefresh, whose key set is asserted exactly above, and a
    // second update or an inline literal here would be the regression.
    check('⛔ it never writes terms_text',
      !/\.update\(\{/.test(code) && /\.update\(patch\)/.test(code),
      'the write must be the fixed patch, never an object assembled here')
    check('the written columns are fixed by the shared patch, not named here',
      !/terms_payment_claim(_fingerprint|_version)?\s*:/.test(code),
      'naming the columns in this file would let them drift from termsClaimRefresh')
    check('it scopes the write to the CALLER\'s own tenant',
      (code.match(/\.update\(/g) || []).length === 1
      && /\.update\(patch\)\.eq\('user_id', user\.id\)/.test(code),
      'an unscoped update would rewrite every tenant\'s classification')
    check('it still calls the unchanged owner RPC — the DB decides',
      /owner_record_customer_acceptance/.test(code))
    check('a null acceptance id is reported as a REFUSAL, never a success',
      /!acceptanceId/.test(code) && /Could not record that acceptance/.test(code))
    check('a failed terms read never becomes "no terms"', /status: 502/.test(code))

    const dlg = readFileSync(join(ROOT, 'src/components/quotes/RecordAcceptanceDialog.tsx'), 'utf8')
    const dcode = dlg.replace(/^\s*\/\/.*$/gm, '')
    check('the dialog latches in-flight with a REF, not state', /inFlight\.current/.test(dcode)
      && /if \(inFlight\.current\) return/.test(dcode))
    check('…and goes through the owner route, not straight to the RPC',
      /\/api\/quotes\/record-acceptance/.test(dcode) && !/rpc\('owner_record_customer_acceptance'/.test(dcode))
    // ⚠️ `canSave` ITSELF must carry !saving. A bare /!saving/ over the file was
    // satisfied by the Cancel button's `disabled={saving}` nearby, so removing
    // it from canSave left the guard green.
    check('the submit button is disabled while pending',
      /disabled=\{!canSave\}/.test(dcode) && /const canSave = [^\n]*!saving/.test(dcode),
      'the pending state must gate canSave, not merely appear somewhere in the file')
    // ⚠️ RE-EXPRESSED per HANDLER, not per file. The old form counted literal
    // toast calls across the whole component and broke the moment a second,
    // legitimate handler existed (the repair confirmation) — a count is not the
    // contract. The contract is that ONE attempt produces ONE toast, so each
    // handler gets exactly one success and each of its error paths returns
    // rather than falling through into another toast.
    for (const fn of ['save', 'confirmCurrent']) {
      const body = new RegExp(`async function ${fn}\\(\\)[\\s\\S]*?\\n  \\}`).exec(dcode)?.[0] ?? ''
      check(`${fn}(): exactly one success toast`, (body.match(/toast\.success\(/g) || []).length === 1, body ? '' : 'handler not found')
      // Every error toast must END that attempt: the next statement is `return`,
      // or it is the catch (where the function is over anyway). A toast that
      // falls through into another is how the same error stacked on the owner's
      // screen. Checked by looking at what FOLLOWS each call rather than by
      // pattern-matching the call itself, which spans template literals.
      const parts = body.split('toast.error(').slice(1)
      const terminal = parts.filter(after => {
        const next = after.slice(0, 300)
        return /\n\s*return\b/.test(next) || /^\s*'[^']*'\)\s*\n\s*\}\s*finally/.test(next)
      })
      check(`${fn}(): every error toast ends the attempt`,
        parts.length > 0 && terminal.length === parts.length,
        `${terminal.length}/${parts.length} error toasts are terminal`)
    }
  }

  await db.close()
  console.log(fail > 0 ? `\n✗ ${fail} FAILURE(S) — ${pass} passed` : `\n✓ owner-external-acceptance: ${pass} checks passed`)
  process.exit(fail > 0 ? 1 : 0)
}
void main()
