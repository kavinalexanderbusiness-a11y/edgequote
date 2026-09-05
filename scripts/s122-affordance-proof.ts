// ── The Pay-deposit button must mean what the door means ─────────────────────
//   npx tsx scripts/s122-affordance-proof.ts
//
// The charge route has TWO acceptance gates: who is named on the acceptance, and
// whether that acceptance still matches the document. The portal mirrored the
// first and not the second — so on a drifted-but-evidenced quote the customer was
// offered a Pay button that the door answers 409.
//
// ⭐ So this compares the two ANSWERS rather than restating either. For each
// payload shape it asks the REAL route (over disposable PGlite, through the
// transport shim, with a fake payment adapter) and the REAL portal model, and
// requires them to agree.
//
// ⛔ Nothing is charged and no checkout is created: the payment adapter records
// what it was asked for and returns a stub URL. No production, no credential, no
// schema applied, no real record. Synthetic tenant, disposable database.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { splitStatements, loadPGlite, substitutePlatformStatements } from './lib/pg-sql'
import { makeSupabaseShim, type Q } from './lib/pg-supabase-shim'
import { buildPortalView, type PortalQuote, type PortalData } from '../src/app/portal/[token]/model'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, d?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; console.error(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
}
const ROOT = process.cwd()
const TENANT = '11111111-1111-4111-8111-111111111111'
const CUSTOMER = '22222222-2222-4222-8222-222222222222'
const TOKEN = 'zz-affordance-token'
const TERMS = 'We accept cash, cheque and e-transfer.'

/** Every checkout the route asked for. It must stay EMPTY except where allowed. */
const charged: { cents: number }[] = []

