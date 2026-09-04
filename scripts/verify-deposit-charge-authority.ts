// ── Verify: only an actor-named acceptance may authorize taking money ────────
//   npm run verify:deposit-charge-authority
//
// THE DEFECT THIS CLOSES (Defect 4, ruled FIX FIRST by an independent review).
// The portal card, the timing sentence and the customer's PDF priced an
// unevidenced quote off `total`; the charge route priced the SAME quote off the
// raw `accepted_price`. A customer could read "$250 deposit", tap Pay, and meet a
// different figure at the checkout.
//
// ⛔ Both obvious fixes were wrong, and the review rejected each:
//   · charging the sanitized total takes money for a version nobody confirmed;
//   · showing the backfilled `accepted_amount` puts an uncorroborated number on
//     the card AS AGREED — the legacy backfill wrote
//     `accepted_amount = coalesce(accepted_price, total)`, so it copied the claim
//     rather than corroborating it.
//
// ⭐ The ruling: fix the GATE, not the surfaces. A kind too weak to say "you
// accepted" is too weak to take money. That removes the only kind on which
// display and charge could disagree, so the remaining states agree by
// construction rather than by two derivations happening to match.
//
// ⭐⭐ AND IT MUST NOT TRAP ANYONE. Withholding the charge is only honest if the
// owner can actually clear it, so §F drives the whole upgrade chain — the real
// owner route, the real confirmation route, the real RPC, the real canonical
// writer — and then charges the repaired quote.
//
// ⛔ No Stripe network, no production data, no real customer, no message. The
// payment adapter is a fake that records what it was asked to charge; the
// database is disposable in-memory PGlite on a synthetic tenant.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { splitStatements, loadPGlite, substitutePlatformStatements } from './lib/pg-sql'
import { makeSupabaseShim, type Q } from './lib/pg-supabase-shim'
import { buildDocItems, type PortalQuote, type PortalData } from '../src/app/portal/[token]/model'
import {
  acceptedPresentation, customerFacingQuote, depositChargeBlock,
  ACTOR_NAMED_ACCEPTANCE_KINDS, type AcceptanceKind,
} from '../src/lib/quoteAcceptance'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, d?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; console.error(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
}

const ROOT = process.cwd()
const TENANT = '11111111-1111-4111-8111-111111111111'
const CUSTOMER = '22222222-2222-4222-8222-222222222222'
const TOKEN = 'zz-charge-authority-token'
const TERMS = 'We accept cash, cheque and e-transfer. Please give 24 hours notice to cancel.'

// ── The fake payment adapter ─────────────────────────────────────────────────
// It records the ask instead of reaching Stripe. ⚠️ Its capture list is also the
// proof that the fake is INSTALLED: a case that expects a charge asserts the
// recording, so a shim that silently failed to take effect cannot pass as "no
// charge happened".
const charged: { cents: number; label: string }[] = []

// ── ⛔ AMBIENT-CONTAMINATION PROBE ───────────────────────────────────────────
// Deliberately poisons the three env vars BEFORE main() installs its synthetic
// values, so the override is tested against a HOSTILE starting state rather than
// an empty one. If that override ever regresses to `||=`, these values survive
// and §J fails loudly — instead of the run quietly pointing at whatever the
// environment held.
//
// ⭐ Clobbering here is also the safe direction: whatever a developer happened to
// have exported, this guard is now guaranteed not to be holding it.
const AMBIENT = {
  url: 'https://zz-ambient-contaminant.invalid',
  key: 'zz-ambient-service-key-must-not-survive',
  app: 'https://zz-ambient-app.invalid',
} as const
process.env.NEXT_PUBLIC_SUPABASE_URL = AMBIENT.url
process.env.SUPABASE_SERVICE_ROLE_KEY = AMBIENT.key
process.env.NEXT_PUBLIC_APP_URL = AMBIENT.app

/** Proof the Supabase fake is INSTALLED, mirroring what `charged` does for Stripe. */
const SHIM_SENTINEL = 'zz-supabase-shim-installed'

