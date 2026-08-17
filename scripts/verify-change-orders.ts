// ── Verify: change orders — added scope is authorised, never assumed ─────────
//   npm run verify:change-orders
//
// WHY THIS SCRIPT EXISTS
// A change order exists so that new work agreed AFTER an approval never rewrites
// the approval. Every way that can go wrong is money or trust, and the brief
// names five of them:
//
//   1. the original accepted quote gets overwritten
//   2. an unapproved change is counted in the authorized value
//   3. a declined change is invoiced
//   4. cross-tenant access
//   5. a duplicate approval
//
// Each is asserted here — the pure half against the REAL engine
// (lib/changeOrders.authorizedValue), the live half against the REAL database in
// an isolated fixture tenant, because most of these defences are DB constraints
// and RLS rather than app code, and a guard that only reads TypeScript would
// have proved nothing about them.
//
// THE CANONICAL MODEL (do not relitigate):
//   • a change order owns SCOPE + PRICE + APPROVAL STATE + TIMESTAMPS
//   • approval — and ONLY approval — mints the job_line_items row that bills
//     (trg_change_order_apply_approval), so "pending is not billable" is a fact
//     about what exists, not about a filter somebody remembered to write
//   • authorized = original + Σ approved   ·   pending is NEVER inside it
//   • quotes are READ by all of this and written by none of it

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  authorizedValue, canTransition, isSettled, isCustomerVisible, changeOrderSendRequest,
  CHANGE_ORDER_STATUSES, type ChangeOrder,
} from '../src/lib/changeOrders'
import { buildInvoiceLineItems } from '../src/lib/invoicing'
import { openFixtureTenant, isSkipped, fixtureResidue } from './lib/verify-fixture'
// THE schema source (Session 41): the generated baseline in supabase/migrations/,
// produced from the live catalogue. ⛔ Never supabase/schema.sql or the retired
// CANONICAL-get_portal_data.sql — both are under supabase/archive/ and applying
// either would roll production backward.
import { baselineSql, portalDataSql } from './lib/schema-source'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
// Strip comments BEFORE any absence assertion — a comment saying "never do X"
// must not satisfy a check about doing X. CRLF-safe: `.` does not match \r, so a
// CRLF checkout otherwise disarms every `.*$` stripper.
const stripComments = (s: string) => s.replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/([^:'"])\/\/[^\n]*/g, '$1')

const co = (status: string, amount: number) => ({ status, amount }) as Pick<ChangeOrder, 'status' | 'amount'>

// The brief's worked example, used throughout: $5,500 approved, +$575 asked.
const ORIGINAL = 5500
const CHANGE = 575

console.log('\n■ 1. The five named regressions (each must FAIL if reintroduced)')
{
  // 1a. AN UNAPPROVED CHANGE IS NOT AUTHORIZED VALUE. The single most damaging
  //     misreading of this feature: work nobody agreed to, counted as agreed.
  const pending = authorizedValue({ originalValue: ORIGINAL, changeOrders: [co('pending', CHANGE)] })
  eq('a pending change leaves the authorized value at the original', pending.authorized, ORIGINAL)
  eq('…and is reported separately as pending', pending.pending, CHANGE)
  eq('…and adds nothing to what will be billed', pending.billable, ORIGINAL)

  // 1b. A DECLINED CHANGE IS NOT MONEY EITHER — in the engine, and (below) in
  //     the invoice, because no line item was ever minted for it.
  const declined = authorizedValue({ originalValue: ORIGINAL, changeOrders: [co('declined', CHANGE)] })
  eq('a declined change adds nothing to the authorized value', declined.authorized, ORIGINAL)
  eq('…and nothing to the billable total', declined.billable, ORIGINAL)
  const withdrawn = authorizedValue({ originalValue: ORIGINAL, changeOrders: [co('cancelled', CHANGE)] })
  eq('a withdrawn change adds nothing', withdrawn.authorized, ORIGINAL)
  const draft = authorizedValue({ originalValue: ORIGINAL, changeOrders: [co('draft', CHANGE)] })
  eq('an unsent draft adds nothing', draft.authorized, ORIGINAL)

  // 1c. AN APPROVED CHANGE IS ADDED, NOT SUBSTITUTED. The original stays visible
  //     as its own figure — that IS the feature.
  const approved = authorizedValue({ originalValue: ORIGINAL, changeOrders: [co('approved', CHANGE)] })
  eq('the original is preserved beside the change', approved.original, ORIGINAL)
  eq('the approved change is its own figure', approved.approvedChanges, CHANGE)
  eq('authorized = original + approved changes', approved.authorized, ORIGINAL + CHANGE)

  // 1d. NO DOUBLE COUNTING. An approved change's money exists twice in the data
  //     — as the change order AND as the line item it minted — so a caller that
  //     passes both must still get one figure. Every owner surface does exactly
  //     this (it hands the engine the visit's whole job_line_items list).
  const both = authorizedValue({
    originalValue: ORIGINAL,
    changeOrders: [co('approved', CHANGE)],
    lineItems: [{ amount: CHANGE, change_order_id: 'the-change-order' }],
  })
  eq('an approved change is counted once, not twice', both.authorized, ORIGINAL + CHANGE)
  eq('…and its line item is not double-counted as an owner extra', both.extras, 0)
  eq('…so the billable total is right', both.billable, ORIGINAL + CHANGE)

  // 1e. OWNER EXTRAS STAY SEPARATE. The pre-existing add-on flow bills without
  //     asking anybody; folding it into "authorized" would claim consent that
  //     was never given.
  const mixed = authorizedValue({
    originalValue: ORIGINAL,
    changeOrders: [co('approved', CHANGE), co('pending', 200)],
    lineItems: [{ amount: CHANGE, change_order_id: 'x' }, { amount: 80, change_order_id: null }],
  })
  eq('an owner-added extra is not "authorized"', mixed.authorized, ORIGINAL + CHANGE)
  eq('…but it IS billable', mixed.billable, ORIGINAL + CHANGE + 80)
  eq('…and the pending ask stays outside both', mixed.pending, 200)
}

console.log('\n■ 2. The lifecycle can only be walked forwards')
{
  eq('draft may be sent', canTransition('draft', 'pending'), true)
  eq('draft may be withdrawn', canTransition('draft', 'cancelled'), true)
  eq('pending may be approved', canTransition('pending', 'approved'), true)
  eq('pending may be declined', canTransition('pending', 'declined'), true)
  eq('a draft may NOT jump straight to approved', canTransition('draft', 'approved'), false)
  eq('an approved change may not be re-approved', canTransition('approved', 'approved'), false)
  eq('an approved change may not be withdrawn', canTransition('approved', 'cancelled'), false)
  eq('a declined change may not be approved later', canTransition('declined', 'approved'), false)
  check('approved / declined / cancelled are terminal',
    isSettled('approved') && isSettled('declined') && isSettled('cancelled'))
  check('draft and pending are not', !isSettled('draft') && !isSettled('pending'))
  eq('a draft is never customer-visible', isCustomerVisible('draft'), false)
  check('every other status is', CHANGE_ORDER_STATUSES.filter(s => s !== 'draft').every(isCustomerVisible))
}

console.log('\n■ 3. One engine, one money path (structural)')
{
  const lib = stripComments(read('src/lib/changeOrders.ts'))
  const panel = stripComments(read('src/components/schedule/JobChangeOrders.tsx'))
  const portalModel = stripComments(read('src/app/portal/[token]/model.ts'))
  const dayOps = stripComments(read('src/components/schedule/DayOpsPanel.tsx'))
  const page = stripComments(read('src/app/dashboard/schedule/page.tsx'))

  check('lib/changeOrders never writes to quotes',
    !/from\(['"]quotes['"]\)/.test(lib), 'a change order must never rewrite the approval it changes')
  check('lib/changeOrders never writes job_line_items',
    !/from\(['"]job_line_items['"]\)\s*\.\s*(insert|update|delete)/.test(lib),
    'the approval trigger is the ONE writer of change-order money')
  check('the owner panel computes no money of its own',
    /authorizedValue\(/.test(panel) && !/reduce\(/.test(panel),
    'JobChangeOrders must render the engine\'s figures, never its own arithmetic')
  check('the portal derives its figures from the SAME engine',
    /from '@\/lib\/changeOrders'/.test(portalModel) && /authorizedValue\(/.test(portalModel),
    'the customer and the owner must not compute the total two ways')
  check('the job card asks the engine for the breakdown',
    /authorizedValue\(/.test(dayOps), 'DayOpsPanel must not re-derive original/approved/pending')
  check('the owner records a decision as their own, never as the portal',
    /recordOwnerDecision/.test(page) && /decided_via: 'owner'/.test(stripComments(read('src/lib/changeOrders.ts'))),
    'an owner-entered approval must never be stored as a customer tap')
  check('the send path is shared by the first ask and the reminder',
    (stripComments(read('src/app/dashboard/schedule/page.tsx')).match(/changeOrderSendRequest\(/g) || []).length === 1,
    'one request builder — otherwise "ask again" can describe the change differently')

  // The add-on editor must not offer to bin customer-approved money.
  check('the add-on editor is handed only the owner\'s own extras',
    /items=\{ownerExtras\}/.test(dayOps) && /addons\.filter\(a => !a\.change_order_id\)/.test(dayOps),
    'a change-order line item must not appear in the add-on trash')

  // Vocabulary: "Services" and "Changes" are different doors and must stay so.
  check('the two doors are named differently on the job card',
    /label=\{ownerExtras\.length \? `Services/.test(dayOps) && /Changes \(\$\{av\.pendingCount\} waiting\)|Changes \(/.test(dayOps),
    'creation doors are never merged by label')
}

console.log('\n■ 4. The LIVE SCHEMA states the guarantees (read from the generated baseline)')
{
  // ⭐ THE SCHEMA IS READ FROM THE GENERATED BASELINE (scripts/lib/schema-source),
  // which is produced FROM the live catalogue. So these assertions are about what
  // the database actually runs — not about what a hand-written migration file
  // claimed on the day it was applied. The old RUN-*.sql apply path is retired and
  // lives under supabase/archive/, where nothing reads it and nothing applies it.
  const sql = baselineSql()
  const has = (name: string, re: RegExp) => check(name, re.test(sql), 'missing from the live schema')
  has('a partial unique index makes a second approval impossible',
    /create unique index[^\n]*job_line_items_change_order_uniq[^\n]*WHERE \(change_order_id IS NOT NULL\)/i)
  has('the job link is a COMPOSITE fk (tenancy is a DB fact)',
    /"change_orders_job_same_owner" FOREIGN KEY \(job_id, user_id\) REFERENCES jobs\(id, user_id\)/)
  has('so is the customer link (a stray customer_id would reach a stranger\'s portal)',
    /"change_orders_customer_same_owner" FOREIGN KEY \(user_id, customer_id\) REFERENCES customers\(user_id, id\)/)
  has('status and timestamps can never disagree', /change_orders_status_stamps/)
  has('a decision must say how it was taken', /change_orders_decided_via_present/)
  has('scope and price freeze once sent', /fixed once it is sent for approval/)
  has('a decided change order freezes whole (provenance included)',
    /is a record of what was answered and cannot be edited/)
  has('the portal door is pending-only', /and status = 'pending'/)
  has('…and it is the ONE door — no second responder exists',
    (sql.match(/FUNCTION public\.portal_respond_change_order/g) || []).length === 1
      ? /portal_respond_change_order/ : /\bthis-can-never-match\b/)
  has('the portal door is row-scoped, not just token-scoped', /and customer_id = v_customer/)
  has('a change-order line item cannot be deleted by a client',
    /for delete[\s\S]{0,120}?\(\(auth\.uid\(\) = user_id\) AND \(change_order_id IS NULL\)\)/)
  has('…nor forged by one', /for insert[\s\S]{0,120}?\(\(auth\.uid\(\) = user_id\) AND \(change_order_id IS NULL\)\)/)
  check('change_orders has no DELETE policy (cancel is how one goes away)',
    !/create policy "change_orders: delete/.test(sql))
  // ⭐⭐ THE PROJECTION ITSELF, read out of the ONE definition of get_portal_data.
  // This is what the earlier "the migration edited it correctly" check was really
  // trying to say, and it survives the migration file being retired — on
  // 2026-08-14 the hand-maintained canonical copy was missing this key while
  // production had been serving it for hours, and running that file would have
  // deleted it from the live portal.
  const portal = portalDataSql()
  check('get_portal_data projects change_orders', /'change_orders', coalesce/.test(portal),
    'the customer cannot see, or answer, what is not serialized')
  check('…and withholds DRAFTS (a privacy predicate, not a preference)',
    /from public\.change_orders where customer_id = v_customer and user_id = v_user and status <> 'draft'/.test(portal),
    'a draft is the owner\'s unfinished ask — a price nobody has decided to charge')
  check('…scoped to the token\'s customer, like every other projection',
    !/from public\.change_orders(?![^\n]*customer_id = v_customer)/.test(portal))
}

console.log('\n■ 5. The customer is told the truth in the message')
{
  const templates = read('src/lib/comms/templates.ts')
  check('there is a change_order template', /change_order: 'Approve extra work'/.test(templates))
  check('it is filed under estimates, not invoices',
    /case 'change_order': return 'estimates'/.test(templates.replace(/\s+/g, ' ').replace(/case 'quote': case 'estimate_reminder': case 'estimate_followup': case 'change_order': return 'estimates'/, "case 'change_order': return 'estimates'")),
    'a change order is a quote for extra work — nothing is owed until they agree')
  check('the ask says the original does not change',
    /does not change|doesn't change|in addition to/.test(templates))

  // The one request builder produces a body that names the scope AND the price.
  const req = changeOrderSendRequest({
    co: { id: 'co1', co_number: 'CO-0001', description: 'Replace two gate posts', amount: CHANGE, customer_id: 'c1', job_id: 'j1' },
    originalTotal: ORIGINAL, attempt: 0,
    body: p => `${p.description}|${p.amount}|${p.originalTotal}`,
    money: n => `$${n.toFixed(2)}`,
  })
  eq('the ask names the scope and the price', req.bodyOverride, `Replace two gate posts|$${CHANGE.toFixed(2)}|$${ORIGINAL.toFixed(2)}`)
  eq('…and rides the change_order template', req.template, 'change_order')
  const again = changeOrderSendRequest({
    co: { id: 'co1', co_number: 'CO-0001', description: 'x', amount: 1, customer_id: 'c1', job_id: 'j1' },
    originalTotal: null, attempt: 7, body: () => 'b', money: n => `$${n}`,
  })
  check('a reminder is a NEW send, not a deduped retry',
    req.clientMessageId !== again.clientMessageId, 'the same key would silently drop the reminder')
}

// ─────────────────────────────────────────────────────────────────────────────
// THE LIVE HALF. Most of this feature's defences are constraints, triggers and
// RLS — things TypeScript cannot be read for. These run against the real
// database in a marked fixture tenant (never the owner's book).
// ─────────────────────────────────────────────────────────────────────────────
async function live() {
  const t = await openFixtureTenant('verify:change-orders')
  if (isSkipped(t)) {
    console.log(`\n■ 6. Live enforcement — SKIPPED (${t.skipped})`)
    return
  }
  const jobIds: string[] = []
  try {
    console.log('\n■ 6. Live enforcement (fixture tenant — never the owner\'s book)')
    const cust = await t.fixtureCustomer()

    // The original approval. Everything below reads it; nothing may write it.
    const { data: quote, error: qErr } = await t.db.from('quotes').insert({
      user_id: t.uid, customer_id: cust.id, quote_number: t.tag('CO-QUOTE'),
      customer_name: t.tag('CUSTOMER'), service_type: 'Fence repair',
      address: 'Verification fixture — not a real address',
      initial_price: ORIGINAL, status: 'accepted', accepted_price: ORIGINAL,
    }).select('*').single()
    if (qErr || !quote) throw new Error(`fixture quote: ${qErr?.message}`)
    const before = quote as Record<string, unknown>

    const { data: job, error: jErr } = await t.db.from('jobs').insert({
      user_id: t.uid, customer_id: cust.id, quote_id: before.id as string,
      title: t.tag('JOB'), service_type: 'Fence repair', scheduled_date: '2026-08-20',
      price: ORIGINAL, status: 'scheduled',
    }).select('id').single()
    if (jErr || !job) throw new Error(`fixture job: ${jErr?.message}`)
    const jobId = (job as { id: string }).id
    jobIds.push(jobId)

    const mk = async (description: string, amount: number) => {
      const { data, error } = await t.db.from('change_orders').insert({
        user_id: t.uid, job_id: jobId, customer_id: cust.id, quote_id: before.id as string,
        description, amount, service_key: 'change_order', status: 'draft',
      }).select('*').single()
      if (error || !data) throw new Error(`change order insert: ${error?.message}`)
      return data as ChangeOrder
    }
    const linesFor = async (id: string) => {
      const { data } = await t.db.from('job_line_items').select('*').eq('change_order_id', id)
      return (data as { id: string; amount: number }[] | null) || []
    }

    // ── The numbering is minted by the DB, and it is unique ──────────────────
    const a = await mk('Replace two gate posts', CHANGE)
    check('the database assigns the CO number', /^CO-\d{4}$/.test(a.co_number), `got ${a.co_number}`)
    const dupNum = await t.db.from('change_orders').insert({
      user_id: t.uid, job_id: jobId, customer_id: cust.id, co_number: a.co_number,
      description: 'a clashing number', amount: 10, status: 'draft',
    })
    check('a duplicate CO number is refused', !!dupNum.error,
      'two changes sharing one customer-facing reference')

    // ── 2. AN UNAPPROVED CHANGE MINTS NO MONEY ───────────────────────────────
    eq('a draft change has no billable line', (await linesFor(a.id)).length, 0)
    const sent = await t.db.from('change_orders').update({ status: 'pending' }).eq('id', a.id).select('*').single()
    check('sending stamps sent_at server-side', !!(sent.data as ChangeOrder | null)?.sent_at)
    eq('a PENDING change still has no billable line', (await linesFor(a.id)).length, 0)

    // Scope and price are frozen the moment it leaves draft.
    const reprice = await t.db.from('change_orders').update({ amount: 5000 }).eq('id', a.id)
    check('a sent change cannot be re-priced', !!reprice.error,
      'the figure the customer is looking at must be the figure on file')

    // ── 5. DUPLICATE APPROVAL ────────────────────────────────────────────────
    const first = await t.db.from('change_orders')
      .update({ status: 'approved', decided_via: 'owner' }).eq('id', a.id).eq('status', 'pending').select('*').single()
    check('approval succeeds once', !first.error && (first.data as ChangeOrder).status === 'approved', first.error?.message ?? '')
    eq('approval minted exactly one billable line', (await linesFor(a.id)).length, 1)

    const second = await t.db.from('change_orders')
      .update({ status: 'approved', decided_via: 'owner' }).eq('id', a.id).eq('status', 'pending').select('*')
    eq('a second approval matches no row', ((second.data as unknown[] | null) || []).length, 0)
    eq('…and mints no second line', (await linesFor(a.id)).length, 1)

    // ⭐ THE REGRESSION THIS GUARD CAUGHT. Re-stating "approved" on an approved
    // row used to SUCCEED and rewrite decided_via — turning an owner-entered
    // approval into "the customer tapped it" on every screen that shows it
    // afterwards. A decided change order is now frozen whole.
    const reApprove = await t.db.from('change_orders').update({ status: 'approved', decided_via: 'portal' }).eq('id', a.id)
    check('a decided change order cannot be rewritten', !!reApprove.error,
      'an owner-recorded approval could be laundered into a customer tap')
    eq('re-stating "approved" mints no second line', (await linesFor(a.id)).length, 1)
    const relabel = await t.db.from('change_orders').update({ description: 'something else entirely' }).eq('id', a.id)
    check('…nor re-described after the fact', !!relabel.error,
      'the words the customer agreed to must be the words on file')
    const unApprove = await t.db.from('change_orders').update({ status: 'cancelled' }).eq('id', a.id)
    check('an approved change cannot be withdrawn', !!unApprove.error, 'approval is the customer\'s, not ours to undo')

    // A client cannot forge or bin change-order money directly.
    const forged = await t.db.from('job_line_items').insert({
      user_id: t.uid, job_id: jobId, description: 'forged', amount: 999, change_order_id: a.id,
    })
    check('a client cannot hand-write a change-order line', !!forged.error)
    await t.db.from('job_line_items').delete().eq('change_order_id', a.id)
    eq('…nor delete one (RLS matches no row)', (await linesFor(a.id)).length, 1)

    // ── 3. A DECLINED CHANGE IS NEVER INVOICED ───────────────────────────────
    const b = await mk('Rebuild the whole fence', 4000)
    await t.db.from('change_orders').update({ status: 'pending' }).eq('id', b.id)
    await t.db.from('change_orders').update({ status: 'declined', decided_via: 'owner' }).eq('id', b.id)
    eq('a declined change has no billable line', (await linesFor(b.id)).length, 0)

    // …proved through the REAL invoice engine, over the REAL rows.
    const { data: addonRows } = await t.db.from('job_line_items')
      .select('description, amount, change_order_id').eq('job_id', jobId)
    const addons = (addonRows as { description: string; amount: number }[] | null) || []
    const built = buildInvoiceLineItems({
      serviceType: 'Fence repair', baseAmount: ORIGINAL, freq: null, isInitial: false, addons, quote: before,
    })
    check('the invoice includes the approved change',
      built.lineItems.some(l => l.description === 'Replace two gate posts' && l.amount === CHANGE),
      JSON.stringify(built.lineItems))
    check('the invoice does NOT include the declined change',
      !built.lineItems.some(l => l.description === 'Rebuild the whole fence'),
      JSON.stringify(built.lineItems))
    eq('the invoice totals original + approved only', built.total, ORIGINAL + CHANGE)

    // ── 1. THE ORIGINAL APPROVAL IS UNTOUCHED ────────────────────────────────
    const { data: after } = await t.db.from('quotes').select('*').eq('id', before.id as string).single()
    const aft = after as Record<string, unknown>
    for (const col of ['status', 'total', 'initial_price', 'accepted_price', 'subtotal']) {
      eq(`quotes.${col} is unchanged by any of this`, String(aft?.[col]), String(before[col]))
    }

    // ── 4. CROSS-TENANT ──────────────────────────────────────────────────────
    const stranger = randomUUID()
    const otherTenant = await t.db.from('change_orders').insert({
      user_id: stranger, job_id: jobId, customer_id: cust.id, description: 'not mine', amount: 5, status: 'draft',
    })
    check('a change order cannot be written for another business', !!otherTenant.error)
    const otherCustomer = await t.db.from('change_orders').insert({
      user_id: t.uid, job_id: jobId, customer_id: stranger, description: 'wrong customer', amount: 5, status: 'draft',
    })
    check('a change order cannot name a customer this business does not own', !!otherCustomer.error,
      'this is how an approval request lands in a stranger\'s portal')
    const c = await mk('Extra coat of paint', 300)
    const moved = await t.db.from('change_orders').update({ customer_id: stranger }).eq('id', c.id)
    check('a change order cannot be moved to another customer', !!moved.error)

    // ── The customer's own door ──────────────────────────────────────────────
    if (!cust.token) {
      fail('the fixture customer has a portal token', 'no token — the portal half could not run')
    } else {
      await t.db.from('change_orders').update({ status: 'pending' }).eq('id', c.id)

      const bogus = await t.anon.rpc('portal_respond_change_order', {
        p_token: 'not-a-real-token', p_change_order_id: c.id, p_decision: 'approve',
      })
      eq('a bogus token is refused', (bogus.data as { reason?: string } | null)?.reason, 'no_access')

      const notMine = await t.anon.rpc('portal_respond_change_order', {
        p_token: cust.token, p_change_order_id: randomUUID(), p_decision: 'approve',
      })
      eq('a valid token cannot answer for a change order that is not theirs',
        (notMine.data as { reason?: string } | null)?.reason, 'not_pending')

      const badDecision = await t.anon.rpc('portal_respond_change_order', {
        p_token: cust.token, p_change_order_id: c.id, p_decision: 'maybe',
      })
      eq('only approve/decline are decisions', (badDecision.data as { reason?: string } | null)?.reason, 'bad_decision')

      const answered = await t.anon.rpc('portal_respond_change_order', {
        p_token: cust.token, p_change_order_id: c.id, p_decision: 'approve',
      })
      const res = answered.data as { ok?: boolean; status?: string } | null
      check('the customer can approve from their portal', !!res?.ok && res.status === 'approved',
        JSON.stringify(answered.data ?? answered.error))
      eq('…which mints exactly one billable line', (await linesFor(c.id)).length, 1)

      const twice = await t.anon.rpc('portal_respond_change_order', {
        p_token: cust.token, p_change_order_id: c.id, p_decision: 'approve',
      })
      eq('a second tap is refused, not double-approved', (twice.data as { reason?: string } | null)?.reason, 'not_pending')
      eq('…and mints no second line', (await linesFor(c.id)).length, 1)

      const { data: decided } = await t.db.from('change_orders').select('decided_via').eq('id', c.id).single()
      eq('a portal approval is recorded as the customer\'s own', (decided as { decided_via: string } | null)?.decided_via, 'portal')
      const { data: ownerDecided } = await t.db.from('change_orders').select('decided_via').eq('id', a.id).single()
      eq('an owner-recorded approval is NOT', (ownerDecided as { decided_via: string } | null)?.decided_via, 'owner')

      // The owner hears about the customer's decision — and only theirs.
      const { data: notes } = await t.db.from('notifications').select('type, entity_id').eq('user_id', t.uid)
      const list = (notes as { type: string; entity_id: string | null }[] | null) || []
      check('a portal decision notifies the owner',
        list.some(n => n.type === 'change_order_approved' && n.entity_id === jobId), JSON.stringify(list))
      eq('an owner-recorded decision does not notify them about their own typing',
        list.filter(n => n.type === 'change_order_approved').length, 1)

      // The customer's payload carries the decided ones and withholds drafts.
      const draftOnly = await mk('A change nobody has sent', 42)
      const { data: payload } = await t.anon.rpc('get_portal_data', { p_token: cust.token })
      const rows = ((payload as { change_orders?: { id: string; status: string }[] } | null)?.change_orders) || []
      check('the portal payload carries the customer\'s change orders',
        rows.some(r => r.id === a.id) && rows.some(r => r.id === c.id), JSON.stringify(rows))
      check('…and withholds the unsent draft',
        !rows.some(r => r.id === draftOnly.id), 'a draft is the owner\'s unfinished ask')
    }
  } catch (e) {
    fail('the live half completed', e instanceof Error ? e.message : String(e))
  } finally {
    // Jobs are not in the harness's sweep (change orders and line items cascade
    // from them), so this guard removes what it made.
    if (jobIds.length) await t.db.from('jobs').delete().in('id', jobIds)
    await t.close()
    const residue = await fixtureResidue(t)
    const left = Object.entries(residue).filter(([, n]) => n !== 0)
    check('the fixture tenant is left clean', left.length === 0, JSON.stringify(residue))
  }
}

live().then(() => {
  console.log(failures === 0
    ? '\n✅ change orders: added scope is authorised, never assumed\n'
    : `\n❌ ${failures} check${failures === 1 ? '' : 's'} failed\n`)
  process.exit(failures === 0 ? 0 : 1)
})