async function main() {
  const pg = await loadPGlite()
  if (!pg) { console.log('\n⏭  SKIPPED — PGlite not installed.\n'); process.exit(0) }
  const db = await pg.PGlite.create({ extensions: Object.fromEntries(Object.entries(pg.contribs).filter(([, v]) => v)) })
  const q: Q = (sql, p = []) => db.query(sql, p) as Promise<{ rows: Record<string, unknown>[] }>
  const apply = async (label: string, raw: string) => {
    const { sql } = substitutePlatformStatements(raw)
    for (const st of splitStatements(sql)) {
      try { await db.exec(st) } catch (e) { throw new Error(`${label}: ${(e as Error).message}`) }
    }
  }

  console.log('\n══ the button and the door ═════════════════════════════════════════\n')
  await apply('prelude', readFileSync(join(ROOT, 'scripts/schema/platform-prelude.sql'), 'utf8'))
  const baseline = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('_baseline.sql')).sort().pop()!
  await apply('baseline', readFileSync(join(ROOT, 'supabase/migrations', baseline), 'utf8'))
  try { await db.exec(`drop publication if exists supabase_realtime`) } catch { /* absent */ }

  await q(`insert into auth.users (id, email) values ($1,'zz-aff@example.invalid')`, [TENANT])
  await q(`insert into public.business_settings (user_id, company_name, owner_name, terms_text) values ($1,'ZZ Co','ZZ Owner',$2)`, [TENANT, TERMS])
  await q(`insert into public.customers (id, user_id, name) values ($1,$2,'ZZ Customer')`, [CUSTOMER, TENANT])
  await q(`insert into public.customer_portal_tokens (user_id, customer_id, token) values ($1,$2,$3)`, [TENANT, CUSTOMER, TOKEN])
  await q(`insert into public.platform_capabilities (user_id, online_payments) values ($1, true)`, [TENANT])
  {
    const { termsClaimRefresh } = await import('../src/lib/payments/termsClaimRefresh')
    const { patch } = termsClaimRefresh({ terms_text: TERMS, terms_payment_claim: null, terms_payment_claim_fingerprint: null, terms_payment_claim_version: null })
    await q(`update public.business_settings set terms_payment_claim=$2, terms_payment_claim_fingerprint=$3, terms_payment_claim_version=$4 where user_id=$1`,
      [TENANT, patch.terms_payment_claim, patch.terms_payment_claim_fingerprint, patch.terms_payment_claim_version])
  }

  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://shim.invalid'
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'zz-shim-key'
  const stub = (id: string, exports: Record<string, unknown>) => {
    const r = require.resolve(id)
    require.cache[r] = { id: r, filename: r, loaded: true, exports } as unknown as NodeModule
  }
  stub('@supabase/supabase-js', { createClient: () => makeSupabaseShim(q, { uid: null }) })
  stub('../src/lib/stripe/config', {
    stripeEnabled: () => true,
    // ⛔ Records the ask and returns a stub. No Stripe, no session, no charge.
    createQuoteDepositCheckoutSession: async (_q: unknown, o: { chargeCents: number }) => {
      charged.push({ cents: o.chargeCents }); return { ok: true, url: 'https://checkout.invalid/zz' }
    },
  })
  /* eslint-disable @typescript-eslint/no-require-imports */
  const route = require('../src/app/api/portal/quote-deposit/route') as { POST: (r: Request) => Promise<Response> }
  /* eslint-enable @typescript-eslint/no-require-imports */

  let seq = 0
  /** An accepted quote with a 50% rule, plus a customer acceptance in some state. */
  const makeQuote = async (o: { drift?: boolean }) => {
    seq++
    const id = `33333333-3333-4333-8333-${String(seq).padStart(12, '0')}`
    await q(`insert into public.quotes (id, user_id, customer_id, customer_name, quote_number, service_type,
               address, status, initial_price, travel_fee, deposit_type, deposit_value)
             values ($1,$2,$3,'ZZ Customer',$4,'ZZ Service','1 Test St','accepted',500,0,'percent',50)`,
      [id, TENANT, CUSTOMER, `ZZ-AF-${seq}`])
    await q(`select set_config('app.quote_consent_writer', $1, false)`, [id])
    await q(`update public.quotes set accepted_price=500 where id=$1`, [id])
    await q(`select set_config('app.quote_consent_writer', '', false)`)
    await q(`insert into public.quote_acceptances (user_id, quote_id, customer_id, accepted_at, kind, source,
               actor_type, actor_id, actor_label, accepted_amount, document, document_fingerprint, terms_required, terms_acknowledged)
             select $1,$2,$3, now(), 'customer','portal','customer',null,'ZZ Customer', 500,
               '{}'::jsonb, public.quote_material_fingerprint($2), false, false`, [TENANT, id, CUSTOMER])
    if (o.drift) {
      // ⭐ SAME-TOTAL drift: only the scope text moves, so the fingerprint changes
      // and `total` does not. Nothing here touches money.
      await q(`update public.quotes set service_type = 'ZZ Service (revised scope)' where id=$1`, [id])
    }
    return id
  }

  /** The DOOR's answer, from the real route. */
  const doorSaysPayable = async (id: string) => {
    const before = charged.length
    const res = await route.POST(new Request('http://zz.invalid/x', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, quoteId: id }),
    }))
    const body = await res.json() as Record<string, unknown>
    return { ok: res.status === 200, status: res.status, error: String(body.error ?? ''), charged: charged.length - before }
  }

  /** The BUTTON's answer, from the real portal model. */
  const rowFor = async (id: string, currentness: 'current' | 'stale' | 'unknown') => {
    const r = (await q(`select * from public.quotes where id=$1`, [id])).rows[0] as Record<string, unknown>
    const pq = {
      id, quote_number: String(r.quote_number), service_type: String(r.service_type), address: '1 Test St',
      property_id: null, total: Number(r.total), initial_price: Number(r.initial_price), subtotal: null,
      weekly_price: null, biweekly_price: null, monthly_price: null, notes: null,
      status: 'accepted', created_at: '2026-09-04', issued_date: '2026-09-04', valid_until: '2026-12-31',
      crew_size: 1, hours: 2, travel_fee: 0,
      accepted_price: r.accepted_price == null ? null : Number(r.accepted_price),
      acceptance_kind: 'customer',
      // The payload shapes: v2 projects the canonical answer; old C projects the
      // kind alone, which is the `unknown` case.
      ...(currentness === 'unknown' ? {} : { acceptance_is_current: currentness === 'current' }),
      deposit_type: 'percent', deposit_value: 50,
    } as unknown as PortalQuote
    const data = {
      customer: { id: CUSTOMER, name: 'ZZ Customer', email: null, phone: null, address: null, city: null },
      business: { gst_percent: 0 } as unknown as PortalData['business'],
      property: null, properties: [], quotes: [pq], invoices: [], jobs: [], recurrences: [], photos: [], payments: [],
    }
    const view = buildPortalView(data as never, '2026-09-04',
      { quote: async () => new Blob(), invoice: async () => new Blob() } as never)
    return view.docItems.find(d => d.kind === 'quote')!
  }

  console.log('■ 1. CURRENT acceptance — the button and the door both say yes')
  {
    const id = await makeQuote({})
    const door = await doorSaysPayable(id)
    const row = await rowFor(id, 'current')
    check('the door allows it', door.ok, `${door.status} ${door.error}`)
    check('…and the button is offered', row.schedulingDeposit?.payable === true)
    check('…at the same figure the door charged',
      door.charged === 1 && charged[charged.length - 1].cents === Math.round((row.schedulingDeposit?.outstanding ?? -1) * 100))
    check('…and no blocked line is shown', row.depositBlockedLine === undefined)
  }

  console.log('\n■ 2. STALE acceptance — same-total drift, only the fingerprint moved')
  {
    const id = await makeQuote({ drift: true })
    check('the acceptance is genuinely not current',
      (await q(`select public.quote_acceptance_is_current($1) c`, [id])).rows[0].c === false)
    const door = await doorSaysPayable(id)
    const row = await rowFor(id, 'stale')
    check('⛔ the door REFUSES it', !door.ok && door.status === 409, `${door.status} ${door.error}`)
    check('…and nothing was charged', door.charged === 0)
    check('⭐ …so the button must not be offered', row.schedulingDeposit?.payable === false,
      'this is the defect: the affordance used to mirror only the KIND gate')
    check('…and the customer is told the next step',
      !!row.depositBlockedLine && /confirm|revised/i.test(row.depositBlockedLine), row.depositBlockedLine)
    check('…while the deposit itself is still shown as owed',
      (row.schedulingDeposit?.required ?? 0) > 0)
  }

  console.log('\n■ 3. UNKNOWN currentness — an old-C payload')
  {
    const id = await makeQuote({})
    const door = await doorSaysPayable(id)
    const row = await rowFor(id, 'unknown')
    // ⚠️ The DOOR always knows: it asks the database directly, so it allows this
    // one. The PORTAL cannot check, and a button whose eligibility we cannot
    // establish is one we must not draw — the disagreement is deliberate and it
    // is in the safe direction (an affordance withheld, never a refusal charged).
    check('the door allows it, because the door can always check', door.ok, `${door.status} ${door.error}`)
    check('⭐ …and the button is withheld anyway, because the PORTAL cannot',
      row.schedulingDeposit?.payable === false)
    check('…with a next step rather than silence',
      !!row.depositBlockedLine && /confirm/i.test(row.depositBlockedLine), row.depositBlockedLine)
  }

  console.log('\n■ 4. The two answers agree wherever the portal can check')
  {
    for (const [label, drift, currentness] of [
      ['current', false, 'current'], ['stale', true, 'stale'],
    ] as [string, boolean, 'current' | 'stale'][]) {
      const id = await makeQuote({ drift })
      const door = await doorSaysPayable(id)
      const row = await rowFor(id, currentness)
      check(`${label} · button ${row.schedulingDeposit?.payable ? 'offered' : 'withheld'} matches door ${door.ok ? 'allow' : 'refuse'}`,
        (row.schedulingDeposit?.payable === true) === door.ok)
    }
  }

  console.log('\n■ 5. Nothing was charged that should not have been')
  check('⛔ exactly the allowed checkouts were asked for, and no others',
    charged.length === 3, `${charged.length} checkout ask(s) — expected 3 (the two CURRENT cases and the UNKNOWN one the door allows)`)

  console.log('\n■ 6. ⭐⭐ THE CARD ITSELF — a withheld ask may not name a figure')
  {
    // Rendered through the SHIPPING BillingTab, because the finding was about
    // what the card SAYS, and a model assertion is not a card.
    const React = (await import('react')).default
    ;(globalThis as unknown as { React: typeof React }).React = React
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { BillingTab } = await import('../src/app/portal/[token]/components/BillingTab')

    const actions = new Proxy(
      { paymentsEnabled: true, paymentPending: false, payingQuoteId: null, accepting: null, payingId: null, decidingChangeId: null, token: TOKEN } as Record<string, unknown>,
      { get: (t, k) => (k in t ? t[k as string] : () => {}) },
    ) as never

    /** One card, rendered from the real model, in a named acceptance state. */
    const card = (over: Record<string, unknown>, payments: Record<string, unknown>[] = []) => {
      const pq = {
        id: 'zz1', quote_number: 'ZZ-CARD', service_type: 'ZZ Service', address: '1 Test St',
        property_id: null, total: 500, initial_price: 500, subtotal: null,
        weekly_price: null, biweekly_price: null, monthly_price: null, notes: null,
        status: 'accepted', created_at: '2026-09-04', issued_date: '2026-09-04',
        valid_until: '2026-12-31', crew_size: 1, hours: 2, travel_fee: 0,
        accepted_price: 1400, acceptance_kind: 'customer',
        deposit_type: 'percent', deposit_value: 50, ...over,
      }
      const data = {
        customer: { id: CUSTOMER, name: 'ZZ Customer', email: null, phone: null, address: null, city: null },
        business: { gst_percent: 0 }, property: null, properties: [],
        quotes: [pq], invoices: [], jobs: [], recurrences: [], photos: [], payments,
      }
      const view = buildPortalView(data as never, '2026-09-04',
        { quote: async () => new Blob(), invoice: async () => new Blob() } as never)
      const row = view.docItems.find(d => d.kind === 'quote')!
      const html = renderToStaticMarkup(React.createElement(BillingTab, { view, actions }))
      const text = html.replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')
      return { row, text }
    }
    /**
     * A recorded cash deposit against the quote — the ledger fact `collected` reads.
     * ⚠️ `kind: 'payment'` and `status: 'paid'` are not decoration: `isCashRow`
     * counts exactly that shape, and my first attempt used 'deposit'/'succeeded'
     * and silently collected nothing — a fixture that proves the absence of a
     * figure by failing to create one proves nothing at all.
     */
    const cash = (amount: number) => [{
      id: 'p1', amount, status: 'paid', paid_at: '2026-09-04', provider: 'manual',
      invoice_id: null, quote_id: 'zz1', created_at: '2026-09-04', kind: 'payment',
    } as Record<string, unknown>]

    // ── CURRENT · unchanged, and the control that keeps the rest honest ───────
    {
      const { row, text } = card({ acceptance_is_current: true })
      check('current · the card still names the ask', /\$700\.00 deposit to secure scheduling/.test(text), text.slice(0, 240))
      check('current · …and the Pay button is offered', row.schedulingDeposit?.payable === true && /Pay \$700\.00 deposit/.test(text))
      check('current · …and the demand is marked settled', row.schedulingDeposit?.demandSettled === true)
    }

    // ── STALE · the finding ──────────────────────────────────────────────────
    {
      const { row, text } = card({ acceptance_is_current: false })
      check('⭐ stale · NO figure is named anywhere on the card',
        !/700/.test(text) && !/\$350/.test(text), text.slice(0, 300))
      check('⛔ stale · …and none was re-derived from the current total',
        !/\$250\.00/.test(text))
      check('stale · the rule survives — the card still says a deposit secures scheduling',
        /Deposit to secure scheduling/.test(text))
      check('stale · …and the next step is there',
        /agree the deposit with you before anything is due/.test(text), row.depositBlockedLine)
      check('stale · no Pay button', !/Pay \$/.test(text))
      check('stale · the demand is marked unsettled', row.schedulingDeposit?.demandSettled === false)
      check('stale · ⛔ and the timing line, which states the figure in words, is gone',
        row.depositTimingLine === undefined && !/secures your booking/.test(text))
    }

    // ── STALE + PARTIALLY COLLECTED · money that arrived must not vanish ──────
    {
      const { row, text } = card({ acceptance_is_current: false }, cash(200))
      check('⭐ stale+partial · the collected $200.00 is STILL shown',
        /\$200\.00 received/.test(text), text.slice(0, 320))
      check('…and says where it sits, rather than implying it vanished',
        /stays on your account/.test(text))
      check('⛔ stale+partial · but not "of $700" nor "$500 still required"',
        !/700/.test(text) && !/still required/.test(text))
      check('stale+partial · the ledger figure is intact in the model',
        row.schedulingDeposit?.collected === 200)
    }

    // ── UNKNOWN + PARTIALLY COLLECTED ────────────────────────────────────────
    {
      const { row, text } = card({}, cash(200))   // kind present, currentness absent
      check('⭐ unknown · no ask figure', !/700/.test(text) && !/still required/.test(text))
      check('unknown · the collected money is still shown', /\$200\.00 received/.test(text))
      check('unknown · …and it does not claim a revision',
        !/revised since/.test(text) && /still being confirmed/.test(text), row.depositBlockedLine)
      check('unknown · demand unsettled', row.schedulingDeposit?.demandSettled === false)
    }

    // ── ZERO OUTSTANDING · a settled deposit says nothing about being due ─────
    {
      const { row, text } = card({ acceptance_is_current: false }, cash(700))
      check('zero outstanding · the gate is satisfied', row.schedulingDeposit?.satisfied === true)
      check('⭐ …so the whole ask card is gone, on a stale quote too',
        !/deposit to secure scheduling/i.test(text) && !/before anything is due/.test(text),
        text.slice(0, 240))
      check('…and the receipt line still says the money is held as credit',
        /Deposit received/.test(text) && /\$700\.00/.test(text))
    }
  }

  await db.close()
  console.log(fail > 0 ? `\n✗ ${fail} FAILURE(S) — ${pass} passed` : `\n✓ affordance: ${pass} checks passed`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()
