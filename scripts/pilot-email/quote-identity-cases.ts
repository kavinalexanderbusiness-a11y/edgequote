import assert from 'node:assert/strict'
import type { Database, TestResult } from './database'
import type { EnsureInput } from '../../src/lib/customers'
import { buildPilotQuoteIdentityPlan, createPilotQuoteIdentityStore, savePilotQuoteIdentityRequest } from '../../src/lib/quotes/pilotQuoteIdentity'
import { identityRows, identityRpc, identitySupabase, identityValue, seedQuoteIdentity, type IdentityFixture } from './quote-identity-fixtures'

type Plan = Awaited<ReturnType<typeof buildPilotQuoteIdentityPlan>>
const newInput = (tag: number): EnsureInput => ({ customerId: '__manual', name: `New identity ${tag}`,
  address: '999 Brand New Road', email: `new-${tag}@fixture.example.invalid`, phone: '4035550109', source: 'referral' })
const selected = (f: IdentityFixture, address = '900 Changed Road'): EnsureInput => ({ customerId: f.target, name: 'Ignored typed alias', address })
const original = (f: IdentityFixture): EnsureInput => ({ customerId: f.customer, name: 'Ignored stale name', address: '100 Original Road' })

export async function runQuoteIdentityCases(db: Database): Promise<TestResult[]> {
  const results: TestResult[] = [], store = createPilotQuoteIdentityStore(identitySupabase(db))
  let tag = 100
  const test = async (name: string, work: (tag: number) => Promise<void>) => {
    await db.exec('begin isolation level read committed')
    try { await work(++tag); results.push({ name, pass: true }) }
    catch (error) { results.push({ name, pass: false, error: error instanceof Error ? error.message.slice(0, 1600) : 'Identity assertion failed' }) }
    finally { await db.exec('rollback') }
  }
  const snapshot = (f: IdentityFixture) => store.snapshot(f.owner, f.quote)
  const plan = async (f: IdentityFixture, input: EnsureInput) => buildPilotQuoteIdentityPlan(await snapshot(f), input)
  const save = (f: IdentityFixture, p: Plan) => identityRpc(db, 'pilot_quote_identity_save', { p_owner: f.owner, p_quote: f.quote, p_plan: p })
  const request = (f: IdentityFixture, revision: unknown, input: EnsureInput, extra: Record<string, unknown> = {}) => new Request('https://fixture.example.invalid/identity', {
    method: 'POST', headers: { origin: 'https://fixture.example.invalid', 'content-type': 'application/json' },
    body: JSON.stringify({ quoteId: f.quote, expectedQuoteRevision: revision, input, ...extra }),
  })
  const auth = (owner: string) => ({ getUser: async () => ({ data: { user: { id: owner } }, error: null }) })
  const protectContent = (before: Record<string, unknown>, after: Record<string, unknown>) => {
    const omit = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([k]) => !['customer_id', 'customer_name', 'property_id', 'address', 'updated_at'].includes(k)))
    assert.deepEqual(omit(after), omit(before), 'Identity save must preserve all financial, status, note and acceptance fields')
  }

  await test('identity: actual helper plans new and matched records without any native business writes', async n => {
    const f = await seedQuoteIdentity(db, n), before = await identityRows(db, f.owner)
    const created = await plan(f, newInput(n))
    assert.equal(created.resolved.created_customer, true); assert.equal(created.resolved.created_property, true)
    assert.ok(created.customer_insert); assert.ok(created.property_insert)
    const enriched = await plan(f, { ...newInput(n), email: `${f.target}@fixture.example.invalid` })
    assert.equal(enriched.resolved.customer_id, f.target); assert.equal(enriched.resolved.matched_by, 'email')
    assert.ok(enriched.customer_patch); assert.equal(enriched.customer_insert, null)
    assert.deepEqual(await identityRows(db, f.owner), before)
  })
  for (const history of ['approved', 'held', 'completed'] as const) {
    await test(`identity: ${history} retained quote refuses explicit and manual reassignment with zero residual rows`, async n => {
      const f = await seedQuoteIdentity(db, n, true)
      const wid = await identityValue(db, 'select id as value from public.pilot_quote_followup_workflows where quote_id=$1::uuid', [f.quote])
      if (history === 'held') assert.equal((await identityRpc(db, 'pilot_email_hold_workflow', { p_workflow: wid, p_reason: 'owner_paused' })).code, 'held')
      if (history === 'completed') {
        const claimed = await identityRpc(db, 'pilot_email_claim', { p_workflow: wid, p_step: 1 })
        assert.equal(claimed.code, 'claimed')
        const args = { p_attempt: claimed.attempt_id, p_fence: claimed.fence }
        assert.equal((await identityRpc(db, 'pilot_email_start', args)).code, 'started')
        assert.equal((await identityRpc(db, 'pilot_email_confirm', { ...args, p_provider_email_id: `identity-history-${n}` })).code, 'confirmed')
        assert.equal((await identityRpc(db, 'pilot_email_finalize', args)).code, 'finalized')
      }
      for (const input of [selected(f), newInput(n), { ...newInput(n), email: `${f.target}@fixture.example.invalid` }]) {
        const before = await identityRows(db, f.owner)
        assert.equal((await save(f, await plan(f, input))).code, 'retained_customer_binding')
        assert.deepEqual(await identityRows(db, f.owner), before)
      }
    })
  }
  for (const child of ['services', 'options'] as const) {
  await test(`identity: retained same-customer preserve/property change keep populated ${child}/addons and all protected quote/history fields`, async n => {
    const f = await seedQuoteIdentity(db, n, true, child), before = await identityRows(db, f.owner)
    assert.equal(before['quote_' + child].length, 1); assert.equal(before.quote_addons.length, 1)
    const unchanged = await plan(f, original(f))
    assert.equal(unchanged.preserve, true)
    assert.equal((await save(f, unchanged)).code, 'unchanged')
    assert.deepEqual(await identityRows(db, f.owner), before)
    const changed = await save(f, await plan(f, { ...original(f), address: '800 Same Customer Road' }))
    assert.equal(changed.code, 'saved'); assert.equal(changed.customer_id, f.customer); assert.equal(changed.created_property, true)
    const after = await identityRows(db, f.owner)
    assert.equal(after.properties.length, before.properties.length + 1)
    protectContent(before.quotes[0], after.quotes[0])
    for (const table of ['quote_services', 'quote_options', 'quote_addons', 'pilot_quote_followup_workflows', 'pilot_email_send_attempts']) assert.deepEqual(after[table], before[table])
  })
  }
  await test('identity: unretained new customer/property save commits together and stale retry cannot duplicate them', async n => {
    const f = await seedQuoteIdentity(db, n), before = await identityRows(db, f.owner), p = await plan(f, newInput(n))
    const saved = await save(f, p); assert.equal(saved.code, 'saved')
    assert.equal(saved.created_customer, true); assert.equal(saved.created_property, true)
    const after = await identityRows(db, f.owner)
    assert.equal(after.customers.length, before.customers.length + 1); assert.equal(after.properties.length, before.properties.length + 1)
    assert.equal(after.quotes[0].customer_id, saved.customer_id); assert.equal(after.quotes[0].property_id, saved.property_id)
    protectContent(before.quotes[0], after.quotes[0])
    assert.equal((await save(f, p)).code, 'stale_quote'); assert.deepEqual(await identityRows(db, f.owner), after)
  })
  await test('identity: canonical helper preserves phone/email/name and blank-source resolution behavior', async n => {
    const f = await seedQuoteIdentity(db, n)
    await db.query('update public.customers set phone=$2,acquisition_source=$3 where id=$1::uuid', [f.target, '+1 (403) 555-0199', '\u00a0\t '])
    const matched = await plan(f, { ...newInput(n), phone: '4035550199', email: `${f.target}@fixture.example.invalid`, address: '200 Existing Road' })
    assert.equal(matched.resolved.customer_id, f.target); assert.equal(matched.resolved.matched_by, 'phone')
    assert.equal(matched.resolved.property_id, f.targetProperty); assert.equal(matched.resolved.created_property, false)
    assert.deepEqual(matched.customer_patch, { acquisition_source: 'referral' })
    assert.equal((await save(f, matched)).code, 'saved')
    assert.equal(await identityValue(db, 'select acquisition_source as value from public.customers where id=$1::uuid', [f.target]), 'referral')
    const email = await plan(f, { ...newInput(n), phone: '', email: `  ${f.target.toUpperCase()}@FIXTURE.EXAMPLE.INVALID  `, source: 'website' })
    assert.equal(email.resolved.customer_id, f.target); assert.equal(email.resolved.matched_by, 'email')
    assert.equal(email.customer_patch, null, 'A populated acquisition source must not be replaced')
    const nameOnly = await plan(f, { customerId: '__manual', name: 'Target Customer', address: '' })
    assert.equal(nameOnly.resolved.created_customer, true); assert.equal(nameOnly.resolved.matched_by, null)
    assert.equal(nameOnly.resolved.property_id, null, 'A newly resolved person cannot inherit the old property')
  })
  await test('identity: no-address property resolution uses primary then first then null without inventing an address', async n => {
    const f = await seedQuoteIdentity(db, n)
    assert.equal((await plan(f, selected(f, ''))).resolved.property_id, f.targetProperty)
    await db.query('update public.properties set is_primary=false where id=$1::uuid', [f.targetProperty])
    assert.equal((await plan(f, selected(f, ''))).resolved.property_id, f.targetProperty)
    await db.query('delete from public.properties where id=$1::uuid', [f.targetProperty])
    const none = await plan(f, selected(f, ''))
    assert.equal(none.resolved.property_id, null); assert.equal(none.property_insert, null)
    assert.equal((await save(f, none)).code, 'saved')
    assert.equal(await identityValue(db, 'select property_id as value from public.quotes where id=$1::uuid', [f.quote]), null)
  })
  await test('identity: actual owner handler saves selected target using current snapshot and keeps foreign owner out', async n => {
    const f = await seedQuoteIdentity(db, n), foreign = await seedQuoteIdentity(db, n + 1000)
    const beforeForeign = await identityRows(db, foreign.owner), snap = await snapshot(f)
    const response = await savePilotQuoteIdentityRequest(store, auth(f.owner), request(f, snap.quote_revision, selected(f, '200 Existing Road')))
    assert.equal(response.status, 200)
    assert.equal(await identityValue(db, 'select customer_id as value from public.quotes where id=$1::uuid', [f.quote]), f.target)
    assert.deepEqual(await identityRows(db, foreign.owner), beforeForeign)
    const before = await identityRows(db, f.owner), current = await snapshot(f)
    assert.equal((await savePilotQuoteIdentityRequest(store, auth(foreign.owner), request(f, current.quote_revision, newInput(n)))).status, 404)
    assert.deepEqual(await identityRows(db, f.owner), before)
    const foreignTarget = await savePilotQuoteIdentityRequest(store, auth(f.owner), request(f, current.quote_revision, { ...selected(f), customerId: foreign.target }))
    assert.equal(foreignTarget.status, 400)
    assert.deepEqual(await identityRows(db, f.owner), before); assert.deepEqual(await identityRows(db, foreign.owner), beforeForeign)
  })
  await test('identity: owner/auth/origin and failed/incomplete snapshot requests never call save or mutate rows', async n => {
    const f = await seedQuoteIdentity(db, n), snap = await snapshot(f), before = await identityRows(db, f.owner)
    let saveCalls = 0
    const neverSave = async () => { saveCalls++; throw new Error('Invalid request must not reach save') }
    assert.equal((await savePilotQuoteIdentityRequest({ ...store, save: neverSave }, { getUser: async () => ({ data: { user: null } }) }, request(f, snap.quote_revision, newInput(n)))).status, 401)
    assert.equal((await savePilotQuoteIdentityRequest({ ...store, save: neverSave }, auth(f.owner), request(f, snap.quote_revision, newInput(n), { owner: f.owner }))).status, 400)
    const badOrigin = request(f, snap.quote_revision, newInput(n)); badOrigin.headers.set('origin', 'https://foreign.example.invalid')
    assert.equal((await savePilotQuoteIdentityRequest({ ...store, save: neverSave }, auth(f.owner), badOrigin)).status, 403)
    for (const shape of ['failed', 'incomplete', 'missing-properties'] as const) {
      const broken = { ...store, save: neverSave, snapshot: async () => {
        if (shape === 'failed') throw new Error('Synthetic read refused')
        const value = structuredClone(snap)
        if (shape === 'incomplete') value.complete = false
        else delete value.properties
        return value
      } }
      assert.equal((await savePilotQuoteIdentityRequest(broken, auth(f.owner), request(f, snap.quote_revision, newInput(n)))).status, 503)
    }
    assert.equal(saveCalls, 0, 'Failed/incomplete snapshot is refused before the mutating RPC')
    assert.deepEqual(await identityRows(db, f.owner), before)
  })
  await test('identity: stale complete-quote revision including content refuses before planning writes', async n => {
    const f = await seedQuoteIdentity(db, n), snap = await snapshot(f)
    await db.query('update public.quotes set internal_notes=$2 where id=$1::uuid', [f.quote, 'Concurrently changed note'])
    const before = await identityRows(db, f.owner)
    assert.equal((await savePilotQuoteIdentityRequest(store, auth(f.owner), request(f, snap.quote_revision, newInput(n)))).status, 409)
    assert.deepEqual(await identityRows(db, f.owner), before)
  })
  await test('identity: unchanged owner result is truthful; fabricated saved receipt for preserve is unavailable', async n => {
    const f = await seedQuoteIdentity(db, n), snap = await snapshot(f), before = await identityRows(db, f.owner)
    const actual = await savePilotQuoteIdentityRequest(store, auth(f.owner), request(f, snap.quote_revision, original(f)))
    assert.equal(actual.status, 200); assert.equal((await actual.json()).code, 'unchanged')
    const malformed = { ...store, save: async (...args: Parameters<typeof store.save>) => {
      const result = await store.save(...args); assert.equal(result.code, 'unchanged')
      return { ...result, code: 'saved' }
    } }
    assert.equal((await savePilotQuoteIdentityRequest(malformed, auth(f.owner), request(f, snap.quote_revision, original(f)))).status, 503)
    assert.deepEqual(await identityRows(db, f.owner), before)
  })
  for (const changed of ['target-contact', 'target-archived', 'new-customer-match', 'new-property-match'] as const) {
    await test(`identity: ${changed} changed after planning produces stale_resolution without writes`, async n => {
      const f = await seedQuoteIdentity(db, n), input = changed === 'new-customer-match' ? newInput(n) : selected(f)
      const p = await plan(f, input)
      if (changed === 'target-contact') await db.query('update public.customers set phone=$2 where id=$1::uuid', [f.target, '4035550123'])
      if (changed === 'target-archived') await db.query('update public.customers set archived_at=clock_timestamp() where id=$1::uuid', [f.target])
      if (changed === 'new-customer-match') await db.query('insert into public.customers(user_id,name,email) values($1::uuid,$2,$3)', [f.owner, 'Newly matching customer', input.email])
      if (changed === 'new-property-match') await db.query('insert into public.properties(user_id,customer_id,address,is_primary) values($1::uuid,$2::uuid,$3,false)', [f.owner, f.target, input.address])
      const before = await identityRows(db, f.owner)
      assert.equal((await save(f, p)).code, 'stale_resolution')
      assert.deepEqual(await identityRows(db, f.owner), before)
    })
  }
  for (const stage of ['property-insert', 'quote-update'] as const) {
    await test(`identity: native late ${stage} failure rolls back customer/property and audit/integration rows`, async n => {
      const f = await seedQuoteIdentity(db, n), p = await plan(f, newInput(n)), before = await identityRows(db, f.owner)
      const table = stage === 'property-insert' ? 'properties' : 'quotes', operation = stage === 'property-insert' ? 'insert' : 'update'
      await db.exec(`create function public.identity_late_fault() returns trigger language plpgsql as $$begin
        raise exception 'Synthetic late identity failure' using errcode='23514'; end$$;
        create trigger identity_late_fault before ${operation} on public.${table} for each row execute function public.identity_late_fault()`)
      await assert.rejects(() => save(f, p), (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === '23514')
      assert.deepEqual(await identityRows(db, f.owner), before)
    })
  }
  await test('identity: native zero-row quote UPDATE cannot leave planned rows or claim saved', async n => {
    const f = await seedQuoteIdentity(db, n), p = await plan(f, newInput(n)), before = await identityRows(db, f.owner)
    await db.exec(`create function public.identity_zero_update() returns trigger language plpgsql as $$begin return null; end$$;
      create trigger identity_zero_update before update on public.quotes for each row execute function public.identity_zero_update()`)
    await assert.rejects(() => save(f, p), (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'P0001')
    assert.deepEqual(await identityRows(db, f.owner), before)
  })
  await test('identity: service-only RPC grants and malformed/foreign/aliasing plan refuse with zero mutations', async n => {
    const f = await seedQuoteIdentity(db, n), foreign = await seedQuoteIdentity(db, n + 1000), p = await plan(f, newInput(n))
    const before = await identityRows(db, f.owner), beforeForeign = await identityRows(db, foreign.owner)
    for (const role of ['anon', 'authenticated']) {
      for (const signature of ['public.pilot_quote_identity_snapshot(uuid,uuid)', 'public.pilot_quote_identity_save(uuid,uuid,jsonb)']) {
        assert.equal(await identityValue(db, "select has_function_privilege($1,$2,'EXECUTE') as value", [role, signature]), false)
      }
    }
    for (const fault of ['extra-key', 'extra-customer-column', 'foreign-owner', 'alias-id'] as const) {
      const corrupt = structuredClone(p) as unknown as Record<string, unknown>
      const insert = corrupt.customer_insert as Record<string, unknown>
      if (fault === 'extra-key') corrupt.unapproved = true
      if (fault === 'extra-customer-column') insert.email_opt_in = true
      if (fault === 'foreign-owner') insert.user_id = foreign.owner
      if (fault === 'alias-id') {
        insert.id = f.target
        ;(corrupt.resolved as Record<string, unknown>).customer_id = f.target
        ;(corrupt.property_insert as Record<string, unknown>).customer_id = f.target
      }
      assert.equal((await identityRpc(db, 'pilot_quote_identity_save', { p_owner: f.owner, p_quote: f.quote, p_plan: corrupt })).code, 'invalid_plan')
      assert.deepEqual(await identityRows(db, f.owner), before)
    }
    assert.equal((await identityRpc(db, 'pilot_quote_identity_save', { p_owner: foreign.owner, p_quote: f.quote, p_plan: p })).code, 'invalid_plan')
    assert.deepEqual(await identityRows(db, foreign.owner), beforeForeign)
  })
  await test('identity: lost successful commit response reports unavailable and stale intent never repeats creation', async n => {
    const f = await seedQuoteIdentity(db, n), snap = await snapshot(f)
    let saved = 0
    const uncertain = { ...store, save: async (...args: Parameters<typeof store.save>) => {
      const result = await store.save(...args); assert.equal(result.code, 'saved'); saved++
      throw new Error('Synthetic response lost after SQL commit boundary')
    } }
    assert.equal((await savePilotQuoteIdentityRequest(uncertain, auth(f.owner), request(f, snap.quote_revision, newInput(n)))).status, 503)
    const after = await identityRows(db, f.owner)
    assert.equal(saved, 1); assert.equal(after.customers.length, 3); assert.equal(after.properties.length, 3)
    assert.equal((await savePilotQuoteIdentityRequest(uncertain, auth(f.owner), request(f, snap.quote_revision, newInput(n)))).status, 409)
    assert.equal(saved, 1); assert.deepEqual(await identityRows(db, f.owner), after)
  })
  return results
}