async function main() {
  const pg = await loadPGlite()
  if (!pg) { console.log('\n⏭  verify:deposit-charge-authority SKIPPED — PGlite not installed.\n'); process.exit(0) }
  const db = await pg.PGlite.create({ extensions: Object.fromEntries(Object.entries(pg.contribs).filter(([, v]) => v)) })
  const q: Q = (sql, p = []) => db.query(sql, p) as Promise<{ rows: Record<string, unknown>[] }>
  const apply = async (label: string, raw: string) => {
    const { sql } = substitutePlatformStatements(raw)
    for (const st of splitStatements(sql)) {
      try { await db.exec(st) } catch (e) { throw new Error(`${label}: ${(e as Error).message}`) }
    }
  }

  console.log('\n══ only a named acceptance may authorize a charge ══════════════════\n')
  await apply('prelude', readFileSync(join(ROOT, 'scripts/schema/platform-prelude.sql'), 'utf8'))
  const baseline = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('_baseline.sql')).sort().pop()!
  await apply('baseline', readFileSync(join(ROOT, 'supabase/migrations', baseline), 'utf8'))
  await apply('S122D', readFileSync(join(ROOT, 'supabase/proposals/RUN-S122D-owner-confirm-current-acceptance.sql'), 'utf8'))
  await apply('S122E', readFileSync(join(ROOT, 'supabase/proposals/RUN-S122E-recorded-version-must-match.sql'), 'utf8'))
  try { await db.exec(`drop publication if exists supabase_realtime`) } catch { /* absent */ }

  await q(`insert into auth.users (id, email) values ($1,'zz-charge@example.invalid')`, [TENANT])
  await q(`insert into public.business_settings (user_id, company_name, owner_name, terms_text) values ($1,'ZZ Charge Co','ZZ Owner',$2)`, [TENANT, TERMS])
  await q(`insert into public.customers (id, user_id, name) values ($1,$2,'ZZ Charge Customer')`, [CUSTOMER, TENANT])
  await q(`insert into public.customer_portal_tokens (user_id, customer_id, token) values ($1,$2,$3)`, [TENANT, CUSTOMER, TOKEN])
  await q(`insert into public.platform_capabilities (user_id, online_payments) values ($1, true)`, [TENANT])
  // The terms verdict the S122 gate requires, written the way the app writes it.
  {
    const { termsClaimRefresh } = await import('../src/lib/payments/termsClaimRefresh')
    const { patch } = termsClaimRefresh({ terms_text: TERMS, terms_payment_claim: null, terms_payment_claim_fingerprint: null, terms_payment_claim_version: null })
    await q(`update public.business_settings set terms_payment_claim=$2, terms_payment_claim_fingerprint=$3, terms_payment_claim_version=$4 where user_id=$1`,
      [TENANT, patch.terms_payment_claim, patch.terms_payment_claim_fingerprint, patch.terms_payment_claim_version])
  }

  // ── Install the fakes BEFORE the routes are loaded ─────────────────────────
  // Transport and payment only. Nothing that decides anything.
  // ⛔ PLAIN `=`, NEVER `||=`. With `||=` an ambient real URL and service-role key
  // SURVIVED into the run — and if a stub then silently failed to install, the
  // queries would have gone wherever that env pointed. This guard has no use for
  // an ambient value, so it takes none. The probe at module scope proves the
  // assignment is unconditional rather than merely looking unconditional.
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://shim.invalid'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'zz-shim-service-key'
  process.env.NEXT_PUBLIC_APP_URL = 'https://zz.invalid'
  let shimUid: string | null = null
  let failTable: string | null = null
  // ⭐ Counted, so "the stub was installed" is provable the same way the Stripe
  // fake proves it: by evidence it was actually USED, not by its presence.
  let shimBuilt = 0
  const shim = () => { shimBuilt++; return makeSupabaseShim(q, { uid: shimUid, failOn: t => t === failTable }) }

  const stub = (id: string, exports: Record<string, unknown>) => {
    const resolved = require.resolve(id)
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as unknown as NodeModule
    return resolved
  }
  // ⭐⭐ Each fake carries a sentinel, so §J can prove the cache entry the routes
  // resolve IS ours. Without it, a stub that silently failed to take effect would
  // hand the routes the REAL client pointed at whatever env held — the exact
  // failure the Stripe fake is already protected against and this one was not.
  const supaResolved = stub('@supabase/supabase-js', { createClient: () => shim(), __zzShim: SHIM_SENTINEL })
  const serverResolved = stub('../src/lib/supabase/server', { createClient: async () => shim(), __zzShim: SHIM_SENTINEL })
  stub('../src/lib/stripe/config', {
    stripeEnabled: () => true,
    createQuoteDepositCheckoutSession: async (_q: unknown, o: { chargeCents: number; chargeLabel: string }) => {
      charged.push({ cents: o.chargeCents, label: o.chargeLabel })
      return { ok: true, url: 'https://checkout.invalid/zz-session' }
    },
  })

  /* eslint-disable @typescript-eslint/no-require-imports */
  const depositRoute = require('../src/app/api/portal/quote-deposit/route') as
    { POST: (r: Request) => Promise<Response> }
  const recordRoute = require('../src/app/api/quotes/record-acceptance/route') as
    { POST: (r: Request) => Promise<Response> }
  const confirmRoute = require('../src/app/api/quotes/confirm-current-acceptance/route') as
    { POST: (r: Request) => Promise<Response> }
  /* eslint-enable @typescript-eslint/no-require-imports */

  const post = async (h: { POST: (r: Request) => Promise<Response> }, body: unknown) => {
    const res = await h.POST(new Request('http://zz.invalid/x', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }))
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  const payDeposit = (quoteId: string) => post(depositRoute, { token: TOKEN, quoteId })

  let seq = 0
  /** A quote with a deposit rule, in whichever evidence state the case needs. */
  const makeQuote = async (o: { price?: number; stale?: number | null; status?: string; optionPrice?: number } = {}) => {
    seq++
    const id = `33333333-3333-4333-8333-${String(seq).padStart(12, '0')}`
    await q(`insert into public.quotes (id, user_id, customer_id, customer_name, quote_number, service_type,
               address, status, initial_price, travel_fee, deposit_type, deposit_value)
             values ($1,$2,$3,'ZZ Charge Customer',$4,'ZZ Service','1 Test St',$5,$6,0,'percent',50)`,
      [id, TENANT, CUSTOMER, `ZZ-CA-${seq}`, o.status ?? 'accepted', o.price ?? 500])
    if (o.stale != null) {
      await q(`select set_config('app.quote_consent_writer', $1, false)`, [id])
      await q(`update public.quotes set accepted_price=$2 where id=$1`, [id, o.stale])
      await q(`select set_config('app.quote_consent_writer', '', false)`)
    }
    return id
  }
  /** The backfill's own shape, welded shut by quote_acceptances_on_behalf_shape_check. */
  const addLegacyRow = async (id: string) => {
    await q(`insert into public.quote_acceptances (user_id, quote_id, customer_id, accepted_at, kind, source,
               actor_type, actor_id, actor_label, accepted_amount, document, document_fingerprint,
               terms_required, terms_acknowledged)
             select $1,$2,$3, now(), 'legacy_unrecorded','migration','system', null,
               'Recorded before EdgeHQ kept acceptance evidence',
               round(coalesce(q.accepted_price, q.total, 0)::numeric, 2),
               jsonb_build_object('backfilled', true), public.quote_material_fingerprint($2), false, false
               from public.quotes q where q.id = $2`, [TENANT, id, CUSTOMER])
  }
  const kindOf = async (id: string) => ((await q(
    `select kind from public.quote_acceptances where quote_id=$1 order by seq desc limit 1`, [id])).rows[0] as { kind: string } | undefined)?.kind ?? null
  const rowCount = async (id: string) => Number(((await q(
    `select count(*)::int n from public.quote_acceptances where quote_id=$1`, [id])).rows[0] as { n: number }).n)

  // ── The portal's own card, from the REAL model ─────────────────────────────
  const business = { gst_percent: 0 } as unknown as PortalData['business']
  const renderers = { quote: async () => new Blob(), invoice: async () => new Blob() }
  const card = async (id: string, kind: AcceptanceKind | null | undefined) => {
    const r = (await q(`select * from public.quotes where id=$1`, [id])).rows[0] as Record<string, unknown>
    const pq = {
      id, quote_number: String(r.quote_number), service_type: 'ZZ Service', address: '1 Test St',
      property_id: null, total: Number(r.total), initial_price: Number(r.initial_price), subtotal: null,
      weekly_price: null, biweekly_price: null, monthly_price: null, notes: null,
      status: String(r.status), created_at: '2026-09-04', issued_date: '2026-09-04',
      valid_until: '2026-12-31', crew_size: 1, hours: 2, travel_fee: 0,
      accepted_price: r.accepted_price == null ? null : Number(r.accepted_price),
      acceptance_kind: kind ?? null,
      deposit_type: 'percent', deposit_value: 50,
    } as unknown as PortalQuote
    return buildDocItems({ quotes: [pq], invoices: [], properties: [], business, todayISO: '2026-09-04', renderers })[0]
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('■ A. The rule, stated once and shared by every surface')
  {
    const kinds: AcceptanceKind[] = ['customer', 'owner_on_behalf', 'legacy_unrecorded']
    for (const k of kinds) {
      const named = ACTOR_NAMED_ACCEPTANCE_KINDS.includes(k)
      const blocked = depositChargeBlock(acceptedPresentation('accepted', k)) !== null
      check(`A · ${k}: named-in-the-list and may-charge agree`, named === !blocked, `named=${named} blocked=${blocked}`)
    }
    check('A · no evidence may not charge', depositChargeBlock(acceptedPresentation('accepted', null)) === 'no_evidence')
    check('A · an UNREADABLE evidence answer may not charge either',
      depositChargeBlock(acceptedPresentation('accepted', undefined)) === 'no_evidence')
    check('A · a legacy row is refused for its own reason, not lumped in',
      depositChargeBlock(acceptedPresentation('accepted', 'legacy_unrecorded')) === 'unknown_provenance')
    check('A · an un-accepted quote has nothing to secure',
      depositChargeBlock(acceptedPresentation('sent', undefined)) === 'not_accepted')
  }

  console.log('\n■ B. The live Defect-4 shape — legacy row, moved price, deposit rule')
  {
    const id = await makeQuote({ price: 500, stale: 1400 })
    await addLegacyRow(id)
    check('B · the fence that used to be relied on still passes this quote',
      (await q(`select public.quote_acceptance_is_current($1) c`, [id])).rows[0].c === true,
      'quote_acceptance_is_current never looks at the kind — that is why the kind must be looked at here')

    const before = charged.length
    const r = await payDeposit(id)
    check('B · ⛔ the charge is REFUSED', r.status === 409, JSON.stringify(r.body))
    check('B ·   …for the honest reason', /before we started keeping acceptance records/.test(String(r.body.error)), String(r.body.error))
    check('B ·   …and NOTHING was sent to the payment adapter', charged.length === before)

    const d = await card(id, 'legacy_unrecorded')
    check('B · the customer sees no Pay button', d.schedulingDeposit?.payable === false)
    check('B ·   …and is told why, in the same words the door uses',
      d.depositBlockedLine === String(r.body.error), `${d.depositBlockedLine}\n      vs ${r.body.error}`)
    check('B ·   …the ask itself is NOT cancelled — scheduling still waits on it',
      (d.schedulingDeposit?.required ?? 0) === 250)
    check('B · ⛔ and $700 — the raw snapshot basis — reaches no surface',
      !JSON.stringify(d).includes('700'))
  }

  console.log('\n■ C. Status alone, with no row at all')
  {
    const id = await makeQuote({ price: 500, stale: 1400 })
    const before = charged.length
    const r = await payDeposit(id)
    check('C · ⛔ refused', r.status === 409)
    check('C ·   …naming the missing record, not the provenance',
      /don.t have a record of your acceptance/.test(String(r.body.error)), String(r.body.error))
    check('C ·   …nothing charged', charged.length === before)
  }

  console.log('\n■ D. A read that FAILED is not permission')
  {
    const id = await makeQuote({ price: 500 })
    await q(`insert into public.quote_acceptances (user_id, quote_id, customer_id, accepted_at, kind, source,
               actor_type, actor_id, actor_label, accepted_amount, document, document_fingerprint, terms_required, terms_acknowledged)
             select $1,$2,$3, now(), 'customer','portal','customer',null,'ZZ Charge Customer', 500,
               '{}'::jsonb, public.quote_material_fingerprint($2), false, false`, [TENANT, id, CUSTOMER])
    failTable = 'quote_acceptances'
    const before = charged.length
    const r = await payDeposit(id)
    failTable = null
    check('D · ⛔ an unreadable acceptance table refuses the charge', r.status !== 200, JSON.stringify(r.body))
    check('D ·   …and charges nothing', charged.length === before)
    // ⭐⭐ AND IT SAYS THE RIGHT UNTRUE-FREE THING. Failing closed is not enough on
    // its own: if the read error is swallowed, the customer still gets refused —
    // but with "we don't have a record of your acceptance on file", which is a
    // confident claim about their record made from a dropped connection. This
    // customer HAS a recorded acceptance. A transport failure must be reported as
    // one, or the refusal accuses the record of something the database never said.
    check('D ·   …reported as a transport failure, not as a verdict on their record',
      r.status === 502, `status ${r.status}: ${JSON.stringify(r.body)}`)
    check('D ·   …and never claims their acceptance is missing',
      !/record of your acceptance/.test(String(r.body.error)), String(r.body.error))
  }

  console.log('\n■ E. With a NAMED acceptance the charge proceeds — at the DISPLAYED figure')
  {
    for (const kind of ['customer', 'owner_on_behalf'] as const) {
      const id = await makeQuote({ price: 500, stale: 500 })
      if (kind === 'customer') {
        await q(`insert into public.quote_acceptances (user_id, quote_id, customer_id, accepted_at, kind, source,
                   actor_type, actor_id, actor_label, accepted_amount, document, document_fingerprint, terms_required, terms_acknowledged)
                 select $1,$2,$3, now(), 'customer','portal','customer',null,'ZZ Charge Customer', 500,
                   '{}'::jsonb, public.quote_material_fingerprint($2), false, false`, [TENANT, id, CUSTOMER])
      } else {
        await q(`insert into public.quote_acceptances (user_id, quote_id, customer_id, accepted_at, kind, source,
                   actor_type, actor_id, actor_label, on_behalf_reason, accepted_amount, document, document_fingerprint, terms_required, terms_acknowledged)
                 select $1,$2,$3, now(), 'owner_on_behalf','dashboard','owner',$1,'ZZ Owner','text_message', 500,
                   '{}'::jsonb, public.quote_material_fingerprint($2), false, false`, [TENANT, id, CUSTOMER])
      }
      const before = charged.length
      const r = await payDeposit(id)
      check(`E · ${kind}: the charge is allowed`, r.status === 200, JSON.stringify(r.body))
      check(`E ·   …the adapter was actually asked (so the fake is installed)`, charged.length === before + 1)
      const d = await card(id, kind)
      check(`E ·   …and the amount charged is the amount DISPLAYED`,
        charged[charged.length - 1]?.cents === Math.round((d.schedulingDeposit?.outstanding ?? -1) * 100),
        `charged=${charged[charged.length - 1]?.cents} displayed=${d.schedulingDeposit?.outstanding}`)
      check(`E ·   …and the portal offers the button`, d.schedulingDeposit?.payable === true)
    }
  }

  console.log('\n■ F. ⭐⭐ THE WAY OUT — a legacy quote is upgraded, then charged')
  {
    const id = await makeQuote({ price: 500, stale: 500 })
    await addLegacyRow(id)
    shimUid = TENANT

    // F1 · the ordinary owner action, through the REAL route.
    const rec = await post(recordRoute, { quoteId: id, reason: 'text_message', note: 'Customer texted yes.' })
    check('F1 · the ordinary record action offers the repair instead of a dead end',
      rec.body.repairRequired === true, JSON.stringify(rec.body))
    check('F1 ·   …and names the shape correctly: nothing CHANGED, nobody is NAMED',
      rec.body.repairKind === 'unnamed', String(rec.body.repairKind))
    check('F1 ·   …the sentence does not claim the quote changed',
      !/changed after acceptance was marked/.test(String(rec.body.error)), String(rec.body.error))
    check('F1 ·   …and it hands back the fingerprint of the version being confirmed',
      typeof rec.body.currentFingerprint === 'string' && String(rec.body.currentFingerprint).length === 32)

    // F2 · the explicit attestation, through the REAL route → RPC → canonical writer.
    const conf = await post(confirmRoute, {
      quoteId: id, reason: 'text_message', note: 'Customer confirmed by text on 4 Sep.',
      expectedFingerprint: String(rec.body.currentFingerprint), expectedAmount: Number(rec.body.currentAmount),
    })
    check('F2 · ⭐ the attestation is accepted — the owner is NOT trapped',
      conf.status === 200 && conf.body.ok === true, JSON.stringify(conf.body))
    check('F2 ·   …the standing evidence now NAMES an actor', (await kindOf(id)) === 'owner_on_behalf')
    check('F2 ·   …the legacy row is superseded, never deleted', (await rowCount(id)) === 2)
    {
      const rows = (await q(`select kind, seq, supersedes_id from public.quote_acceptances where quote_id=$1 order by seq`, [id])).rows as { kind: string; seq: number; supersedes_id: string | null }[]
      check('F2 ·   …and the new row points back at the one it replaces',
        rows[0].kind === 'legacy_unrecorded' && rows[1].supersedes_id != null,
        JSON.stringify(rows))
    }

    // F3 · and NOW the money may be taken.
    const before = charged.length
    const r = await payDeposit(id)
    check('F3 · ⭐ the deposit can now be charged', r.status === 200, JSON.stringify(r.body))
    check('F3 ·   …the adapter was asked exactly once', charged.length === before + 1)
    const d = await card(id, 'owner_on_behalf')
    check('F3 ·   …at the figure the portal now shows',
      charged[charged.length - 1]?.cents === Math.round((d.schedulingDeposit?.outstanding ?? -1) * 100))
    check('F3 ·   …and the portal offers the button again', d.schedulingDeposit?.payable === true)

    // F4 · replay is still idempotent after the upgrade.
    const again = await post(confirmRoute, {
      quoteId: id, reason: 'text_message', note: 'Customer confirmed by text on 4 Sep.',
      expectedFingerprint: String(rec.body.currentFingerprint), expectedAmount: Number(rec.body.currentAmount),
    })
    check('F4 · a replay is idempotent, not a third row',
      again.body.ok === true && again.body.idempotent === true, JSON.stringify(again.body))
    check('F4 ·   …still exactly two rows', (await rowCount(id)) === 2)
    shimUid = null
  }

  console.log('\n■ G. The upgrade is narrow — it does not overwrite a real acceptance')
  {
    const id = await makeQuote({ price: 500, stale: 500 })
    await q(`insert into public.quote_acceptances (user_id, quote_id, customer_id, accepted_at, kind, source,
               actor_type, actor_id, actor_label, accepted_amount, document, document_fingerprint, terms_required, terms_acknowledged)
             select $1,$2,$3, now(), 'customer','portal','customer',null,'ZZ Charge Customer', 500,
               '{}'::jsonb, public.quote_material_fingerprint($2), false, false`, [TENANT, id, CUSTOMER])
    shimUid = TENANT
    const fp = String(((await q(`select public.quote_material_fingerprint($1) f`, [id])).rows[0] as { f: string }).f)
    const conf = await post(confirmRoute, {
      quoteId: id, reason: 'text_message', note: 'Trying to overwrite a real acceptance.',
      expectedFingerprint: fp, expectedAmount: 500,
    })
    check('G · ⛔ a CUSTOMER acceptance is never superseded by an attestation',
      conf.body.ok !== true && conf.body.reason === 'evidence_exists', JSON.stringify(conf.body))
    check('G ·   …and the customer’s row still stands alone', (await rowCount(id)) === 1 && (await kindOf(id)) === 'customer')
    shimUid = null
  }

  console.log('\n■ H. The owner-sent PDF and the owner’s banner read the same rule')
  {
    const page = readFileSync(join(ROOT, 'src/app/dashboard/quotes/[id]/page.tsx'), 'utf8')
    check('H · the downloaded PDF is rendered from the shared basis, not the raw row',
      /renderQuoteBlob\(facing\.moneyQuote,/.test(page) && !/renderQuoteBlob\(quote,/.test(page),
      'this file is the one the owner sends — the caller gates "mark sent" on it')
    check('H ·   …and a FAILED acceptance read goes in as unknown, not as "none"',
      /acceptanceLoaded \? \(acceptance\?\.accepted \? acceptance\.kind : null\) : undefined/.test(page))
    check('H · the owner is told why the deposit link is off',
      /depositChargeBlockedOwnerNote\(chargeBlock\)/.test(page))
    check('H ·   …instead of being told the customer can pay from their portal',
      /chargeBlock\s*\n?\s*\?\s*depositChargeBlockedOwnerNote/.test(page.replace(/\r/g, '')))
    // The basis rule itself, executed rather than grepped.
    const raw = { status: 'accepted', total: 500, accepted_price: 1400, deposit_type: 'percent', deposit_value: 50 }
    const unnamed = customerFacingQuote(acceptedPresentation('accepted', 'legacy_unrecorded'), raw)
    check('H · an unnamed acceptance strips the snapshot before the PDF sees it',
      unnamed.moneyQuote.accepted_price === null)
    const named = customerFacingQuote(acceptedPresentation('accepted', 'customer'), raw)
    check('H ·   …and a named one keeps it', named.moneyQuote.accepted_price === 1400)
  }

  console.log('\n■ I. The customer’s headline action never points at a shut door')
  {
    const { primaryPortalAction } = await import('../src/app/portal/[token]/model')
    const model = readFileSync(join(ROOT, 'src/app/portal/[token]/model.ts'), 'utf8')
    check('I · the ranked action requires payable, in the predicate itself',
      /d\.schedulingDeposit\?\.payable && !d\.schedulingDeposit\.satisfied/.test(model))
    const id = await makeQuote({ price: 500, stale: 1400 })
    await addLegacyRow(id)
    const d = await card(id, 'legacy_unrecorded')
    const action = primaryPortalAction([d], { due: 0, overdue: 0, paid: 0 } as never, [])
    check('I ·   …so a blocked quote never becomes "Pay deposit"',
      action?.kind !== 'pay-deposit', JSON.stringify(action))
    const bill = readFileSync(join(ROOT, 'src/app/portal/[token]/components/BillingTab.tsx'), 'utf8')
    check('I · Billing renders the reason in place of the button',
      /!d\.schedulingDeposit\.payable \?/.test(bill) && /d\.depositBlockedLine/.test(bill))
  }

  // ── J · THE HARNESS ITSELF ────────────────────────────────────────────────
  // A synthetic guard is only evidence if its fakes are genuinely in place. These
  // check the harness, not the product: every case above ran against them.
  {
    console.log('\n── J · the harness is synthetic, provably ─────────────────────────\n')

    // ⛔ Ambient values must not survive. The probe set all three to contaminants
    // before main() ran; if the override regressed to `||=`, these fail.
    check('J · the Supabase URL is the synthetic one, not the ambient value',
      process.env.NEXT_PUBLIC_SUPABASE_URL === 'http://shim.invalid', process.env.NEXT_PUBLIC_SUPABASE_URL)
    check('J · the service-role key is the synthetic one',
      process.env.SUPABASE_SERVICE_ROLE_KEY === 'zz-shim-service-key')
    check('J · the app URL is the synthetic one',
      process.env.NEXT_PUBLIC_APP_URL === 'https://zz.invalid')
    check('J · ⛔ no contaminant survived anywhere in the three',
      ![process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.NEXT_PUBLIC_APP_URL]
        .some(v => v === AMBIENT.url || v === AMBIENT.key || v === AMBIENT.app))

    // [negative control] the operator that used to be here would have kept it.
    const probe: Record<string, string> = { X: AMBIENT.url }
    probe.X ||= 'http://shim.invalid'
    check('J · [negative control] `||=` would have kept the ambient value',
      probe.X === AMBIENT.url)

    // ⛔ The module the routes resolve must BE the fake.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const cached = (id: string) => (require.cache[id]?.exports ?? {}) as { __zzShim?: string }
    /* eslint-enable @typescript-eslint/no-require-imports */
    check('J · the @supabase/supabase-js cache entry is the fake',
      cached(supaResolved).__zzShim === SHIM_SENTINEL)
    check('J · the src/lib/supabase/server cache entry is the fake',
      cached(serverResolved).__zzShim === SHIM_SENTINEL)

    // [negative control] a module nobody stubbed carries no sentinel, so the
    // assertion above is discriminating rather than always-true.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const unstubbed = require.resolve('./lib/pg-supabase-shim')
    /* eslint-enable @typescript-eslint/no-require-imports */
    check('J · [negative control] an unstubbed module carries no sentinel',
      cached(unstubbed).__zzShim !== SHIM_SENTINEL)

    // ⛔⛔ FAIL LOUD: presence is not use. Every route above went through the fake.
    check('J · the shim was actually constructed by the routes under test',
      shimBuilt > 0, `shimBuilt=${shimBuilt}`)
    check('J · …and the Stripe fake likewise recorded real asks',
      charged.length > 0, `charged=${charged.length}`)
  }

  await db.close()
  console.log(fail > 0 ? `\n✗ ${fail} FAILURE(S) — ${pass} passed` : `\n✓ deposit-charge-authority: ${pass} checks passed`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()
