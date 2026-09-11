import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createPilotQuoteSaveAuth, requirePilotQuoteSaveOwner, type PilotQuoteSaveAuth } from '../../src/lib/quotes/pilotQuoteSaveAuth'
import { savePilotQuoteSaveRequest, type PilotQuoteSaveStore } from '../../src/lib/quotes/pilotQuoteSave'
import { loadPilotQuoteSaveBaselineRequest, projectPilotQuoteSaveBaseline } from '../../src/lib/quotes/pilotQuoteSaveBaselineServer'
import { PilotQuoteSaveHttpRefusal } from '../../src/lib/quotes/pilotQuoteSaveHttp'
import type { PilotQuoteSaveIntent } from '../../src/lib/quotes/pilotQuoteSavePlan'
import { baselineBinding as binding, baselineId, baselinePrivateSentinel, quoteSaveBaselineFixture } from '../pilot-email/quote-save-baseline-fixtures'
import type { TestResult } from '../pilot-email/database'

// Synthetic HTTP boundary and fake-SDK contract tests only. These exercise the
// canonical helper and handlers, but authenticate no session and call no network
// or database. No committed Save acknowledgement is invented here. The native
// atomic role RPC and native writes have a separate, explicitly scoped proof.
type Row = Record<string, unknown>
type Mode = 'baseline' | 'save'
type RoleResult = Awaited<ReturnType<PilotQuoteSaveAuth['readOwnerRole']>>
const origin = 'https://authority-http.fixture.example.invalid'
const ownerEvidence = () => ({ owner_id: binding.ownerId, role: 'owner' })
export const authorityHttpEvidence: Row[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => { resolve = finish })
  return { promise, resolve }
}
function harness() {
  const calls: string[] = []
  const auth: PilotQuoteSaveAuth = {
    async getUser() { calls.push('getUser:synthetic'); return { data: { user: { id: binding.ownerId } }, error: null } },
    async readOwnerRole(expectedOwner, signal) {
      calls.push('readOwnerRole:synthetic')
      assert.equal(expectedOwner, binding.ownerId); assert.equal(signal.aborted, false)
      return { data: ownerEvidence(), error: null }
    },
  }
  const store: PilotQuoteSaveStore = {
    async snapshot(owner, quote, signal) {
      calls.push('snapshot'); assert.equal(owner, binding.ownerId); assert.equal(quote, binding.quoteId)
      assert.equal(signal.aborted, false)
      // A read refusal marks that owner authority passed. No successful write
      // or synthetic committed receipt is needed to establish this boundary.
      return { code: 'not_found' }
    },
    async targets() { calls.push('UNEXPECTED_TARGETS'); throw Error('Unexpected target read') },
    async commit() { calls.push('UNEXPECTED_COMMIT'); throw Error('Unexpected commit') },
  }
  const baseline = projectPilotQuoteSaveBaseline(quoteSaveBaselineFixture(), binding)
  const intent: PilotQuoteSaveIntent = { version: 1, quoteId: binding.quoteId, expectedEditorRevision: baseline.editorRevision,
    clientOperationId: baselineId(91), editorGeneration: 'authority-http-fixture', values: baseline.values }
  const run = (mode: Mode, signal = new AbortController().signal, ms = 1000) => {
    const body = mode === 'baseline' ? { version: 1, quoteId: binding.quoteId } : intent
    const request = new Request(origin + '/dormant-' + mode, { method: 'POST', signal,
      headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const options = { trustedOrigin: origin, bodyTimeoutMs: 1000, operationTimeoutMs: ms }
    return mode === 'baseline' ? loadPilotQuoteSaveBaselineRequest(store, auth, request, options)
      : savePilotQuoteSaveRequest(store, auth, request, options)
  }
  return { auth, calls, run }
}
async function responseIs(response: Response, status: number, code: string) {
  assert.equal(response.status, status)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const text = await response.text()
  assert.equal(text.includes(baselinePrivateSentinel), false)
  assert.deepEqual(JSON.parse(text), { code })
}
async function helperRefuses(auth: PilotQuoteSaveAuth, status: number, code: string) {
  await assert.rejects(requirePilotQuoteSaveOwner(auth, new AbortController().signal, 1000), error => {
    assert.ok(error instanceof Error)
    if (status === 401 || status === 403) {
      assert.ok(error instanceof PilotQuoteSaveHttpRefusal)
      assert.equal(error.status, status); assert.equal(error.code, code)
    } else if (error instanceof PilotQuoteSaveHttpRefusal) assert.equal(error.status, status)
    return true
  })
}
function noStore(calls: string[]) {
  assert.equal(calls.some(call => ['snapshot', 'UNEXPECTED_TARGETS', 'UNEXPECTED_COMMIT'].includes(call)), false)
}

export async function runAuthorityHttpCases(): Promise<TestResult[]> {
  const tests: TestResult[] = []
  authorityHttpEvidence.length = 0
  const test = async (name: string, work: () => Promise<void>) => {
    try { await work(); tests.push({ name: 'Authority HTTP: ' + name, pass: true }) }
    catch (error) { tests.push({ name: 'Authority HTTP: ' + name, pass: false,
      error: error instanceof Error ? error.message.slice(0, 1800) : 'Authority HTTP assertion failed' }) }
  }

  await test('bound owner passes the shared helper and reaches only the baseline/Save snapshot', async () => {
    const helper = harness()
    assert.equal(await requirePilotQuoteSaveOwner(helper.auth, new AbortController().signal, 1000), binding.ownerId)
    assert.deepEqual(helper.calls, ['getUser:synthetic', 'readOwnerRole:synthetic'])
    for (const mode of ['baseline', 'save'] as const) {
      const h = harness(); await responseIs(await h.run(mode), 404, 'not_found')
      assert.deepEqual(h.calls, ['getUser:synthetic', 'readOwnerRole:synthetic', 'snapshot'])
      authorityHttpEvidence.push({ kind: 'owner-reaches-read', mode, calls: h.calls, syntheticSnapshotRefusal: true })
    }
  })

  const roleCases: { name: string; value: unknown; status: number; code: string }[] = [
    { name: 'none', value: { owner_id: binding.ownerId, role: 'none' }, status: 403, code: 'forbidden' },
    { name: 'crew', value: { owner_id: binding.ownerId, role: 'crew' }, status: 403, code: 'forbidden' },
    { name: 'atomic identity refusal', value: { code: 'forbidden' }, status: 403, code: 'forbidden' },
    { name: 'foreign owner payload', value: { owner_id: baselineId(99), role: 'owner' }, status: 503, code: 'unavailable' },
    { name: 'unknown role', value: { owner_id: binding.ownerId, role: 'administrator' }, status: 503, code: 'unavailable' },
    { name: 'null result', value: null, status: 503, code: 'unavailable' },
    { name: 'bare role string', value: 'owner', status: 503, code: 'unavailable' },
    { name: 'array result', value: [ownerEvidence()], status: 503, code: 'unavailable' },
    { name: 'missing identity', value: { role: 'owner' }, status: 503, code: 'unavailable' },
    { name: 'missing role', value: { owner_id: binding.ownerId }, status: 503, code: 'unavailable' },
    { name: 'non-string role', value: { owner_id: binding.ownerId, role: true }, status: 503, code: 'unavailable' },
    { name: 'extra owner payload key', value: { ...ownerEvidence(), private: baselinePrivateSentinel }, status: 503, code: 'unavailable' },
    { name: 'ambiguous refusal payload', value: { code: 'forbidden', ...ownerEvidence() }, status: 503, code: 'unavailable' },
  ]
  for (const c of roleCases) await test(c.name + ' refuses before either store capability', async () => {
    const prepare = () => {
      const h = harness()
      h.auth.readOwnerRole = async (expectedOwner, signal) => {
        h.calls.push('readOwnerRole:synthetic'); assert.equal(expectedOwner, binding.ownerId); assert.equal(signal.aborted, false)
        return { data: structuredClone(c.value), error: null }
      }
      return h
    }
    await helperRefuses(prepare().auth, c.status, c.code)
    for (const mode of ['baseline', 'save'] as const) {
      const h = prepare(); await responseIs(await h.run(mode), c.status, c.code)
      assert.deepEqual(h.calls, ['getUser:synthetic', 'readOwnerRole:synthetic']); noStore(h.calls)
      authorityHttpEvidence.push({ kind: 'role-refusal', case: c.name, mode, status: c.status, code: c.code, calls: h.calls })
    }
  })

  for (const mode of ['baseline', 'save'] as const) {
    await test(mode + ' rejects absent or invalid verified identity before role reads', async () => {
      const identities = [{ data: { user: null }, error: null }, { data: { user: { id: 'invalid-id' } }, error: null },
        { data: { user: { id: binding.ownerId } }, error: { message: baselinePrivateSentinel } }]
      for (const identity of identities) {
        const h = harness(); h.auth.getUser = async () => { h.calls.push('getUser:synthetic'); return identity }
        await responseIs(await h.run(mode), 401, 'unauthenticated')
        assert.deepEqual(h.calls, ['getUser:synthetic']); noStore(h.calls)
      }
    })
    await test(mode + ' fails closed on missing capability, role errors and identity transport errors', async () => {
      for (const failure of ['missing-role-capability', 'role-error', 'role-throws', 'identity-throws'] as const) {
        const h = harness()
        if (failure === 'missing-role-capability') (h.auth as unknown as Row).readOwnerRole = undefined
        else if (failure === 'identity-throws') h.auth.getUser = async () => { h.calls.push('getUser:synthetic'); throw Error(baselinePrivateSentinel) }
        else h.auth.readOwnerRole = async () => {
          h.calls.push('readOwnerRole:synthetic')
          if (failure === 'role-throws') throw Error(baselinePrivateSentinel)
          return { data: ownerEvidence(), error: { message: baselinePrivateSentinel } }
        }
        await responseIs(await h.run(mode), 503, 'unavailable'); noStore(h.calls)
        authorityHttpEvidence.push({ kind: 'unavailable', mode, failure, calls: h.calls })
      }
    })
    await test(mode + ' bounds role timeouts and ignores a late owner answer', async () => {
      const h = harness(), answer = deferred<RoleResult>()
      let roleSignal: AbortSignal | undefined
      h.auth.readOwnerRole = (_expectedOwner, signal) => { h.calls.push('readOwnerRole:synthetic'); roleSignal = signal; return answer.promise }
      try {
        await responseIs(await h.run(mode, new AbortController().signal, 10), 503, 'unavailable')
        assert.equal(roleSignal?.aborted, true)
      } finally { answer.resolve({ data: ownerEvidence(), error: null }) }
      await Promise.resolve(); await Promise.resolve()
      assert.deepEqual(h.calls, ['getUser:synthetic', 'readOwnerRole:synthetic']); noStore(h.calls)
    })
    await test(mode + ' cancels an in-flight role read without trusting its late answer', async () => {
      const h = harness(), answer = deferred<RoleResult>(), started = deferred<AbortSignal>(), controller = new AbortController()
      h.auth.readOwnerRole = (_expectedOwner, signal) => { h.calls.push('readOwnerRole:synthetic'); started.resolve(signal); return answer.promise }
      const response = h.run(mode, controller.signal)
      try {
        const roleSignal = await Promise.race([started.promise, response.then(() => { throw Error('Handler returned before role read started') })])
        controller.abort(); await responseIs(await response, 503, 'unavailable'); assert.equal(roleSignal.aborted, true)
      } finally { controller.abort(); answer.resolve({ data: ownerEvidence(), error: null }); await response }
      await Promise.resolve(); noStore(h.calls)
      assert.deepEqual(h.calls, ['getUser:synthetic', 'readOwnerRole:synthetic'])
    })
    await test(mode + ' cannot start role/store work after identity timeout or prior request cancellation', async () => {
      const h = harness(), answer = deferred<Awaited<ReturnType<PilotQuoteSaveAuth['getUser']>>>()
      h.auth.getUser = () => { h.calls.push('getUser:synthetic'); return answer.promise }
      try { await responseIs(await h.run(mode, new AbortController().signal, 10), 503, 'unavailable') }
      finally { answer.resolve({ data: { user: { id: binding.ownerId } }, error: null }) }
      await Promise.resolve(); assert.deepEqual(h.calls, ['getUser:synthetic']); noStore(h.calls)
      const aborted = harness(), controller = new AbortController(); controller.abort()
      await responseIs(await aborted.run(mode, controller.signal), 503, 'unavailable'); assert.deepEqual(aborted.calls, [])
    })
  }

  await test('canonical factory forwards the exact expected-owner RPC and supplied abort signal', async () => {
    const calls: Row[] = [], controller = new AbortController()
    const sdk = {
      auth: { async getUser() { calls.push({ operation: 'getUser' }); return { data: { user: { id: binding.ownerId } }, error: null } } },
      rpc(name: string, args: unknown) {
        calls.push({ operation: 'rpc', name, args })
        return { async abortSignal(signal: AbortSignal) {
          assert.equal(signal, controller.signal); calls.push({ operation: 'abortSignal', aborted: signal.aborted })
          return { data: ownerEvidence(), error: null }
        } }
      },
    }
    const auth = createPilotQuoteSaveAuth(sdk as unknown as SupabaseClient)
    assert.equal((await auth.getUser()).data?.user?.id, binding.ownerId)
    assert.deepEqual(await auth.readOwnerRole(binding.ownerId, controller.signal), { data: ownerEvidence(), error: null })
    assert.deepEqual(calls, [{ operation: 'getUser' }, { operation: 'rpc', name: 'pilot_quote_save_owner_role', args: { p_expected_owner: binding.ownerId } },
      { operation: 'abortSignal', aborted: false }])
    authorityHttpEvidence.push({ kind: 'fake-sdk-contract', calls, actualSdkOrAuthenticationEvidence: false })
  })
  await test('canonical factory and helper fail closed on switched identity or failed RPC, without fallback reads', async () => {
    for (const result of [{ data: { code: 'forbidden' }, error: null }, { data: ownerEvidence(), error: { message: baselinePrivateSentinel } }]) {
      const calls: string[] = []
      const sdk = {
        auth: { async getUser() { calls.push('getUser'); return { data: { user: { id: binding.ownerId } }, error: null } },
          getSession() { throw Error('Forbidden cached-session fallback') } },
        from() { throw Error('Forbidden table-role fallback') },
        rpc(name: string, args: unknown) {
          calls.push('rpc'); assert.equal(name, 'pilot_quote_save_owner_role'); assert.deepEqual(args, { p_expected_owner: binding.ownerId })
          return { async abortSignal(signal: AbortSignal) { assert.equal(signal.aborted, false); calls.push('abortSignal'); return result } }
        },
      }
      await helperRefuses(createPilotQuoteSaveAuth(sdk as unknown as SupabaseClient), result.error ? 503 : 403, result.error ? 'unavailable' : 'forbidden')
      assert.deepEqual(calls, ['getUser', 'rpc', 'abortSignal'])
    }
  })
  await test('canonical factory refuses an already-aborted role request before SDK dispatch', async () => {
    const calls: string[] = [], controller = new AbortController(); controller.abort()
    const sdk = { rpc() { calls.push('rpc'); throw Error('An aborted role RPC was dispatched') } }
    const auth = createPilotQuoteSaveAuth(sdk as unknown as SupabaseClient)
    let refused = false
    try { const result = await auth.readOwnerRole(binding.ownerId, controller.signal); refused = !!result.error }
    catch { refused = true }
    assert.equal(refused, true); assert.deepEqual(calls, [])
  })
  return tests
}
